"""PyMOL ↔ AtomArrayPlus bridge.

Responsibilities:
- Building the (chain_id, res_id, ins_code, atom_name) → atom_index map.
- Loading structures from disk into both PyMOL and the plugin state.
- Reloading a modified AtomArrayPlus back into PyMOL.
- Translating PyMOL selections into AtomArrayPlus index lists.
- Combining multiple visible objects into one merged AtomArrayPlus.
"""

import logging
from pathlib import Path

import biotite.structure as struc
import numpy as np
from atomworks.io.config import ParseConfig
from atomworks.io.parser import parse
from atomworks.io.utils.atom_array_plus import (
    AtomArrayPlus,
    as_atom_array_plus,
)
from atomworks.io.utils.io_utils import CIFWriteConfig, to_cif_string
from atomworks_studio_editing.annotations import normalize_annotation_aliases
from atomworks_studio_editing.structure_mutations import (
    delete_atoms,
    deletion_would_create_res_id_gap,
    refresh_chain_derived_annotations,
)
from atomworks_studio_pymol.display import prepare_for_display
from atomworks_studio_pymol.state import STATE
from atomworks_studio_pymol.views import apply_current_view
from biotite.structure import AtomArrayStack
from pymol import cmd

logger = logging.getLogger("atomworks_studio_pymol")

__all__ = ["delete_atoms", "deletion_would_create_res_id_gap"]


# ---------------------------------------------------------------------------
# Index map
# ---------------------------------------------------------------------------


def _array_atom_key(array: AtomArrayPlus, i: int) -> tuple:
    """Build the (chain_id, res_id, ins_code, atom_name) identity key for array row *i*."""
    has_ins = "ins_code" in array.get_annotation_categories()
    ins = (array.ins_code[i] if has_ins else "") or ""
    return (
        str(array.chain_iid[i]),
        int(array.res_id[i]),
        str(ins).strip(),
        str(array.atom_name[i]),
    )


def build_index_map(obj_name: str) -> dict[tuple, int]:
    """Build a (chain_id, res_id, ins_code, atom_name) → array_index map from
    the in-memory :py:class:`AtomArrayPlus` stored for *obj_name*.

    We key off the array — not off ``cmd.get_model(obj_name).atom`` — because
    PyMOL reorders atoms within each residue when loading a CIF (backbone
    atoms N/CA/C/O are promoted ahead of sidechain heavies). Walking PyMOL's
    enumeration therefore assigns the wrong array index to every atom
    affected by the reorder. The 4-tuple is unique in any well-formed array,
    so looking up PyMOL selections through this dict is exact.

    Args:
        obj_name: PyMOL object name; must be present in ``STATE.arrays``.

    Returns:
        Dict mapping 4-tuples to integer indices into the AtomArrayPlus.
    """
    array = STATE.arrays[obj_name]
    return {_array_atom_key(array, i): i for i in range(len(array))}


def _pymol_resi_to_res_id_ins_code(resi: str) -> tuple[int, str]:
    """Parse a PyMOL resi string (e.g. ``"14A"``) into ``(res_id, ins_code)``."""
    resi = resi.strip()
    if resi and resi[-1].isalpha():
        return int(resi[:-1]), resi[-1]
    return int(resi), ""


def _pymol_atom_key(atom) -> tuple:
    """Build the (chain_id, res_id, ins_code, atom_name) identity key for a chempy atom."""
    res_id, ins_code = _pymol_resi_to_res_id_ins_code(atom.resi)
    return (atom.chain, res_id, ins_code, atom.name)


def selection_to_indices(selection: str, index_map: dict[tuple, int]) -> list[int]:
    """Translate a PyMOL selection string into AtomArrayPlus atom indices.

    Args:
        selection: PyMOL selection expression (e.g. ``"sele"``, ``"chain A"``).
        index_map: Mapping built by :py:func:`build_index_map`.

    Returns:
        List of integer indices into the AtomArrayPlus.
    """
    indices: list[int] = []
    misses: list[tuple] = []
    for atom in cmd.get_model(selection).atom:
        key = _pymol_atom_key(atom)
        idx = index_map.get(key)
        if idx is not None:
            indices.append(idx)
        else:
            misses.append(key)

    if misses and not indices:
        logger.warning(
            "selection_to_indices: no atoms matched. PyMOL keys (sample): %s. Index map keys (sample): %s.",
            misses[:3],
            list(index_map.keys())[:3],
        )

    return indices


