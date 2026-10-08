"""Comparison utilities for PyMOL plugin tests.

The two critical operations:

- :py:func:`collect_pymol_atoms` — freeze PyMOL's view of an object as a list of
  plain tuples, in PyMOL's own enumeration order. This is what
  :py:func:`atomworks_studio_pymol.bridge.build_index_map` walks.
- :py:func:`assert_pymol_matches_array` — assert that PyMOL's atoms match the
  AtomArrayPlus row-by-row. If this fails, the bridge's core assumption
  (PyMOL index == array index) is broken.

All comparisons normalize whitespace and insertion codes so that PyMOL's
string-valued ``resi`` matches the array's ``(res_id, ins_code)`` split.
"""

from dataclasses import dataclass

import numpy as np
from atomworks.io.utils.atom_array_plus import AtomArrayPlus
from pymol import cmd


def visible_atom_mask(array: AtomArrayPlus) -> np.ndarray:
    """Boolean mask of array rows loaded into PyMOL.

    The bridge now loads every row and gives unresolved/NaN atoms temporary
    display coordinates so they remain selectable. ``hide_nans`` controls
    visibility only; hidden atoms are still returned by PyMOL selections.
    """
    return np.ones(len(array), dtype=bool)


@dataclass(frozen=True)
class PyMOLAtomRow:
    """One atom as PyMOL reports it."""

    chain: str
    res_id: int
    ins_code: str
    res_name: str
    atom_name: str
    element: str
    coord: tuple[float, float, float]


def _split_resi(resi: str) -> tuple[int, str]:
    resi = resi.strip()
    if resi and resi[-1].isalpha():
        return int(resi[:-1]), resi[-1]
    return int(resi), ""


def collect_pymol_atoms(obj_name: str) -> list[PyMOLAtomRow]:
    """Return PyMOL's atoms for *obj_name* in enumeration order."""
    rows: list[PyMOLAtomRow] = []
    for a in cmd.get_model(obj_name).atom:
        res_id, ins_code = _split_resi(a.resi)
        rows.append(
            PyMOLAtomRow(
                chain=a.chain,
                res_id=res_id,
                ins_code=ins_code,
                res_name=a.resn,
                atom_name=a.name,
                element=(a.symbol or "").strip(),
                coord=(float(a.coord[0]), float(a.coord[1]), float(a.coord[2])),
            )
        )
    return rows


def array_to_rows(array: AtomArrayPlus) -> list[PyMOLAtomRow]:
    """Materialize the array as PyMOLAtomRow objects for row-by-row comparison.

    Uses ``chain_iid`` (not ``chain_id``) because :py:func:`prepare_for_display`
    rewrites the CIF's chain column to ``chain_iid`` before handing it to
    PyMOL — that's what PyMOL's ``atom.chain`` returns.
    """
    # ``ins_code`` is not always present; tolerate either spelling.
    cats = set(array.get_annotation_categories())
    has_ins = "ins_code" in cats
    rows: list[PyMOLAtomRow] = []
    for i in range(len(array)):
        ins = array.ins_code[i] if has_ins else ""
        rows.append(
            PyMOLAtomRow(
                chain=str(array.chain_iid[i]),
                res_id=int(array.res_id[i]),
                ins_code=("" if ins is None else str(ins)).strip(),
                res_name=str(array.res_name[i]),
                atom_name=str(array.atom_name[i]),
                element=str(array.element[i]).strip(),
                coord=(
                    float(array.coord[i, 0]),
                    float(array.coord[i, 1]),
                    float(array.coord[i, 2]),
                ),
            )
        )
    return rows


def assert_pymol_matches_array(
    obj_name: str,
    array: AtomArrayPlus,
    *,
    coord_tol: float = 1e-3,
) -> None:
    """Assert PyMOL and the array represent the same atom set (bijection).

    PyMOL reorders atoms within each residue on CIF load (backbone first),
    so row-by-row equality does not hold. The real correctness requirement
    is that every PyMOL atom matches exactly one array row by 4-tuple AND
    by coordinate. If that bijection holds, the bridge can safely translate
    PyMOL selections into array indices via the 4-tuple key.

    NaN-coordinate rows are identity-checked but not coordinate-checked because
    PyMOL receives temporary display coordinates for them.
    """
    pymol_rows = collect_pymol_atoms(obj_name)
    all_array_rows = array_to_rows(array)
    vis = visible_atom_mask(array)
    array_rows = [r for r, keep in zip(all_array_rows, vis, strict=True) if keep]

    assert len(pymol_rows) == len(array_rows), (
        f"atom count mismatch: PyMOL has {len(pymol_rows)}, "
        f"visible array rows: {len(array_rows)} (total array: {len(all_array_rows)})"
    )

    # Build a 4-tuple → array row index lookup, verifying uniqueness inline.
    array_by_key: dict[tuple, int] = {}
    for i, a in enumerate(array_rows):
        key = (a.chain, a.res_id, a.ins_code, a.atom_name)
        if key in array_by_key:
            raise AssertionError(f"array has duplicate 4-tuple key {key!r} at indices {array_by_key[key]} and {i}")
        array_by_key[key] = i

    for i, p in enumerate(pymol_rows):
        key = (p.chain, p.res_id, p.ins_code, p.atom_name)
        j = array_by_key.get(key)
        if j is None:
            raise AssertionError(f"pymol atom[{i}] {key!r} has no matching row in the array")
        a = array_rows[j]
        if np.isnan(a.coord).any():
            continue
        dist = np.linalg.norm(np.array(p.coord) - np.array(a.coord))
        if dist > coord_tol:
            raise AssertionError(
                f"coord drift {dist:.4f} Å > {coord_tol} for {key!r}:\n"
                f"  pymol (row {i}): {p.coord}\n"
                f"  array (row {j}): {a.coord}"
            )


