"""Semantic conformance tests against native AtomWorks condition APIs."""

from pathlib import Path

import numpy as np
import pytest
from annotation_studio.core import StudioDocument
from atomworks.io.utils.standard_annotations.base import STANDARD_ANNOTATIONS, StandardAnnotationBase
from atomworks.ml.conditions import C_CHA, C_CRD, C_DIS, C_SEQ
from atomworks_studio_editing.annotations import editing_type, is_structure_derived
from atomworks_studio_editing.mutations import edit_distance_restraint
from atomworks_studio_editing.validation import validate_atom_array
from atomworks_studio_rfd4 import CONDITION_PROVIDER, VALIDATION_PROVIDER
from atomworks_studio_rfd4.condition_contract import editable_condition_classes
from atomworks_studio_rfd4.model import C_BP, C_CATH, C_PICATION, C_RAS

pytestmark = pytest.mark.usefixtures("stable_cif_metadata")

FIXTURE = Path(__file__).parent / "fixtures" / "SAM_hbonds.cif"
CONDITIONS = {definition.key: definition.condition for definition in CONDITION_PROVIDER.definitions}


def test_derived_query_does_not_mutate_document():
    document = _rfd4_document((FIXTURE.parent / "minimal_multichain.cif").read_text())
    if "is_protein" in document.array.get_annotation_categories():
        document.array.del_annotation("is_protein")
    before = document.export_state()
    assert document.query_indices("is_protein").tolist() == list(range(len(document.array)))
    assert "is_protein" not in document.array.get_annotation_categories()
    assert document.export_state() == before


def _condition_roundtrip_cases():
    for definition in CONDITION_PROVIDER.definitions:
        if definition.kind in {"pair", "operation"}:
            continue
        if definition.kind == "enum":
            value = next(member.value for member in definition.enum_values if member.value != definition.default)
        elif definition.kind == "scalar":
            value = 0.0
        elif definition.kind == "text":
            value = "2.60.40"
        elif definition.kind == "integer":
            value = 7
        elif definition.kind == "vector3":
            value = [1.25, -2.5, 3.75]
        else:
            value = None
        scope = (
            "chain" if definition.level.value == "chain" else "atom" if definition.level.value == "atom" else "residue"
        )
        yield pytest.param(definition.key, value, scope, id=definition.key)


def _rfd4_document(cif: str, name: str = "structure") -> StudioDocument:
    return StudioDocument.from_cif(
        cif,
        name,
        condition_provider=CONDITION_PROVIDER,
        validation_provider=VALIDATION_PROVIDER,
    )


@pytest.fixture
def document() -> StudioDocument:
    return _rfd4_document(FIXTURE.read_text(), FIXTURE.stem)


@pytest.mark.parametrize(
    ("name", "value", "scope"),
    _condition_roundtrip_cases(),
)
def test_every_plugin_condition_survives_cif_roundtrip(
    document: StudioDocument,
    name: str,
    value: int | list[float] | None,
    scope: str,
) -> None:
    document.set_condition(name, [0], enabled=True, value=value, scope=scope)
    reparsed = _rfd4_document(document.to_cif())
    condition = CONDITIONS[name]

    expected_mask = condition.mask(document.array, default="generate")
    actual_mask = condition.mask(reparsed.array, default="generate")
    assert np.array_equal(actual_mask, expected_mask)

    if condition.has_annotation(document.array):
        expected = condition.annotation(document.array, default="generate")
        actual = condition.annotation(reparsed.array, default="generate")
        np.testing.assert_equal(actual, expected)


def test_export_is_semantically_idempotent(document: StudioDocument) -> None:
    first = _rfd4_document(document.to_cif())
    second = _rfd4_document(first.to_cif())

    assert len(first.array) == len(second.array)
    assert np.allclose(first.array.coord, second.array.coord, equal_nan=True)
    assert first.summary()["condition_counts"] == second.summary()["condition_counts"]


def test_rfd4_alias_input_is_exported_canonically() -> None:
    alias_cif = FIXTURE.read_text().replace(f"_atom_site.{C_RAS.full_name}", "_atom_site.C_RAS")
    document = _rfd4_document(alias_cif)

    assert "C_RAS" not in document.array.get_annotation_categories()
    assert C_RAS.full_name in document.array.get_annotation_categories()
    assert f"_atom_site.{C_RAS.full_name}" in document.to_cif()


def test_rfd4_provider_registers_and_preserves_project_annotations(document: StudioDocument) -> None:
    assert "src-component" in STANDARD_ANNOTATIONS.list()
    from atomworks_studio_rfd4.model import standard_annotations

    source_component = standard_annotations.SA_SRC

    expected = np.full(len(document.array), "component-x", dtype="<U10")
    source_component.set_annotation(document.array, expected)

    reparsed = _rfd4_document(document.to_cif())

    np.testing.assert_array_equal(source_component.annotation(reparsed.array, default="raise"), expected)