def find_chain_res_id_gaps(arr: AtomArrayPlus) -> list[str]:
    """Return a description of each internal res_id discontinuity found in *arr*."""
    if "chain_iid" not in arr.get_annotation_categories():
        return []
    starts = struc.get_residue_starts(arr)
    messages = []
    prev_chain_iid = None
    prev_res_id: int | None = None
    for start in starts:
        chain_iid = arr.chain_iid[start]
        res_id = int(arr.res_id[start])
        if chain_iid == prev_chain_iid and prev_res_id is not None:
            delta = res_id - prev_res_id
            # delta == 0 means same res_id, different ins_code - not a gap.
            if delta not in (0, 1):
                messages.append(f"chain {chain_iid}: res_id jumps from {prev_res_id} to {res_id}")
        prev_chain_iid = chain_iid
        prev_res_id = res_id
    return messages


def refresh_coords_from_pymol(obj_name: str) -> None:
    """Pull live atom coordinates from PyMOL into the cached AtomArrayPlus.

    PyMOL coordinate mutations (``translate``, manual dragging, ``alter_state``,
    etc.) are not mirrored into ``STATE`` automatically — only structural edits
    routed through the plugin (delete, insert, undo) rebuild the array. Call
    this before reading ``arr.coord`` for anything that must reflect the
    structure's current pose (e.g. coordinate conditioning), so a moved
    structure doesn't silently condition on stale positions.

    Atoms are matched by the same identity key used elsewhere in the bridge
    (:py:func:`_pymol_atom_key`), not by position, so this is unaffected by
    PyMOL's internal atom reordering. NaN-coord atoms are skipped: those are
    unresolved atoms displayed at a placeholder centroid position (see
    :py:func:`_load_array_into_pymol`), and must not be "resolved" by reading
    that placeholder back as a real coordinate.

    Args:
        obj_name: PyMOL object name; must be present in ``STATE.arrays``.
    """
    array = STATE.arrays.get(obj_name)
    index_map = STATE.index_maps.get(obj_name)
    if array is None or index_map is None:
        return

    misses = 0
    for atom in cmd.get_model(obj_name).atom:
        idx = index_map.get(_pymol_atom_key(atom))
        if idx is None:
            misses += 1
            continue
        if np.isnan(array.coord[idx]).any():
            continue
        array.coord[idx] = atom.coord

    if misses:
        logger.warning("refresh_coords_from_pymol: %d atom(s) in '%s' had no matching array index", misses, obj_name)


def find_pymol_array_divergence(obj_name: str) -> list[str]:
    """Detect atoms where PyMOL's object and the cached AtomArrayPlus disagree.

    Only edits routed through the plugin's own commands/buttons (delete,
    insert, undo, reload) keep ``STATE`` in sync -- a raw PyMOL-level
    structural edit (``remove``, ``alter``, deleting atoms directly in the
    viewer, etc.) is invisible to the plugin (see the "Command intercepts"
    TODO at the bottom of this module). Left undetected, the tracked array
    would still contain atoms the user believes they deleted, and those
    atoms would be written out on save with no indication anything was
    wrong. This compares identity keys (the same ones used everywhere else
    in the bridge) between what PyMOL currently holds and what the array
    is expected to display, so it catches both raw deletions/renames
    (expected atoms missing from PyMOL) and raw additions (unexpected atoms
    in PyMOL) -- in either direction, there's no safe way to auto-repair an
    arbitrary raw edit, so this only detects and reports.

    Args:
        obj_name: PyMOL object name; must be present in ``STATE.arrays``.

    Returns:
        Human-readable description of each kind of divergence found, or an
        empty list if PyMOL and the array agree.
    """
    array = STATE.arrays.get(obj_name)
    if array is None:
        return []

    display = prepare_for_display(array, nan_coord_policy="centroid")
    expected_keys = {_array_atom_key(display, i) for i in range(len(display)) if not np.isnan(display.coord[i]).any()}
    pymol_keys = {_pymol_atom_key(atom) for atom in cmd.get_model(obj_name).atom}

    messages = []
    missing_from_pymol = expected_keys - pymol_keys
    if missing_from_pymol:
        messages.append(f"{len(missing_from_pymol)} atom(s) tracked in the plugin are missing from PyMOL")
    unexpected_in_pymol = pymol_keys - expected_keys
    if unexpected_in_pymol:
        messages.append(f"{len(unexpected_in_pymol)} atom(s) in PyMOL have no match in the tracked structure")
    return messages


