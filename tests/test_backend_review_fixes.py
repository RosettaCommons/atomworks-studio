"""Regressions for hosted-mode session handling: identity hand-off, session release, restart safety."""

import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest
from annotation_studio import main as studio_main
from annotation_studio.main import DocumentStore, app
from atomworks_studio_editing.document import StudioDocument
from fastapi.testclient import TestClient

FIXTURE = Path(__file__).parent / "fixtures" / "inverse_folding_2kl8.cif"
HEADER = "X-Forwarded-User"


def test_persistent_store_keeps_the_revision_across_reloads(tmp_path) -> None:
    store = DocumentStore(tmp_path)
    session_id = store.add(StudioDocument.from_cif(FIXTURE.read_text(), "input"))
    for value in (1, 0):
        store.call(session_id, lambda document, value=value: document.set_charge([0], value=value), persist=True)
    assert store.get(session_id).revision == 2

    reloaded = DocumentStore(tmp_path).get(session_id)
    # Restarting at 0 would let a client's stale expected_revision match a different document.
    assert reloaded.revision == 2
    assert reloaded.to_cif() == store.get(session_id).to_cif()


class _SamplesProvider:
    """Minimal GenerationProvider: the hand-off is under test, not a model's controls."""

    title = "Hand-off test"
    default_example = None
    warning_checks = frozenset({"missing_atoms"})  # as the RFD4 provider: incomplete residues warn

    def controls(self):
        import gradio as gr

        return {"samples": gr.Number(value=1, precision=0)}

    def validate(self, options):
        return {"samples": int(options.get("samples") or 1)}

    def validate_input(self, snapshot, options):
        return None

    def example_options(self, example):
        return {}


def _demo_callbacks(generate_fn=None):
    pytest.importorskip("gradio")
    from annotation_studio.gradio import create_demo

    def default_generate(cif, options):
        return [cif] * options["samples"]

    demo = create_demo(app, provider=_SamplesProvider(), generate_fn=generate_fn or default_generate)
    return demo, {event.fn.__name__: event.fn for event in demo.fns.values() if event.fn}


def test_gradio_hand_off_works_in_identity_mode_and_releases_sessions(monkeypatch) -> None:
    monkeypatch.setattr(studio_main, "IDENTITY_HEADER", HEADER)
    demo, callbacks = _demo_callbacks()
    alice = SimpleNamespace(headers={HEADER: "alice"}, session_hash="alice-tab")
    client = TestClient(app)

    def status(session_id: str, user: str) -> int:
        return client.get(f"/api/v1/sessions/{session_id}", headers={HEADER: user}).status_code

    async def run():
        cif = FIXTURE.read_text()
        sessions_before = len(studio_main.store._documents)
        # Without forwarding the proxy identity, every in-process hand-off call was a 401.
        direct = await callbacks["generate_cif"](cif, {"samples": 1}, alice)
        assert len(direct["designs"]) == 1
        # The temporary API session is released instead of occupying one of the 64 store slots.
        assert len(studio_main.store._documents) == sessions_before

        source = client.post("/api/v1/sessions", files={"file": ("input.cif", cif.encode())}, headers={HEADER: "alice"})
        source_id = source.json()["session_id"]
        values = (2,)
        first = await callbacks["generate"](source_id, *values, request=alice)
        first_results = [key for key in first[2] if key != source_id]
        assert len(first_results) == 2
        # Results belong to the authenticated user, so the iframe can open them and others cannot.
        assert all(status(key, "alice") == 200 for key in first_results)
        assert all(status(key, "bob") == 404 for key in first_results)

        second = await callbacks["generate"](source_id, *values, request=alice)
        assert all(status(key, "alice") == 404 for key in first_results), "earlier designs must be released"
        assert all(status(key, "alice") == 200 for key in second[2])
        assert status(source_id, "alice") == 200, "the input session must survive"

    try:
        asyncio.run(run())
    finally:
        demo.close()


def _generate_values(samples):
    return (samples,)  # _SamplesProvider.controls() is a single "samples" number


def test_result_sessions_opened_in_a_failed_generation_are_released(monkeypatch) -> None:
    """If a later design fails to open, the result sessions already opened in that call are closed
    instead of leaking into the bounded store."""

    def generate(cif, options):
        # The second "design" is not a valid CIF, so its hand-off open raises mid-loop.
        return [cif, "not a cif at all"]

    demo, callbacks = _demo_callbacks(generate)
    client = SimpleNamespace(headers={}, session_hash="failing-tab")

    async def run():
        source = TestClient(app).post("/api/sessions", files={"file": ("input.cif", FIXTURE.read_bytes())})
        source_id = source.json()["session_id"]
        before = len(studio_main.store._documents)
        result = await callbacks["generate"](source_id, *_generate_values(2), request=client)
        assert "failed" in str(result[5].value).lower(), "a failed generation should report failure"
        # No partially-opened design session is left behind.
        assert len(studio_main.store._documents) == before, "a failed generation leaked sessions"

    try:
        asyncio.run(run())
    finally:
        demo.close()


def test_a_tracked_source_is_released_when_a_later_generation_uses_a_different_source(monkeypatch) -> None:
    demo, callbacks = _demo_callbacks()
    client = SimpleNamespace(headers={}, session_hash="chain-tab")

    async def run():
        http = TestClient(app)
        src = http.post("/api/sessions", files={"file": ("input.cif", FIXTURE.read_bytes())}).json()["session_id"]
        first = await callbacks["generate"](src, *_generate_values(2), request=client)
        designs = [key for key in first[2] if key != src]
        assert len(designs) == 2 and all(http.get(f"/api/sessions/{d}").status_code == 200 for d in designs)
        # Generate from the first design; it must stay open (it is the current source)...
        await callbacks["generate"](designs[0], *_generate_values(1), request=client)
        assert http.get(f"/api/sessions/{designs[0]}").status_code == 200
        # ...then generating from the original input must release that earlier source.
        await callbacks["generate"](src, *_generate_values(1), request=client)
        assert http.get(f"/api/sessions/{designs[0]}").status_code == 404, "earlier source never released"

    try:
        asyncio.run(run())
    finally:
        demo.close()


def test_client_registry_is_bounded(monkeypatch) -> None:
    import annotation_studio.gradio as gradio_module

    monkeypatch.setattr(gradio_module, "MAX_TRACKED_CLIENTS", 2)
    demo, callbacks = _demo_callbacks()

    async def run():
        http = TestClient(app)
        src = http.post("/api/sessions", files={"file": ("input.cif", FIXTURE.read_bytes())}).json()["session_id"]
        designs = []
        for tab in range(3):  # exceed the cap of 2 tracked clients
            request = SimpleNamespace(headers={}, session_hash=f"tab-{tab}")
            out = await callbacks["generate"](src, *_generate_values(1), request=request)
            designs.append(next(key for key in out[2] if key != src))
        # The evicted (oldest) client's design session is released; the registry stays bounded.
        assert http.get(f"/api/sessions/{designs[0]}").status_code == 404
        assert all(http.get(f"/api/sessions/{d}").status_code == 200 for d in designs[1:])

    try:
        asyncio.run(run())
    finally:
        demo.close()
