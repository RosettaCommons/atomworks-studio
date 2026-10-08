"""Actual Qt actions and HTTP requests must produce the same annotated document."""

import json
import os
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
from annotation_studio.main import app, store
from atomworks.io.config import ParseConfig
from atomworks_studio_editing.document import StudioDocument
from atomworks_studio_editing.loading import LOAD_FIELDS, build_load_config
from atomworks_studio_rfd4 import CONDITION_PROVIDER, VALIDATION_PROVIDER
from atomworks_studio_rfd4.model import C_CENTROID, C_CRDGRP, C_IDXGRP
from fastapi.testclient import TestClient

FIXTURE = Path(__file__).parent / "fixtures" / "SAM_hbonds.cif"
client = TestClient(app)


@pytest.fixture
def qt(monkeypatch):
    pytest.importorskip("pymol")
    if "QT_QPA_PLATFORM" not in os.environ:
        monkeypatch.setenv("QT_QPA_PLATFORM", "offscreen")
    from pymol.Qt import QtWidgets

    application = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])
    monkeypatch.setattr(QtWidgets.QMessageBox, "critical", lambda *args: pytest.fail(str(args)))
    monkeypatch.setattr(QtWidgets.QMessageBox, "warning", lambda *args: pytest.fail(str(args)))
    yield application


@pytest.fixture
def documents():
    native = StudioDocument.from_cif(
        FIXTURE.read_text(),
        condition_provider=CONDITION_PROVIDER,
        validation_provider=VALIDATION_PROVIDER,
    )
    browser = native.clone()
    state = SimpleNamespace(
        active="test",
        documents={"test": native},
        arrays={"test": native.array},
        document=lambda name: native,
        get_synced_array=lambda name: native.array,
        structure_version=lambda name: 0,
    )
    return native, browser, state


@pytest.mark.usefixtures("stable_cif_metadata")
def test_bond_buttons_share_http_transactions(qt, monkeypatch, documents):
    from atomworks_studio_pymol import bond_wizard
    from pymol.Qt import QtWidgets

    native, browser, state = documents
    state.index_maps = {"test": {"a": 0, "b": 1}}
    session = store.add(browser)
    monkeypatch.setenv("CCD_MIRROR_PATH", "/unused-test-ccd")
    monkeypatch.setattr(bond_wizard, "reload_structure_in_pymol", lambda name: None)
    monkeypatch.setattr(QtWidgets.QMessageBox, "question", lambda *args: QtWidgets.QMessageBox.Yes)
    wizard = bond_wizard.BondWizard(state)
    monkeypatch.setattr(wizard, "_refresh_table", lambda: None)
    wizard._picked = [("a", "a", "test", 0), ("b", "b", "test", 0)]
    wizard._table_bonds = [("a", "b", 1, "test", 0)]
    wizard._table.setRowCount(1)
    wizard._table.setItem(0, 0, QtWidgets.QTableWidgetItem("a-b"))
    wizard._table.selectRow(0)
    for button, action in (
        (wizard._btn_add, "add"),
        (wizard._btn_remove, "remove"),
        (wizard._btn_add, "add"),
        (wizard._btn_delete_row, "remove"),
    ):
        button.click()
        response = client.post(
            f"/api/sessions/{session}/bonds",
            json={"atom1": 0, "atom2": 1, "action": action, "bond_type": "SINGLE"},
        )
        assert response.status_code == 200, response.text
        assert native.inspect_bonds() == browser.inspect_bonds()
        assert native.to_cif() == browser.to_cif()
        assert native.revision == browser.revision

    # Only the external CCD lookup is substituted; real Qt/HTTP/document paths run.
    def infer(array, *, sanitize):
        assert sanitize is False  # Bond editing must not remove atoms or change charges.
        array.bonds.add_bond(0, 1, 2)
        return array

    monkeypatch.setattr("atomworks_studio_editing.document.infer_bonds_from_residue_names", infer)
    wizard._btn_infer.click()
    response = client.post(f"/api/sessions/{session}/bonds/infer-ccd")
    assert response.status_code == 200, response.text
    assert native.to_cif() == browser.to_cif()
    assert native.revision == browser.revision == 5
    assert native.undo() and browser.undo()
    assert native.to_cif() == browser.to_cif()

    # A partially failed inference must preserve the document and its full Undo budget.
    for _ in range(10):
        native.snapshot()
    before = native.to_cif(), native.revision, len(native._undo)

    def failed_inference(array, *, sanitize):
        array.charge[0] = 9
        raise ValueError("CCD lookup failed")

    errors = []
    monkeypatch.setattr("atomworks_studio_editing.document.infer_bonds_from_residue_names", failed_inference)
    monkeypatch.setattr(QtWidgets.QMessageBox, "critical", lambda *args: errors.append(args[-1]))
    wizard._btn_infer.click()
    assert errors == ["CCD lookup failed"]
    assert (native.to_cif(), native.revision, len(native._undo)) == before
    wizard.widget.close()


