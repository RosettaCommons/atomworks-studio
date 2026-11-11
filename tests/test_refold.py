"""The optional refold hooks of the Gradio host: models, limits, validation, the route, and the panel's bridge."""

import asyncio
import json
import math
import re
from pathlib import Path

import pytest
from annotation_studio import refold
from annotation_studio.main import app

REPO = Path(__file__).parents[1]
DESIGN = (REPO / "tests/fixtures/inverse_folding_2kl8.cif").read_text()


class RefoldingProvider:
    """A generation provider with the refold hooks: only what the panel needs from a deployment."""

    title = "Refold test"
    warning_checks = frozenset({"missing_atoms"})
    default_example = None

    def __init__(self, models=None, limits=None):
        self._models = [{"id": "af3"}, {"id": "openbind0"}] if models is None else models
        self._limits = limits

    def controls(self):
        import gradio as gr

        return {"seed": gr.Number(value=1, precision=0, label="Seed")}

    def validate(self, options):
        return {"seed": int(options.get("seed", 1))}

    def example_options(self, example):
        return {}

    def refold_models(self):
        return self._models

    def refold_limits(self):
        return self._limits or {}


class PlainProvider:
    """A provider written before the refold hooks existed: the same members minus `refold_models` and `refold_limits`."""

    title = RefoldingProvider.title
    warning_checks = RefoldingProvider.warning_checks
    default_example = None
    controls = RefoldingProvider.controls
    validate = RefoldingProvider.validate
    example_options = RefoldingProvider.example_options


def make_plain():
    return PlainProvider()


def test_defaults_match_the_panel_defaults():
    """Python validation and Studio's panel (src/refold/session.ts) must offer the same choices out of the box."""
    source = (REPO / "packages/web/src/refold/session.ts").read_text()
    block = source[source.index("export const DEFAULT_LIMITS") : source.index("export type ResolvedLimits")]
    assert [int(n) for n in re.search(r"recycles: \{\s*options: \[([^\]]*)\]", block).group(1).split(",")] == (
        refold.DEFAULT_REFOLD_LIMITS["recycles"]["options"]
    )
    assert [int(n) for n in re.search(r"steps: \{\s*options: \[([^\]]*)\]", block).group(1).split(",")] == (
        refold.DEFAULT_REFOLD_LIMITS["steps"]["options"]
    )
    assert int(re.search(r"recycles: \{[^}]*default: (\d+)", block, re.S).group(1)) == 3
    assert int(re.search(r"steps: \{[^}]*default: (\d+)", block, re.S).group(1)) == 25
    assert refold.DEFAULT_REFOLD_LIMITS["recycles"]["default"] == 3
    assert refold.DEFAULT_REFOLD_LIMITS["steps"]["default"] == 25
    assert f"max: {2**32 - 1}" in block and refold.DEFAULT_REFOLD_LIMITS["seed"]["max"] == 2**32 - 1


def test_models_and_limits_are_read_from_the_provider():
    provider = RefoldingProvider(
        models=["openbind0", {"id": "of3", "label": "OpenFold 3", "terms": None}],
        limits={"steps": {"options": [25, 50], "default": 50}, "model": {"default": "of3"}},
    )
    assert refold.refold_models(provider) == [{"id": "openbind0"}, {"id": "of3", "label": "OpenFold 3", "terms": None}]
    limits = refold.refold_limits(provider)
    assert limits["steps"] == {"options": [25, 50], "default": 50}
    assert limits["recycles"] == refold.DEFAULT_REFOLD_LIMITS["recycles"]
    assert limits["model"] == {"default": "of3"}
    with pytest.raises(ValueError, match="Unknown refold limit"):
        refold.refold_limits(RefoldingProvider(limits={"temperature": {}}))
    with pytest.raises(ValueError, match="needs an id"):
        refold.refold_models(RefoldingProvider(models=[{"label": "x"}]))
    # A default that is not among the options falls back to the first option.
    assert refold.refold_limits(RefoldingProvider(limits={"steps": {"options": [10, 20], "default": 99}}))["steps"][
        "default"
    ] == 10


def test_a_provider_without_the_hooks_offers_nothing():
    class Old:
        title = "Old"

    assert refold.refold_models(Old()) == []


