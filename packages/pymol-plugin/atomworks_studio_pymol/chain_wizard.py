"""Chain editing wizard for the AtomWorks PyMOL plugin.

Provides :py:class:`ChainWizard`, a dockable tab that edits the ``chain_id``
annotation on the active :py:class:`AtomArrayPlus`. All chain-derived
annotations (``pn_unit_id``, ``molecule_id``, ``*_iid``, entity hashes) are
re-derived by the shared AtomWorks mutation.
"""

import logging

import numpy as np
from atomworks.io.utils.chain import create_chain_id_generator
from pymol.Qt import QtWidgets

from atomworks_studio_pymol.bridge import (
    reload_structure_in_pymol,
    selection_to_indices,
)
from atomworks_studio_pymol.state import PluginState

logger = logging.getLogger("atomworks_studio_pymol")


class ChainWizard:
    """Tab for editing ``chain_id`` on the active AtomArrayPlus.

    Operations apply to the current PyMOL ``sele`` selection:

    - Assign the selection to an existing chain (via dropdown).
    - Create a new chain from the selection (using the next unused chain ID).
    """

    def __init__(self, state: PluginState, parent: QtWidgets.QWidget | None = None):
        self._state = state
        self._widget = QtWidgets.QWidget(parent)
        self._widget.setMinimumWidth(300)
        layout = QtWidgets.QVBoxLayout(self._widget)

        layout.addWidget(QtWidgets.QLabel("<b>Chains</b>"))

        # Existing chain dropdown + add button + refresh
        chain_row = QtWidgets.QHBoxLayout()
        chain_row.addWidget(QtWidgets.QLabel("Chain:"))
        self._chain_combo = QtWidgets.QComboBox()
        chain_row.addWidget(self._chain_combo, stretch=1)
        btn_refresh = QtWidgets.QPushButton("↻")
        btn_refresh.setToolTip("Refresh chain list from the active object")
        btn_refresh.setMaximumWidth(30)
        chain_row.addWidget(btn_refresh)
        layout.addLayout(chain_row)

        self._btn_add = QtWidgets.QPushButton("Add selection to chain")
        layout.addWidget(self._btn_add)

        layout.addSpacing(6)

        self._btn_new = QtWidgets.QPushButton("New chain from selection")
        layout.addWidget(self._btn_new)

        layout.addSpacing(6)

        self._status = QtWidgets.QLabel("")
        self._status.setWordWrap(True)
        layout.addWidget(self._status)

        layout.addStretch()

        self._btn_add.clicked.connect(self._add_to_chain)
        self._btn_new.clicked.connect(self._new_chain_from_selection)
        btn_refresh.clicked.connect(self.refresh)

        self.refresh()

    @property
    def widget(self) -> QtWidgets.QWidget:
        return self._widget

    # -- helpers ----------------------------------------------------------

    def _active(self) -> tuple[str, object] | None:
        obj_name = self._state.active
        if not obj_name or obj_name not in self._state.arrays:
            QtWidgets.QMessageBox.warning(self._widget, "No active object", "Load a structure first.")
            return None
        arr = self._state.get_synced_array(obj_name)
        if arr is None:
            QtWidgets.QMessageBox.warning(self._widget, "No active object", "Load a structure first.")
            return None
        if "chain_id" not in arr.get_annotation_categories():
            raise ValueError("AtomArray has no 'chain_id' annotation.")
        return obj_name, arr

    def _active_indices(self) -> tuple[str, object, list[int]] | None:
        active = self._active()
        if active is None:
            return None
        obj_name, arr = active
        indices = selection_to_indices("sele", self._state.index_maps[obj_name], obj_name)
        if not indices:
            QtWidgets.QMessageBox.warning(self._widget, "No selection", "Make a selection in PyMOL first.")
            return None
        return obj_name, arr, indices

    def _selected_chain_id(self) -> str | None:
        data = self._chain_combo.currentData()
        return None if data is None else str(data)

    def _post_edit(self, obj_name: str, status: str) -> None:
        # Chain assignment renames atom identities; bump the structure version so
        # identity keys picked before the edit are rejected.
        self._state.set_array(obj_name, self._state.documents[obj_name].array)
        reload_structure_in_pymol(obj_name)
        self._status.setText(status)
        self.refresh()

    # -- UI refresh -------------------------------------------------------

    def refresh(self) -> None:
        """Rebuild the chain dropdown from the active object."""
        self._chain_combo.blockSignals(True)
        self._chain_combo.clear()

        obj_name = self._state.active
        if not obj_name or obj_name not in self._state.arrays:
            self._chain_combo.addItem("(no active object)", None)
            self._chain_combo.blockSignals(False)
            return

        arr = self._state.get_synced_array(obj_name)
        if arr is None:
            self._chain_combo.addItem("(no active object)", None)
            self._chain_combo.blockSignals(False)
            return
        if "chain_id" not in arr.get_annotation_categories():
            self._chain_combo.addItem("(no chain_id annotation)", None)
            self._chain_combo.blockSignals(False)
            return

        chain_ids, counts = np.unique(arr.chain_id, return_counts=True)
        for cid, count in zip(chain_ids, counts, strict=True):
            self._chain_combo.addItem(f"{cid} ({int(count)} atoms)", str(cid))

        self._chain_combo.blockSignals(False)

    # -- actions ----------------------------------------------------------

    def _add_to_chain(self) -> None:
        try:
            result = self._active_indices()
        except ValueError as e:
            QtWidgets.QMessageBox.critical(self._widget, "Chain error", str(e))
            return
        if result is None:
            return
        obj_name, _arr, indices = result

        chain_id = self._selected_chain_id()
        if chain_id is None:
            QtWidgets.QMessageBox.warning(self._widget, "No chain", "Pick a chain from the dropdown first.")
            return

        try:
            self._state.document(obj_name).assign_chain(indices, chain_id)
        except Exception as e:
            QtWidgets.QMessageBox.critical(self._widget, "Add to chain failed", str(e))
            return

        self._post_edit(obj_name, f"Assigned {len(indices)} atoms to chain {chain_id!r}.")

    def _new_chain_from_selection(self) -> None:
        try:
            result = self._active_indices()
        except ValueError as e:
            QtWidgets.QMessageBox.critical(self._widget, "Chain error", str(e))
            return
        if result is None:
            return
        obj_name, arr, indices = result

        unavailable = list(np.unique(arr.chain_id).astype(str))
        new_chain_id = next(create_chain_id_generator(unavailable))

        try:
            self._state.document(obj_name).assign_chain(indices, new_chain_id)
        except Exception as e:
            QtWidgets.QMessageBox.critical(self._widget, "New chain failed", str(e))
            return

        self._post_edit(obj_name, f"Created chain {new_chain_id!r} with {len(indices)} atoms.")
