"""Annotation Wizard editor for the ChainCentroid condition.

Provides :py:class:`ChainCentroidEditor`, compatible with the standard
``editor_cls(annotation_cls, state)`` signature used by every other entry in
the Annotation Wizard.

Centroid values are entered manually (not derived automatically from a PyMOL
selection), since a user may want to condition on a centroid that isn't
simply the mean of currently-loaded atoms (e.g. a docking target copied from
elsewhere). Setting a chain's centroid drops a colored, labeled indicator
sphere at that position so it's clear at a glance which chain each marker
belongs to.
"""

import logging

import numpy as np
from atomworks.io.utils.atom_array_plus import AtomArrayPlus
from atomworks.io.utils.standard_annotations.base import StandardAnnotationBase
from atomworks_studio_pymol.editors.widgets import BaseAnnotationEditor
from atomworks_studio_pymol.state import PluginState
from pymol import cmd
from pymol.Qt import QtWidgets

from atomworks_studio_rfd4 import CONDITION_PROVIDER
from atomworks_studio_rfd4.pymol.visualize import (
    _PALETTE,
    _ensure_palette_registered,
    _warn_too_many_chains_for_distinct_colors,
)

logger = logging.getLogger("atomworks_studio_pymol")

_SPHERE_SCALE = 0.6


def _marker_name(obj_name: str, chain_id: str) -> str:
    return f"{obj_name}_centroid_{chain_id}"


