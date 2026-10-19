"""Qt panel for the AtomWorks PyMOL plugin.

Provides:
- :py:func:`open_main_panel` — called from the PyMOL menu.
- :py:class:`MainPanel` — the primary dockable control panel.
- :py:class:`AnnotationWizard` — the annotation/condition editor dialog.
- :py:class:`LoadCIFDialog` — parse-option dialog shown before loading.
- :py:class:`ExpandableSegmentInsertDialog` — expandable segment parameter dialog.
"""

import importlib
import logging
from collections.abc import Callable
from pathlib import Path

import numpy as np
from atomworks.enums import ChainType
from atomworks.io.config import ParseConfig
from atomworks.io.utils.atom_array_plus import AtomArrayPlus
from atomworks.io.utils.io_utils import to_cif_file
from atomworks.ml.conditions import C_CRD, C_DIS, C_IDX, C_SEQ
from atomworks_studio_editing.annotations import has_stored_mask
from atomworks_studio_editing.layout import EDITOR_TABS
from atomworks_studio_editing.loading import LOAD_FIELDS, build_load_config, inspect_import
from atomworks_studio_editing.validation import validate_atom_array_for_save
from atomworks_studio_pymol.bond_wizard import BondWizard
from atomworks_studio_pymol.bridge import (
    combine_visible,
    deletion_would_create_res_id_gap,
    load_structure,
    reload_structure_in_pymol,
    selection_to_indices,
)
from atomworks_studio_pymol.charge_wizard import ChargeWizard
from atomworks_studio_pymol.display import count_hidden_nan_atoms
from atomworks_studio_pymol.editors import editor_for, is_excluded
from atomworks_studio_pymol.extensions import add_extension, read_extensions, remove_extension
from atomworks_studio_pymol.state import STATE, PluginState
from atomworks_studio_pymol.views import (
    DEFAULT_VIEW_NAME,
    VIEWS,
    apply_current_view,
    get_default_view_name,
    set_default_view,
)
from pymol import cmd
from pymol.Qt import QtCore, QtWidgets

logger = logging.getLogger("atomworks_studio_pymol")

# ---------------------------------------------------------------------------
# Hook registries (populated by extensions)
# ---------------------------------------------------------------------------

# Each hook receives the active AtomArrayPlus and returns a list of violation
# strings.  Non-empty lists cause a warning popup before saving.
_pre_save_hooks: list[Callable[[AtomArrayPlus], list[str]]] = []


def register_pre_save_hook(fn: Callable[[AtomArrayPlus], list[str]]) -> None:
    """Register *fn* to be called before each CIF save.

    Hooks must treat the passed array as read-only (the live structure is passed
    for efficiency); copy it before any mutation.
    """
    if fn not in _pre_save_hooks:
        _pre_save_hooks.append(fn)


# Each hook receives the active AtomArrayPlus and returns a formatted summary
# string (empty string means nothing to show for that hook).
_summary_hooks: list[Callable[[AtomArrayPlus], str]] = []


def register_summary_hook(fn: Callable[[AtomArrayPlus], str]) -> None:
    """Register *fn* to contribute to the "Summarize changes" dialog.

    Hooks must treat the passed array as read-only; copy it before any mutation.
    """
    if fn not in _summary_hooks:
        _summary_hooks.append(fn)


# Keep references so garbage collection doesn't destroy the panel or its callbacks
_dock_instance = None
_panel_instance = None


def get_main_panel() -> "MainPanel | None":
    """Return the currently instantiated :py:class:`MainPanel`, or ``None``."""
    return _panel_instance


def _check_atom_array_invariants(arr: AtomArrayPlus) -> list[str]:
    return [f"[{issue['check']}] {issue['message']}" for issue in validate_atom_array_for_save(arr)]


def _builtin_annotation_summary(arr: AtomArrayPlus) -> str:
    """Summarize the atomworks-native conditions the plugin can edit.

    Only conditions actually stored on the array are reported (a derivable
    default that was never set is not counted), so the summary reflects design
    intent rather than structural defaults.
    """
    import biotite.structure as struc

    lines: list[str] = []

    def _residue_count(atom_mask: np.ndarray) -> int:
        return int(atom_mask[struc.get_residue_starts(arr)].sum())

    if has_stored_mask(C_SEQ, arr):
        n = _residue_count(C_SEQ.mask(arr, default="generate"))
        if n > 0:
            lines.append(f"Sequence conditioning: {n} residues")

    if has_stored_mask(C_CRD, arr):
        crd_mask = C_CRD.mask(arr, default="generate")
        if crd_mask.any():
            lines.append(f"Coordinate conditioning: {int(crd_mask.sum())} atoms")

    if has_stored_mask(C_IDX, arr):
        # mask=False means unindexed.
        is_unindexed = ~C_IDX.mask(arr, default="generate")
        if is_unindexed.any():
            lines.append(f"Index conditioning: {int(is_unindexed.sum())} atoms unindexed")

    # 2-body conditions: report the number of stored pairs.
    for condition_cls, label in [(C_DIS, "Distance restraints")]:
        if condition_cls.has_annotation(arr):
            n_pairs = len(condition_cls.annotation(arr, default="generate").values)
            if n_pairs > 0:
                lines.append(f"{label}: {n_pairs} pairs")

    return "\n".join(lines)


# AtomWorks Studio ships a default summary for its own conditions; extensions add their own.
register_summary_hook(_builtin_annotation_summary)


def open_main_panel() -> None:
    """Create (or raise) the AtomWorks dock panel inside PyMOL's main window."""
    global _dock_instance, _panel_instance

    if _dock_instance is not None and _dock_instance.isVisible():
        _dock_instance.raise_()
        return

    _panel_instance = MainPanel(state=STATE)

    # Find PyMOL's QMainWindow so we can dock into it
    app = QtWidgets.QApplication.instance()
    main_win = next(
        (w for w in app.topLevelWidgets() if isinstance(w, QtWidgets.QMainWindow)),
        None,
    )

    dock = QtWidgets.QDockWidget("AtomWorks Studio [BETA]", main_win)
    dock.setWidget(_panel_instance._widget)
    dock.setAllowedAreas(QtCore.Qt.LeftDockWidgetArea | QtCore.Qt.RightDockWidgetArea)
    main_win.addDockWidget(QtCore.Qt.RightDockWidgetArea, dock)
    _dock_instance = dock


# ---------------------------------------------------------------------------
# Load CIF options dialog
# ---------------------------------------------------------------------------


_PRESET_CONFIGS: dict[str, ParseConfig] = {
    "rcsb": build_load_config("rcsb"),
    "minimal_with_annotations": build_load_config("minimal"),
}


