"""Protonation preserves heavy-atom authoring and remains undoable in the saved document."""

from pathlib import Path

import numpy as np
import pytest
from atomworks.experimental.protonation import add_hydrogens
from atomworks.ml.conditions import C_DIS, C_SEQ
from atomworks_studio_editing.document import StudioDocument
from atomworks_studio_rfd4 import CONDITION_PROVIDER

FIXTURE = Path(__file__).parent / "fixtures/SAM_hbonds.cif"


@pytest.fixture
def document():
    return StudioDocument.from_cif(FIXTURE.read_text(), condition_provider=CONDITION_PROVIDER)


def test_protonation_matches_upstream_preserves_annotations_and_undo(document):
    heavy = np.flatnonzero(document.array.element != "H")
    document.set_condition("sequence", heavy[:2].tolist())
    document.edit_distance_restraint(int(heavy[0]), int(heavy[1]), "set", 3.0)
    before = document.array.copy()
    expected = add_hydrogens(before.copy(), ph=7.4)
    result = document.protonate(7.4)
    assert result["hydrogen_count"] > 0
    np.testing.assert_equal(document.array.coord, expected.coord)
    np.testing.assert_array_equal(document.array.charge, expected.charge)
    actual_heavy = document.array[document.array.element != "H"]
    original_heavy = before[before.element != "H"]
    np.testing.assert_equal(actual_heavy.coord, original_heavy.coord)
    np.testing.assert_array_equal(actual_heavy.atom_id, original_heavy.atom_id)
    np.testing.assert_equal(C_SEQ.annotation(actual_heavy), C_SEQ.annotation(original_heavy))
    np.testing.assert_array_equal(C_DIS.annotation(actual_heavy).pairs, C_DIS.annotation(original_heavy).pairs)
    np.testing.assert_equal(C_DIS.annotation(actual_heavy).values, C_DIS.annotation(original_heavy).values)
    restored = StudioDocument.from_cif(document.to_cif(), condition_provider=CONDITION_PROVIDER)
    assert np.count_nonzero(restored.array.element == "H") == result["hydrogen_count"]
    np.testing.assert_array_equal(restored.array.charge, document.array.charge)
    document.undo()
    np.testing.assert_equal(document.array.coord, before.coord)
    np.testing.assert_array_equal(document.array.bonds.as_array(), before.bonds.as_array())
    np.testing.assert_array_equal(document.array.atom_name, before.atom_name)


@pytest.mark.parametrize("ph", [-1, 15, float("nan"), float("inf")])
def test_invalid_ph_does_not_change_document(document, ph, stable_cif_metadata):
    before = document.export_state()
    with pytest.raises(ValueError, match="pH"):
        document.protonate(ph)
    assert document.export_state() == before


def test_protonation_failure_rolls_back(document, monkeypatch, stable_cif_metadata):
    before = document.export_state()

    def fail(array, *, ph):
        array.coord[:] = 0
        raise ValueError("Unsupported geometry")

    monkeypatch.setattr("atomworks_studio_editing.document.add_hydrogens", fail)
    with pytest.raises(ValueError, match="Unsupported geometry"):
        document.protonate()
    assert document.export_state() == before
