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


def _demo_callbacks():
    pytest.importorskip("gradio")
    from annotation_studio.gradio import create_demo

    def generate(cif, options):
        return [cif] * options["samples"]

    demo = create_demo(app, provider=_SamplesProvider(), generate_fn=generate)
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
