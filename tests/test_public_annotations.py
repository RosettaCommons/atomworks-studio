"""Public AtomWorks editing works independently of the shared RFD4 adapter."""

from pathlib import Path

import numpy as np
import pytest
from atomworks_studio_editing.conditions import CONDITION_PROVIDER
from atomworks_studio_editing.document import StudioDocument

FIXTURE = Path(__file__).parent / "fixtures" / "minimal_multichain.cif"


@pytest.mark.parametrize("definition", CONDITION_PROVIDER.definitions, ids=lambda definition: definition.key)
def test_public_condition_apply_inspect_save_remove_undo(definition):
    document = StudioDocument.from_cif(FIXTURE.read_text())
    pair = definition.kind == "pair"
    indices = [0, 1] if pair else [0]
    # Start with no active values, including generated terminal defaults.
    if not pair:
        document.set_condition(definition.key, list(range(len(document.array))), enabled=False)
    document.set_condition(
        definition.key,
        indices,
        scope=definition.level.value,
        value=3.5 if pair else None,
    )
    details = document.annotation_details(definition.key)
    assert len(details) == 1
    assert details[0]["count"] == 1
    expected = [0] if definition.key == "coordinate" else [0, 1]
    assert details[0]["values"][0]["atom_indices"] == expected
    saved = StudioDocument.from_cif(document.to_cif())
    assert saved.annotation_details(definition.key) == details
    if definition.key == "coordinate":
        np.testing.assert_allclose(definition.condition.annotation(saved.array)[0], saved.array.coord[0])
    if definition.key == "sequence":
        assert definition.condition.annotation(saved.array)[:2].tolist() == ["GLY", "GLY"]
    saved.set_condition(definition.key, indices, enabled=False, scope=definition.level.value)
    assert saved.annotation_details(definition.key) == []
    assert saved.undo()
    assert saved.annotation_details(definition.key) == details


def test_api_edits_without_any_installed_provider(monkeypatch):
    from annotation_studio import main
    from atomworks_studio_editing import providers
    from fastapi.testclient import TestClient

    monkeypatch.setattr(providers, "entry_points", lambda **kwargs: [])
    registry = providers.load_providers.__wrapped__()
    assert registry.condition_provider is CONDITION_PROVIDER
    monkeypatch.setattr(main, "condition_provider", registry.condition_provider)
    monkeypatch.setattr(main, "store", main.DocumentStore(condition_provider=registry.condition_provider))
    client = TestClient(main.app)
    assert "sequence" in client.get("/api/schema").json()["conditions"]
    uploaded = client.post("/api/sessions", files={"file": ("input.cif", FIXTURE.read_bytes())})
    assert uploaded.status_code == 200, uploaded.text
    session = uploaded.json()["session_id"]
    response = client.post(
        f"/api/sessions/{session}/conditions",
        json={
            "condition": "sequence",
            "atom_indices": [0],
            "scope": "residue",
        },
    )
    assert response.status_code == 200, response.text
    assert response.json()["structure"]["condition_counts"]["sequence"] == 1
    annotation = client.get(f"/api/sessions/{session}/annotations/sequence").json()["annotation"]
    assert annotation["values"][0]["atom_indices"] == [0, 1]
    restored = StudioDocument.from_cif(client.get(f"/api/sessions/{session}/cif").text)
    assert restored.annotation_details("sequence") == [annotation]


def test_editor_exposes_shared_annotations_without_job_routes():
    from annotation_studio import main
    from atomworks_studio_editing.providers import load_providers
    from atomworks_studio_rfd4 import CONDITION_PROVIDER as RFD4_CONDITIONS

    assert main.condition_provider is load_providers().condition_provider is RFD4_CONDITIONS
    assert "hotspot" in main.schema()["conditions"]
    assert not any("design" in path or "jobs" in path for path in main.app.openapi()["paths"])
