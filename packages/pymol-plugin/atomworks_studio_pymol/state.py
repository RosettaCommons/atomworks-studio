"""Plugin state management."""

from __future__ import annotations

import logging
from collections.abc import MutableMapping
from dataclasses import dataclass, field

from atomworks.io.utils.atom_array_plus import AtomArrayPlus
from atomworks_studio_editing.contracts import (
    ConditionProvider,
    ValidationProvider,
)
from atomworks_studio_editing.document import StudioDocument
from atomworks_studio_editing.providers import load_providers
from pymol import cmd

logger = logging.getLogger("atomworks_studio_pymol")


class _DocumentArrays(MutableMapping[str, AtomArrayPlus]):
    """Array access for extensions, backed by the shared documents."""

    def __init__(self, state: PluginState):
        self.state = state
        self.documents = state.documents

    def __getitem__(self, name: str) -> AtomArrayPlus:
        return self.documents[name].array

    def __setitem__(self, name: str, array: AtomArrayPlus) -> None:
        if name in self.documents:
            self.documents[name].array = array
        else:
            self.documents[name] = StudioDocument(
                array,
                name,
                condition_provider=self.state.condition_provider,
                validation_provider=self.state.validation_provider,
            )

    def __delitem__(self, name: str) -> None:
        del self.documents[name]

    def __iter__(self):
        return iter(self.documents)

    def __len__(self) -> int:
        return len(self.documents)


