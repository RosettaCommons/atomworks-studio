"""Regression tests for PyMOL plugin review findings (object targeting, load/save, picking)."""

import os
from pathlib import Path

import biotite.structure as struc
import pytest
from atomworks.io.utils.atom_array_plus import as_atom_array_plus
from atomworks.ml.conditions import C_DIS
from atomworks_studio_editing.loading import build_load_config
from atomworks_studio_pymol import commands
from atomworks_studio_pymol.bond_wizard import BondWizard
from atomworks_studio_pymol.bridge import (
    combine_visible,
    find_pymol_array_divergence,
    load_structure,
    reload_structure_in_pymol,
    selection_to_indices,
)
from atomworks_studio_pymol.chain_wizard import ChainWizard
from atomworks_studio_pymol.charge_wizard import ChargeWizard
from atomworks_studio_pymol.editors.widgets import BaseAnnotationEditor, PairValueEditor
from atomworks_studio_pymol.state import STATE
from pymol import cmd
from pymol.Qt import QtWidgets

REPO_ROOT = Path(__file__).resolve().parents[3]
BINDER = REPO_ROOT / "packages/api/annotation_studio/examples/protein_binder.cif"
SAM = REPO_ROOT / "tests" / "fixtures" / "SAM_hbonds.cif"


@pytest.fixture
def messages(monkeypatch):
    """Collect message-box titles instead of blocking on a modal dialog."""
    if "QT_QPA_PLATFORM" not in os.environ:
        monkeypatch.setenv("QT_QPA_PLATFORM", "offscreen")
    app = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])
    shown: list[str] = []
    for kind in ("warning", "critical", "information"):
        monkeypatch.setattr(QtWidgets.QMessageBox, kind, lambda _parent, title, *args, **kwargs: shown.append(title))
    monkeypatch.setattr(QtWidgets.QMessageBox, "question", lambda *args, **kwargs: QtWidgets.QMessageBox.Yes)
    monkeypatch.setattr(QtWidgets.QMessageBox, "exec_", lambda box: shown.append(box.windowTitle()))
    yield shown
    app.processEvents()


@pytest.fixture
def panel(messages):
    from atomworks_studio_pymol.panel import MainPanel

    return MainPanel(STATE)


def _load(path: Path, name: str) -> str:
    return load_structure(path, config=build_load_config("minimal"), obj_name=name)


def _two_copies() -> None:
    """Load the binder as objA and objB; objB ends up active."""
    _load(BINDER, "objA")
    _load(BINDER, "objB")
    assert STATE.active == "objB"


def _res_ids(name: str, chain_iid: str = "B_1") -> set[int]:
    array = STATE.arrays[name]
    return set(array.res_id[array.chain_iid == chain_iid].tolist())


# F05: a selection in another object must not be mapped onto the edited object.


def test_selection_to_indices_is_restricted_to_the_named_object():
    _two_copies()
    cmd.select("sele", "objA and chain B_1 and resi 1-3")
    assert selection_to_indices("sele", STATE.index_maps["objB"], "objB") == []
    assert len(selection_to_indices("sele", STATE.index_maps["objA"], "objA")) == cmd.count_atoms("sele")


def test_panel_delete_ignores_selection_in_another_object(panel, messages):
    _two_copies()
    before = len(STATE.arrays["objB"])
    cmd.select("sele", "objA and chain B_1 and resi 1-3")
    panel._delete_selection()
    assert len(STATE.arrays["objB"]) == before
    assert messages == ["No selection"]


def test_wizards_and_editors_ignore_selection_in_another_object(messages):
    _two_copies()
    cmd.select("sele", "objA and chain B_1 and resi 1-3")
    assert ChargeWizard(STATE)._active_indices() is None
    assert ChainWizard(STATE)._active_indices() is None
    assert messages == ["No selection", "No selection"]

    class Editor(BaseAnnotationEditor):
        _state = STATE

    assert Editor()._get_selection_indices() == []


# F06: aw_delete edits the named object and never falls back to an unrestricted selection.


