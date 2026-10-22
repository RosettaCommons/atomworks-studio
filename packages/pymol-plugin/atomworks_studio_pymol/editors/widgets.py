"""Annotation editor widgets for the AtomWorks PyMOL plugin.

Each editor is a QWidget that:
1. Reads the current annotation state from the active AtomArrayPlus.
2. Presents appropriate controls for the user to modify the annotation.
3. Applies changes to the AtomArrayPlus (and refreshes PyMOL) when the
   user clicks Apply.

All Qt imports are deferred to avoid pulling PyQt into the core library.
"""

import logging

import numpy as np
from atomworks.io.utils.atom_array_plus import AnnotationList2D
from atomworks.io.utils.standard_annotations.base import StandardAnnotationBase
from atomworks_studio_editing.annotations import set_annotation_mask
from atomworks_studio_editing.mutations import set_condition_mask
from pymol import cmd
from pymol.Qt import QtCore
from pymol.Qt import QtWidgets as _QtWidgets

from atomworks_studio_pymol.bridge import (
    _pymol_resi_to_res_id_ins_code,
    reload_structure_in_pymol,
    selection_to_indices,
)
from atomworks_studio_pymol.state import PluginState
from atomworks_studio_pymol.views import apply_current_view

logger = logging.getLogger("atomworks_studio_pymol")

# ---------------------------------------------------------------------------
# Base editor
# ---------------------------------------------------------------------------


class BaseAnnotationEditor:
    """Abstract base mixin for annotation editors.

    Subclasses are QWidget subclasses that also mix in these helpers.
    Subclasses must set ``self._annotation_cls`` and ``self._state`` before
    calling any of these methods, and must implement :py:meth:`apply_to_selection`.
    """

    def _get_selection_indices(self, selection: str = "sele") -> list[int]:
        """Translate current PyMOL selection to AtomArrayPlus indices."""
        obj_name = self._state.active
        if not obj_name or obj_name not in self._state.index_maps:
            return []
        return selection_to_indices(selection, self._state.index_maps[obj_name], obj_name)

    def _require_selection_indices(self, selection: str = "sele") -> list[int] | None:
        """Return selection indices, or ``None`` (after a popup) if nothing is selected.

        Warns via a message box rather than failing silently, so a button press
        with an empty ``sele`` never looks like a no-op bug. Named condition
        selections (e.g. ``rasa_buried_...``) are visual highlights only and do
        not count as the active selection.
        """
        indices = self._get_selection_indices(selection)
        if not indices:
            parent = self if isinstance(self, _QtWidgets.QWidget) else None
            _QtWidgets.QMessageBox.warning(
                parent,
                "No atoms selected",
                "No atoms are selected in PyMOL. Make a selection in the viewport first.\n\n"
                "Note: only `sele` is the active selection",
            )
            return None
        return indices

    def _clear_selection(self) -> None:
        """Empty ``sele`` and turn off all selection indicators after an edit."""
        cmd.select("sele", "none")
        cmd.deselect()

    def apply_to_selection(self) -> None:  # pragma: no cover
        """Apply the editor's current settings to the PyMOL selection."""
        raise NotImplementedError

    def _set_mask(self, value: bool) -> bool:
        """Set the annotation mask to *value* for the current PyMOL selection."""
        obj_name = self._state.active
        if not obj_name or obj_name not in self._state.arrays:
            return False
        indices = self._require_selection_indices()
        if indices is None:
            return False
        document = self._state.document(obj_name)
        definition = document.condition_provider.definitions_by_name.get(self._annotation_cls.name)
        try:
            if definition is not None:
                document.set_condition(
                    definition.key,
                    indices,
                    enabled=not value if definition.invert_mask else value,
                    scope=definition.level.value,
                )
            else:
                with document.edit():
                    set_condition_mask(document.array, self._annotation_cls, indices, value)
        except (ValueError, TypeError) as error:
            _QtWidgets.QMessageBox.warning(self, "Annotation edit failed", str(error))
            return False
        self._reload_or_recolor()
        self._clear_selection()
        return True

    def _reload_or_recolor(self, structural_change: bool = False) -> None:
        """Refresh the PyMOL view after an annotation or structural edit.

        Args:
            structural_change: If True, full reload is needed (atom count changed).
                If False, re-applies the style command to reflect annotation changes.
        """
        obj_name = self._state.active
        if not obj_name or obj_name not in self._state.arrays:
            return

        if structural_change:
            reload_structure_in_pymol(obj_name)
        else:
            apply_current_view(self._state.get_synced_array(obj_name), obj_name)


