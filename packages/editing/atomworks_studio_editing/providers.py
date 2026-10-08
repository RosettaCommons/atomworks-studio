"""Load the same annotation contract in every Studio interface."""

from collections.abc import Mapping
from dataclasses import dataclass, field
from functools import cache
from importlib.metadata import entry_points

from .conditions import CONDITION_PROVIDER
from .contracts import NEUTRAL_VALIDATION_PROVIDER, ConditionOperation, ConditionProvider, ValidationProvider


@dataclass(frozen=True)
class AnnotationProviders:
    condition_provider: ConditionProvider = CONDITION_PROVIDER
    validation_provider: ValidationProvider = NEUTRAL_VALIDATION_PROVIDER
    condition_operations: Mapping[str, ConditionOperation] = field(default_factory=dict)
    pymol_editors: tuple[str, ...] = ()


@cache
def load_providers() -> AnnotationProviders:
    """Use installed definitions, falling back to public AtomWorks when none are installed.

    Fail visibly on a broken installation instead of silently removing annotations.
    """
    entries = list(entry_points(group="atomworks_studio.annotations"))
    if not entries:
        return AnnotationProviders()
    if len(entries) != 1:
        raise RuntimeError("Studio expects one annotation provider; remove conflicting installations")
    module = entries[0].load()
    return AnnotationProviders(
        module.CONDITION_PROVIDER,
        getattr(module, "VALIDATION_PROVIDER", NEUTRAL_VALIDATION_PROVIDER),
        getattr(module, "CONDITION_OPERATIONS", {}),
        tuple(getattr(module, "PYMOL_EDITORS", ())),
    )
