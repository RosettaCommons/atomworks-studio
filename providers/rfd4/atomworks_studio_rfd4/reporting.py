"""Headless summaries and index-group synchronization for editable RFD4 conditions."""

from enum import IntEnum

import numpy as np
from atomworks.io.utils.atom_array_plus import AnnotationList2D, AtomArrayPlus
from atomworks.io.utils.selection import get_residue_starts
from atomworks.io.utils.standard_annotations.base import STANDARD_ANNOTATIONS, Level
from atomworks.ml.conditions import C_CRD, C_IDX, C_SEQ
from atomworks.ml.conditions.base import ConditionBase
from atomworks_studio_editing.annotations import editing_type, has_stored_mask

from atomworks_studio_rfd4.model import (
    C_CENTROID,
    C_CRDGRP,
    C_HB,
    C_HOT,
    C_IDXGRP,
    C_INTCRD,
    C_RAS,
    C_SEC,
)


def _index_group_summary(arr: AtomArrayPlus) -> list[str]:
    if not C_IDXGRP.has_annotation(arr):
        return []
    groups = C_IDXGRP.annotation(arr, default="raise")
    n_groups = len(np.unique(groups))
    lines = [f'Index groups: {n_groups} groups  (check "Color by index group" in atomworks studio viewer)']
    # Report implied res_id gaps within unindexed groups so the user can confirm
    # that non-contiguous regions were split as intended (rather than collapsed
    # into one group with fixed-size gaps).
    if has_stored_mask(C_IDX, arr):
        is_indexed = C_IDX.mask(arr, default="generate")
        res_id = arr.res_id
        for gid in np.unique(groups):
            in_group = groups == gid
            if is_indexed[in_group].any():
                continue  # indexed group — index offsets are externally defined
            gid_res = np.unique(res_id[in_group])
            if len(gid_res) > 1 and np.any(np.diff(np.sort(gid_res)) > 1):
                lines.append(
                    f"  unindexed group {int(gid)} contains non-sequential res_ids: "
                    "these gaps will be preserved in the output. If this is not desired, "
                    "please adjust the index groups accordingly."
                )
    return ["\n".join(lines)]


def _coord_group_summary(arr: AtomArrayPlus) -> list[str]:
    if not C_CRDGRP.has_annotation(arr):
        return []
    n_groups = len(np.unique(C_CRDGRP.annotation(arr, default="raise")))
    return [f'Coordinate groups: {n_groups} groups  (check "Color by coord group" view)']


def _chain_centroid_summary(arr: AtomArrayPlus) -> list[str]:
    if not C_CENTROID.has_annotation(arr):
        return []
    mask = C_CENTROID.mask(arr, default="generate")
    if not mask.any():
        return []
    annot = C_CENTROID.annotation(arr, default="generate")
    lines = ["Chain centroid:"]
    for chain_id in np.unique(arr.chain_iid[mask]):
        xyz = annot[mask & (arr.chain_iid == chain_id)][0]
        lines.append(f"  {chain_id}: ({xyz[0]:.3f}, {xyz[1]:.3f}, {xyz[2]:.3f})")
    return ["\n".join(lines)]


_SUMMARY_LABELS = {
    C_SEQ: "Sequence",
    C_CRD: "Coordinates",
    C_IDX: "Index",
    C_HOT: "Hotspot",
    C_RAS: "RASA",
    C_SEC: "Secondary structure",
    C_HB: "Hydrogen bonds",
    C_INTCRD: "Internal coordinates",
}
_CUSTOM_SUMMARIES = {
    C_IDXGRP: _index_group_summary,
    C_CRDGRP: _coord_group_summary,
    C_CENTROID: _chain_centroid_summary,
}
_HOST_SUMMARIZED = frozenset({C_SEQ, C_CRD})
_NO_SUMMARY = frozenset({C_IDX})


def editable_conditions() -> tuple[type[ConditionBase], ...]:
    """Return the imported Conditions that opt into the shared editing contract."""
    return tuple(
        annotation
        for annotation in STANDARD_ANNOTATIONS
        if issubclass(annotation, ConditionBase) and editing_type(annotation) is not None
    )


