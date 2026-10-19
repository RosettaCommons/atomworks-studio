"""Annotation Wizard editor for mask-authored internal coordinates."""

import logging

from atomworks.io.utils.standard_annotations.base import StandardAnnotationBase
from atomworks_studio_pymol.editors.widgets import BaseAnnotationEditor
from atomworks_studio_pymol.state import PluginState
from pymol.Qt import QtWidgets

from atomworks_studio_rfd4 import CONDITION_PROVIDER
from atomworks_studio_rfd4.internal_coordinate import set_internal_coordinate_conditioning
from atomworks_studio_rfd4.pymol.coordinate_edit import commit_document_edit

logger = logging.getLogger("atomworks_studio_pymol")


class InternalCoordEditor(QtWidgets.QWidget, BaseAnnotationEditor):
    """Mask/group editor that leaves coordinate values to featurization."""

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

        header = QtWidgets.QLabel(f"<b>{annotation_cls.name}</b>")
        layout.addWidget(header)

        desc = QtWidgets.QLabel(
            "Mark the selected atoms for internal-coordinate conditioning. "
            "The selection gets its own coordinate group and its absolute-coordinate "
            "mask is cleared; RFD4 derives the values during featurization."
        )
        desc.setWordWrap(True)
        layout.addWidget(desc)

        layout.addSpacing(8)

        mark_button = QtWidgets.QPushButton("Mark selection as internal coords")
        unset_button = QtWidgets.QPushButton("Unset internal-coord mask on selection")
        layout.addWidget(mark_button)
        layout.addWidget(unset_button)

        layout.addSpacing(6)
        self._status = QtWidgets.QLabel("")
        self._status.setWordWrap(True)
        layout.addWidget(self._status)
        layout.addStretch()

        mark_button.clicked.connect(self._mark)
        unset_button.clicked.connect(lambda: self._update(False))

    def _mark(self) -> None:
        self._update(True)

    def _update(self, enabled: bool) -> None:
        obj_name = self._state.active
        if not obj_name or obj_name not in self._state.arrays:
            return
        indices = self._get_selection_indices()
        if not indices:
            QtWidgets.QMessageBox.warning(self, "No selection", "Make a selection in PyMOL first.")
            return

        self._state.get_synced_array(obj_name)
        result = {}
        try:
            document = self._state.document(obj_name)
            document.condition_provider = CONDITION_PROVIDER
            if not commit_document_edit(
                self,
                document,
                lambda **kwargs: result.update(
                    document.apply_selection_transform(
                        indices, "atom", set_internal_coordinate_conditioning, enabled, **kwargs
                    )
                ),
            ):
                return
        except Exception as error:
            QtWidgets.QMessageBox.critical(self, "Update failed", str(error))
            return

        self._status.setText(result["message"])
        self._reload_or_recolor()
        self._clear_selection()

    def apply_to_selection(self) -> None:
        self._mark()
