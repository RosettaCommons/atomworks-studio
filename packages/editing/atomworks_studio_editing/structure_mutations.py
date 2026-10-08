"""Shared in-place structure mutations used by desktop and web editors.

Moved into atomworks-studio (from atomworks ``io.utils.structure_mutations``, commit
8e4b2c39) so these editor primitives live with the editors that use them -- the web API
(annotation_studio) and the PyMOL plugin.
"""

import itertools
from collections.abc import Iterable
from typing import Literal

import biotite.structure as struc
import numpy as np
from atomworks.io.transforms.atom_array import add_id_and_entity_annotations, add_iid_annotations
from atomworks.io.utils.atom_array_plus import AtomArrayPlus


def _indices(array: AtomArrayPlus, indices: Iterable[int]) -> np.ndarray:
    selected = np.unique(np.fromiter(indices, dtype=np.int64))
    if len(selected) == 0:
        raise ValueError("at least one atom must be selected")
    if selected[0] < 0 or selected[-1] >= len(array):
        raise IndexError(f"atom index outside [0, {len(array) - 1}]")
    return selected


def refresh_chain_derived_annotations(array: AtomArrayPlus) -> None:
    """Rebuild every annotation derived from ``chain_id``."""
    if "chain_id" not in array.get_annotation_categories():
        raise ValueError("AtomArray has no 'chain_id' annotation")
    add_id_and_entity_annotations(array, overwrite=True)
    if "transformation_id" not in array.get_annotation_categories():
        array.set_annotation("transformation_id", np.full(len(array), "1"))
    add_iid_annotations(array, overwrite=True)
    if "label_entity_id" in array.get_annotation_categories():
        array.set_annotation("label_entity_id", (array.chain_entity + 1).astype(np.int32))


def assign_chain_id(array: AtomArrayPlus, indices: Iterable[int], chain_id: str) -> None:
    """Assign atoms to a chain and atomically refresh dependent annotations."""
    normalized_chain_id = chain_id.strip()
    if not normalized_chain_id:
        raise ValueError("chain_id must not be empty")
    selected = _indices(array, indices)
    chain_ids = array.chain_id.copy()
    chain_ids[selected] = normalized_chain_id
    array.set_annotation("chain_id", chain_ids)
    refresh_chain_derived_annotations(array)


def set_formal_charge(
    array: AtomArrayPlus,
    indices: Iterable[int],
    *,
    value: int | None = None,
    delta: int | None = None,
) -> None:
    """Set or adjust formal charge on selected atoms."""
    selected = _indices(array, indices)
    if (value is None) == (delta is None):
        raise ValueError("provide exactly one of value or delta")
    if "charge" not in array.get_annotation_categories():
        array.set_annotation("charge", np.zeros(len(array), dtype=int))
    if value is not None:
        array.charge[selected] = int(value)
    else:
        assert delta is not None
        array.charge[selected] += int(delta)


def edit_bond(
    array: AtomArrayPlus,
    atom1: int,
    atom2: int,
    action: Literal["add", "remove"],
    bond_type: struc.BondType = struc.BondType.SINGLE,
) -> None:
    """Add or remove one bond using the shared desktop/web semantics."""
    selected = _indices(array, (atom1, atom2))
    if len(selected) != 2:
        raise ValueError("a bond requires two different atoms")
    if array.bonds is None:
        array.bonds = struc.BondList(len(array))
    if action == "add":
        array.bonds.add_bond(int(selected[0]), int(selected[1]), bond_type)
    elif action == "remove":
        array.bonds.remove_bond(int(selected[0]), int(selected[1]))
    else:
        raise ValueError(f"unsupported bond action: {action}")


def _last_kept_residue_start_by_chain(
    array: AtomArrayPlus,
    keep: np.ndarray,
    bounds: np.ndarray,
) -> dict[str, int]:
    last_kept: dict[str, int] = {}
    for start, stop in itertools.pairwise(bounds):
        if keep[start:stop].any():
            last_kept[str(array.chain_iid[start])] = int(start)
    return last_kept


def deletion_would_create_res_id_gap(array: AtomArrayPlus, keep: np.ndarray) -> bool:
    """Return whether a deletion mask leaves an internal residue-ID gap."""
    if "chain_iid" not in array.get_annotation_categories():
        return False
    bounds = struc.get_residue_starts(array, add_exclusive_stop=True)
    last_kept = _last_kept_residue_start_by_chain(array, keep, bounds)
    return any(
        not keep[start:stop].any() and start < last_kept.get(str(array.chain_iid[start]), -1)
        for start, stop in itertools.pairwise(bounds)
    )


def delete_atoms(
    array: AtomArrayPlus,
    keep: np.ndarray,
    *,
    close_res_id_gaps: bool = False,
) -> AtomArrayPlus:
    """Return an array with masked atoms removed and optional gap closing."""
    if keep.shape != (len(array),) or keep.dtype != np.bool_:
        raise ValueError("keep must be a boolean mask matching the atom count")
    if not keep.any():
        raise ValueError("cannot delete every atom")
    if not close_res_id_gaps or "chain_iid" not in array.get_annotation_categories():
        return array[keep]

    bounds = struc.get_residue_starts(array, add_exclusive_stop=True)
    last_kept = _last_kept_residue_start_by_chain(array, keep, bounds)
    adjusted = array.res_id.copy()
    shifts: dict[str, int] = {}
    for start, stop in itertools.pairwise(bounds):
        chain = str(array.chain_iid[start])
        shift = shifts.get(chain, 0)
        if not keep[start:stop].any():
            if start < last_kept.get(chain, -1):
                shifts[chain] = shift + 1
            continue
        adjusted[start:stop] = array.res_id[start:stop] - shift
    result = array[keep]
    result.res_id = adjusted[keep]
    return result
