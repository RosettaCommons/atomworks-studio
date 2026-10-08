"""Native saved-target confirmation and cancellation exercise real widget handlers."""

import os
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
from atomworks.ml.conditions import C_CRD
from atomworks_studio_editing.document import StudioDocument
from atomworks_studio_rfd4 import CONDITION_PROVIDER
from atomworks_studio_rfd4.model import C_CRDGRP, C_INTCRD

pytest.importorskip("pymol")


@pytest.mark.parametrize("operation", ["absolute", "split", "merge", "remove", "delete", "internal"])
@pytest.mark.parametrize("answer", ["Yes", "Cancel"])
def test_native_coordinate_confirmation(monkeypatch, operation, answer):
    if "QT_QPA_PLATFORM" not in os.environ:
        monkeypatch.setenv("QT_QPA_PLATFORM", "offscreen")
    from atomworks_studio_rfd4.pymol.document_editors import DocumentMaskEditor
    from atomworks_studio_rfd4.pymol.group_editor import GroupEditor
    from atomworks_studio_rfd4.pymol.internal_coord_editor import InternalCoordEditor
    from pymol.Qt import QtWidgets

    application = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])
    document = StudioDocument.from_cif(
        (Path(__file__).parent / "fixtures" / "SAM_hbonds.cif").read_text(),
        condition_provider=CONDITION_PROVIDER,
    )
    document.set_condition("coordinate_group", [0, 1], value=7)
    document.set_condition("coordinate_group", [2, 3], value=8)
    targets = C_INTCRD.default_annotation(document.array)
    targets[:4] = [[-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0]]
    C_INTCRD.set_annotation(document.array, targets)
    original_groups = C_CRDGRP.annotation(document.array).copy()
    state = SimpleNamespace(
        active="test",
        documents={"test": document},
        arrays={"test": document.array},
        document=lambda name: document,
        get_synced_array=lambda name: document.array,
        structure_version=lambda name: 0,
    )
    if operation == "absolute":
        editor = DocumentMaskEditor(C_CRD, state)

        def action():
            editor._set_mask(True)
    elif operation == "internal":
        editor = InternalCoordEditor(C_INTCRD, state)
        action = editor._mark
    else:
        editor = GroupEditor(C_CRDGRP, state)
        monkeypatch.setattr(editor, "_post_edit", lambda *args: None)
        editor._group_combo.setCurrentIndex(editor._group_combo.findData(8 if operation == "merge" else 7))
        action = {
            "split": editor._new_group_from_selection,
            "merge": editor._add_to_group,
            "remove": editor._remove_from_group,
            "delete": editor._delete_group,
        }[operation]
    monkeypatch.setattr(editor, "_get_selection_indices", lambda *args: [0])
    monkeypatch.setattr(editor, "_reload_or_recolor", lambda *args: None)
    monkeypatch.setattr(editor, "_clear_selection", lambda *args: None)
    prompts = []

    def confirm(*args):
        prompts.append(args)
        return getattr(QtWidgets.QMessageBox, answer)

    monkeypatch.setattr(QtWidgets.QMessageBox, "warning", confirm)
    monkeypatch.setattr(QtWidgets.QMessageBox, "critical", lambda *args: pytest.fail(str(args)))
    revision = document.revision
    action()
    application.processEvents()
    assert len(prompts) == 1
    assert prompts[0][-1] == QtWidgets.QMessageBox.Cancel
    expected_loss = 4 if operation == "merge" else 2
    assert f"{expected_loss} atoms" in prompts[0][2]
    if answer == "Cancel":
        assert document.revision == revision
        np.testing.assert_equal(C_INTCRD.annotation(document.array), targets)
        np.testing.assert_equal(C_CRDGRP.annotation(document.array), original_groups)
    else:
        assert document.revision == revision + 1
        assert np.isnan(C_INTCRD.annotation(document.array)[:expected_loss]).all()
        np.testing.assert_equal(C_INTCRD.annotation(document.array)[expected_loss:], targets[expected_loss:])
        assert document.undo()
        np.testing.assert_equal(C_INTCRD.annotation(document.array), targets)
        np.testing.assert_equal(C_CRDGRP.annotation(document.array), original_groups)
    editor.close()


