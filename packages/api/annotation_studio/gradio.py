"""Same-origin Studio editor and Gradio controls for a separately hosted model."""

import asyncio
import html
import json
import logging
import tempfile
import zipfile
from collections.abc import Callable
from pathlib import Path
from typing import Protocol
from urllib.parse import quote

import gradio as gr
import httpx
from fastapi import FastAPI
from fastapi.responses import RedirectResponse

from annotation_studio import refold as refold_support


class GenerationProvider(Protocol):
    """UI and validation supplied by a model's Studio provider.

    `title`, `warning_checks`, `controls`, `validate` and `example_options` are required. The rest are optional and
    read with a default, so a provider written against an earlier release keeps working unchanged.
    """

    title: str
    warning_checks: frozenset[str]

    # Optional. An example id to open Studio on, so a visitor lands on something runnable instead of an empty editor.
    default_example: str | None
    # Optional. Extra CSS for the provider's own controls, appended to Studio's. Keeps provider element ids out of
    # this module.
    css: str

    def controls(self) -> dict[str, gr.Component]: ...
    def validate(self, options: dict) -> dict: ...
    def example_options(self, example: dict) -> dict: ...

    # Optional. Reject an input the chosen options cannot be run on, before any GPU time is spent. Receives the
    # export snapshot (`cif`, `issues`, `has_expandable_segments`, ...) and the already-validated options, and
    # raises `gr.Error` to stop the run.
    def validate_input(self, snapshot: dict, options: dict) -> None: ...

    # Optional. Refold: fold each design again and score how it comes back, in Studio's Refold panel. A provider that
    # implements `refold_models`, with a deployment that passes `refold_fn` to `create_demo`/`create_app`, gets the
    # panel under the generation controls and a `/refold_cif` route; one that does not is untouched. See
    # docs/INTEGRATIONS.md, "Refold panel".
    #
    # The models on offer, in menu order: `[{"id": "af3"}, {"id": "openbind0"}]`. An id Studio knows ("af3",
    # "openbind0") needs nothing else; others give a `label`. `"terms": None` drops the AlphaFold 3 terms dialog a
    # deployment that has its own licence for the weights does not need.
    def refold_models(self) -> list[dict]: ...

    # Optional. The choices the panel offers, over Studio's defaults: `{"steps": {"options": [25, 50], "default": 25},
    # "recycles": {...}, "seed": {"min": 0, "max": 99}, "model": {"default": "openbind0"}}`.
    def refold_limits(self) -> dict: ...

    # Optional. Replace the default check of `{model, seed, recycles, steps}`; return the options `refold_fn` gets.
    def validate_refold(self, options: dict) -> dict: ...


# Gradio renders the progress tracker as an overlay positioned over its target, so a one-line Markdown status
# collapses it to a sliver. Give it room and drop the default spinner; a provider dresses the space through its own
# `css`, targeting `#generation-status [data-testid="status-tracker"]`.
STUDIO_CSS = """
.gradio-container { max-width: 1600px !important; }
#studio-editor { padding: 0; }
#generation-status:has([data-testid="status-tracker"]:not(.hide)) { min-height: 144px; }
#generation-status [data-testid="status-tracker"] svg { display: none; }
#generation-status [data-testid="status-tracker"]:not(.hide) {
    min-height: 144px; flex-direction: row; gap: 12px;
}
"""

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