def test_aw_delete_on_named_object_uses_only_that_objects_atoms():
    _two_copies()
    objb_before = len(STATE.arrays["objB"])
    cmd.select("sele", "(objA and chain B_1 and resi 1-3) or (objB and chain B_1 and resi 11-13)")
    commands._aw_delete_selection("sele", "objA")
    remaining = _res_ids("objA")
    assert not remaining & {1, 2, 3}
    assert {11, 12, 13} <= remaining
    assert len(STATE.arrays["objB"]) == objb_before


def test_aw_delete_does_not_fall_back_to_atoms_of_other_objects(capsys):
    _two_copies()
    obja_before = len(STATE.arrays["objA"])
    cmd.select("sele", "objB and chain B_1 and resi 11-13")
    commands._aw_delete_selection("sele", "objA")
    assert len(STATE.arrays["objA"]) == obja_before
    assert "matched no atoms in 'objA'" in capsys.readouterr().out


# F07: loading or combining into an existing name replaces both PyMOL and the plugin state.


def test_reloading_into_existing_object_name_replaces_object_and_history():
    _load(BINDER, "objB")
    cmd.select("sele", "objB and chain B_1 and resi 1 and name CA")
    commands._aw_delete_selection("sele", "objB")
    assert STATE.documents["objB"]._undo

    _load(SAM, "objB")
    assert find_pymol_array_divergence("objB") == []
    assert len(STATE.arrays["objB"]) == len(STATE.index_maps["objB"])
    assert STATE.pop_snapshot("objB") is None  # the old structure's undo history is gone


def test_combine_with_overwrite_replaces_existing_combined_object():
    _load(SAM, "objA")
    _load(SAM, "objB")
    combine_visible("combined")
    cmd.disable("combined")
    cmd.enable("objA")
    cmd.enable("objB")
    document = STATE.document("objA")
    document.delete_atoms([0], close_residue_gaps=False)
    STATE.set_array("objA", document.array)
    reload_structure_in_pymol("objA")

    combine_visible("combined", allow_overwrite=True)
    assert find_pymol_array_divergence("combined") == []
    assert len(STATE.arrays["combined"]) == len(STATE.arrays["objA"]) + len(STATE.arrays["objB"])
    assert STATE.active == "combined"
    assert "objA" not in cmd.get_names("objects", enabled_only=1)
    assert "objB" not in cmd.get_names("objects", enabled_only=1)


def test_failed_pymol_load_leaves_tracked_object_unchanged(monkeypatch):
    from atomworks_studio_pymol import bridge

    _load(BINDER, "objA")
    before = len(STATE.arrays["objA"])
    load_array_into_pymol = bridge._load_array_into_pymol
    calls = []

    def fail_once(*args, **kwargs):
        calls.append(args)
        if len(calls) == 1:
            raise RuntimeError("load failed")
        load_array_into_pymol(*args, **kwargs)

    monkeypatch.setattr(bridge, "_load_array_into_pymol", fail_once)
    with pytest.raises(RuntimeError):
        _load(SAM, "objA")
    monkeypatch.undo()
    assert len(STATE.arrays["objA"]) == before
    assert "objA" in cmd.get_names("objects")
    assert find_pymol_array_divergence("objA") == []


# F14: an illegal object name is sanitized the way PyMOL does, and no ghost object is tracked.


def test_illegal_object_name_is_tracked_under_pymol_legal_name():
    name = _load(BINDER, "my design")
    assert name == "my_design"
    assert list(STATE.arrays) == ["my_design"]
    assert STATE.active == "my_design"
    assert find_pymol_array_divergence("my_design") == []


def test_combine_sanitizes_the_new_name():
    _load(SAM, "objA")
    _load(SAM, "objB")
    assert combine_visible("my combo") == "my_combo"
    assert "my combo" not in STATE.arrays
    assert find_pymol_array_divergence("my_combo") == []


# F15: identity-renumbering edits bump the structure version so stale picked keys are rejected.


def test_reset_res_id_bumps_structure_version(panel):
    name = _load(BINDER, "objA")
    cmd.select("sele", f"{name} and chain B_1 and resi 1")
    panel._delete_selection()
    version = STATE.structure_version(name)
    panel._reset_res_id()
    assert min(_res_ids(name)) == 1
    assert STATE.structure_version(name) > version


