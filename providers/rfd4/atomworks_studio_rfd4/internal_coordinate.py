"""Mask/group-only authoring for RFD4 internal-coordinate conditioning."""

from __future__ import annotations

from collections.abc import Iterable

import numpy as np
from atomworks.io.utils.atom_array_plus import AtomArrayPlus
from atomworks.ml.conditions import C_CRD

from atomworks_studio_rfd4.model import C_CRDGRP, C_INTCRD, conditions


def clear_internal_coordinate_targets(array, atom_indices, _enabled=True) -> None:
    """Clear saved targets throughout selected internal groups, retaining membership."""
    groups = C_CRDGRP.annotation(array, default="generate")
    selected_groups = np.unique(groups[list(atom_indices)])
    selected_groups = selected_groups[selected_groups > C_CRDGRP.KNOWN_ABSOLUTE_COORDS]
    affected = np.isin(groups, selected_groups)
    values = C_INTCRD.annotation(array, default="generate").copy()
    if not np.isfinite(values[affected]).any():
        raise ValueError("The selected internal-coordinate groups have no saved targets to clear.")
    values[affected] = np.nan
    C_INTCRD.set_annotation(array, values)


def edit_absolute_coordinates(array, indices, enabled, value) -> None:
    """Keep reserved group membership consistent with absolute targets."""
    groups = C_CRDGRP.annotation(array, default="generate").copy()
    internal = C_CRDGRP.is_internal(array)
    coordinates = C_CRD.annotation(array, default="generate").copy()
    coordinates[indices] = array.coord[indices] if enabled else C_CRD.default_annotation(array)[indices]
    C_CRD.set_annotation(array, coordinates)
    affected = indices if enabled else indices[~internal[indices]]
    groups[affected] = C_CRDGRP.default_annotation(array)[affected]
    C_CRDGRP.set_annotation(array, groups, on_internal_coord_mismatch="clear")


def edit_coordinate_group(array, indices, enabled, value) -> None:
    """Assign internal groups, clearing selected absolute targets in the same edit."""
    group = value if enabled else C_CRDGRP.UNKNOWN_COORDS
    if isinstance(group, bool) or not isinstance(group, int):
        raise ValueError("coordinate_group requires an integer value")
    if enabled and group <= C_CRDGRP.KNOWN_ABSOLUTE_COORDS:
        raise ValueError(
            "Choose a positive internal coordinate group; absolute coordinates are managed by Coordinate conditioning."
        )
    groups = C_CRDGRP.annotation(array, default="generate").copy()
    if enabled:
        coordinates = C_CRD.annotation(array, default="generate").copy()
        coordinates[indices] = C_CRD.default_annotation(array)[indices]
        C_CRD.set_annotation(array, coordinates)
    groups[indices] = C_CRDGRP.default_annotation(array)[indices] if not enabled else group
    C_CRDGRP.set_annotation(array, groups, on_internal_coord_mismatch="clear")


def set_internal_coordinate_conditioning(
    array: AtomArrayPlus,
    atom_indices: Iterable[int],
    enabled: bool,
) -> dict[str, object]:
    """Set mask-authored internal-coordinate conditioning on selected atoms.

    Editors leave unset ``C_INTCRD`` targets for featurization. Current RFD4
    preserves whole-group targets and clears invalidated targets on a candidate.
    The document requires confirmation before committing target loss.
    """
    mask = np.zeros(len(array), dtype=bool)
    mask[list(atom_indices)] = True
    selected_count = int(mask.sum())
    affected_count = int((mask & np.isfinite(array.coord).all(axis=1)).sum()) if enabled else selected_count
    skipped = selected_count - affected_count
    message = (
        f"Marked {affected_count} atoms for internal coordinates."
        if enabled
        else f"Unset internal coordinates on {affected_count} atoms."
    )
    if skipped:
        message += f" ({skipped} unresolved atom(s) in the selection were skipped.)"
    result = {"affected_count": affected_count, "skipped_count": skipped, "message": message}
    if hasattr(conditions, "set_internal_coord_conditioning"):
        conditions.set_internal_coord_conditioning(array, mask, enabled, require_nonempty=enabled)
        return result
    if enabled:
        mask &= np.isfinite(array.coord).all(axis=1)
        if not mask.any():
            raise ValueError("no selected atoms have resolved coordinates")
    groups = C_CRDGRP.annotation(array, default="generate").copy()
    coordinates = C_CRD.annotation(array, default="generate").copy()
    coordinates[mask] = C_CRD.default_annotation(array)[mask]
    groups[mask] = max(1, int(groups.max()) + 1) if enabled else C_CRDGRP.UNKNOWN_COORDS
    C_CRD.set_annotation(array, coordinates)
    C_CRDGRP.set_annotation(array, groups, on_internal_coord_mismatch="clear")
    return result


def separate_coordinate_groups(arrays):
    """Give independent inputs disjoint group IDs, preserving complete saved targets."""
    result = []
    next_id = 1
    for original in arrays:
        array = original.copy()
        groups = C_CRDGRP.annotation(array, default="generate").copy()
        old = groups.copy()
        internal = groups > C_CRDGRP.KNOWN_ABSOLUTE_COORDS
        if C_INTCRD.has_annotation(array) and not np.isnan(C_INTCRD.annotation(array)[~internal]).all():
            raise ValueError("Internal coordinate targets exist outside internal coordinate groups.")
        for group in np.unique(old[internal]):
            groups[old == group] = next_id
            next_id += 1
        C_CRDGRP.set_annotation(array, groups)
        result.append(array)
    return result
