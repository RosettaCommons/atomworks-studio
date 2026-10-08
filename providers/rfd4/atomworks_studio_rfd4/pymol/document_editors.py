"""Native controls backed by the same validated operations as browser sessions."""

from atomworks_studio_pymol.editors.widgets import MaskEditor, ScalarEditor
from pymol.Qt import QtWidgets

from atomworks_studio_rfd4 import CONDITION_PROVIDER
from atomworks_studio_rfd4.pymol.coordinate_edit import commit_document_edit


class DocumentMaskEditor(MaskEditor):
    def _set_mask(self, value: bool) -> bool:
        name = self._state.active
        if not name:
            return False
        indices = self._require_selection_indices()
        if indices is None:
            return False
        document = self._state.document(name)
        document.condition_provider = CONDITION_PROVIDER
        definition = CONDITION_PROVIDER.definitions_by_name[self._annotation_cls.name]
        try:
            if not commit_document_edit(
                self,
                document,
                lambda **kwargs: document.set_condition(
                    definition.key, indices, enabled=not value if definition.invert_mask else value, **kwargs
                ),
            ):
                return False
        except ValueError as error:
            QtWidgets.QMessageBox.warning(self, "Condition edit failed", str(error))
            return False
        self._reload_or_recolor()
        self._clear_selection()
        return True

    def _reset(self) -> None:
        name = self._state.active
        if not name:
            return
        document = self._state.document(name)
        document.condition_provider = CONDITION_PROVIDER
        try:
            if not commit_document_edit(
                self,
                document,
                lambda **kwargs: document.set_condition(
                    self._annotation_cls.name, list(range(len(document.array))), enabled=False, **kwargs
                ),
            ):
                return
        except ValueError as error:
            QtWidgets.QMessageBox.warning(self, "Condition reset failed", str(error))
            return
        self._reload_or_recolor()


class SequenceProbabilityEditor(ScalarEditor):
    def __init__(self, annotation_cls, state, parent=None):
        super().__init__(annotation_cls, state, parent)
        self._value_widget.setRange(0.0, 1.0)
        self._value_widget.setDecimals(6)
        self._mask_chk.setText("Specify probability for the selected residues")
        self._mask_chk.setChecked(True)

    def apply_to_selection(self) -> None:
        name = self._state.active
        if not name:
            return
        indices = self._require_selection_indices()
        if indices is None:
            return
        document = self._state.document(name)
        document.condition_provider = CONDITION_PROVIDER
        try:
            document.set_condition(
                self._annotation_cls.name,
                indices,
                enabled=self._mask_chk.isChecked(),
                value=self._value_widget.value(),
                scope="residue",
            )
        except ValueError as error:
            QtWidgets.QMessageBox.warning(self, "Sequence probability edit failed", str(error))
            return
        self._reload_or_recolor()
        self._clear_selection()
