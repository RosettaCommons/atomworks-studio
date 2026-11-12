# ruff: noqa: I001
"""Cross-check browser mutations against the existing PyMOL bridge."""

from pathlib import Path

import numpy as np
import pytest

pymol = pytest.importorskip("pymol", reason="PyMOL is not installed")
pymol.finish_launching(["pymol", "-qck"])

from pymol import cmd  # noqa: E402

from atomworks.io.config import ParseConfig  # noqa: E402
from atomworks.io.utils.io_utils import to_cif_file  # noqa: E402
from atomworks_studio_pymol.bridge import load_structure, selection_to_indices  # noqa: E402
from atomworks_studio_pymol.editors import editor_for  # noqa: E402
from atomworks_studio_pymol.editors.widgets import PairValueEditor  # noqa: E402
from atomworks_studio_pymol.state import STATE  # noqa: E402
from atomworks_studio_editing.annotations import set_annotation_mask  # noqa: E402
from atomworks.ml.conditions import C_DIS  # noqa: E402
from atomworks_studio_editing.mutations import edit_distance_restraint  # noqa: E402
from atomworks_studio_rfd4.model import C_HOT, C_RAS  # noqa: E402
from atomworks_studio_rfd4.condition_contract import CONDITION_DEFINITIONS  # noqa: E402
from atomworks_studio_rfd4.pymol.editors import _run_annotation_validation  # noqa: E402

from annotation_studio.core import StudioDocument  # noqa: E402
from atomworks_studio_rfd4 import CONDITION_PROVIDER, VALIDATION_PROVIDER  # noqa: E402

pytestmark = pytest.mark.usefixtures("stable_cif_metadata")

FIXTURE = Path(__file__).parent / "fixtures" / "SAM_hbonds.cif"


def _rfd4_document(cif: str, name: str) -> StudioDocument:
    return StudioDocument.from_cif(
        cif,
        name,
        condition_provider=CONDITION_PROVIDER,
        validation_provider=VALIDATION_PROVIDER,
    )


def test_selection_and_condition_outputs_match_pymol_plugin() -> None:
    cmd.reinitialize()
    STATE.clear_all()
    config = ParseConfig.from_preset(
        "minimal",
        build_assembly=["1"],
        load_standard_annotations=True,
        return_atom_array_plus=True,
    )
    name = load_structure(FIXTURE, config=config, obj_name="conformance")
    plugin_array = STATE.arrays[name]
    document = _rfd4_document(FIXTURE.read_text(), FIXTURE.stem)

    chain = str(plugin_array.chain_iid[0])
    residue = int(plugin_array.res_id[0])
    expression = f"{name} and chain {chain} and resi {residue}"
    indices = sorted(selection_to_indices(expression, STATE.index_maps[name]))
    assert indices
    assert indices == document.resolve_indices([indices[0]], "residue").tolist()

    hotspot = C_HOT.mask(plugin_array, default="generate").copy()
    hotspot[indices] = True
    set_annotation_mask(C_HOT, plugin_array, hotspot)
    rasa = C_RAS.annotation(plugin_array, default="generate").copy()
    rasa[indices] = 3
    C_RAS.set_annotation(plugin_array, rasa)
    rasa_mask = C_RAS.mask(plugin_array, default="generate").copy()
    rasa_mask[indices] = True
    set_annotation_mask(C_RAS, plugin_array, rasa_mask)

    document.set_condition("hotspot", indices, enabled=True)
    document.set_condition("rasa", indices, enabled=True, value=3)

    assert np.array_equal(
        C_HOT.mask(document.array, default="generate"),
        C_HOT.mask(plugin_array, default="generate"),
    )
    assert np.array_equal(
        C_RAS.annotation(document.array, default="generate"),
        C_RAS.annotation(plugin_array, default="generate"),
    )

    studio_summary = {entry["name"]: entry for entry in document.annotation_details()}
    plugin_hotspot_count = int(C_HOT.mask(plugin_array, default="generate").sum())
    assert studio_summary["hotspot"]["count"] == plugin_hotspot_count
    plugin_rasa = C_RAS.annotation(plugin_array, default="generate")
    plugin_rasa_mask = C_RAS.mask(plugin_array, default="generate")
    plugin_exposed_count = int((plugin_rasa_mask & (plugin_rasa == 3)).sum())
    exposed = next(value for value in studio_summary["rasa"]["values"] if value["label"] == "EXPOSED")
    assert exposed["count"] == plugin_exposed_count