@pytest.mark.usefixtures("stable_cif_metadata")
@pytest.mark.parametrize("condition", [C_IDXGRP, C_CRDGRP])
def test_group_actions_match_qt_and_http(qt, monkeypatch, documents, condition):
    from atomworks_studio_rfd4.pymol.group_editor import GroupEditor

    native, browser, state = documents
    session = store.add(browser)
    editor = GroupEditor(condition, state)
    monkeypatch.setattr(editor, "_post_edit", lambda *args: editor.refresh())
    cleared = []
    monkeypatch.setattr(editor, "_clear_selection", lambda: cleared.append(True))
    selection = [0, 1]
    monkeypatch.setattr(editor, "_get_selection_indices", lambda: selection)
    actions = [
        ("new", [0, 1], None),
        ("new", [2, 3], None),
        ("add", [4], 1),
        ("remove", [0], None),
        ("delete", [], 2),
    ]
    for action, selection, group_id in actions:
        if group_id is not None:
            editor._group_combo.setCurrentIndex(editor._group_combo.findData(group_id))
        editor._edit_group(action)
        response = client.post(
            f"/api/sessions/{session}/groups",
            json={
                "condition": condition.name,
                "action": action,
                "atom_indices": selection,
                "group_id": group_id,
                "expected_revision": browser.revision,
            },
        )
        assert response.status_code == 200, response.text
        assert native.to_cif() == browser.to_cif()
        assert native.validate() == browser.validate()
        assert native.revision == browser.revision
        assert response.json()["edit_result"]["affected_count"] > 0
        values = condition.annotation(native.array)
        if action == "remove":
            expected = -1 if condition is C_IDXGRP else C_CRDGRP.default_annotation(native.array)[selection]
            np.testing.assert_equal(values[selection], expected)
        if action == "delete":
            assert not np.any(values == group_id)
    assert len(cleared) == native.revision  # No-op group edits retain the selection, as in PyMOL.
    assert native.undo() and browser.undo()
    assert native.to_cif() == browser.to_cif()
    editor.close()


@pytest.mark.usefixtures("stable_cif_metadata")
def test_centroid_fill_set_clear_matches_qt_and_http(qt, monkeypatch, documents):
    from atomworks_studio_rfd4.pymol.chain_centroid_editor import ChainCentroidEditor

    native, browser, state = documents
    native.array.coord[0] = np.nan
    browser.array.coord[0] = np.nan
    session = store.add(browser)
    monkeypatch.setattr(ChainCentroidEditor, "_redraw_markers", lambda *args: None)
    editor = ChainCentroidEditor(C_CENTROID, state)
    chain = str(native.array.chain_iid[1])
    editor._chain_combo.setCurrentIndex(editor._chain_combo.findData(chain))
    chain = editor._selected_chain()
    editor._fill_with_current_centroid()
    values = [editor._spin_x.value(), editor._spin_y.value(), editor._spin_z.value()]
    expected = np.nanmean(native.array.coord[native.array.chain_iid == chain], axis=0)
    np.testing.assert_allclose(values, expected, atol=0.00051)
    for enabled in (True, False):
        editor._apply(enabled)
        response = client.post(
            f"/api/sessions/{session}/centroids",
            json={
                "condition": "chain_centroid",
                "chain": chain,
                "value": values if enabled else None,
                "expected_revision": browser.revision,
            },
        )
        assert response.status_code == 200, response.text
        assert native.to_cif() == browser.to_cif()
        assert native.validate() == browser.validate()
    editor.close()