def assert_index_map_unique(array: AtomArrayPlus) -> None:
    """Assert the bridge's 4-tuple key is unique across the array.

    If duplicates exist, :py:func:`build_index_map` silently loses atoms: later
    entries overwrite earlier ones in the dict. Uses ``chain_iid`` to match
    the bridge's keying.
    """
    cats = set(array.get_annotation_categories())
    has_ins = "ins_code" in cats
    seen: dict[tuple, int] = {}
    dupes: list[tuple[tuple, int, int]] = []
    for i in range(len(array)):
        ins = (array.ins_code[i] if has_ins else "") or ""
        key = (
            str(array.chain_iid[i]),
            int(array.res_id[i]),
            str(ins).strip(),
            str(array.atom_name[i]),
        )
        if key in seen:
            dupes.append((key, seen[key], i))
        else:
            seen[key] = i
    if dupes:
        sample = dupes[:5]
        raise AssertionError(
            f"{len(dupes)} duplicate (chain_iid, res_id, ins_code, atom_name) keys in array. "
            f"The bridge index map silently drops duplicates. Sample: {sample}"
        )


def ground_truth_indices(
    array: AtomArrayPlus,
    *,
    chain: str | None = None,
    res_id_range: tuple[int, int] | None = None,
    atom_names: list[str] | None = None,
    hetero: bool | None = None,
    visible_only: bool = True,
) -> list[int]:
    """Compute expected array indices for a selection, directly from the array.

    Filters by ``chain_iid`` (the annotation PyMOL sees as its chain column).
    If ``visible_only`` is True, also restricts to atoms that survived the
    current ``STATE.hide_nans`` policy — required for parity with PyMOL-side
    selections which can't return atoms that aren't loaded.
    """
    mask = np.ones(len(array), dtype=bool)
    if chain is not None:
        mask &= array.chain_iid == chain
    if res_id_range is not None:
        lo, hi = res_id_range
        mask &= (array.res_id >= lo) & (array.res_id <= hi)
    if atom_names is not None:
        mask &= np.isin(array.atom_name, atom_names)
    if hetero is not None and "hetero" in array.get_annotation_categories():
        mask &= array.hetero == hetero
    if visible_only:
        mask &= visible_atom_mask(array)
    return np.nonzero(mask)[0].tolist()


def assert_rows_identical(
    array_a: AtomArrayPlus,
    array_b: AtomArrayPlus,
    *,
    coord_tol: float = 1e-5,
    skip_annotations: tuple[str, ...] = (),
) -> None:
    """Assert two arrays are identical row-for-row, including all annotations.

    Used to verify that destructive operations (delete) preserve every
    remaining atom's metadata exactly.
    """
    assert len(array_a) == len(array_b), f"length mismatch: {len(array_a)} vs {len(array_b)}"
    # equal_nan=True: expandable-segment sentinels legitimately carry NaN
    # coords; they must survive a delete unchanged, not be treated as unequal.
    assert np.allclose(array_a.coord, array_b.coord, atol=coord_tol, equal_nan=True), "coordinate mismatch"
    cats_a = set(array_a.get_annotation_categories())
    cats_b = set(array_b.get_annotation_categories())
    assert cats_a == cats_b, f"annotation category set differs: only-a={cats_a - cats_b}, only-b={cats_b - cats_a}"
    for cat in sorted(cats_a):
        if cat in skip_annotations:
            continue
        va = array_a.get_annotation(cat)
        vb = array_b.get_annotation(cat)
        # ``equal_nan`` is only legal for floats; object/string dtypes throw.
        is_float = np.issubdtype(va.dtype, np.floating)
        if is_float:
            if np.array_equal(va, vb, equal_nan=True):
                continue
            mismatch = ~((va == vb) | (np.isnan(va) & np.isnan(vb)))
        else:
            if np.array_equal(va, vb):
                continue
            mismatch = va != vb
        diff = np.where(mismatch)[0]
        if len(diff) == 0:
            continue
        first = int(diff[0])
        raise AssertionError(
            f"annotation {cat!r} differs ({len(diff)} rows); "
            f"first mismatch at index {first}: {va[first]!r} vs {vb[first]!r}"
        )
