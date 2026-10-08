"""End-to-end delete-selection test.

This is the test that mirrors the user-observed bug most directly: make a
PyMOL selection, run the plugin's delete, and assert the atoms that
*remained* kept every annotation they started with — including synthetic
annotations meant to stand in for sequence-conditioning masks.

The test does three things after the delete:

1. Checks the remaining array equals ``original[keep_mask]`` row-for-row,
   including all annotations and a synthetic per-atom index annotation.
2. Rebuilds invariants: PyMOL order matches the array, the index map is
   still unique and covers every atom.
3. Runs a fresh round-trip selection to prove the post-delete bridge still
   maps selections to correct indices.
"""

import copy

import numpy as np
from atomworks.io.utils.atom_array_plus import AtomArrayPlus
from atomworks_studio_pymol.bridge import (
    build_index_map,
    delete_atoms,
    deletion_would_create_res_id_gap,
    reload_structure_in_pymol,
    selection_to_indices,
)
from atomworks_studio_pymol.state import STATE
from pymol import cmd

from .helpers import (
    assert_index_map_unique,
    assert_pymol_matches_array,
    assert_rows_identical,
    ground_truth_indices,
)


def _stamp_synthetic_annotation(array: AtomArrayPlus) -> None:
    """Attach per-atom index and a 'mask' annotation.

    The 'mask' annotation simulates a sequence-conditioning mask applied to
    a specific, known subset of atoms. If delete corrupts row ordering, the
    mask values on the remaining atoms will no longer line up with their
    true originals.
    """
    n = len(array)
    array.set_annotation("synthetic_idx", np.arange(n, dtype=np.int32))
    # Stamp a mask on atoms whose res_id is even — an arbitrary pattern the
    # post-delete array must preserve exactly.
    mask = (array.res_id % 2 == 0).astype(np.int8)
    array.set_annotation("synthetic_mask", mask)


def test_delete_preserves_remaining_annotations(loaded_cif: tuple[str, str]) -> None:
    """After deleting a selection, every remaining atom keeps its metadata."""
    _, obj_name = loaded_cif
    # Establish the same CIF-rounded coordinate baseline that every plugin
    # mutation path gets through push_snapshot()/get_synced_array().
    array = STATE.get_synced_array(obj_name)

    _stamp_synthetic_annotation(array)
    original = copy.deepcopy(array)

    # Delete atoms from the most populous chain's middle residue range.
    # This is a non-trivial slice that removes interior atoms, which is the
    # scenario most likely to expose order drift. Use ``chain_iid`` — PyMOL's
    # chain column — so the selection string matches PyMOL's view.
    chains, counts = np.unique(array.chain_iid, return_counts=True)
    chain = str(chains[np.argmax(counts)])
    res_ids = sorted(np.unique(array.res_id[array.chain_iid == chain]))
    # Delete the middle third of residues in that chain.
    lo_idx = len(res_ids) // 3
    hi_idx = 2 * len(res_ids) // 3
    lo, hi = int(res_ids[lo_idx]), int(res_ids[hi_idx])
    sel = f"{obj_name} and chain {chain} and resi {lo}-{hi}"

    delete_indices = selection_to_indices(sel, STATE.index_maps[obj_name])
    assert delete_indices, "test setup: selection produced no indices to delete"

    expected_delete = set(ground_truth_indices(original, chain=chain, res_id_range=(lo, hi)))
    assert set(delete_indices) == expected_delete, (
        "bridge selected different atoms than the array-side ground truth — "
        "any delete test from here is meaningless. Fix the bridge first."
    )

    # Reproduce the plugin's delete path (see commands._aw_delete_selection).
    keep_mask = np.ones(len(array), dtype=bool)
    keep_mask[delete_indices] = False
    STATE.push_snapshot(obj_name)
    STATE.arrays[obj_name] = array[keep_mask]
    reload_structure_in_pymol(obj_name)

    new_array = STATE.arrays[obj_name]
    expected_remaining = original[keep_mask]

    # (1) Every remaining atom kept every annotation, including our synthetic mask.
    assert_rows_identical(new_array, expected_remaining)

    # (2) Post-delete invariants hold.
    assert_index_map_unique(new_array)
    assert_pymol_matches_array(obj_name, new_array)
    assert len(STATE.index_maps[obj_name]) == len(new_array), (
        "post-delete index map lost atoms — duplicate keys appeared after delete"
    )

    # (3) A fresh round-trip selection on the new array still maps correctly.
    actual = sorted(selection_to_indices(f"{obj_name} and chain {chain}", STATE.index_maps[obj_name]))
    expected = sorted(ground_truth_indices(new_array, chain=chain))
    assert actual == expected, f"post-delete selection drift: {len(actual)} vs {len(expected)} on chain {chain}"


