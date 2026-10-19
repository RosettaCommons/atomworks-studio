from __future__ import annotations

from pathlib import Path
from typing import ClassVar

from annotation_studio.contracts import ConditionDefinition
from annotation_studio.core import StudioDocument
from atomworks.io.utils.atom_array_plus import AtomArrayPlus

FIXTURE = Path(__file__).parent / "fixtures" / "SAM_hbonds.cif"


class EmptyConditionProvider:
    definitions: tuple[ConditionDefinition, ...] = ()
    definitions_by_name: ClassVar[dict[str, ConditionDefinition]] = {}

    def after_condition_update(self, name: str, array: AtomArrayPlus) -> None:
        del name, array


class MarkerValidationProvider:
    def validate(self, array: AtomArrayPlus, *, full_pipeline: bool = False) -> list[dict[str, str]]:
        del array
        return [
            {
                "severity": "warning",
                "check": "provider_marker",
                "message": "full" if full_pipeline else "basic",
            }
        ]


def test_document_uses_explicit_model_providers() -> None:
    document = StudioDocument.from_cif(
        FIXTURE.read_text(encoding="utf-8"),
        condition_provider=EmptyConditionProvider(),
        validation_provider=MarkerValidationProvider(),
    )

    assert document.annotation_details() == []
    assert document.validate()[-1] == {
        "severity": "warning",
        "check": "provider_marker",
        "message": "basic",
    }
    assert document.validate(full_pipeline=True)[-1]["message"] == "full"


def test_document_defaults_are_model_neutral() -> None:
    document = StudioDocument.from_cif(FIXTURE.read_text(encoding="utf-8"))

    assert {definition.key for definition in document.condition_provider.definitions} == {
        "sequence",
        "coordinate",
        "index",
        "distance",
        "n_terminus",
        "c_terminus",
    }
    assert "hotspot" not in document.condition_provider.definitions_by_name


def test_rfd4_excludes_distance_authoring_but_preserves_imported_pairs(stable_cif_metadata) -> None:
    import pytest
    from annotation_studio.main import app, store
    from atomworks_studio_rfd4 import CONDITION_PROVIDER
    from fastapi.testclient import TestClient

    generic = StudioDocument.from_cif(FIXTURE.read_text())
    generic.edit_distance_restraint(0, 1, "set", 3.25)
    document = StudioDocument.from_cif(generic.to_cif(), condition_provider=CONDITION_PROVIDER)
    before = document.export_state()
    client = TestClient(app)
    session = store.add(document)

    assert "distance" not in client.get("/api/schema").json()["conditions"]
    assert "distance" not in CONDITION_PROVIDER.definitions_by_name
    assert document.distance_restraints() == generic.distance_restraints()
    with pytest.raises(ValueError, match="unsupported condition"):
        document.set_condition("distance", [0, 1], value=4)
    with pytest.raises(ValueError, match="not supported"):
        document.edit_distance_restraint(0, 1, "set", 4)
    with pytest.raises(ValueError, match="not supported"):
        document.replace_distance_restraints([(0, 1)], [4])
    for path, payload in [
        ("conditions", {"condition": "distance", "atom_indices": [0, 1], "value": 4}),
        ("distance-restraints", {"atom1": 0, "atom2": 1, "action": "set", "distance": 4}),
        ("distance-restraints/replace", {"pairs": [[0, 1]], "values": [4], "expected_revision": 0}),
    ]:
        response = client.post(f"/api/sessions/{session}/{path}", json=payload)
        assert response.status_code == 422, response.text
        assert document.export_state() == before
    restored = StudioDocument.from_cif(document.to_cif(), condition_provider=CONDITION_PROVIDER)
    assert restored.distance_restraints() == generic.distance_restraints()
