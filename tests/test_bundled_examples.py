"""Shipped examples preserve annotations under the explicit annotated-CIF preset."""

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
def test_bundled_examples_open_with_annotated_preset(path: Path) -> None:
    parsed = parse(path, config=build_load_config("minimal", assembly="asym"))
    array = parsed["asym_unit"][0]
    for chain, info in parsed["chain_info"].items():
        atoms = array[array.chain_id == chain]
        starts = get_residue_starts(atoms)
        assert list(atoms.res_name[starts]) == list(info["res_name"])


def test_enzyme_added_atoms_have_free_coordinates_and_consistent_residue_conditions() -> None:
    path = ROOT / "tests/fixtures/tip_atom_enzyme.cif"
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
    source = ROOT / "tests/fixtures/tip_atom_enzyme.cif"
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


def test_antibody_has_shared_fv_backbone_group_and_six_expandable_cdrs() -> None:
    from atomworks_studio_rfd4.model import C_CATH, C_CRDGRP, C_INTCRD

    path = ROOT / "packages/api/annotation_studio/examples/antibody_design.cif"
    document = StudioDocument.from_cif(
        path.read_text(),
        condition_provider=PROVIDERS.condition_provider,
        validation_provider=PROVIDERS.validation_provider,
    )
    array = document.array
    groups = C_CRDGRP.annotation(array)
    antibody = np.isin(array.chain_id, ["H", "L"])
    resolved = np.isfinite(array.coord).all(axis=1)
    backbone = resolved & np.isin(array.atom_name, ["N", "CA", "C", "O"])
    np.testing.assert_array_equal(groups == 1, antibody & backbone)
    np.testing.assert_array_equal(groups == 0, (array.chain_id == "A") & backbone)
    np.testing.assert_array_equal(C_CRD.mask(array, default="generate"), groups == 0)
    np.testing.assert_array_equal(np.isfinite(C_INTCRD.annotation(array)).all(axis=1), groups == 1)
    free = ~C_SEQ.mask(array, default="generate")
    assert list(zip(array.chain_id[free], array.res_name[free], strict=True)) == [
        ("H", "13-15"),
        ("H", "9-10"),
        ("H", "11-22"),
        ("L", "11-14"),
        ("L", "8-8"),
        ("L", "8-12"),
    ]
    assert np.isnan(array.coord[free]).all()
    assert (groups[free] == -1).all()
    assert (C_CATH.annotation(array)[antibody] == "2.60.40.x").all()
    assert not document.validate(full_pipeline=True)


def test_protein_binder_conditions_only_internal_target_backbone() -> None:
    from atomworks_studio_rfd4.model import C_CRDGRP, C_HOT, C_INTCRD

    path = ROOT / "packages/api/annotation_studio/examples/protein_binder.cif"
    document = StudioDocument.from_cif(
        path.read_text(),
        condition_provider=PROVIDERS.condition_provider,
        validation_provider=PROVIDERS.validation_provider,
    )
    array = document.array
    target = array.chain_id == "B"
    backbone = target & np.isin(array.atom_name, ["N", "CA", "C", "O"])
    assert backbone.sum() == 628
    np.testing.assert_array_equal(C_CRDGRP.annotation(array) == 1, backbone)
    assert not C_CRD.mask(array, default="generate").any()
    assert not np.isfinite(C_INTCRD.annotation(array, default="generate")).any()
    assert C_SEQ.mask(array, default="generate")[target].all()
    assert C_IDX.mask(array, default="generate")[target].all()
    hotspots = C_HOT.mask(array, default="generate")
    assert not hotspots.any()
    assert list(array.res_name[~target]) == ["50-120"]
    assert {issue["check"] for issue in document.validate(full_pipeline=True)} == {"missing_atoms"}


def test_vhh_display_is_near_target_and_preserves_saved_internal_geometry() -> None:
    from atomworks_studio_rfd4.model import C_CRDGRP, C_INTCRD

    path = ROOT / "packages/api/annotation_studio/examples/nanobody.cif"
    document = StudioDocument.from_cif(
        path.read_text(),
        condition_provider=PROVIDERS.condition_provider,
        validation_provider=PROVIDERS.validation_provider,
    )
    array = document.array
    resolved = np.isfinite(array.coord).all(axis=1)
    target = array.coord[(array.chain_id == "A") & resolved]
    vhh = array.coord[(array.chain_id == "H") & resolved]
    separation = np.linalg.norm(vhh[:, None] - target[None, :], axis=2).min()
    assert separation == pytest.approx(8.0, abs=0.002)
    internal = C_CRDGRP.annotation(array) == 1
    assert internal.sum() == 332
    saved = C_INTCRD.annotation(array)[internal]
    displayed = array.coord[internal]
    np.testing.assert_allclose(
        np.linalg.norm(displayed[:, None] - displayed[None, :], axis=2),
        np.linalg.norm(saved[:, None] - saved[None, :], axis=2),
        atol=0.003,
    )
    absolute = C_CRD.mask(array, default="generate")
    assert set(array.chain_id[absolute]) == {"A"}
    np.testing.assert_allclose(array.coord[absolute], C_CRD.annotation(array)[absolute], atol=0.001)
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
