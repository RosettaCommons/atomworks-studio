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


def rigid_transform(
    array: AtomArrayPlus,
    indices: Iterable[int],
    *,
    translation: Iterable[float] = (0.0, 0.0, 0.0),
    rotation_axis: Iterable[float] | None = None,
    rotation_angle: float = 0.0,
    center: Iterable[float] | None = None,
    coupled: Iterable[np.ndarray] = (),
) -> int:
    """Move selected atoms as one rigid body: rotate about `center`, then translate.

    Rotation uses Rodrigues' formula about `center` (the selection's own centroid when None), so the body turns in
    place rather than swinging around the origin. Atoms without coordinates keep their NaN: they have no position to
    move, and writing one would invent a coordinate the document says is unknown. Returns the number of atoms moved.

    `coupled` holds (n, 3) annotations that are positions in the same frame -- saved coordinate conditioning, whose
    stored values are what a model builds from. They are moved with the atoms, on the selected rows where they are
    set, so the structure and what it conditions cannot drift apart. The pivot is always the atoms' own centroid,
    not each array's, so one motion applies to all of them.
    """
    selected = _indices(array, indices)
    shift = np.asarray(list(translation), dtype=np.float64)
    if shift.shape != (3,) or not np.isfinite(shift).all():
        raise ValueError("translation must be three finite numbers")

    rotation = np.eye(3)
    if rotation_axis is not None:
        axis = np.asarray(list(rotation_axis), dtype=np.float64)
        if axis.shape != (3,) or not np.isfinite(axis).all():
            raise ValueError("rotation axis must be three finite numbers")
        if not np.isfinite(rotation_angle):
            raise ValueError("rotation angle must be a finite number")
        norm = float(np.linalg.norm(axis))
        if norm == 0.0:
            raise ValueError("rotation axis must not be zero length")
        axis = axis / norm
        cos_angle = float(np.cos(rotation_angle))
        sin_angle = float(np.sin(rotation_angle))
        cross = np.array(
            [[0.0, -axis[2], axis[1]], [axis[2], 0.0, -axis[0]], [-axis[1], axis[0], 0.0]],
            dtype=np.float64,
        )
        rotation = np.eye(3) + sin_angle * cross + (1.0 - cos_angle) * (cross @ cross)

    # Only positioned atoms can move, and only they define the pivot.
    positioned = selected[np.isfinite(array.coord[selected]).all(axis=1)]
    coupled_arrays = list(coupled)
    if len(positioned) == 0 and not coupled_arrays:
        return 0
    if len(positioned):
        pivot_source = array.coord[positioned].astype(np.float64)
    else:
        # Nothing positioned, but saved conditioning still holds places worth moving: pivot on those instead.
        finite = [extra[selected][np.isfinite(extra[selected]).all(axis=1)] for extra in coupled_arrays]
        stacked = np.concatenate([rows for rows in finite if len(rows)]) if any(len(r) for r in finite) else None
        if stacked is None:
            return 0
        pivot_source = stacked.astype(np.float64)
    pivot = pivot_source.mean(axis=0) if center is None else np.asarray(list(center), dtype=np.float64)
    if pivot.shape != (3,) or not np.isfinite(pivot).all():
        raise ValueError("center must be three finite numbers")

    def moved(points: np.ndarray) -> np.ndarray:
        return (points.astype(np.float64) - pivot) @ rotation.T + pivot + shift

    if len(positioned):
        array.coord[positioned] = moved(array.coord[positioned]).astype(array.coord.dtype)
    for extra in coupled_arrays:
        if extra.shape != (len(array), 3):
            raise ValueError("coupled annotations must have shape (n_atoms, 3)")
        rows = selected[np.isfinite(extra[selected]).all(axis=1)]
        if len(rows):
            extra[rows] = moved(extra[rows]).astype(extra.dtype)
    return len(positioned)
