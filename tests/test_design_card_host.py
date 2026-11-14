"""The design-card mode of the Gradio host: configuration, the editor frame, the bridge, the generate request."""

import asyncio
import base64
import json
import re
from pathlib import Path

import pytest
from annotation_studio import design_card
from annotation_studio.main import app

REPO = Path(__file__).parents[1]
DESIGN = (REPO / "tests/fixtures/inverse_folding_2kl8.cif").read_text()


class CardProvider:
    title = "Card test"
    warning_checks = frozenset({"missing_atoms"})
    default_example = "enzyme_design"

    def __init__(self, **card):
        self._card = {"engine": {"badge": "Test GPU"}, **card}

    def controls(self):  # pragma: no cover - must not be called in card mode
        raise AssertionError("the card replaces the Gradio controls")

    def validate(self, options):
        if options.get("samples", 1) > 4:
            raise ValueError("at most 4 designs")
        return {"samples": int(options.get("samples", 1)), "thinking": options.get("thinking", "low")}

    def example_options(self, example):
        return {}

    def design_card(self):
        return self._card

    def refold_models(self):
        return [{"id": "openbind0"}]


def _demo(provider, **kwargs):
    from annotation_studio.gradio import create_demo

    return create_demo(app, provider=provider, generate_fn=lambda cif, options: [cif] * options["samples"], **kwargs)


def _callbacks(demo):
    return {event.fn.__name__: event.fn for event in demo.fns.values() if event.fn}


def _decode(value):
    return json.loads(base64.urlsafe_b64decode(value + "=" * (-len(value) % 4)))


def test_the_card_config_has_the_reference_defaults_and_hides_what_the_engine_lacks():
    config = design_card.card_config(
        CardProvider(settings={"earlyStop": None, "thinking": {"options": ["low", "high"]}})
    )
    assert config["engine"] == {"badge": "Test GPU"}
    assert config["settings"]["earlyStop"] is None
    assert config["settings"]["thinking"] == {"options": ["low", "high"], "default": "low"}
    assert config["settings"]["samples"] == {"min": 1, "max": 8, "default": 1}
    assert config["settings"]["backboneK"]["default"] == 16 and config["settings"]["latentK"]["default"] == 4
    assert design_card.card_config(object()) is None
    with pytest.raises(ValueError, match="badge"):
        design_card.card_config(CardProvider(engine={}))
    with pytest.raises(ValueError, match="Unknown design-card setting"):
        design_card.card_config(CardProvider(settings={"nope": {}}))


def test_settings_become_provider_options():
    class Plain:
        pass

    got = design_card.card_options(
        Plain(),
        {
            "samples": 2,
            "thinking": "high",
            "seed": 7,
            "partialDiffusion": True,
            "partialPercent": 40,
            "backboneK": 12,
            "latentK": 3,
            "earlyStop": True,
            "other": 1,
        },
    )
    assert got == {
        "samples": 2,
        "thinking": "high",
        "seed": 7,
        "partial_diffusion": True,
        "partial_diffusion_percent": 40,
        "backbone_k": 12,
        "latent_k": 3,
        "early_stop": True,
    }

    class Mapped:
        def card_options(self, settings):
            return {"n": settings["samples"]}

    assert design_card.card_options(Mapped(), {"samples": 3}) == {"n": 3}


def test_card_mode_shows_only_the_editor_and_the_bridge():
    pytest.importorskip("gradio")
    demo = _demo(CardProvider(), refold_fn=lambda cif, options: {"cif": "x"})
    try:
        html_blocks = [b for b in demo.blocks.values() if type(b).__name__ == "HTML"]
        assert sorted(b.elem_id for b in html_blocks) == ["design-card-bridge", "refold-bus", "studio-editor"]
        editor = next(b for b in html_blocks if b.elem_id == "studio-editor")
        query = re.search(r"card=([^&\"]+)", editor.value).group(1)
        card = _decode(query)
        assert card["engine"]["badge"] == "Test GPU"
        assert card["refold"]["models"] == [{"id": "openbind0"}]
        assert "example=enzyme_design" in editor.value
        assert any(e["api_name"] == "generate_cif" for e in demo.config["dependencies"])
        assert any(e["api_name"] == "refold_cif" for e in demo.config["dependencies"])
        names = {type(b).__name__ for b in demo.blocks.values()}
        assert "Radio" not in names and "Slider" not in names, "no Gradio controls"
    finally:
        demo.close()


def test_the_card_request_generates_and_opens_each_design(stable_cif_metadata):
    pytest.importorskip("gradio")
    import gradio as gr
    from annotation_studio.gradio import StudioHandoff

    demo = _demo(CardProvider())
    try:
        callbacks = _callbacks(demo)

        async def run():
            session, _ = await StudioHandoff(app).open("input.cif", DESIGN)
            event = lambda data: gr.EventData(None, data)  # noqa: E731
            ok = json.loads(
                await callbacks["card_generate"](
                    event({"request": "g1", "session_id": session, "settings": {"samples": 2, "thinking": "low"}})
                )
            )
            assert ok["type"] == "generated" and ok["request"] == "g1"
            assert [d["name"] for d in ok["designs"]] == ["Design 1", "Design 2"]
            assert all(d["id"] and d["cif"] for d in ok["designs"])
            assert ok["designs"][0]["id"] != session
            invalid = json.loads(
                await callbacks["card_generate"](
                    event({"request": "g2", "session_id": session, "settings": {"samples": 9}})
                )
            )
            assert invalid == {"type": "generated", "request": "g2", "error": "at most 4 designs"}
            missing = json.loads(await callbacks["card_generate"](event({"request": "g3", "settings": {}})))
            assert "Open a structure" in missing["error"]

        asyncio.run(run())
    finally:
        demo.close()


def test_a_provider_without_design_card_keeps_its_layout():
    pytest.importorskip("gradio")
    from test_refold import RefoldingProvider

    demo = _demo(RefoldingProvider())
    try:
        assert "card_generate" not in _callbacks(demo)
        assert "generate" in _callbacks(demo)
    finally:
        demo.close()
