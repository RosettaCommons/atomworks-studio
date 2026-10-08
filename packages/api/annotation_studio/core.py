"""Compatibility exports for the shared Studio editing package."""

from atomworks_studio_editing.document import (
    BOND_TYPES,
    INTERACTION_TYPES,
    StudioDocument,
    parse_annotated_cif,
)

__all__ = ["BOND_TYPES", "INTERACTION_TYPES", "StudioDocument", "parse_annotated_cif"]