def test_restraint_replacement_is_atomic_and_revision_bound(documents):
    native, browser, _ = documents
    session = store.add(browser)
    payload = {"pairs": [[0, 1], [1, 0], [2, 3]], "values": [4, 5, 6], "expected_revision": 0}
    native.replace_distance_restraints(payload["pairs"], payload["values"])
    response = client.post(f"/api/sessions/{session}/distance-restraints/replace", json=payload)
    assert response.status_code == 200, response.text
    assert native.distance_restraints() == browser.distance_restraints()
    assert len(native.distance_restraints()) == 2
    assert native.distance_restraints()[0]["distance"] == 5
    assert client.post(f"/api/sessions/{session}/distance-restraints/replace", json=payload).status_code == 409
    payload.update(expected_revision=browser.revision, pairs=[[0, 0]], values=[7])
    assert client.post(f"/api/sessions/{session}/distance-restraints/replace", json=payload).status_code == 422
    assert browser.distance_restraints() == native.distance_restraints()
    browser.array.coord[0] = np.nan
    result = client.get(f"/api/sessions/{session}/atom-distance?atom1=0&atom2=1").json()
    assert result["distance"] is None
    assert browser.atom_label(1) == result["atom2_label"]
    assert browser.undo()
    assert browser.distance_restraints() == []


@pytest.mark.usefixtures("stable_cif_metadata")
def test_pair_widget_apply_matches_http_and_supports_undo(qt, monkeypatch, documents):
    from atomworks.ml.conditions import C_DIS
    from atomworks_studio_pymol.editors.widgets import PairValueEditor

    native, browser, state = documents
    keys = [(str(atom.chain_iid), int(atom.res_id), str(atom.ins_code), str(atom.atom_name)) for atom in native.array]
    state.index_maps = {"test": {key: index for index, key in enumerate(keys)}}
    session = store.add(browser)
    editor = PairValueEditor(C_DIS, state)
    monkeypatch.setattr(editor, "_reload_or_recolor", lambda **kwargs: None)
    editor._picked = [(keys[index], native.atom_label(index), "test", 0) for index in (0, 1)]
    editor._use_actual_distance()
    assert editor._value_spin.value() == round(native.atom_distance(0, 1), 2)
    editor._add_pair()
    assert native.distance_restraints() == []
    editor.apply_to_selection()
    response = client.post(
        f"/api/sessions/{session}/distance-restraints/replace",
        json={
            "pairs": [[0, 1]],
            "values": [editor._value_spin.value()],
            "expected_revision": 0,
        },
    )
    assert response.status_code == 200, response.text
    assert native.to_cif() == browser.to_cif()
    assert native.undo() and native.distance_restraints() == []
    editor.close()


def test_internal_coordinate_feedback_counts_unresolved_atoms(documents):
    from atomworks_studio_rfd4.internal_coordinate import set_internal_coordinate_conditioning

    native, _browser, _state = documents
    native.array.coord[0] = np.nan
    result = native.apply_selection_transform([0, 1], "atom", set_internal_coordinate_conditioning, True)
    assert result["affected_count"] == 1
    assert result["skipped_count"] == 1
    assert "unresolved" in result["message"]


