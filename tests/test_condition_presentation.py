"""Presentation choices preserve the underlying scientific annotations."""

from pathlib import Path

from annotation_studio.main import schema
from atomworks.ml.conditions import C_NTR
from atomworks_studio_editing.document import StudioDocument
from atomworks_studio_rfd4 import CONDITION_PROVIDER
from atomworks_studio_rfd4.reporting import summarize_conditions

FIXTURE = Path(__file__).parent / "fixtures/minimal_multichain.cif"


def test_hidden_conditions_remain_available_for_stored_data() -> None:
    hidden = {"n_terminus", "c_terminus", "internal_coordinate"}
    assert hidden.isdisjoint(schema()["conditions"])
    assert schema()["conditions"]["na_ss_state"]["label"] == "Nucleic Acid Secondary Structure"
    document = StudioDocument.from_cif(FIXTURE.read_text(), condition_provider=CONDITION_PROVIDER)
    document.set_condition("n_terminus", [0], enabled=True)
    document.set_condition("coordinate_group", [0, 1], value=1)
    assert C_NTR.mask(document.array, default="generate")[:2].all()
    assert hidden.isdisjoint(entry["name"] for entry in document.annotation_details())
    assert document.annotation_details("internal_coordinate")[0]["count"] == 2
    report = summarize_conditions(document.array)
    assert "Internal coordinates" not in report
    assert "terminus" not in report.lower()
    assert "Coordinate groups: 1 groups" in report


def test_absolute_group_has_an_explicit_label() -> None:
    document = StudioDocument.from_cif(FIXTURE.read_text(), condition_provider=CONDITION_PROVIDER)
    document.set_condition("coordinate", [0], enabled=True)
    entry = document.annotation_details("coordinate_group")[0]
    assert entry["count"] == 1
    assert entry["values"][0]["label"] == "Absolute coordinates (group 0)"