def test_confirmation_cannot_apply_to_a_changed_document(monkeypatch):
    from atomworks_studio_editing.contracts import DocumentRevisionConflictError
    from atomworks_studio_rfd4.pymol.coordinate_edit import commit_document_edit
    from pymol.Qt import QtWidgets

    document = StudioDocument.from_cif(
        (Path(__file__).parent / "fixtures" / "SAM_hbonds.cif").read_text(),
        condition_provider=CONDITION_PROVIDER,
    )
    document.set_condition("coordinate_group", [0, 1], value=7)
    targets = C_INTCRD.default_annotation(document.array)
    targets[:2] = [[-1, 0, 0], [1, 0, 0]]
    C_INTCRD.set_annotation(document.array, targets)
    revision = document.revision

    def confirm(*args):
        document.set_condition("hotspot", [4])
        return QtWidgets.QMessageBox.Yes

    monkeypatch.setattr(QtWidgets.QMessageBox, "warning", confirm)
    with pytest.raises(DocumentRevisionConflictError):
        commit_document_edit(None, document, lambda **kwargs: document.set_condition("coordinate", [0], **kwargs))
    assert document.revision == revision + 1
    np.testing.assert_equal(C_INTCRD.annotation(document.array), targets)
    assert C_CRDGRP.annotation(document.array)[:2].tolist() == [7, 7]


@pytest.mark.parametrize("action", ["_add_to_group", "_delete_group"])
def test_stale_group_editor_cannot_modify_a_reused_group_id(monkeypatch, action):
    if "QT_QPA_PLATFORM" not in os.environ:
        monkeypatch.setenv("QT_QPA_PLATFORM", "offscreen")
    from atomworks_studio_pymol.state import PluginState
    from atomworks_studio_rfd4.pymol.group_editor import GroupEditor
    from pymol.Qt import QtWidgets

    application = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])
    document = StudioDocument.from_cif(
        (Path(__file__).parent / "fixtures" / "SAM_hbonds.cif").read_text(),
        condition_provider=CONDITION_PROVIDER,
    )
    document.set_condition("coordinate_group", [0, 1], value=1)
    document.set_condition("coordinate_group", [2, 3], value=2)
    state = PluginState(documents={"test": document}, active="test")
    monkeypatch.setattr(state, "get_synced_array", lambda *args, **kwargs: document.array)
    monkeypatch.setattr("atomworks_studio_rfd4.pymol.group_editor.reload_structure_in_pymol", lambda *args: None)
    current = GroupEditor(C_CRDGRP, state)
    stale = GroupEditor(C_CRDGRP, state)
    monkeypatch.setattr(current, "_get_selection_indices", lambda *args: [4, 5])
    monkeypatch.setattr(stale, "_get_selection_indices", lambda *args: [0])
    monkeypatch.setattr(QtWidgets.QMessageBox, "warning", lambda *args: pytest.fail(str(args)))
    for editor in (current, stale):
        editor._group_combo.setCurrentIndex(editor._group_combo.findData(2))
    structural_version = state.structure_version("test")
    current._delete_group()
    current._new_group_from_selection()
    assert C_CRDGRP.annotation(document.array)[:6].tolist() == [1, 1, -1, -1, 2, 2]
    assert state.structure_version("test") == structural_version
    revision = document.revision
    groups = C_CRDGRP.annotation(document.array).copy()
    getattr(stale, action)()
    application.processEvents()
    assert "structure changed" in stale._status.text()
    assert document.revision == revision
    np.testing.assert_equal(C_CRDGRP.annotation(document.array), groups)
    current.close()
    stale.close()


@pytest.mark.parametrize("answer", ["Yes", "Cancel"])
@pytest.mark.usefixtures("stable_cif_metadata")
def test_remove_group_confirms_orphan_target_cleanup_after_cif_import(monkeypatch, answer):
    if "QT_QPA_PLATFORM" not in os.environ:
        monkeypatch.setenv("QT_QPA_PLATFORM", "offscreen")
    from atomworks_studio_pymol.state import PluginState
    from atomworks_studio_rfd4.pymol.group_editor import GroupEditor
    from pymol.Qt import QtWidgets

    application = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])
    source = StudioDocument.from_cif(
        (Path(__file__).parent / "fixtures" / "SAM_hbonds.cif").read_text(),
        condition_provider=CONDITION_PROVIDER,
    )
    # A malformed imported file can contain payloads outside internal groups.
    # Bypass the scientific setter to reproduce that source data faithfully.
    groups = C_CRDGRP.default_annotation(source.array)
    targets = C_INTCRD.default_annotation(source.array)
    targets[0] = [1.0, 2.0, 3.0]
    source.array.set_annotation(C_CRDGRP.full_name, groups)
    source.array.set_annotation(C_INTCRD.full_name, targets)
    document = StudioDocument.from_cif(source.to_cif(), condition_provider=CONDITION_PROVIDER)
    np.testing.assert_equal(C_INTCRD.annotation(document.array), targets)
    assert C_CRDGRP.annotation(document.array)[0] == C_CRDGRP.UNKNOWN_COORDS
    state = PluginState(documents={"test": document}, active="test")
    monkeypatch.setattr(state, "get_synced_array", lambda *args, **kwargs: document.array)
    editor = GroupEditor(C_CRDGRP, state)
    monkeypatch.setattr(editor, "_get_selection_indices", lambda *args: [0])
    monkeypatch.setattr(editor, "_post_edit", lambda *args: None)
    prompts = []

    def confirm(*args):
        prompts.append(args)
        return getattr(QtWidgets.QMessageBox, answer)

    monkeypatch.setattr(QtWidgets.QMessageBox, "warning", confirm)
    monkeypatch.setattr(QtWidgets.QMessageBox, "critical", lambda *args: pytest.fail(str(args)))
    original = document.to_cif()
    revision = document.revision
    editor._remove_from_group()
    application.processEvents()
    assert len(prompts) == 1
    assert "saved targets for 1 atoms" in prompts[0][2]
    assert prompts[0][-1] == QtWidgets.QMessageBox.Cancel
    np.testing.assert_equal(C_CRDGRP.annotation(document.array), groups)
    if answer == "Cancel":
        assert document.revision == revision
        assert document.to_cif() == original
        assert not document.undo()
    else:
        assert document.revision == revision + 1
        assert np.isnan(C_INTCRD.annotation(document.array)).all()
        assert document.undo()
        assert document.to_cif() == original
        np.testing.assert_equal(C_INTCRD.annotation(document.array), targets)
    editor.close()