# ---------------------------------------------------------------------------
# Load / reload helpers
# ---------------------------------------------------------------------------


def _load_array_into_pymol(
    array: AtomArrayPlus,
    obj_name: str,
    hide_nans: bool = True,
    show_seq_gaps: bool = False,
) -> None:
    """Serialize *array* to an in-memory CIF and load it into PyMOL.

    Uses ``cmd.load_raw`` to write directly into PyMOL without going through
    ``cmd.load``.  Expandable segment sentinels receive interpolated
    display coordinates via :py:func:`prepare_for_display` so they appear at a
    sensible position in the 3D view.  Standard annotations are excluded from
    the CIF — PyMOL doesn't understand them.

    Args:
        array: Structure to load.
        obj_name: PyMOL object name.
        hide_nans: Whether NaN-coord atoms are hidden in the view (applied later
            by :py:func:`~atomworks_studio_pymol.views.apply_current_view`). They
            are always loaded into the object — moved to their residue centroid —
            so they stay selectable and every ground-truth atom has a PyMOL counterpart.
        show_seq_gaps: If True, write ``_entity``/``_entity_poly``/
            ``_entity_poly_seq`` so PyMOL's sequence viewer shows gaps for
            unresolved residues. Off by default because for structures whose
            chains share a ``chain_entity`` but have divergent per-chain
            residue layouts (e.g. designed/generated CIFs with flexible
            residue indexing), the broadcast canonical sequence causes
            grayed-out ghost residues, duplicate-position rendering, and
            missing polymer bonds.
    """
    # Always keep NaN-coord atoms (moved to their residue centroid) so PyMOL
    # holds every ground-truth atom and selections/mask edits can reach them.
    display = prepare_for_display(array, nan_coord_policy="centroid")
    config = CIFWriteConfig(
        save_standard_annotations=False,
        include_entity_categories=show_seq_gaps,
        include_nan_coords=False,
    )
    cif_str = to_cif_string(display, config=config)
    cmd.load_raw(cif_str, format="cif", object=obj_name)


def load_structure(
    path: str | Path,
    config: ParseConfig,
    obj_name: str | None = None,
) -> str:
    """Load a CIF file into both PyMOL and the plugin state.

    Args:
        path: Path to the CIF file.
        config: Parse configuration controlling assembly building, annotation
            loading, missing atoms, waters, etc.
        obj_name: PyMOL object name.  Defaults to the file stem.

    Returns:
        The PyMOL object name used.
    """
    path = Path(path)
    obj_name = obj_name or path.stem

    result = parse(path, config=config)

    if config.build_assembly is not None:
        assemblies = result.get("assemblies", {})
        if assemblies:
            requested = config.build_assembly
            if isinstance(requested, str) and requested in assemblies:
                array = assemblies[requested]
            else:
                array = next(iter(assemblies.values()))
        else:
            array = result["asym_unit"]
    else:
        array = result["asym_unit"]

    # always choose the first model for now
    if isinstance(array, AtomArrayStack):
        array = array[0]
    array = as_atom_array_plus(array)
    normalize_annotation_aliases(array)

    refresh_chain_derived_annotations(array)

    STATE.set_array(obj_name, array)
    STATE.active = obj_name
    _load_array_into_pymol(array, obj_name, hide_nans=STATE.hide_nans, show_seq_gaps=STATE.show_seq_gaps)
    apply_current_view(array, obj_name)

    logger.info("Loaded %s as '%s' (%d atoms)", path.name, obj_name, len(array))

    return obj_name