class LoadCIFDialog:
    """Choose inferred presets or manual settings before importing a CIF."""

    def __init__(self, parent: QtWidgets.QWidget | None = None):
        self._base_preset = "minimal"
        self._dialog = QtWidgets.QDialog(parent)
        self._dialog.setWindowTitle("Load CIF — Options")
        layout = QtWidgets.QVBoxLayout(self._dialog)

        # ---- Preset selector ----
        layout.addWidget(QtWidgets.QLabel("<b>Parse settings</b>"))
        preset_row = QtWidgets.QHBoxLayout()
        self._preset_group = QtWidgets.QButtonGroup(self._dialog)
        self._preset_group.setExclusive(True)
        self._rb_rcsb = QtWidgets.QRadioButton("Unannotated input")
        self._rb_rcsb.setToolTip("For raw RCSB PDB structures: adds missing heavy atoms, converts MSE→MET, etc. ")
        self._rb_minimal = QtWidgets.QRadioButton("Annotated CIF")
        self._rb_minimal.setToolTip(
            "For CIFs produced by this plugin or models that output annotated CIFs: "
            "loads all StandardAnnotations without adding or modifying atoms."
        )
        self._rb_auto = QtWidgets.QRadioButton("Infer")
        self._rb_manual = QtWidgets.QRadioButton("Custom")
        self._rb_auto.setToolTip("Infer a preset from the file")
        self._rb_auto.setChecked(True)
        self._preset_group.addButton(self._rb_auto)
        self._preset_group.addButton(self._rb_manual)
        preset_row.addWidget(self._rb_auto)
        self._preset_group.addButton(self._rb_rcsb)
        self._preset_group.addButton(self._rb_minimal)
        preset_row.addWidget(self._rb_rcsb)
        preset_row.addWidget(self._rb_minimal)
        preset_row.addWidget(self._rb_manual)
        preset_row.addStretch()
        layout.addLayout(preset_row)

        # ---- File picker ----
        layout.addSpacing(4)
        layout.addWidget(QtWidgets.QLabel("File:"))
        file_row = QtWidgets.QHBoxLayout()
        self._path_edit = QtWidgets.QLineEdit()
        self._path_edit.setPlaceholderText("Select a CIF file…")
        btn_browse = QtWidgets.QPushButton("Browse…")
        file_row.addWidget(self._path_edit)
        file_row.addWidget(btn_browse)
        layout.addLayout(file_row)

        # ---- Object name ----
        layout.addWidget(QtWidgets.QLabel("Object name:"))
        self._name_edit = QtWidgets.QLineEdit()
        self._name_edit.setPlaceholderText("Defaults to the file name")
        self._name_edited_by_user = False
        self._name_edit.textEdited.connect(self._on_name_edited)
        layout.addWidget(self._name_edit)

        # ---- Advanced toggle + panel ----
        layout.addSpacing(4)
        self._btn_advanced = QtWidgets.QPushButton("▸ Show advanced settings")
        self._btn_advanced.setCheckable(True)
        self._btn_advanced.setStyleSheet("text-align: left;")
        layout.addWidget(self._btn_advanced)

        self._advanced = QtWidgets.QWidget()
        adv_layout = QtWidgets.QFormLayout(self._advanced)
        adv_layout.setContentsMargins(12, 4, 4, 4)

        # Bool checkboxes
        self._chk_load_sa = QtWidgets.QCheckBox()
        adv_layout.addRow("load_standard_annotations", self._chk_load_sa)

        self._chk_add_missing = QtWidgets.QCheckBox()
        adv_layout.addRow("add_missing_atoms", self._chk_add_missing)

        self._chk_remove_waters = QtWidgets.QCheckBox()
        adv_layout.addRow("remove_waters", self._chk_remove_waters)

        self._chk_fix_sym = QtWidgets.QCheckBox()
        adv_layout.addRow("fix_ligands_at_symmetry_centers", self._chk_fix_sym)

        self._chk_fix_arg = QtWidgets.QCheckBox()
        adv_layout.addRow("fix_arginines", self._chk_fix_arg)

        self._chk_id_entity = QtWidgets.QCheckBox()
        adv_layout.addRow("add_id_and_entity_annotations", self._chk_id_entity)

        self._chk_mse = QtWidgets.QCheckBox()
        adv_layout.addRow("convert_mse_to_met", self._chk_mse)

        # Literal dropdowns
        self._cmb_long_bond = QtWidgets.QComboBox()
        self._cmb_long_bond.addItems(LOAD_FIELDS["long_bond_policy"]["choices"])
        adv_layout.addRow("long_bond_policy", self._cmb_long_bond)

        self._cmb_struct_conn = QtWidgets.QComboBox()
        self._cmb_struct_conn.addItems(LOAD_FIELDS["struct_conn_distance_policy"]["choices"])
        adv_layout.addRow("struct_conn_distance_policy", self._cmb_struct_conn)

        self._cmb_hydrogen = QtWidgets.QComboBox()
        self._cmb_hydrogen.addItems(["keep", "remove"])
        adv_layout.addRow("hydrogen_policy", self._cmb_hydrogen)

        # build_assembly: specific ID (e.g. "1", "2"), "first", "all", or empty for asym unit
        self._edit_assembly = QtWidgets.QLineEdit()
        self._edit_assembly.setPlaceholderText('Assembly ID (e.g. "1"), "first", "all", or blank for asym unit')
        adv_layout.addRow("build_assembly", self._edit_assembly)

        self._cmb_altloc = QtWidgets.QComboBox()
        self._cmb_altloc.addItems(["first", "random_per_chain", "random_clash_aware"])
        adv_layout.addRow("altloc", self._cmb_altloc)

        # altloc_seed: int | None — checkbox + spinbox
        seed_row = QtWidgets.QHBoxLayout()
        self._chk_seed_none = QtWidgets.QCheckBox("None")
        self._spin_seed = QtWidgets.QSpinBox()
        self._spin_seed.setRange(0, 2**31 - 1)
        self._spin_seed.setValue(0)
        seed_row.addWidget(self._chk_seed_none)
        seed_row.addWidget(self._spin_seed)
        seed_row.addStretch()
        self._chk_seed_none.toggled.connect(lambda c: self._spin_seed.setEnabled(not c))
        seed_wrap = QtWidgets.QWidget()
        seed_wrap.setLayout(seed_row)
        adv_layout.addRow("altloc_seed", seed_wrap)

        # model: int | None — checkbox + spinbox
        model_row = QtWidgets.QHBoxLayout()
        self._chk_all_models = QtWidgets.QCheckBox("All models")
        self._spin_model = QtWidgets.QSpinBox()
        self._spin_model.setRange(0, 9999)
        self._spin_model.setValue(0)
        model_row.addWidget(self._chk_all_models)
        model_row.addWidget(self._spin_model)
        model_row.addStretch()
        self._chk_all_models.toggled.connect(lambda c: self._spin_model.setEnabled(not c))
        model_wrap = QtWidgets.QWidget()
        model_wrap.setLayout(model_row)
        adv_layout.addRow("model", model_wrap)

        # remove_ccds: tuple[str, ...] — comma-separated text
        self._edit_remove_ccds = QtWidgets.QLineEdit()
        self._edit_remove_ccds.setPlaceholderText("Comma-separated CCD codes, e.g. GOL,EDO")
        adv_layout.addRow("remove_ccds", self._edit_remove_ccds)

        self._advanced.setVisible(False)
        layout.addWidget(self._advanced)

        # Warning when load_standard_annotations is off
        self._warning_label = QtWidgets.QLabel(
            "⚠ Loading without standard annotations will wipe all previously-made "
            "annotations (conditions, etc.) saved in this CIF."
        )
        self._warning_label.setWordWrap(True)
        self._warning_label.setStyleSheet("color: red;")
        self._warning_label.setVisible(False)
        layout.addWidget(self._warning_label)

        # ---- OK/Cancel ----
        btns = QtWidgets.QDialogButtonBox(QtWidgets.QDialogButtonBox.Ok | QtWidgets.QDialogButtonBox.Cancel)
        btns.accepted.connect(self._accept)
        btns.rejected.connect(self._dialog.reject)
        layout.addWidget(btns)

        btn_browse.clicked.connect(self._browse)
        self._btn_advanced.toggled.connect(self._on_advanced_toggled)
        self._rb_rcsb.toggled.connect(self._on_preset_changed)
        self._rb_minimal.toggled.connect(self._on_preset_changed)
        self._rb_auto.toggled.connect(self._on_preset_changed)
        self._rb_manual.toggled.connect(self._on_preset_changed)
        self._chk_load_sa.toggled.connect(lambda c: self._warning_label.setVisible(not c))

        # Initial population from default preset
        self._apply_preset(_PRESET_CONFIGS["minimal_with_annotations"])

    def _on_advanced_toggled(self, checked: bool) -> None:
        self._advanced.setVisible(checked)
        if checked:
            self._rb_manual.setChecked(True)
        self._btn_advanced.setText(("▾ Hide" if checked else "▸ Show") + " advanced settings")
        self._dialog.adjustSize()

    def _on_preset_changed(self, checked: bool = True) -> None:
        if not checked:
            return
        if self._rb_manual.isChecked():
            self._btn_advanced.setChecked(True)
            return
        self._btn_advanced.setChecked(False)
        key = "rcsb" if self._rb_rcsb.isChecked() else "minimal_with_annotations"
        self._base_preset = "rcsb" if self._rb_rcsb.isChecked() else "minimal"
        self._apply_preset(_PRESET_CONFIGS[key])

    def _apply_preset(self, cfg: ParseConfig) -> None:
        self._chk_load_sa.setChecked(cfg.load_standard_annotations)
        self._chk_add_missing.setChecked(cfg.add_missing_atoms)
        self._chk_remove_waters.setChecked(cfg.remove_waters)
        self._chk_fix_sym.setChecked(cfg.fix_ligands_at_symmetry_centers)
        self._chk_fix_arg.setChecked(cfg.fix_arginines)
        self._chk_id_entity.setChecked(cfg.add_id_and_entity_annotations)
        self._chk_mse.setChecked(cfg.convert_mse_to_met)

        self._cmb_long_bond.setCurrentText(cfg.long_bond_policy)
        self._cmb_struct_conn.setCurrentText(cfg.struct_conn_distance_policy)
        self._cmb_hydrogen.setCurrentText(cfg.hydrogen_policy)

        if cfg.build_assembly is None:
            self._edit_assembly.setText("")
        elif isinstance(cfg.build_assembly, list | tuple):
            self._edit_assembly.setText(",".join(cfg.build_assembly))
        else:
            self._edit_assembly.setText(str(cfg.build_assembly))

        self._cmb_altloc.setCurrentText(cfg.altloc)

        if cfg.altloc_seed is None:
            self._chk_seed_none.setChecked(True)
            self._spin_seed.setEnabled(False)
        else:
            self._chk_seed_none.setChecked(False)
            self._spin_seed.setEnabled(True)
            self._spin_seed.setValue(cfg.altloc_seed)

        if cfg.model is None:
            self._chk_all_models.setChecked(True)
            self._spin_model.setEnabled(False)
        else:
            self._chk_all_models.setChecked(False)
            self._spin_model.setEnabled(True)
            self._spin_model.setValue(cfg.model)

        self._edit_remove_ccds.setText(",".join(cfg.remove_ccds))

    def _accept(self) -> None:
        try:
            if not Path(self.path).is_file():
                raise ValueError("Choose a CIF file before importing.")
            if self._rb_auto.isChecked():
                inspection = inspect_import(Path(self.path))
                if inspection["preset"] is None:
                    QtWidgets.QMessageBox.warning(self._dialog, "Choose import settings", inspection["message"])
                    return
                radio = self._rb_rcsb if inspection["preset"] == "rcsb" else self._rb_minimal
                radio.setChecked(True)
            _ = self.config  # Validate manual combinations before closing the dialog.
        except Exception as error:
            QtWidgets.QMessageBox.critical(self._dialog, "Cannot import CIF", str(error))
            return
        self._dialog.accept()

    def _browse(self) -> None:
        path, _ = QtWidgets.QFileDialog.getOpenFileName(
            self._dialog, "Select CIF", "", "CIF Files (*.cif *.bcif *.cif.gz);;All Files (*)"
        )
        if path:
            self._path_edit.setText(path)
            if not self._name_edited_by_user:
                from pathlib import Path

                self._name_edit.setText(Path(path).stem)

    def _on_name_edited(self, _text: str) -> None:
        self._name_edited_by_user = True

    def exec_(self) -> bool:
        return self._dialog.exec_() == QtWidgets.QDialog.Accepted

    @property
    def path(self) -> str:
        return self._path_edit.text().strip()

    @property
    def obj_name(self) -> str | None:
        name = self._name_edit.text().strip()
        return name or None

    @property
    def config(self) -> ParseConfig:
        """Return a :py:class:`~atomworks.io.config.ParseConfig` from the current widget state."""
        ccds_text = self._edit_remove_ccds.text().strip()
        remove_ccds = tuple(s.strip() for s in ccds_text.split(",") if s.strip()) if ccds_text else ()

        return build_load_config(
            self._base_preset,
            assembly=self._edit_assembly.text(),
            load_standard_annotations=self._chk_load_sa.isChecked(),
            add_missing_atoms=self._chk_add_missing.isChecked(),
            remove_waters=self._chk_remove_waters.isChecked(),
            fix_ligands_at_symmetry_centers=self._chk_fix_sym.isChecked(),
            fix_arginines=self._chk_fix_arg.isChecked(),
            add_id_and_entity_annotations=self._chk_id_entity.isChecked(),
            convert_mse_to_met=self._chk_mse.isChecked(),
            long_bond_policy=self._cmb_long_bond.currentText(),
            struct_conn_distance_policy=self._cmb_struct_conn.currentText(),
            hydrogen_policy=self._cmb_hydrogen.currentText(),
            altloc=self._cmb_altloc.currentText(),
            altloc_seed=None if self._chk_seed_none.isChecked() else int(self._spin_seed.value()),
            model=None if self._chk_all_models.isChecked() else int(self._spin_model.value()),
            remove_ccds=remove_ccds,
        )


