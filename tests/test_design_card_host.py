"""The design-card mode of the Gradio host: configuration, the editor frame, the bridge, the generate request."""

import asyncio
import inspect
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


def _stream_demo(stream, **kwargs):
    from annotation_studio.gradio import create_demo

    return create_demo(app, provider=CardProvider(), generate_stream_fn=stream, **kwargs)


def _stream_of(designs=2, frames=3, fail_after=None):
    """A streaming model as the convention has it: frames of design 0, then the designs with their trajectories."""

    def stream(cif, options):
        for step in range(frames):
            if fail_after is not None and step == fail_after:
                raise RuntimeError("boom")
            yield {"status": "warming"} if step == 0 else {"status": f"s{step}"}
            yield {"frame": f"frame-{step}", "step": step, "steps": frames, "design": 0, "designs": designs}
        yield {
            "done": True,
            "designs": [cif] * designs,
            "trajectories": [f"traj-{k}" for k in range(designs)],
            "steps_run": [frames - 1, None][:designs],
            "nsteps": frames,
            "warnings": ["w"],
        }

    return stream


async def _collect(handler, data):
    import gradio as gr

    return [json.loads(item) async for item in handler(gr.EventData(None, data))]


def test_a_streaming_model_sends_the_bus_one_numbered_message_per_item_in_order(stable_cif_metadata):
    pytest.importorskip("gradio")
    from annotation_studio.gradio import StudioHandoff

    demo = _stream_demo(_stream_of())
    try:
        callbacks = _callbacks(demo)
        assert "card_abort" in callbacks

        async def run():
            session, _ = await StudioHandoff(app).open("input.cif", DESIGN)
            messages = await _collect(
                callbacks["card_generate_stream"], {"request": "g1", "session_id": session, "settings": {"samples": 2}}
            )
            assert [m["type"] for m in messages] == ["status", "frame", "status", "frame", "status", "frame", "generated"]
            assert [m["seq"] for m in messages] == list(range(1, 8))
            assert all(m["request"] == "g1" for m in messages)
            frames = [m for m in messages if m["type"] == "frame"]
            assert [(m["cif"], m["step"], m["steps"], m["design"], m["designs"]) for m in frames] == [
                (f"frame-{k}", k, 3, 0, 2) for k in range(3)
            ]
            final = messages[-1]
            assert [d["name"] for d in final["designs"]] == ["Design 1", "Design 2"]
            assert [d.get("trajectoryCif") for d in final["designs"]] == ["traj-0", "traj-1"]
            assert [d.get("stepsRun") for d in final["designs"]] == [2, None]
            assert final["nsteps"] == 3 and "w" in final["warnings"]
            assert all(d["id"] and d["cif"] for d in final["designs"])

        asyncio.run(run())
    finally:
        demo.close()


def test_a_streaming_model_that_fails_ends_the_stream_with_the_error(stable_cif_metadata):
    pytest.importorskip("gradio")
    from annotation_studio.gradio import StudioHandoff

    demo = _stream_demo(_stream_of(fail_after=2))
    try:
        callbacks = _callbacks(demo)

        async def run():
            session, _ = await StudioHandoff(app).open("input.cif", DESIGN)
            messages = await _collect(callbacks["card_generate_stream"], {"request": "g1", "session_id": session, "settings": {}})
            assert [m["type"] for m in messages][-1] == "generated"
            assert messages[-1]["error"] and "frame" in [m["type"] for m in messages]
            invalid = await _collect(callbacks["card_generate_stream"], {"request": "g2", "session_id": session, "settings": {"samples": 9}})
            assert invalid == [{"type": "generated", "request": "g2", "seq": 1, "error": "at most 4 designs"}]

        asyncio.run(run())
    finally:
        demo.close()


def test_stop_ends_the_consuming_of_a_stream_and_closes_it(stable_cif_metadata):
    pytest.importorskip("gradio")
    import gradio as gr
    from annotation_studio.gradio import StudioHandoff

    closed = []

    def stream(cif, options):
        try:
            for step in range(50):
                yield {"frame": f"f{step}", "step": step, "steps": 50, "design": 0, "designs": 1}
            yield {"done": True, "designs": [cif]}
        finally:
            closed.append(True)

    demo = _stream_demo(stream)
    try:
        callbacks = _callbacks(demo)

        async def run():
            session, _ = await StudioHandoff(app).open("input.cif", DESIGN)
            seen = []
            async for item in callbacks["card_generate_stream"](
                gr.EventData(None, {"request": "g1", "session_id": session, "settings": {}})
            ):
                seen.append(json.loads(item))
                if len(seen) == 3:
                    callbacks["card_abort"](gr.EventData(None, {"request": "g1"}))
            assert [m["type"] for m in seen] == ["frame"] * 3, "nothing more is sent after Stop"
            assert closed == [True]
            # The next request is not affected by the earlier Stop.
            again = await _collect(callbacks["card_generate_stream"], {"request": "g1", "session_id": session, "settings": {}})
            assert again[-1]["type"] == "generated" and len(again) == 51

        asyncio.run(run())
    finally:
        demo.close()


def test_a_provider_with_only_generate_fn_is_unchanged_and_one_with_only_a_stream_still_serves_the_api():
    pytest.importorskip("gradio")
    demo = _demo(CardProvider())
    try:
        callbacks = _callbacks(demo)
        assert "card_abort" not in callbacks
        assert not inspect.isasyncgenfunction(callbacks["card_generate"]), "the old handler returns one message"
        bridge = next(b for b in demo.blocks.values() if getattr(b, "elem_id", None) == "design-card-bridge")
        assert '"streaming"' not in bridge.js_on_load
    finally:
        demo.close()
    streaming = _stream_demo(_stream_of(designs=1, frames=1))
    try:
        bridge = next(b for b in streaming.blocks.values() if getattr(b, "elem_id", None) == "design-card-bridge")
        assert '"streaming": true' in bridge.js_on_load
        # The Gradio API route runs the stream to its end.
        route = _callbacks(streaming)["generate_cif"]
        result = asyncio.run(route(DESIGN, {"samples": 1}))
        assert len(result["designs"]) == 1
    finally:
        streaming.close()
    from annotation_studio.gradio import create_demo

    with pytest.raises(ValueError, match="generate_fn, generate_stream_fn"):
        create_demo(app, provider=CardProvider())
