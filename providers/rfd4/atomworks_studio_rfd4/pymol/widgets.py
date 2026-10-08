"""Custom PyMOL editor widgets for rfproteina conditions.

Only ever imported inside a running PyMOL process via
:py:func:`atomworks_studio_rfd4.pymol.editors.register`.
Qt imports at module level are intentional and safe here.
"""

from atomworks.io.utils.standard_annotations.base import StandardAnnotationBase
from atomworks_studio_pymol.editors.widgets import BaseAnnotationEditor
from atomworks_studio_pymol.state import PluginState
from pymol.Qt import QtWidgets

from atomworks_studio_rfd4 import CONDITION_PROVIDER

# ---------------------------------------------------------------------------
# ValueButtonEditor — one button per named value
# ---------------------------------------------------------------------------


class ValueButtonEditor(QtWidgets.QWidget, BaseAnnotationEditor):
    """Editor for integer-valued conditions using one button per named value.

    Each button sets the annotation value for the current PyMOL selection.

    Args:
        annotation_cls: The annotation class to edit.
        state: Plugin state singleton.
        named_values: Sequence of ``(label, int_value)`` pairs, one button each.
        null_value: If provided, setting this value also sets mask=False;
            all other values set mask=True.  Pass ``None`` to skip mask updates
            (e.g. for annotations whose mask is always all-True).
    """

    def __init__(
        self,
        annotation_cls: type[StandardAnnotationBase],
        state: PluginState,
        named_values: list[tuple[str, int]],
        null_value: int | None = None,
        parent: QtWidgets.QWidget | None = None,
    ):
        super().__init__(parent)
        layout = QtWidgets.QVBoxLayout(self)

        cls = annotation_cls
        header = QtWidgets.QLabel(f"<b>{cls.name}</b> &nbsp; <i>(level: {cls.level})</i>")
        header.setWordWrap(True)
        layout.addWidget(header)

        if cls.__doc__:
            doc = QtWidgets.QLabel(cls.__doc__.strip().split("\n")[0])
            doc.setWordWrap(True)
            layout.addWidget(doc)

        layout.addSpacing(8)

        for label, value in named_values:
            btn = QtWidgets.QPushButton(f"Set {label} for selection")
            btn.clicked.connect(lambda checked, v=value: self._apply_value(v))
            layout.addWidget(btn)

        layout.addSpacing(4)
        btn_reset = QtWidgets.QPushButton("Reset to default")
        btn_reset.clicked.connect(self._reset)
        layout.addWidget(btn_reset)
        layout.addStretch()

        self._annotation_cls = annotation_cls
        self._state = state
        self._null_value = null_value

    def _apply_value(self, value: int) -> None:
        obj_name = self._state.active
        if not obj_name or obj_name not in self._state.arrays:
            return
        indices = self._require_selection_indices()
        if indices is None:
            return

        document = self._state.document(obj_name)
        document.condition_provider = CONDITION_PROVIDER
        try:
            document.set_condition(self._annotation_cls.name, indices, value=value, enabled=value != self._null_value)
        except ValueError as error:
            QtWidgets.QMessageBox.warning(self, "Condition edit failed", str(error))
            return

        self._reload_or_recolor()
        # Force the user to make a fresh selection before the next apply,
        # preventing silent overlap with the previous region. deselect() also
        # clears the on-screen indicators so nothing looks selected afterwards.
        self._clear_selection()

    def _reset(self) -> None:
        obj_name = self._state.active
        if not obj_name or obj_name not in self._state.arrays:
            return
        document = self._state.document(obj_name)
        document.condition_provider = CONDITION_PROVIDER
        try:
            document.set_condition(self._annotation_cls.name, list(range(len(document.array))), enabled=False)
        except ValueError as error:
            QtWidgets.QMessageBox.warning(self, "Condition reset failed", str(error))
            return
        self._reload_or_recolor()