def test_options_are_checked_against_what_the_panel_offers():
    models = [{"id": "af3"}, {"id": "openbind0"}]
    limits = refold.refold_limits(RefoldingProvider())
    assert refold.validate_refold_options({}, models, limits) == {"model": "af3", "seed": 0, "recycles": 3, "steps": 25}
    assert refold.validate_refold_options(
        {"model": "openbind0", "seed": 7, "recycles": 5, "steps": 200}, models, limits
    ) == {"model": "openbind0", "seed": 7, "recycles": 5, "steps": 200}
    for bad, message in (
        ({"model": "nope"}, "Unknown refold model"),
        ({"seed": -1}, "seed must be between"),
        ({"seed": 2**32}, "seed must be between"),
        ({"seed": 1.5}, "whole number"),
        ({"seed": True}, "whole number"),
        ({"seed": "7"}, "whole number"),
        ({"recycles": 4}, "recycles must be one of"),
        ({"steps": 30}, "steps must be one of"),
        ({"temperature": 1}, "Unknown refold options"),
    ):
        with pytest.raises(ValueError, match=message):
            refold.validate_refold_options(bad, models, limits)
    # An integral float from JSON is accepted.
    assert refold.validate_refold_options({"seed": 7.0}, models, limits)["seed"] == 7


def test_the_result_is_json_safe_and_shaped_for_the_panel():
    shaped = refold.shape_refold_result(
        {
            "cif": "data_x",
            "metrics": {"rmsd": 1.25, "placed_rmsd": float("nan"), "plddt": 91, "min_ipae": math.inf, "iptm": None},
            "text": "AlphaFold 3 refold: 1.25 Å",
            "passed": True,
        }
    )
    assert shaped == {
        "cif": "data_x",
        "ligand_cif": None,
        "metrics": {"rmsd": 1.25, "placed_rmsd": None, "plddt": 91.0, "min_ipae": None, "iptm": None},
        "text": "AlphaFold 3 refold: 1.25 Å",
        "passed": True,
    }
    json.dumps(shaped, allow_nan=False)
    panel = refold.panel_result(shaped)
    assert panel["metrics"] == {"rmsd": 1.25, "placedRmsd": None, "plddt": 91.0, "minIpae": None, "iptm": None}
    assert panel["ligandCif"] is None and panel["pass"] is True
    assert refold.shape_refold_result({"cif": "x"})["passed"] is None, "no verdict unless the deployment gives one"
    for bad in (None, {}, {"cif": ""}, {"cif": 3}, "data_x"):
        with pytest.raises(ValueError, match="no structure"):
            refold.shape_refold_result(bad)
    for bad in (None, "", "   ", 5):
        with pytest.raises(ValueError, match="CIF string"):
            refold.check_design_cif(bad)
    with pytest.raises(ValueError, match="too large"):
        refold.check_design_cif("x" * (refold.MAX_REFOLD_CIF_BYTES + 1))


def _demo(provider, **kwargs):
    from annotation_studio.gradio import create_demo

    return create_demo(app, provider=provider, generate_fn=lambda cif, options: [cif, cif], **kwargs)


def _callbacks(demo):
    return {event.fn.__name__: event.fn for event in demo.fns.values() if event.fn}


def test_the_route_and_the_panel_share_one_refold():
    pytest.importorskip("gradio")
    import gradio as gr

    seen = []

    def fold(cif, options):
        seen.append((cif, options))
        if options["seed"] == 13:
            raise RuntimeError("secret detail the visitor should not see")
        return {"cif": "data_refold\n", "ligand_cif": "data_ligand\n", "metrics": {"rmsd": 0.8, "plddt": 92.0}, "passed": True}

    demo = _demo(RefoldingProvider(), refold_fn=fold)
    try:
        assert any(event["api_name"] == "refold_cif" for event in demo.config["dependencies"])
        callbacks = _callbacks(demo)

        async def run():
            direct = await callbacks["refold_cif"](DESIGN, {"model": "openbind0", "seed": 3, "recycles": 1, "steps": 50})
            assert direct["cif"] == "data_refold\n" and direct["ligand_cif"] == "data_ligand\n"
            assert direct["metrics"] == {"rmsd": 0.8, "plddt": 92.0} and direct["passed"] is True
            assert seen[-1] == (DESIGN, {"model": "openbind0", "seed": 3, "recycles": 1, "steps": 50})
            # Defaults fill in what is left out.
            await callbacks["refold_cif"](DESIGN, {})
            assert seen[-1][1] == {"model": "af3", "seed": 0, "recycles": 3, "steps": 25}
            with pytest.raises(ValueError, match="Unknown refold model"):
                await callbacks["refold_cif"](DESIGN, {"model": "nope"})
            assert len(seen) == 2, "an invalid request never reaches the model"

            # The panel's request goes through the same path and answers over the bridge.
            ok = json.loads(
                await callbacks["refold_design"](
                    gr.EventData(None, {"request": "r1", "cif": DESIGN, "options": {"model": "af3", "seed": 4, "recycles": 3, "steps": 25}})
                )
            )
            assert ok["type"] == "result" and ok["request"] == "r1"
            assert ok["result"]["ligandCif"] == "data_ligand\n" and ok["result"]["pass"] is True
            failed = json.loads(
                await callbacks["refold_design"](gr.EventData(None, {"request": "r2", "cif": DESIGN, "options": {"seed": 13}}))
            )
            assert failed == {"type": "result", "request": "r2", "error": "The refold failed. Please retry."}
            invalid = json.loads(
                await callbacks["refold_design"](gr.EventData(None, {"request": "r3", "cif": DESIGN, "options": {"steps": 7}}))
            )
            assert "steps must be one of" in invalid["error"]

        asyncio.run(run())
    finally:
        demo.close()


