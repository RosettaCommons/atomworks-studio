"""Shared authoring behavior across direct, HTTP and native editing paths."""

from pathlib import Path

import numpy as np
import pytest
from annotation_studio.main import app, store
from atomworks.ml.conditions import C_IDX
from atomworks_studio_editing.conditions import CONDITION_PROVIDER as ATOMWORKS_PROVIDER
from atomworks_studio_editing.document import StudioDocument
from atomworks_studio_rfd4 import CONDITION_PROVIDER
from fastapi.testclient import TestClient

FIXTURE = Path(__file__).parent / "fixtures" / "minimal_multichain.cif"


@pytest.mark.parametrize(
    ("key", "value", "expected"),
    [
        ("secondary_structure", 1, [0, 1]),
        ("sequence", None, [0, 1]),
        ("index", None, [0, 1]),
        ("index_group", 17, [0, 1]),
        ("coordinate", None, [0]),
        ("saltbridge", 1, [0]),
        ("saltbridge", 2, [0]),
        ("metal_coord", 1, [0]),
        ("metal_coord", 2, [0]),
        ("chain_centroid", [1.0, 2.0, 3.0], [0, 1]),
    ],
)
def test_condition_level_is_shared_by_http_and_document(key, value, expected):
    document = StudioDocument.from_cif(FIXTURE.read_text(), condition_provider=CONDITION_PROVIDER)
    browser = document.clone()
    client = TestClient(app)
    session = store.add(browser)
    result = document.set_condition(key, [0], value=value)
    response = client.post(
        f"/api/sessions/{session}/conditions",
        json={"condition": key, "atom_indices": [0], "value": value, "scope": "atom"},
    )
    assert response.status_code == 200, response.text
    assert result["affected_count"] == len(expected)
    assert response.json()["edit_result"]["affected_count"] == len(expected)
    condition = CONDITION_PROVIDER.definitions_by_name[key].condition
    np.testing.assert_equal(condition.annotation(document.array), condition.annotation(browser.array))
    if key not in {"index", "index_group", "sequence"}:
        assert np.flatnonzero(condition.mask(document.array)).tolist() == expected
    if value is not None:
        np.testing.assert_allclose(
            condition.annotation(document.array)[expected],
            np.broadcast_to(value, np.shape(condition.annotation(document.array)[expected])),
        )
    restored = StudioDocument.from_cif(document.to_cif(), condition_provider=CONDITION_PROVIDER)
    np.testing.assert_equal(condition.annotation(document.array), condition.annotation(restored.array))
    document.set_condition(key, [0], enabled=False)
    assert document.undo()
    np.testing.assert_equal(condition.annotation(document.array), condition.annotation(restored.array))


def test_token_broadcast_respects_atomization_and_group_counts():
    document = StudioDocument.from_cif(FIXTURE.read_text(), condition_provider=CONDITION_PROVIDER)
    document.array.set_annotation("atomize", np.ones(len(document.array), dtype=bool))
    result = document.edit_condition_group("index_group", "new", [0])
    assert result["affected_count"] == 1
    condition = CONDITION_PROVIDER.definitions_by_name["index_group"].condition
    assert condition.annotation(document.array)[0] != condition.annotation(document.array)[1]
    document.array.set_annotation("atomize", np.zeros(len(document.array), dtype=bool))
    result = document.edit_condition_group("index_group", "new", [0])
    assert result["affected_count"] == 2
    assert condition.annotation(document.array)[0] == condition.annotation(document.array)[1]


@pytest.mark.parametrize(("chains", "expected"), [(["A", "C"], "D"), (["A", "Z"], "AA"), (["AA", "AZ"], "BA")])
def test_new_segment_uses_shared_chain_suggestion_and_undo(chains, expected):
    document = StudioDocument.from_cif(FIXTURE.read_text(), condition_provider=CONDITION_PROVIDER)
    original = list(dict.fromkeys(document.array.chain_id))
    document.array.chain_id = np.array(
        [chains[original.index(chain) % len(chains)] for chain in document.array.chain_id]
    )
    before = document.array.copy()
    assert document.next_chain_id() == expected
    assert document.summary()["next_chain_id"] == expected
    document.insert_segment(5, 10, new_chain=True, chain_type="polypeptide(L)")
    assert expected in document.array.chain_id
    restored = StudioDocument.from_cif(document.to_cif(), condition_provider=CONDITION_PROVIDER)
    assert expected in restored.array.chain_id
    assert document.undo()
    np.testing.assert_equal(document.array.chain_id, before.chain_id)
    document.insert_segment(5, 10, new_chain=True, chain_id="TEST", chain_type="polypeptide(L)")
    assert "TEST" in document.array.chain_id


def test_sequence_probability_schema_keeps_all_channels_in_one_editor():
    client = TestClient(app)
    schema = client.get("/api/schema").json()["conditions"]
    options = {key: definition for key, definition in schema.items() if definition.get("editor_group")}
    assert len(options) == 28
    assert {option["editor_group"] for option in options.values()} == {"Sequence probability"}
    assert {option["option_label"] for option in options.values()} >= {"ALA", "ARG", "A", "DA"}
    assert all(
        (option["minimum"], option["maximum"], option["step"], option["decimals"]) == (0, 1, 0.1, 2)
        for option in options.values()
    )
    assert schema["saltbridge"]["values"] == {"NONE": 0, "POSITIVE": 1, "NEGATIVE": 2}
    assert schema["metal_coord"]["values"] == {"NONE": 0, "METAL": 1, "COORDINATING": 2}


def test_new_segment_rejects_truncated_chain_ids():
    document = StudioDocument.from_cif(FIXTURE.read_text(), condition_provider=CONDITION_PROVIDER)
    with pytest.raises(ValueError, match="at most four"):
        document.insert_segment(5, 10, new_chain=True, chain_id="CUSTOM", chain_type="polypeptide(L)")
    assert document.revision == 0
    assert len(document.array) == 4


@pytest.mark.parametrize("provider", [ATOMWORKS_PROVIDER, CONDITION_PROVIDER])
@pytest.mark.parametrize("via_http", [False, True])
def test_index_defaults_on_and_only_explicit_exceptions_are_unindexed(provider, via_http):
    document = StudioDocument.from_cif(FIXTURE.read_text(), condition_provider=provider)
    assert C_IDX.mask(document.array, default="generate").all()
    assert not document.annotation_details("index")
    assert provider.definitions_by_name["index"].schema["invert_mask"] is True
    client = TestClient(app)
    session = store.add(document)
    for enabled, expected in [(True, [False, False, True, True]), (False, [True] * 4)]:
        if via_http:
            response = client.post(
                f"/api/sessions/{session}/conditions",
                json={"condition": "index", "atom_indices": [0], "enabled": enabled},
            )
            assert response.status_code == 200, response.text
        else:
            document.set_condition("index", [0], enabled=enabled)
        np.testing.assert_equal(C_IDX.mask(document.array), expected)
        restored = StudioDocument.from_cif(document.to_cif(), condition_provider=provider)
        np.testing.assert_equal(C_IDX.mask(restored.array), expected)
        if enabled:
            entry = document.annotation_details("index")[0]
            assert entry["label"] == "Unindexed residues"
            assert entry["values"][0]["atom_indices"] == [0, 1]
        else:
            assert not document.annotation_details("index")
    assert document.undo()
    np.testing.assert_equal(C_IDX.mask(document.array), [False, False, True, True])
    document.reset_conditions()
    assert C_IDX.mask(document.array).all()
