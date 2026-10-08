"""Value-derived annotation regressions, run with current upstream snapshots."""

from pathlib import Path

import numpy as np
import pytest
from atomworks_studio_editing.contracts import TargetDiscardConfirmationRequiredError
from atomworks_studio_editing.document import StudioDocument
from atomworks_studio_rfd4 import CONDITION_PROVIDER
from atomworks_studio_rfd4.internal_coordinate import clear_internal_coordinate_targets
from atomworks_studio_rfd4.model import C_CRDGRP, C_INTCRD, conditions

pytestmark = [
    pytest.mark.skipif(not hasattr(C_CRDGRP, "is_internal"), reason="requires value-derived annotations"),
    pytest.mark.usefixtures("stable_cif_metadata"),
]
FIXTURE = Path(__file__).parent / "fixtures" / "SAM_hbonds.cif"


def test_coordinate_edits_preserve_saved_targets_or_roll_back() -> None:
    document = StudioDocument.from_cif(FIXTURE.read_text(), condition_provider=CONDITION_PROVIDER)
    document.set_condition("coordinate_group", [0, 1], value=7)
    targets = C_INTCRD.default_annotation(document.array)
    targets[[0, 1]] = [[-1, 0, 0], [1, 0, 0]]
    C_INTCRD.set_annotation(document.array, targets)

    document.set_condition("coordinate_group", [0, 1], value=8)
    np.testing.assert_equal(C_INTCRD.annotation(document.array), targets)
    revision = document.revision
    for condition, value in [("coordinate_group", 9), ("coordinate", None)]:
        with pytest.raises(TargetDiscardConfirmationRequiredError, match="clears saved") as caught:
            document.set_condition(condition, [0], value=value)
        assert caught.value.lost_target_count == 2
        assert document.revision == revision
        np.testing.assert_equal(C_INTCRD.annotation(document.array), targets)
        assert C_CRDGRP.annotation(document.array)[[0, 1]].tolist() == [8, 8]

    reparsed = StudioDocument.from_cif(document.to_cif(), condition_provider=CONDITION_PROVIDER)
    np.testing.assert_equal(C_INTCRD.annotation(reparsed.array), targets)
    assert reparsed.annotation_details("internal_coordinate")[0]["count"] == 2


def test_sparse_sequence_probabilities_validate_and_roundtrip() -> None:
    document = StudioDocument.from_cif(
        FIXTURE.with_name("minimal_multichain.cif").read_text(), condition_provider=CONDITION_PROVIDER
    )
    first = next(c for c in conditions.SEQUENCE_PROBABILITY_CONDITIONS if c.token_name == "ALA")
    second = next(c for c in conditions.SEQUENCE_PROBABILITY_CONDITIONS if c.token_name == "ARG")
    protein = int(np.flatnonzero(np.isin(document.array.res_name, ["ALA", "ARG", "GLY", "LEU"]))[0])
    selected = document.resolve_indices([protein], "residue")
    document.set_condition("sequence", [protein], enabled=False, scope="residue")
    document.set_condition(first.name, [protein], value=0.6)
    np.testing.assert_allclose(first.annotation(document.array)[selected], 0.6)
    revision = document.revision
    with pytest.raises(ValueError, match="sum above 1"):
        document.set_condition(second.name, [protein], value=0.6)
    assert document.revision == revision
    assert not second.mask(document.array, default="generate")[selected].any()
    with pytest.raises(ValueError, match="conflicts with C_SEQ"):
        document.set_condition("sequence", [protein], scope="residue")
    assert document.revision == revision

    document.set_condition(second.name, [protein], value=0.0)
    reparsed = StudioDocument.from_cif(document.to_cif(), condition_provider=CONDITION_PROVIDER)
    assert second.mask(reparsed.array)[selected].all(), "explicit zero must remain a specified probability"
    np.testing.assert_equal(second.annotation(reparsed.array)[selected], 0.0)
    reparsed.set_condition(second.name, [protein], enabled=False)
    assert np.isnan(second.annotation(reparsed.array)[selected]).all()


def test_clear_saved_targets_covers_whole_groups_and_is_undoable() -> None:
    document = StudioDocument.from_cif(FIXTURE.read_text(), condition_provider=CONDITION_PROVIDER)
    document.set_condition("coordinate_group", [0, 1], value=7)
    document.set_condition("coordinate_group", [2, 3], value=8)
    targets = C_INTCRD.default_annotation(document.array)
    targets[:4] = [[-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0]]
    C_INTCRD.set_annotation(document.array, targets)
    before = document.to_cif()
    document.apply_selection_transform([0], "atom", clear_internal_coordinate_targets, True, allow_target_discard=True)
    assert np.isnan(C_INTCRD.annotation(document.array)[:2]).all()
    np.testing.assert_equal(C_INTCRD.annotation(document.array)[2:], targets[2:])
    assert C_CRDGRP.annotation(document.array)[:4].tolist() == [7, 7, 8, 8]
    assert document.undo()
    assert document.to_cif() == before


