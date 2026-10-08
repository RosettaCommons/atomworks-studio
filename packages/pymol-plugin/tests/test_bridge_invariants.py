"""Invariants the PyMOL ↔ AtomArrayPlus bridge must hold immediately after load.

If any of these fail, every selection-driven operation downstream (delete,
annotate, mask) is silently unsafe: the bridge uses enumeration index as the
array index, and indexes selections through a 4-tuple dict that assumes
key uniqueness.
"""

import numpy as np
from atomworks_studio_pymol.bridge import (
    refresh_chain_derived_annotations,
    refresh_coords_from_pymol,
    selection_to_indices,
)
from atomworks_studio_pymol.state import STATE
from pymol import cmd

from .helpers import assert_pymol_matches_array, visible_atom_mask


def test_pymol_and_array_form_a_bijection_after_load(loaded_cif: tuple[str, str]) -> None:
    """PyMOL's atoms and the visible array rows must represent the same set.

    PyMOL reorders atoms within a residue when parsing a CIF (backbone first),
    so identical row order is not guaranteed. The real invariant is that the
    4-tuple key (chain_iid, res_id, ins_code, atom_name) matches a unique
    array row in each direction, and coordinates agree. When ``hide_nans`` is
    on, PyMOL is a strict subset of the array; the helper restricts to the
    visible subset.
    """
    _, obj_name = loaded_cif
    array = STATE.arrays[obj_name]
    assert_pymol_matches_array(obj_name, array)


def test_select_all_covers_every_atom(loaded_cif: tuple[str, str]) -> None:
    """Selecting the whole object must hit every visible array index exactly once.

    The *order* is not required to match PyMOL's enumeration (PyMOL may
    reorder atoms on load), but the returned indices as a set must equal the
    set of visible array rows under the current ``hide_nans`` policy.
    """
    _, obj_name = loaded_cif
    array = STATE.arrays[obj_name]
    index_map = STATE.index_maps[obj_name]

    indices = selection_to_indices(obj_name, index_map)
    expected = set(np.nonzero(visible_atom_mask(array))[0].tolist())

    assert len(indices) == len(expected), (
        f"selecting the whole object returned {len(indices)} atoms, "
        f"expected {len(expected)} visible rows (array total: {len(array)})"
    )
    assert set(indices) == expected, "selecting all atoms must cover every visible array index exactly once"


def test_per_residue_selection_covers_all_atoms(loaded_cif: tuple[str, str]) -> None:
    """For every residue in the array, selecting it in PyMOL must return
    exactly that residue's visible atom indices. This catches localized
    duplicate-key collapses even when the global uniqueness test happens to
    pass.
    """
    _, obj_name = loaded_cif
    array = STATE.arrays[obj_name]
    index_map = STATE.index_maps[obj_name]
    vis = visible_atom_mask(array)

    # Probe residues drawn from visible atoms only; an all-NaN residue would
    # have zero atoms in PyMOL and nothing meaningful to round-trip.
    visible_indices = np.nonzero(vis)[0]
    assert len(visible_indices) > 0, "fixture has no visible atoms"
    probe = visible_indices[np.linspace(0, len(visible_indices) - 1, num=min(10, len(visible_indices)), dtype=int)]

    checked = 0
    for i in probe:
        chain = str(array.chain_iid[i])
        res_id = int(array.res_id[i])
        sel = f"{obj_name} and chain {chain} and resi {res_id}"
        pymol_count = cmd.count_atoms(sel)
        if pymol_count == 0:
            continue
        expected = np.nonzero((array.chain_iid == chain) & (array.res_id == res_id) & vis)[0].tolist()
        actual = sorted(selection_to_indices(sel, index_map))
        assert actual == sorted(expected), (
            f"residue {chain}/{res_id}: PyMOL selection → {len(actual)} indices, "
            f"array has {len(expected)} visible atoms; first diff:\n"
            f"  actual:   {actual[:5]}\n  expected: {expected[:5]}"
        )
        checked += 1
    assert checked > 0, "probe selected no residues — fixture may be empty"


def test_translate_is_invisible_to_the_array_until_refreshed(loaded_cif: tuple[str, str]) -> None:
    """A raw PyMOL ``translate`` must not silently update the cached array.

    Guards the known gap (see the plugin README): PyMOL coordinate mutations
    are not mirrored into ``STATE`` automatically. Before
    :py:func:`refresh_coords_from_pymol` runs, the array must still reflect
    the pre-translate pose; after it runs, the array's visible atoms must
    match PyMOL's translated coordinates (NaN sentinel atoms excepted).
    """
    _, obj_name = loaded_cif
    array = STATE.arrays[obj_name]
    resolved = np.isfinite(array.coord).all(axis=1)
    coord_before = array.coord.copy()

    shift = np.array([5.0, -3.0, 1.5])
    cmd.translate(list(shift), selection=obj_name, camera=0)

    # Cache is untouched by the raw PyMOL mutation.
    assert np.allclose(array.coord, coord_before, equal_nan=True), (
        "array coordinates changed without a call to refresh_coords_from_pymol"
    )

    refresh_coords_from_pymol(obj_name)

    # Visible atoms now reflect the translated pose; NaN sentinels are untouched.
    expected = coord_before.copy()
    expected[resolved] += shift
    assert np.allclose(array.coord[resolved], expected[resolved], atol=1e-3), (
        "resolved atoms did not pick up the PyMOL move"
    )
    if (~resolved).any():
        assert np.all(np.isnan(array.coord[~resolved])), "NaN sentinel atoms must not be 'resolved' by the refresh"

    assert_pymol_matches_array(obj_name, array)


def test_chain_rename_refreshes_label_entity_id(loaded_cif: tuple[str, str]) -> None:
    """A chain rename must refresh ``label_entity_id``, not just ``chain_entity``.

    ``label_entity_id`` -- not ``chain_entity`` -- is what's actually written as
    the entity ID on CIF export (see ``_ensure_label_entity_id``, which only
    computes it "if missing"). If a rename left it stale, the saved file's
    entity table would silently no longer match the renamed chain grouping.
    """
    _, obj_name = loaded_cif
    array = STATE.arrays[obj_name]
    if "label_entity_id" not in array.get_annotation_categories() or len(array) < 2:
        return

    # Split into two brand-new chain ids, forcing a genuine chain_entity regroup.
    half = len(array) // 2
    new_chain_id = array.chain_id.copy()
    new_chain_id[:half] = "ZZZ1"
    new_chain_id[half:] = "ZZZ2"
    array.set_annotation("chain_id", new_chain_id)

    refresh_chain_derived_annotations(array)

    expected = (array.chain_entity + 1).astype(array.label_entity_id.dtype)
    assert np.array_equal(array.label_entity_id, expected), (
        "label_entity_id was not refreshed to match the renamed chain_entity grouping"
    )