# ---------------------------------------------------------------------------
# Expandable segment insert dialog
# ---------------------------------------------------------------------------


class ExpandableSegmentInsertDialog:
    """Modal dialog for entering expandable segment parameters.

    Supports both in-chain insertion (before/after a selection) and
    insertion as a new standalone chain.
    """

    def __init__(self, parent: QtWidgets.QWidget | None = None, *, default_chain_id: str = ""):
        self._dialog = QtWidgets.QDialog(parent)
        self._dialog.setWindowTitle("Insert Expandable Segment")
        layout = QtWidgets.QVBoxLayout(self._dialog)

        # ---- Min / Max ----
        layout.addWidget(QtWidgets.QLabel("Expandable segment parameters:"))

        min_row = QtWidgets.QHBoxLayout()
        min_row.addWidget(QtWidgets.QLabel("Min length:"))
        self._min_spin = QtWidgets.QSpinBox()
        self._min_spin.setRange(0, 9999)
        self._min_spin.setValue(0)
        min_row.addWidget(self._min_spin)
        layout.addLayout(min_row)

        max_row = QtWidgets.QHBoxLayout()
        max_row.addWidget(QtWidgets.QLabel("Max length:"))
        self._max_spin = QtWidgets.QSpinBox()
        self._max_spin.setRange(0, 9999)
        self._max_spin.setValue(10)
        max_row.addWidget(self._max_spin)
        layout.addLayout(max_row)

        layout.addSpacing(4)

        # ---- New chain toggle ----
        self._new_chain_chk = QtWidgets.QCheckBox("Insert as new chain")
        layout.addWidget(self._new_chain_chk)

        # ---- In-chain options (hidden when new_chain is checked) ----
        self._before_chk = QtWidgets.QCheckBox("Insert before selection (default: after)")
        layout.addWidget(self._before_chk)

        # ---- New-chain options (hidden when new_chain is unchecked) ----
        self._new_chain_group = QtWidgets.QWidget()
        nc_layout = QtWidgets.QVBoxLayout(self._new_chain_group)
        nc_layout.setContentsMargins(0, 0, 0, 0)

        chain_id_row = QtWidgets.QHBoxLayout()
        chain_id_row.addWidget(QtWidgets.QLabel("Chain ID:"))
        self._chain_id_edit = QtWidgets.QLineEdit()
        self._chain_id_edit.setText(default_chain_id)
        self._chain_id_edit.setMaximumWidth(60)
        chain_id_row.addWidget(self._chain_id_edit)
        chain_id_row.addStretch()
        nc_layout.addLayout(chain_id_row)

        chain_type_row = QtWidgets.QHBoxLayout()
        chain_type_row.addWidget(QtWidgets.QLabel("Chain type:"))
        self._chain_type_combo = QtWidgets.QComboBox()
        for ct in ChainType:
            self._chain_type_combo.addItem(ct.to_mmcif_string(), ct)
        default_idx = next(
            (
                i
                for i in range(self._chain_type_combo.count())
                if self._chain_type_combo.itemData(i) == ChainType.POLYPEPTIDE_L
            ),
            0,
        )
        self._chain_type_combo.setCurrentIndex(default_idx)
        chain_type_row.addWidget(self._chain_type_combo)
        nc_layout.addLayout(chain_type_row)

        self._new_chain_group.setVisible(False)
        layout.addWidget(self._new_chain_group)

        btns = QtWidgets.QDialogButtonBox(QtWidgets.QDialogButtonBox.Ok | QtWidgets.QDialogButtonBox.Cancel)
        btns.accepted.connect(self._dialog.accept)
        btns.rejected.connect(self._dialog.reject)
        layout.addWidget(btns)

        self._new_chain_chk.toggled.connect(self._on_new_chain_toggled)

    def _on_new_chain_toggled(self, checked: bool) -> None:
        self._before_chk.setVisible(not checked)
        self._new_chain_group.setVisible(checked)

    def exec_(self) -> bool:
        return self._dialog.exec_() == QtWidgets.QDialog.Accepted

    @property
    def seg_min(self) -> int:
        return self._min_spin.value()

    @property
    def seg_max(self) -> int:
        return self._max_spin.value()

    @property
    def insert_before(self) -> bool:
        return self._before_chk.isChecked()

    @property
    def new_chain(self) -> bool:
        return self._new_chain_chk.isChecked()

    @property
    def new_chain_id(self) -> str:
        return self._chain_id_edit.text().strip()

    @property
    def new_chain_type(self) -> ChainType:
        return self._chain_type_combo.currentData()


