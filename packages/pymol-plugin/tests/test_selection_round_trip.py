"""Round-trip PyMOL selections through the bridge.

For each fixture we run a battery of selection expressions and assert that
the indices returned by :py:func:`selection_to_indices` match an independent
numpy-mask ground truth computed directly from the array. This is the test
that actually catches the class of bugs the user observed — annotations
landing on "mostly right but some wrong" atoms.
"""

import numpy as np
import pytest
from atomworks.io.utils.atom_array_plus import AtomArrayPlus
from atomworks_studio_pymol.bridge import selection_to_indices
from atomworks_studio_pymol.state import STATE
from pymol import cmd

from .helpers import ground_truth_indices, visible_atom_mask


def _pick_chain(array: AtomArrayPlus) -> str:
    """Pick the most populous chain (by ``chain_iid``) — guarantees a
    non-trivial selection. ``chain_iid`` is used because that's what PyMOL
    sees as its chain column after :py:func:`prepare_for_display`.
    """
    chains, counts = np.unique(array.chain_iid, return_counts=True)
    return str(chains[np.argmax(counts)])


def test_select_by_chain(loaded_cif: tuple[str, str]) -> None:
    _, obj_name = loaded_cif
    array = STATE.arrays[obj_name]
    chain = _pick_chain(array)

    actual = sorted(selection_to_indices(f"{obj_name} and chain {chain}", STATE.index_maps[obj_name]))
    expected = sorted(ground_truth_indices(array, chain=chain))

    assert len(actual) == len(expected), (
        f"chain {chain}: {len(actual)} vs {len(expected)} indices — "
        f"length mismatch usually means duplicate-key collisions in the index map"
    )
    assert actual == expected


def test_select_by_residue_range(loaded_cif: tuple[str, str]) -> None:
    _, obj_name = loaded_cif
    array = STATE.arrays[obj_name]
    chain = _pick_chain(array)

    chain_mask = array.chain_iid == chain
    res_ids = array.res_id[chain_mask]
    lo = int(np.percentile(res_ids, 25))
    hi = int(np.percentile(res_ids, 75))

    sel = f"{obj_name} and chain {chain} and resi {lo}-{hi}"
    actual = sorted(selection_to_indices(sel, STATE.index_maps[obj_name]))
    expected = sorted(ground_truth_indices(array, chain=chain, res_id_range=(lo, hi)))

    assert actual == expected, f"chain {chain} resi {lo}-{hi}: {len(actual)} actual vs {len(expected)} expected"


def test_select_backbone(loaded_cif: tuple[str, str]) -> None:
    _, obj_name = loaded_cif
    array = STATE.arrays[obj_name]
    backbone = ["N", "CA", "C", "O"]

    sel = f"{obj_name} and name N+CA+C+O"
    actual = sorted(selection_to_indices(sel, STATE.index_maps[obj_name]))
    expected = sorted(ground_truth_indices(array, atom_names=backbone))

    # If PyMOL has zero backbone atoms (e.g. RNA-only fixture), skip meaningfully.
    if not expected:
        pytest.skip("fixture has no standard protein backbone atoms")

    assert actual == expected


def test_select_random_subset(loaded_cif: tuple[str, str]) -> None:
    """Randomly pick atoms by identity, build a PyMOL selection that names
    them exactly, and assert the bridge recovers the same array indices.

    We build the selection from each atom's ``(chain, resi, atom_name)``
    rather than PyMOL's 1-based ``index`` because PyMOL's enumeration order
    differs from the array's order after a CIF load (backbone is promoted
    within each residue). Identity-based selection is the invariant path.
    """
    _, obj_name = loaded_cif
    array = STATE.arrays[obj_name]

    # Sample only from atoms that actually exist in PyMOL — an invisible
    # (NaN-coord, dropped) atom can't be named in a PyMOL selection, so it
    # couldn't round-trip by construction.
    visible_indices = np.nonzero(visible_atom_mask(array))[0]
    assert len(visible_indices) > 0, "fixture has no visible atoms"
    rng = np.random.default_rng(seed=42)
    sample = sorted(rng.choice(visible_indices, size=max(1, len(visible_indices) // 10), replace=False).tolist())

    # Build one big ``(chain X and resi Y and name Z)`` term per sampled atom,
    # using ``chain_iid`` because that's PyMOL's chain column. Skip atoms
    # whose residue has repeated atom names (would be ambiguous); the
    # uniqueness invariant guarantees the 4-tuple is globally unique, so
    # per-residue+name is unambiguous too.
    terms = []
    for i in sample:
        terms.append(f"(chain {array.chain_iid[i]} and resi {array.res_id[i]} and name {array.atom_name[i]})")
    sel_name = "aw_test_random"
    cmd.select(sel_name, f"{obj_name} and ({' or '.join(terms)})")
    try:
        actual = sorted(selection_to_indices(sel_name, STATE.index_maps[obj_name]))
    finally:
        cmd.delete(sel_name)

    assert actual == sample, (
        f"identity-based selection round-tripped to a different set of array "
        f"indices. Symmetric diff (first 5): "
        f"{sorted(set(actual) ^ set(sample))[:5]}"
    )
