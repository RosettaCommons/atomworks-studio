"""Evaluate structure queries after deriving only their referenced annotations."""

import ast

import numpy as np
from atomworks.io.utils.annotator import ANNOTATOR_REGISTRY, ensure_annotations
from atomworks.io.utils.query import QueryExpression
from atomworks.io.utils.selection import get_annotation_categories
from biotite.structure import AtomArray, AtomArrayStack


def resolve_mask(atom_array: AtomArray | AtomArrayStack, query: str) -> np.ndarray:
    """Evaluate a selection query string against ``atom_array``.

    Derive the annotations referenced by an editor selection on a temporary
    copy, then evaluate its boolean mask without mutating document state.

    An annotation the query references but that isn't already present is derived
    first -- but *only* if it has a real generator in
    :py:data:`~atomworks.io.utils.annotator.ANNOTATOR_REGISTRY`. Everything else
    is left for :py:class:`~atomworks.io.utils.query.QueryExpression` itself:
    query-function names like ``has_bonds`` resolve there, and a genuinely absent
    annotation raises ``NameError``.

    Args:
      atom_array: Structure (or stack) to evaluate the query against.
      query: Boolean-expression query string, e.g. ``"chain_id == 'A' and
        res_id >= 10"``.

    Returns:
      Boolean mask, one entry per atom.

    Raises:
      NameError: If the query references an annotation that is neither present on
        ``atom_array``, derivable, nor a query-engine builtin.
    """
    tree = ast.parse(query, mode="eval")
    referenced_names = {node.id for node in ast.walk(tree) if isinstance(node, ast.Name)}
    present = set(get_annotation_categories(atom_array, n_body="all"))
    missing = (referenced_names - present) & ANNOTATOR_REGISTRY.keys()
    if missing:
        # A query must not persist derived fields that become stale after edits.
        atom_array = atom_array.copy()
        ensure_annotations(atom_array, *sorted(missing))
    return QueryExpression(query).mask(atom_array)
