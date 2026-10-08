"""Custom editor registrations for specific annotation classes.

Registers hand-crafted editor widgets for annotations whose UI needs are
richer than the auto-detected defaults.  This module is imported at plugin
startup so all registrations are in effect before the wizard is opened.

Dependency direction: this module imports from ``atomworks.ml.conditions``
(reads annotation classes) and from ``atomworks_studio_pymol.editors``
(writes to the registry).  It does NOT import from core atomworks.io or ml
modules at class-definition time — only at registration time here.
"""

from atomworks.io.utils.standard_annotations import S_SEGMAX, S_SEGMIN
from atomworks.ml.conditions import CONDITIONS
from atomworks_studio_pymol.editors import exclude_annotation, register_editor
from atomworks_studio_pymol.editors.widgets import CoordinateEditor, MaskEditor, SequenceEditor


def register_custom_editors() -> None:
    """
    Register custom editor widgets and exclusions.
    """

    register_editor(CONDITIONS.sequence)(SequenceEditor)
    register_editor(CONDITIONS.coordinate)(CoordinateEditor)
    # Index is mask-only in the plugin — the value is derived, not manually entered.
    register_editor(CONDITIONS.index)(MaskEditor)

    # Chain conditioning is managed programmatically — exclude from the wizard.
    exclude_annotation(CONDITIONS.chain)

    # Expandable segment annotations are managed via the Insert Expandable Segment
    # button — they should not be directly editable by the user.
    exclude_annotation(S_SEGMIN)
    exclude_annotation(S_SEGMAX)
