"""Document provider contracts shared by local and service-based editors."""

from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from types import MappingProxyType
from typing import Literal, Protocol

from atomworks.io.utils.atom_array_plus import AtomArrayPlus
from atomworks.io.utils.standard_annotations.base import Level
from atomworks.ml.conditions.base import ConditionBase

ConditionKind = Literal["mask", "enum", "integer", "scalar", "vector3", "pair", "operation", "text"]
CountUnit = Literal["atoms", "residues", "chains", "groups", "pairs"]
ConditionDefault = bool | int | float | str | None
ConditionOperation = Callable[[AtomArrayPlus, Iterable[int], bool], dict[str, object] | None]


class TargetDiscardConfirmationRequiredError(ValueError):
    """An edit would discard saved targets and must be explicitly confirmed."""

    def __init__(self, lost_target_count: int, revision: int):
        self.lost_target_count = lost_target_count
        self.revision = revision
        super().__init__(f"This edit clears saved internal-coordinate targets for {lost_target_count} atoms.")


class DocumentRevisionConflictError(ValueError):
    """A confirmation refers to an earlier version of the document."""

    def __init__(self, expected: int, actual: int):
        self.revision = actual
        super().__init__(f"The structure changed since confirmation (revision {expected} → {actual}); retry the edit.")


@dataclass(frozen=True, slots=True)
class ConditionValue:
    """One named value accepted by an enum-style condition."""

    name: str
    value: int


@dataclass(frozen=True, slots=True)
class ConditionDefinition:
    """UI-neutral condition metadata and its AtomWorks condition object."""

    key: str
    label: str
    kind: ConditionKind
    level: Level
    count_unit: CountUnit
    default: ConditionDefault
    invert_mask: bool
    condition: type[ConditionBase]
    enum_values: tuple[ConditionValue, ...] = ()
    normalize_value: Callable[[object], object] | None = None
    editor_group: str | None = None
    option_label: str | None = None
    minimum: float | None = None
    maximum: float | None = None
    step: float | None = None
    decimals: int | None = None
    active_mask: Callable[[AtomArrayPlus], object] | None = None
    mutate: Callable[[AtomArrayPlus, object, bool, object], None] | None = None
    visible: bool = True
    group_editor: bool = False
    reserved_group_ids: tuple[int, ...] = ()

    @property
    def schema(self) -> dict[str, object]:
        """Return the JSON-facing editor schema without duplicated stored state."""
        schema: dict[str, object] = {
            "kind": self.kind,
            "level": self.level.value,
            "default": self.default,
            "label": self.label,
            "group_editor": self.group_editor,
            "invert_mask": self.invert_mask,
        }
        for field in ("editor_group", "option_label", "minimum", "maximum", "step", "decimals"):
            if (value := getattr(self, field)) is not None:
                schema[field] = value
        if self.enum_values:
            schema["values"] = {member.name: member.value for member in self.enum_values}
        return schema


class ConditionProvider(Protocol):
    """Supplies model-specific conditions without coupling the editor core."""

    @property
    def definitions(self) -> tuple[ConditionDefinition, ...]: ...

    @property
    def definitions_by_name(self) -> Mapping[str, ConditionDefinition]: ...

    def after_condition_update(self, name: str, array: AtomArrayPlus) -> None: ...


class ValidationProvider(Protocol):
    """Runs model-specific checks after the editor's generic validation."""

    def validate(self, array: AtomArrayPlus, *, full_pipeline: bool = False) -> list[dict[str, str]]: ...


class NeutralConditionProvider:
    """Condition provider for model-neutral document operations."""

    definitions: tuple[ConditionDefinition, ...] = ()
    definitions_by_name: Mapping[str, ConditionDefinition] = MappingProxyType({})

    def after_condition_update(self, name: str, array: AtomArrayPlus) -> None:
        del name, array


class NeutralValidationProvider:
    """Validation provider that adds no model-specific checks."""

    def validate(self, array: AtomArrayPlus, *, full_pipeline: bool = False) -> list[dict[str, str]]:
        del array, full_pipeline
        return []


NEUTRAL_CONDITION_PROVIDER = NeutralConditionProvider()
NEUTRAL_VALIDATION_PROVIDER = NeutralValidationProvider()