# ---------------------------------------------------------------------------
# Main panel
# ---------------------------------------------------------------------------


class MainPanel:
    """Primary AtomWorks plugin panel (QWidget wrapper).

    Displays load/save controls, the active-object selector, combine-visible,
    and a button to open the Annotation Wizard. Designed to live inside a
    QDockWidget docked to PyMOL's main window.
    """

    def __init__(self, state: PluginState, parent: QtWidgets.QWidget | None = None):
        self._state = state
        self._widget = QtWidgets.QWidget(parent)
        self._widget.setMinimumWidth(320)

        root_layout = QtWidgets.QVBoxLayout(self._widget)

        tabs = QtWidgets.QTabWidget()
        root_layout.addWidget(tabs)

        # ---- Main tab ----
        main_widget = QtWidgets.QWidget()
        layout = QtWidgets.QVBoxLayout(main_widget)

        # Active object selector
        active_row = QtWidgets.QHBoxLayout()
        active_row.addWidget(QtWidgets.QLabel("Active:"))
        self._active_combo = QtWidgets.QComboBox()
        active_row.addWidget(self._active_combo, stretch=1)
        layout.addLayout(active_row)

        layout.addSpacing(4)

        # Load
        load_btn = QtWidgets.QPushButton("Load CIF...")
        layout.addWidget(load_btn)

        layout.addSpacing(4)

        # Combine / Save
        combine_row = QtWidgets.QHBoxLayout()
        combine_row.addWidget(QtWidgets.QLabel("Combine visible →"))
        self._combine_name = QtWidgets.QLineEdit("combined")
        self._combine_name.setMaximumWidth(120)
        combine_row.addWidget(self._combine_name)
        btn_combine = QtWidgets.QPushButton("Go")
        combine_row.addWidget(btn_combine)
        layout.addLayout(combine_row)

        save_btn = QtWidgets.QPushButton("Save Active As...")
        layout.addWidget(save_btn)

        util_row = QtWidgets.QHBoxLayout()
        summarize_btn = QtWidgets.QPushButton("Summarize changes")
        summarize_btn.setToolTip("Show a summary of all non-default annotations on the active structure.")
        clear_btn = QtWidgets.QPushButton("Clear Session")
        clear_btn.setToolTip("Delete all tracked structures and fully reset plugin state.")
        util_row.addWidget(summarize_btn)
        util_row.addWidget(clear_btn)
        reset_conditions_btn = QtWidgets.QPushButton("Reset conditions to defaults")
        reset_conditions_btn.setToolTip("Reset all conditions on the active structure. Undo restores them.")
        layout.addWidget(reset_conditions_btn)
        layout.addLayout(util_row)

        layout.addSpacing(4)

        # Expandable segments & Delete
        gap_btn = QtWidgets.QPushButton("Insert Expandable Segment...")
        reset_res_id_btn = QtWidgets.QPushButton("Reset Res ID")
        reset_res_id_btn.setToolTip(
            "Re-index residues per chain_iid so the first residue in each chain "
            "starts at 1 (subtracts min(res_id) - 1 from every atom in the chain)."
        )
        delete_btn = QtWidgets.QPushButton("Delete selection")
        undo_btn = QtWidgets.QPushButton("Undo")
        layout.addWidget(gap_btn)
        layout.addWidget(reset_res_id_btn)
        layout.addWidget(delete_btn)
        layout.addWidget(undo_btn)

        layout.addSpacing(4)

        # Views section: exclusive toggle buttons (selected = default view)
        layout.addWidget(QtWidgets.QLabel("<b>Views</b>"))
        self._views_container = QtWidgets.QWidget()
        self._views_container_layout = QtWidgets.QVBoxLayout(self._views_container)
        self._views_container_layout.setContentsMargins(0, 0, 0, 0)
        layout.addWidget(self._views_container)
        self._view_button_group = QtWidgets.QButtonGroup(self._widget)
        self._view_button_group.setExclusive(True)

        nan_row = QtWidgets.QHBoxLayout()
        self._hide_nans_checkbox = QtWidgets.QCheckBox("Hide NaN atoms")
        self._hide_nans_checkbox.setChecked(self._state.hide_nans)
        self._hide_nans_checkbox.setToolTip(
            "When checked, atoms with NaN coordinates are dropped from the PyMOL view. "
            "When unchecked, NaN coordinates are zeroed out so the atoms still render "
            "(stacked at the origin)."
        )
        nan_row.addWidget(self._hide_nans_checkbox)
        self._nan_label = QtWidgets.QLabel("")
        self._nan_label.setStyleSheet("color: gray; font-size: 11px;")
        nan_row.addWidget(self._nan_label)
        nan_row.addStretch()
        layout.addLayout(nan_row)

        seq_gaps_row = QtWidgets.QHBoxLayout()
        self._show_seq_gaps_checkbox = QtWidgets.QCheckBox("Show seq-viewer gaps")
        self._show_seq_gaps_checkbox.setChecked(self._state.show_seq_gaps)
        self._show_seq_gaps_checkbox.setToolTip(
            "When checked, writes _entity_poly_seq into the CIF handed to PyMOL "
            "so the sequence viewer shows gaps for unresolved residues. "
            "Off by default — for structures whose chains share an entity but "
            "have divergent per-chain residue layouts (e.g. designed/generated "
            "CIFs with flexible residue indexing), this causes grayed-out ghost "
            "residues, duplicate-position rendering, and missing polymer bonds."
        )
        seq_gaps_row.addWidget(self._show_seq_gaps_checkbox)
        seq_gaps_row.addStretch()
        layout.addLayout(seq_gaps_row)

        reload_btn = QtWidgets.QPushButton("Reload AtomArray")
        reload_btn.setToolTip("Reload the active structure and re-apply the selected view")
        layout.addWidget(reload_btn)

        layout.addSpacing(4)

        extensions_btn = QtWidgets.QPushButton("Extensions...")
        extensions_btn.setToolTip("Manage AtomWorks Studio PyMOL editor extensions")
        layout.addWidget(extensions_btn)

        layout.addStretch()

        # ---- Annotations tab ----
        self._annotation_wizard = AnnotationWizard(state)

        # ---- Structure tab ----
        self._charge_wizard = ChargeWizard(state)
        self._bond_wizard = BondWizard(state)
        structure_widget = QtWidgets.QWidget()
        structure_layout = QtWidgets.QVBoxLayout(structure_widget)
        structure_layout.addWidget(QtWidgets.QLabel("<b>Charges</b>"))
        self._charge_wizard.widget.setSizePolicy(QtWidgets.QSizePolicy.Preferred, QtWidgets.QSizePolicy.Maximum)
        structure_layout.addWidget(self._charge_wizard.widget)
        structure_layout.addWidget(QtWidgets.QLabel("<b>Bonds</b>"))
        structure_layout.addWidget(self._bond_wizard.widget)
        structure_scroll = QtWidgets.QScrollArea()
        structure_scroll.setWidgetResizable(True)
        structure_scroll.setWidget(structure_widget)

        tab_widgets = {
            "main": main_widget,
            "annotations": self._annotation_wizard.widget,
            "structure": structure_scroll,
        }
        for key, label in EDITOR_TABS:
            tabs.addTab(tab_widgets[key], label)

        # ---- Connections ----
        load_btn.clicked.connect(self._load_cif)
        btn_combine.clicked.connect(self._combine_visible)
        save_btn.clicked.connect(self._save_active)
        summarize_btn.clicked.connect(self._summarize_changes)
        clear_btn.clicked.connect(self._clear_session)
        reset_conditions_btn.clicked.connect(self._reset_conditions)
        gap_btn.clicked.connect(self._insert_expandable_segment)
        reset_res_id_btn.clicked.connect(self._reset_res_id)
        delete_btn.clicked.connect(self._delete_selection)
        undo_btn.clicked.connect(self._undo)
        reload_btn.clicked.connect(self._reload_visualization)
        extensions_btn.clicked.connect(self._open_extensions)
        self._active_combo.activated.connect(self._on_active_changed)
        self._hide_nans_checkbox.toggled.connect(self._on_hide_nans_toggled)
        self._show_seq_gaps_checkbox.toggled.connect(self._on_show_seq_gaps_toggled)

        self._refresh_active_combo()
        self.refresh_views()

    # -- UI actions --------------------------------------------------------

    def _refresh_active_combo(self) -> None:
        self._active_combo.blockSignals(True)
        self._active_combo.clear()
        for name in self._state.arrays:
            self._active_combo.addItem(name)
        if self._state.active:
            idx = self._active_combo.findText(self._state.active)
            if idx >= 0:
                self._active_combo.setCurrentIndex(idx)
        self._active_combo.blockSignals(False)
        self._refresh_nan_label()

    def _refresh_nan_label(self) -> None:
        array = self._state.active_array()
        if array is None or len(array) == 0:
            self._nan_label.setText("")
            return
        n = count_hidden_nan_atoms(array)
        verb = "Hidden" if self._state.hide_nans else "Zeroed"
        self._nan_label.setText(f"{verb} NaN-coord atoms: {n}")

    def _on_active_changed(self, index: int) -> None:
        name = self._active_combo.itemText(index)
        if name:
            self._state.active = name
            self._refresh_nan_label()

    def _on_hide_nans_toggled(self, checked: bool) -> None:
        self._state.hide_nans = checked
        self._refresh_nan_label()
        obj_name = self._state.active
        if obj_name and obj_name in self._state.arrays:
            self._state.get_synced_array(obj_name)
            reload_structure_in_pymol(obj_name)

    def _on_show_seq_gaps_toggled(self, checked: bool) -> None:
        self._state.show_seq_gaps = checked
        obj_name = self._state.active
        if obj_name and obj_name in self._state.arrays:
            self._state.get_synced_array(obj_name)
            reload_structure_in_pymol(obj_name)

    def _load_cif(self) -> None:
        dlg = LoadCIFDialog(self._widget)
        if not dlg.exec_():
            return
        if not dlg.path:
            QtWidgets.QMessageBox.warning(self._widget, "No file selected", "Please select a CIF file.")
            return
        try:
            load_structure(dlg.path, config=dlg.config, obj_name=dlg.obj_name)
        except Exception as e:
            QtWidgets.QMessageBox.critical(self._widget, "Load Error", str(e))
        self._refresh_active_combo()

    def _save_active(self) -> None:
        obj_name = self._state.active
        if not obj_name or obj_name not in self._state.arrays:
            QtWidgets.QMessageBox.warning(self._widget, "No active object", "Load a structure first.")
            return
        path, _ = QtWidgets.QFileDialog.getSaveFileName(
            self._widget, "Save CIF", f"{obj_name}.cif", "CIF Files (*.cif);;All Files (*)"
        )
        if not path:
            return

        arr = self._state.get_synced_array(obj_name)
        violations: list[str] = _check_atom_array_invariants(arr)
        for hook in _pre_save_hooks:
            try:
                violations.extend(hook(arr.copy()))
            except Exception as e:
                violations.append(f"[hook_error] {e}")

        if violations:
            msg = "Validation issues found:\n\n" + "\n".join(f"• {v}" for v in violations)
            msg += "\n\nSave anyway?"
            reply = QtWidgets.QMessageBox.warning(
                self._widget,
                "Validation Issues",
                msg,
                QtWidgets.QMessageBox.Yes | QtWidgets.QMessageBox.No,
            )
            if reply != QtWidgets.QMessageBox.Yes:
                return

        try:
            to_cif_file(arr, path, save_standard_annotations=True, chain_disambiguation="chain_iid")
        except Exception as e:
            QtWidgets.QMessageBox.critical(self._widget, "Save Error", str(e))

    def _reset_conditions(self) -> None:
        obj_name = self._state.active
        if not obj_name:
            return
        self._state.get_synced_array(obj_name)
        try:
            self._state.document(obj_name).reset_conditions()
        except Exception as error:
            QtWidgets.QMessageBox.warning(self._widget, "Condition reset failed", str(error))
            return
        cmd.deselect()
        reload_structure_in_pymol(obj_name)

    def _clear_session(self) -> None:
        reply = QtWidgets.QMessageBox.question(
            self._widget,
            "Clear Session",
            "This will delete ALL objects and selections from PyMOL and fully reset the plugin. Continue?",
            QtWidgets.QMessageBox.Yes | QtWidgets.QMessageBox.No,
        )
        if reply != QtWidgets.QMessageBox.Yes:
            return
        cmd.delete("all")
        self._state.clear_all()
        self._state.hide_nans = True
        self._state.show_seq_gaps = False
        set_default_view(DEFAULT_VIEW_NAME)
        self._hide_nans_checkbox.setChecked(True)
        self._show_seq_gaps_checkbox.setChecked(False)
        self._refresh_active_combo()
        self.refresh_views()

    def _summarize_changes(self) -> None:
        obj_name = self._state.active
        if not obj_name or obj_name not in self._state.arrays:
            QtWidgets.QMessageBox.information(self._widget, "No active object", "Load a structure first.")
            return
        arr = self._state.get_synced_array(obj_name)
        sections: list[str] = []
        for hook in _summary_hooks:
            try:
                section = hook(arr.copy())
                if section and section.strip():
                    sections.append(section)
            except Exception as e:
                logger.warning("Summary hook %s failed: %s", hook, e)
        text = "\n\n".join(sections) if sections else "No non-default annotations found."
        dlg = QtWidgets.QDialog(self._widget)
        dlg.setWindowTitle("Annotation Summary")
        dlg_layout = QtWidgets.QVBoxLayout(dlg)
        te = QtWidgets.QTextEdit()
        te.setReadOnly(True)
        te.setPlainText(text)
        dlg_layout.addWidget(te)
        close_btns = QtWidgets.QDialogButtonBox(QtWidgets.QDialogButtonBox.Close)
        close_btns.rejected.connect(dlg.reject)
        dlg_layout.addWidget(close_btns)
        dlg.resize(500, 400)
        dlg.exec_()

    def _combine_visible(self) -> None:
        new_name = self._combine_name.text().strip() or "combined"
        allow_overwrite = False
        if new_name in self._state.arrays:
            reply = QtWidgets.QMessageBox.question(
                self._widget,
                "Name Already In Use",
                f"'{new_name}' is already a tracked structure. Combining into this name will "
                "permanently replace it, and any existing undo history for it will no longer "
                "apply.\n\nContinue?",
                QtWidgets.QMessageBox.Yes | QtWidgets.QMessageBox.Cancel,
            )
            if reply != QtWidgets.QMessageBox.Yes:
                return
            allow_overwrite = True
        try:
            combine_visible(new_name, allow_overwrite=allow_overwrite)
        except Exception as e:
            QtWidgets.QMessageBox.critical(self._widget, "Combine Error", str(e))
        self._refresh_active_combo()

    def _insert_expandable_segment(self) -> None:
        obj_name = self._state.active
        if not obj_name or obj_name not in self._state.arrays:
            QtWidgets.QMessageBox.warning(self._widget, "No active object", "Load a structure first.")
            return

        dlg = ExpandableSegmentInsertDialog(
            self._widget, default_chain_id=self._state.document(obj_name).next_chain_id()
        )
        if not dlg.exec_():
            return

        try:
            document = self._state.document(obj_name)
            if dlg.new_chain:
                document.insert_segment(
                    dlg.seg_min,
                    dlg.seg_max,
                    new_chain=True,
                    chain_id=dlg.new_chain_id,
                    chain_type=dlg.new_chain_type,
                )
            else:
                indices = selection_to_indices("sele", self._state.index_maps[obj_name])
                if not indices:
                    QtWidgets.QMessageBox.warning(self._widget, "No selection", "Make a selection in PyMOL first.")
                    return
                document.insert_segment(
                    dlg.seg_min,
                    dlg.seg_max,
                    int(indices[0] if dlg.insert_before else indices[-1]),
                    before=dlg.insert_before,
                )
            self._state.set_array(obj_name, document.array)
        except Exception as e:
            QtWidgets.QMessageBox.critical(self._widget, "Segment Insert Error", str(e))
            return

        reload_structure_in_pymol(obj_name)

    def _reset_res_id(self) -> None:
        obj_name = self._state.active
        if not obj_name or obj_name not in self._state.arrays:
            QtWidgets.QMessageBox.warning(self._widget, "No active object", "Load a structure first.")
            return

        arr = self._state.get_synced_array(obj_name)
        if "chain_iid" not in arr.get_annotation_categories():
            QtWidgets.QMessageBox.warning(
                self._widget, "Missing chain_iid", "Active array has no chain_iid annotation."
            )
            return

        self._state.document(obj_name).reset_residue_ids()
        reload_structure_in_pymol(obj_name)

    def _delete_selection(self) -> None:
        obj_name = self._state.active
        if not obj_name or obj_name not in self._state.arrays:
            QtWidgets.QMessageBox.warning(self._widget, "No active object", "Load a structure first.")
            return

        indices = selection_to_indices("sele", self._state.index_maps[obj_name])
        if not indices:
            QtWidgets.QMessageBox.warning(self._widget, "No selection", "Make a selection in PyMOL first.")
            return

        arr = self._state.get_synced_array(obj_name)
        keep = np.ones(len(arr), dtype=bool)
        keep[indices] = False

        close_gaps = False
        if deletion_would_create_res_id_gap(arr, keep):
            reply = QtWidgets.QMessageBox.question(
                self._widget,
                "Residue Numbering",
                "Deleting this selection will leave a gap in residue numbering (res_id) "
                "for one or more chains.\n\nRes_id gaps are shown to the model as chain "
                "breaks, so keep the gap only if a break is desired here. Otherwise the "
                "remaining residues can be renumbered to close it.\n\nKeep the res_id gap?",
                QtWidgets.QMessageBox.Yes | QtWidgets.QMessageBox.No | QtWidgets.QMessageBox.Cancel,
                QtWidgets.QMessageBox.Yes,
            )
            if reply == QtWidgets.QMessageBox.Cancel:
                return
            close_gaps = reply == QtWidgets.QMessageBox.No

        try:
            document = self._state.document(obj_name)
            document.delete_atoms(indices, close_residue_gaps=close_gaps)
            self._state.set_array(obj_name, document.array)
        except Exception as e:
            QtWidgets.QMessageBox.critical(self._widget, "Delete Error", str(e))
            return
        reload_structure_in_pymol(obj_name)

    def _undo(self) -> None:
        obj_name = self._state.active
        if not obj_name:
            return
        snapshot = self._state.pop_snapshot(obj_name)
        if snapshot is None:
            QtWidgets.QMessageBox.information(self._widget, "Undo", "Nothing to undo.")
            return

        reload_structure_in_pymol(obj_name)

    def _reload_visualization(self) -> None:
        obj_name = self._state.active
        if not obj_name or obj_name not in self._state.arrays:
            QtWidgets.QMessageBox.warning(self._widget, "No active object", "Load a structure first.")
            return
        self._state.get_synced_array(obj_name)
        reload_structure_in_pymol(obj_name)

    def _open_extensions(self) -> None:
        self._extensions_dialog = ExtensionsDialog(parent=self._widget)
        self._extensions_dialog.show()

    # -- Views -------------------------------------------------------------

    def refresh_views(self) -> None:
        """Rebuild the view toggle buttons from the registry.

        The currently-selected toggle is the default view — i.e. the one
        applied by ``reload_structure_in_pymol``. Clicking a toggle switches
        the default and immediately applies that view to the active object.
        """
        # Remove existing buttons from the button group, then clear the container.
        # Buttons live inside nested QHBoxLayout rows, so clearing must recurse:
        # takeAt(0).widget() is None for a nested layout, which previously left the
        # old buttons alive (still parented to the container) so they piled up and
        # overlapped on every rebuild (e.g. after Clear Session).
        for btn in list(self._view_button_group.buttons()):
            self._view_button_group.removeButton(btn)

        def _clear_layout(layout: QtWidgets.QLayout) -> None:
            while layout.count():
                item = layout.takeAt(0)
                w = item.widget()
                if w is not None:
                    w.deleteLater()
                    continue
                child = item.layout()
                if child is not None:
                    _clear_layout(child)
                    child.deleteLater()

        _clear_layout(self._views_container_layout)

        current_default = get_default_view_name()
        row: QtWidgets.QHBoxLayout | None = None
        for i, name in enumerate(VIEWS):
            if i % 2 == 0:
                row = QtWidgets.QHBoxLayout()
                self._views_container_layout.addLayout(row)
            btn = QtWidgets.QPushButton(name)
            btn.setCheckable(True)
            if name == current_default:
                btn.setChecked(True)
            self._view_button_group.addButton(btn)
            btn.clicked.connect(lambda _=False, n=name: self._select_view(n))
            row.addWidget(btn)

        self._refresh_nan_label()

    def _select_view(self, name: str) -> None:
        """Set *name* as the default view and apply it to the active object."""
        try:
            set_default_view(name)
        except KeyError:
            return
        obj_name = self._state.active
        if not obj_name or obj_name not in self._state.arrays:
            return
        try:
            apply_current_view(self._state.get_synced_array(obj_name), obj_name)
        except Exception as e:
            QtWidgets.QMessageBox.critical(self._widget, f"View '{name}' failed", str(e))


