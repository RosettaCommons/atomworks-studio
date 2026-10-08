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

from atomworks.io.config import ParseConfig
from atomworks.io.utils.io_utils import to_cif_file
from atomworks_studio_pymol.bridge import (
    combine_visible,
    load_structure,
    reload_structure_in_pymol,
    selection_to_indices,
)
from atomworks_studio_pymol.state import STATE
from pymol import cmd

logger = logging.getLogger("atomworks_studio_pymol")


def _aw_load(path: str, obj_name: str = "") -> None:
    config = ParseConfig.from_preset("rcsb", build_assembly="first")
    obj_name = load_structure(path, config=config, obj_name=obj_name or None)
    print(f"AtomWorks: loaded '{path}' as '{obj_name}'")


def _aw_save(path: str, obj_name: str = "") -> None:
    target = obj_name or STATE.active
    if not target or target not in STATE.arrays:
        print("AtomWorks: no active object to save.")
        return
    to_cif_file(STATE.get_synced_array(target, interactive=False), path, save_standard_annotations=True)
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

    indices = _selection_to_indices_for_active(selection, STATE.index_maps[target])
    if not indices:
        print(f"AtomWorks: selection '{selection}' matched no atoms in '{target}'.")
        return

    before = insert_before.strip() in ("1", "true", "True", "yes")
    try:
        document = STATE.document(target, interactive=False)
        document.insert_segment(int(seg_min), int(seg_max), int(indices[0]), before=before)
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

    indices = _selection_to_indices_for_active(selection, STATE.index_maps[target])
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


def _selection_to_indices_for_active(selection: str, index_map: dict) -> list[int]:
    """Translate a PyMOL selection to indices, preferring atoms from the active object."""
    target = STATE.active
    try:
        if target:
            qualified = f"({selection}) and {target}"
            if cmd.get_model(qualified).atom:
                return selection_to_indices(qualified, index_map)
    except Exception:
        logger.debug("Could not restrict selection to active object", exc_info=True)
    return selection_to_indices(selection, index_map)


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