# ---------------------------------------------------------------------------
# MaskEditor
# ---------------------------------------------------------------------------


class MaskEditor(_QtWidgets.QWidget, BaseAnnotationEditor):
    """Editor for boolean mask annotations (NTerminus, CTerminus, Atomize, etc.).

    Provides three buttons:
    - Set True for selection
    - Set False for selection
    - Reset to default
    """

    def __init__(
        self, annotation_cls: type[StandardAnnotationBase], state: PluginState, parent: _QtWidgets.QWidget | None = None
    ):
        super().__init__(parent)
        layout = _QtWidgets.QVBoxLayout(self)

        # Header
        cls = annotation_cls
        header = _QtWidgets.QLabel(f"<b>{cls.name}</b> &nbsp; <i>(level: {cls.level}, n_body: {cls.n_body})</i>")
        header.setWordWrap(True)
        layout.addWidget(header)

        # Description
        if cls.__doc__:
            doc_label = _QtWidgets.QLabel(cls.__doc__.strip().split("\n")[0])
            doc_label.setWordWrap(True)
            layout.addWidget(doc_label)

        layout.addSpacing(8)

        definition = state.condition_provider.definitions_by_name.get(cls.name)
        inverted = definition is not None and definition.invert_mask
        if inverted:
            description = _QtWidgets.QLabel("All residues are indexed by default unless explicitly unindexed.")
            description.setWordWrap(True)
            layout.addWidget(description)
        btn_true = _QtWidgets.QPushButton("Restore indexing" if inverted else "Set True for selection")
        btn_false = _QtWidgets.QPushButton("Unindex selection" if inverted else "Set False for selection")
        btn_reset = _QtWidgets.QPushButton("Reset to Default")
        layout.addWidget(btn_true)
        layout.addWidget(btn_false)
        layout.addWidget(btn_reset)
        layout.addStretch()

        self._annotation_cls = annotation_cls
        self._state = state

        btn_true.clicked.connect(lambda: self._set_mask(True))
        btn_false.clicked.connect(lambda: self._set_mask(False))
        btn_reset.clicked.connect(self._reset)

    def _reset(self) -> None:
        obj_name = self._state.active
        if not obj_name or obj_name not in self._state.arrays:
            return
        document = self._state.document(obj_name)
        try:
            with document.edit():
                self._annotation_cls.set_annotation(
                    document.array, self._annotation_cls.default_annotation(document.array)
                )
        except (ValueError, TypeError) as error:
            _QtWidgets.QMessageBox.warning(self, "Annotation reset failed", str(error))
            return
        self._reload_or_recolor()

    def apply_to_selection(self) -> None:
        self._set_mask(True)


# ---------------------------------------------------------------------------
# ScalarEditor

# ---------------------------------------------------------------------------


