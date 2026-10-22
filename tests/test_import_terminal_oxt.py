"""Import inference exempts only an OXT on a free C-terminal carboxyl, and words its notice correctly."""

from collections import Counter
from pathlib import Path

import biotite.structure as struc
from atomworks_studio_editing.loading import inspect_import, terminal_oxt_count

EXAMPLES = Path(__file__).resolve().parents[1] / "packages/api/annotation_studio/examples"


def _residues(spec: list[tuple[str, int]]) -> struc.AtomArray:
    """One N and one C atom per (chain, res_id) residue, in order."""
    array = struc.AtomArray(2 * len(spec))
    for k, (chain, res_id) in enumerate(spec):
        for j, name in enumerate(("N", "C")):
            i = 2 * k + j
            array.chain_id[i], array.res_id[i], array.atom_name[i] = chain, res_id, name
    array.ins_code[:] = ""
    array.res_name[:] = "GLY"
    array.bonds = struc.BondList(len(array))
    return array


def test_only_an_oxt_on_a_free_carboxyl_is_exempt() -> None:
    # Chain A: residues 1-2-3 linked by peptide bonds C(i)-N(i+1). Chain B: an unlinked island,
    # like the separately placed motif residues of the enzyme example.
    completed = _residues([("A", 1), ("A", 2), ("A", 3), ("B", 5)])
    completed.bonds.add_bond(1, 2)  # C(A1)-N(A2)
    completed.bonds.add_bond(3, 4)  # C(A2)-N(A3)
    missing = Counter(
        {
            ("A", 3, "", "GLY", "OXT"): 1,  # C-terminus of A: free carboxyl, exempt
            ("B", 5, "", "GLY", "OXT"): 1,  # unlinked island: free carboxyl, exempt
            ("A", 2, "", "GLY", "OXT"): 1,  # C(A2) is linked to A3: still a missing heavy atom
            ("A", 3, "", "GLY", "CB"): 1,  # other atoms are never exempt
        }
    )
    assert terminal_oxt_count(missing, completed) == 2


def test_terminal_oxt_notice_is_singular_for_one_atom_and_plural_otherwise() -> None:
    one = inspect_import(EXAMPLES / "protein_binder.cif")  # missing B157 OXT only
    two = inspect_import(EXAMPLES / "partial_diffusion.cif")  # missing A111 and B157 OXT
    assert one["preset"] == two["preset"] == "minimal"
    assert "1 terminal OXT atom is missing" in one["message"]
    assert "2 terminal OXT atoms are missing" in two["message"]