def test_generation_tells_the_panel_which_designs_exist(stable_cif_metadata):
    gr = pytest.importorskip("gradio")
    from annotation_studio.gradio import StudioHandoff

    demo = _demo(RefoldingProvider(), refold_fn=lambda cif, options: {"cif": "data_x"})
    try:
        callbacks = _callbacks(demo)

        async def run():
            session, _ = await StudioHandoff(app).open("input.cif", DESIGN)
            outputs = await callbacks["generate"](session, 1)
            *rest, message = outputs
            assert len(rest) == 8, "the existing outputs are unchanged and the bridge message is added last"
            parsed = json.loads(message)
            assert parsed["type"] == "designs"
            assert [d["name"] for d in parsed["designs"]] == ["Design 1", "Design 2"]
            assert all(d["cif"] for d in parsed["designs"])
            assert parsed["selected"] == parsed["designs"][0]["id"] == outputs[0]
            paths = outputs[2]
            # A row of the panel opens that design, as the View selector does, and updates the selector.
            second = parsed["designs"][1]["id"]
            opened = callbacks["open_design"](gr.EventData(None, {"id": second}), paths)
            assert opened[0] == second and f"session={second}" in opened[1]
            assert json.loads(opened[3]) == {"type": "selected", "id": second}
            assert opened[4].value == second
            with pytest.raises(gr.Error):
                callbacks["open_design"](gr.EventData(None, {"id": "unknown"}), paths)
            # Opening another document clears the panel.
            cleared = callbacks["clear_results"]()
            assert json.loads(cleared[-1]) == {"type": "designs", "designs": [], "selected": None}
            # A failed run leaves the panel as it was.
            failed = await callbacks["generate"]("", 1)
            assert len(failed) == 9 and failed[-1] == gr.skip() and "Open a structure" in failed[5].value

        asyncio.run(run())
    finally:
        demo.close()


def test_a_deployment_without_refold_is_unchanged(stable_cif_metadata):
    pytest.importorskip("gradio")
    from annotation_studio.gradio import StudioHandoff

    # Hooks on the provider but no refold_fn: no panel, no route, the same outputs as before.
    with_models_only = _demo(RefoldingProvider())
    plain = _demo(make_plain())
    try:
        for demo in (with_models_only, plain):
            assert not any(event["api_name"] == "refold_cif" for event in demo.config["dependencies"])
            html_blocks = [b for b in demo.blocks.values() if type(b).__name__ == "HTML"]
            assert [b.elem_id for b in html_blocks] == ["studio-editor"], "only the editor: no panel, no bridge"
            callbacks = _callbacks(demo)
            assert "refold_cif" not in callbacks and "open_design" not in callbacks

            async def run(callbacks=callbacks):
                session, _ = await StudioHandoff(app).open("input.cif", DESIGN)
                assert len(await callbacks["generate"](session, 1)) == 8
                assert len(callbacks["clear_results"]()) == 4

            asyncio.run(run())
    finally:
        with_models_only.close()
        plain.close()


def test_refold_fn_needs_a_provider_that_names_models():
    pytest.importorskip("gradio")
    with pytest.raises(ValueError, match="refold_models"):
        _demo(make_plain(), refold_fn=lambda cif, options: {"cif": "x"})


def test_the_panel_is_mounted_beside_the_editor():
    pytest.importorskip("gradio")
    demo = _demo(RefoldingProvider(models=[{"id": "openbind0"}]), refold_fn=lambda cif, options: {"cif": "x"})
    try:
        host = next(b for b in demo.blocks.values() if getattr(b, "elem_id", None) == "refold-panel")
        assert "/refold-panel.js" in host.js_on_load
        config = json.loads(re.search(r"const config = (\{.*?\});\n", host.js_on_load, re.S).group(1))
        assert config["models"] == [{"id": "openbind0"}]
        assert config["limits"]["steps"]["options"] == [25, 50, 100, 200]
        bus = next(b for b in demo.blocks.values() if getattr(b, "elem_id", None) == "refold-bus")
        assert "'refold'" in bus.js_on_load and "'open_design'" in bus.js_on_load
    finally:
        demo.close()
