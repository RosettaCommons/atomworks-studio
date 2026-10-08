"""The shared host uses current Studio edits and preserves them when a model fails."""

import asyncio
import zipfile
from pathlib import Path

import httpx
import pytest
from annotation_studio.main import app


@pytest.mark.parametrize("samples", [1, 8])
def test_edit_generate_reopen(samples, stable_cif_metadata):
    gr = pytest.importorskip("gradio")
    from annotation_studio.gradio import StudioHandoff, create_demo
    from atomworks_studio_rfd4.generation import RFD4GenerationProvider

    provider = RFD4GenerationProvider(noise_defaults=(0.3, 0.1))
    submitted = []

    def generate(cif, options):
        if options["seed"] == 43:
            raise RuntimeError("Model failed")
        submitted.append((cif, options))
        return [cif] * options["samples"]

    demo = create_demo(app, provider=provider, generate_fn=generate)
    assert any(event["api_name"] == "generate_cif" for event in demo.config["dependencies"])
    callbacks = {event.fn.__name__: event.fn for event in demo.fns.values() if event.fn}

    async def run():
        handoff = StudioHandoff(app)
        source = Path(__file__).parents[1] / "packages/api/annotation_studio/examples/inverse_folding.cif"
        session, _ = await handoff.open("input.cif", source.read_text())
        async with httpx.AsyncClient(transport=handoff.transport, base_url="http://studio") as client:
            response = await client.post(
                f"/api/v1/sessions/{session}/conditions",
                json={"condition": "sequence", "atom_indices": [0], "scope": "residue", "enabled": True},
            )
            response.raise_for_status()
        snapshot = await handoff.export(session, provider.warning_checks)
        assert snapshot["revision"] > 0
        task, *_ = callbacks["editor_example"](gr.EventData(None, {"task": "inverse_folding"}))
        reopened, frame, paths, view, download, status, _, batch = await callbacks["generate"](
            session, task, "high", samples, 42, 0.25, 0.15
        )
        assert submitted[0][0] == snapshot["cif"]
        assert submitted[0][1]["task"] == "inverse_folding"
        assert submitted[0][1]["backbone_noise"] == 0.25
        assert f"revision {snapshot['revision']}" in status.value
        assert len(view.choices) == samples + 1
        assert reopened != session and f"session={reopened}" in frame
        assert Path(download.value["path"]).read_text() == snapshot["cif"]
        with zipfile.ZipFile(batch.value["path"]) as archive:
            assert len(archive.namelist()) == samples
        assert callbacks["inspect"](session, paths)[0] == session
        assert (await handoff.export(session, provider.warning_checks))["cif"] == snapshot["cif"]
        direct = await callbacks["generate_cif"](source.read_text(), {"task": "inverse_folding", "samples": 1})
        assert direct["designs"] == [submitted[-1][0]]
        assert submitted[-1][1]["task"] == "inverse_folding"
        failed = await callbacks["generate"](session, task, "high", samples, 43, 0.25, 0.15)
        assert "Your input is unchanged" in failed[5].value and failed[1] == gr.skip()
        assert (await handoff.export(session, provider.warning_checks))["cif"] == snapshot["cif"]
        failed = await callbacks["generate"]("", task, "high", samples, 42, 0.25, 0.15)
        assert "Open a structure" in failed[5].value
        assert failed[1] == gr.skip() and len(submitted) == 2

    try:
        asyncio.run(run())
    finally:
        demo.close()