class ChainCentroidEditor(QtWidgets.QWidget, BaseAnnotationEditor):
    """Editor for the ChainCentroid condition.

    Centroid xyz is entered manually per chain (with an optional "fill with
    current centroid" shortcut), then drawn as a colored indicator sphere
    labeled with the chain id.
    """

    def __init__(
        self,
        annotation_cls: type[StandardAnnotationBase],
        state: PluginState,
        parent: QtWidgets.QWidget | None = None,
    ):
        super().__init__(parent)
        self._annotation_cls = annotation_cls
        self._state = state

        layout = QtWidgets.QVBoxLayout(self)

        header = QtWidgets.QLabel("<b>Chain Centroid Condition</b>")
        layout.addWidget(header)

        desc = QtWidgets.QLabel(
            "Condition a chain on a centroid xyz position, entered manually below "
            "(use 'Fill with current centroid' as a starting point). Shown as a "
            "colored indicator sphere labeled with the chain id."
        )
        desc.setWordWrap(True)
        layout.addWidget(desc)

        layout.addSpacing(8)

        chain_row = QtWidgets.QHBoxLayout()
        chain_row.addWidget(QtWidgets.QLabel("Chain:"))
        self._chain_combo = QtWidgets.QComboBox()
        chain_row.addWidget(self._chain_combo, stretch=1)
        btn_refresh = QtWidgets.QPushButton("↻")
        btn_refresh.setToolTip("Refresh chain list from the active object")
        btn_refresh.setMaximumWidth(30)
        chain_row.addWidget(btn_refresh)
        layout.addLayout(chain_row)

        definition = CONDITION_PROVIDER.definitions_by_name[annotation_cls.name]
        coord_row = QtWidgets.QHBoxLayout()
        self._spin_x = QtWidgets.QDoubleSpinBox()
        self._spin_y = QtWidgets.QDoubleSpinBox()
        self._spin_z = QtWidgets.QDoubleSpinBox()
        for label, spin in (("x", self._spin_x), ("y", self._spin_y), ("z", self._spin_z)):
            spin.setRange(-9999.0, 9999.0)
            spin.setDecimals(definition.decimals)
            spin.setSingleStep(definition.step)
            coord_row.addWidget(QtWidgets.QLabel(f"{label}:"))
            coord_row.addWidget(spin)
        layout.addLayout(coord_row)

        btn_fill = QtWidgets.QPushButton("Fill with current centroid")
        layout.addWidget(btn_fill)

        layout.addSpacing(6)
        btn_set = QtWidgets.QPushButton("Set centroid for chain")
        btn_clear = QtWidgets.QPushButton("Clear centroid for chain")
        layout.addWidget(btn_set)
        layout.addWidget(btn_clear)

        layout.addSpacing(6)
        self._show_markers_chk = QtWidgets.QCheckBox("Show centroid markers")
        self._show_markers_chk.setChecked(True)
        layout.addWidget(self._show_markers_chk)

        layout.addSpacing(6)
        self._status = QtWidgets.QLabel("")
        self._status.setWordWrap(True)
        layout.addWidget(self._status)
        layout.addStretch()

        btn_refresh.clicked.connect(self.refresh)
        self._chain_combo.currentIndexChanged.connect(self._load_current_chain_value)
        btn_fill.clicked.connect(self._fill_with_current_centroid)
        btn_set.clicked.connect(lambda: self._apply(True))
        btn_clear.clicked.connect(lambda: self._apply(False))
        self._show_markers_chk.toggled.connect(self._toggle_markers)

        self.refresh()

    # -- helpers -----------------------------------------------------------

    def _active(self) -> tuple[str, AtomArrayPlus] | None:
        obj_name = self._state.active
        if not obj_name or obj_name not in self._state.arrays:
            return None
        return obj_name, self._state.get_synced_array(obj_name)

    def _selected_chain(self) -> str | None:
        data = self._chain_combo.currentData()
        return None if data is None else str(data)

    # -- UI refresh ----------------------------------------------------------

    def refresh(self) -> None:
        """Rebuild the chain dropdown and redraw markers for the active object."""
        self._chain_combo.blockSignals(True)
        self._chain_combo.clear()

        active = self._active()
        if active is None:
            self._chain_combo.addItem("(no active object)", None)
            self._chain_combo.blockSignals(False)
            return

        _obj_name, arr = active
        for chain_id in np.unique(arr.chain_iid):
            self._chain_combo.addItem(str(chain_id), str(chain_id))

        self._chain_combo.blockSignals(False)
        self._load_current_chain_value()
        self._redraw_markers()

    def _load_current_chain_value(self) -> None:
        """Pre-fill the spinboxes with the selected chain's existing centroid, if any."""
        active = self._active()
        chain_id = self._selected_chain()
        if active is None or chain_id is None:
            return
        _obj_name, _arr = active
        document = self._state.document(_obj_name)
        document.condition_provider = CONDITION_PROVIDER
        entry = next(item for item in document.chain_centroids(self._annotation_cls.name) if item["chain"] == chain_id)
        if entry["target"] is not None:
            for spin, value in zip((self._spin_x, self._spin_y, self._spin_z), entry["target"], strict=True):
                spin.setValue(value)

    def _fill_with_current_centroid(self) -> None:
        active = self._active()
        chain_id = self._selected_chain()
        if active is None or chain_id is None:
            return
        obj_name, _arr = active
        document = self._state.document(obj_name)
        document.condition_provider = CONDITION_PROVIDER
        entry = next(item for item in document.chain_centroids(self._annotation_cls.name) if item["chain"] == chain_id)
        if entry["current"] is None:
            QtWidgets.QMessageBox.warning(self, "No coordinates", "This chain has no resolved coordinates.")
            return
        for spin, value in zip((self._spin_x, self._spin_y, self._spin_z), entry["current"], strict=True):
            spin.setValue(value)

    # -- actions -------------------------------------------------------------

    def _apply(self, value: bool) -> None:
        active = self._active()
        chain_id = self._selected_chain()
        if active is None or chain_id is None:
            return
        obj_name, _arr = active
        document = self._state.document(obj_name)
        document.condition_provider = CONDITION_PROVIDER
        try:
            result = document.edit_chain_centroid(
                self._annotation_cls.name,
                chain_id,
                [self._spin_x.value(), self._spin_y.value(), self._spin_z.value()] if value else None,
            )
        except Exception as e:
            QtWidgets.QMessageBox.critical(self, "Apply failed", str(e))
            return

        self._status.setText(result["message"])
        self._redraw_markers()

    # -- markers -------------------------------------------------------------

    def _toggle_markers(self, checked: bool) -> None:
        active = self._active()
        if active is None:
            return
        obj_name, _arr = active
        show_or_hide = cmd.show if checked else cmd.hide
        show_or_hide("spheres", f"{obj_name}_centroid_*")
        show_or_hide("labels", f"{obj_name}_centroid_*")

    def _redraw_markers(self) -> None:
        """Drop one colored, labeled indicator sphere per centroid-conditioned chain."""
        active = self._active()
        if active is None:
            return
        obj_name, arr = active

        cmd.delete(f"{obj_name}_centroid_*")
        if not self._annotation_cls.has_annotation(arr):
            return

        mask = self._annotation_cls.mask(arr, default="generate")
        if not mask.any():
            return

        _ensure_palette_registered()
        annot = self._annotation_cls.annotation(arr, default="raise")
        chains = sorted({str(c) for c in np.unique(arr.chain_iid)})
        if len(chains) > len(_PALETTE):
            _warn_too_many_chains_for_distinct_colors(len(chains), len(_PALETTE))
        color_for = {c: _PALETTE[i % len(_PALETTE)] for i, c in enumerate(chains)}

        for chain_id in np.unique(arr.chain_iid[mask]):
            chain_mask = mask & (arr.chain_iid == chain_id)
            xyz = annot[chain_mask][0]
            name = _marker_name(obj_name, str(chain_id))
            cmd.pseudoatom(name, pos=list(xyz.astype(float)), label=str(chain_id))
            cmd.show("spheres", name)
            cmd.color(color_for[str(chain_id)], name)
            cmd.set("sphere_scale", _SPHERE_SCALE, name)

        if not self._show_markers_chk.isChecked():
            self._toggle_markers(False)

    def apply_to_selection(self) -> None:
        self._apply(True)
