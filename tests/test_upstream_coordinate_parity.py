"""Differential checks against the real RFD4 operations called by its PyMOL plugin.

Set STUDIO_UPSTREAM_PYTHON to the Python in an independent RFD4 runtime. The
oracle imports RFD4 normally in its own process; it does not import Studio.
"""

import os
import pickle
import subprocess
from pathlib import Path

import numpy as np
import pytest
from atomworks.ml.conditions import C_CRD
from atomworks_studio_editing.contracts import TargetDiscardConfirmationRequiredError
from atomworks_studio_editing.document import StudioDocument
from atomworks_studio_rfd4 import CONDITION_PROVIDER
from atomworks_studio_rfd4.model import C_CRDGRP, C_INTCRD

ORACLE = r"""
import contextlib, pickle, sys
with contextlib.redirect_stdout(sys.stderr):
    import numpy as np
    from atomworks.ml.conditions import C_CRD
    from rfproteina.conditions import C_CRDGRP, C_INTCRD
    from rfproteina.transforms.utils.conditioning_utils import set_absolute_coordinate_conditioning
    original, action, indices, value = pickle.loads(sys.stdin.buffer.read())
    edited = original.copy()
    error = None
    try:
        if action == "absolute":
            set_absolute_coordinate_conditioning(edited, np.asarray(indices), value)
        else:
            groups = C_CRDGRP.annotation(edited, default="generate").copy()
            groups[indices] = C_CRDGRP.default_annotation(edited)[indices] if action == "remove" else value
            C_CRDGRP.set_annotation(edited, groups, on_internal_coord_mismatch="clear")
    except ValueError as caught:
        error = str(caught)
    lost = int((np.isfinite(C_INTCRD.annotation(original, default="generate")).any(axis=1)
        & ~np.isfinite(C_INTCRD.annotation(edited, default="generate")).any(axis=1)).sum())
    unchanged = all(np.array_equal(cls.annotation(original, default="generate"),
        cls.annotation(edited, default="generate"), equal_nan=True) for cls in (C_CRD,C_CRDGRP,C_INTCRD))
sys.stdout.buffer.write(pickle.dumps((edited, error, lost, unchanged)))
"""


@pytest.mark.parametrize(
    "action,indices,value",
    [
        ("absolute", [0], True),  # Split saved group: clear all original members.
        ("absolute", [0, 1], True),
        ("absolute", [0], False),  # Clearing absolute leaves internal membership intact.
        ("group", [0, 1], 9),  # Whole-group rename preserves payload.
        ("group", [0], 9),
        ("group", [0], 8),  # Merge invalidates both source and destination groups.
        ("group", [0, 1, 2, 3], 9),
        ("group", [4], 7),  # Adding an unconditioned atom invalidates destination targets.
        ("remove", [0], None),
        ("remove", [0, 1], None),
        ("remove", [5], None),  # Removing absolute group preserves absolute coordinates.
        ("group", [5], 7),  # Cannot relabel absolute atoms without clearing absolute first.
        ("group", [0], 0),
        ("group", [0], -2),
        ("group", [0], 32768),
        ("absolute", [5], False),
        ("absolute", [5], True),  # No-op must not consume undo history.
    ],
)
def test_coordinate_operations_match_independent_upstream(action, indices, value):
    python = os.environ.get("STUDIO_UPSTREAM_PYTHON")
    if not python:
        pytest.skip("set STUDIO_UPSTREAM_PYTHON to a real independent RFD4 runtime")
    document = StudioDocument.from_cif(
        (Path(__file__).parent / "fixtures" / "SAM_hbonds.cif").read_text(),
        condition_provider=CONDITION_PROVIDER,
    )
    document.set_condition("coordinate_group", [0, 1], value=7)
    document.set_condition("coordinate_group", [2, 3], value=8)
    document.set_condition("coordinate", [5])
    targets = C_INTCRD.default_annotation(document.array)
    targets[:4] = [[-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0]]
    C_INTCRD.set_annotation(document.array, targets)
    original = document.array.copy()
    result = subprocess.run(
        [python, "-c", ORACLE],
        input=pickle.dumps((original, action, indices, value)),
        capture_output=True,
        check=False,
        timeout=90,
    )
    assert result.returncode == 0, result.stderr.decode()
    expected, error, lost, unchanged = pickle.loads(result.stdout)
    condition = "coordinate" if action == "absolute" else "coordinate_group"
    kwargs = {"enabled": value} if action == "absolute" else {"enabled": action != "remove", "value": value}
    revision = document.revision
    if error:
        with pytest.raises(ValueError) as caught:
            document.set_condition(condition, indices, **kwargs)
        assert str(caught.value) == error
        assert document.revision == revision
        np.testing.assert_equal(C_CRDGRP.annotation(document.array), C_CRDGRP.annotation(original))
        np.testing.assert_equal(C_INTCRD.annotation(document.array), targets)
        return
    if lost:
        with pytest.raises(TargetDiscardConfirmationRequiredError) as caught:
            document.set_condition(condition, indices, **kwargs)
        assert caught.value.lost_target_count == lost
        assert document.revision == revision
        np.testing.assert_equal(C_INTCRD.annotation(document.array), targets)
    document.set_condition(condition, indices, **kwargs, allow_target_discard=bool(lost), expected_revision=revision)
    assert document.revision == revision + (not unchanged)
    assert document.array.get_annotation_categories() == expected.get_annotation_categories()
    for name in expected.get_annotation_categories():
        np.testing.assert_equal(document.array.get_annotation(name), expected.get_annotation(name), err_msg=name)
    np.testing.assert_equal(document.array.coord, expected.coord)
    reparsed = StudioDocument.from_cif(document.to_cif(), condition_provider=CONDITION_PROVIDER)
    for condition_class in (C_CRD, C_CRDGRP, C_INTCRD):
        np.testing.assert_allclose(
            condition_class.annotation(reparsed.array, default="generate"),
            condition_class.annotation(expected, default="generate"),
            equal_nan=True,
            atol=0.001,
        )
    if not unchanged:
        assert document.undo()
        np.testing.assert_equal(C_INTCRD.annotation(document.array), targets)
        np.testing.assert_equal(C_CRDGRP.annotation(document.array), C_CRDGRP.annotation(original))
