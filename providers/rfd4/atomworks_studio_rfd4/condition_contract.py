"""Own Studio's authoring schema over upstream scientific annotation definitions.

Value storage, aliases, levels and body order remain scientific contracts.
Widget kinds, coupled edits, labels and authoring scopes belong to Studio.
The annotation adapter also accepts the earlier separate-mask format.
"""

from __future__ import annotations

import pickle
import re
from enum import IntEnum
from functools import cache
from types import MappingProxyType

import numpy as np
from atomworks.io.utils.standard_annotations.base import STANDARD_ANNOTATIONS, Level
from atomworks.ml.conditions import C_CRD, C_CTR, C_IDX, C_NTR, C_SEQ
from atomworks.ml.conditions.base import ConditionBase
from atomworks_studio_editing.annotations import editing_type, is_boolean, is_structure_derived
from atomworks_studio_editing.contracts import (
    ConditionDefault,
    ConditionDefinition,
    ConditionKind,
    ConditionValue,
    CountUnit,
)

from atomworks_studio_rfd4.internal_coordinate import edit_absolute_coordinates, edit_coordinate_group
from atomworks_studio_rfd4.model import (
    C_CATH,
    C_CENTROID,
    C_CRDGRP,
    C_IDXGRP,
    C_INTCRD,
    C_MCOORD,
    C_NA_SS_STATE,
    C_RAS,
    C_SALT,
    source_root,
)

_KEY_OVERRIDES: dict[type[ConditionBase], str] = {C_RAS: "rasa"}
_LABEL_OVERRIDES: dict[type[ConditionBase], str] = {
    C_SEQ: "Sequence conditioning",
    C_CRD: "Coordinate conditioning",
    C_IDX: "Index conditioning",
    C_RAS: "RASA",
    C_INTCRD: "Internal coordinate",
    C_CENTROID: "Chain centroid",
    C_CATH: "CATH fold",
    C_SALT: "Salt bridge",
    C_MCOORD: "Metal coordination",
    C_NA_SS_STATE: "Nucleic Acid Secondary Structure",
}
_COUNT_UNIT_OVERRIDES: dict[type[ConditionBase], CountUnit] = {
    C_IDXGRP: "groups",
    C_CRDGRP: "groups",
    C_CENTROID: "chains",
}
_DEFAULT_OVERRIDES: dict[type[ConditionBase], ConditionDefault] = {
    C_IDX: True,
    C_IDXGRP: -1,
    C_CRDGRP: -1,
    C_CATH: C_CATH.NULL_VALUE,
}


def editable_condition_classes() -> tuple[type[ConditionBase], ...]:
    """Return conditions supported by Studio's current generic editors.

    Generic pairwise distance annotations are not supported RFD4 inputs.
    Their presence in AtomWorks' registry does not imply model support.
    """
    return tuple(
        annotation
        for annotation in STANDARD_ANNOTATIONS
        if issubclass(annotation, ConditionBase) and _supports_studio_editor(annotation)
    )


def _supports_studio_editor(condition: type[ConditionBase]) -> bool:
    if editing_type(condition) is None or condition.n_body != 1:
        return False
    try:
        condition_kind(condition)
    except TypeError:
        return False
    return True


def condition_key(condition: type[ConditionBase]) -> str:
    """Return a stable snake-case UI key without duplicating semantic aliases."""
    if condition in _KEY_OVERRIDES:
        return _KEY_OVERRIDES[condition]
    if condition.name.startswith("sequence-probability-"):
        return condition.name.replace("-", "_").lower()
    with_word_boundaries = re.sub(r"(?<!^)(?=[A-Z])", "_", condition.name)
    return with_word_boundaries.replace("-", "_").lower()


def enum_type(condition: type[ConditionBase]) -> type[IntEnum] | None:
    edit_type = editing_type(condition)
    return edit_type if isinstance(edit_type, type) and issubclass(edit_type, IntEnum) else None


def condition_kind(condition: type[ConditionBase]) -> ConditionKind:
    """Translate editing_type/editing_is_mask_only into Studio's widget vocabulary."""
    if condition is C_INTCRD:
        # This mask edit also assigns a fresh coordinate group and clears C_CRD.
        return "operation"
    if is_boolean(condition) or is_structure_derived(condition):
        return "mask"
    if enum_type(condition) is not None:
        return "enum"
    edit_type = editing_type(condition)
    if isinstance(edit_type, np.dtype) and edit_type.subdtype is not None:
        _, shape = edit_type.subdtype
        if shape == (3,):
            return "vector3"
    if edit_type is int:
        return "integer"
    if edit_type is float:
        return "scalar"
    if edit_type is str:
        return "text"
    raise TypeError(f"{condition.name} requires a custom Studio editor for {edit_type!r}")


