"""Native widgets for the same annotation contract used by the browser."""

from atomworks.io.utils.atom_array_plus import AtomArrayPlus

# Import AtomWorks' non-condition definitions before condition_registry.apply()
# sweeps the registry. The provider package registers RFD4-specific definitions.
from atomworks.io.utils.standard_annotations import S_ATM  # noqa: F401
from atomworks_studio_pymol.views import register_view

from atomworks_studio_rfd4.interactive_validation import validate_rfd4
from atomworks_studio_rfd4.pymol import condition_registry
from atomworks_studio_rfd4.pymol.visualize import color_by_coord_group, color_by_index_group

# ---------------------------------------------------------------------------
# Pre-save annotation validation hook
# ---------------------------------------------------------------------------


def _run_annotation_validation(arr: AtomArrayPlus) -> list[str]:
    return [f"[{issue['check']}] {issue['message']}" for issue in validate_rfd4(arr, full_pipeline=False)]


# ---------------------------------------------------------------------------
# Extension registration entry point
# ---------------------------------------------------------------------------


def register() -> None:
    """Register rfproteina condition editors and views with the AtomWorks PyMOL plugin.

    Called once at PyMOL plugin startup after atomworks is confirmed importable.
    """
    from atomworks_studio_pymol.panel import register_pre_save_hook

    # Views
    register_view("Color by index group", color_by_index_group)
    register_view("Color by coord group", color_by_coord_group)

    # Editors, wizard visibility, and summaries are derived by sweeping the
    # StandardAnnotation editing contract. Computed/non-editable annotations
    # are excluded automatically.
    condition_registry.apply()

    # Pre-save validation hooks.
    register_pre_save_hook(_run_annotation_validation)
