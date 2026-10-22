"""Same-origin Studio editor and Gradio controls for a separately hosted model."""

import asyncio
import html
import logging
import secrets
import tempfile
import zipfile
from collections import OrderedDict
from collections.abc import Callable
from pathlib import Path
from typing import Protocol
from urllib.parse import quote

import gradio as gr
import httpx
from fastapi import FastAPI
from fastapi.responses import RedirectResponse


class GenerationProvider(Protocol):
    """UI and validation supplied by a model's Studio provider."""

    title: str
    warning_checks: frozenset[str]

    def controls(self) -> dict[str, gr.Component]: ...
    def validate(self, options: dict) -> dict: ...
    def example_options(self, example: dict) -> dict: ...


# A public host serves many short-lived browser tabs; cap the per-tab result registry so it
# cannot grow without bound. Evicting a client releases its tracked sessions.
MAX_TRACKED_CLIENTS = 64


HOST_BRIDGE = """
const configure = () => {
  const frame = element.querySelector('iframe');
  if (frame && !frame.dataset.hostConfigured) {
    frame.dataset.hostConfigured = 'true';
    const url = new URL(frame.src);
    url.searchParams.set('parent_origin', location.origin);
    frame.src = url.href;
  }
};
configure();
watch('value', configure);
window.addEventListener('message', (event) => {
  const frame = element.querySelector('iframe');
  if (event.origin === location.origin && event.source === frame?.contentWindow &&
      event.data?.source === 'atomworks-annotation-studio' &&
      ['ready', 'changed', 'example'].includes(event.data.type)) {
    const previous = frame.dataset.sessionId;
    frame.dataset.sessionId = event.data.session_id;
    if (previous && previous !== event.data.session_id) trigger('document', {});
    if (event.data.type === 'example') {
      trigger('example', {task: event.data.task});
    }
  }
});
"""

CURRENT_SESSION = """(session, ...values) => {
  const frame = document.querySelector('iframe[title="AtomWorks Studio"]');
  return [frame?.dataset.sessionId || "", ...values];
}"""


def identity_headers(request: gr.Request | None) -> dict[str, str]:
    """Forward the proxy-authenticated user to Studio for in-process hand-off calls.

    In identity mode Studio rejects requests without the configured header, and sessions are
    owned by that user. The Gradio request came through the same trusted proxy, so its header
    is as trustworthy as the browser's own Studio requests and keeps results openable in the iframe.
    """
    from annotation_studio import main as studio_main

    header = studio_main.IDENTITY_HEADER
    if not header or request is None:
        return {}
    value = request.headers.get(header)
    return {header: value} if value else {}


class StudioHandoff:
    """Use Studio's versioned HTTP contract without sharing document internals."""

    def __init__(self, studio: FastAPI, editor_path: str = "/"):
        self.editor_path = editor_path
        self.transport = httpx.ASGITransport(app=studio)

    async def open(self, name: str, cif: str, headers: dict[str, str] | None = None) -> tuple[str, str]:
        async with httpx.AsyncClient(transport=self.transport, base_url="http://studio", headers=headers) as client:
            response = await client.post("/api/v1/sessions", files={"file": (name, cif.encode())})
            response.raise_for_status()
        session = response.json()
        session_id = session["session_id"]
        return session_id, self.frame(session_id)

    async def close(self, session_ids: list[str], headers: dict[str, str] | None = None) -> None:
        """Release hand-off sessions; Studio's bounded store would otherwise evict live user sessions."""
        async with httpx.AsyncClient(transport=self.transport, base_url="http://studio", headers=headers) as client:
            for session_id in session_ids:
                response = await client.delete(f"/api/v1/sessions/{quote(session_id, safe='')}")
                if response.status_code not in (204, 404):
                    response.raise_for_status()

    def frame(self, session_id: str | None = None) -> str:
        query = "embed=1"
        if session_id:
            query += "&amp;session=" + html.escape(quote(session_id, safe=""))
        return (
            f'<iframe src="{self.editor_path}?{query}" title="AtomWorks Studio" '
            'style="width:100%;height:76vh;min-height:620px;border:0" '
            'allow="clipboard-write; fullscreen; webgpu"></iframe>'
        )

    async def export(
        self, session_id: str, warning_checks: frozenset[str], headers: dict[str, str] | None = None
    ) -> dict:
        if not session_id:
            raise gr.Error("Open a structure in Studio first")
        session_id = quote(session_id, safe="")
        async with httpx.AsyncClient(transport=self.transport, base_url="http://studio", headers=headers) as client:
            response = await client.post(f"/api/v1/sessions/{session_id}/export")
            response.raise_for_status()
        snapshot = response.json()
        for issue in snapshot["issues"]:
            if issue.get("check") in warning_checks:
                issue["severity"] = "warning"
        errors = [issue["message"] for issue in snapshot["issues"] if issue["severity"] == "error"]
        if errors:
            raise gr.Error("Fix Studio validation errors before generating: " + "; ".join(errors))
        return snapshot


