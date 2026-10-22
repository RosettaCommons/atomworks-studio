"""Bond editing wizard for the AtomWorks PyMOL plugin.

Provides :py:class:`BondWizard`, a dockable dialog for interactively adding,
removing, and inferring bonds on the active :py:class:`AtomArrayPlus`.
"""

import logging
import os

from atomworks_studio_editing.document import BOND_TYPES
from biotite.structure.bonds import BondType
from pymol import cmd
from pymol.Qt import QtCore, QtWidgets

from atomworks_studio_pymol.bridge import (
    _pymol_resi_to_res_id_ins_code,
    reload_structure_in_pymol,
    selection_to_indices,
)
from atomworks_studio_pymol.state import PluginState

logger = logging.getLogger("atomworks_studio_pymol")

_POLL_MS = 200  # QTimer polling interval (ms) for atom picking


class BondWizard:
    """Dialog for editing the bond graph of the active AtomArrayPlus.

    Features:
    - Pick two atoms from the PyMOL 3D view, choose a bond type, and add or
      remove the bond between them.
    - View all bonds involving the current PyMOL selection in a table, and
      delete individual bonds from it.
    - Optionally infer all bonds from CCD templates (requires CCD_MIRROR_PATH).
    """

    def __init__(self, state: PluginState, parent: QtWidgets.QWidget | None = None):
        self._state = state
        # Picked atoms and table rows are stored by identity key, not raw row index, alongside
        # the object name and structure version at pick/refresh time -- this lets a later
        # resolve detect that the structure changed in the meantime, even if the key happens
        # to still be present in the (rebuilt) index map for a *different* atom.
        self._picked: list[tuple[tuple, str, str, int] | None] = [None, None]
        self._table_bonds: list[tuple[tuple, tuple, int, str, int]] = []
        self._timers: list = [None, None]
        # PyMOL's mouse_selection_mode while picking is active (picking forces atom mode).
        self._saved_selection_mode: str | None = None

        self._widget = QtWidgets.QWidget(parent)
        self._widget.setWindowTitle("AtomWorks — Bond Wizard")
        self._widget.setMinimumWidth(300)
        layout = QtWidgets.QVBoxLayout(self._widget)

        # ---- Atom picking ------------------------------------------------
        layout.addWidget(QtWidgets.QLabel("<b>Atoms</b>"))

        self._lbl_atom = [QtWidgets.QLabel("Atom 1: —"), QtWidgets.QLabel("Atom 2: —")]
        self._btn_pick = [
            QtWidgets.QPushButton("Select Atom 1"),
            QtWidgets.QPushButton("Select Atom 2"),
        ]
        for row_layout, lbl, btn in zip(
            [QtWidgets.QHBoxLayout(), QtWidgets.QHBoxLayout()],
            self._lbl_atom,
            self._btn_pick,
            strict=False,
        ):
            row_layout.addWidget(lbl, stretch=1)
            row_layout.addWidget(btn)
            layout.addLayout(row_layout)

        self._btn_pick[0].clicked.connect(lambda: self._toggle_picking(0))
        self._btn_pick[1].clicked.connect(lambda: self._toggle_picking(1))

        layout.addSpacing(6)

        # ---- Bond type ---------------------------------------------------
        type_row = QtWidgets.QHBoxLayout()
        type_row.addWidget(QtWidgets.QLabel("Bond type:"))
        self._type_combo = QtWidgets.QComboBox()
        self._type_combo.addItems(list(BOND_TYPES))
        type_row.addWidget(self._type_combo)
        type_row.addStretch()
        layout.addLayout(type_row)

        layout.addSpacing(6)

        # ---- Add / Remove ------------------------------------------------
        action_row = QtWidgets.QHBoxLayout()
        self._btn_add = QtWidgets.QPushButton("Add Bond")
        self._btn_remove = QtWidgets.QPushButton("Remove Bond")
        action_row.addWidget(self._btn_add)
        action_row.addWidget(self._btn_remove)
        layout.addLayout(action_row)

        self._btn_add.clicked.connect(self._add_bond)
        self._btn_remove.clicked.connect(self._remove_bond)

        # ---- Status label ------------------------------------------------
        self._status = QtWidgets.QLabel("")
        self._status.setWordWrap(True)
        layout.addWidget(self._status)

        layout.addSpacing(6)

        # ---- Bonds table -------------------------------------------------
        layout.addWidget(QtWidgets.QLabel("<b>Bonds involving selection</b>"))

        self._table = QtWidgets.QTableWidget(0, 3)
        self._table.setHorizontalHeaderLabels(["Atom 1", "Atom 2", "Type"])
        self._table.horizontalHeader().setStretchLastSection(True)
        self._table.setSelectionBehavior(QtWidgets.QAbstractItemView.SelectRows)
        self._table.setSelectionMode(QtWidgets.QAbstractItemView.SingleSelection)
        self._table.setEditTriggers(QtWidgets.QAbstractItemView.NoEditTriggers)
        self._table.setMinimumHeight(120)
        layout.addWidget(self._table)

        table_btns = QtWidgets.QHBoxLayout()
        self._btn_refresh = QtWidgets.QPushButton("Refresh Table")
        self._btn_delete_row = QtWidgets.QPushButton("Delete Selected Bond")
        self._btn_delete_row.setEnabled(False)
        table_btns.addWidget(self._btn_refresh)
        table_btns.addWidget(self._btn_delete_row)
        layout.addLayout(table_btns)

        self._btn_refresh.clicked.connect(self._refresh_table)
        self._btn_delete_row.clicked.connect(self._delete_selected_bond)
        self._table.itemSelectionChanged.connect(
            lambda: self._btn_delete_row.setEnabled(bool(self._table.selectedItems()))
        )

        # ---- Infer from CCD ----------------------------------------------
        sep = QtWidgets.QFrame()
        sep.setFrameShape(QtWidgets.QFrame.HLine)
        sep.setFrameShadow(QtWidgets.QFrame.Sunken)
        layout.addWidget(sep)

        self._btn_infer = QtWidgets.QPushButton("Infer Bonds from CCD")
        ccd_available = bool(os.environ.get("CCD_MIRROR_PATH"))
        if ccd_available:
            self._btn_infer.setToolTip(
                "Infer bonds using CCD templates without changing atoms or charges.\n"
                "Works for standard residues and any molecule with a CCD code."
            )
        else:
            self._btn_infer.setEnabled(False)
            self._btn_infer.setToolTip("Requires CCD_MIRROR_PATH to be set in the environment.")
        layout.addWidget(self._btn_infer)
        self._btn_infer.clicked.connect(self._infer_from_ccd)

    @property
    def widget(self) -> object:
        """Return the inner QWidget for embedding in a tab or dock."""
        return self._widget

    def show(self) -> None:
        """Show the wizard as a floating window."""
        self._widget.show()
        self._widget.raise_()
        self._widget.activateWindow()

    # ------------------------------------------------------------------
    # Atom picking state machine (mirrors PairValueEditor)
    # ------------------------------------------------------------------

    def _toggle_picking(self, slot: int) -> None:
        if self._timers[slot] is not None:
            self._cancel_picking(slot)
        else:
            self._start_picking(slot)

    def _start_picking(self, slot: int) -> None:
        cmd.select("sele", "none")
        # A click selects a whole residue in PyMOL's default (residue) mode, so pick atoms.
        if self._saved_selection_mode is None:
            self._saved_selection_mode = cmd.get("mouse_selection_mode")
            cmd.set("mouse_selection_mode", 0)

        self._btn_pick[slot].setText("Cancel")
        self._lbl_atom[slot].setText(f"Atom {slot + 1}: left-click an atom in PyMOL…")

        timer = QtCore.QTimer(self._widget)
        timer.setInterval(_POLL_MS)

        def on_tick() -> None:
            try:
                model = cmd.get_model("sele")
            except Exception:
                return
            if not model.atom:
                return
            if len(model.atom) != 1 or model.atom[0].model != self._state.active:
                cmd.select("sele", "none")
                self._lbl_atom[slot].setText(f"Atom {slot + 1}: click a single atom of '{self._state.active}'…")
                return
            self._finish_picking(slot, model.atom[0])

        timer.timeout.connect(on_tick)
        self._timers[slot] = timer
        timer.start()

    def _cancel_picking(self, slot: int) -> None:
        timer = self._timers[slot]
        if timer is not None:
            timer.stop()
            self._timers[slot] = None
        if self._saved_selection_mode is not None and all(t is None for t in self._timers):
            cmd.set("mouse_selection_mode", self._saved_selection_mode)
            self._saved_selection_mode = None
        self._btn_pick[slot].setText(f"Select Atom {slot + 1}")
        if self._picked[slot] is None:
            self._lbl_atom[slot].setText(f"Atom {slot + 1}: —")

    def _finish_picking(self, slot: int, atom) -> None:
        self._cancel_picking(slot)

        obj_name = self._state.active
        if not obj_name or obj_name not in self._state.index_maps:
            return

        res_id, ins_code = _pymol_resi_to_res_id_ins_code(atom.resi)
        key = (atom.chain, res_id, ins_code, atom.name)

        if key not in self._state.index_maps[obj_name]:
            self._lbl_atom[slot].setText(f"Atom {slot + 1}: not found ({atom.chain}{atom.resi} {atom.name})")
            return

        label = f"{atom.chain}{atom.resi} {atom.name}"
        self._picked[slot] = (key, label, obj_name, self._state.structure_version(obj_name))
        self._lbl_atom[slot].setText(f"Atom {slot + 1}: {label}")

    # ------------------------------------------------------------------
    # Bond operations
    # ------------------------------------------------------------------

    def _current_bond_type(self) -> BondType:
        return BOND_TYPES[self._type_combo.currentText()]

    def _resolve_picked(self, obj_name: str) -> tuple[int, int] | None:
        """Resolve both picked atoms' identity keys to current row indices.

        Returns ``None`` if either atom was picked against a different object,
        the structure has since changed (even if the key still resolves -- it
        may now belong to a different atom), or the key is simply gone.
        """
        index_map = self._state.index_maps.get(obj_name) or {}
        current_version = self._state.structure_version(obj_name)
        indices = []
        for picked in self._picked:
            key, _, picked_obj_name, picked_version = picked
            if picked_obj_name != obj_name or picked_version != current_version:
                return None
            idx = index_map.get(key)
            if idx is None:
                return None
            indices.append(idx)
        return indices[0], indices[1]

    def _add_bond(self) -> None:
        if self._picked[0] is None or self._picked[1] is None:
            self._status.setText("Pick both atoms first.")
            return

        obj_name = self._state.active
        if not obj_name or obj_name not in self._state.arrays:
            return

        lbl1, lbl2 = self._picked[0][1], self._picked[1][1]
        self._state.get_synced_array(obj_name)
        resolved = self._resolve_picked(obj_name)
        if resolved is None:
            QtWidgets.QMessageBox.warning(
                self._widget, "Atom not found", "A picked atom no longer exists in the structure -- re-pick it."
            )
            return
        idx1, idx2 = resolved
        if idx1 == idx2:
            self._status.setText("Cannot add a bond from an atom to itself.")
            return

        try:
            self._state.document(obj_name).edit_bond(idx1, idx2, "add", self._current_bond_type().name)
        except Exception as e:
            QtWidgets.QMessageBox.critical(self._widget, "Add Bond Error", str(e))
            return

        reload_structure_in_pymol(obj_name)
        self._status.setText(f"Added {self._current_bond_type().name} bond: {lbl1} — {lbl2}")
        self._refresh_table()

    def _remove_bond(self) -> None:
        if self._picked[0] is None or self._picked[1] is None:
            self._status.setText("Pick both atoms first.")
            return

        obj_name = self._state.active
        if not obj_name or obj_name not in self._state.arrays:
            return

        lbl1, lbl2 = self._picked[0][1], self._picked[1][1]
        arr = self._state.get_synced_array(obj_name)
        if arr is None:
            return

        if arr.bonds is None:
            self._status.setText("No bonds on this structure.")
            return

        resolved = self._resolve_picked(obj_name)
        if resolved is None:
            QtWidgets.QMessageBox.warning(
                self._widget, "Atom not found", "A picked atom no longer exists in the structure -- re-pick it."
            )
            return
        idx1, idx2 = resolved

        try:
            self._state.document(obj_name).edit_bond(idx1, idx2, "remove")
        except Exception as e:
            QtWidgets.QMessageBox.critical(self._widget, "Remove Bond Error", str(e))
            return

        reload_structure_in_pymol(obj_name)
        self._status.setText(f"Removed bond: {lbl1} — {lbl2}")
        self._refresh_table()

    def _delete_selected_bond(self) -> None:
        row = self._table.currentRow()
        if row < 0 or row >= len(self._table_bonds):
            return

        obj_name = self._state.active
        if not obj_name or obj_name not in self._state.arrays:
            return

        key1, key2, _, row_obj_name, row_version = self._table_bonds[row]
        self._state.get_synced_array(obj_name)
        index_map = self._state.index_maps.get(obj_name) or {}
        current_version = self._state.structure_version(obj_name)
        idx1, idx2 = index_map.get(key1), index_map.get(key2)
        if row_obj_name != obj_name or row_version != current_version or idx1 is None or idx2 is None:
            QtWidgets.QMessageBox.warning(
                self._widget, "Bond not found", "An atom in this bond no longer exists -- refresh the table."
            )
            self._refresh_table()
            return

        try:
            self._state.document(obj_name).edit_bond(idx1, idx2, "remove")
        except Exception as e:
            QtWidgets.QMessageBox.critical(self._widget, "Delete Bond Error", str(e))
            return

        reload_structure_in_pymol(obj_name)
        self._status.setText(f"Deleted bond (row {row}).")
        self._refresh_table()

    # ------------------------------------------------------------------
    # Bonds table
    # ------------------------------------------------------------------

    def _atom_label(self, idx: int, reverse_map: dict) -> str:
        key = reverse_map.get(idx)
        if key is None:
            return str(idx)
        chain, res_id, ins_code, atom_name = key
        return f"{chain}{res_id}{ins_code} {atom_name}".strip()

    def _bond_type_name(self, bond_type_val: int) -> str:
        try:
            return BondType(bond_type_val).name
        except ValueError:
            return str(bond_type_val)

    def _refresh_table(self) -> None:
        self._table_bonds = []
        self._table.setRowCount(0)

        obj_name = self._state.active
        if not obj_name or obj_name not in self._state.arrays:
            return

        arr = self._state.get_synced_array(obj_name)
        if arr is None or arr.bonds is None:
            return

        bond_array = arr.bonds.as_array()  # shape (N, 3): [idx1, idx2, bond_type]
        if len(bond_array) == 0:
            return

        # Filter to bonds involving the current sele (if any)
        try:
            sel_indices = set(selection_to_indices("sele", self._state.index_maps[obj_name], obj_name))
        except Exception:
            sel_indices = set()

        if sel_indices:
            mask = [b[0] in sel_indices or b[1] in sel_indices for b in bond_array]
            filtered = bond_array[[i for i, m in enumerate(mask) if m]]
        else:
            filtered = bond_array

        if len(filtered) == 0:
            return

        reverse_map = {v: k for k, v in self._state.index_maps[obj_name].items()}
        version = self._state.structure_version(obj_name)

        self._table.setRowCount(len(filtered))
        for row, (i1, i2, btype) in enumerate(filtered):
            self._table_bonds.append((reverse_map[int(i1)], reverse_map[int(i2)], int(btype), obj_name, version))
            self._table.setItem(row, 0, QtWidgets.QTableWidgetItem(self._atom_label(i1, reverse_map)))
            self._table.setItem(row, 1, QtWidgets.QTableWidgetItem(self._atom_label(i2, reverse_map)))
            self._table.setItem(row, 2, QtWidgets.QTableWidgetItem(self._bond_type_name(btype)))

    # ------------------------------------------------------------------
    # CCD inference
    # ------------------------------------------------------------------

    def _infer_from_ccd(self) -> None:
        obj_name = self._state.active
        if not obj_name or obj_name not in self._state.arrays:
            return

        confirm = QtWidgets.QMessageBox.question(
            self._widget,
            "Infer Bonds from CCD",
            "Infer bonds using CCD templates without changing atoms or charges?",
            QtWidgets.QMessageBox.Yes | QtWidgets.QMessageBox.Cancel,
        )
        if confirm != QtWidgets.QMessageBox.Yes:
            return

        try:
            self._state.document(obj_name).infer_bonds_from_ccd()
        except Exception as e:
            QtWidgets.QMessageBox.critical(self._widget, "CCD Inference Error", str(e))
            return

        reload_structure_in_pymol(obj_name)
        self._status.setText("Bonds inferred from CCD templates.")
        self._refresh_table()
