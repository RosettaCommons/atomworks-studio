"""The example rebuild states the aromatic ligand bond orders it would otherwise copy as AROM."""

import json
from pathlib import Path
from runpy import run_path

import numpy as np
import pytest
from atomworks_studio_editing.document import StudioDocument
from biotite.structure.bonds import BondType

ROOT = Path(__file__).resolve().parents[1]
EXAMPLES = ROOT / "packages/api/annotation_studio/examples"
builder = run_path(str(ROOT / "scripts/build_hit_examples.py"))
state_aromatic_bond_orders = builder["state_aromatic_bond_orders"]

# enzyme_design and inverse_folding both carry the nitrophenyl phosphate ligand L:0,
# whose benzene ring the design source stores with unstated (AROMATIC) bond orders.
LIGAND_EXAMPLES = ["enzyme_design.cif", "inverse_folding.cif"]
RING = [("C2", "C3"), ("C2", "C4"), ("C3", "C5"), ("C4", "C6"), ("C5", "C7"), ("C6", "C7")]


def _load(name):
    return StudioDocument.from_cif((EXAMPLES / name).read_text(), name, parse_options={"preset": "minimal"})


@pytest.mark.parametrize("name", LIGAND_EXAMPLES)
def test_shipped_ligand_has_no_unstated_aromatic_bonds(name):
    bonds = _load(name).array.bonds.as_array()
    assert not any(order == BondType.AROMATIC for *_ignored, order in bonds), (
        f"{name}: ships BondType.AROMATIC bonds, which protonation rejects"
    )


@pytest.mark.parametrize("name", LIGAND_EXAMPLES)
def test_rebuild_restates_source_aromatic_ring_as_shipped(name):
    """Reverting the ring to the source's AROM bonds and re-running the builder helper
    reproduces the shipped bond orders, so a documented rebuild no longer regenerates
    unstated bonds."""
    doc = _load(name)
    array = doc.array
    shipped = array.bonds.as_array().copy()
    ligand = array.res_name == "L:0"
    atom = lambda nm: int(np.flatnonzero(ligand & (array.atom_name == nm))[0])  # noqa: E731
    for first, second in RING:
        array.bonds.add_bond(atom(first), atom(second), BondType.AROMATIC)
    assert state_aromatic_bond_orders(array) == len(RING)
    np.testing.assert_array_equal(array.bonds.as_array(), shipped)
    ring_atoms = [atom(name) for name in sorted({name for edge in RING for name in edge})]
    assert np.all(array.element[ring_atoms] == "C")
    for index in ring_atoms:
        partners, orders = array.bonds.get_bonds(index)
        ring_orders = orders[np.isin(partners, ring_atoms)]
        assert sorted(ring_orders) == [BondType.AROMATIC_SINGLE, BondType.AROMATIC_DOUBLE]
    # And the restated ligand can be protonated, which the AROM source could not.
    assert doc.protonate(7.4)["hydrogen_count"] > 0


def test_rebuild_writes_ligand_provenance(tmp_path, monkeypatch):
    """Generated provenance records bond repairs only for the affected examples."""

    def prepared(name):
        doc = _load(name)
        if name in LIGAND_EXAMPLES:
            bonds = doc.array.bonds.as_array()
            for i, j, order in bonds:
                if order in (BondType.AROMATIC_SINGLE, BondType.AROMATIC_DOUBLE):
                    if doc.array.res_name[i] == doc.array.res_name[j] == "L:0":
                        doc.array.bonds.add_bond(i, j, BondType.AROMATIC)
        return doc

    # Use packaged documents at the preparation boundary; exercise the real repair,
    # serialization and provenance-writing steps without requiring private source files.
    build = builder["build"]
    monkeypatch.setitem(build.__globals__, "pte_inverse_folding", lambda _source: prepared("inverse_folding.cif"))
    monkeypatch.setitem(build.__globals__, "pte_scaffold", lambda _source: prepared("enzyme_design.cif"))
    monkeypatch.setitem(build.__globals__, "binder", lambda source, *_args: prepared(source.name))
    build(EXAMPLES / "inverse_folding.cif", EXAMPLES / "ptm_binder.cif", EXAMPLES / "protein_binder.cif", tmp_path)

    generated = json.loads((tmp_path / "hit-example-provenance.json").read_text())
    expected = json.loads((EXAMPLES / "hit-example-provenance.json").read_text())
    assert set(generated) == set(expected)
    for name, record in generated.items():
        if name in LIGAND_EXAMPLES:
            assert record["ligand_bond_orders"] == expected[name]["ligand_bond_orders"]
        else:
            assert "ligand_bond_orders" not in record