def reload_structure_in_pymol(obj_name: str) -> None:
    """Replace the PyMOL object with the current in-memory AtomArrayPlus.

    Used after structural edits (delete, gap insertion) that change the array.
    This only pushes ``STATE.arrays[obj_name]`` into PyMOL -- it never pulls
    live PyMOL coordinates first. Pulling is :py:meth:`PluginState.get_synced_array`'s
    job, and it must happen *before* any edit rebuilds the index map.

    Args:
        obj_name: Name of the PyMOL object to replace.
    """
    if obj_name not in STATE.arrays:
        logger.warning("reload_structure_in_pymol: '%s' not in state", obj_name)
        return

    array = STATE.arrays[obj_name]

    STATE.index_maps.pop(obj_name, None)

    try:
        cmd.delete(obj_name)
        _load_array_into_pymol(array, obj_name, hide_nans=STATE.hide_nans, show_seq_gaps=STATE.show_seq_gaps)
    except Exception:
        STATE.arrays[obj_name] = array
        STATE.index_maps[obj_name] = build_index_map(obj_name)
        raise

    STATE.arrays[obj_name] = array
    STATE.index_maps[obj_name] = build_index_map(obj_name)
    apply_current_view(array, obj_name)


# ---------------------------------------------------------------------------
# Chain conflict resolution for combine
# ---------------------------------------------------------------------------


def combine_visible(new_name: str, *, allow_overwrite: bool = False) -> str:
    """Combine all visible tracked objects into a single AtomArrayPlus.

    Source objects are hidden after combining.  The merged result becomes active.

    Args:
        new_name: Name for the merged PyMOL object.
        allow_overwrite: If ``new_name`` already names a tracked object, this must
            be set to replace it (destroying its undo history); otherwise raises.

    Returns:
        The new object name.

    Raises:
        ValueError: If ``new_name`` already names a tracked object and
            ``allow_overwrite`` is False.
    """
    if new_name in STATE.arrays and not allow_overwrite:
        raise ValueError(
            f"'{new_name}' is already a tracked object. Pass allow_overwrite=True to replace it "
            "(this destroys its undo history)."
        )

    visible = STATE.visible_arrays()
    if len(visible) < 2:
        raise RuntimeError("Need at least 2 visible tracked objects to combine.")

    names = [n for n, _ in visible]
    document = STATE.document(names[0]).clone()
    document.combine([STATE.document(name) for name in names[1:]])
    document.name = new_name
    document.clear_history()
    merged = document.array

    STATE.documents[new_name] = document
    STATE.set_array(new_name, merged)
    _load_array_into_pymol(merged, new_name, hide_nans=STATE.hide_nans, show_seq_gaps=STATE.show_seq_gaps)
    apply_current_view(merged, new_name)

    for n in names:
        cmd.disable(n)
    STATE.active = new_name

    return new_name


# ---------------------------------------------------------------------------
# TODO: Command intercepts (deferred)
# ---------------------------------------------------------------------------
#
# Idea: wrap PyMOL's built-in ``remove`` / ``load`` / ``delete`` commands via
# ``cmd.extend`` so that user actions in the PyMOL console stay mirrored into
# the plugin's ``STATE`` (arrays + index maps) without the user having to go
# through ``aw_*`` commands:
#
#   - ``remove <sel>`` → translate selection to atom indices, drop those atoms
#     from the tracked AtomArrayPlus, and rebuild the index map.
#   - ``load <file>`` → if the file is CIF-like, parse it with AtomWorks and
#     register the resulting AtomArrayPlus under the new object name.
#   - ``delete <name>`` / ``delete all`` → clear the matching entry (or all
#     entries) from ``STATE``.
#
# Removed for now: keeping array state consistent with arbitrary PyMOL
# mutations is subtle (reorderings, partial matches, error propagation,
# recursion via our own ``cmd.load_raw`` path) and not worth the complexity
# at this stage. Revisit once the core plugin surface stabilizes.
