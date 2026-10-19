"""Shipped annotated examples open without an ambiguous parse-preset decision."""

from pathlib import Path
from runpy import run_path

import numpy as np
import pytest
from atomworks.io import parse
from atomworks.io.utils.io_utils import to_cif_file
from atomworks.ml.conditions import C_CRD, C_IDX, C_SEQ
from atomworks_studio_editing.document import StudioDocument
from atomworks_studio_editing.loading import build_load_config, inspect_import
from atomworks_studio_editing.mutations import edit_distance_restraint
from atomworks_studio_editing.providers import load_providers
from biotite.structure import get_residue_starts

ROOT = Path(__file__).resolve().parents[1]
EXAMPLES = sorted((ROOT / "packages/api/annotation_studio/examples").glob("*.cif")) + sorted(
    (ROOT / "examples").glob("*.cif")
)
PROVIDERS = load_providers()


@pytest.mark.parametrize("path", EXAMPLES, ids=lambda path: path.stem)
def test_bundled_examples_infer_without_conflict(path: Path) -> None:
    assert inspect_import(path)["preset"] in {"minimal", "rcsb"}
    parsed = parse(path, config=build_load_config("minimal", assembly="asym"))
    array = parsed["asym_unit"][0]
    for chain, info in parsed["chain_info"].items():
        atoms = array[array.chain_id == chain]
        starts = get_residue_starts(atoms)
        assert list(atoms.res_name[starts]) == list(info["res_name"])


def test_enzyme_added_atoms_have_free_coordinates_and_consistent_residue_conditions() -> None:
    path = ROOT / "packages/api/annotation_studio/examples/enzyme_design.cif"
    document = StudioDocument.from_cif(path.read_text(), condition_provider=PROVIDERS.condition_provider)
    array = document.array
    residue = array.res_name == "ASP"
    assert set(array.atom_name[residue]) == {"N", "CA", "C", "O", "CB", "CG", "OD1", "OD2", "OXT"}
    added = residue & np.isin(array.atom_name, ["N", "CA", "C", "O", "CB", "OD2", "OXT"])
    assert np.isnan(array.coord[added]).all()
    assert not C_CRD.mask(array, default="generate")[added].any()
    assert C_CRD.mask(array, default="generate")[residue].sum() == 2
    assert C_SEQ.mask(array, default="generate")[residue].all()
    assert not C_IDX.mask(array, default="generate")[residue].any()
    assert not document.validate()


def test_completion_preserves_pair_annotations_and_original_source(tmp_path: Path) -> None:
    source = ROOT / "packages/api/annotation_studio/examples/enzyme_design.cif"
    document = StudioDocument.from_cif(source.read_text(), condition_provider=PROVIDERS.condition_provider)
    array = document.array
    array = array[~((array.res_name == "ASP") & np.isnan(array.coord).all(axis=1))]
    edit_distance_restraint(array, 1, 14, "set", 4.0)
    incomplete = tmp_path / "incomplete.cif"
    to_cif_file(array, incomplete)
    before = incomplete.read_bytes()
    complete = run_path(str(ROOT / "scripts/complete_example_atoms.py"))["complete_example"]
    assert complete(incomplete, tmp_path / "complete.cif") == 7
    assert incomplete.read_bytes() == before
    assert inspect_import(tmp_path / "complete.cif")["preset"] == "minimal"


def test_antibody_has_separate_ig_groups_and_a_free_h3() -> None:
    from atomworks_studio_rfd4.model import C_CRDGRP, C_INTCRD

    path = ROOT / "packages/api/annotation_studio/examples/antibody_design.cif"
    document = StudioDocument.from_cif(path.read_text(), condition_provider=PROVIDERS.condition_provider)
    array = document.array
    groups = C_CRDGRP.annotation(array)
    seq = C_SEQ.mask(array, default="generate")
    resolved = np.isfinite(array.coord).all(axis=1)
    free = (array.chain_id == "H") & np.isin(array.res_id, np.arange(99, 110))
    np.testing.assert_array_equal(~seq, free)
    np.testing.assert_array_equal(groups == 1, (array.chain_id == "H") & seq & resolved)
    np.testing.assert_array_equal(groups == 2, (array.chain_id == "L") & seq & resolved)
    np.testing.assert_array_equal(groups == 0, C_CRD.mask(array, default="generate"))
    assert set(array.chain_id[groups == 0]) == {"T"}
    assert set(groups[free]) == {-1}
    lys30 = (array.chain_id == "H") & (array.res_id == 30) & resolved
    assert lys30.sum() == 5
    assert (groups[lys30] == 1).all()
    assert not np.isfinite(C_INTCRD.annotation(array, default="generate")).any()
    assert not document.validate(full_pipeline=True)


def test_sam_has_a_real_conformer_without_coordinate_conditioning() -> None:
    from atomworks_studio_rfd4.model import C_CRDGRP

    path = ROOT / "packages/api/annotation_studio/examples/small_molecule_binder.cif"
    document = StudioDocument.from_cif(path.read_text(), condition_provider=PROVIDERS.condition_provider)
    array = document.array
    ligand = array[array.res_name == "SAM"]
    assert len(ligand) == 27
    assert np.isfinite(ligand.coord).all()
    assert len(np.unique(ligand.coord, axis=0)) == 27
    bonds = ligand.bonds.as_array()
    lengths = np.linalg.norm(ligand.coord[bonds[:, 0]] - ligand.coord[bonds[:, 1]], axis=1)
    assert ((lengths > 1.1) & (lengths < 2.0)).all()
    np.testing.assert_allclose(ligand.coord[ligand.atom_name == "N"], [[-1.947, -1.185, 3.414]], atol=1e-5)
    assert not C_CRD.mask(array, default="generate").any()
    assert (C_CRDGRP.annotation(array, default="generate") == -1).all()
    assert C_SEQ.mask(ligand, default="generate").all()
    assert np.isnan(array.coord[array.res_name == "150-150"]).all()
    assert not document.validate(full_pipeline=True)
