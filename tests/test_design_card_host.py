"""The design-card mode of the Gradio host: configuration, the editor frame, the bridge, the generate request."""

import asyncio
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


def test_the_card_config_has_the_reference_defaults_and_hides_what_the_engine_lacks():
    config = design_card.card_config(
        CardProvider(settings={"earlyStop": None, "thinking": {"options": ["low", "high"]}})
    )
    assert config["engine"] == {"badge": "Test GPU"}
    assert config["settings"]["earlyStop"] is False
    assert config["settings"]["thinking"] == {"options": ["low", "high"], "default": "low"}
    assert config["settings"]["samples"] == {"min": 1, "max": 8, "default": 1}
    assert config["settings"]["partialDiffusion"] == {"percent": 40} and config["settings"]["seed"] is True
    assert config["settings"]["backboneK"]["default"] == 16 and config["settings"]["latentK"]["default"] == 4
    assert design_card.card_config(object()) is None
    guided = design_card.card_config(CardProvider(guide={"url": "https://example.org/guide/"}))
    assert guided["guide"] is True and guided["guideUrl"] == "https://example.org/guide/"
    assert "guide" not in config
    # A guide at an address of the host's own: the frame fetches it and shows it itself.
    local = design_card.card_config(CardProvider(guide={"url": "/help/index.html"}))
    assert local["guide"] is True and local["guideUrl"] == "/help/index.html"
    assert design_card.card_config(CardProvider(guide="/help/index.html"))["guideUrl"] == "/help/index.html"
    # Back-compat: a Guide with no address is a button the host's page answers.
    bare = design_card.card_config(CardProvider(guide=True))
    assert bare["guide"] is True and "guideUrl" not in bare
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
            "partialDiffusion": 40,
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
        assert sorted(b.elem_id for b in html_blocks if b.elem_id) == [
            "design-card-bridge",
            "design-card-style",
            "refold-bus",
            "studio-editor",
        ]
        editor = next(b for b in html_blocks if b.elem_id == "studio-editor")
        assert "card=1" in editor.value
        assert "design-card-notice" not in [b.elem_id for b in demo.blocks.values()]
        bridge = next(b for b in html_blocks if b.elem_id == "design-card-bridge")
        card = json.loads(re.search(r"const config = (\{.*?\});\n", bridge.js_on_load, re.S).group(1))
        assert card["engine"]["badge"] == "Test GPU"
        assert card["refold"]["models"] == [{"id": "openbind0"}]
        assert "'design-card'" in bridge.js_on_load and "'refold-result'" in bridge.js_on_load
        assert "example=" not in editor.value, "opens on the card's start screen"
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


def test_the_rfd4_provider_offers_the_card_with_every_setting_but_early_stop():
    from atomworks_studio_rfd4.generation import RFD4GenerationProvider

    assert design_card.card_config(RFD4GenerationProvider(k_defaults=(16.0, 4.0))) is None, "opt in"
    provider = RFD4GenerationProvider(k_defaults=(16.0, 4.0), card=True)
    config = design_card.card_config(provider)
    assert config["settings"]["earlyStop"] is False
    assert config["settings"]["thinking"]["options"] == ["none", "low", "medium", "high"]
    assert (config["settings"]["backboneK"]["default"], config["settings"]["latentK"]["default"]) == (16, 4)
    options = provider.validate(
        design_card.card_options(
            provider,
            {
                "samples": 2,
                "thinking": "none",
                "seed": 5,
                "partialDiffusion": 40,
                "backboneK": 16,
                "latentK": 4,
            },
        )
    )
    assert options["thinking"] == "none" and options["partial_diffusion_percent"] == 40


def test_what_judges_a_design_follows_the_task():
    assert design_card.design_kind("binder") == "binder" and design_card.design_kind("antibody") == "antibody"
    assert design_card.design_kind("unconditional") == "monomer"
    assert design_card.design_kind("enzyme") is None and design_card.design_kind(None) is None


def test_a_deployment_notice_stays_above_the_card():
    pytest.importorskip("gradio")

    class Noticed(CardProvider):
        def design_card(self):
            return {**self._card, "notice": "**Notice:** terms"}

    demo = _demo(Noticed())
    try:
        notice = next(b for b in demo.blocks.values() if getattr(b, "elem_id", None) == "design-card-notice")
        assert "terms" in notice.value
    finally:
        demo.close()


def test_the_bridge_no_longer_opens_the_guide_in_a_new_tab():
    js = design_card.bridge_js(design_card.card_config(CardProvider(guide={"url": "/help/index.html"})))
    assert "window.open" not in js
    assert '"guideUrl": "/help/index.html"' in js


def _guide_app(provider, **kwargs):
    from annotation_studio.gradio import create_app
    from fastapi.testclient import TestClient

    return TestClient(create_app(provider=provider, generate_fn=lambda cif, options: [cif], **kwargs))


def test_create_app_serves_the_guide_directory_at_help(tmp_path):
    (tmp_path / "img").mkdir()
    (tmp_path / "index.html").write_text("<main><h1>Sample guide</h1></main>")
    (tmp_path / "img/a.svg").write_text("<svg xmlns='http://www.w3.org/2000/svg'/>")
    client = _guide_app(CardProvider(guide={"url": "/help/index.html"}), guide_dir=tmp_path)
    for path in ("/help/", "/help/index.html"):
        response = client.get(path)
        assert response.status_code == 200 and "Sample guide" in response.text
    assert client.get("/help/img/a.svg").headers["content-type"].startswith("image/svg")
    assert client.get("/help/missing.html").status_code == 404
    # Studio itself stays where it was.
    assert client.get("/api/v1/health").status_code in (200, 404)
    assert client.get("/", params={"embed": "1"}).status_code in (200, 404, 307)


def test_a_provider_member_names_the_guide_directory_as_method_or_attribute(tmp_path):
    (tmp_path / "index.html").write_text("<main>from the provider</main>")

    class Method(CardProvider):
        def guide_dir(self):
            return tmp_path

    class Attribute(CardProvider):
        guide_dir = str(tmp_path)

    for provider in (Method(), Attribute()):
        assert "from the provider" in _guide_app(provider).get("/help/").text


def test_without_a_guide_directory_nothing_is_mounted_at_help(tmp_path):
    client = _guide_app(CardProvider())
    assert client.get("/help/").status_code in (404, 405)
    with pytest.raises(ValueError, match="not a directory"):
        _guide_app(CardProvider(), guide_dir=tmp_path / "nope")