class ScalarEditor(_QtWidgets.QWidget, BaseAnnotationEditor):
    """Editor for scalar non-mask annotations (Index, etc.).

    Provides:
    - A mask toggle checkbox for the selection.
    - A value input (spinbox or line edit depending on dtype).
    """

    def __init__(
        self, annotation_cls: type[StandardAnnotationBase], state: PluginState, parent: _QtWidgets.QWidget | None = None
    ):
        super().__init__(parent)
        layout = _QtWidgets.QVBoxLayout(self)

        cls = annotation_cls
        header = _QtWidgets.QLabel(f"<b>{cls.name}</b> &nbsp; <i>(level: {cls.level})</i>")
        header.setWordWrap(True)
        layout.addWidget(header)

        # Mask toggle
        self._mask_chk = _QtWidgets.QCheckBox("Include selection in mask (condition active)")
        layout.addWidget(self._mask_chk)

        # Value input
        if np.issubdtype(cls.dtype, np.integer):
            self._value_widget = _QtWidgets.QSpinBox()
            self._value_widget.setRange(-9999, 9999)
        elif np.issubdtype(cls.dtype, np.floating):
            self._value_widget = _QtWidgets.QDoubleSpinBox()
            self._value_widget.setRange(-9999.0, 9999.0)
            self._value_widget.setDecimals(3)
        else:
            self._value_widget = _QtWidgets.QLineEdit()

        value_container = _QtWidgets.QWidget()
        value_row = _QtWidgets.QHBoxLayout(value_container)
        value_row.setContentsMargins(0, 0, 0, 0)
        value_row.addWidget(_QtWidgets.QLabel("Value:"))
        value_row.addWidget(self._value_widget)
        layout.addWidget(value_container)
        self._mask_chk.toggled.connect(value_container.setVisible)
        value_container.setVisible(self._mask_chk.isChecked())

        btn_apply = _QtWidgets.QPushButton("Apply")
        btn_apply.clicked.connect(self.apply_to_selection)
        layout.addWidget(btn_apply)
        layout.addStretch()

        self._annotation_cls = annotation_cls
        self._state = state

    def apply_to_selection(self) -> None:
        obj_name = self._state.active
        if not obj_name or obj_name not in self._state.arrays:
            return
        indices = self._require_selection_indices()
        if indices is None:
            return
        document = self._state.document(obj_name)
        try:
            with document.edit():
                arr = document.array
                mask = self._annotation_cls.mask(arr, default="generate").copy()
                mask[indices] = self._mask_chk.isChecked()
                if isinstance(self._value_widget, _QtWidgets.QSpinBox | _QtWidgets.QDoubleSpinBox):
                    val = self._value_widget.value()
                else:
                    val = self._value_widget.text()
                if self._mask_chk.isChecked():
                    annot = self._annotation_cls.annotation(arr, default="generate").copy()
                    annot[indices] = val
                    self._annotation_cls.set_annotation(arr, annot)
                set_annotation_mask(self._annotation_cls, arr, mask)
        except (ValueError, TypeError) as error:
            _QtWidgets.QMessageBox.warning(self, "Annotation edit failed", str(error))
            return

        self._reload_or_recolor()
        self._clear_selection()


# ---------------------------------------------------------------------------
# SequenceEditor (custom, for Sequence condition)
# ---------------------------------------------------------------------------


class SequenceEditor(_QtWidgets.QWidget, BaseAnnotationEditor):
    """Mask-only editor for the Sequence condition.

    Toggles the sequence mask on the selection.  The annotation value (which
    amino acid sequence to condition on) is always taken from the current
    ``res_name`` on the array — no manual value entry is needed.
    """

    def __init__(
        self, annotation_cls: type[StandardAnnotationBase], state: PluginState, parent: _QtWidgets.QWidget | None = None
    ):
        super().__init__(parent)
        layout = _QtWidgets.QVBoxLayout(self)

        header = _QtWidgets.QLabel("<b>Sequence Condition</b>")
        layout.addWidget(header)

        desc = _QtWidgets.QLabel(
            "Condition the selected residues on their current sequence (res_name). "
            "The mask controls whether the model is constrained to match the "
            "existing sequence at those positions."
        )
        desc.setWordWrap(True)
        layout.addWidget(desc)

        layout.addSpacing(8)

        btn_true = _QtWidgets.QPushButton("Condition on sequence (mask = True)")
        btn_false = _QtWidgets.QPushButton("Free design (mask = False)")
        layout.addWidget(btn_true)
        layout.addWidget(btn_false)
        layout.addStretch()

        self._annotation_cls = annotation_cls
        self._state = state

        btn_true.clicked.connect(lambda: self._set_mask(True))
        btn_false.clicked.connect(lambda: self._set_mask(False))

    def apply_to_selection(self) -> None:
        self._set_mask(True)