@pytest.mark.usefixtures("stable_cif_metadata")
def test_unchanged_native_group_removal_does_not_prompt_or_consume_history(monkeypatch):
    if "QT_QPA_PLATFORM" not in os.environ:
        monkeypatch.setenv("QT_QPA_PLATFORM", "offscreen")
    from atomworks_studio_pymol.state import PluginState
    from atomworks_studio_rfd4.pymol.group_editor import GroupEditor
    from pymol.Qt import QtWidgets

    application = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])
    document = StudioDocument.from_cif(
        (Path(__file__).parent / "fixtures" / "SAM_hbonds.cif").read_text(),
        condition_provider=CONDITION_PROVIDER,
    )
    state = PluginState(documents={"test": document}, active="test")
    monkeypatch.setattr(state, "get_synced_array", lambda *args, **kwargs: document.array)
    editor = GroupEditor(C_CRDGRP, state)
    monkeypatch.setattr(editor, "_get_selection_indices", lambda *args: [0])
    monkeypatch.setattr(editor, "_post_edit", lambda *args: pytest.fail("A no-op must not refresh the viewer"))
    monkeypatch.setattr(QtWidgets.QMessageBox, "warning", lambda *args: pytest.fail(str(args)))
    monkeypatch.setattr(QtWidgets.QMessageBox, "critical", lambda *args: pytest.fail(str(args)))
    original = document.to_cif()
    revision = document.revision
    editor._remove_from_group()
    application.processEvents()
    assert document.revision == revision
    assert document.to_cif() == original
    assert not document.undo()
    editor.close()


def test_native_index_group_edit_still_commits_and_undoes(monkeypatch):
    if "QT_QPA_PLATFORM" not in os.environ:
        monkeypatch.setenv("QT_QPA_PLATFORM", "offscreen")
    from atomworks_studio_pymol.state import PluginState
    from atomworks_studio_rfd4.model import C_IDXGRP
    from atomworks_studio_rfd4.pymol.group_editor import GroupEditor
    from pymol.Qt import QtWidgets

    application = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])
    document = StudioDocument.from_cif(
        (Path(__file__).parent / "fixtures" / "SAM_hbonds.cif").read_text(),
        condition_provider=CONDITION_PROVIDER,
    )
    state = PluginState(documents={"test": document}, active="test")
    monkeypatch.setattr(state, "get_synced_array", lambda *args, **kwargs: document.array)
    editor = GroupEditor(C_IDXGRP, state)
    monkeypatch.setattr(editor, "_get_selection_indices", lambda *args: [0])
    monkeypatch.setattr(editor, "_post_edit", lambda *args: None)
    monkeypatch.setattr(QtWidgets.QMessageBox, "warning", lambda *args: pytest.fail(str(args)))
    monkeypatch.setattr(QtWidgets.QMessageBox, "critical", lambda *args: pytest.fail(str(args)))
    original = C_IDXGRP.annotation(document.array, default="generate").copy()
    revision = document.revision
    editor._new_group_from_selection()
    application.processEvents()
    assert document.revision == revision + 1
    assert C_IDXGRP.annotation(document.array)[0] == max(1, int(original.max()) + 1)
    np.testing.assert_equal(C_IDXGRP.annotation(document.array)[1:], original[1:])
    assert document.undo()
    np.testing.assert_equal(C_IDXGRP.annotation(document.array, default="generate"), original)
    editor.close()