# ---------------------------------------------------------------------------
# Annotation Wizard
# ---------------------------------------------------------------------------


class AnnotationWizard:
    """Dialog for browsing and editing all registered annotations and conditions.

    Layout:
    - Left: searchable list of all annotations and conditions.
    - Right: annotation-specific editor panel (swapped on selection).
    """

    def __init__(self, state: PluginState, parent: QtWidgets.QWidget | None = None):
        self._state = state
        self._widget = QtWidgets.QWidget(parent)
        self._widget.setWindowTitle("AtomWorks — Annotation Wizard")

        outer = QtWidgets.QHBoxLayout(self._widget)

        # ---- Left panel ----
        left = QtWidgets.QVBoxLayout()

        self._search = QtWidgets.QLineEdit()
        self._search.setPlaceholderText("Search conditions...")
        left.addWidget(self._search)

        self._list = QtWidgets.QListWidget()
        self._list.setMinimumWidth(120)
        left.addWidget(self._list)

        outer.addLayout(left)

        # ---- Right panel ----
        self._right_stack = QtWidgets.QStackedWidget()
        outer.addWidget(self._right_stack)

        # Populate list
        self._annotation_classes: list = []
        self._populate_list()

        self._list.currentRowChanged.connect(self._on_item_selected)
        self._search.textChanged.connect(self._filter_list)

        if self._list.count() > 0:
            self._list.setCurrentRow(0)

    @property
    def widget(self) -> object:
        """Return the inner QWidget for embedding in a tab or dock."""
        return self._widget

    def show(self) -> None:
        """Show the wizard as a floating window."""
        self._widget.show()
        self._widget.raise_()
        self._widget.activateWindow()

    def _populate_list(self) -> None:
        self._list.clear()
        self._annotation_classes.clear()

        # Conditions group
        header_item = QtWidgets.QListWidgetItem("── Conditions ──")
        header_item.setFlags(QtCore.Qt.NoItemFlags)
        self._list.addItem(header_item)
        self._annotation_classes.append(None)

        listed_groups = set()
        for definition in self._state.condition_provider.definitions:
            cls = definition.condition
            if not definition.visible or is_excluded(cls):
                continue
            if definition.editor_group:
                if definition.editor_group in listed_groups:
                    continue
                listed_groups.add(definition.editor_group)
            self._list.addItem(definition.editor_group or definition.label)
            self._annotation_classes.append(cls)

    def _filter_list(self, text: str) -> None:
        text = text.lower()
        for i in range(self._list.count()):
            item = self._list.item(i)
            cls = self._annotation_classes[i]
            if cls is None:
                # Group headers are always visible
                item.setHidden(False)
            else:
                item.setHidden(text not in cls.name.lower() and text not in item.text().lower())

    def _on_item_selected(self, row: int) -> None:
        if row < 0 or row >= len(self._annotation_classes):
            return
        cls = self._annotation_classes[row]
        if cls is None:
            return  # group header

        try:
            editor_cls = editor_for(cls)
            editor = editor_cls(cls, self._state)
        except Exception as e:
            logger.warning("Could not create editor for %s: %s", cls.name, e)
            placeholder = QtWidgets.QLabel(f"Editor unavailable: {e}")
            placeholder.setWordWrap(True)
            self._right_stack.addWidget(placeholder)
            self._right_stack.setCurrentWidget(placeholder)
            return

        # Remove old widget from stack to prevent accumulation
        while self._right_stack.count() > 0:
            w = self._right_stack.widget(0)
            self._right_stack.removeWidget(w)
            w.deleteLater()

        self._right_stack.addWidget(editor)
        self._right_stack.setCurrentWidget(editor)