@pytest.mark.parametrize("preset", ["minimal", "rcsb"])
def test_loading_matches_desktop_controls(qt, preset):
    from atomworks_studio_pymol.panel import LoadCIFDialog

    dialog = LoadCIFDialog()
    if preset == "rcsb":
        dialog._rb_rcsb.setChecked(True)
    config = dialog.config
    expected = build_load_config(preset)
    # The old dialog constructed ParseConfig directly from its exposed fields.
    assert config == ParseConfig(
        **{name: getattr(config, name) for name in LOAD_FIELDS},
        build_assembly=["1"],
        return_atom_array_plus=True,
    )
    for name in LOAD_FIELDS:
        assert getattr(config, name) == getattr(expected, name), name
    dialog._chk_add_missing.setChecked(False)
    dialog._cmb_altloc.setCurrentText("random_per_chain")
    dialog._chk_seed_none.setChecked(False)
    dialog._spin_seed.setValue(12)
    dialog._edit_remove_ccds.setText("GOL, EDO")
    assert dialog.config == build_load_config(
        preset,
        add_missing_atoms=False,
        altloc="random_per_chain",
        altloc_seed=12,
        remove_ccds="GOL, EDO",
    )
    dialog._dialog.close()


def test_advanced_load_options_are_validated_and_reach_parser(monkeypatch):
    import atomworks_studio_editing.document as module

    original = module.parse
    observed = []

    def parse(*args, config):
        observed.append(config)
        return original(*args, config=config)

    monkeypatch.setattr(module, "parse", parse)
    options = {"add_missing_atoms": False, "altloc": "random_per_chain", "altloc_seed": 12, "remove_ccds": "GOL, EDO"}
    response = client.post(
        "/api/sessions",
        files={"file": ("test.cif", FIXTURE.read_bytes())},
        data={"advanced_options": json.dumps(options)},
    )
    assert response.status_code == 200, response.text
    assert observed[0] == build_load_config("minimal", **options).replace(file_type="cif")
    for options in ({"add_missing_atoms": "false"}, {"file_type": "pdb"}, {"altloc_seed": 1.5}):
        response = client.post(
            "/api/sessions",
            files={"file": ("test.cif", FIXTURE.read_bytes())},
            data={"advanced_options": json.dumps(options)},
        )
        assert response.status_code == 422


def test_cif_without_comments_is_not_misidentified_as_pdb():
    text = FIXTURE.read_text()
    without_comments = "\n".join(line for line in text.splitlines() if not line.startswith("#"))
    original = StudioDocument.from_cif(text)
    reparsed = StudioDocument.from_cif(without_comments)
    np.testing.assert_equal(reparsed.array.coord, original.array.coord)
    assert list(reparsed.array.atom_name) == list(original.array.atom_name)


def test_protonation_button_updates_native_object_and_supports_undo(qt, monkeypatch):
    from atomworks_studio_pymol.bridge import load_structure, reload_structure_in_pymol
    from atomworks_studio_pymol.charge_wizard import ChargeWizard
    from atomworks_studio_pymol.state import STATE
    from pymol import cmd

    cmd.reinitialize()
    STATE.clear_all()
    name = load_structure(FIXTURE, config=build_load_config(), obj_name="protonation_test")
    STATE.active = name
    before = STATE.arrays[name].copy()
    from pymol.Qt import QtWidgets

    errors = []
    monkeypatch.setattr(QtWidgets.QMessageBox, "critical", lambda *args: errors.append(args[1:]))
    monkeypatch.setattr(QtWidgets.QMessageBox, "warning", lambda *args: errors.append(args[1:]))
    wizard = ChargeWizard(STATE)
    assert wizard._ph.value() == 7.4
    wizard._protonate_button.click()
    qt.processEvents()
    assert errors == []
    assert wizard._protonate_button.isEnabled()
    array = STATE.arrays[name]
    assert np.count_nonzero(array.element == "H") > 0
    assert cmd.count_atoms(name) == len(array)
    assert len(STATE.index_maps[name]) == cmd.count_atoms(name)
    STATE.pop_snapshot(name)
    reload_structure_in_pymol(name)
    np.testing.assert_equal(STATE.arrays[name].coord, before.coord)
    np.testing.assert_array_equal(STATE.arrays[name].atom_name, before.atom_name)
    STATE.clear_all()
    cmd.delete(name)
