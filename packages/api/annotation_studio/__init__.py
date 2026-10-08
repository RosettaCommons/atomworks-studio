"""AtomWorks Studio service and provider contracts.

Keep package imports lightweight so the launch command can show help/version
without initializing AtomWorks, model providers, or a GPU runtime.
"""

from importlib import import_module
from typing import TYPE_CHECKING

from .version import __version__

if TYPE_CHECKING:
    from .contracts import ConditionProvider, ValidationProvider
    from .core import StudioDocument

__all__ = [
    "ConditionProvider",
    "StudioDocument",
    "ValidationProvider",
    "__version__",
]


def __getattr__(name: str):
    if name not in __all__:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    module = ".core" if name == "StudioDocument" else ".contracts"
    value = getattr(import_module(module, __name__), name)
    globals()[name] = value
    return value