def test_align_to_restores_common_backbone_coordinates(document: StudioDocument) -> None:
    reference = _rfd4_document(document.to_cif())
    rotation = np.array([[0.0, -1.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0]])
    finite = np.isfinite(document.array.coord).all(axis=1)
    document.array.coord[finite] = document.array.coord[finite] @ rotation + [11.0, -7.0, 3.0]

    result = document.align_to(reference)

    assert result["matched_atom_count"] >= 3
    assert result["rmsd_before"] > 1.0
    assert result["rmsd_after"] < 1e-5
    assert np.allclose(document.array.coord[finite], reference.array.coord[finite], atol=1e-4)


def test_add_modify_delete_annotations_survive_each_export(document: StudioDocument) -> None:
    all_indices = list(range(len(document.array)))
    document.set_condition("hotspot", all_indices, enabled=False)
    document.set_condition("hotspot", [0, 1], enabled=True)
    added = _rfd4_document(document.to_cif())
    assert added.annotation_details("hotspot")[0]["values"][0]["atom_indices"] == [0, 1]

    added.set_condition("hotspot", [0], enabled=False)
    added.set_condition("rasa", [1], enabled=True, value=3)
    modified = _rfd4_document(added.to_cif())
    assert modified.annotation_details("hotspot")[0]["values"][0]["atom_indices"] == [1]
    rasa = modified.annotation_details("rasa")[0]
    assert rasa["values"][0]["label"] == "EXPOSED"
    assert rasa["values"][0]["value"] == 3
    assert rasa["values"][0]["atom_indices"] == [1]

    modified.set_condition("hotspot", [1], enabled=False)
    modified.set_condition("rasa", [1], enabled=False)
    cleared = _rfd4_document(modified.to_cif())
    assert cleared.annotation_details("hotspot") == []
    assert cleared.annotation_details("rasa") == []


def test_condition_aliases_resolve_to_the_stable_ui_definition(document: StudioDocument) -> None:
    for name in ("rasa", C_RAS.name, C_RAS.full_name, *C_RAS.aliases):
        assert CONDITION_PROVIDER.definitions_by_name[name].condition is C_RAS

    document.set_condition("C_RAS", [0], enabled=True, value=3)

    assert document.annotation_details(C_RAS.full_name)[0]["name"] == "rasa"


@pytest.mark.parametrize(
    ("name", "condition", "source", "scope"),
    [("sequence", C_SEQ, "res_name", "residue"), ("coordinate", C_CRD, "coord", "atom")],
)
def test_mask_authored_conditions_materialize_declared_ground_truth(
    document: StudioDocument,
    name: str,
    condition: type[StandardAnnotationBase],
    source: str,
    scope: str,
) -> None:
    selected = document.resolve_indices([0], scope)
    document.set_condition(name, [0], enabled=True, scope=scope)

    np.testing.assert_array_equal(
        condition.annotation(document.array, default="raise")[selected],
        getattr(document.array, source)[selected],
    )


def test_removing_integer_condition_restores_its_structure_default(document: StudioDocument) -> None:
    condition = CONDITIONS["index_group"]
    selected = document.resolve_indices([0], "residue")
    expected = condition.default_annotation(document.array)[selected].copy()

    document.set_condition("index_group", [0], enabled=True, value=7, scope="residue")
    document.set_condition("index_group", [0], enabled=False, scope="residue")

    np.testing.assert_array_equal(condition.annotation(document.array)[selected], expected)


def test_residue_enum_summary_counts_residues_not_atoms(document: StudioDocument) -> None:
    selected = document.resolve_indices([0], "residue")
    document.set_condition("secondary_structure", [0], enabled=True, value=1, scope="residue")

    details = document.annotation_details("secondary_structure")[0]
    assert details["count"] == 1
    assert details["values"][0]["count"] == len(selected) > 1


def test_atom_annotation_details_match_condition_membership(document: StudioDocument) -> None:
    document.set_condition("hotspot", [0], enabled=True)
    details = document.atom_annotation_details(0)
    assert details["atom_index"] == 0
    assert any(annotation["name"] == "hotspot" for annotation in details["annotations"])
    assert not any(annotation["name"] == "hotspot" for annotation in document.atom_annotation_details(1)["annotations"])


def test_shared_contract_drives_studio_and_all_stored_fields_are_visible(document: StudioDocument) -> None:
    assert set(CONDITIONS.values()) == set(editable_condition_classes())
    assert C_PICATION in CONDITIONS.values()
    assert C_CATH in CONDITIONS.values()
    assert not {C_CHA, C_BP} & set(CONDITIONS.values())
    for definition in CONDITION_PROVIDER.definitions:
        condition = definition.condition
        assert editing_type(condition) is not None
        assert STANDARD_ANNOTATIONS.get(condition.aliases[0]) is condition
        if is_structure_derived(condition):
            assert definition.kind in {"mask", "operation"}
    fields = {field["name"] for field in document.stored_annotation_fields()}
    expected = {
        category
        for category in document.array.get_annotation_categories()
        if category.startswith(("mask_", "condition_", "annotation_"))
    }
    assert fields == expected
    assert "condition_saltbridge_1_atom" in fields
    assert fields.intersection({"mask_pistack_1_atom", "condition_pistack_1_atom"})
    atom = document.atom_annotation_details(0)
    assert atom["stored_fields"]


