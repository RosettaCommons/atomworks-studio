"""Scientific intent and lossless packaging checks for the hit-based example inputs."""

import hashlib
import json
from pathlib import Path

import numpy as np
import pytest
from atomworks.io.utils.standard_annotations import S_SEGMAX, S_SEGMIN
from atomworks.ml.conditions import C_CRD, C_IDX, C_SEQ
from atomworks_studio_editing.document import StudioDocument
from atomworks_studio_editing.providers import load_providers
from atomworks_studio_rfd4.model import C_CRDGRP, C_HB, C_HOT, C_IDXGRP, C_RAS
from biotite.structure import get_residue_starts

ROOT = Path(__file__).resolve().parents[1]
EXAMPLES = ROOT / "packages/api/annotation_studio/examples"
P = load_providers()


def load(name):
    return StudioDocument.from_cif(
        (EXAMPLES / name).read_text(),
        condition_provider=P.condition_provider,
        validation_provider=P.validation_provider,
    ).array


def test_catalog_is_complete_and_partial_diffusion_is_not_inverse_folding():
    catalog = json.loads((EXAMPLES / "examples.json").read_text())
    assert len(catalog) == len({row["id"] for row in catalog}) == 10
    assert {row["file"] for row in catalog} == {path.name for path in EXAMPLES.glob("*.cif")}
    by_id = {row["id"]: row for row in catalog}
    assert by_id["inverse_folding"]["task"] == "inverse_folding"
    assert by_id["partial_diffusion"]["task"] == "partial_diffusion"
    assert by_id["ptm_binder"]["task"] == "unconditional"


def test_provenance_hashes_and_unchanged_bhrf1_complex():
    provenance = json.loads((EXAMPLES / "hit-example-provenance.json").read_text())
    for name, record in provenance.items():
        assert hashlib.sha256((EXAMPLES / name).read_bytes()).hexdigest() == record["sha256"]
    complex_record = provenance["partial_diffusion.cif"]
    assert complex_record["unchanged_source_bytes"]
    assert (
        complex_record["sha256"]
        == complex_record["source_sha256"]
        == "a0ba838ceacc226eecdf4a7016df78168f94e047315e299897ccc1170c09d69f"
    )


def test_pte_inverse_folding_conditions_only_motif_sequence_and_backbone_plus_tips():
    a = load("inverse_folding.cif")
    protein = a.chain_id == "A"
    motif = protein & np.isin(a.res_id, [16, 45, 75, 79, 94, 98, 102, 105])
    np.testing.assert_array_equal(C_SEQ.mask(a, default="generate"), motif | ~protein)
    fixed = C_CRD.mask(a, default="generate")
    backbone = protein & np.isin(a.atom_name, ["N", "CA", "C", "O"])
    assert backbone.sum() == 880
    assert fixed.sum() == 951
    assert fixed[backbone | ~protein].all()
    assert not fixed[protein & ~motif & ~backbone].any()
    assert C_IDX.mask(a, default="generate").all()
    np.testing.assert_array_equal(C_CRDGRP.annotation(a, default="generate") == 0, fixed)
    np.testing.assert_allclose(C_CRD.annotation(a)[backbone], a.coord[backbone], atol=0.001)


