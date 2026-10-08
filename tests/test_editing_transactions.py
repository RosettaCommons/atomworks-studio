"""Editor failures must not consume history or leave partially updated structures."""

from pathlib import Path

import numpy as np
import pytest
from atomworks_studio_editing.document import StudioDocument
from atomworks_studio_rfd4 import CONDITION_PROVIDER
from atomworks_studio_rfd4.model import C_CATH

pytestmark = pytest.mark.usefixtures("stable_cif_metadata")

FIXTURE = Path(__file__).parent / "fixtures" / "SAM_hbonds.cif"


def test_failed_edit_preserves_full_history_and_revision() -> None:
    document = StudioDocument.from_cif(FIXTURE.read_text())
    for charge in range(10):
        document.set_charge([0], value=charge)
    before = document.export_state()

    def fail_after_mutation(array, _indices, _enabled):
        array.coord[:] = 123
        array.charge[:] = -9
        raise ValueError("provider failed")

    with pytest.raises(ValueError, match="provider failed"):
        document.apply_selection_transform([0], "atom", fail_after_mutation, True)
    assert document.export_state() == before
    for expected in reversed(range(9)):
        assert document.undo()
        assert document.array.charge[0] == expected
    assert document.undo()
    assert not document.undo()


def test_nested_edits_commit_as_one_undo_step() -> None:
    document = StudioDocument.from_cif(FIXTURE.read_text())
    before = document.to_cif()
    with document.edit():
        document.set_charge([0], value=3)
        document.edit_distance_restraint(0, 1, "set", 4.25)
    assert document.revision == 1
    assert document.undo()
    assert document.to_cif() == before
    assert not document.undo()


def test_cath_edit_roundtrip_clear_and_reject_unknown_labels() -> None:
    document = StudioDocument.from_cif(FIXTURE.read_text(), condition_provider=CONDITION_PROVIDER)
    document.set_condition("C_CATH", [0], value="2.60.40", scope="residue")
    assert C_CATH.annotation(document.array)[0] == "2.60.40.x"
    reparsed = StudioDocument.from_cif(document.to_cif(), condition_provider=CONDITION_PROVIDER)
    np.testing.assert_array_equal(C_CATH.annotation(reparsed.array), C_CATH.annotation(document.array))
    assert reparsed.annotation_details("C_CATH")[0]["values"][0]["value"] == "2.60.40.x"
    before = document.export_state()
    with pytest.raises(ValueError, match="Unknown CAT label"):
        document.set_condition("C_CATH", [0], value="999.999.999", scope="residue")
    assert document.export_state() == before
    document.set_condition("C_CATH", [0], enabled=False, scope="residue")
    assert not C_CATH.mask(document.array)[0]
    assert C_CATH.annotation(document.array)[0] == C_CATH.NULL_VALUE