def test_every_shared_condition_roundtrips_into_pymol(tmp_path: Path) -> None:
    document = _rfd4_document(FIXTURE.read_text(), "all_conditions")
    mutations = [
        ("sequence", True, None, "residue"),
        ("coordinate", True, None, "atom"),
        ("index", True, None, "residue"),
        ("hotspot", True, None, "atom"),
        ("rasa", True, 3, "atom"),
        ("hbond", True, 1, "atom"),
        ("index_group", True, 7, "residue"),
        ("coordinate_group", True, 2, "atom"),
        ("chain_centroid", True, [1.0, 2.0, 3.0], "chain"),
    ]
    for condition, enabled, value, scope in mutations:
        # Upstream rejects internal groups on atoms with absolute targets.
        indices = [2] if condition == "coordinate_group" else [0]
        document.set_condition(condition, indices, enabled=enabled, value=value, scope=scope)
    edit_distance_restraint(document.array, 0, 1, "set", 3.25)

    exported = tmp_path / "all_conditions.cif"
    to_cif_file(document.array, exported, save_standard_annotations=True, chain_disambiguation="chain_iid")
    cmd.reinitialize()
    STATE.clear_all()
    name = load_structure(
        exported,
        config=ParseConfig.from_preset(
            "minimal", build_assembly=["1"], load_standard_annotations=True, return_atom_array_plus=True
        ),
        obj_name="all_conditions",
    )
    plugin_array = STATE.arrays[name]
    assert len(plugin_array) == len(document.array)

    for definition in CONDITION_DEFINITIONS:
        condition = definition.condition
        if definition.kind == "pair":
            plugin_annotation = condition.annotation(plugin_array, default="raise")
            document_annotation = condition.annotation(document.array, default="raise")
            assert plugin_annotation.pairs.tolist() == document_annotation.pairs.tolist()
            np.testing.assert_allclose(plugin_annotation.values, document_annotation.values)
            continue
        assert np.array_equal(
            condition.mask(plugin_array, default="generate"),
            condition.mask(document.array, default="generate"),
        ), definition.key
        if condition.full_name in document.array.get_annotation_categories():
            np.testing.assert_equal(
                condition.annotation(plugin_array, default="raise"),
                condition.annotation(document.array, default="raise"),
                err_msg=definition.key,
            )


def test_distance_condition_uses_existing_pair_editor() -> None:
    from atomworks_studio_rfd4.pymol import condition_registry

    condition_registry.apply()

    assert editor_for(C_DIS) is PairValueEditor


def test_pymol_and_studio_share_annotation_validation(monkeypatch) -> None:
    import atomworks_studio_rfd4
    from atomworks_studio_rfd4.pymol import editors

    document = _rfd4_document(FIXTURE.read_text(), "validation")
    issue = {"severity": "error", "check": "res_id_gap", "message": "upstream index-group report"}
    monkeypatch.setattr(atomworks_studio_rfd4, "validate_rfd4", lambda *args, **kwargs: [issue])
    monkeypatch.setattr(editors, "validate_rfd4", lambda *args, **kwargs: [issue])
    assert _run_annotation_validation(document.array) == ["[res_id_gap] upstream index-group report"]
    assert issue in document.validate(full_pipeline=True)


def test_console_edits_and_reload_share_document_undo() -> None:
    from atomworks_studio_pymol.bridge import reload_structure_in_pymol
    from atomworks_studio_pymol.commands import _aw_delete_selection, _aw_undo

    cmd.reinitialize()
    STATE.clear_all()
    name = load_structure(FIXTURE, config=ParseConfig.from_preset("minimal"), obj_name="shared_history")
    document = STATE.document(name)
    original_count = len(document.array)
    cmd.select("sele", f"{name} and index 1")
    _aw_delete_selection()
    assert STATE.document(name) is document
    assert len(document.array) == original_count - 1
    reload_structure_in_pymol(name)
    _aw_undo()
    assert STATE.document(name) is document
    assert len(document.array) == original_count
    assert not document.undo()


