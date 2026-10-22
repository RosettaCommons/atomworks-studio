"""Console commands for the AtomWorks PyMOL plugin.

Registers ``aw_*`` commands via ``cmd.extend()`` so users can drive the plugin
from the PyMOL console without the GUI.

Examples::

    aw_load my_design.cif
    aw_insert_segment sele, 20, 50
    aw_delete sele
    aw_undo
    aw_save output.cif
    aw_combine_visible scaffold_motif
"""

import logging
from pathlib import Path

from atomworks_studio_editing.loading import build_load_config, inspect_import
from pymol import cmd

from atomworks_studio_pymol.bridge import (
    combine_visible,
    load_structure,
    reload_structure_in_pymol,
    selection_to_indices,
)
from atomworks_studio_pymol.saving import collect_save_issues, write_cif
from atomworks_studio_pymol.state import STATE

logger = logging.getLogger("atomworks_studio_pymol")


def _aw_load(path: str, obj_name: str = "") -> None:
    # Match the GUI: an annotated CIF keeps its saved annotations, and only an unannotated
    # file gets the RCSB preset. Loading everything as RCSB silently discarded annotations.
    try:
        preset = inspect_import(Path(path))["preset"]
    except Exception:
        logger.debug("Could not inspect '%s' for an import preset", path, exc_info=True)
        preset = None
    if preset is None:
        print(f"AtomWorks: '{path}' needs an explicit preset; loading annotated. Use the panel to choose.")
        preset = "minimal"
    config = build_load_config(preset, assembly="first")
    obj_name = load_structure(path, config=config, obj_name=obj_name or None)
    print(f"AtomWorks: loaded '{path}' as '{obj_name}' ({preset})")


def _aw_save(path: str, obj_name: str = "") -> None:
    target = obj_name or STATE.active
    if not target or target not in STATE.arrays:
        print("AtomWorks: no active object to save.")
        return
    arr = STATE.get_synced_array(target, interactive=False)
    if arr is None:
        print(f"AtomWorks: '{target}' no longer exists in PyMOL.")
        return
    # Same validation and writer as the panel's Save button. There is no one to confirm
    # a prompt here, so issues are reported and the file is saved anyway.
    for issue in collect_save_issues(arr):
        print(f"AtomWorks: save validation: {issue}")
    try:
        write_cif(arr, path)
    except Exception as e:
        print(f"AtomWorks: save failed: {e}")
        return
    print(f"AtomWorks: saved '{target}' → '{path}'")


def _aw_insert_segment(
    selection: str = "sele",
    seg_min: str = "0",
    seg_max: str = "10",
    insert_before: str = "0",
) -> None:
    target = STATE.active
    if not target or target not in STATE.arrays:
        print("AtomWorks: no active object.")
        return

    indices = selection_to_indices(selection, STATE.index_maps[target], target)
    if not indices:
        print(f"AtomWorks: selection '{selection}' matched no atoms in '{target}'.")
        return

    before = insert_before.strip() in ("1", "true", "True", "yes")
    try:
        document = STATE.document(target, interactive=False)
        anchor = indices[0] if before else indices[-1]
        document.insert_segment(int(seg_min), int(seg_max), int(anchor), before=before)
        STATE.set_array(target, document.array)
    except Exception as e:
        print(f"AtomWorks: segment insertion failed: {e}")
        return

    reload_structure_in_pymol(target)
    print(f"AtomWorks: inserted expandable segment [{seg_min}-{seg_max}] in '{target}'")


def _aw_delete_selection(selection: str = "sele", obj_name: str = "") -> None:
    target = obj_name or STATE.active
    if not target or target not in STATE.arrays:
        print("AtomWorks: no active object.")
        return

    indices = selection_to_indices(selection, STATE.index_maps[target], target)
    if not indices:
        print(f"AtomWorks: selection '{selection}' matched no atoms in '{target}'.")
        return

    document = STATE.document(target, interactive=False)
    document.delete_atoms(indices, close_residue_gaps=False)
    STATE.set_array(target, document.array)
    reload_structure_in_pymol(target)
    print(f"AtomWorks: deleted {len(indices)} atoms from '{target}'")


def _aw_undo(obj_name: str = "") -> None:
    target = obj_name or STATE.active
    if not target:
        print("AtomWorks: no active object.")
        return
    snapshot = STATE.pop_snapshot(target)
    if snapshot is None:
        print(f"AtomWorks: no undo history for '{target}'.")
        return
    reload_structure_in_pymol(target)
    print(f"AtomWorks: undone last edit for '{target}'")


def _aw_combine_visible(new_name: str = "combined") -> None:
    try:
        result_name = combine_visible(new_name)
        print(f"AtomWorks: combined visible objects into '{result_name}'")
    except Exception as e:
        print(f"AtomWorks: combine failed: {e}")


def _aw_set_active(obj_name: str) -> None:
    if obj_name not in STATE.arrays:
        print(f"AtomWorks: '{obj_name}' is not a loaded AtomWorks object.")
        return
    STATE.active = obj_name
    print(f"AtomWorks: active object → '{obj_name}'")


def register_commands() -> None:
    """Register all aw_* commands with PyMOL."""

    cmd.extend("aw_load", _aw_load)
    cmd.extend("aw_save", _aw_save)
    cmd.extend("aw_insert_segment", _aw_insert_segment)
    cmd.extend("aw_delete", _aw_delete_selection)
    cmd.extend("aw_undo", _aw_undo)
    cmd.extend("aw_combine_visible", _aw_combine_visible)
    cmd.extend("aw_set_active", _aw_set_active)

    logger.info("AtomWorks: registered aw_* console commands")
