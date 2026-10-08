"""Headless mutation helpers for built-in conditions.

Moved into atomworks-studio (from atomworks ``ml.conditions.mutations``, commit 8e4b2c39)
as a shared editor primitive; see :mod:`atomworks_studio_editing.structure_mutations`.
"""

from typing import Literal

import numpy as np
from atomworks.io.utils.atom_array_plus import AnnotationList2D, AtomArrayPlus
from atomworks.io.utils.standard_annotations.base import StandardAnnotationBase
from atomworks.ml.conditions.definitions import Distance

from atomworks_studio_editing.annotations import is_structure_derived, set_annotation_mask


def set_condition_mask(
    atom_array: AtomArrayPlus,
    condition: type[StandardAnnotationBase],
    indices: np.ndarray,
    enabled: bool,
    *,
    invert: bool = False,
) -> None:
    """Set a condition mask and materialize any declared structure-derived value."""
    mask_value = not enabled if invert else enabled
    mask = np.asarray(condition.mask(atom_array, default="generate")).copy()
    mask[indices] = mask_value
    set_annotation_mask(condition, atom_array, mask)

    if not mask_value or not is_structure_derived(condition):
        return
    ground_truth_value = getattr(condition, "ground_truth_value", None)
    source = ground_truth_value(atom_array) if ground_truth_value is not None else None
    if source is None:
        return
    annotation = np.asarray(condition.annotation(atom_array, default="generate")).copy()
    annotation[indices] = source[indices]
    condition.set_annotation(atom_array, annotation)


def replace_distance_restraints(
    atom_array: AtomArrayPlus,
    pairs: np.ndarray | list[tuple[int, int]],
    values: np.ndarray | list[float],
) -> None:
    """Replace C_DIS with validated, canonical, unique atom pairs.

    Repeated or reversed pairs use the last supplied value. Empty inputs clear
    the annotation.
    """
    pair_array = np.asarray(pairs, dtype=np.int64)
    value_array = np.asarray(values, dtype=float)
    if pair_array.size == 0:
        pair_array = np.empty((0, 2), dtype=np.int32)
    if pair_array.ndim != 2 or pair_array.shape[1] != 2:
        raise ValueError("distance restraint pairs must have shape (n, 2)")
    if value_array.ndim != 1 or len(value_array) != len(pair_array):
        raise ValueError("distance restraint values must match the number of pairs")
    if np.any(pair_array < 0) or np.any(pair_array >= len(atom_array)):
        raise IndexError(f"distance restraint atom index outside [0, {len(atom_array) - 1}]")
    if np.any(pair_array[:, 0] == pair_array[:, 1]):
        raise ValueError("a distance restraint requires two different atoms")
    if not np.isfinite(value_array).all() or np.any(value_array <= 0):
        raise ValueError("distance must be a positive finite number")

    canonical: dict[tuple[int, int], float] = {}
    for pair, value in zip(pair_array, value_array, strict=True):
        key = tuple(sorted((int(pair[0]), int(pair[1]))))
        canonical[key] = float(value)

    canonical_pairs = np.asarray(list(canonical), dtype=np.int32)
    if canonical_pairs.size == 0:
        canonical_pairs = np.empty((0, 2), dtype=np.int32)
    Distance.set_annotation(
        atom_array,
        AnnotationList2D(
            len(atom_array),
            pairs=canonical_pairs,
            values=np.asarray(list(canonical.values()), dtype=float),
        ),
    )


def edit_distance_restraint(
    atom_array: AtomArrayPlus,
    atom1: int,
    atom2: int,
    action: Literal["set", "remove"],
    distance: float | None = None,
) -> None:
    """Set or remove one symmetric C_DIS pair."""
    pair = tuple(sorted((int(atom1), int(atom2))))
    if pair[0] == pair[1]:
        raise ValueError("a distance restraint requires two different atoms")

    annotation = Distance.annotation(atom_array, default="generate")
    retained: dict[tuple[int, int], float] = {}
    for existing, value in zip(annotation.pairs, annotation.values, strict=True):
        existing_pair = tuple(sorted((int(existing[0]), int(existing[1]))))
        if existing_pair != pair:
            retained[existing_pair] = float(value)

    if action == "set":
        if distance is None:
            raise ValueError("distance must be a positive finite number")
        retained[pair] = float(distance)
    elif action != "remove":
        raise ValueError(f"unsupported distance restraint action: {action}")

    replace_distance_restraints(atom_array, list(retained), list(retained.values()))
