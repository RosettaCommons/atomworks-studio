"""Session errors and shared document contracts."""

from __future__ import annotations

from atomworks_studio_editing.contracts import (
    NEUTRAL_CONDITION_PROVIDER as NEUTRAL_CONDITION_PROVIDER,
)
from atomworks_studio_editing.contracts import (
    NEUTRAL_VALIDATION_PROVIDER as NEUTRAL_VALIDATION_PROVIDER,
)
from atomworks_studio_editing.contracts import (
    ConditionDefault as ConditionDefault,
)
from atomworks_studio_editing.contracts import (
    ConditionDefinition as ConditionDefinition,
)
from atomworks_studio_editing.contracts import (
    ConditionKind as ConditionKind,
)
from atomworks_studio_editing.contracts import (
    ConditionOperation as ConditionOperation,
)
from atomworks_studio_editing.contracts import (
    ConditionProvider as ConditionProvider,
)
from atomworks_studio_editing.contracts import (
    ConditionValue as ConditionValue,
)
from atomworks_studio_editing.contracts import (
    CountUnit as CountUnit,
)
from atomworks_studio_editing.contracts import (
    NeutralConditionProvider as NeutralConditionProvider,
)
from atomworks_studio_editing.contracts import (
    NeutralValidationProvider as NeutralValidationProvider,
)
from atomworks_studio_editing.contracts import (
    ValidationProvider as ValidationProvider,
)


class SessionNotFoundError(KeyError):
    """A session store could not resolve a session for the current owner."""


class CapacityExceededError(RuntimeError):
    """A bounded local or shared resource has reached its configured limit."""