def test_native_cath_widget_uses_shared_validation_and_undo(monkeypatch) -> None:
    import os

    if "QT_QPA_PLATFORM" not in os.environ:
        monkeypatch.setenv("QT_QPA_PLATFORM", "offscreen")
    from pymol.Qt import QtWidgets

    from atomworks_studio_rfd4.model import C_CATH
    from atomworks_studio_rfd4.pymol.cath_editor import CathEditor

    application = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])
    cmd.reinitialize()
    STATE.clear_all()
    name = load_structure(FIXTURE, config=ParseConfig.from_preset("minimal"), obj_name="cath_widget")
    editor = CathEditor(C_CATH, STATE)
    editor._label.setText("2.60.40")
    cmd.select("sele", f"{name} and index 1")
    selected = selection_to_indices("sele", STATE.index_maps[name])
    assert selected
    button = next(
        button for button in editor.findChildren(QtWidgets.QPushButton) if button.text().startswith("Set CAT")
    )
    button.click()
    application.processEvents()
    assert C_CATH.annotation(STATE.arrays[name])[selected[0]] == "2.60.40.x"
    assert STATE.pop_snapshot(name) is not None
    assert not C_CATH.mask(STATE.arrays[name], default="generate")[selected[0]]
    editor.close()


@pytest.mark.parametrize("kind", ["rasa", "group", "centroid", "probability"])
def test_native_specialized_editors_share_undo(monkeypatch, kind) -> None:
    import os

    if "QT_QPA_PLATFORM" not in os.environ:
        monkeypatch.setenv("QT_QPA_PLATFORM", "offscreen")
    from pymol.Qt import QtWidgets
    from atomworks_studio_rfd4.model import C_CENTROID, C_CRDGRP, conditions
    from atomworks_studio_rfd4.pymol.chain_centroid_editor import ChainCentroidEditor
    from atomworks_studio_rfd4.pymol.document_editors import SequenceProbabilityEditor
    from atomworks_studio_rfd4.pymol.group_editor import GroupEditor
    from atomworks_studio_rfd4.pymol.widgets import ValueButtonEditor

    if kind == "probability" and not hasattr(conditions, "SEQUENCE_PROBABILITY_CONDITIONS"):
        pytest.skip("requires sequence probability conditions")
    application = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])
    cmd.reinitialize()
    STATE.clear_all()
    name = load_structure(FIXTURE, config=ParseConfig.from_preset("minimal"), obj_name="specialized_widget")
    document = STATE.document(name)
    before = document.to_cif()
    cmd.select("sele", f"{name} and index 1")
    if kind == "rasa":
        editor = ValueButtonEditor(C_RAS, STATE, named_values=[("EXPOSED", 3)], null_value=0)
        editor._apply_value(3)
    elif kind == "group":
        editor = GroupEditor(C_CRDGRP, STATE)
        editor._new_group_from_selection()
    elif kind == "centroid":
        editor = ChainCentroidEditor(C_CENTROID, STATE)
        editor._spin_x.setValue(3.0)
        editor._apply(True)
    else:
        editor = SequenceProbabilityEditor(conditions.SEQUENCE_PROBABILITY_CONDITIONS[0], STATE)
        editor._value_widget.setValue(0.0)
        editor.apply_to_selection()
    application.processEvents()
    assert document.revision == 1
    assert document.to_cif() != before
    assert document.undo()
    assert document.to_cif() == before
    assert not document.undo()
    editor.close()


def test_native_coordinate_buttons_share_document_history(monkeypatch) -> None:
    import os

    if "QT_QPA_PLATFORM" not in os.environ:
        monkeypatch.setenv("QT_QPA_PLATFORM", "offscreen")
    from pymol.Qt import QtWidgets
    from atomworks.ml.conditions import C_CRD
    from atomworks_studio_rfd4.pymol.document_editors import DocumentMaskEditor
    from atomworks_studio_pymol.display import display_atom_ids

    application = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])
    cmd.reinitialize()
    STATE.clear_all()
    name = load_structure(FIXTURE, config=ParseConfig.from_preset("minimal"), obj_name="coordinate_widget")
    document = STATE.document(name)
    before = document.to_cif()
    editor = DocumentMaskEditor(C_CRD, STATE)
    resolved = int(np.flatnonzero(np.isfinite(document.array.coord).all(axis=1))[0])
    cmd.select("sele", f"{name} and id {display_atom_ids(document.array)[resolved]}")
    selected = selection_to_indices("sele", STATE.index_maps[name])
    button = next(
        button for button in editor.findChildren(QtWidgets.QPushButton) if button.text().startswith("Set True")
    )
    button.click()
    application.processEvents()
    assert C_CRD.mask(document.array)[selected].all()
    assert document.revision == 1
    assert document.undo()
    assert document.to_cif() == before
    editor.close()