class StudioHandoff:
    """Use Studio's versioned HTTP contract without sharing document internals."""

    def __init__(self, studio: FastAPI, editor_path: str = "/"):
        self.editor_path = editor_path
        self.transport = httpx.ASGITransport(app=studio)

    async def open(self, name: str, cif: str) -> tuple[str, str]:
        async with httpx.AsyncClient(transport=self.transport, base_url="http://studio") as client:
            response = await client.post("/api/v1/sessions", files={"file": (name, cif.encode())})
            response.raise_for_status()
        session = response.json()
        session_id = session["session_id"]
        return session_id, self.frame(session_id)

    def frame(self, session_id: str | None = None, *, example: str | None = None) -> str:
        query = "embed=1"
        if session_id:
            query += "&amp;session=" + html.escape(quote(session_id, safe=""))
        elif example:
            query += "&amp;example=" + html.escape(quote(example, safe=""))
        return (
            f'<iframe src="{self.editor_path}?{query}" title="AtomWorks Studio" '
            'style="width:100%;height:76vh;min-height:620px;border:0" '
            'allow="clipboard-write; fullscreen; webgpu"></iframe>'
        )

    async def export(self, session_id: str, warning_checks: frozenset[str]) -> dict:
        if not session_id:
            raise gr.Error("Open a structure in Studio first")
        session_id = quote(session_id, safe="")
        async with httpx.AsyncClient(transport=self.transport, base_url="http://studio") as client:
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
    refold_fn: Callable[[str, dict], dict] | None = None,
    editor_path: str = "/",
) -> gr.Blocks:
    """Export current edits, call a model off the API loop, and inspect returned CIFs.

    `refold_fn(design_cif, options) -> dict`, optional, folds one design again (`options` is `{model, seed, recycles,
    steps}`) and returns `cif`, `ligand_cif`, `metrics`, `text` and `passed` (`annotation_studio.refold`). It takes
    effect with a provider that names its `refold_models`.
    """
    handoff = StudioHandoff(studio, editor_path)
    refold_models = refold_support.refold_models(provider)
    if refold_fn is not None and not refold_models:
        raise ValueError("refold_fn needs a provider that implements refold_models()")
    refolding = refold_fn is not None
    refold_limits = refold_support.refold_limits(provider) if refolding else {}
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
        refold_bus = None
        if refolding:
            # Studio's own Refold panel, and the hidden component the browser and Python exchange its messages through.
            config = {
                "models": refold_models,
                "limits": refold_limits,
                "nameHeader": {"label": "Design"},
                "module": editor_path.rstrip("/") + "/refold-panel.js",
            }
            gr.HTML(
                "", html_template="", elem_id="refold-panel", padding=False,
                js_on_load=refold_support.HOST_JS.replace("__CONFIG__", json.dumps(config)),
            )
            refold_bus = gr.HTML(
                "", html_template="", visible="hidden", elem_id="refold-bus", js_on_load=refold_support.BUS_JS
            )
        status = gr.Markdown(
            "Open a CIF or choose an example in Studio, then generate a design.", elem_id="generation-status"
        )
        editor = gr.HTML(
            handoff.frame(example=getattr(provider, "default_example", None)),
            elem_id="studio-editor",
            js_on_load=HOST_BRIDGE,
        )
        api_cif = gr.Textbox(visible=False)
        api_options = gr.JSON(visible=False)
        api_result = gr.JSON(visible=False)
        api_run = gr.Button(visible=False)

        def panel(message) -> tuple:
            """What each handler adds to its outputs for the Refold panel: nothing, unless the host has one."""
            return (message,) if refolding else ()

        def check_input(snapshot: dict, options: dict) -> None:
            """Give the provider the last word on whether these options suit this input."""
            hook = getattr(provider, "validate_input", None)
            if hook is not None:
                hook(snapshot, options)

        async def run_cifs(cif: str, options: dict) -> list[str]:
            results = await asyncio.to_thread(generate_fn, cif, options)
            if not results:
                raise gr.Error("The model returned no structures")
            return results

        async def generate_cif(cif: str, options: dict) -> dict:
            """Generate from an annotated CIF through the same Studio validation and model path."""
            validated = provider.validate(options or {})
            session_id, _ = await handoff.open("input.cif", cif)
            snapshot = await handoff.export(session_id, provider.warning_checks)
            check_input(snapshot, validated)
            return {
                "designs": await run_cifs(snapshot["cif"], validated),
                "warnings": [issue["message"] for issue in snapshot["issues"]],
            }

        async def generate(
            session_id: str,
            *values,
            progress: gr.Progress = gr.Progress(),  # noqa: B008
        ) -> tuple:
            try:
                progress(None, desc="Checking current edits…")
                options = provider.validate(dict(zip(controls, values, strict=True)))
                snapshot = await handoff.export(session_id, provider.warning_checks)
                check_input(snapshot, options)
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
                        result_id, _ = await handoff.open(path.name, cif)
                        paths[result_id] = download.move_resource_to_block_cache(path)
                        choices.append((f"Design {index}", result_id))
                result_id = choices[1][1]
                warnings = "; ".join(issue["message"] for issue in snapshot["issues"])
                message = f"Generated from input revision {snapshot['revision']}. {warnings}".strip()
                designs = [
                    {"id": design_id, "name": label, "cif": cif}
                    for (label, design_id), cif in zip(choices[1:], results, strict=True)
                ]
                return (
                    result_id,
                    handoff.frame(result_id),
                    paths,
                    gr.Radio(choices=choices, value=result_id),
                    gr.DownloadButton(value=paths[result_id], visible=True),
                    gr.Markdown(value=message, visible=True),
                    gr.Row(visible=True),
                    gr.DownloadButton(value=archive_download, visible=True),
                    *panel(refold_support.panel_message("designs", designs=designs, selected=result_id)),
                )
            except Exception as error:
                logging.getLogger(__name__).exception("Studio generation failed")
                message = error.message if isinstance(error, gr.Error) else "The model request failed. Please retry."
                failure = gr.Markdown(value=f"**Generation failed.** {html.escape(message)} Your input is unchanged.")
                return gr.skip(), gr.skip(), gr.skip(), gr.skip(), gr.skip(), failure, gr.skip(), gr.skip(), *panel(gr.skip())

        def inspect(session_id: str, paths: dict) -> tuple:
            if session_id not in paths:
                raise gr.Error("Generate and select a design first")
            return (
                session_id,
                handoff.frame(session_id),
                gr.DownloadButton(value=paths[session_id], visible=paths[session_id] is not None),
                *panel(refold_support.panel_message("selected", id=session_id)),
            )

        def open_design(event: gr.EventData, paths: dict) -> tuple:
            """A row of the Refold panel was chosen: show that design, as the View selector does."""
            session_id = (event._data or {}).get("id")
            return (*inspect(session_id, paths), gr.Radio(value=session_id))

        def clear_results() -> tuple:
            return (
                {},
                gr.Radio(choices=[], value=None),
                gr.Markdown(value="Ready to generate."),
                gr.Row(visible=False),
                *panel(refold_support.panel_message("designs", designs=[], selected=None)),
            )

        def editor_example(event: gr.EventData) -> tuple:
            updates = provider.example_options(event._data)
            return *(updates.get(key, gr.skip()) for key in controls), *clear_results()

        bus = [refold_bus] if refolding else []
        editor.document(clear_results, outputs=[views, view, status, results_row, *bus], api_name=False)
        editor.example(editor_example, outputs=[*controls.values(), views, view, status, results_row, *bus], api_name=False)
        run.click(
            generate,
            [session, *controls.values()],
            [session, editor, views, view, download, status, results_row, download_all, *bus],
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
        view.input(inspect, [view, views], [session, editor, download, *bus], api_name=False, show_progress_on=status)
        if refolding:
            check_refold = getattr(provider, "validate_refold", None) or (
                lambda options: refold_support.validate_refold_options(options, refold_models, refold_limits)
            )

            async def refold_cif(cif: str, options: dict) -> dict:
                """Refold one design with the deployment's model: validated, off the API loop, one at a time."""
                validated = check_refold(options or {})
                design = refold_support.check_design_cif(cif)
                raw = await asyncio.to_thread(refold_fn, design, validated)
                return refold_support.shape_refold_result(raw)

            async def refold_design(event: gr.EventData) -> str:
                """The panel's request: the same `refold_cif`, answered through the bridge component."""
                data = event._data or {}
                request = str(data.get("request", ""))
                try:
                    result = await refold_cif(data.get("cif"), data.get("options"))
                except Exception as error:
                    logging.getLogger(__name__).exception("Studio refold failed")
                    reason = error.message if isinstance(error, gr.Error) else (
                        str(error) if isinstance(error, ValueError) else "The refold failed. Please retry."
                    )
                    return refold_support.panel_message("result", request=request, error=reason)
                return refold_support.panel_message("result", request=request, result=refold_support.panel_result(result))

            refold_api_cif = gr.Textbox(visible=False)
            refold_api_options = gr.JSON(visible=False)
            refold_api_result = gr.JSON(visible=False)
            refold_api_run = gr.Button(visible=False)
            refold_api_run.click(
                refold_cif,
                [refold_api_cif, refold_api_options],
                refold_api_result,
                api_name="refold_cif",
                concurrency_limit=1,
                concurrency_id="refold",
                show_progress="hidden",
            )
            refold_bus.refold(
                refold_design, None, refold_bus, api_name=False, concurrency_limit=1, concurrency_id="refold",
                show_progress="hidden",
            )
            refold_bus.open_design(
                open_design, [views], [session, editor, download, refold_bus, view], api_name=False,
                show_progress="hidden",
            )
    return demo.queue(max_size=8)


def create_app(
    *,
    provider: GenerationProvider,
    generate_fn: Callable[[str, dict], list[str]],
    refold_fn: Callable[[str, dict], dict] | None = None,
) -> FastAPI:
    """Mount the optional generation UI at /design beside the existing editor.

    `refold_fn`, optional, adds Studio's Refold panel and the `/refold_cif` route; see `create_demo`.
    """
    from annotation_studio.main import app as studio

    app = FastAPI()

    @app.middleware("http")
    async def landing(request, call_next):
        if request.url.path == "/" and not ({"session", "embed"} & request.query_params.keys()):
            return RedirectResponse("/design/")
        return await call_next(request)

    app = gr.mount_gradio_app(
        app,
        create_demo(studio, provider=provider, generate_fn=generate_fn, refold_fn=refold_fn),
        path="/design",
        theme=gr.themes.Default(primary_hue="blue"),
        css=STUDIO_CSS + getattr(provider, "css", ""),
        max_file_size="10mb",
        show_error=False,
        ssr_mode=False,
        footer_links=["api"],
        run_history=False,
    )
    app.mount("/", studio)
    return app