# ---------------------------------------------------------------------------
# CoordinateEditor (custom, for Coordinate condition)
# ---------------------------------------------------------------------------


class CoordinateEditor(_QtWidgets.QWidget, BaseAnnotationEditor):
    """Mask-only editor for the Coordinate condition.

    Toggles the coordinate mask on the selection.  The annotation value
    (which coordinates to condition on) is always taken from the current
    atom coordinates in the array.
    """

    def __init__(
        self, annotation_cls: type[StandardAnnotationBase], state: PluginState, parent: _QtWidgets.QWidget | None = None
    ):
        super().__init__(parent)
        layout = _QtWidgets.QVBoxLayout(self)

        header = _QtWidgets.QLabel("<b>Coordinate Condition</b>")
        layout.addWidget(header)

        desc = _QtWidgets.QLabel(
            "Condition the selected atoms on their current 3D coordinates. "
            "The mask controls whether the model is constrained to place atoms "
            "near their existing positions."
        )
        desc.setWordWrap(True)
        layout.addWidget(desc)

        layout.addSpacing(8)

        btn_true = _QtWidgets.QPushButton("Condition on coordinates (mask = True)")
        btn_false = _QtWidgets.QPushButton("Free design (mask = False)")
        layout.addWidget(btn_true)
        layout.addWidget(btn_false)
        layout.addStretch()

        self._annotation_cls = annotation_cls
        self._state = state

        btn_true.clicked.connect(lambda: self._set_mask(True))
        btn_false.clicked.connect(lambda: self._set_mask(False))

    def apply_to_selection(self) -> None:
        self._set_mask(True)


# ---------------------------------------------------------------------------
# PairValueEditor (for 2-body non-mask, e.g. Distance)
# ---------------------------------------------------------------------------


