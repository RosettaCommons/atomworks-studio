"""Annotation Wizard editor for integer-per-atom group annotations.

Provides :py:class:`GroupEditor`, compatible with the standard
``editor_cls(annotation_cls, state)`` signature used by every other
entry in the Annotation Wizard. Used for both
:py:data:`~rfproteina.conditions.C_IDXGRP` and
:py:data:`~rfproteina.conditions.C_CRDGRP`.
"""

import logging

from atomworks.io.utils.atom_array_plus import AtomArrayPlus
from atomworks.io.utils.standard_annotations.base import StandardAnnotationBase
from atomworks_studio_pymol.bridge import reload_structure_in_pymol
from atomworks_studio_pymol.editors.widgets import BaseAnnotationEditor
from atomworks_studio_pymol.state import PluginState
from pymol.Qt import QtCore, QtWidgets

from atomworks_studio_rfd4 import CONDITION_PROVIDER
from atomworks_studio_rfd4.pymol.coordinate_edit import commit_document_edit

logger = logging.getLogger("atomworks_studio_pymol")


class GroupEditor(QtWidgets.QWidget, BaseAnnotationEditor):
    """Annotation-wizard editor for integer-per-atom group annotations.

    Supports listing existing groups, adding a PyMOL selection to an existing
    group, creating a new group from a selection, removing a selection from
    any group (assigning the unassigned value), and deleting a group.
    """

    def __init__(
        self,
        annotation_cls: StandardAnnotationBase,
        state: PluginState,
        parent: QtWidgets.QWidget | None = None,
    ):
        super().__init__(parent)
        self._annotation_cls = annotation_cls
        self._state = state

        layout = QtWidgets.QVBoxLayout(self)

        cls = annotation_cls
        header = QtWidgets.QLabel(f"<b>{cls.name}</b> &nbsp; <i>(level: {cls.level})</i>")
        header.setWordWrap(True)
        layout.addWidget(header)

        if cls.__doc__:
            doc = QtWidgets.QLabel(cls.__doc__.strip().split("\n")[0])
            doc.setWordWrap(True)
            layout.addWidget(doc)

        layout.addSpacing(6)

        # Groups dropdown + delete
        group_row = QtWidgets.QHBoxLayout()
        group_row.addWidget(QtWidgets.QLabel("Group:"))
        self._group_combo = QtWidgets.QComboBox()
        group_row.addWidget(self._group_combo, stretch=1)
        self._btn_delete = QtWidgets.QPushButton("Delete")
        self._btn_delete.setToolTip("Reassign all atoms in this group to the unassigned value.")
        group_row.addWidget(self._btn_delete)
        btn_refresh = QtWidgets.QPushButton("↻")
        btn_refresh.setToolTip("Refresh group list")
        btn_refresh.setMaximumWidth(30)
        group_row.addWidget(btn_refresh)
        layout.addLayout(group_row)

        layout.addSpacing(4)

        layout.addWidget(QtWidgets.QLabel("<b>Selection actions</b>"))
        self._btn_add = QtWidgets.QPushButton("Add selection to group")
        self._btn_new = QtWidgets.QPushButton("New group from selection")
        self._btn_remove = QtWidgets.QPushButton("Remove selection from any group")
        layout.addWidget(self._btn_add)
        layout.addWidget(self._btn_new)
        layout.addWidget(self._btn_remove)

        layout.addSpacing(6)
        self._status = QtWidgets.QLabel("")
        self._status.setWordWrap(True)
        layout.addWidget(self._status)
        layout.addStretch()

        self._btn_add.clicked.connect(self._add_to_group)
        self._btn_new.clicked.connect(self._new_group_from_selection)
        self._btn_remove.clicked.connect(self._remove_from_group)
        self._btn_delete.clicked.connect(self._delete_group)
        btn_refresh.clicked.connect(self.refresh)
        self._group_combo.installEventFilter(self)

        self.refresh()

    def eventFilter(self, obj: QtCore.QObject, event: QtCore.QEvent) -> bool:
        """Refresh the dropdown when the user opens it so it reflects current state."""
        if obj is self._group_combo and event.type() == QtCore.QEvent.MouseButtonPress:
            self.refresh()
        return super().eventFilter(obj, event)

    # -- helpers ---------------------------------------------------------

    def _active(self) -> tuple[str, AtomArrayPlus] | None:
        obj_name = self._state.active
        if not obj_name or obj_name not in self._state.arrays:
            return None
        return obj_name, self._state.get_synced_array(obj_name)

    def _selected_group_id(self) -> int | None:
        data = self._group_combo.currentData()
        return None if data is None else int(data)

    def _post_edit(self, obj_name: str, status: str) -> None:
        self._status.setText(status)
        reload_structure_in_pymol(obj_name)
        self.refresh()

    # -- UI refresh ------------------------------------------------------

    def refresh(self) -> None:
        """Rebuild the group dropdown from the current annotation."""
        selected = self._selected_group_id()
        self._group_combo.blockSignals(True)
        self._group_combo.clear()

        active = self._active()
        if active is None:
            self._group_combo.addItem("(no active object)", None)
            self._group_combo.blockSignals(False)
            return

        _obj, _arr = active
        self._displayed = (_obj, self._state.structure_version(_obj), self._state.documents[_obj].revision)
        document = self._state.document(_obj)
        document.condition_provider = CONDITION_PROVIDER
        for group in document.condition_groups(self._annotation_cls.name):
            self._group_combo.addItem(f"Group {group['id']} ({group['count']} atoms)", group["id"])

        selected_index = self._group_combo.findData(selected)
        if selected_index >= 0:
            self._group_combo.setCurrentIndex(selected_index)
        self._group_combo.blockSignals(False)

    # -- actions ---------------------------------------------------------

    def _edit_group(self, action: str) -> None:
        active = self._active()
        if active is None:
            return
        obj_name, _arr = active
        if action in ("add", "delete") and getattr(self, "_displayed", None) != (
            obj_name,
            self._state.structure_version(obj_name),
            self._state.documents[obj_name].revision,
        ):
            self.refresh()
            self._status.setText("The structure changed. Select the intended group and try again.")
            return
        indices = self._get_selection_indices() if action != "delete" else []
        if action != "delete" and not indices:
            QtWidgets.QMessageBox.warning(self, "No selection", "Make a selection in PyMOL first.")
            return
        document = self._state.document(obj_name)
        document.condition_provider = CONDITION_PROVIDER
        result = {}

        def operation(**kwargs):
            result.update(
                document.edit_condition_group(
                    self._annotation_cls.name,
                    action,
                    indices,
                    group_id=self._selected_group_id(),
                    **kwargs,
                )
            )

        try:
            if not commit_document_edit(self, document, operation):
                return
        except Exception as error:
            QtWidgets.QMessageBox.critical(self, "Group edit failed", str(error))
            return
        self._post_edit(obj_name, result["message"])
        self._clear_selection()
        if action == "new":
            self._group_combo.setCurrentIndex(self._group_combo.findData(result["group_id"]))

    def _add_to_group(self) -> None:
        self._edit_group("add")

    def _new_group_from_selection(self) -> None:
        self._edit_group("new")

    def _remove_from_group(self) -> None:
        self._edit_group("remove")

    def _delete_group(self) -> None:
        self._edit_group("delete")

    def apply_to_selection(self) -> None:
        self._edit_group("new")
