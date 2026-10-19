"""HTTP-level parity checks for upload, mutation, validation, and download."""

from pathlib import Path
from urllib.parse import parse_qs, urlparse

import pytest
from annotation_studio.core import StudioDocument
from annotation_studio.identity import reset_current_owner, set_current_owner
from annotation_studio.main import DocumentStore, SessionNotFoundError, app
from atomworks_studio_rfd4 import CONDITION_PROVIDER, VALIDATION_PROVIDER
from atomworks_studio_rfd4.model import C_CRDGRP, C_INTCRD, C_PISTACK
from fastapi.testclient import TestClient
from pytest import MonkeyPatch

FIXTURE = Path(__file__).parent / "fixtures" / "SAM_hbonds.cif"
client = TestClient(app)


def _session() -> str:
    response = client.post(
        "/api/sessions",
        files={"file": ("SAM_hbonds.cif", FIXTURE.read_bytes(), "chemical/x-mmcif")},
    )
    assert response.status_code == 200, response.text
    return response.json()["session_id"]


def test_session_deep_link_and_optional_embedding_policy(monkeypatch: MonkeyPatch) -> None:
    response = client.post(
        "/api/sessions",
        files={"file": ("SAM_hbonds.cif", FIXTURE.read_bytes(), "chemical/x-mmcif")},
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    query = parse_qs(urlparse(payload["editor_path"]).query)
    assert query == {"session": [payload["session_id"]], "embed": ["1"]}
    assert response.headers["x-content-type-options"] == "nosniff"

    monkeypatch.setenv("ANNOTATION_STUDIO_FRAME_ANCESTORS", "'self' https://build.nvidia.com")
    monkeypatch.setenv("ANNOTATION_STUDIO_VERSION", "1.2.3")
    monkeypatch.setenv("ANNOTATION_STUDIO_REVISION", "test-revision")
    health = client.get("/api/health")
    assert health.headers["content-security-policy"] == "frame-ancestors 'self' https://build.nvidia.com"
    assert health.headers["cache-control"] == "no-store"
    assert health.json()["version"] == "1.2.3"
    assert health.json()["revision"] == "test-revision"


def test_versioned_api_is_canonical_and_legacy_routes_remain_compatible() -> None:
    assert client.get("/api/v1/health").status_code == 200
    assert client.get("/api/health").status_code == 200
    paths = client.get("/openapi.json").json()["paths"]
    assert "/api/v1/health" in paths
    assert "/api/health" not in paths


def test_upload_accepts_desktop_parse_options() -> None:
    response = client.post(
        "/api/sessions",
        files={"file": ("SAM_hbonds.cif", FIXTURE.read_bytes(), "chemical/x-mmcif")},
        data={
            "parse_preset": "minimal",
            "assembly": "asym",
            "hydrogen_policy": "remove",
            "remove_waters": "false",
            "model": "1",
        },
    )
    assert response.status_code == 200, response.text
    assert response.json()["structure"]["atom_count"] > 0


def test_persistent_store_restores_mutations_after_restart(tmp_path: Path) -> None:
    first_process = DocumentStore(
        tmp_path,
        condition_provider=CONDITION_PROVIDER,
        validation_provider=VALIDATION_PROVIDER,
    )
    session_id = first_process.add(
        StudioDocument.from_cif(
            FIXTURE.read_text(),
            "persistent",
            condition_provider=CONDITION_PROVIDER,
            validation_provider=VALIDATION_PROVIDER,
        )
    )
    first_process.call(
        session_id,
        lambda document: document.set_condition("hotspot", [0], enabled=True),
        persist=True,
    )

    restarted_process = DocumentStore(
        tmp_path,
        condition_provider=CONDITION_PROVIDER,
        validation_provider=VALIDATION_PROVIDER,
    )
    summary = restarted_process.call(session_id, lambda document: document.summary())
    assert summary["name"] == "persistent"
    assert summary["condition_counts"]["hotspot"] == 1
    assert summary["undo_depth"] == 0
    assert len(list(tmp_path.glob("*.session"))) == 1


def test_document_store_distinguishes_missing_sessions_from_operation_key_errors(tmp_path: Path) -> None:
    store = DocumentStore(tmp_path)
    session_id = store.add(StudioDocument.from_cif(FIXTURE.read_text()))

    with pytest.raises(KeyError, match="domain failure"):
        store.call(session_id, lambda _document: {}["domain failure"])
    with pytest.raises(SessionNotFoundError):
        store.call("missing", lambda _document: None)


def test_persistent_store_hides_sessions_from_other_owners(tmp_path: Path) -> None:
    documents = DocumentStore(
        tmp_path,
        condition_provider=CONDITION_PROVIDER,
        validation_provider=VALIDATION_PROVIDER,
    )
    owner_token = set_current_owner("alice@example.org")
    try:
        session_id = documents.add(
            StudioDocument.from_cif(
                FIXTURE.read_text(),
                "private",
                condition_provider=CONDITION_PROVIDER,
                validation_provider=VALIDATION_PROVIDER,
            )
        )
    finally:
        reset_current_owner(owner_token)
    other_token = set_current_owner("bob@example.org")
    try:
        with pytest.raises(KeyError):
            documents.get(session_id)
    finally:
        reset_current_owner(other_token)


def test_readiness_endpoint() -> None:
    response = client.get("/api/ready")
    assert response.status_code == 200
    assert response.json() == {"status": "ready"}


def test_full_condition_api_and_download_roundtrip() -> None:
    session_id = _session()
    mutations = [
        {"condition": "sequence", "atom_indices": [0], "scope": "residue"},
        {"condition": "coordinate", "atom_indices": [0]},
        {"condition": "index", "atom_indices": [0], "enabled": True, "scope": "residue"},
        {"condition": "hotspot", "atom_indices": [0]},
        {"condition": "C_RAS", "atom_indices": [0], "value": 3},
        {"condition": "hbond", "atom_indices": [1], "value": 1},
        {"condition": "index_group", "atom_indices": [0], "value": 7, "scope": "residue"},
        {"condition": "coordinate_group", "atom_indices": [2], "value": 2},
        {
            "condition": "chain_centroid",
            "atom_indices": [0],
            "scope": "chain",
            "value": [1.0, 2.0, 3.0],
        },
    ]
    for mutation in mutations:
        response = client.post(f"/api/sessions/{session_id}/conditions", json=mutation)
        assert response.status_code == 200, response.text

    annotation = client.get(f"/api/sessions/{session_id}/annotations/hotspot")
    assert annotation.status_code == 200, annotation.text
    assert annotation.json()["annotation"]["values"][0]["atom_indices"] == [0]
    index_annotation = client.get(f"/api/sessions/{session_id}/annotations/index")
    assert index_annotation.json()["annotation"]["values"][0]["label"] == "Unindexed"
    atom = client.get(f"/api/sessions/{session_id}/atoms/0/annotations")
    assert atom.status_code == 200, atom.text
    assert "hotspot" in {item["name"] for item in atom.json()["annotations"]}
    pistack_field = getattr(C_PISTACK, "mask_name", C_PISTACK.full_name)
    stored = client.get(f"/api/sessions/{session_id}/annotation-fields/{pistack_field}")
    assert stored.status_code == 200, stored.text
    assert stored.json()["annotation"]["values"]

    response = client.post(
        f"/api/sessions/{session_id}/charges",
        json={"atom_indices": [0], "value": 1},
    )
    assert response.status_code == 200, response.text

    download = client.get(f"/api/sessions/{session_id}/cif")
    assert download.status_code == 200
    assert any(
        field in download.text for field in ("_atom_site.mask_hotspot_1_atom", "_atom_site.condition_hotspot_1_atom")
    )
    assert "_condition_ChainCentroid_1_atom" in download.text

    reupload = client.post(
        "/api/sessions",
        files={"file": ("roundtrip.cif", download.content, "chemical/x-mmcif")},
    )
    assert reupload.status_code == 200, reupload.text
    counts = reupload.json()["structure"]["condition_counts"]
    assert counts["hotspot"] == 1
    assert counts["rasa"] == 1
    assert counts["chain_centroid"] > 0
    assert "distance" not in counts


def test_internal_coordinate_operation_clears_absolute_coords() -> None:
    session_id = _session()
    # Absolute coordinate conditioning on the first residue, then mark it as internal coords.
    assert (
        client.post(
            f"/api/sessions/{session_id}/conditions",
            json={"condition": "coordinate", "atom_indices": [0], "scope": "residue"},
        ).status_code
        == 200
    )
    response = client.post(
        f"/api/sessions/{session_id}/internal-coords",
        json={"atom_indices": [0], "scope": "residue"},
    )
    assert response.status_code == 200, response.text
    counts = response.json()["structure"]["condition_counts"]
    # The operation swaps the masks and assigns a coordinate group.
    assert counts.get("coordinate_group", 0) > 0
    assert "coordinate" not in counts

    download = client.get(f"/api/sessions/{session_id}/cif")
    assert download.status_code == 200
    # Editors serialize the mask/group contract only. RFD4 writes values during featurization.
    membership_field = getattr(C_INTCRD, "mask_name", C_CRDGRP.full_name)
    assert f"_atom_site.{membership_field}" in download.text
    assert "_condition_InternalCoordinate_1_atom.val0" not in download.text

    reupload = client.post(
        "/api/sessions",
        files={"file": ("intcrd.cif", download.content, "chemical/x-mmcif")},
    )
    assert reupload.status_code == 200, reupload.text
    assert reupload.json()["structure"]["condition_counts"].get("coordinate_group", 0) > 0

    removed = client.post(
        f"/api/sessions/{session_id}/internal-coords",
        json={"atom_indices": [0], "scope": "residue", "enabled": False},
    )
    assert removed.status_code == 200, removed.text
    assert "internal_coordinate" not in removed.json()["structure"]["condition_counts"]


def test_internal_coordinate_endpoint_rejects_empty_selection() -> None:
    session_id = _session()
    assert client.post(f"/api/sessions/{session_id}/internal-coords", json={"atom_indices": []}).status_code == 422


def test_upload_defenses_and_unknown_session() -> None:
    wrong_type = client.post(
        "/api/sessions",
        files={"file": ("structure.pdb", b"ATOM", "chemical/x-pdb")},
    )
    assert wrong_type.status_code == 415
    assert client.get("/api/sessions/not-a-session").status_code == 404
    session_id = _session()
    invalid_enum = client.post(
        f"/api/sessions/{session_id}/conditions",
        json={"condition": "rasa", "atom_indices": [0], "value": 999},
    )
    assert invalid_enum.status_code == 422
    for invalid_value in (True, "1", [True, 2, 3]):
        response = client.post(
            f"/api/sessions/{session_id}/conditions",
            json={"condition": "rasa", "atom_indices": [0], "value": invalid_value},
        )
        assert response.status_code == 422


def test_selection_scope_and_atomworks_query_api() -> None:
    session_id = _session()
    atom = client.get(f"/api/sessions/{session_id}/atoms/0/annotations").json()

    residue = client.post(
        f"/api/sessions/{session_id}/selections/resolve",
        json={"atom_indices": [0], "scope": "residue"},
    )
    assert residue.status_code == 200, residue.text
    assert 0 in residue.json()["atom_indices"]
    assert residue.json()["count"] > 1

    expression = f"(chain_iid == {atom['chain']!r}) & (res_id == {atom['residue_id']})"
    queried = client.post(
        f"/api/sessions/{session_id}/selections/query",
        json={"expression": expression, "syntax": "expression"},
    )
    assert queried.status_code == 200, queried.text
    assert queried.json()["atom_indices"] == residue.json()["atom_indices"]

    unsafe = client.post(
        f"/api/sessions/{session_id}/selections/query",
        json={"expression": "__import__('os').system('true')"},
    )
    assert unsafe.status_code == 422


def test_charge_bond_delete_and_undo_routes() -> None:
    session_id = _session()
    original = client.get(f"/api/sessions/{session_id}").json()["structure"]["atom_count"]

    charge = client.post(
        f"/api/sessions/{session_id}/charges",
        json={"atom_indices": [0], "value": 1},
    )
    assert charge.status_code == 200, charge.text
    chain = client.post(
        f"/api/sessions/{session_id}/chains",
        json={"atom_indices": [0], "chain_id": "WEB"},
    )
    assert chain.status_code == 200, chain.text
    atom = client.get(f"/api/sessions/{session_id}/atoms/0/annotations")
    assert atom.json()["chain_id"] == "WEB"
    bond = client.post(
        f"/api/sessions/{session_id}/bonds",
        json={"atom1": 0, "atom2": 1, "action": "add", "bond_type": "single"},
    )
    assert bond.status_code == 200, bond.text
    deleted = client.post(
        f"/api/sessions/{session_id}/delete",
        json={"atom_indices": [original - 1], "close_residue_gaps": True},
    )
    assert deleted.status_code == 200, deleted.text
    assert deleted.json()["structure"]["atom_count"] == original - 1
    restored = client.post(f"/api/sessions/{session_id}/undo")
    assert restored.status_code == 200, restored.text
    assert restored.json()["structure"]["atom_count"] == original


def test_bond_inspection_ccd_inference_and_unsupported_distance_restraints() -> None:
    session_id = _session()
    original = client.get(f"/api/sessions/{session_id}").json()["structure"]

    bonds = client.get(f"/api/sessions/{session_id}/bonds")
    assert bonds.status_code == 200, bonds.text
    assert bonds.json()["count"] > 0
    first_bond = bonds.json()["bonds"][0]
    assert first_bond["bond_type"] in client.get("/api/schema").json()["bond_types"]
    assert first_bond["distance"] > 0

    touching = client.get(
        f"/api/sessions/{session_id}/bonds",
        params={"atom_index": first_bond["atom1"]},
    )
    assert touching.status_code == 200, touching.text
    assert all(first_bond["atom1"] in (bond["atom1"], bond["atom2"]) for bond in touching.json()["bonds"])

    set_restraint = client.post(
        f"/api/sessions/{session_id}/distance-restraints",
        json={"atom1": 0, "atom2": 1, "action": "set", "distance": 3.25},
    )
    assert set_restraint.status_code == 422, set_restraint.text
    assert "not supported" in set_restraint.json()["detail"]
    assert client.get(f"/api/sessions/{session_id}").json()["structure"]["revision"] == original["revision"]
    assert client.get(f"/api/sessions/{session_id}/distance-restraints").json()["count"] == 0

    inferred = client.post(f"/api/sessions/{session_id}/bonds/infer-ccd")
    assert inferred.status_code == 200, inferred.text
    assert inferred.json()["structure"]["revision"] == original["revision"] + 1


def test_interaction_analysis_filtering_validation_and_revision_cache() -> None:
    session_id = _session()
    request = {
        "interaction_types": ["hbond", "hydrophobic", "pi", "salt", "halogen", "metal"],
        "hbond_model": "plip",
        "inter_chain_only": True,
    }
    first = client.post(f"/api/sessions/{session_id}/interactions/analyze", json=request)
    assert first.status_code == 200, first.text
    payload = first.json()
    assert payload["cached"] is False
    assert payload["interaction_count"] == len(payload["interactions"])
    for interaction in payload["interactions"]:
        assert interaction["type"] in request["interaction_types"]
        assert interaction["interaction_type"] in {
            "hbond",
            "hydrophobic",
            "pistacking",
            "pication",
            "saltbridge",
            "halogen",
            "metal",
        }
        assert interaction["atom1_role"]
        assert interaction["atom2_role"]
        assert interaction["distance"] >= 0

    cached = client.post(f"/api/sessions/{session_id}/interactions/analyze", json=request)
    assert cached.status_code == 200, cached.text
    assert cached.json()["cached"] is True
    assert cached.json()["interactions"] == payload["interactions"]

    if payload["interactions"]:
        source = payload["interactions"][0]["atom2"]
        filtered = client.post(
            f"/api/sessions/{session_id}/interactions/analyze",
            json={**request, "source_atom_indices": [source]},
        )
        assert filtered.status_code == 200, filtered.text
        assert all(interaction["atom1"] == source for interaction in filtered.json()["interactions"])

    mutated = client.post(
        f"/api/sessions/{session_id}/charges",
        json={"atom_indices": [0], "delta": 1},
    )
    assert mutated.status_code == 200, mutated.text
    refreshed = client.post(f"/api/sessions/{session_id}/interactions/analyze", json=request)
    assert refreshed.status_code == 200, refreshed.text
    assert refreshed.json()["cached"] is False
    assert refreshed.json()["revision"] == payload["revision"] + 1

    invalid_type = client.post(
        f"/api/sessions/{session_id}/interactions/analyze",
        json={"interaction_types": ["unknown"]},
    )
    assert invalid_type.status_code == 422
    invalid_filter = client.post(
        f"/api/sessions/{session_id}/interactions/analyze",
        json={"source_atom_indices": [1_000_000]},
    )
    assert invalid_filter.status_code == 422


def test_expandable_segment_routes() -> None:
    session_id = _session()
    inserted = client.post(
        f"/api/sessions/{session_id}/segments",
        json={"minimum": 2, "maximum": 4, "atom_index": 0, "before": False},
    )
    assert inserted.status_code == 200, inserted.text
    collapsed_count = inserted.json()["structure"]["atom_count"]
    inserted_segments = [
        item
        for chain in inserted.json()["structure"]["sequence"]
        for item in chain["items"]
        if item["kind"] == "segment"
    ]
    assert inserted_segments
    assert all(not segment["realized"] for segment in inserted_segments)
    realized = client.post(f"/api/sessions/{session_id}/segments/realize", json={"seed": 7})
    assert realized.status_code == 200, realized.text
    assert realized.json()["structure"]["atom_count"] > collapsed_count
    realized_segments = [
        item
        for chain in realized.json()["structure"]["sequence"]
        for item in chain["items"]
        if item["kind"] == "segment"
    ]
    assert realized_segments
    assert all(segment["realized"] for segment in realized_segments)
    collapsed = client.post(f"/api/sessions/{session_id}/segments/collapse")
    assert collapsed.status_code == 200, collapsed.text
    assert collapsed.json()["structure"]["atom_count"] == collapsed_count
    collapsed_segments = [
        item
        for chain in collapsed.json()["structure"]["sequence"]
        for item in chain["items"]
        if item["kind"] == "segment"
    ]
    assert all(not segment["realized"] for segment in collapsed_segments)


def test_combine_and_reset_residue_routes() -> None:
    first = _session()
    second = _session()
    original = client.get(f"/api/sessions/{first}").json()["structure"]["atom_count"]
    combined = client.post(
        f"/api/sessions/{first}/combine",
        json={"session_ids": [second]},
    )
    assert combined.status_code == 200, combined.text
    assert combined.json()["structure"]["atom_count"] == 2 * original
    reset = client.post(f"/api/sessions/{first}/reset-residue-ids")
    assert reset.status_code == 200, reset.text


def test_cath_condition_is_validated_and_roundtrips_through_http() -> None:
    session_id = _session()
    request = {"condition": "C_CATH", "atom_indices": [0], "scope": "residue", "value": "2.60.40"}
    response = client.post(f"/api/sessions/{session_id}/conditions", json=request)
    assert response.status_code == 200, response.text
    bad = client.post(f"/api/sessions/{session_id}/conditions", json={**request, "value": "999.999.999"})
    assert bad.status_code == 422, bad.text
    downloaded = client.get(f"/api/sessions/{session_id}/cif")
    assert downloaded.status_code == 200
    assert "2.60.40.x" in downloaded.text


def test_protonation_api_and_undo() -> None:
    session_id = _session()
    path = f"/api/sessions/{session_id}"
    before = client.get(path).json()["structure"]
    for ph in (-1, 15):
        assert client.post(f"{path}/protonate", json={"ph": ph}).status_code == 422
    response = client.post(f"{path}/protonate", json={"ph": 7.4})
    assert response.status_code == 200, response.text
    assert response.json()["edit_result"]["hydrogen_count"] > 0
    assert response.json()["structure"]["revision"] == before["revision"] + 1
    undone = client.post(f"{path}/undo").json()["structure"]
    assert undone["atom_count"] == before["atom_count"]


def test_packaged_design_examples_share_a_safe_catalog() -> None:
    from annotation_studio.main import EXAMPLES_DIR

    catalog = client.get("/api/v1/examples").json()
    assert len(catalog) == 9
    assert len({item["id"] for item in catalog}) == 9
    for item in catalog:
        response = client.get(f"/api/v1/examples/{item['id']}/cif")
        assert response.status_code == 200
        assert response.text == (EXAMPLES_DIR / item["file"]).read_text()
    assert client.get("/api/v1/examples/not-an-example/cif").status_code == 404
