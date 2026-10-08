"""Studio authoring policy over AtomWorks' stored scientific annotations.

These helpers derive editor behavior from the public AtomWorks 3 annotation contract.
"""

from __future__ import annotations

import numpy as np
from atomworks.io.utils.standard_annotations.base import STANDARD_ANNOTATIONS, StandardAnnotationBase


def normalize_annotation_aliases(array) -> None:
    """Canonicalize stored one-body aliases without changing annotation values."""
    categories = set(array.get_annotation_categories())
    for annotation in STANDARD_ANNOTATIONS:
        if annotation.n_body != 1:
            continue
        aliases = categories.intersection(annotation.aliases) - {annotation.full_name}
        if not aliases:
            continue
        values = annotation.annotation(array, default="raise").copy()
        # Directly rename storage: a domain setter may require related fields
        # that have not yet been normalized, or validate an imported invalid input.
        array.set_annotation(annotation.full_name, values)
        for alias in aliases:
            array.del_annotation(alias)


def editing_type(annotation: type[StandardAnnotationBase]):
    if annotation.n_body == 0:
        return None
    if annotation.value_shape:
        return np.dtype((annotation.storage_dtype(), annotation.value_shape))
    if annotation.enum is not None:
        return annotation.enum
    kind = annotation.storage_dtype().kind
    return {"b": bool, "i": int, "u": int, "f": float, "U": str, "S": str}.get(kind)


def is_boolean(annotation: type[StandardAnnotationBase]) -> bool:
    return np.issubdtype(annotation.storage_dtype(), np.bool_)


def is_structure_derived(annotation: type[StandardAnnotationBase]) -> bool:
    return getattr(annotation, "has_ground_truth", False)


def has_stored_mask(annotation, array) -> bool:
    return annotation.has_annotation(array)


def display_mask_name(annotation) -> str:
    return f"mask_{annotation.name}_{annotation.n_body}_{annotation.level.value}"


def default_mask(annotation, array):
    return annotation.mask_from_annotation(annotation.default_annotation(array))


def set_annotation_mask(annotation, array, mask) -> None:
    """Clear inactive values using the annotation's declared defaults."""
    mask = np.asarray(mask, dtype=bool)
    if is_boolean(annotation):
        annotation.set_annotation(array, mask)
        return
    values = annotation.annotation(array, default="generate").copy()
    values[~mask] = annotation.default_annotation(array)[~mask]
    annotation.set_annotation(array, values)
