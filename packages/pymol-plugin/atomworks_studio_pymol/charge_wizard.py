"""Charge editing wizard for the AtomWorks PyMOL plugin.

Provides :py:class:`ChargeWizard`, an editor that edits the integer
``charge`` annotation on the active :py:class:`AtomArrayPlus`.
"""

import logging

import numpy as np
from atomworks.io.utils.atom_array_plus import AtomArrayPlus
from pymol import cmd
from pymol.Qt import QtWidgets

from atomworks_studio_pymol.bridge import reload_structure_in_pymol, selection_to_indices
from atomworks_studio_pymol.state import PluginState

logger = logging.getLogger("atomworks_studio_pymol")


def _read_charges(arr: AtomArrayPlus) -> np.ndarray:
    """Return ``arr.charge`` if annotated, else a zero-filled read-only view."""
    if "charge" in arr.get_annotation_categories():
        return arr.charge
    return np.zeros(len(arr), dtype=int)


class ChargeWizard:
    """Controls for editing the ``charge`` field on the active AtomArrayPlus.

    Operations apply to the current PyMOL ``sele`` selection:

    - Set charge to an exact value (buttons for -1/0/+1, plus a custom field).
    - Increment or decrement charges on the selection.
    - Reset selection charges to 0.
    """

    def __init__(self, state: PluginState, parent: QtWidgets.QWidget | None = None):
        self._state = state
        self._widget = QtWidgets.QWidget(parent)
        self._widget.setMinimumWidth(300)
        layout = QtWidgets.QVBoxLayout(self._widget)

        layout.addWidget(QtWidgets.QLabel("<b>Selection</b>"))
        self._lbl_selection = QtWidgets.QLabel("Selection: (refresh to read)")
        self._lbl_selection.setWordWrap(True)
        layout.addWidget(self._lbl_selection)
        self._lbl_current = QtWidgets.QLabel("Current charges: —")
        self._lbl_current.setWordWrap(True)
        layout.addWidget(self._lbl_current)
        btn_refresh = QtWidgets.QPushButton("Refresh selection info")
        layout.addWidget(btn_refresh)

        layout.addSpacing(6)

        # Exact value buttons
        layout.addWidget(QtWidgets.QLabel("<b>Set charge</b>"))
        exact_row = QtWidgets.QHBoxLayout()
        for value in (-1, 0, 1):
            btn = QtWidgets.QPushButton(f"{value:+d}" if value != 0 else "0")
            btn.clicked.connect(lambda _=False, v=value: self._set_charge(v))
            exact_row.addWidget(btn)
        layout.addLayout(exact_row)

        custom_row = QtWidgets.QHBoxLayout()
        custom_row.addWidget(QtWidgets.QLabel("Custom:"))
        self._custom_spin = QtWidgets.QSpinBox()
        self._custom_spin.setRange(-10, 10)
        self._custom_spin.setValue(0)
        custom_row.addWidget(self._custom_spin)
        btn_set_custom = QtWidgets.QPushButton("Set")
        custom_row.addWidget(btn_set_custom)
        custom_row.addStretch()
        layout.addLayout(custom_row)

        layout.addSpacing(6)

        # Increment / decrement / reset
        layout.addWidget(QtWidgets.QLabel("<b>Modify</b>"))
        mod_row = QtWidgets.QHBoxLayout()
        btn_inc = QtWidgets.QPushButton("Increment (+1)")
        btn_dec = QtWidgets.QPushButton("Decrement (-1)")
        btn_reset = QtWidgets.QPushButton("Reset to 0")
        mod_row.addWidget(btn_inc)
        mod_row.addWidget(btn_dec)
        mod_row.addWidget(btn_reset)
        layout.addLayout(mod_row)

        layout.addSpacing(6)

        layout.addWidget(QtWidgets.QLabel("<b>Protonation</b>"))
        protonation_row = QtWidgets.QHBoxLayout()
        protonation_row.addWidget(QtWidgets.QLabel("pH:"))
        self._ph = QtWidgets.QDoubleSpinBox()
        self._ph.setRange(0, 14)
        self._ph.setDecimals(1)
        self._ph.setSingleStep(0.1)
        self._ph.setValue(7.4)
        protonation_row.addWidget(self._ph)
        self._protonate_button = QtWidgets.QPushButton("Protonate active object")
        self._protonate_button.clicked.connect(self._protonate)
        protonation_row.addWidget(self._protonate_button)
        layout.addLayout(protonation_row)
        note = QtWidgets.QLabel(
            "Updates hydrogens and formal charges for the whole active object. Use Undo to restore it."
        )
        note.setWordWrap(True)
        layout.addWidget(note)

        self._lbl_summary = QtWidgets.QLabel("")
        self._lbl_summary.setWordWrap(True)
        layout.addWidget(self._lbl_summary)

        layout.addStretch()

        # Wiring
        btn_refresh.clicked.connect(self._refresh_selection_info)
        btn_set_custom.clicked.connect(lambda: self._set_charge(self._custom_spin.value()))
        btn_inc.clicked.connect(lambda: self._modify_charges(+1))
        btn_dec.clicked.connect(lambda: self._modify_charges(-1))
        btn_reset.clicked.connect(lambda: self._set_charge(0))

    @property
    def widget(self) -> QtWidgets.QWidget:
        return self._widget

    # -- helpers ----------------------------------------------------------

    def _active_indices(self) -> tuple[str, list[int]] | None:
        """Return ``(obj_name, sele_indices)`` for the active object, or None with a warning."""
        obj_name = self._state.active
        if not obj_name or obj_name not in self._state.arrays:
            QtWidgets.QMessageBox.warning(self._widget, "No active object", "Load a structure first.")
            return None
        indices = selection_to_indices("sele", self._state.index_maps[obj_name], obj_name)
        if not indices:
            QtWidgets.QMessageBox.warning(self._widget, "No selection", "Make a selection in PyMOL first.")
            return None
        return obj_name, indices

    def _refresh_selection_info(self) -> None:
        obj_name = self._state.active
        if not obj_name or obj_name not in self._state.arrays:
            self._lbl_selection.setText("Selection: (no active object)")
            self._lbl_current.setText("Current charges: —")
            return
        indices = (
            selection_to_indices("sele", self._state.index_maps[obj_name], obj_name)
            if "sele" in cmd.get_names("selections")
            else []
        )
        arr = self._state.get_synced_array(obj_name)
        if arr is None:
            self._lbl_selection.setText("Selection: (no active object)")
            self._lbl_current.setText("Current charges: —")
            return
        charges = _read_charges(arr)
        self._lbl_selection.setText(f"Selection: {len(indices)} atoms")
        if indices:
            values = charges[indices]
            preview = ", ".join(f"{int(v):+d}" for v in values[:20])
            suffix = f" (+{len(indices) - 20} more)" if len(indices) > 20 else ""
            self._lbl_current.setText(f"Current charges: [{preview}]{suffix}")
        else:
            self._lbl_current.setText("Current charges: —")
        self._update_summary()

    def _update_summary(self) -> None:
        obj_name = self._state.active
        if not obj_name or obj_name not in self._state.arrays:
            self._lbl_summary.setText("")
            return
        arr = self._state.get_synced_array(obj_name)
        if arr is None:
            self._lbl_summary.setText("")
            return
        charges = _read_charges(arr)
        nonzero = int(np.count_nonzero(charges))
        net = int(charges.sum())
        self._lbl_summary.setText(f"Non-zero charges in active: {nonzero} atoms (net {net:+d})")

    # -- actions ----------------------------------------------------------

    def _set_charge(self, value: int) -> None:
        result = self._active_indices()
        if result is None:
            return
        obj_name, indices = result
        try:
            self._state.document(obj_name).set_charge(indices, value=value)
        except Exception as e:
            QtWidgets.QMessageBox.critical(self._widget, "Set charge error", str(e))
            return
        reload_structure_in_pymol(obj_name)
        self._refresh_selection_info()

    def _modify_charges(self, delta: int) -> None:
        result = self._active_indices()
        if result is None:
            return
        obj_name, indices = result
        try:
            self._state.document(obj_name).set_charge(indices, delta=delta)
        except Exception as e:
            QtWidgets.QMessageBox.critical(self._widget, "Modify charge error", str(e))
            return
        reload_structure_in_pymol(obj_name)
        self._refresh_selection_info()

    def _protonate(self) -> None:
        obj_name = self._state.active
        if not obj_name or obj_name not in self._state.arrays:
            QtWidgets.QMessageBox.warning(
                self._widget, "No active object", "Load a CIF and choose an active object first."
            )
            return
        self._protonate_button.setEnabled(False)
        try:
            document = self._state.document(obj_name)
            document.protonate(self._ph.value())
            # Protonation adds atoms; bump the structure version so stale picked keys are rejected.
            self._state.set_array(obj_name, document.array)
            reload_structure_in_pymol(obj_name)
            self._refresh_selection_info()
        except Exception as error:
            QtWidgets.QMessageBox.critical(self._widget, "Protonation failed", str(error))
        finally:
            self._protonate_button.setEnabled(True)