def test_delete_is_idempotent_when_redone_from_scratch(loaded_cif: tuple[str, str]) -> None:
    """Deleting the same selection twice via two fresh index-map builds is
    consistent: the second delete on an already-pruned array either removes
    nothing (if the selection no longer matches) or removes a well-defined
    subset — never a phantom set of unrelated atoms.
    """
    _, obj_name = loaded_cif
    array = STATE.arrays[obj_name]

    # Delete the first residue of the first chain — small, well-defined,
    # guaranteed not to leave the array empty (which would hit an unrelated
    # ``to_cif_string`` edge case on zero-length arrays).
    chain = str(array.chain_iid[0])
    res_id = int(array.res_id[0])
    sel = f"{obj_name} and chain {chain} and resi {res_id}"

    idx1 = selection_to_indices(sel, STATE.index_maps[obj_name])
    if not idx1:
        return  # nothing to delete, skip silently

    keep = np.ones(len(array), dtype=bool)
    keep[idx1] = False
    STATE.arrays[obj_name] = array[keep]
    reload_structure_in_pymol(obj_name)

    # Freshly rebuild and re-run: the bridge must agree with what PyMOL's
    # ``get_model`` returns for the same selection. We compare against
    # ``get_model`` (not ``count_atoms``) because that's what the bridge
    # iterates — ``count_atoms`` can disagree by 1 on boundary cases after a
    # reload that drops NaN-coord atoms.
    fresh_map = build_index_map(obj_name)
    STATE.index_maps[obj_name] = fresh_map
    idx2 = selection_to_indices(sel, fresh_map)
    pymol_atoms = len(cmd.get_model(sel).atom)
    assert len(idx2) == pymol_atoms, (
        f"post-delete, PyMOL's get_model sees {pymol_atoms} atoms matching {sel!r} "
        f"but bridge mapped {len(idx2)} — divergence between PyMOL and the array"
    )


def test_delete_close_gap_preserves_coordinates(loaded_cif: tuple[str, str]) -> None:
    """Closing the res_id gap on delete must not scramble downstream coordinates."""
    _, obj_name = loaded_cif
    array = STATE.get_synced_array(obj_name)

    chains, counts = np.unique(array.chain_iid, return_counts=True)
    chain = str(chains[np.argmax(counts)])
    res_ids = sorted(np.unique(array.res_id[array.chain_iid == chain]))
    if len(res_ids) < 6:
        return  # not enough residues in this fixture for an internal deletion

    lo_idx = len(res_ids) // 3
    hi_idx = 2 * len(res_ids) // 3
    lo, hi = int(res_ids[lo_idx]), int(res_ids[hi_idx])
    sel = f"{obj_name} and chain {chain} and resi {lo}-{hi}"

    delete_indices = selection_to_indices(sel, STATE.index_maps[obj_name])
    if not delete_indices:
        return  # nothing to delete in this fixture/selection

    keep = np.ones(len(array), dtype=bool)
    keep[delete_indices] = False
    if not deletion_would_create_res_id_gap(array, keep):
        return  # selection didn't land internally; nothing to close

    expected_remaining = array[keep]

    STATE.push_snapshot(obj_name)
    STATE.set_array(obj_name, delete_atoms(array, keep, close_res_id_gaps=True))
    reload_structure_in_pymol(obj_name)

    new_array = STATE.arrays[obj_name]

    # The only thing allowed to differ is res_id (legitimately renumbered).
    # Every other annotation -- crucially coord -- must match row-for-row.
    assert_rows_identical(new_array, expected_remaining, skip_annotations=("res_id",))

    assert_index_map_unique(new_array)
    assert_pymol_matches_array(obj_name, new_array)