def _mask_summary(condition: type[ConditionBase], arr: AtomArrayPlus) -> list[str]:
    if condition is C_INTCRD and hasattr(C_CRDGRP, "is_internal"):
        mask = C_CRDGRP.is_internal(arr)
    elif has_stored_mask(condition, arr):
        mask = condition.mask(arr, default="generate")
    else:
        return []
    values, unit = _summary_values(condition, arr, mask.values if isinstance(mask, AnnotationList2D) else mask)
    if not values.any():
        return []
    label = _SUMMARY_LABELS.get(condition, condition.name)
    return [f"{label}: {int(values.sum())} {unit}"]


def _summary_values(condition: type[ConditionBase], arr: AtomArrayPlus, values: np.ndarray) -> tuple[np.ndarray, str]:
    """Return values and units at the condition's authoring level."""
    if condition.n_body == 2:
        return values, "pairs"
    if condition.level == Level.RESIDUE:
        return values[get_residue_starts(arr)], "residues"
    return values, "atoms"


def _enum_summary(condition: type[ConditionBase], arr: AtomArrayPlus, enum_cls: type[IntEnum]) -> list[str]:
    if not condition.has_annotation(arr):
        return []
    annot = condition.annotation(arr, default="raise")
    mask = condition.mask(arr, default="generate")
    annot_values = annot.values if isinstance(annot, AnnotationList2D) else annot
    mask_values = mask.values if isinstance(mask, AnnotationList2D) else mask
    annot_values, unit = _summary_values(condition, arr, annot_values)
    mask_values, _ = _summary_values(condition, arr, mask_values)
    section: list[str] = []
    null_value = next(iter(enum_cls)).value
    for enum_val in enum_cls:
        if enum_val.value == null_value:
            continue
        value_mask = mask_values & (annot_values == enum_val.value)
        if not value_mask.any():
            continue
        section.append(f"  {enum_val.name}: {int(value_mask.sum())} {unit}")
    if not section:
        return []
    label = _SUMMARY_LABELS.get(condition, condition.name)
    return [f"{label}:\n" + "\n".join(section)]


def summarize_conditions(arr: AtomArrayPlus, *, include_host_summarized: bool = False) -> str:
    """Summarize every imported condition that declares an editing type.

    Args:
      arr: The annotated structure to summarize.
      include_host_summarized: Also emit lines for conditions an embedding
        application reports through its own summary hook. Leave ``False`` inside
        PyMOL, where AtomWorks' hook already lists them; pass ``True`` when this
        report is the only one the user sees.
    """
    lines: list[str] = []
    for condition in editable_conditions():
        if condition in _NO_SUMMARY:
            continue
        if condition in _HOST_SUMMARIZED and not include_host_summarized:
            continue
        if condition in _CUSTOM_SUMMARIES:
            lines.extend(_CUSTOM_SUMMARIES[condition](arr))
        elif isinstance(edit_type := editing_type(condition), type) and issubclass(edit_type, IntEnum):
            lines.extend(_enum_summary(condition, arr, edit_type))
        else:
            lines.extend(_mask_summary(condition, arr))
    return "\n\n".join(lines)


# ---------------------------------------------------------------------------
# Index group sync (pure logic behind the Qt-coupled `_IndexMaskEditor`)
# ---------------------------------------------------------------------------


def sync_index_groups(arr: AtomArrayPlus, preserve_manual_edits: bool = True) -> None:
    """Recompute :py:data:`~rfproteina.conditions.C_IDXGRP` in place on ``arr``.

    Enforces mandatory split points (molecule boundaries and ``C_IDX``
    transitions) while optionally preserving any manual group subdivisions
    already present.

    Args:
      arr: Structure to update in place.
      preserve_manual_edits: If ``True`` (default), two atoms keep sharing a
        group iff they already share both the default group and the current
        group. If ``False``, groups are fully reset to the default split.
    """
    default_groups = C_IDXGRP.default_annotation(arr)
    if preserve_manual_edits and C_IDXGRP.has_annotation(arr):
        current_groups = C_IDXGRP.annotation(arr, default="raise")
        combined = np.stack([default_groups, current_groups], axis=1)
        _, new_groups = np.unique(combined, axis=0, return_inverse=True)
    else:
        new_groups = default_groups
    C_IDXGRP.set_annotation(arr, new_groups)