def test_distance_restraints_use_shared_canonical_mutation(document: StudioDocument) -> None:
    direct = document.clone()

    document.edit_distance_restraint(1, 0, "set", 3.25)
    edit_distance_restraint(direct.array, 0, 1, "set", 3.25)

    actual = C_DIS.annotation(document.array, default="raise")
    expected = C_DIS.annotation(direct.array, default="raise")
    assert actual.pairs.tolist() == expected.pairs.tolist()
    assert {tuple(sorted(pair)) for pair in actual.pairs} == {(0, 1)}
    assert actual.values.tolist() == expected.values.tolist()
    assert np.all(actual.values == 3.25)
    assert document.annotation_details("distance")[0]["count"] == 1
    assert document.annotation_details("distance")[0]["values"][0]["atom_indices"] == [0, 1]
    reparsed = _rfd4_document(document.to_cif())
    assert reparsed.distance_restraints()[0]["distance"] == 3.25

    revision = document.revision
    with pytest.raises(ValueError, match="positive finite"):
        document.edit_distance_restraint(0, 1, "set", 0.0)
    assert document.revision == revision
    assert document.distance_restraints()[0]["distance"] == 3.25

    document.edit_distance_restraint(0, 1, "remove")
    assert document.annotation_details("distance") == []
    document.set_condition("distance", [1, 0], enabled=True, value=4.5)
    assert document.distance_restraints()[0]["distance"] == 4.5


def test_document_uses_shared_atomworks_validation(document: StudioDocument) -> None:
    document.array.coord[0, 0] = np.inf
    shared = validate_atom_array(document.array)

    assert shared == [{"severity": "error", "check": "coordinates", "message": "coordinates contain infinity"}]
    assert document.validate()[: len(shared)] == shared


def test_interactions_use_live_geometry_and_preserve_authored_targets(document: StudioDocument) -> None:
    baseline = document.analyze_interactions(inter_chain_only=False, hbond_model="plip")
    assert baseline["interaction_count"] > 0
    document.set_condition("coordinate", [0], enabled=True)
    targets = C_CRD.annotation(document.array).copy()
    targets[0] += 1000
    C_CRD.set_annotation(document.array, targets)
    document.set_condition("hotspot", [1], enabled=True)
    before = document.export_state()
    analyzed = document.analyze_interactions(inter_chain_only=False, hbond_model="plip")
    assert analyzed["interactions"] == baseline["interactions"]
    assert document.export_state() == before


def test_plddt_confidence_is_exposed_in_colored_buckets(document: StudioDocument) -> None:
    confidence = np.full(len(document.array), 95.0)
    confidence[:3] = [25.0, 60.0, 80.0]
    document.array.set_annotation("b_factor", confidence)

    field = document.scalar_annotation_fields("b_factor")[0]
    assert [value["label"] for value in field["values"]] == [
        "Very low (<50)",
        "Low (50-70)",
        "Confident (70-90)",
        "Very high (≥90)",
    ]
    assert field["values"][0]["color"]["name"] == "red"
    assert field["values"][-1]["color"]["name"] == "blue"
    assert document.atom_annotation_details(2)["scalar_fields"][0]["value"] == 80.0


def test_charge_bond_delete_and_undo(document: StudioDocument) -> None:
    original_count = len(document.array)
    document.set_charge([0], value=1)
    document.edit_bond(0, 1, "add", "SINGLE")
    document.delete_atoms([0])
    assert len(document.array) == original_count - 1
    assert document.undo()
    assert len(document.array) == original_count
    assert int(document.array.charge[0]) == 1


def test_expandable_segment_insert_realize_collapse(document: StudioDocument) -> None:
    document.insert_segment(2, 4, atom_index=0, before=False)
    collapsed_count = len(document.array)
    document.realize_segments(seed=7)
    assert len(document.array) >= collapsed_count + 1
    document.collapse_segments()
    assert len(document.array) == collapsed_count


def test_expandable_only_protein_chain_survives_cif_roundtrip(document: StudioDocument) -> None:
    document.insert_segment(
        50,
        120,
        new_chain=True,
        chain_id="Z",
        chain_type="polypeptide(L)",
    )

    reparsed = _rfd4_document(document.to_cif())
    chain = reparsed.array[reparsed.array.chain_id == "Z"]

    assert len(chain) == 1
    assert chain.chain_type[0] == document.array[document.array.chain_id == "Z"].chain_type[0]
    assert bool(chain.is_polymer[0])


def test_combine_resolves_chain_conflicts_and_reset_ids(document: StudioDocument) -> None:
    other = _rfd4_document(FIXTURE.read_text(), "other")
    original_count = len(document.array)
    document.combine([other])

    assert len(document.array) == 2 * original_count
    assert len(np.unique(document.array.chain_id)) == 4
    document.reset_residue_ids()
    for chain in np.unique(document.array.chain_iid):
        assert int(document.array.res_id[document.array.chain_iid == chain].min()) == 1