def test_chain_assignment_bumps_structure_version(messages):
    name = _load(BINDER, "objA")
    wizard = ChainWizard(STATE)
    cmd.select("sele", f"{name} and chain B_1 and resi 1-3")
    version = STATE.structure_version(name)
    wizard._new_chain_from_selection()
    assert messages == []
    assert STATE.structure_version(name) > version


def test_protonation_bumps_structure_version(messages):
    name = load_structure(SAM, config=build_load_config(), obj_name="protonate")
    version = STATE.structure_version(name)
    ChargeWizard(STATE)._protonate()
    assert messages == []
    assert STATE.structure_version(name) > version


# F16: aw_save shares the GUI save path (chain disambiguation and validation hooks).


def test_aw_save_writes_homo_oligomer_chain_instances(tmp_path, capsys):
    name = _load(BINDER, "objA")
    monomer = STATE.arrays[name][STATE.arrays[name].chain_iid == "A_1"]
    copy = monomer.copy()
    copy.chain_iid[:] = "A_2"  # second instance of chain A, as build_assembly produces
    copy.coord += 30.0
    STATE.set_array(name, as_atom_array_plus(struc.concatenate([monomer, copy])))
    reload_structure_in_pymol(name)

    path = tmp_path / "out.cif"
    commands._aw_save(str(path), name)
    out = capsys.readouterr().out
    assert "save failed" not in out
    assert "saved 'objA'" in out
    reread = _load(path, "reread")
    assert len(set(STATE.arrays[reread].chain_iid.tolist())) == 2


def test_aw_save_reports_pre_save_hook_issues(tmp_path, capsys, monkeypatch):
    from atomworks_studio_pymol import panel, saving

    assert panel.register_pre_save_hook is saving.register_pre_save_hook
    monkeypatch.setattr(saving, "_pre_save_hooks", [lambda arr: ["custom issue"]])
    name = _load(BINDER, "objA")
    commands._aw_save(str(tmp_path / "out.cif"), name)
    out = capsys.readouterr().out
    assert "custom issue" in out
    assert (tmp_path / "out.cif").exists()


# F18: atom picking captures the clicked atom, not the first atom of a residue selection.


@pytest.mark.parametrize("make_picker", [lambda: BondWizard(STATE), lambda: PairValueEditor(C_DIS, STATE)])
def test_atom_picking_uses_atom_mode_and_rejects_multi_atom_selections(make_picker, messages):
    _two_copies()
    cmd.set("mouse_selection_mode", 1)
    picker = make_picker()
    picker._start_picking(0)
    assert cmd.get("mouse_selection_mode") == "0"

    cmd.select("sele", "byres (objB and chain B_1 and resi 5 and name CB)")
    picker._timers[0].timeout.emit()
    assert picker._picked[0] is None
    cmd.select("sele", "objA and chain B_1 and resi 5 and name CB")
    picker._timers[0].timeout.emit()
    assert picker._picked[0] is None

    cmd.select("sele", "objB and chain B_1 and resi 5 and name CB")
    picker._timers[0].timeout.emit()
    assert picker._picked[0][0] == ("B_1", 5, "", "CB")
    assert picker._picked[0][2] == "objB"
    assert cmd.get("mouse_selection_mode") == "1"


# F22: deleting a tracked object in PyMOL forgets it instead of resurrecting it.


def test_deleted_object_is_forgotten_not_reloaded():
    _two_copies()
    cmd.delete("objB")
    assert STATE.get_synced_array("objB", interactive=False) is None
    assert "objB" not in cmd.get_names("objects")
    assert "objB" not in STATE.arrays
    assert STATE.active == "objA"


def test_panel_actions_on_deleted_object_do_not_resurrect_it(panel, messages):
    _load(BINDER, "objA")
    cmd.delete("objA")
    panel._reset_res_id()
    assert "objA" not in cmd.get_names("objects")
    assert panel._active_combo.count() == 0
    assert STATE.active is None


# F32: a missing 'sele' shows the "No selection" warning instead of raising.


def test_missing_sele_warns_instead_of_raising(panel, messages):
    _load(BINDER, "objA")
    assert "sele" not in cmd.get_names("selections")
    panel._delete_selection()
    assert ChargeWizard(STATE)._active_indices() is None
    assert messages == ["No selection", "No selection"]
    assert selection_to_indices("sele", STATE.index_maps["objA"]) == []
