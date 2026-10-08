"""CATH fold authoring through the same document operation as the browser."""

from atomworks_studio_pymol.editors.widgets import BaseAnnotationEditor
from pymol.Qt import QtWidgets

from atomworks_studio_rfd4 import CONDITION_PROVIDER
from atomworks_studio_rfd4.model import C_CATH


class CathEditor(QtWidgets.QWidget, BaseAnnotationEditor):
    def __init__(self, annotation_cls, state, parent=None):
        super().__init__(parent)
        self._annotation_cls = annotation_cls
        self._state = state
        layout = QtWidgets.QVBoxLayout(self)
        description = QtWidgets.QLabel(
            "Enter a C.A.T fold label for the selected residues. "
            "Use x for trailing unspecified levels, e.g. 1.x.x or 2.60.40."
        )
        description.setWordWrap(True)
        layout.addWidget(description)
        self._label = QtWidgets.QLineEdit("1.x.x")
        layout.addWidget(self._label)
        apply_button = QtWidgets.QPushButton("Set CAT for selection")
        apply_button.clicked.connect(self.apply_to_selection)
        layout.addWidget(apply_button)
        clear_button = QtWidgets.QPushButton("Clear CAT for selection")
        clear_button.clicked.connect(lambda: self._apply_value(False))
        layout.addWidget(clear_button)
        layout.addStretch()

    def apply_to_selection(self) -> None:
        self._apply_value(True)

    def _apply_value(self, enabled: bool) -> None:
        name = self._state.active
        if not name:
            return
        indices = self._require_selection_indices()
        if indices is None:
            return
        document = self._state.document(name)
        document.condition_provider = CONDITION_PROVIDER
        try:
            document.set_condition(C_CATH.name, indices, enabled=enabled, value=self._label.text(), scope="residue")
        except (ValueError, OSError) as error:
            QtWidgets.QMessageBox.warning(self, "CAT edit failed", str(error))
            return
        self._reload_or_recolor()
        self._clear_selection()
