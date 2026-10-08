"""Public annotation widgets commit undoable edits in a plain PyMOL install."""

import os
from pathlib import Path

import numpy as np
import pytest
from atomworks.ml.conditions import C_CRD, C_CTR, C_IDX, C_NTR, C_SEQ
from atomworks_studio_editing.conditions import CONDITION_PROVIDER
from atomworks_studio_editing.document import StudioDocument
from atomworks_studio_editing.loading import build_load_config
from atomworks_studio_pymol.bridge import load_structure
from atomworks_studio_pymol.editors.widgets import CoordinateEditor, MaskEditor, SequenceEditor
from atomworks_studio_pymol.state import STATE
from pymol import cmd
from pymol.Qt import QtWidgets

FIXTURE = Path(__file__).resolve().parents[3] / "tests" / "fixtures" / "minimal_multichain.cif"


@pytest.fixture
def qt_app(monkeypatch):
    if "QT_QPA_PLATFORM" not in os.environ:
        monkeypatch.setenv("QT_QPA_PLATFORM", "offscreen")
    app = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])
    yield app


@pytest.mark.parametrize(
    "condition,editor_cls",
    [
        (C_SEQ, SequenceEditor),
        (C_CRD, CoordinateEditor),
        (C_IDX, MaskEditor),
        (C_NTR, MaskEditor),
        (C_CTR, MaskEditor),
    ],
)
def test_mask_widget_uses_residue_scope_and_undo(condition, editor_cls, qt_app, monkeypatch):
    monkeypatch.setattr(STATE, "condition_provider", CONDITION_PROVIDER)
    name = load_structure(FIXTURE, config=build_load_config("minimal"), obj_name="annotations")
    document = STATE.document(name)
    definition = CONDITION_PROVIDER.definitions_by_name[condition.name]
    document.set_condition(definition.key, list(range(len(document.array))), enabled=definition.invert_mask)
    document.clear_history()
    original = condition.annotation(document.array).copy()
    cmd.select("sele", f"{name} and chain {document.array.chain_iid[0]} and name N")
    widget = editor_cls(condition, STATE)
    assert widget._set_mask(True)
    selected = [0] if condition is C_CRD else [0, 1]
    np.testing.assert_array_equal(np.flatnonzero(condition.mask(document.array)), selected)
    assert len(document._undo) == 1
    restored = StudioDocument.from_cif(document.to_cif())
    np.testing.assert_equal(condition.annotation(restored.array), condition.annotation(document.array))
    assert cmd.count_atoms("sele") == 0
    assert document.undo()
    np.testing.assert_equal(condition.annotation(document.array), original)
    widget.deleteLater()


def test_mask_reset_is_undoable(qt_app, monkeypatch):
    monkeypatch.setattr(STATE, "condition_provider", CONDITION_PROVIDER)
    name = load_structure(FIXTURE, config=build_load_config("minimal"), obj_name="annotations")
    document = STATE.document(name)
    document.set_condition("n_terminus", [0, 1, 2, 3], enabled=False)
    document.clear_history()
    widget = MaskEditor(C_NTR, STATE)
    widget._reset()
    assert C_NTR.mask(document.array).all()
    assert document.undo()
    assert not C_NTR.mask(document.array).any()
    widget.deleteLater()


def test_installed_hosts_share_hotspot_storage(qt_app):
    """No extension configuration is needed for browser/native annotation parity."""
    from atomworks_studio_editing.providers import load_providers
    from atomworks_studio_pymol.state import PluginState
    from atomworks_studio_rfd4.model import C_HOT

    providers = load_providers()
    state = PluginState()
    assert state.condition_provider is providers.condition_provider
    assert state.validation_provider is providers.validation_provider
    assert state.condition_provider.definitions_by_name["hotspot"].condition is C_HOT
    assert providers.pymol_editors == ("atomworks_studio_rfd4.pymol.editors",)
