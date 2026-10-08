"""Confirm saved-target loss and commit through the shared document transaction."""

from atomworks_studio_editing.contracts import TargetDiscardConfirmationRequiredError
from pymol.Qt import QtWidgets


def commit_document_edit(editor, document, operation) -> bool:
    """Run an edit, requesting explicit consent before retrying target loss."""
    revision = document.revision
    try:
        operation(allow_target_discard=False, expected_revision=revision)
    except TargetDiscardConfirmationRequiredError as error:
        reply = QtWidgets.QMessageBox.warning(
            editor,
            "Discard saved internal coordinate targets?",
            f"This edit clears saved targets for {error.lost_target_count} atoms in affected coordinate groups, "
            "including group members outside the selection. New targets will be taken from the structure "
            "when model inputs are prepared. Undo restores the saved targets.",
            QtWidgets.QMessageBox.Yes | QtWidgets.QMessageBox.Cancel,
            QtWidgets.QMessageBox.Cancel,
        )
        if reply != QtWidgets.QMessageBox.Yes:
            return False
        operation(allow_target_discard=True, expected_revision=revision)
    return document.revision != revision