def test_pte_scaffold_has_independent_islands_and_indexed_kcx_between_segments():
    a = load("enzyme_design.cif")
    indexed = C_IDX.mask(a, default="generate")
    groups = C_IDXGRP.annotation(a, default="generate")
    starts = get_residue_starts(a)
    islands = starts[~indexed[starts]]
    assert len(islands) == 7
    assert len(set(groups[islands])) == 7
    assert set(a.res_name[islands]) == {"ASP", "HIS", "TRP"}
    for start in islands:
        members = groups == groups[start]
        assert not indexed[members].any()
        assert len(get_residue_starts(a[members])) == 1
    for group in np.unique(groups):
        assert len(set(indexed[groups == group])) == 1
    protein_starts = starts[a.chain_id[starts] == "A"]
    assert list(a.res_name[protein_starts][-3:]) == ["75-100", "KCX", "75-100"]
    assert len(set(groups[protein_starts][-3:])) == 1
    assert indexed[protein_starts[-3:]].all()
    segments = a.res_name == "75-100"
    np.testing.assert_array_equal(S_SEGMIN.annotation(a)[segments], [75, 75])
    np.testing.assert_array_equal(S_SEGMAX.annotation(a)[segments], [100, 100])
    assert np.isnan(a.coord[segments]).all()
    assert not C_SEQ.mask(a, default="generate")[segments].any()
    assert not C_CRD.mask(a, default="generate")[segments].any()
    # Retained atom chemistry, coordinates and tip targets equal the complete hit.
    original = load("inverse_folding.cif")

    def keys(b):
        return list(zip(b.chain_id, b.res_id, b.res_name, b.atom_name, strict=True))

    lookup = {key: i for i, key in enumerate(keys(original))}
    retained = a[~segments]
    expected = original[[lookup[key] for key in keys(retained)]]
    np.testing.assert_array_equal(retained.bonds.as_array(), expected.bonds.as_array())
    np.testing.assert_array_equal(retained.charge, expected.charge)
    np.testing.assert_allclose(retained.coord, expected.coord, atol=0.001)
    fixed = C_CRD.mask(retained, default="generate")
    assert fixed.sum() == 71
    np.testing.assert_allclose(C_CRD.annotation(retained)[fixed], C_CRD.annotation(expected)[fixed], atol=0.001)
    assert C_SEQ.mask(retained, default="generate").all()
    # No accidental peptide bonds join separately placeable islands after reload.
    for left, right, _ in a.bonds.as_array():
        if not indexed[left] or not indexed[right]:
            assert a.res_id[left] == a.res_id[right]


@pytest.mark.parametrize(
    "file,target_atoms,length,internal",
    [
        ("ptm_binder.cif", 96, "150-150", 0),
        ("protein_binder.cif", 1266, "50-120", 628),
    ],
)
def test_binders_keep_only_target_and_free_design_segment(file, target_atoms, length, internal):
    a = load(file)
    target = a.chain_id == "B"
    assert target.sum() == target_atoms
    assert list(a.res_name[~target]) == [length]
    assert set(a.chain_id) == {"A", "B"}
    np.testing.assert_array_equal(C_SEQ.mask(a, default="generate"), target)
    assert not C_CRD.mask(a, default="generate").any()
    groups = C_CRDGRP.annotation(a, default="generate")
    assert (groups > 0).sum() == internal
    if internal:
        np.testing.assert_array_equal(groups > 0, target & np.isin(a.atom_name, ["N", "CA", "C", "O"]))
        assert len(set(groups[groups > 0])) == 1
    else:
        assert set(a.res_name[target]) >= {"SEP"}
    assert np.isnan(a.coord[~target]).all()
    assert C_IDX.mask(a, default="generate").all()
    assert not C_HOT.mask(a, default="generate").any()
    assert not C_HB.annotation(a, default="generate").any()
    assert not C_RAS.annotation(a, default="generate").any()


def test_partial_diffusion_retains_bhrf1_binder_and_source_conditioning():
    a = load("partial_diffusion.cif")
    binder = a.chain_id == "A"
    target = a.chain_id == "B"
    assert len(a) == 2150
    assert binder.sum() == 884 and target.sum() == 1266
    assert len(get_residue_starts(a[binder])) == 111
    assert len(get_residue_starts(a[target])) == 157
    assert np.isfinite(a.coord).all()
    np.testing.assert_array_equal(C_SEQ.mask(a, default="generate"), target)
    np.testing.assert_array_equal(
        C_CRD.mask(a, default="generate"), target & np.isin(a.atom_name, ["N", "CA", "C", "O"])
    )
    assert not C_CRD.mask(a, default="generate")[binder].any()
