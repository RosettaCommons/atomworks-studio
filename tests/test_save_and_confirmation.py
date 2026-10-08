"""Save snapshots and confirmed edits must bind validation to the exact output."""

from pathlib import Path

import numpy as np
import pytest
from annotation_studio import main
from atomworks_studio_editing.document import StudioDocument
from atomworks_studio_rfd4 import CONDITION_PROVIDER, VALIDATION_PROVIDER
from atomworks_studio_rfd4.model import C_CRDGRP, C_INTCRD
from fastapi.testclient import TestClient

FIXTURE = Path(__file__).parent / "fixtures" / "SAM_hbonds.cif"
pytestmark = pytest.mark.usefixtures("stable_cif_metadata")
client = TestClient(main.app)


@pytest.fixture
def session():
    document = StudioDocument.from_cif(
        FIXTURE.read_text(),
        name="presave",
        condition_provider=CONDITION_PROVIDER,
        validation_provider=VALIDATION_PROVIDER,
    )
    return main.store.add(document), document


@pytest.mark.parametrize("valid", [True, False])
def test_export_validates_one_snapshot_and_returns_that_exact_cif(monkeypatch, session, valid):
    session_id, live = session
    before = live.to_cif()
    issues = [] if valid else [{"severity": "error", "check": "res_id_gap", "message": "gap in group"}]
    calls = []

    def validate(snapshot, full_pipeline=False):
        assert snapshot is not live
        assert full_pipeline
        assert snapshot.to_cif() == before
        calls.append(snapshot.revision)
        # Simulate another client editing while the expensive worker validates.
        live.set_charge([0], value=4)
        return issues

    monkeypatch.setattr(StudioDocument, "validate", validate)
    response = client.post(f"/api/sessions/{session_id}/export")
    assert response.status_code == 200, response.text
    assert response.json() == {"name": "presave", "revision": 0, "issues": issues, "cif": before}
    assert calls == [0]
    assert live.revision == 1
    assert live.to_cif() != before


def test_export_validation_failure_does_not_return_unchecked_file(monkeypatch, session):
    def fail(_document, full_pipeline=False):
        raise RuntimeError("worker unavailable")

    monkeypatch.setattr(StudioDocument, "validate", fail)
    with TestClient(main.app, raise_server_exceptions=False) as safe_client:
        response = safe_client.post(f"/api/sessions/{session[0]}/export")
    assert response.status_code == 500
    assert "data_" not in response.text


def test_target_loss_requires_confirmation_and_undo_restores_whole_group(session):
    session_id, document = session
    document.set_condition("coordinate_group", [0, 1], value=7)
    targets = C_INTCRD.default_annotation(document.array)
    targets[:2] = [[-1, 0, 0], [1, 0, 0]]
    C_INTCRD.set_annotation(document.array, targets)
    before = document.export_state()
    body = {"condition": "coordinate", "atom_indices": [0], "enabled": True}
    response = client.post(f"/api/sessions/{session_id}/conditions", json=body)
    assert response.status_code == 409, response.text
    detail = response.json()["detail"]
    assert detail["code"] == "target_discard_confirmation_required"
    assert detail["lost_target_count"] == 2
    assert detail["revision"] == document.revision
    assert document.export_state() == before

    response = client.post(
        f"/api/sessions/{session_id}/conditions",
        json={
            **body,
            "allow_target_discard": True,
            "expected_revision": detail["revision"],
        },
    )
    assert response.status_code == 200, response.text
    assert document.revision == before["revision"] + 1
    assert np.isnan(C_INTCRD.annotation(document.array)[:2]).all()
    assert C_CRDGRP.annotation(document.array)[0] == C_CRDGRP.KNOWN_ABSOLUTE_COORDS
    assert client.post(f"/api/sessions/{session_id}/undo").status_code == 200
    np.testing.assert_equal(C_INTCRD.annotation(document.array), targets)


def test_stale_or_unversioned_target_loss_confirmation_is_rejected(session):
    session_id, document = session
    document.set_condition("coordinate_group", [0, 1], value=7)
    targets = C_INTCRD.default_annotation(document.array)
    targets[:2] = [[-1, 0, 0], [1, 0, 0]]
    C_INTCRD.set_annotation(document.array, targets)
    body = {"condition": "coordinate", "atom_indices": [0], "enabled": True}
    preview = client.post(f"/api/sessions/{session_id}/conditions", json=body).json()["detail"]
    document.set_charge([0], value=1)
    before = document.export_state()
    stale = client.post(
        f"/api/sessions/{session_id}/conditions",
        json={
            **body,
            "allow_target_discard": True,
            "expected_revision": preview["revision"],
        },
    )
    assert stale.status_code == 409
    assert stale.json()["detail"]["code"] == "revision_conflict"
    missing = client.post(f"/api/sessions/{session_id}/conditions", json={**body, "allow_target_discard": True})
    assert missing.status_code == 422
    assert document.export_state() == before