def test_native_delete_group_requires_confirmation_and_preserves_undo(monkeypatch) -> None:
    import os

    from atomworks_studio_rfd4.model import C_CRDGRP, C_INTCRD

    if not hasattr(C_CRDGRP, "is_internal"):
        pytest.skip("requires saved-target preservation contract")
    if "QT_QPA_PLATFORM" not in os.environ:
        monkeypatch.setenv("QT_QPA_PLATFORM", "offscreen")
    from pymol.Qt import QtWidgets
    from atomworks_studio_rfd4.pymol.group_editor import GroupEditor

    application = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])
    cmd.reinitialize()
    STATE.clear_all()
    name = load_structure(FIXTURE, config=ParseConfig.from_preset("minimal"), obj_name="saved_targets_widget")
    document = STATE.document(name)
    document.condition_provider = CONDITION_PROVIDER
    cmd.select("sele", f"{name} and index 1+2")
    selected = selection_to_indices("sele", STATE.index_maps[name])
    assert len(selected) == 2
    document.set_condition("coordinate_group", selected, value=7)
    targets = C_INTCRD.default_annotation(document.array)
    targets[selected] = [[-1, 0, 0], [1, 0, 0]]
    C_INTCRD.set_annotation(document.array, targets)
    revision = document.revision
    editor = GroupEditor(C_CRDGRP, STATE)
    editor._group_combo.setCurrentIndex(editor._group_combo.findData(7))
    assert not any("Clear saved targets" in button.text() for button in editor.findChildren(QtWidgets.QPushButton))
    monkeypatch.setattr(QtWidgets.QMessageBox, "warning", lambda *args: QtWidgets.QMessageBox.Cancel)
    editor._delete_group()
    assert document.revision == revision
    np.testing.assert_equal(C_INTCRD.annotation(document.array), targets)
    monkeypatch.setattr(QtWidgets.QMessageBox, "warning", lambda *args: QtWidgets.QMessageBox.Yes)
    editor._delete_group()
    application.processEvents()
    assert np.isnan(C_INTCRD.annotation(document.array)[selected]).all()
    assert document.undo()
    np.testing.assert_equal(C_INTCRD.annotation(document.array), targets)
    editor.close()


def test_group_color_overflow_highlights_one_group_without_reusing_colors(monkeypatch) -> None:
    from atomworks_studio_rfd4.pymol.visualize import _HIGHLIGHTED_GROUPS, _PALETTE, _color_by_group
    from pymol.Qt import QtWidgets

    application = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])
    cmd.reinitialize()
    STATE.clear_all()
    name = load_structure(FIXTURE, config=ParseConfig.from_preset("minimal"), obj_name="group_colors")
    document = STATE.document(name)
    before = document.to_cif()
    groups = np.full(len(document.array), -1)
    groups[:8] = np.arange(1, 9)
    original = []
    cmd.iterate(name, "colors.append((ID, color))", space={"colors": original})
    monkeypatch.setattr(QtWidgets.QInputDialog, "getItem", lambda *args: ("8", False))
    _color_by_group(document.array, name, groups, {-1: "gray60"})
    cancelled = []
    cmd.iterate(name, "colors.append((ID, color))", space={"colors": cancelled})
    assert cancelled == original
    _HIGHLIGHTED_GROUPS.clear()  # a cancelled choice is remembered until the user chooses again
    monkeypatch.setattr(QtWidgets.QInputDialog, "getItem", lambda *args: ("8", True))
    _color_by_group(document.array, name, groups, {-1: "gray60"})
    application.processEvents()
    colors = []
    cmd.iterate(name, "colors.append(color)", space={"colors": colors})
    assert colors.count(cmd.get_color_index(_PALETTE[0])) == 1
    assert document.to_cif() == before
