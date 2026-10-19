"""Protonation preserves heavy-atom authoring and remains undoable in the saved document."""

from pathlib import Path

import numpy as np
import pytest
from atomworks.experimental.protonation import add_hydrogens
from atomworks.io.utils.standard_annotations.base import STANDARD_ANNOTATIONS
from atomworks.ml.conditions import C_CRD, C_DIS, C_SEQ
from atomworks_studio_editing.document import StudioDocument
from atomworks_studio_editing.loading import inspect_import
from atomworks_studio_editing.mutations import edit_distance_restraint
from atomworks_studio_rfd4 import CONDITION_PROVIDER
from atomworks_studio_rfd4.model import C_CRDGRP, C_INTCRD

FIXTURE = Path(__file__).parent / "fixtures/SAM_hbonds.cif"


@pytest.fixture
def document():
    return StudioDocument.from_cif(FIXTURE.read_text(), condition_provider=CONDITION_PROVIDER)


def test_protonation_matches_upstream_preserves_annotations_and_undo(document):
    heavy = np.flatnonzero(document.array.element != "H")
    document.set_condition("sequence", heavy[:2].tolist())
    edit_distance_restraint(document.array, int(heavy[0]), int(heavy[1]), "set", 3.0)
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

    monkeypatch.setattr("atomworks_studio_editing.document.assign_hydrogens", fail)
    with pytest.raises(ValueError, match="Unsupported geometry"):
        document.protonate()
    assert document.export_state() == before


EXAMPLES = sorted((Path(__file__).parents[1] / "packages/api/annotation_studio/examples").glob("*.cif"))


@pytest.mark.parametrize("path", EXAMPLES, ids=lambda path: path.stem)
def test_protonate_examples_preserves_saved_conditions(path):
    document = StudioDocument.from_cif(
        path.read_text(),
        condition_provider=CONDITION_PROVIDER,
        parse_options={"preset": inspect_import(path)["preset"], "assembly": "asym"},
    )
    before = document.array.copy()
    if "atom_id" not in before.get_annotation_categories():
        before.set_annotation("atom_id", np.arange(len(before)))
    document.protonate()
    after = document.array
    original_indices = {(atom.chain_iid, atom.atom_id): index for index, atom in enumerate(before)}
    source = np.array([original_indices.get((atom.chain_iid, atom.atom_id), -1) for atom in after])
    retained = source >= 0
    np.testing.assert_equal(after.coord[retained], before.coord[source[retained]])
    assert set(before.atom_id[before.element != "H"]) <= set(after.atom_id)
    for annotation in STANDARD_ANNOTATIONS:
        if annotation.n_body == 1 and annotation.has_annotation(before):
            np.testing.assert_equal(
                annotation.annotation(after)[retained],
                annotation.annotation(before)[source[retained]],
                err_msg=annotation.full_name,
            )
    assert not C_CRD.mask(after, default="generate")[~retained].any()
    np.testing.assert_array_equal(
        C_CRDGRP.annotation(after, default="generate") == 0, C_CRD.mask(after, default="generate")
    )
    restored = StudioDocument.from_cif(document.to_cif(), condition_provider=CONDITION_PROVIDER)
    np.testing.assert_equal(
        C_CRD.annotation(restored.array, default="generate"), C_CRD.annotation(after, default="generate")
    )
    document.protonate()
    np.testing.assert_equal(document.array.coord, after.coord)
    document.undo()
    document.undo()
    np.testing.assert_equal(document.array.coord, before.coord)
    np.testing.assert_array_equal(document.array.bonds.as_array(), before.bonds.as_array())


def test_protonation_keeps_saved_absolute_and_internal_targets(document):
    document.set_condition("coordinate", [0, 1])
    document.set_condition("coordinate_group", [2, 3], value=7)
    absolute = C_CRD.annotation(document.array).copy()
    absolute[:2] += 10
    C_CRD.set_annotation(document.array, absolute)
    internal = C_INTCRD.default_annotation(document.array)
    internal[2:4] = [[-1, 0, 0], [1, 0, 0]]
    C_INTCRD.set_annotation(document.array, internal)
    before = document.array.copy()
    document.protonate()
    after = document.array
    original_indices = {atom_id: index for index, atom_id in enumerate(before.atom_id)}
    source = np.array([original_indices.get(atom_id, -1) for atom_id in after.atom_id])
    retained = source >= 0
    for condition in (C_CRD, C_CRDGRP, C_INTCRD):
        np.testing.assert_equal(condition.annotation(after)[retained], condition.annotation(before)[source[retained]])
        np.testing.assert_equal(condition.annotation(after)[~retained], condition.default_annotation(after)[~retained])
