"""Shared RFD4 annotation adapter for every Studio interface."""

from __future__ import annotations

import numpy as np
from atomworks.io.utils.atom_array_plus import AtomArrayPlus
from atomworks.ml.conditions import C_CRD
from atomworks_studio_editing.contracts import (
    ConditionDefinition,
    ConditionOperation,
    ConditionProvider,
    ValidationProvider,
)

from atomworks_studio_rfd4.reporting import sync_index_groups

from .condition_contract import CONDITION_DEFINITIONS, CONDITION_DEFINITIONS_BY_NAME
from .interactive_validation import validate_rfd4
from .internal_coordinate import (
    clear_internal_coordinate_targets,
    separate_coordinate_groups,
    set_internal_coordinate_conditioning,
)
from .model import C_CRDGRP, C_INTCRD, conditions


class RFD4ConditionProvider(ConditionProvider):
    """Expose RFD4's shared annotation editing contract to Studio."""

    definitions: tuple[ConditionDefinition, ...] = CONDITION_DEFINITIONS
    definitions_by_name = CONDITION_DEFINITIONS_BY_NAME

    def condition_edit_is_noop(self, operation: str, before: AtomArrayPlus, after: AtomArrayPlus) -> bool:
        definition = self.definitions_by_name.get(operation)
        key = definition.key if definition is not None else operation
        if definition is not None and definition.group_editor and key != "coordinate_group":
            return np.array_equal(
                definition.condition.annotation(before, default="generate"),
                definition.condition.annotation(after, default="generate"),
            )
        if key not in {"coordinate", "coordinate_group", "set_internal_coordinate_conditioning"}:
            return False
        return all(
            np.array_equal(
                condition.annotation(before, default="generate"),
                condition.annotation(after, default="generate"),
                equal_nan=True,
            )
            for condition in (C_CRD, C_CRDGRP, C_INTCRD)
        )

    def discarded_target_count(self, before: AtomArrayPlus, after: AtomArrayPlus) -> int:
        original = C_INTCRD.annotation(before, default="generate")
        edited = C_INTCRD.annotation(after, default="generate")
        return int((np.isfinite(original).any(axis=1) & ~np.isfinite(edited).any(axis=1)).sum())

    def prepare_combination(self, arrays: list[AtomArrayPlus]) -> list[AtomArrayPlus]:
        return separate_coordinate_groups(arrays)

    def after_condition_update(self, name: str, array: AtomArrayPlus) -> None:
        if name == "index":
            sync_index_groups(array)
        if name.startswith("sequence_probability_") or (
            name == "sequence" and hasattr(conditions, "SEQUENCE_PROBABILITY_CONDITIONS")
        ):
            from .sequence_probability import (
                canonicalize_sequence_probabilities,
                check_sequence_probability_conditioning_violations,
            )

            candidate = canonicalize_sequence_probabilities({"atom_array": array.copy()})["atom_array"]
            issues = check_sequence_probability_conditioning_violations(candidate)
            if issues:
                raise ValueError("\n".join(issue.message for issue in issues))


class RFD4ValidationProvider(ValidationProvider):
    """RFD4 annotation checks without the model runtime."""

    def validate(self, array: AtomArrayPlus, *, full_pipeline: bool = False) -> list[dict[str, str]]:
        return validate_rfd4(array, full_pipeline=full_pipeline)


CONDITION_PROVIDER = RFD4ConditionProvider()
VALIDATION_PROVIDER = RFD4ValidationProvider()

# Named coupled operations exposed by the API. Internal-coordinate values are
# deliberately left for RFD4 featurization to materialize.
CONDITION_OPERATIONS: dict[str, ConditionOperation] = {
    "internal_coordinate": set_internal_coordinate_conditioning,
    "clear_internal_targets": clear_internal_coordinate_targets,
}


PYMOL_EDITORS = ("atomworks_studio_rfd4.pymol.editors",)
