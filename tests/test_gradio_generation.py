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

    provider = RFD4GenerationProvider(k_defaults=(16.0, 4.0))
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
        assert "example=enzyme_design" in handoff.frame(example=provider.default_example)
        assert "example=" not in handoff.frame("existing-session", example=provider.default_example)
        source = Path(__file__).parents[1] / "tests/fixtures/inverse_folding_2kl8.cif"
        session, _ = await handoff.open("input.cif", source.read_text())
        async with httpx.AsyncClient(transport=handoff.transport, base_url="http://studio") as client:
            response = await client.post(
                f"/api/v1/sessions/{session}/conditions",
                json={"condition": "sequence", "atom_indices": [0], "scope": "residue", "enabled": True},
            )
            response.raise_for_status()
        snapshot = await handoff.export(session, provider.warning_checks)
        assert snapshot["revision"] > 0
        updates = callbacks["editor_example"](gr.EventData(None, {"task": "inverse_folding"}))
        # Switching example resets partial diffusion, and greys its percentage out with it.
        assert updates[6] is False
        assert updates[5].get("interactive") is False
        reopened, frame, paths, view, download, status, _, batch = await callbacks["generate"](
            session, "high", samples, 42, 8.0, 2.0, 70, False
        )
        assert submitted[0][0] == snapshot["cif"]
        assert "inverse_folding" not in submitted[0][1]
        assert submitted[0][1]["backbone_k"] == 8.0
        assert submitted[0][1]["latent_k"] == 2.0
        assert f"revision {snapshot['revision']}" in status.value
        assert len(view.choices) == samples + 1
        assert reopened != session and f"session={reopened}" in frame
        assert Path(download.value["path"]).read_text() == snapshot["cif"]
        with zipfile.ZipFile(batch.value["path"]) as archive:
            assert len(archive.namelist()) == samples
        assert callbacks["inspect"](session, paths)[0] == session
        assert (await handoff.export(session, provider.warning_checks))["cif"] == snapshot["cif"]
        direct = await callbacks["generate_cif"](source.read_text(), {"samples": 1})
        assert direct["designs"] == [submitted[-1][0]]
        assert "inverse_folding" not in submitted[-1][1]
        failed = await callbacks["generate"](session, "high", samples, 43, 8.0, 2.0, 70, False)
        assert "Your input is unchanged" in failed[5].value and failed[1] == gr.skip()
        assert (await handoff.export(session, provider.warning_checks))["cif"] == snapshot["cif"]
        failed = await callbacks["generate"]("", "high", samples, 42, 8.0, 2.0, 70, False)
        assert "Open a structure" in failed[5].value
        assert failed[1] == gr.skip() and len(submitted) == 2

    try:
        asyncio.run(run())
    finally:
        demo.close()


def test_k_controls_use_model_defaults():
    gr = pytest.importorskip("gradio")
    from atomworks_studio_rfd4.generation import RFD4GenerationProvider

    provider = RFD4GenerationProvider(k_defaults=(16.0, 4.0))
    with gr.Blocks() as demo:
        controls = provider.controls()
    try:
        for name, default, maximum in (("backbone_k", 16.0, 20.0), ("latent_k", 4.0, 6.0)):
            slider = controls[name]
            assert (slider.minimum, slider.maximum, slider.value) == (1, maximum, default)
        assert "task" not in controls
        assert controls["partial_diffusion"].value is False
        assert provider.validate({})["partial_diffusion"] is False
        partial = controls["partial_diffusion_percent"]
        assert (partial.minimum, partial.maximum, partial.value, partial.interactive) == (1, 100, 70, False)
        assert provider.validate({})["partial_diffusion_percent"] == 70
        for options in (
            {"backbone_k": 16.0, "latent_k": 4.0},
            {"backbone_k": 1.0, "latent_k": 1.0},
            {"backbone_k": 20.0, "latent_k": 6.0},
        ):
            validated = provider.validate(options)
            assert all(validated[key] == value for key, value in options.items())
        assert provider.validate({})["backbone_k"] is None
        assert provider.validate({})["latent_k"] is None
    finally:
        demo.close()


@pytest.mark.parametrize(
    "options",
    [
        {"backbone_k": 0.9},
        {"latent_k": 0.9},
        {"backbone_k": 20.1},
        {"latent_k": 6.1},
        {"backbone_k": float("inf")},
        {"latent_k": float("nan")},
        {"backbone_noise": 0.3},
        {"inverse_folding": True},
        {"partial_diffusion_percent": 0},
        {"partial_diffusion_percent": 101},
        {"partial_diffusion_percent": float("nan")},
    ],
)
def test_invalid_generation_options_are_rejected(options):
    pytest.importorskip("gradio")
    from atomworks_studio_rfd4.generation import RFD4GenerationProvider

    with pytest.raises(ValueError):
        RFD4GenerationProvider(k_defaults=(16.0, 4.0)).validate(options)


@pytest.mark.parametrize("realized", [False, True])
def test_partial_diffusion_rejects_segments_before_model_call(realized, stable_cif_metadata):
    gr = pytest.importorskip("gradio")
    from annotation_studio.gradio import StudioHandoff, create_demo
    from atomworks_studio_rfd4.generation import RFD4GenerationProvider

    provider = RFD4GenerationProvider(k_defaults=(16.0, 4.0))
    submitted = []

    def generate(cif, options):
        submitted.append(options)
        return [cif]

    demo = create_demo(app, provider=provider, generate_fn=generate)
    callbacks = {event.fn.__name__: event.fn for event in demo.fns.values() if event.fn}

    async def run():
        handoff = StudioHandoff(app)
        source = Path(__file__).parents[1] / "packages/api/annotation_studio/examples/protein_binder.cif"
        session, _ = await handoff.open("input.cif", source.read_text())
        if realized:
            async with httpx.AsyncClient(transport=handoff.transport, base_url="http://studio") as client:
                response = await client.post(f"/api/v1/sessions/{session}/segments/realize", json={"seed": 7})
                response.raise_for_status()
        snapshot = await handoff.export(session, provider.warning_checks)
        assert snapshot["has_expandable_segments"]
        failed = await callbacks["generate"](session, "medium", 1, 42, 16.0, 4.0, 70, True)
        assert "undefined residues" in failed[5].value
        assert "Generate an input first" in failed[5].value
        assert "partial diffusion example" in failed[5].value
        assert failed[1] == gr.skip()
        with pytest.raises(gr.Error, match="undefined residues"):
            await callbacks["generate_cif"](snapshot["cif"], {"partial_diffusion": True})
        assert not submitted
        # Expandable segments remain valid for full generation.
        await callbacks["generate_cif"](snapshot["cif"], {})
        assert len(submitted) == 1
        # A defined structure accepts partial diffusion and forwards the chosen percentage.
        defined = source.with_name("partial_diffusion.cif").read_text()
        await callbacks["generate_cif"](defined, {"partial_diffusion": True, "partial_diffusion_percent": 85})
        assert submitted[-1]["partial_diffusion_percent"] == 85

    try:
        asyncio.run(run())
    finally:
        demo.close()
