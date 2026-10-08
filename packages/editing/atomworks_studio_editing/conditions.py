"""Editors for public AtomWorks conditions, available without a model provider."""

from types import MappingProxyType

from atomworks.io.utils.standard_annotations.base import Level
from atomworks.ml.conditions import C_CRD, C_CTR, C_DIS, C_IDX, C_NTR, C_SEQ

from .contracts import ConditionDefinition, NeutralConditionProvider


class AtomWorksConditionProvider(NeutralConditionProvider):
    definitions = tuple(
        ConditionDefinition(
            key=condition.name.replace("-", "_"),
            label=label,
            kind="pair" if condition is C_DIS else "mask",
            level=condition.level,
            count_unit="pairs" if condition is C_DIS else "residues" if condition.level == Level.RESIDUE else "atoms",
            default=True if condition is C_IDX else False,
            invert_mask=condition is C_IDX,
            condition=condition,
        )
        for condition, label in (
            (C_SEQ, "Sequence conditioning"),
            (C_CRD, "Coordinate conditioning"),
            (C_IDX, "Index conditioning"),
            (C_DIS, "Distance restraints"),
            (C_NTR, "N-terminus"),
            (C_CTR, "C-terminus"),
        )
    )
    definitions_by_name = MappingProxyType(
        {
            name: definition
            for definition in definitions
            for name in {
                definition.key,
                definition.condition.name,
                definition.condition.full_name,
                *definition.condition.aliases,
            }
        }
    )


CONDITION_PROVIDER = AtomWorksConditionProvider()
