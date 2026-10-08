"""Annotation editor registry for the AtomWorks PyMOL plugin.

The registry maps :py:class:`~atomworks.io.utils.standard_annotations.base.StandardAnnotationBase`
subclasses to editor widget classes.  Custom editors are registered with the
:py:func:`register_editor` decorator; everything else falls back to
:py:func:`_auto_editor_for`.

The dependency direction is intentionally one-way::

    pymol_plugin.editors  →  atomworks.ml.conditions  (reads annotation metadata)
                           →  atomworks.io.utils       (reads/writes AtomArrayPlus)

``atomworks.io`` and ``atomworks.ml`` never import from this subpackage.
"""

from collections.abc import Callable

from atomworks.io.utils.standard_annotations.base import StandardAnnotationBase
from atomworks_studio_editing.annotations import editing_type, is_boolean, is_structure_derived
from atomworks_studio_pymol.editors.widgets import BaseAnnotationEditor, MaskEditor, PairValueEditor, ScalarEditor

_editor_registry: dict[type[StandardAnnotationBase], Callable[..., BaseAnnotationEditor]] = {}
_excluded_annotations: set[type[StandardAnnotationBase]] = set()


def exclude_annotation(annotation_cls: type[StandardAnnotationBase]) -> None:
    """Exclude an annotation class from the Annotation Wizard entirely.

    Excluded annotations are not shown in the wizard list and cannot be
    edited from the plugin UI.  Call this at plugin startup for annotations
    that should not be user-editable via PyMOL (e.g. chain pairing, which
    is managed programmatically rather than interactively).

    Args:
        annotation_cls: The StandardAnnotationBase subclass to exclude.
    """
    _excluded_annotations.add(annotation_cls)


def is_excluded(annotation_cls: type[StandardAnnotationBase]) -> bool:
    """Return True if *annotation_cls* has been excluded from the wizard."""
    return annotation_cls in _excluded_annotations


def register_editor[EditorT: Callable[..., BaseAnnotationEditor]](
    annotation_cls: type[StandardAnnotationBase],
) -> Callable[[EditorT], EditorT]:
    """Decorator that registers a custom editor for a specific annotation class.

    Args:
        annotation_cls: The StandardAnnotationBase subclass to register for.

    Returns:
        Decorator that registers and returns the editor class unchanged.

    Example:
        >>> @register_editor(CONDITIONS.sequence)
        ... class SequenceEditor(BaseAnnotationEditor): ...
    """

    def decorator(editor_cls: EditorT) -> EditorT:
        _editor_registry[annotation_cls] = editor_cls
        return editor_cls

    return decorator


def editor_for(annotation_cls: type[StandardAnnotationBase]) -> Callable[..., BaseAnnotationEditor]:
    """Return the appropriate editor class for *annotation_cls*.

    Checks the custom registry first; falls back to auto-detection.

    Args:
        annotation_cls: The annotation class to find an editor for.

    Returns:
        Editor class (a QWidget subclass).
    """
    if annotation_cls in _editor_registry:
        return _editor_registry[annotation_cls]
    return _auto_editor_for(annotation_cls)


def _auto_editor_for(annotation_cls: type[StandardAnnotationBase]) -> Callable[..., BaseAnnotationEditor]:
    """Infer an appropriate editor from annotation metadata.

    Args:
        annotation_cls: The annotation class to infer an editor for.

    Returns:
        One of the standard editor classes.
    """

    if editing_type(annotation_cls) is None:
        raise TypeError(f"{annotation_cls.name} does not declare an editing_type")
    if annotation_cls.n_body != 1:
        if annotation_cls.n_body == 2 and editing_type(annotation_cls) is float and not is_boolean(annotation_cls):
            return PairValueEditor
        raise TypeError(f"{annotation_cls.name} requires a custom {annotation_cls.n_body}-body editor")
    if is_boolean(annotation_cls) or is_structure_derived(annotation_cls):
        return MaskEditor
    if editing_type(annotation_cls) in {int, float}:
        return ScalarEditor
    raise TypeError(f"{annotation_cls.name} requires a custom editor for {editing_type(annotation_cls)!r}")