class ExtensionsDialog:
    """Manage persistent AtomWorks Studio PyMOL editor extensions."""

    def __init__(self, parent: QtWidgets.QWidget | None = None):
        self._dialog = QtWidgets.QDialog(parent)
        self._dialog.setWindowTitle("AtomWorks Studio - Extensions")
        self._dialog.setMinimumWidth(480)
        layout = QtWidgets.QVBoxLayout(self._dialog)

        layout.addWidget(QtWidgets.QLabel("<b>Registered editor extensions</b>"))
        self._list = QtWidgets.QListWidget()
        layout.addWidget(self._list)

        add_row = QtWidgets.QHBoxLayout()
        self._add_edit = QtWidgets.QLineEdit()
        self._add_edit.setPlaceholderText("e.g. atomworks_studio_rfd4.pymol.editors")
        self._btn_add = QtWidgets.QPushButton("Add")
        add_row.addWidget(self._add_edit, stretch=1)
        add_row.addWidget(self._btn_add)
        layout.addLayout(add_row)

        self._btn_remove = QtWidgets.QPushButton("Remove selected")
        self._btn_remove.setEnabled(False)
        layout.addWidget(self._btn_remove)

        self._status = QtWidgets.QLabel("")
        self._status.setWordWrap(True)
        layout.addWidget(self._status)

        close_btn = QtWidgets.QDialogButtonBox(QtWidgets.QDialogButtonBox.Close)
        close_btn.rejected.connect(self._dialog.accept)
        layout.addWidget(close_btn)

        self._btn_add.clicked.connect(self._add)
        self._btn_remove.clicked.connect(self._remove)
        self._list.itemSelectionChanged.connect(lambda: self._btn_remove.setEnabled(bool(self._list.selectedItems())))
        self._refresh()

    def show(self) -> None:
        """Show the dialog as a non-modal window."""
        self._dialog.show()
        self._dialog.raise_()
        self._dialog.activateWindow()

    def _refresh(self) -> None:
        self._list.clear()
        for module in read_extensions():
            try:
                importlib.import_module(module)
                label = f"{module}  [available]"
                color = QtCore.Qt.darkGreen
            except ImportError:
                label = f"{module}  [not found]"
                color = QtCore.Qt.red
            item = QtWidgets.QListWidgetItem(label)
            item.setData(QtCore.Qt.UserRole, module)
            item.setForeground(color)
            self._list.addItem(item)

    def _add(self) -> None:
        module = self._add_edit.text().strip()
        if not module:
            self._status.setText("Enter a Python module path.")
            return

        try:
            extension = importlib.import_module(module)
        except ImportError as error:
            self._status.setText(f"Cannot import '{module}': {error}")
            return

        if not callable(getattr(extension, "register", None)):
            self._status.setText(f"'{module}' has no register() function.")
            return

        if add_extension(module):
            try:
                extension.register()
                self._status.setText(f"Registered and activated '{module}'.")
            except Exception as error:
                self._status.setText(f"Registered '{module}' but register() raised: {error}")
            panel = get_main_panel()
            if panel is not None:
                panel.refresh_views()
        else:
            self._status.setText(f"'{module}' is already registered.")

        self._add_edit.clear()
        self._refresh()

    def _remove(self) -> None:
        item = self._list.currentItem()
        if item is None:
            return
        module = item.data(QtCore.Qt.UserRole)
        remove_extension(module)
        self._status.setText(f"Removed '{module}'. Takes effect on next PyMOL launch.")
        self._refresh()
