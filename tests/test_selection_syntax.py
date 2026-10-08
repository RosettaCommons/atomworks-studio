"""Selections agree with AtomWorks and known atoms without changing the document."""

from pathlib import Path

import numpy as np
import pytest
from atomworks.io.utils.query import AtomSelectionStack, QueryExpression
from atomworks_studio_editing.document import StudioDocument


@pytest.fixture
def document():
    return StudioDocument.from_cif((Path(__file__).parent / "fixtures/minimal_multichain.cif").read_text(), "selection")


@pytest.mark.parametrize(
    ("path", "expression", "expected"),
    [
        ("*", "res_id >= 1", [0, 1, 2, 3]),
        ("A", "chain_id == 'A'", [0, 1]),
        ("*/ALA", "res_name == 'ALA'", [2, 3]),
        ("*/*/*/CA", "atom_name == 'CA'", [1, 3]),
        ("[A,B]/*/*/CA", "(chain_id in ['A', 'B']) and atom_name == 'CA'", [1, 3]),
        ("A/*/[1-3]", "chain_id == 'A' and res_id >= 1 and res_id <= 3", [0, 1]),
        ("A/*/[3-1]", "chain_id == 'A'", [0, 1]),
        ("A/*/[-2-1]", "chain_id == 'A' and res_id <= 1", [0, 1]),
        ("A/*/[1,3]/[N,CA]", "chain_id == 'A' and atom_name in ['N', 'CA']", [0, 1]),
        (
            "A/*/*/N, B/*/*/CA",
            "(chain_id == 'A' and atom_name == 'N') or (chain_id == 'B' and atom_name == 'CA')",
            [0, 3],
        ),
        ("[A,Z]/*/*/CA", "chain_id in ['A', 'Z'] and atom_name == 'CA'", [1]),
        ("Z", "chain_id == 'Z'", []),
        ("A/*/[20-30]", "chain_id == 'A' and res_id >= 20", []),
    ],
)
def test_path_expression_and_upstream_agree(document, path, expression, expected, stable_cif_metadata):
    before = document.export_state()
    assert document.query_indices(path, syntax="path").tolist() == expected
    assert document.query_indices(expression).tolist() == expected
    assert document.query_indices(f"sel({path!r})").tolist() == expected
    np.testing.assert_array_equal(
        np.flatnonzero(AtomSelectionStack.from_query(path).get_mask(document.array, raise_on_empty=False)), expected
    )
    np.testing.assert_array_equal(np.flatnonzero(QueryExpression(expression).mask(document.array)), expected)
    assert document.export_state() == before


@pytest.mark.parametrize("scope, expected", [("atom", [1]), ("residue", [0, 1]), ("chain", [0, 1])])
def test_query_expands_to_requested_scope(document, scope, expected):
    assert document.query_indices("A/*/*/CA", syntax="path", scope=scope).tolist() == expected


@pytest.mark.parametrize("path", ["A/*/1-3", "A/*/[1-nope]", "A/*/[1", ""])
def test_invalid_path_has_actionable_error(document, path):
    with pytest.raises(ValueError):
        document.query_indices(path, syntax="path")


@pytest.mark.parametrize(
    "query", ["__import__('os')", "atom_name.__class__", "[x for x in atom_id]", "missing_annotation == 1"]
)
def test_query_rejects_python_and_unknown_annotations(document, query):
    with pytest.raises((ValueError, NameError, TypeError, SyntaxError)):
        document.query_indices(query)