def create_demo(
    studio: FastAPI,
    *,
    provider: GenerationProvider,
    generate_fn: Callable[[str, dict], list[str]],
    editor_path: str = "/",
) -> gr.Blocks:
    """Export current edits, call a model off the API loop, and inspect returned CIFs."""
    handoff = StudioHandoff(studio, editor_path)
    # Result sessions each browser tab created, released when that tab generates again or when
    # the bounded registry evicts the tab.
    results_by_client: OrderedDict[str, list[str]] = OrderedDict()
    with gr.Blocks(delete_cache=(3600, 3600)) as demo:
        gr.Markdown(f"# {provider.title}")
        session = gr.Textbox(visible=False)
        views = gr.State({})
        controls = provider.controls()
        run = gr.Button("Generate design", variant="primary")
        with gr.Row(visible=False, elem_id="design-results") as results_row:
            view = gr.Radio(choices=[], label="View", container=False, scale=4)
            download = gr.DownloadButton("Download CIF", size="sm", min_width=150, scale=1, elem_id="download-design")
            download_all = gr.DownloadButton("Download all", size="sm", min_width=150, scale=1, elem_id="download-all")
        status = gr.Markdown(
            "Open a CIF or choose an example in Studio, then generate a design.", elem_id="generation-status"
        )
        editor = gr.HTML(handoff.frame(), elem_id="studio-editor", js_on_load=HOST_BRIDGE)
        api_cif = gr.Textbox(visible=False)
        api_options = gr.JSON(visible=False)
        api_result = gr.JSON(visible=False)
        api_run = gr.Button(visible=False)

        async def run_cifs(cif: str, options: dict) -> list[str]:
            results = await asyncio.to_thread(generate_fn, cif, options)
            if not results:
                raise gr.Error("The model returned no structures")
            return results

        async def generate_cif(cif: str, options: dict, request: gr.Request = None) -> dict:
            """Generate from an annotated CIF through the same Studio validation and model path."""
            validated = provider.validate(options or {})
            headers = identity_headers(request)
            session_id, _ = await handoff.open("input.cif", cif, headers)
            try:
                snapshot = await handoff.export(session_id, provider.warning_checks, headers)
            finally:
                await handoff.close([session_id], headers)
            return {
                "designs": await run_cifs(snapshot["cif"], validated),
                "warnings": [issue["message"] for issue in snapshot["issues"]],
            }

        async def generate(
            session_id: str,
            *values,
            request: gr.Request = None,
            progress: gr.Progress = gr.Progress(),  # noqa: B008
        ) -> tuple:
            headers = identity_headers(request)
            # A browser tab is tracked by its Gradio session; a call without one (the exposed API used
            # statelessly) gets its own key, so its results are still released when the bounded
            # registry evicts it instead of waiting for Studio's global eviction.
            client = getattr(request, "session_hash", None) or f"api-{secrets.token_hex(8)}"
            opened: list[str] = []  # result sessions created in this call, for cleanup on failure
            try:
                progress(None, desc="Checking current edits…")
                options = provider.validate(dict(zip(controls, values, strict=True)))
                snapshot = await handoff.export(session_id, provider.warning_checks, headers)
                with tempfile.TemporaryDirectory(prefix="studio-generation-") as directory:
                    progress(None, desc="Generating design (including any GPU wait)…")
                    results = await run_cifs(snapshot["cif"], options)
                    progress(None, desc="Opening generated designs in Studio…")
                    archive_path = Path(directory) / "designs.zip"
                    with zipfile.ZipFile(archive_path, "w", zipfile.ZIP_DEFLATED) as archive:
                        for index, cif in enumerate(results, start=1):
                            archive.writestr(f"design-{index}.cif", cif)
                    archive_download = download_all.move_resource_to_block_cache(archive_path)
                    paths = {session_id: None}
                    choices = [("Input", session_id)]
                    for index, cif in enumerate(results, start=1):
                        path = Path(directory) / f"design-{index}.cif"
                        path.write_text(cif)
                        result_id, _ = await handoff.open(path.name, cif, headers)
                        opened.append(result_id)
                        paths[result_id] = download.move_resource_to_block_cache(path)
                        choices.append((f"Design {index}", result_id))
                result_id = choices[1][1]
                previous = results_by_client.get(client, [])
                # Keep the session generated from when it was one of this tab's tracked results,
                # so a later generation from a different source still releases it.
                retained = [session_id] if session_id in previous else []
                stale = [key for key in previous if key not in opened and key not in retained]
                results_by_client[client] = opened + retained
                results_by_client.move_to_end(client)
                while len(results_by_client) > MAX_TRACKED_CLIENTS:
                    _evicted, evicted_ids = results_by_client.popitem(last=False)
                    stale.extend(key for key in evicted_ids if key not in opened)
                await handoff.close(stale, headers)
                warnings = "; ".join(issue["message"] for issue in snapshot["issues"])
                message = f"Generated from input revision {snapshot['revision']}. {warnings}".strip()
                return (
                    result_id,
                    handoff.frame(result_id),
                    paths,
                    gr.Radio(choices=choices, value=result_id),
                    gr.DownloadButton(value=paths[result_id], visible=True),
                    gr.Markdown(value=message, visible=True),
                    gr.Row(visible=True),
                    gr.DownloadButton(value=archive_download, visible=True),
                )
            except Exception as error:
                logging.getLogger(__name__).exception("Studio generation failed")
                if opened:
                    try:
                        await handoff.close(opened, headers)
                    except Exception:
                        logging.getLogger(__name__).exception("Releasing partial generation sessions failed")
                message = error.message if isinstance(error, gr.Error) else "The model request failed. Please retry."
                failure = gr.Markdown(value=f"**Generation failed.** {html.escape(message)} Your input is unchanged.")
                return gr.skip(), gr.skip(), gr.skip(), gr.skip(), gr.skip(), failure, gr.skip(), gr.skip()

        def inspect(session_id: str, paths: dict) -> tuple:
            if session_id not in paths:
                raise gr.Error("Generate and select a design first")
            return (
                session_id,
                handoff.frame(session_id),
                gr.DownloadButton(value=paths[session_id], visible=paths[session_id] is not None),
            )

        def clear_results() -> tuple:
            return {}, gr.Radio(choices=[], value=None), gr.Markdown(value="Ready to generate."), gr.Row(visible=False)

        def editor_example(event: gr.EventData) -> tuple:
            updates = provider.example_options(event._data)
            return *(updates.get(key, gr.skip()) for key in controls), *clear_results()

        editor.document(clear_results, outputs=[views, view, status, results_row], api_name=False)
        editor.example(editor_example, outputs=[*controls.values(), views, view, status, results_row], api_name=False)
        run.click(
            generate,
            [session, *controls.values()],
            [session, editor, views, view, download, status, results_row, download_all],
            concurrency_limit=1,
            show_progress="full",
            show_progress_on=status,
            js=CURRENT_SESSION,
            api_name="generate_from_studio",
        )
        api_run.click(
            generate_cif,
            [api_cif, api_options],
            api_result,
            api_name="generate_cif",
            concurrency_limit=1,
            show_progress="hidden",
        )
        view.input(inspect, [view, views], [session, editor, download], api_name=False, show_progress_on=status)
    return demo.queue(max_size=8)


def create_app(*, provider: GenerationProvider, generate_fn: Callable[[str, dict], list[str]]) -> FastAPI:
    """Mount the optional generation UI at /design beside the existing editor."""
    from annotation_studio.main import app as studio

    app = FastAPI()

    @app.middleware("http")
    async def landing(request, call_next):
        if request.url.path == "/" and not ({"session", "embed"} & request.query_params.keys()):
            return RedirectResponse("/design/")
        return await call_next(request)

    app = gr.mount_gradio_app(
        app,
        create_demo(studio, provider=provider, generate_fn=generate_fn),
        path="/design",
        theme=gr.themes.Default(primary_hue="blue"),
        css=".gradio-container { max-width: 1600px !important; } #studio-editor { padding: 0; }",
        max_file_size="10mb",
        show_error=False,
        ssr_mode=False,
        footer_links=["api"],
        run_history=False,
    )
    app.mount("/", studio)
    return app
