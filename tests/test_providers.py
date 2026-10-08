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
