"""CIF saving shared by the panel's Save button and the ``aw_save`` console command.

Kept free of Qt so console commands can save where the panel cannot be imported.
"""

from collections.abc import Callable
from pathlib import Path

from atomworks.io.utils.atom_array_plus import AtomArrayPlus
from atomworks.io.utils.io_utils import to_cif_file
from atomworks_studio_editing.validation import validate_atom_array_for_save

# Each hook receives the active AtomArrayPlus and returns a list of violation
# strings.  Non-empty lists cause a warning popup before saving.
_pre_save_hooks: list[Callable[[AtomArrayPlus], list[str]]] = []


def register_pre_save_hook(fn: Callable[[AtomArrayPlus], list[str]]) -> None:
    """Register *fn* to be called before each CIF save.

    Hooks must treat the passed array as read-only (the live structure is passed
    for efficiency); copy it before any mutation.
    """
    if fn not in _pre_save_hooks:
        _pre_save_hooks.append(fn)


def collect_save_issues(arr: AtomArrayPlus) -> list[str]:
    """Return the built-in save validation issues plus those reported by pre-save hooks."""
    violations = [f"[{issue['check']}] {issue['message']}" for issue in validate_atom_array_for_save(arr)]
    for hook in _pre_save_hooks:
        try:
            violations.extend(hook(arr.copy()))
        except Exception as e:
            violations.append(f"[hook_error] {e}")
    return violations


def write_cif(arr: AtomArrayPlus, path: str | Path) -> None:
    """Write *arr* as an annotated CIF, keeping chain instances (e.g. homo-oligomer copies) distinct."""
    to_cif_file(arr, path, save_standard_annotations=True, chain_disambiguation="chain_iid")
