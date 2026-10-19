"""Reset defaults without replacing the document or its physical structure."""

from pathlib import Path

import numpy as np
import pytest
from annotation_studio.main import app, store
from atomworks.ml.conditions import C_DIS, C_IDX
from atomworks_studio_editing.document import StudioDocument
from atomworks_studio_editing.mutations import edit_distance_restraint
from atomworks_studio_rfd4 import CONDITION_PROVIDER
from atomworks_studio_rfd4.model import C_INTCRD
from fastapi.testclient import TestClient

FIXTURE = Path(__file__).parent / "fixtures" / "minimal_multichain.cif"


@pytest.mark.parametrize("via_http", [False, True])
def test_reset_preserves_structure_and_undo_restores_all_conditions(via_http, stable_cif_metadata):
    document = StudioDocument.from_cif(FIXTURE.read_text(), condition_provider=CONDITION_PROVIDER)
    document.assign_chain([0, 1], "Z")
    for key, indices, value in [
        ("sequence", [0], None),
        ("coordinate", [0], None),
        ("index", [0], None),
        ("saltbridge", [0], 1),
        ("metal_coord", [2], 2),
        ("sequence_probability_ala", [2], 0.3),
        ("coordinate_group", [2, 3], 7),
        ("chain_centroid", [0], [1.0, 2.0, 3.0]),
    ]:
        document.set_condition(key, indices, value=value)
    edit_distance_restraint(document.array, 0, 2, "set", 3.5)
    targets = C_INTCRD.default_annotation(document.array)
    targets[2:] = [[1, 0, 0], [-1, 0, 0]]
    C_INTCRD.set_annotation(document.array, targets)
    before = document.array.copy()
    cif = document.to_cif()
    revision = document.revision
    if via_http:
        response = TestClient(app).post(
            f"/api/sessions/{store.add(document)}/conditions/reset",
            json={"expected_revision": revision},
        )
        assert response.status_code == 200, response.text
    else:
        document.reset_conditions(expected_revision=revision)
    assert document.revision == revision + 1
    np.testing.assert_equal(document.array.coord, before.coord)
    for key in before.get_annotation_categories():
        if not key.startswith("condition_"):
            np.testing.assert_equal(document.array.get_annotation(key), before.get_annotation(key))
    if before.bonds is not None:
        np.testing.assert_equal(document.array.bonds.as_array(), before.bonds.as_array())
    assert C_IDX.annotation(document.array).all()
    assert len(C_DIS.annotation(document.array).values) == 0
    assert np.isnan(C_INTCRD.annotation(document.array)).all()
    for definition in CONDITION_PROVIDER.definitions:
        condition = definition.condition
        if condition.n_body == 1:
            np.testing.assert_equal(condition.annotation(document.array), condition.default_annotation(document.array))
    restored = StudioDocument.from_cif(document.to_cif(), condition_provider=CONDITION_PROVIDER)
    assert restored.summary()["condition_counts"] == document.summary()["condition_counts"]
    assert document.undo()
    assert document.to_cif() == cif


def test_reset_rejects_stale_revision_without_changing_document(stable_cif_metadata):
    document = StudioDocument.from_cif(FIXTURE.read_text(), condition_provider=CONDITION_PROVIDER)
    document.set_condition("sequence", [0])
    cif = document.to_cif()
    response = TestClient(app).post(
        f"/api/sessions/{store.add(document)}/conditions/reset",
        json={"expected_revision": 0},
    )
    assert response.status_code == 409
    assert document.to_cif() == cif
    assert document.revision == 1