def test_http_clear_targets_preserves_membership_and_undo() -> None:
    from annotation_studio.main import app
    from fastapi.testclient import TestClient

    document = StudioDocument.from_cif(FIXTURE.read_text(), condition_provider=CONDITION_PROVIDER)
    document.set_condition("coordinate_group", [0, 1], value=7)
    targets = C_INTCRD.default_annotation(document.array)
    targets[:2] = [[-1, 0, 0], [1, 0, 0]]
    C_INTCRD.set_annotation(document.array, targets)
    client = TestClient(app)
    response = client.post("/api/sessions", files={"file": ("saved.cif", document.to_cif(), "chemical/x-mmcif")})
    assert response.status_code == 200, response.text
    session = response.json()["session_id"]
    response = client.post(
        f"/api/sessions/{session}/internal-coords/clear-targets",
        json={"atom_indices": [0], "expected_revision": response.json()["structure"]["revision"]},
    )
    assert response.status_code == 200, response.text
    cleared = StudioDocument.from_cif(client.get(f"/api/sessions/{session}/cif").text)
    assert not C_INTCRD.mask(cleared.array).any()
    assert C_CRDGRP.is_internal(cleared.array)[:2].all()
    response = client.post(f"/api/sessions/{session}/undo")
    assert response.status_code == 200, response.text
    restored = StudioDocument.from_cif(client.get(f"/api/sessions/{session}/cif").text)
    np.testing.assert_equal(C_INTCRD.annotation(restored.array), targets)


def test_combine_keeps_independent_saved_coordinate_groups() -> None:
    first = StudioDocument.from_cif(FIXTURE.read_text(), condition_provider=CONDITION_PROVIDER)
    second = first.clone()
    for document, offset in [(first, 0), (second, 10)]:
        document.set_condition("coordinate_group", [0, 1], value=7)
        targets = C_INTCRD.default_annotation(document.array)
        targets[:2] = np.array([[-1, 0, 0], [1, 0, 0]]) + offset
        C_INTCRD.set_annotation(document.array, targets)
    second.set_condition("C_CATH", [0], value="1.x.x")
    first_targets = C_INTCRD.annotation(first.array).copy()
    second_targets = C_INTCRD.annotation(second.array).copy()
    first_size = len(first.array)
    first.combine([second])
    np.testing.assert_equal(C_INTCRD.annotation(first.array)[:first_size], first_targets)
    np.testing.assert_equal(C_INTCRD.annotation(first.array)[first_size:], second_targets)
    groups = C_CRDGRP.annotation(first.array)
    assert groups[0] != groups[first_size]
    assert first.annotation_details("C_CATH")
    assert first.undo()
    np.testing.assert_equal(C_INTCRD.annotation(first.array), first_targets)


def test_confirmed_coordinate_edit_clears_only_affected_groups_and_undoes() -> None:
    document = StudioDocument.from_cif(FIXTURE.read_text(), condition_provider=CONDITION_PROVIDER)
    document.set_condition("coordinate_group", [0, 1], value=7)
    document.set_condition("coordinate_group", [2, 3], value=8)
    targets = C_INTCRD.default_annotation(document.array)
    targets[:4] = [[-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0]]
    C_INTCRD.set_annotation(document.array, targets)
    before = document.to_cif()
    revision = document.revision
    with pytest.raises(TargetDiscardConfirmationRequiredError) as caught:
        document.set_condition("coordinate", [0])
    assert caught.value.lost_target_count == 2
    assert document.to_cif() == before
    document.set_condition("coordinate", [0], allow_target_discard=True, expected_revision=revision)
    assert document.revision == revision + 1
    assert np.isnan(C_INTCRD.annotation(document.array)[:2]).all()
    np.testing.assert_equal(C_INTCRD.annotation(document.array)[2:], targets[2:])
    assert document.undo()
    assert document.to_cif() == before


def test_group_edits_preserve_upstream_absolute_coordinate_rules() -> None:
    document = StudioDocument.from_cif(FIXTURE.read_text(), condition_provider=CONDITION_PROVIDER)
    document.set_condition("coordinate", [0])
    before = document.to_cif()
    with pytest.raises(ValueError, match="group 0 must match"):
        document.set_condition("coordinate_group", [0], value=7)
    assert document.to_cif() == before
    document.set_condition("coordinate_group", [0], enabled=False)
    assert document.to_cif() == before