class PairValueEditor(_QtWidgets.QWidget, BaseAnnotationEditor):
    """Interactive editor for 2-body non-mask annotations (Distance condition).

    Atom picking is driven by a QTimer that polls PyMOL's ``pk1``/``pk2``
    selections.  Click "Select Atom 1", then click any atom in the PyMOL
    3D view — the atom is captured automatically (no manual "Pick" step).
    A single left-click in PyMOL sets ``sele``; ``pk1``/``pk2`` are set by
    ctrl+clicking, but either works since we poll both.
    """

    _POLL_MS = 200  # polling interval in milliseconds

    def __init__(
        self, annotation_cls: type[StandardAnnotationBase], state: PluginState, parent: _QtWidgets.QWidget | None = None
    ):
        super().__init__(parent)

        layout = _QtWidgets.QVBoxLayout(self)

        cls = annotation_cls
        layout.addWidget(_QtWidgets.QLabel(f"<b>{cls.name}</b> — pairwise condition"))

        desc = _QtWidgets.QLabel(
            "Click 'Select Atom N', then left-click an atom in PyMOL. The selection is captured automatically."
        )
        desc.setWordWrap(True)
        layout.addWidget(desc)

        layout.addSpacing(8)

        # Atom 1 row
        a1_row = _QtWidgets.QHBoxLayout()
        self._lbl_atom1 = _QtWidgets.QLabel("Atom 1: —")
        self._btn_pick1 = _QtWidgets.QPushButton("Select Atom 1")
        a1_row.addWidget(self._lbl_atom1, stretch=1)
        a1_row.addWidget(self._btn_pick1)
        layout.addLayout(a1_row)

        # Atom 2 row
        a2_row = _QtWidgets.QHBoxLayout()
        self._lbl_atom2 = _QtWidgets.QLabel("Atom 2: —")
        self._btn_pick2 = _QtWidgets.QPushButton("Select Atom 2")
        a2_row.addWidget(self._lbl_atom2, stretch=1)
        a2_row.addWidget(self._btn_pick2)
        layout.addLayout(a2_row)

        # Value row — spin + "Use actual distance" button
        val_row = _QtWidgets.QHBoxLayout()
        val_row.addWidget(_QtWidgets.QLabel("Value (Å):"))
        self._value_spin = _QtWidgets.QDoubleSpinBox()
        self._value_spin.setRange(0.0, 9999.0)
        self._value_spin.setDecimals(2)
        val_row.addWidget(self._value_spin)
        btn_actual = _QtWidgets.QPushButton("Use actual distance")
        btn_actual.setToolTip("Fill in the Euclidean distance between the two selected atoms.")
        val_row.addWidget(btn_actual)
        layout.addLayout(val_row)

        btn_add = _QtWidgets.QPushButton("Add Pair")
        layout.addWidget(btn_add)

        # Pair table — row selection, no per-row delete buttons
        self._table = _QtWidgets.QTableWidget(0, 3)
        self._table.setHorizontalHeaderLabels(["Atom 1", "Atom 2", "Value (Å)"])
        self._table.horizontalHeader().setStretchLastSection(True)
        self._table.setSelectionBehavior(_QtWidgets.QAbstractItemView.SelectRows)
        self._table.setSelectionMode(_QtWidgets.QAbstractItemView.SingleSelection)
        self._table.setEditTriggers(_QtWidgets.QAbstractItemView.NoEditTriggers)
        layout.addWidget(self._table)

        self._btn_delete_selected = _QtWidgets.QPushButton("Delete Selected")
        self._btn_delete_selected.setEnabled(False)
        layout.addWidget(self._btn_delete_selected)

        btn_clear = _QtWidgets.QPushButton("Clear All")
        btn_apply = _QtWidgets.QPushButton("Apply")
        btn_row = _QtWidgets.QHBoxLayout()
        btn_row.addWidget(btn_clear)
        btn_row.addWidget(btn_apply)
        layout.addLayout(btn_row)

        self._annotation_cls = annotation_cls
        self._state = state
        # Picked atoms and pairs are stored by identity key, not raw row index, alongside
        # the object name and structure version at pick/add time -- this lets a later
        # resolve detect that the structure changed in the meantime, even if the key
        # happens to still be present in the (rebuilt) index map for a *different* atom.
        self._picked: list[tuple[tuple, str, str, int] | None] = [None, None]
        self._pairs: list[tuple[tuple, tuple, float, str, int]] = []
        self._timers: list = [None, None]  # one QTimer per slot
        # PyMOL's mouse_selection_mode while picking is active (picking forces atom mode).
        self._saved_selection_mode: str | None = None

        self._btn_pick1.clicked.connect(lambda: self._toggle_picking(0))
        self._btn_pick2.clicked.connect(lambda: self._toggle_picking(1))
        btn_actual.clicked.connect(self._use_actual_distance)
        btn_add.clicked.connect(self._add_pair)
        self._btn_delete_selected.clicked.connect(self._delete_selected)
        self._table.itemSelectionChanged.connect(self._on_selection_changed)
        btn_clear.clicked.connect(self._clear_all)
        btn_apply.clicked.connect(self.apply_to_selection)

        # Populate from existing annotation so pairs persist across wizard reopens
        self._load_existing_pairs()

    # -- Picking state machine -------------------------------------------

    def _toggle_picking(self, slot: int) -> None:
        if self._timers[slot] is not None:
            self._cancel_picking(slot)
        else:
            self._start_picking(slot)

    def _start_picking(self, slot: int) -> None:
        """Enter picking mode for *slot*.

        Clears PyMOL's ``sele`` selection, then polls every ``_POLL_MS`` ms
        until ``sele`` becomes non-empty (i.e. the user left-clicked an atom).
        Using ``sele`` avoids the console errors that ``pk1``/``pk2`` produce
        when queried before they exist.
        """
        btn = self._btn_pick1 if slot == 0 else self._btn_pick2
        lbl = self._lbl_atom1 if slot == 0 else self._lbl_atom2

        # Clear sele so we can detect the *next* click unambiguously
        cmd.select("sele", "none")
        # A click selects a whole residue in PyMOL's default (residue) mode, so pick atoms.
        if self._saved_selection_mode is None:
            self._saved_selection_mode = cmd.get("mouse_selection_mode")
            cmd.set("mouse_selection_mode", 0)

        btn.setText("Cancel")
        lbl.setText(f"Atom {slot + 1}: left-click an atom in PyMOL…")

        timer = QtCore.QTimer(self)
        timer.setInterval(self._POLL_MS)

        def on_tick() -> None:
            try:
                model = cmd.get_model("sele")
            except Exception:
                return
            if not model.atom:
                return
            if len(model.atom) != 1 or model.atom[0].model != self._state.active:
                cmd.select("sele", "none")
                lbl.setText(f"Atom {slot + 1}: click a single atom of '{self._state.active}'…")
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
        btn = self._btn_pick1 if slot == 0 else self._btn_pick2
        btn.setText(f"Select Atom {slot + 1}")
        lbl = self._lbl_atom1 if slot == 0 else self._lbl_atom2
        if self._picked[slot] is None:
            lbl.setText(f"Atom {slot + 1}: —")

    def _finish_picking(self, slot: int, atom) -> None:
        """Capture *atom* for *slot*, stop the timer, restore button state."""
        self._cancel_picking(slot)

        obj_name = self._state.active
        if not obj_name or obj_name not in self._state.index_maps:
            return

        res_id, ins_code = _pymol_resi_to_res_id_ins_code(atom.resi)
        key = (atom.chain, res_id, ins_code, atom.name)

        lbl = self._lbl_atom1 if slot == 0 else self._lbl_atom2
        if key not in self._state.index_maps[obj_name]:
            lbl.setText(f"Atom {slot + 1}: not found ({atom.chain}{atom.resi} {atom.name})")
            return

        label_str = f"{atom.chain}{atom.resi} {atom.name}"
        self._picked[slot] = (key, label_str, obj_name, self._state.structure_version(obj_name))
        lbl.setText(f"Atom {slot + 1}: {label_str}")

    # -- Value helpers ---------------------------------------------------

    def _resolve_picked(self, obj_name: str) -> tuple[int, int] | None:
        """Resolve both picked atoms' identity keys to current row indices.

        Returns ``None`` if either atom was picked against a different object,
        the structure has since changed (even if the key still resolves --
        it may now belong to a different atom), or the key is simply gone.
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

    def _use_actual_distance(self) -> None:
        """Calculate the Euclidean distance between the two picked atoms and fill the spin."""
        if self._picked[0] is None or self._picked[1] is None:
            return
        obj_name = self._state.active
        if not obj_name or obj_name not in self._state.arrays:
            return
        self._state.get_synced_array(obj_name)
        resolved = self._resolve_picked(obj_name)
        if resolved is None:
            _QtWidgets.QMessageBox.warning(
                self, "Atom not found", "A picked atom no longer exists in the structure -- re-pick it."
            )
            return
        idx1, idx2 = resolved
        distance = self._state.document(obj_name).atom_distance(idx1, idx2)
        if distance is not None:
            self._value_spin.setValue(round(distance, 2))

    # -- Pair management -------------------------------------------------

    def _add_pair(self) -> None:
        if self._picked[0] is None or self._picked[1] is None:
            return
        obj_name = self._state.active
        if not obj_name:
            return
        if self._resolve_picked(obj_name) is None:
            _QtWidgets.QMessageBox.warning(
                self,
                "Structure changed",
                "The structure changed since these atoms were picked -- re-pick them before adding the pair.",
            )
            return
        key1, _, _, version1 = self._picked[0]
        key2, _, _, _ = self._picked[1]
        self._pairs.append((key1, key2, self._value_spin.value(), obj_name, version1))
        self._refresh_table()

    def _refresh_table(self) -> None:
        self._table.setRowCount(len(self._pairs))
        for row, (k1, k2, val, _, _) in enumerate(self._pairs):
            self._table.setItem(row, 0, _QtWidgets.QTableWidgetItem(f"{k1[0]}{k1[1]}{k1[2]} {k1[3]}"))
            self._table.setItem(row, 1, _QtWidgets.QTableWidgetItem(f"{k2[0]}{k2[1]}{k2[2]} {k2[3]}"))
            self._table.setItem(row, 2, _QtWidgets.QTableWidgetItem(f"{val:.2f}"))

    def _on_selection_changed(self) -> None:
        self._btn_delete_selected.setEnabled(bool(self._table.selectedItems()))

    def _delete_selected(self) -> None:
        rows = sorted({idx.row() for idx in self._table.selectedIndexes()}, reverse=True)
        for row in rows:
            if 0 <= row < len(self._pairs):
                self._pairs.pop(row)
        self._refresh_table()
        self._btn_delete_selected.setEnabled(False)

    def _load_existing_pairs(self) -> None:
        """Populate the table from the current annotation so pairs persist across reopens."""
        obj_name = self._state.active
        if not obj_name or obj_name not in self._state.arrays:
            return
        arr = self._state.get_synced_array(obj_name)
        index_map = self._state.index_maps.get(obj_name) or {}
        idx_to_key = {v: k for k, v in index_map.items()}
        version = self._state.structure_version(obj_name)
        try:
            annot = self._annotation_cls.annotation(arr, default="generate")
            if len(annot) == 0:
                return
            for i in range(len(annot)):
                i1, i2 = int(annot.pairs[i, 0]), int(annot.pairs[i, 1])
                if i1 not in idx_to_key or i2 not in idx_to_key:
                    continue
                self._pairs.append((idx_to_key[i1], idx_to_key[i2], float(annot.values[i]), obj_name, version))
            self._refresh_table()
        except Exception:
            logger.debug("Could not restore existing pair annotations", exc_info=True)

    def _clear_all(self) -> None:
        self._pairs.clear()
        self._refresh_table()

    def apply_to_selection(self) -> None:
        obj_name = self._state.active
        if not obj_name or obj_name not in self._state.arrays:
            return
        arr = self._state.get_synced_array(obj_name)
        index_map = self._state.index_maps.get(obj_name) or {}
        current_version = self._state.structure_version(obj_name)

        resolved_pairs = []
        resolved_values = []
        for key1, key2, value, pair_obj_name, pair_version in self._pairs:
            if pair_obj_name != obj_name or pair_version != current_version:
                continue
            idx1 = index_map.get(key1)
            idx2 = index_map.get(key2)
            if idx1 is None or idx2 is None:
                continue
            resolved_pairs.append((idx1, idx2))
            resolved_values.append(value)

        n_skipped = len(self._pairs) - len(resolved_pairs)
        if n_skipped:
            _QtWidgets.QMessageBox.warning(
                self,
                "Some pairs skipped",
                f"{n_skipped} pair(s) referenced an atom that no longer exists in the structure "
                "(likely deleted since it was added) and were skipped. Re-pick and re-add them if still needed.",
            )
        if not resolved_pairs and self._pairs:
            return

        pairs_arr = np.array(resolved_pairs, dtype=int)
        values_arr = np.array(resolved_values, dtype=float)
        from atomworks.ml.conditions import C_DIS

        if self._annotation_cls is C_DIS:
            self._state.document(obj_name).replace_distance_restraints(resolved_pairs, resolved_values)
        else:
            self._annotation_cls.set_annotation(arr, AnnotationList2D(len(arr), pairs=pairs_arr, values=values_arr))
        self._reload_or_recolor(structural_change=True)