def _condition_default(condition: type[ConditionBase], kind: ConditionKind) -> ConditionDefault:
    if condition in _DEFAULT_OVERRIDES:
        return _DEFAULT_OVERRIDES[condition]
    enum_cls = enum_type(condition)
    if enum_cls is not None:
        return next(iter(enum_cls)).value
    if kind == "mask":
        return False
    return None


def _count_unit(condition: type[ConditionBase]) -> CountUnit:
    if condition in _COUNT_UNIT_OVERRIDES:
        return _COUNT_UNIT_OVERRIDES[condition]
    if condition.level == Level.RESIDUE:
        return "residues"
    if condition.level == Level.CHAIN:
        return "chains"
    return "atoms"


def _enum_values(condition: type[ConditionBase]) -> tuple[ConditionValue, ...]:
    enum_cls = enum_type(condition)
    if enum_cls is None:
        return ()
    return tuple(
        ConditionValue(name=member.name, value=int(member.value)) for member in enum_cls if member.name != "NON_PROTEIN"
    )


def build_condition_definitions() -> tuple[ConditionDefinition, ...]:
    """Build Studio definitions from the live StandardAnnotation registry."""
    definitions = []
    for condition in editable_condition_classes():
        probability = condition.name.startswith("sequence-probability-")
        key = condition_key(condition)
        kind = condition_kind(condition)
        default = _condition_default(condition, kind)
        label = _LABEL_OVERRIDES.get(condition, key.replace("_", " ").title())
        enum_values = _enum_values(condition)
        definitions.append(
            ConditionDefinition(
                key=key,
                label=label,
                kind=kind,
                level=Level.CHAIN if condition is C_CENTROID else condition.level,
                count_unit=_count_unit(condition),
                default=default,
                invert_mask=condition is C_IDX,
                condition=condition,
                visible=condition not in (C_NTR, C_CTR, C_INTCRD),
                group_editor=condition in (C_IDXGRP, C_CRDGRP),
                reserved_group_ids=(-1, 0) if condition is C_CRDGRP else (),
                enum_values=enum_values,
                normalize_value=normalize_cath_label if condition is C_CATH else None,
                editor_group="Sequence probability" if probability else None,
                option_label=condition.token_name if probability else None,
                minimum=0.0 if probability else None,
                maximum=1.0 if probability else None,
                step=0.1 if probability or condition is C_CENTROID else None,
                decimals=2 if probability else 1 if condition is C_CENTROID else None,
                active_mask=getattr(C_CRDGRP, "is_internal", None) if condition is C_INTCRD else None,
                mutate=(
                    {C_CRD: edit_absolute_coordinates, C_CRDGRP: edit_coordinate_group}.get(condition)
                    if hasattr(C_CRDGRP, "is_internal")
                    else None
                ),
            )
        )
    keys = [definition.key for definition in definitions]
    if len(keys) != len(set(keys)):
        raise ValueError(f"Condition editing contract produces duplicate Studio keys: {keys}")
    return tuple(definitions)


@cache
def _cat_vocabulary() -> frozenset[str]:
    path = source_root().parents[1] / "data" / "cath_label_mapping.pkl"
    with path.open("rb") as handle:
        vocabulary = pickle.load(handle)
    return frozenset(
        {
            "x.x.x",
            *(code + ".x" * (2 - depth) for depth, level in enumerate(("C", "A", "T")) for code in vocabulary[level]),
        }
    )


def normalize_cath_label(value: object) -> str:
    """Validate the model's CAT vocabulary and retain its C.A.T.x storage format."""
    if not isinstance(value, str):
        raise ValueError("CATH requires a C.A.T label such as '1.x.x' or '2.60.40'")
    value = value.strip()
    if len(value.split(".")) == 4 and value.endswith(".x"):
        value = value[:-2]
    if value not in _cat_vocabulary():
        raise ValueError(f"Unknown CAT label {value!r}; use a model C/A/T label or 'x.x.x' to clear")
    return value + ".x"


CONDITION_DEFINITIONS = build_condition_definitions()

_definitions_by_name: dict[str, ConditionDefinition] = {}
for definition in CONDITION_DEFINITIONS:
    names = {definition.key, definition.condition.name, definition.condition.full_name, *definition.condition.aliases}
    for name in names:
        if (existing := _definitions_by_name.get(name)) is not None and existing is not definition:
            raise ValueError(
                f"Condition editor name {name!r} resolves to both {existing.key!r} and {definition.key!r}."
            )
        _definitions_by_name[name] = definition
CONDITION_DEFINITIONS_BY_NAME = MappingProxyType(_definitions_by_name)