@dataclass
class PluginState:
    """Global plugin state.

    Attributes:
        arrays: Maps PyMOL object name → AtomArrayPlus (ground truth).
        index_maps: Maps PyMOL object name → {(chain_id, res_id, ins_code, atom_name): int}.
        versions: Maps PyMOL object name → int, bumped on every structural edit.
        documents: Shared documents containing arrays and bounded undo history.
        active: Name of the currently active object.
    """

    documents: dict[str, StudioDocument] = field(default_factory=dict)
    arrays: MutableMapping[str, AtomArrayPlus] = field(init=False)
    index_maps: dict = field(default_factory=dict)
    versions: dict = field(default_factory=dict)
    active: str | None = None
    hide_nans: bool = True
    show_seq_gaps: bool = False
    condition_provider: ConditionProvider = field(default_factory=lambda: load_providers().condition_provider)
    validation_provider: ValidationProvider = field(default_factory=lambda: load_providers().validation_provider)

    def __post_init__(self) -> None:
        self.arrays = _DocumentArrays(self)

    def configure_documents(
        self, condition_provider: ConditionProvider, validation_provider: ValidationProvider
    ) -> None:
        self.condition_provider = condition_provider
        self.validation_provider = validation_provider
        for document in self.documents.values():
            document.condition_provider = condition_provider
            document.validation_provider = validation_provider

    def document(self, obj_name: str, *, interactive: bool = True) -> StudioDocument:
        """Synchronize live coordinates before a shared document operation."""
        if self.get_synced_array(obj_name, interactive=interactive) is None:
            raise KeyError(f"No tracked structure: {obj_name}")
        return self.documents[obj_name]

    def set_array(self, obj_name: str, array: AtomArrayPlus) -> None:
        """Replace the tracked array for *obj_name* and rebuild its index map to match.

        Any code that structurally changes an array (delete, insert, undo, ...)
        must go through this rather than assigning ``self.arrays[obj_name]``
        directly. ``index_maps[obj_name]`` is nothing but a cached lookup
        derived from the array's identity keys -- rebuilding it here, in the
        same step as the array replacement, means the two can never be
        observed out of sync.

        Bumps ``versions[obj_name]`` so callers holding an identity key from
        before this edit can tell their key is stale even if it happens to
        still be present in the rebuilt index map (e.g. a different atom
        renumbered into the same ``res_id`` after ``close_res_id_gaps``).
        """
        self.arrays[obj_name] = array
        from atomworks_studio_pymol.bridge import build_index_map

        self.index_maps[obj_name] = build_index_map(obj_name)
        self.versions[obj_name] = self.versions.get(obj_name, 0) + 1

    def structure_version(self, obj_name: str) -> int:
        """Return the current structural-edit version counter for *obj_name*."""
        return self.versions.get(obj_name, 0)

    def get_synced_array(self, obj_name: str, *, interactive: bool = True) -> AtomArrayPlus | None:
        """Return the array for *obj_name*, refreshed from PyMOL's live coordinates first.

        Every read or mutation path should go through this rather than indexing
        ``arrays`` directly: a raw PyMOL coordinate mutation (``translate``,
        dragging, ``alter_state``, etc.) never touches the cache on its own, so
        indexing ``arrays`` directly can silently return a stale pose. Import is
        lazy to avoid a circular import with :py:mod:`atomworks_studio_pymol.bridge`
        (which imports ``STATE`` from this module).

        A raw PyMOL-level structural edit (``remove``, ``alter``, deleting atoms
        directly in the viewer, etc.) is a more serious case than a coordinate
        move: it's not just stale, the tracked array and PyMOL's object no
        longer agree on which atoms exist, and there's no safe way to reconcile
        an arbitrary external edit. There's no legitimate reason to keep working
        from a diverged state, so this reloads PyMOL from the tracked array
        (the ground truth) immediately upon detecting it, rather than letting
        the mismatch silently ride until save.

        An object deleted in PyMOL (``delete obj``, the object menu) is not a
        divergence to repair: its state is cleared and ``None`` is returned, as
        for an untracked object, rather than reloading the object into the viewer.

        Args:
          interactive: Whether to pop a blocking confirmation dialog on divergence.
            Set to ``False`` for callers reachable from scripted/headless contexts
            (e.g. ``aw_*`` console commands), where there's no one present to
            dismiss a modal -- a warning is logged instead.
        """
        if obj_name not in self.arrays:
            return None
        if obj_name not in cmd.get_names("objects"):
            logger.info("'%s' was deleted in PyMOL; it is no longer tracked", obj_name)
            self.clear_object(obj_name)
            return None
        from atomworks_studio_pymol.bridge import (
            find_pymol_array_divergence,
            refresh_coords_from_pymol,
            reload_structure_in_pymol,
        )

        if find_pymol_array_divergence(obj_name):
            message = (
                "PyMOL and the tracked structure for '%s' have diverged -- not all PyMOL "
                "operations are mirrored into the plugin (e.g. raw 'remove'/'alter' "
                "commands, or deleting atoms directly in the viewer). There's no safe "
                "way to reconcile an arbitrary external edit, so the tracked structure "
                "will now be reloaded into PyMOL to restore a known-good state. Redo "
                "any changes you intended using the plugin's own actions."
            )
            if interactive:
                from pymol.Qt import QtWidgets

                box = QtWidgets.QMessageBox(
                    QtWidgets.QMessageBox.Warning,
                    "PyMOL / Structure Mismatch",
                    message % obj_name,
                )
                box.addButton("Reload AtomArray", QtWidgets.QMessageBox.AcceptRole)
                box.exec_()
            else:
                logger.warning(message, obj_name)
            reload_structure_in_pymol(obj_name)
        else:
            refresh_coords_from_pymol(obj_name)
        return self.arrays[obj_name]

    def active_array(self) -> AtomArrayPlus | None:
        """Return the active AtomArrayPlus, refreshed from PyMOL first, or None."""
        return self.get_synced_array(self.active) if self.active else None

    def visible_arrays(self) -> list[tuple[str, AtomArrayPlus]]:
        """Return (name, array) pairs for all visible tracked PyMOL objects."""
        try:
            visible = cmd.get_names("objects", enabled_only=1)
            return [(n, self.get_synced_array(n)) for n in visible if n in self.arrays]
        except Exception:
            return list(self.arrays.items())

    def push_snapshot(self, obj_name: str, *, interactive: bool = True) -> None:
        """Save a deep copy of the (freshly synced) array for undo (max 10 levels)."""
        array = self.get_synced_array(obj_name, interactive=interactive)
        if array is None:
            return
        self.documents[obj_name].snapshot()

    def pop_snapshot(self, obj_name: str) -> AtomArrayPlus | None:
        """Undo the document edit and rebuild the renderer's identity map.

        An object the user deleted directly in PyMOL (``delete obj``, the object
        menu) is not resurrected: its state is cleared and ``None`` is returned,
        mirroring :py:meth:`get_synced_array`. Without this check, undo would
        restore the document and the subsequent reload would recreate an object
        the user had deleted.
        """
        document = self.documents.get(obj_name)
        if document is None:
            return None
        if obj_name in self.arrays and obj_name not in cmd.get_names("objects"):
            logger.info("'%s' was deleted in PyMOL; refusing to undo (not resurrecting it)", obj_name)
            self.clear_object(obj_name)
            return None
        if not document.undo():
            return None
        self.set_array(obj_name, document.array)
        return document.array

    def clear_object(self, obj_name: str) -> None:
        """Remove all state for a tracked object.

        ``versions`` is kept so a structure later loaded under the same name gets a
        new version, and keys picked against the removed one stay stale.
        """
        self.arrays.pop(obj_name, None)
        self.index_maps.pop(obj_name, None)
        if self.active == obj_name:
            self.active = next(iter(self.arrays), None)

    def forget_deleted_objects(self) -> None:
        """Clear state for every tracked object that no longer exists in PyMOL."""
        existing = set(cmd.get_names("objects"))
        for name in [name for name in self.arrays if name not in existing]:
            self.clear_object(name)

    def clear_all(self) -> None:
        """Clear all state."""
        self.arrays.clear()
        self.index_maps.clear()
        self.versions.clear()
        self.active = None


# Module-level singleton shared by the entire plugin
STATE = PluginState()
