"""Chains edited as plans: the design card's document operations.

A chain loaded from a structure reads as an ordered list of *parts*: runs of the chain as it was loaded
(`kept`), blocks of new residues (`new`, an expandable segment) and residues the source does not have (`own`).
An edit changes the list and :meth:`ChainPlanMixin.rebuild_chain` makes the atoms from it in one undo step: order,
numbering, source names and bonds are set by one rule. This is the Python counterpart of the in-browser engine the
RFD4-Proteina page serves (`chainPlan`, `rebuildChain`, `replaceWithSegments`, `restoreSegment`, `scaffoldMotif`, ...);
both must give the same atoms for the same operations (`tests/test_design_card_parity.py`).

Two pieces of state outlive undo, as in the page: each chain's *source* (the chain as it was loaded) and the
*segment origins* (the residues a block of new residues replaced). Every polymer residue also carries its place in
its source as a hidden per-atom annotation (``_studio_src``, ``"num:ins"``), so it follows atoms through every edit,
undo and clone; it is never written to a CIF.
"""

from __future__ import annotations

import copy
import re
from dataclasses import dataclass, field
from typing import Any

import biotite.structure as struc
import numpy as np
from atomworks.constants import MASKED
from atomworks.enums import ChainType
from atomworks.io.utils.atom_array_plus import AtomArrayPlus, concatenate_atom_array_plus
from atomworks.io.utils.standard_annotations import S_SEGMAX, S_SEGMIN
from atomworks.io.utils.standard_annotations.base import STANDARD_ANNOTATIONS
from atomworks.io.utils.testing import has_ambiguous_annotation_set
from atomworks.ml.utils.expandable_segment import insert_expandable_segment

from atomworks_studio_editing.structure_mutations import refresh_chain_derived_annotations

HIDDEN_SRC = "_studio_src"
_HIDDEN_PREFIX = "_studio_"
SRC_COMPONENT = "annotation_src-component_1_atom"
_SEGMENT_NAME = re.compile(r"\d+-\d+")
_SOURCE_LABEL = re.compile(r"[A-Za-z]+-?\d+[A-Za-z]?")
_BACKBONE_LINKS = {"C", "N", "O3'", "P"}
_NEUTRAL = "#"


# ---------------------------------------------------------------------------------------------------------------------
# Array helpers
# ---------------------------------------------------------------------------------------------------------------------
def is_segment_mask(array: AtomArrayPlus) -> np.ndarray:
    """Atoms of unrealized new-residue segments (``"min-max"`` placeholders)."""
    names = np.asarray(array.res_name).astype(str)
    if not len(names):
        return np.zeros(0, dtype=bool)
    unique, inverse = np.unique(names, return_inverse=True)
    flags = np.array([_SEGMENT_NAME.fullmatch(name) is not None for name in unique])
    return flags[inverse]


def is_polymer_mask(array: AtomArrayPlus) -> np.ndarray:
    """Polymer residue atoms (modified residues included), not a ligand and not a new-residue placeholder."""
    if "is_polymer" in array.get_annotation_categories():
        polymer = np.asarray(array.is_polymer, dtype=bool)
    else:
        polymer = ~np.asarray(array.hetero, dtype=bool)
    return polymer & ~is_segment_mask(array)


def chain_key_array(array: AtomArrayPlus) -> np.ndarray:
    """The unique chain key of every atom: ``chain_iid`` (chain and transformation) when present."""
    name = "chain_iid" if "chain_iid" in array.get_annotation_categories() else "chain_id"
    return np.asarray(array.get_annotation(name)).astype(str)


def display_chain_array(array: AtomArrayPlus) -> np.ndarray:
    """The chain name a written CIF carries: ``chain_id``, or ``chain_iid`` when assembly copies make it ambiguous."""
    if "chain_iid" in array.get_annotation_categories() and has_ambiguous_annotation_set(array):
        return np.asarray(array.chain_iid).astype(str)
    return np.asarray(array.chain_id).astype(str)


def _ins_array(array: AtomArrayPlus) -> np.ndarray:
    if "ins_code" in array.get_annotation_categories():
        return np.asarray(array.ins_code).astype(str)
    return np.full(len(array), "")


def residue_bounds(array: AtomArrayPlus) -> np.ndarray:
    """Residue start indices with the exclusive end appended (a residue changes with chain, number, name, ins code)."""
    n = len(array)
    if n == 0:
        return np.array([0])
    changed = np.zeros(n - 1, dtype=bool)
    for values in (chain_key_array(array), np.asarray(array.res_id), np.asarray(array.res_name).astype(str), _ins_array(array)):
        changed |= values[1:] != values[:-1]
    return np.concatenate([[0], np.flatnonzero(changed) + 1, [n]])


def _residue_key(array: AtomArrayPlus, index: int, keys: np.ndarray | None = None, ins: np.ndarray | None = None) -> str:
    keys = chain_key_array(array) if keys is None else keys
    ins = _ins_array(array) if ins is None else ins
    return f"{keys[index]}:{int(array.res_id[index])}:{ins[index]}"


def _standard_annotation(name: str):
    try:
        return STANDARD_ANNOTATIONS.get(name)
    except Exception:  # noqa: BLE001 - not registered in this installation
        return None


def _src_labels(array: AtomArrayPlus) -> np.ndarray:
    """Source names ("A38") per atom; empty where none."""
    cls = _standard_annotation(SRC_COMPONENT)
    if cls is not None and cls.has_annotation(array):
        values = np.asarray(cls.annotation(array, default="generate")).astype(str)
    elif SRC_COMPONENT in array.get_annotation_categories():
        values = np.asarray(array.get_annotation(SRC_COMPONENT)).astype(str)
    else:
        return np.full(len(array), "", dtype="<U10")
    return np.where(np.isin(values, [".", "?"]), "", values)


def _set_src_labels(array: AtomArrayPlus, labels: np.ndarray) -> None:
    values = np.where(np.asarray(labels).astype(str) == "", ".", np.asarray(labels).astype(str))
    width = max(10, max((len(v) for v in values), default=1))
    values = values.astype(f"<U{width}")
    cls = _standard_annotation(SRC_COMPONENT)
    if cls is not None:
        cls.set_annotation(array, values)
    else:
        array.set_annotation(SRC_COMPONENT, values)


def hidden_tags(array: AtomArrayPlus, name: str = HIDDEN_SRC) -> np.ndarray:
    if name in array.get_annotation_categories():
        return np.asarray(array.get_annotation(name)).astype(str)
    return np.full(len(array), "", dtype="<U1")


def set_hidden(array: AtomArrayPlus, name: str, values) -> None:
    values = np.asarray(values).astype(str)
    width = max(1, max((len(v) for v in values), default=1))
    array.set_annotation(name, values.astype(f"<U{width}"))


def ensure_hidden(array: AtomArrayPlus) -> None:
    """Every document array carries its residues' source tags (empty where unknown)."""
    if HIDDEN_SRC not in array.get_annotation_categories():
        set_hidden(array, HIDDEN_SRC, np.full(len(array), ""))


def tag_polymer_atoms(array: AtomArrayPlus) -> None:
    """Each polymer residue tagged with its place in the chain as loaded (``"num:ins"``)."""
    tags = np.full(len(array), "", dtype=object)
    polymer = np.flatnonzero(is_polymer_mask(array))
    ins = _ins_array(array)
    for i in polymer:
        tags[i] = f"{int(array.res_id[i])}:{ins[i]}"
    set_hidden(array, HIDDEN_SRC, tags)


def _custom_default(values: np.ndarray):
    kind = values.dtype.kind
    if kind in "iu":
        return -1 if kind == "i" else 0
    if kind == "f":
        return np.nan
    if kind == "b":
        return False
    return ""


def align_custom_annotations(arrays: list[AtomArrayPlus]) -> list[AtomArrayPlus]:
    """Give every array the same non-standard 1-body annotations (a placeholder's uid, hidden bookkeeping).

    `concatenate_atom_array_plus` refuses categories missing from some inputs; the standard annotations are filled
    by its own option, these are the document's private ones.
    """
    standard = set(STANDARD_ANNOTATIONS.get_field_names(include_aliases=True))
    base = {"chain_id", "res_id", "ins_code", "res_name", "hetero", "atom_name", "element", "occupancy", "charge",
            "chain_type", "is_polymer", "label_alt_id", "b_factor", "atomic_number", "chem_comp_type", "stereo",
            "is_aromatic", "is_backbone_atom", "pn_unit_id", "molecule_id", "chain_entity", "pn_unit_entity",
            "molecule_entity", "transformation_id", "chain_iid", "pn_unit_iid", "molecule_iid", "label_entity_id",
            "atom_id", "token_id", "is_leaving_atom", "altloc_id", "auth_seq_id"}
    extra: dict[str, np.ndarray] = {}
    for array in arrays:
        for name in array.get_annotation_categories():
            if name in standard or name in base or name in extra:
                continue
            extra[name] = np.asarray(array.get_annotation(name))
    out = []
    for array in arrays:
        array = array.copy()
        present = set(array.get_annotation_categories())
        for name, example in extra.items():
            if name not in present:
                array.set_annotation(name, np.full(len(array), _custom_default(example), dtype=example.dtype))
        out.append(array)
    return out


def concatenate_documents(arrays: list[AtomArrayPlus], *, policy: str = "raise") -> AtomArrayPlus:
    arrays = align_custom_annotations(arrays)
    return concatenate_atom_array_plus(arrays, fill_missing_standard_annotations=True, on_annotation_mismatch_policy=policy)


def _bond_pairs(array: AtomArrayPlus) -> np.ndarray:
    if array.bonds is None:
        return np.zeros((0, 3), dtype=int)
    return array.bonds.as_array()


def _set_bonds(array: AtomArrayPlus, rows) -> None:
    rows = np.asarray(rows, dtype=int).reshape(-1, 3)
    array.bonds = struc.BondList(len(array), rows) if len(rows) else struc.BondList(len(array))


def _add_bond(array: AtomArrayPlus, u: int, v: int) -> None:
    if array.bonds is None:
        array.bonds = struc.BondList(len(array))
    array.bonds.add_bond(int(u), int(v), struc.BondType.SINGLE)


def _chain_type_of(name: str | None) -> ChainType:
    return ChainType.as_enum(
        {
            "polydeoxyribonucleotide": "polydeoxyribonucleotide",
            "polyribonucleotide": "polyribonucleotide",
            "polypeptide(D)": "polypeptide(D)",
        }.get(name or "", "polypeptide(L)")
    )


def _bond_atom_names(chain_type: int) -> tuple[str, str]:
    nucleic = int(chain_type) in (int(ChainType.DNA), int(ChainType.RNA))
    return ("O3'", "P") if nucleic else ("C", "N")


def install_sentinel_bonds(array: AtomArrayPlus, sentinel: int) -> None:
    """Wire a new-residue placeholder into the polymer bond graph (its neighbours' polymer atoms, in its chain)."""
    bounds = residue_bounds(array)
    keys = chain_key_array(array)
    chain_types = array.chain_type if "chain_type" in array.get_annotation_categories() else np.zeros(len(array), int)
    term_name, start_name = _bond_atom_names(int(chain_types[sentinel]))
    seg_min = np.asarray(S_SEGMIN.annotation(array)) if S_SEGMIN.has_annotation(array) else np.full(len(array), -1)
    r = int(np.searchsorted(bounds[:-1], sentinel, side="right")) - 1

    def pick(k: int, name: str) -> int | None:
        if k < 0 or k >= len(bounds) - 1:
            return None
        s, e = int(bounds[k]), int(bounds[k + 1])
        if keys[s] != keys[sentinel]:
            return None
        for i in range(s, e):
            if array.atom_name[i] == name or (e - s == 1 and seg_min[i] != -1 and seg_min[i] > 0):
                return i
        return None

    prev, nxt = pick(r - 1, term_name), pick(r + 1, start_name)
    rows = [tuple(row) for row in _bond_pairs(array).tolist()]
    pair = lambda u, v: (min(u, v), max(u, v))  # noqa: E731
    if prev is not None and nxt is not None:
        direct = pair(prev, nxt)
        rows = [row for row in rows if pair(row[0], row[1]) != direct]
    have = {pair(row[0], row[1]) for row in rows}
    if prev is not None and pair(prev, sentinel) not in have:
        rows.append((prev, sentinel, int(struc.BondType.SINGLE)))
    if nxt is not None and pair(sentinel, nxt) not in have:
        rows.append((sentinel, nxt, int(struc.BondType.SINGLE)))
    _set_bonds(array, rows)


def reinstall_sentinel_bonds(array: AtomArrayPlus, chains: set[str]) -> None:
    """Drop and rebuild every placeholder's links in `chains`, after residues next to them moved or went."""
    segment = is_segment_mask(array)
    keys = chain_key_array(array)
    sentinels = [i for i in np.flatnonzero(segment) if keys[i] in chains]
    if not sentinels:
        return
    own = set(sentinels)
    rows = [row for row in _bond_pairs(array).tolist() if row[0] not in own and row[1] not in own]
    _set_bonds(array, rows)
    for i in sentinels:
        install_sentinel_bonds(array, int(i))


# ---------------------------------------------------------------------------------------------------------------------
# State kept beside the array
# ---------------------------------------------------------------------------------------------------------------------
@dataclass
class ChainSource:
    """A chain as it was loaded: the whole loaded array (shared by every chain of it) and which chain is meant."""

    array: AtomArrayPlus
    chain: str  # the chain's key (chain_iid) in `array`
    label: str  # its name in a written CIF when loaded


@dataclass
class SegmentOrigin:
    """The residues one block of new residues replaced, and what was next to them."""

    chain: str  # chain key
    prev: str | None  # key of the polymer residue before (None: none)
    next: str | None
    array: AtomArrayPlus


@dataclass
class _SourceIndex:
    residues: list[dict[str, Any]] = field(default_factory=list)
    index: dict[str, int] = field(default_factory=dict)
    chain: str = ""
    array: AtomArrayPlus | None = None
    source_chain: str = ""


# ---------------------------------------------------------------------------------------------------------------------
# The mixin
# ---------------------------------------------------------------------------------------------------------------------
class ChainPlanMixin:
    """Design-card operations of `StudioDocument` (needs ``array``, ``edit``, ``set_condition``, ``resolve_indices``)."""

    # -- state ---------------------------------------------------------------------------------------------------
    def _init_design_state(self) -> None:
        """Record every chain as loaded and tag each polymer residue with its place in it."""
        self._sources: dict[str, ChainSource] = {}
        self._origins: list[SegmentOrigin] = []
        array = self.array
        if len(array):
            tag_polymer_atoms(array)
            loaded = copy.deepcopy(array)
            labels = display_chain_array(array)
            keys = chain_key_array(array)
            for key in dict.fromkeys(keys.tolist()):
                label = labels[np.flatnonzero(keys == key)[0]]
                self._sources[key] = ChainSource(loaded, key, str(label))

    def _share_design_state(self, other: ChainPlanMixin) -> None:
        self._sources = dict(other._sources)
        self._origins = list(other._origins)

    # -- chain names ---------------------------------------------------------------------------------------------
    def chain_key(self, chain: str) -> str:
        """The chain key (``chain_iid``) of a chain named as in a CIF, or by its key."""
        array = self.array
        labels = display_chain_array(array)
        keys = chain_key_array(array)
        chain = str(chain)
        hit = np.flatnonzero(labels == chain)
        if len(hit) == 0:
            hit = np.flatnonzero(keys == chain)
        if len(hit) == 0:
            raise KeyError(f"no chain {chain}")
        return str(keys[hit[0]])

    def _chain_label(self, key: str) -> str:
        keys = chain_key_array(self.array)
        hit = np.flatnonzero(keys == key)
        return str(display_chain_array(self.array)[hit[0]]) if len(hit) else key

    def _apply_chain(self, array: AtomArrayPlus, indices, key: str) -> None:
        """Atoms `indices` of `array` made part of chain `key` (chain id and transformation)."""
        chain_id, _, transformation = key.rpartition("_")
        if not chain_id:
            chain_id, transformation = key, "1"
        indices = np.asarray(indices, dtype=int)
        chain_ids = np.asarray(array.chain_id).astype(f"<U{max(len(chain_id), array.chain_id.dtype.itemsize // 4)}")
        chain_ids[indices] = chain_id
        array.set_annotation("chain_id", chain_ids)
        if "transformation_id" in array.get_annotation_categories():
            tids = np.asarray(array.transformation_id).astype(f"<U{max(len(transformation), array.transformation_id.dtype.itemsize // 4)}")
            tids[indices] = transformation
            array.set_annotation("transformation_id", tids)

    # -- source of a chain ---------------------------------------------------------------------------------------
    def _source_index(self, key: str) -> _SourceIndex:
        src = self._sources.get(key)
        if src is None:
            return _SourceIndex(chain=self._chain_label(key), source_chain=key)
        b = src.array
        keys = chain_key_array(b)
        ins = _ins_array(b)
        labels = _src_labels(b)
        polymer = is_polymer_mask(b)
        residues: list[dict[str, Any]] = []
        for i in np.flatnonzero((keys == src.chain) & polymer):
            num = int(b.res_id[i])
            if residues and residues[-1]["num"] == num and residues[-1]["ins"] == ins[i]:
                continue
            label = str(labels[i])
            residues.append(
                {"num": num, "ins": str(ins[i]), "name": str(b.res_name[i]),
                 "label": label if _SOURCE_LABEL.fullmatch(label) else ""}
            )
        index = {f"{r['num']}:{r['ins']}": k for k, r in enumerate(residues)}
        return _SourceIndex(residues, index, src.label, b, src.chain)

    def _source_index_of(self, atom: int, info: _SourceIndex, tags: np.ndarray | None = None) -> int | None:
        tag = str((hidden_tags(self.array) if tags is None else tags)[atom])
        return info.index.get(tag) if tag else None

    # -- plans ---------------------------------------------------------------------------------------------------
    def chain_plan(self, chain: str) -> dict[str, Any]:
        """Chain as a plan: ``{chain, source: [{num, ins, name, label}], parts: [...]}`` (JSON-safe)."""
        key = self.chain_key(chain)
        info = self._source_index(key)
        a = self.array
        keys = chain_key_array(a)
        ins = _ins_array(a)
        segment = is_segment_mask(a)
        polymer = is_polymer_mask(a)
        seg_min = np.asarray(S_SEGMIN.annotation(a)) if S_SEGMIN.has_annotation(a) else None
        seg_max = np.asarray(S_SEGMAX.annotation(a)) if S_SEGMAX.has_annotation(a) else None
        parts: list[dict[str, Any]] = []
        last_key = None
        tags = hidden_tags(a)
        for i in np.flatnonzero(keys == key):
            i = int(i)
            if segment[i]:
                lo, hi = (int(x) for x in str(a.res_name[i]).split("-"))
                parts.append(
                    {"kind": "new", "atom": i,
                     "min": int(seg_min[i]) if seg_min is not None and seg_min[i] > 0 else lo,
                     "max": int(seg_max[i]) if seg_max is not None and seg_max[i] > 0 else hi}
                )
                last_key = None
                continue
            if not polymer[i]:
                continue
            residue = f"{int(a.res_id[i])}:{ins[i]}"
            if residue == last_key:
                parts[-1]["atoms"].append(i)
                continue
            last_key = residue
            k = self._source_index_of(i, info, tags)
            last = parts[-1] if parts else None
            if k is None:
                if last is not None and last["kind"] == "own":
                    last["atoms"].append(i)
                else:
                    parts.append({"kind": "own", "atoms": [i]})
                continue
            if last is not None and last["kind"] == "kept" and k == last["to"] + 1:
                last["to"] = k
                last["atoms"].append(i)
            else:
                parts.append({"kind": "kept", "from": k, "to": k, "atoms": [i]})
        for part in parts:
            if part["kind"] == "kept":
                part["lo"] = info.residues[part["from"]]["num"]
                part["hi"] = info.residues[part["to"]]["num"]
        return {"chain": info.chain, "source": info.residues, "parts": parts}

    def chain_source_cif(self, chain: str) -> dict[str, str] | None:
        """The chain as it was loaded, as a minimal overlay mmCIF (`{chain, cif}`), or None when unknown."""
        key = self.chain_key(chain)
        src = self._sources.get(key)
        if src is None:
            return None
        b = src.array
        keys = chain_key_array(b)
        mine = keys == src.chain
        wanted = {int(r) for r in np.asarray(b.res_id)[mine]}
        header = ["data_overlay", "loop_"] + [
            f"_atom_site.{c}" for c in (
                "group_PDB", "id", "type_symbol", "label_atom_id", "label_comp_id", "label_asym_id", "label_entity_id",
                "label_seq_id", "auth_seq_id", "auth_asym_id", "Cartn_x", "Cartn_y", "Cartn_z", "occupancy",
                "B_iso_or_equiv", "pdbx_PDB_model_num")]
        rows = []
        for i in np.flatnonzero(mine):
            x, y, z = (float(v) for v in b.coord[i])
            if not np.isfinite(x) or int(b.res_id[i]) not in wanted:
                continue
            name = str(b.atom_name[i])
            element = (str(b.element[i]) if len(str(b.element[i])) else name[:1]).upper() or "C"
            quoted = f'"{name}"' if re.search(r"['\"\s]", name) else name
            rows.append(
                f"ATOM {len(rows) + 1} {element} {quoted} {b.res_name[i]} {src.label} 1 {int(b.res_id[i])} "
                f"{int(b.res_id[i])} {src.label} {x:.3f} {y:.3f} {z:.3f} 1.00 0.00 1"
            )
        return {"chain": src.label, "cif": ("\n".join([*header, *rows]) + "\n") if rows else ""}

    # -- low-level edits (used inside a transaction) ---------------------------------------------------------------
    def _permute(self, order) -> None:
        order = np.asarray(order, dtype=int)
        if len(order) != len(self.array) or len(np.unique(order)) != len(order):
            raise ValueError("permutation must name every atom once")
        self.array = self.array[order]

    def _delete_atoms(self, indices) -> None:
        """Atoms removed; new residues beside them are re-joined to what is next to them now."""
        a = self.array
        selected = np.unique(np.asarray(list(indices), dtype=int))
        if len(selected) >= len(a):
            raise ValueError("cannot delete every atom")
        keys = chain_key_array(a)
        touched = set(keys[selected].tolist())
        keep = np.ones(len(a), dtype=bool)
        keep[selected] = False
        result = a[keep]
        reinstall_sentinel_bonds(result, touched)
        self.array = result
        refresh_chain_derived_annotations(self.array)

    def _insert_segment_array(
        self,
        minimum: int,
        maximum: int,
        *,
        atom_index: int | None,
        before: bool,
        new_chain: bool,
        chain: str | None,
        chain_type: str | None,
    ) -> int:
        """One new-residue placeholder, numbered so that no residue already there is renumbered; its index.

        The residue before's number with the next insertion code ("40A") where the numbering has no gap, rather
        than shifting the rest of the chain up by one: a target's numbering (and its hotspots) must not change under
        the user. `atom_index` is any atom of the residue the placeholder goes before or after.
        """
        a = self.array
        n = len(a)
        minimum = max(1, int(minimum))
        maximum = max(minimum, int(maximum))
        if new_chain:
            chain_id = (chain or "").strip() or self.next_chain_id()
            ct = _chain_type_of(chain_type)
            result = insert_expandable_segment(
                a, minimum, maximum, new_chain=True, new_chain_id=chain_id, new_chain_type=ct
            )
            position = n
            if "transformation_id" in result.get_annotation_categories():
                tids = np.asarray(result.transformation_id).astype("<U8")
                tids[position] = "1"
                result.set_annotation("transformation_id", tids)
            result.set_annotation("chain_id", np.asarray(result.chain_id).astype(f"<U{max(8, len(chain_id))}"))
            result.chain_id[position] = chain_id
            refresh_chain_derived_annotations(result)
            self._reset_hidden(result, position)
            self.array = result
            return position
        if atom_index is None:
            raise ValueError("atom_index is required when new_chain is false")
        bounds = residue_bounds(a)
        r = int(np.searchsorted(bounds[:-1], int(atom_index), side="right")) - 1
        anchor = int(bounds[r]) if before else int(bounds[r + 1]) - 1
        position = anchor if before else anchor + 1
        keys = chain_key_array(a)
        key = keys[anchor]
        chain_idx = np.flatnonzero(keys == key)
        res_ids = np.asarray(a.res_id)
        ins = _ins_array(a)
        n_before = int((chain_idx < position).sum())
        shift = False
        res_id, ins_code = 1, ""
        if n_before > 0:
            prev_atom = int(chain_idx[n_before - 1])
            prev_id = int(res_ids[prev_atom])
            next_atom = int(chain_idx[n_before]) if n_before < len(chain_idx) else None
            next_id = None if next_atom is None else int(res_ids[next_atom])
            prev_ins = str(ins[prev_atom])
            code = chr(ord(prev_ins[0]) + 1) if prev_ins else "A"
            next_ins = "" if next_atom is None else str(ins[next_atom])
            if next_id is None or next_id > prev_id + 1:
                res_id = prev_id + 1 if next_id is None else next_id - 1
            elif not (next_id == prev_id and next_ins and next_ins <= code) and re.fullmatch(r"[A-Z]", code):
                res_id, ins_code = prev_id, code
            else:
                res_id, shift = prev_id + 1, True
        else:
            res_id = int(res_ids[chain_idx[0]]) - 1
        result = insert_expandable_segment(a, minimum, maximum, atom_idx=anchor, insert_before=before)
        if not shift:
            # `insert_expandable_segment` numbers by its own rule: put every residue back and number the placeholder.
            old_ids = np.insert(res_ids, position, res_id)
            old_ins = np.insert(ins, position, ins_code)
            result.set_annotation("res_id", old_ids.astype(res_ids.dtype))
            result.set_annotation("ins_code", old_ins.astype("<U4"))
        else:
            result.res_id[position] = res_id
            result.set_annotation("ins_code", np.insert(ins, position, "").astype("<U4"))
        refresh_chain_derived_annotations(result)
        self._reset_hidden(result, position)
        self.array = result
        install_sentinel_bonds(self.array, position)
        return position

    @staticmethod
    def _reset_hidden(array: AtomArrayPlus, index: int) -> None:
        for name in array.get_annotation_categories():
            if name.startswith(_HIDDEN_PREFIX):
                values = np.asarray(array.get_annotation(name)).astype(object)
                values[index] = ""
                set_hidden(array, name, values)
        if SRC_COMPONENT in array.get_annotation_categories():
            labels = _src_labels(array)
            labels[index] = ""
            _set_src_labels(array, labels)

    def _renumber_chain(self, key: str) -> None:
        """One chain's residues numbered consecutively, its first residue that is not new residues being 1."""
        a = self.array
        bounds = residue_bounds(a)
        keys = chain_key_array(a)
        segment = is_segment_mask(a)
        mine = [r for r in range(len(bounds) - 1) if keys[bounds[r]] == key]
        first_kept = max(0, next((k for k, r in enumerate(mine) if not segment[bounds[r]]), 0))
        res_id = np.asarray(a.res_id).copy()
        ins = _ins_array(a).astype("<U4")
        counter = -first_kept
        for r in mine:
            counter += 1
            res_id[bounds[r]:bounds[r + 1]] = counter
            ins[bounds[r]:bounds[r + 1]] = ""
        a.set_annotation("res_id", res_id)
        a.set_annotation("ins_code", ins)

    # -- chain residues ------------------------------------------------------------------------------------------
    def _chain_residues(self, key: str, *, segments: bool = False) -> list[dict[str, Any]]:
        """Polymer residues of a chain in order, as ``{key, res_id, atoms}``; with `segments`, placeholders too."""
        a = self.array
        keys = chain_key_array(a)
        ins = _ins_array(a)
        segment = is_segment_mask(a)
        polymer = is_polymer_mask(a)
        seg_min = np.asarray(S_SEGMIN.annotation(a)) if S_SEGMIN.has_annotation(a) else None
        seg_max = np.asarray(S_SEGMAX.annotation(a)) if S_SEGMAX.has_annotation(a) else None
        out: list[dict[str, Any]] = []
        for i in np.flatnonzero(keys == key):
            i = int(i)
            if segments and segment[i]:
                lo = int(seg_min[i]) if seg_min is not None and seg_min[i] > 0 else 1
                hi = int(seg_max[i]) if seg_max is not None and seg_max[i] > 0 else lo
                out.append({"key": f"seg:{i}", "segment": True, "atoms": [i], "length": int(np.floor((lo + hi) / 2 + 0.5))})
                continue
            if not polymer[i]:
                continue
            key_i = f"{key}:{int(a.res_id[i])}:{ins[i]}"
            if not out or out[-1]["key"] != key_i:
                out.append({"key": key_i, "res_id": int(a.res_id[i]), "atoms": []})
            out[-1]["atoms"].append(i)
        return out

    # -- rebuild -------------------------------------------------------------------------------------------------
    def rebuild_chain(self, chain: str, parts: list[dict[str, Any]]) -> dict[str, Any]:
        """Chain rebuilt to `parts`, in that order, in one undo step (see the module docstring)."""
        key = self.chain_key(chain)
        with self.edit():
            return self._rebuild(key, parts)

    def _rebuild(self, key: str, parts: list[dict[str, Any]]) -> dict[str, Any]:
        info = self._source_index(key)

        def to_index(num) -> int:
            for k, r in enumerate(info.residues):
                if r["num"] == int(num):
                    return k
            raise ValueError(f"chain {self._chain_label(key)} as loaded has no residue {num}")

        plan: list[dict[str, Any]] = []
        for p in parts:
            kind = p.get("kind")
            if kind == "kept":
                start = p["from"] if isinstance(p.get("from"), int) and not isinstance(p.get("from"), bool) else to_index(p["lo"])
                end = p["to"] if isinstance(p.get("to"), int) and not isinstance(p.get("to"), bool) else to_index(p["hi"])
                plan.append({"kind": "kept", "from": int(start), "to": int(end)})
            elif kind == "own":
                plan.append({"kind": "own", "atoms": [int(i) for i in p.get("atoms", [])]})
            elif kind == "new":
                atom = p.get("atom")
                low = int(p.get("min") or 1)
                plan.append(
                    {"kind": "new", "atom": int(atom) if isinstance(atom, int) and not isinstance(atom, bool) else None,
                     "min": max(1, low), "max": max(max(1, low), int(p.get("max") or 1))}
                )
            else:
                raise ValueError(f"unknown part kind {kind!r}")
        own_of = {i: k for k, p in enumerate(plan) if p["kind"] == "own" for i in p["atoms"]}
        want: set[int] = set()
        for p in plan:
            if p["kind"] == "kept":
                want.update(range(min(p["from"], p["to"]), max(p["from"], p["to"]) + 1))
        keep_segments = {p["atom"] for p in plan if p["kind"] == "new" and p["atom"] is not None}

        a = self.array
        keys = chain_key_array(a)
        segment = is_segment_mask(a)
        polymer = is_polymer_mask(a)
        tags = np.full(len(a), "", dtype=object)
        present: set[int] = set()
        drop: list[int] = []
        src_tags = hidden_tags(a)
        for i in np.flatnonzero(keys == key):
            i = int(i)
            if segment[i]:
                tags[i] = f"s{i}"
                if i not in keep_segments:
                    drop.append(i)
            elif polymer[i]:
                k = self._source_index_of(i, info, src_tags)
                if k is not None:
                    tags[i] = f"r{k}"
                    if k in want:
                        present.add(k)
                    else:
                        drop.append(i)
                elif i in own_of:
                    tags[i] = f"p{own_of[i]}"
                else:
                    tags[i] = "x"
                    drop.append(i)
            else:
                tags[i] = "o"
        set_hidden(a, "_studio_tag", tags)
        seg_tag = {id(p): f"s{p['atom']}" for p in plan if p["kind"] == "new" and p["atom"] is not None}
        if drop:
            self._delete_atoms(drop)

        missing = want - present
        if missing and info.array is None:
            raise ValueError(f"chain {self._chain_label(key)} has no source to bring residues back from")
        if missing:
            b = info.array
            b_keys = chain_key_array(b)
            b_ins = _ins_array(b)
            take, take_tags, take_src = [], [], []
            for i in np.flatnonzero((b_keys == info.source_chain) & is_polymer_mask(b)):
                k = info.index.get(f"{int(b.res_id[i])}:{b_ins[i]}")
                if k is not None and k in missing:
                    take.append(int(i))
                    take_tags.append(f"r{k}")
                    take_src.append(f"{int(b.res_id[i])}:{b_ins[i]}")
            part = b[np.asarray(take, dtype=int)]
            set_hidden(part, "_studio_tag", take_tags)
            set_hidden(part, HIDDEN_SRC, take_src)
            self._apply_chain(part, np.arange(len(part)), key)
            self.array = concatenate_documents([self.array, part])
            refresh_chain_derived_annotations(self.array)

        # New blocks: a placeholder each, tagged by its place in the plan.
        for k, p in enumerate(plan):
            if p["kind"] != "new" or p["atom"] is not None:
                continue
            keys = chain_key_array(self.array)
            mine = np.flatnonzero(keys == key)
            if len(mine):
                position = self._insert_segment_array(
                    p["min"], p["max"], atom_index=int(mine[0]), before=True, new_chain=False, chain=None, chain_type=None
                )
            else:
                chain_id, _, _tid = key.rpartition("_")
                position = self._insert_segment_array(
                    p["min"], p["max"], atom_index=None, before=True, new_chain=True, chain=chain_id or key, chain_type=None
                )
            tt = hidden_tags(self.array, "_studio_tag").astype(object)
            tt[position] = f"n{k}"
            set_hidden(self.array, "_studio_tag", tt)
            seg_tag[id(p)] = f"n{k}"

        # The chain's atoms in the plan's order (anything else in the chain, a ligand, after them).
        c = self.array
        keys = chain_key_array(c)
        tag_now = hidden_tags(c, "_studio_tag")
        ins = _ins_array(c)
        res_ids = np.asarray(c.res_id)
        res_names = np.asarray(c.res_name).astype(str)
        rid = np.full(len(c), "", dtype=object)
        for i in np.flatnonzero(keys == key):
            rid[i] = f"{tag_now[i]}|{res_ids[i]}|{ins[i]}|{res_names[i]}"
        set_hidden(c, "_studio_rid", rid)
        by_tag: dict[str, list[int]] = {}
        for i in np.flatnonzero(keys == key):
            by_tag.setdefault(str(tag_now[i]) or "o", []).append(int(i))
        block: list[int] = []
        for k, p in enumerate(plan):
            if p["kind"] == "kept":
                step = 1 if p["from"] <= p["to"] else -1
                for kk in range(p["from"], p["to"] + step, step):
                    block.extend(by_tag.get(f"r{kk}", []))
            elif p["kind"] == "own":
                block.extend(by_tag.get(f"p{k}", []))
            else:
                block.extend(by_tag.get(seg_tag.get(id(p), ""), []))
        block.extend(by_tag.get("o", []))
        order: list[int] = []
        placed = False
        for i in range(len(c)):
            if keys[i] != key:
                order.append(i)
            elif not placed:
                order.extend(block)
                placed = True
        self._permute(order)

        # Numbering and source names, one rule.
        d = self.array
        keys = chain_key_array(d)
        tg = hidden_tags(d, "_studio_tag")
        rids = hidden_tags(d, "_studio_rid")
        src = _src_labels(d)
        linked_before: set[str] = set()
        for u, v, _bt in _bond_pairs(d).tolist():
            if rids[u] and rids[v] and rids[u] != rids[v]:
                linked_before.add(f"{rids[u]}>{rids[v]}")
                linked_before.add(f"{rids[v]}>{rids[u]}")
        bounds = residue_bounds(d)
        segment = is_segment_mask(d)
        res: list[dict[str, Any]] = []
        for r in range(len(bounds) - 1):
            s0, e = int(bounds[r]), int(bounds[r + 1])
            if keys[s0] != key:
                continue
            tv = str(tg[s0]) or "o"
            res.append({"s0": s0, "e": e, "k": int(tv[1:]) if tv.startswith("r") else None, "seg": bool(segment[s0])})
        res_id = np.asarray(d.res_id).copy()
        ins_code = _ins_array(d).astype("<U4")

        def set_res(r, num, code):
            res_id[r["s0"]:r["e"]] = num
            ins_code[r["s0"]:r["e"]] = code

        def fixed_num(r):
            if r["k"] is not None:
                x = info.residues[r["k"]]
                return x["num"], x["ins"]
            return int(res_id[r["s0"]]), str(ins_code[r["s0"]])

        real = [r for r in res if not r["seg"]]

        def after(x, y):
            (xn, xi), (yn, yi) = x, y
            return (xn > yn) or (xn == yn and xi > yi)

        in_order = all(j == 0 or after(fixed_num(r), fixed_num(real[j - 1])) for j, r in enumerate(real))
        if in_order:
            for r in res:
                if r["k"] is not None:
                    x = info.residues[r["k"]]
                    set_res(r, x["num"], x["ins"])
                    src[r["s0"]:r["e"]] = x["label"]
            last_id, last_ins = None, ""
            for j, r in enumerate(res):
                if not r["seg"]:
                    last_id, last_ins = int(res_id[r["s0"]]), str(ins_code[r["s0"]])
                    continue
                q = next((x for x in res[j + 1:] if not x["seg"]), None)
                q_id = fixed_num(q)[0] if q is not None else None
                code = ""
                if last_id is None:
                    num = q_id - 1 if q_id is not None else 1
                elif q_id is None:
                    num = last_id + 1
                elif q_id - 1 > last_id:
                    num = q_id - 1
                else:
                    num, code = last_id, (chr(ord(last_ins[0]) + 1) if last_ins else "A")
                set_res(r, num, code)
                last_id, last_ins = num, code
            d.set_annotation("res_id", res_id)
            d.set_annotation("ins_code", ins_code)
            _set_src_labels(d, src)
        else:
            for r in res:
                if r["k"] is not None:
                    x = info.residues[r["k"]]
                    src[r["s0"]:r["e"]] = x["label"] or f"{info.chain}{x['num']}{x['ins']}"
            _set_src_labels(d, src)
            self._renumber_chain(key)

        # Bonds along the plan: the chain's backbone links rebuilt (side-chain links such as disulfides kept).
        d = self.array
        res_of = np.full(len(d), -1, dtype=int)
        for j, r in enumerate(res):
            res_of[r["s0"]:r["e"]] = j
        names = np.asarray(d.atom_name).astype(str)
        rows = []
        for u, v, bt in _bond_pairs(d).tolist():
            ru, rv = res_of[u], res_of[v]
            if ru < 0 or rv < 0 or ru == rv:
                rows.append((u, v, bt))
            elif res[ru]["seg"] or res[rv]["seg"]:
                continue
            elif not (names[u] in _BACKBONE_LINKS and names[v] in _BACKBONE_LINKS):
                rows.append((u, v, bt))
        _set_bonds(d, rows)
        chain_types = d.chain_type if "chain_type" in d.get_annotation_categories() else np.zeros(len(d), int)

        def find(r, name):
            for i in range(r["s0"], r["e"]):
                if names[i] == name:
                    return i
            return -1

        rids = hidden_tags(d, "_studio_rid")
        for j in range(len(res) - 1):
            x, y = res[j], res[j + 1]
            was_linked = f"{rids[x['s0']]}>{rids[y['s0']]}" in linked_before
            if not was_linked and (x["k"] is None or y["k"] is None or y["k"] != x["k"] + 1):
                continue
            if x["seg"] or y["seg"]:
                continue
            term, start = _bond_atom_names(int(chain_types[x["s0"]]))
            u, v = find(x, term), find(y, start)
            if u >= 0 and v >= 0:
                _add_bond(d, u, v)
        for r in res:
            if r["seg"]:
                install_sentinel_bonds(d, r["s0"])
        for name in ("_studio_tag", "_studio_rid"):
            if name in d.get_annotation_categories():
                d.del_annotation(name)
        refresh_chain_derived_annotations(d)
        return {"message": f"Chain {self._chain_label(key)} rebuilt."}

    def preview_rebuild(self, chain: str, parts: list[dict[str, Any]]) -> str:
        """The CIF of the document with `chain` rebuilt to `parts`; this document is unchanged."""
        key = self.chain_key(chain)
        copy_ = self.clone()
        copy_.rebuild_chain(key, parts)
        return copy_.to_cif()

    # -- removing ------------------------------------------------------------------------------------------------
    def remove_atoms(self, indices: list[int]) -> dict[str, Any]:
        """Atoms removed. Whole residues and blocks of new residues taken out of a chain that stays are a plan edit
        (the chain re-joined and numbered by the one rule); anything else (a whole chain, a ligand, some atoms of a
        residue) is deleted as it is. One undo step."""
        selected = self.resolve_indices(indices, "atom")
        a = self.array
        delete = set(int(i) for i in selected)
        keys = chain_key_array(a)
        ins = _ins_array(a)
        segment = is_segment_mask(a)
        polymer = is_polymer_mask(a)
        residue_ids = [f"{keys[i]}:{int(a.res_id[i])}:{ins[i]}:{a.res_name[i]}" for i in range(len(a))]
        by_residue: dict[str, list[int]] = {}
        for i, key in enumerate(residue_ids):
            by_residue.setdefault(key, []).append(i)
        planned: list[str] = []
        for key in dict.fromkeys(keys[sorted(delete)].tolist()):
            mine = np.flatnonzero(keys == key)
            if all(int(i) in delete for i in mine):
                continue
            gone = [int(i) for i in mine if int(i) in delete]
            whole = all(
                (segment[i] or polymer[i]) and all(j in delete for j in by_residue[residue_ids[i]]) for i in gone
            )
            if whole:
                planned.append(key)
        with self.edit():
            if not planned:
                self._remove_plain(sorted(delete))
                return {"message": f"Deleted {len(delete)} atoms."}
            tag = np.zeros(len(a), dtype=int)
            tag[sorted(delete)] = 1
            set_hidden(a, "_studio_remove", tag)
            for key in planned:
                d = self.array
                t = hidden_tags(d, "_studio_remove")
                dkeys = chain_key_array(d)
                plan = self.chain_plan(key)
                info = self._source_index(key)
                out = {int(i) for i in np.flatnonzero(dkeys == key) if t[i] == "1"}
                new_parts: list[dict[str, Any]] = []
                for q in plan["parts"]:
                    if q["kind"] == "new":
                        if q["atom"] not in out:
                            new_parts.append({"kind": "new", "atom": q["atom"], "min": q["min"], "max": q["max"]})
                        continue
                    if q["kind"] == "own":
                        left = [i for i in q["atoms"] if i not in out]
                        if left:
                            new_parts.append({"kind": "own", "atoms": left})
                        continue
                    keep_k: list[int] = []
                    for i in q["atoms"]:
                        if i in out:
                            continue
                        k = self._source_index_of(i, info)
                        if k is not None and (not keep_k or keep_k[-1] != k):
                            keep_k.append(k)
                    run = id(q)
                    for k in keep_k:
                        last = new_parts[-1] if new_parts else None
                        if last is not None and last["kind"] == "kept" and last["to"] == k - 1 and last.get("_run") == run:
                            last["to"] = k
                        else:
                            new_parts.append({"kind": "kept", "from": k, "to": k, "_run": run})
                self._rebuild(key, [{k: v for k, v in p.items() if k != "_run"} for p in new_parts])
            d = self.array
            rest = [int(i) for i in np.flatnonzero(hidden_tags(d, "_studio_remove") == "1")]
            if rest:
                self._delete_atoms(rest)
            if "_studio_remove" in self.array.get_annotation_categories():
                self.array.del_annotation("_studio_remove")
            return {"message": f"Removed {len(delete)} atoms."}

    def _remove_plain(self, delete: list[int]) -> None:
        a = self.array
        if len(delete) >= len(a):
            raise ValueError("cannot delete every atom")
        self._delete_atoms(delete)

    # -- chain order, coordinates, segments ------------------------------------------------------------------------
    def reorder_chains(self, chains: list[str]) -> dict[str, Any]:
        """Chains in the order given (chains not named keep their place after those named)."""
        a = self.array
        labels = display_chain_array(a)
        keys = chain_key_array(a)
        want: list[str] = []
        missing = []
        for chain in chains or []:
            try:
                want.append(self.chain_key(str(chain)))
            except KeyError:
                missing.append(str(chain))
        if missing:
            raise ValueError(f"no chain {', '.join(missing)}")
        present = list(dict.fromkeys(keys.tolist()))
        sequence = [*dict.fromkeys(want), *[k for k in present if k not in want]]
        order = [int(i) for key in sequence for i in np.flatnonzero(keys == key)]
        with self.edit():
            self._permute(order)
            refresh_chain_derived_annotations(self.array)
        names = [str(labels[np.flatnonzero(keys == k)[0]]) for k in sequence]
        return {"message": f"Chains in order {', '.join(names)}."}

    def clear_coordinates(self, indices: list[int], lead: list[int] | None = None) -> dict[str, Any]:
        """Forget where `indices` are: no coordinates, occupancy or coordinate conditions. Atoms in `lead` move to
        the front of their residues (in their order), so a residue that keeps only some atoms is read from one."""
        selected = self.resolve_indices(indices, "atom")
        with self.edit():
            a = self.array
            a.coord[selected] = np.nan
            a.occupancy[selected] = 0
            # Targets first: a group member without a target is a valid state, the reverse is not.
            for full_name in ("condition_InternalCoordinate_1_atom", "condition_CoordinateGroup_1_atom",
                              "condition_coordinate_1_atom"):
                cls = _standard_annotation(full_name)
                if cls is None:
                    continue
                values = np.asarray(cls.annotation(a, default="generate")).copy()
                values[selected] = np.asarray(cls.default_annotation(a))[selected]
                if full_name == "condition_CoordinateGroup_1_atom":
                    cls.set_annotation(a, values, on_internal_coord_mismatch="clear")
                else:
                    cls.set_annotation(a, values)
            first = {int(i) for i in (lead or [])}
            if first:
                bounds = residue_bounds(a)
                order: list[int] = []
                for r in range(len(bounds) - 1):
                    atoms = list(range(int(bounds[r]), int(bounds[r + 1])))
                    order.extend([i for i in atoms if i in first] + [i for i in atoms if i not in first])
                self._permute(order)
                refresh_chain_derived_annotations(self.array)
        return {"affected_count": int(len(selected)), "message": f"Cleared the coordinates of {len(selected)} atoms."}

    def set_segment_range(self, atom_index: int, minimum: int, maximum: int) -> dict[str, Any]:
        """Change an expandable segment's length range (its placeholder's min/max, and its ``min-max`` name)."""
        a = self.array
        if not S_SEGMIN.has_annotation(a) or not (0 <= int(atom_index) < len(a)):
            raise ValueError("not an expandable segment")
        seg_min = np.asarray(S_SEGMIN.annotation(a)).copy()
        if not seg_min[atom_index] > 0:
            raise ValueError("not an expandable segment")
        low = max(1, int(minimum))
        high = max(low, int(maximum))
        with self.edit():
            a = self.array
            seg_min = np.asarray(S_SEGMIN.annotation(a)).copy()
            seg_max = np.asarray(S_SEGMAX.annotation(a)).copy()
            seg_min[atom_index], seg_max[atom_index] = low, high
            S_SEGMIN.set_annotation(a, seg_min)
            S_SEGMAX.set_annotation(a, seg_max)
            if _SEGMENT_NAME.fullmatch(str(a.res_name[atom_index])):
                names = np.asarray(a.res_name).astype(f"<U{max(a.res_name.dtype.itemsize // 4, 9)}")
                names[atom_index] = f"{low}-{high}"
                a.set_annotation("res_name", names)
        return {"message": f"Segment length set to {low}-{high}."}

    # -- segments that replaced residues -----------------------------------------------------------------------------
    def replace_with_segments(self, indices: list[int], minimum: int, maximum: int) -> dict[str, Any]:
        """Replace the selected polymer residues with new residues: one ``min-max`` block per contiguous run."""
        selected = self.resolve_indices(indices, "residue")
        a = self.array
        keys_arr = chain_key_array(a)
        ins = _ins_array(a)
        keys = {f"{keys_arr[i]}:{int(a.res_id[i])}:{ins[i]}" for i in selected}
        low = max(1, int(np.floor(float(minimum or 0) + 0.5)) or 1)
        high = max(low, int(np.floor(float(maximum or 0) + 0.5)) or low)
        drop: list[int] = []
        runs: list[dict[str, Any]] = []
        for chain in dict.fromkeys(keys_arr[selected].tolist()):
            residues = self._chain_residues(chain)
            in_run = False
            for k, r in enumerate(residues):
                if r["key"] not in keys:
                    in_run = False
                    continue
                drop.extend(r["atoms"])
                if in_run:
                    runs[-1]["atoms"].extend(r["atoms"])
                    continue
                in_run = True
                prev = next((x for x in reversed(residues[:k]) if x["key"] not in keys), None)
                nxt = next((x for x in residues[k + 1:] if x["key"] not in keys), None)
                runs.append({"chain": chain, "prev": prev["key"] if prev else None,
                             "next": nxt["key"] if nxt else None, "atoms": list(r["atoms"])})
        if not drop:
            raise ValueError("select polymer residues to replace")
        origins = [SegmentOrigin(run["chain"], run["prev"], run["next"], copy.deepcopy(a[np.asarray(run["atoms"])]))
                   for run in runs]
        with self.edit():
            for chain in dict.fromkeys(run["chain"] for run in runs):
                plan = self.chain_plan(chain)
                info = self._source_index(chain)
                d = self.array
                dkeys = chain_key_array(d)
                dins = _ins_array(d)
                new_parts: list[dict[str, Any]] = []
                in_run = False

                def res_key(i):
                    return f"{dkeys[i]}:{int(d.res_id[i])}:{dins[i]}"

                for q in plan["parts"]:
                    if q["kind"] == "new":
                        new_parts.append({"kind": "new", "atom": q["atom"], "min": q["min"], "max": q["max"]})
                        in_run = False
                        continue
                    if q["kind"] == "own":
                        last_key = None
                        for i in q["atoms"]:
                            key = res_key(i)
                            if key == last_key:
                                if new_parts and new_parts[-1]["kind"] == "own" and not in_run:
                                    new_parts[-1]["atoms"].append(i)
                                continue
                            last_key = key
                            if key in keys:
                                if not in_run:
                                    new_parts.append({"kind": "new", "min": low, "max": high})
                                    in_run = True
                            else:
                                in_run = False
                                if new_parts and new_parts[-1]["kind"] == "own":
                                    new_parts[-1]["atoms"].append(i)
                                else:
                                    new_parts.append({"kind": "own", "atoms": [i]})
                        continue
                    last_k = None
                    for i in q["atoms"]:
                        k = self._source_index_of(i, info)
                        if k == last_k:
                            continue
                        last_k = k
                        if res_key(i) in keys:
                            if not in_run:
                                new_parts.append({"kind": "new", "min": low, "max": high})
                                in_run = True
                        else:
                            in_run = False
                            last = new_parts[-1] if new_parts else None
                            if last is not None and last["kind"] == "kept" and last["to"] == k - 1:
                                last["to"] = k
                            else:
                                new_parts.append({"kind": "kept", "from": k, "to": k})
                self._rebuild(chain, new_parts)
            self._origins.extend(origins)
        count = len(runs)
        return {"message": f"Replaced {len(keys)} residues with {count} new-residue segment{'' if count == 1 else 's'}."}

    def _segment_origin(self, atom_index: int):
        a = self.array
        if not self._origins or not (0 <= int(atom_index) < len(a)) or not is_segment_mask(a)[atom_index]:
            return None
        chain = str(chain_key_array(a)[atom_index])
        residues = self._chain_residues(chain, segments=True)
        k = next((j for j, r in enumerate(residues) if r.get("segment") and r["atoms"][0] == atom_index), -1)

        def near(r):
            if r is None:
                return None
            return _NEUTRAL if r.get("segment") else r["key"]

        prev = near(residues[k - 1]) if k - 1 >= 0 else None
        nxt = near(residues[k + 1]) if k + 1 < len(residues) else None
        taken = {r["key"] for r in residues if not r.get("segment")}
        for origin in reversed(self._origins):
            if origin.chain != chain or origin.prev != prev or origin.next != nxt:
                continue
            b = origin.array
            bkeys = chain_key_array(b)
            bins = _ins_array(b)
            keys = list(dict.fromkeys(f"{chain}:{int(b.res_id[i])}:{bins[i]}" for i in range(len(b))))
            if any(key in taken for key in keys):
                continue
            return origin, keys
        return None

    def segment_origin(self, atom_index: int) -> dict[str, Any] | None:
        """How many residues segment `atom_index` replaced, and their keys ("A:41:"), or None when not known."""
        found = self._segment_origin(atom_index)
        if found is None:
            return None
        _origin, keys = found
        chain = self._chain_label(str(chain_key_array(self.array)[atom_index]))
        shown = [f"{chain}:{key.split(':', 1)[1]}" for key in keys]
        return {"count": len(keys), "keys": shown}

    def segment_origins(self) -> dict[str, dict[str, Any]]:
        """`segment_origin` of every new-residue atom that has one, by atom index (as text)."""
        out = {}
        for i in np.flatnonzero(is_segment_mask(self.array)):
            found = self.segment_origin(int(i))
            if found is not None:
                out[str(int(i))] = found
        return out

    def restore_segment(self, atom_index: int) -> dict[str, Any]:
        """Turn new-residue segment `atom_index` back into the residues it replaced, in its place, with their
        conditions and coordinates. One undo step."""
        found = self._segment_origin(atom_index)
        if found is None:
            raise ValueError("these new residues did not replace residues this document remembers")
        origin, keys = found
        chain = str(chain_key_array(self.array)[atom_index])
        with self.edit():
            before = len(self.array)
            part = copy.deepcopy(origin.array)
            self._apply_chain(part, np.arange(len(part)), chain)
            self.array = concatenate_documents([self.array, part])
            order = []
            for i in range(before):
                if i == atom_index:
                    order.extend(range(before, len(self.array)))
                else:
                    order.append(i)
            order.append(atom_index)
            self._permute(order)
            self._delete_atoms([len(self.array) - 1])
            self._relink_chain(chain)
            refresh_chain_derived_annotations(self.array)
        return {"message": f"Brought back {len(keys)} residue{'' if len(keys) == 1 else 's'} to chain {self._chain_label(chain)}."}

    def _relink_chain(self, key: str) -> None:
        """A chain's links after its residues moved: peptide bonds between consecutive numbers, blocks joined."""
        a = self.array
        bounds = residue_bounds(a)
        keys = chain_key_array(a)
        segment = is_segment_mask(a)
        polymer = is_polymer_mask(a)
        names = np.asarray(a.atom_name).astype(str)
        res_of = np.zeros(len(a), dtype=int)
        for r in range(len(bounds) - 1):
            res_of[bounds[r]:bounds[r + 1]] = r
        in_chain = keys == key
        own = {int(i) for i in np.flatnonzero(in_chain & segment)}
        rows = []
        for u, v, bt in _bond_pairs(a).tolist():
            if in_chain[u] and in_chain[v] and res_of[u] != res_of[v]:
                continue
            if u in own or v in own:
                continue
            rows.append((u, v, bt))
        _set_bonds(a, rows)
        chain_types = a.chain_type if "chain_type" in a.get_annotation_categories() else np.zeros(len(a), int)

        def find(r, name):
            for i in range(bounds[r], bounds[r + 1]):
                if names[i] == name:
                    return i
            return -1

        for r in range(len(bounds) - 2):
            s1, s2 = int(bounds[r]), int(bounds[r + 1])
            if not (in_chain[s1] and in_chain[s2]) or segment[s1] or segment[s2]:
                continue
            if not (polymer[s1] and polymer[s2]) or int(a.res_id[s2]) - int(a.res_id[s1]) != 1:
                continue
            term, start = _bond_atom_names(int(chain_types[s1]))
            u, v = find(r, term), find(r + 1, start)
            if u >= 0 and v >= 0:
                _add_bond(a, u, v)
        for i in sorted(own):
            install_sentinel_bonds(a, i)

    # -- set-ups ---------------------------------------------------------------------------------------------------
    def _insert_gap_segments(self, gaps: list[dict[str, Any]]) -> None:
        """One segment per gap (anchored on residue `res_id` of `chain`); C-terminal gaps first, so renumbering never
        moves an anchor still to be used."""
        rank = {chain: k for k, chain in enumerate(dict.fromkeys(g["chain"] for g in gaps))}

        def order(g):
            return (rank[g["chain"]], -(g["res_id"] if g["res_id"] is not None else 0), 1 if g["before"] else 0)

        for g in sorted(gaps, key=order):
            if g["res_id"] is None:
                chain_id, _, _t = g["chain"].rpartition("_")
                self._insert_segment_array(g["min"], g["max"], atom_index=None, before=True, new_chain=True,
                                           chain=chain_id or g["chain"], chain_type=None)
                continue
            anchor = next((r["atoms"][0] for r in self._chain_residues(g["chain"]) if r["res_id"] == g["res_id"]), None)
            if anchor is not None:
                self._insert_segment_array(g["min"], g["max"], atom_index=anchor, before=g["before"], new_chain=False,
                                           chain=None, chain_type=None)

    def scaffold_motif(
        self,
        indices: list[int],
        *,
        spread: float = 0.25,
        sidechains_only: bool = False,
        unindexed: bool = False,
        total_min: int | None = None,
        total_max: int | None = None,
        ordered: bool = False,
    ) -> dict[str, Any]:
        """Motif scaffolding around a selection: keep the selected residues (sequence and coordinates of the whole
        residue, or of its side chain only), delete the other polymer residues of their chains and rebuild them as new
        residues (one segment per gap, each its original length +/- `spread`; unindexed: one segment of `total_min`
        to `total_max` plus the motif)."""
        a = self.array
        indices = [int(i) for i in indices]
        keep = self.resolve_indices(indices, "residue")
        keys_arr = chain_key_array(a)
        ins = _ins_array(a)

        def res_key(i):
            return f"{keys_arr[i]}:{int(a.res_id[i])}:{ins[i]}"

        typed: list[str] = list(dict.fromkeys(res_key(i) for i in indices)) if ordered else []
        if not len(keep):
            raise ValueError("select the motif residues first")
        polymer = is_polymer_mask(a)
        keep_polymer = [int(i) for i in keep if polymer[i]]
        if not keep_polymer:
            raise ValueError("select at least one protein or nucleic-acid residue as the motif")
        kept = {res_key(i) for i in keep_polymer}
        chains = list(dict.fromkeys(keys_arr[keep_polymer].tolist()))

        def span(length):
            low = max(1, int(np.floor(length * (1 - spread) + 0.5)))
            return low, max(low, int(np.floor(length * (1 + spread) + 0.5)))

        gaps: list[dict[str, Any]] = []
        drop: list[int] = []
        for chain in chains:
            residues = self._chain_residues(chain, segments=True)
            for r in residues:
                if r["key"] not in kept:
                    drop.extend(r["atoms"])
            first = next((r for r in residues if r["key"] in kept), None)
            if unindexed:
                total = sum(r["length"] if r.get("segment") else (0 if r["key"] in kept else 1) for r in residues)
                d_min, d_max = span(total)
                low = max(1, int(np.floor((total_min if total_min is not None else d_min) + 0.5)))
                high = max(low, int(np.floor((total_max if total_max is not None else d_max) + 0.5)))
                gaps.append({"chain": chain, "res_id": first["res_id"], "before": True, "min": low, "max": high})
                continue
            run = 0
            last_kept = None
            def flush(nxt):
                nonlocal run
                if not run:
                    return
                anchor = last_kept if last_kept is not None else nxt
                if anchor is not None:
                    low, high = span(run)
                    gaps.append({"chain": chain, "res_id": anchor["res_id"], "before": last_kept is None, "min": low, "max": high})
                run = 0
            for r in residues:
                if r["key"] in kept:
                    flush(r)
                    last_kept = r
                else:
                    run += r["length"] if r.get("segment") else 1
            flush(None)

        backbone = {"N", "CA", "C", "O", "OXT"}
        names = np.asarray(a.atom_name).astype(str)
        crd_atoms = [int(i) for i in keep if (not polymer[i]) or names[i] not in backbone] if sidechains_only else [int(i) for i in keep]
        with self.edit():
            self.set_condition("coordinate", [int(i) for i in keep], enabled=False, allow_target_discard=True)
            if crd_atoms:
                self.set_condition("coordinate", crd_atoms, allow_target_discard=True)
            self.set_condition("sequence", [int(i) for i in keep], allow_target_discard=True)
            # "Index conditioning" is stored inverted: enabling it marks residues as unindexed (placed anywhere).
            self.set_condition("index", keep_polymer, enabled=unindexed, allow_target_discard=True)
            if drop:
                self._delete_atoms(drop)
            self._insert_gap_segments(gaps)
            if len(typed) > 1:
                self._order_motif(typed, chains)
        n = len(kept)
        return {"message": f"Kept {n} motif residue{'' if n == 1 else 's'}{' (placed anywhere)' if unindexed else ''}; "
                           f"{len(gaps)} new-residue segment{'' if len(gaps) == 1 else 's'}."}

    def _order_motif(self, typed: list[str], chains: list[str]) -> None:
        """After a scaffold: the kept residues of `chains` take the order of `typed` ("A:38:" style), each in the slot
        of a kept residue (new-residue segments stay where they are), and the chains are numbered 1, 2, 3... again."""
        a = self.array
        keys = chain_key_array(a)
        ins = _ins_array(a)
        bounds = residue_bounds(a)
        segment = is_segment_mask(a)
        residues = []
        for r in range(len(bounds) - 1):
            s0, e = int(bounds[r]), int(bounds[r + 1])
            residues.append({"key": f"{keys[s0]}:{int(a.res_id[s0])}:{ins[s0]}", "chain": str(keys[s0]),
                             "atoms": list(range(s0, e)), "segment": bool(segment[s0]), "next": None})
        changed = False
        for chain in chains:
            slots = [r for r in residues if r["chain"] == chain and not r["segment"]]
            want = [k for k in typed if any(r["key"] == k for r in slots)]
            if len(want) != len(slots):
                continue
            by_key = {r["key"]: r for r in slots}
            for k, slot in enumerate(slots):
                slot["next"] = by_key[want[k]]
                if slot["next"] is not slot:
                    changed = True
        if not changed:
            return
        labels = _src_labels(a)
        chain_ids = np.asarray(a.chain_id).astype(str)
        for r in residues:
            if not r["segment"] and not labels[r["atoms"][0]]:
                for i in r["atoms"]:
                    labels[i] = f"{chain_ids[i]}{int(a.res_id[i])}"
        _set_src_labels(a, labels)
        self._permute([i for r in residues for i in (r["next"] or r)["atoms"]])
        for chain in chains:
            self._renumber_chain(chain)
        reinstall_sentinel_bonds(self.array, set(chains))
        refresh_chain_derived_annotations(self.array)

    def design_around_ligand(
        self, *, remove_protein: bool = True, pose_fixed: bool = True, minimum: int = 100, maximum: int = 150
    ) -> dict[str, Any]:
        """Small-molecule binder set-up: optionally remove every polymer chain, keep the ligands (identity always;
        pose fixed or predicted) and add a new protein chain of `minimum`-`maximum` residues."""
        a = self.array
        polymer = is_polymer_mask(a) | is_segment_mask(a)
        ligand = np.flatnonzero(~polymer)
        if not len(ligand):
            raise ValueError("this structure has no ligand")
        with self.edit():
            if remove_protein and polymer.any():
                self._delete_atoms(np.flatnonzero(polymer))
            now = self.array
            lig = [int(i) for i in np.flatnonzero(~(is_polymer_mask(now) | is_segment_mask(now)))]
            self.set_condition("sequence", lig, allow_target_discard=True)
            self.set_condition("coordinate", lig, enabled=bool(pose_fixed), allow_target_discard=True)
            self._insert_segment_array(minimum, maximum, atom_index=None, before=True, new_chain=True, chain=None, chain_type=None)
            n_lig = len(set(np.asarray(self.array.res_name)[lig].tolist()))
        return {"message": f"Set up a protein of {minimum}-{maximum} residues around {n_lig} ligand(s)."}

    # -- serialization -------------------------------------------------------------------------------------------
    def export_design_state(self, *, undo_arrays: list[AtomArrayPlus] | None = None) -> dict[str, Any]:
        """The sources, segment origins and residue tags as JSON-safe data (for a shared store or a session file)."""
        from atomworks_studio_editing.document import StudioDocument

        cache = getattr(self, "_design_cif_cache", None)
        if cache is None:
            cache = self._design_cif_cache = {}

        def cif_of(array: AtomArrayPlus) -> str:
            hit = cache.get(id(array))
            if hit is None or hit[0] is not array:
                hit = cache[id(array)] = (array, StudioDocument._array_to_cif(array))
            return hit[1]

        loaded: list[AtomArrayPlus] = []
        sources: dict[str, dict[str, Any]] = {}
        for key, src in self._sources.items():
            for k, array in enumerate(loaded):
                if array is src.array:
                    break
            else:
                loaded.append(src.array)
                k = len(loaded) - 1
            sources[key] = {"loaded": k, "chain": src.chain, "label": src.label}
        return {
            "keys": chain_key_array(self.array).tolist(),
            "src_tags": hidden_tags(self.array).tolist(),
            "undo_src_tags": [hidden_tags(array).tolist() for array in (undo_arrays or [])],
            "loaded": [{"cif": cif_of(array), "keys": chain_key_array(array).tolist()} for array in loaded],
            "sources": sources,
            "origins": [
                {"chain": o.chain, "prev": o.prev, "next": o.next, "cif": cif_of(o.array),
                 "keys": chain_key_array(o.array).tolist(), "src_tags": hidden_tags(o.array).tolist()}
                for o in self._origins
            ],
        }

    def restore_design_state(self, state: dict[str, Any] | None, *, undo_arrays: list[AtomArrayPlus] | None = None) -> None:
        """Counterpart of `export_design_state` on a document just parsed from the same CIF."""
        from atomworks_studio_editing.document import parse_annotated_cif

        if not state:
            return
        a = self.array
        if len(state.get("src_tags", [])) == len(a):
            set_hidden(a, HIDDEN_SRC, state["src_tags"])
        for array, tags in zip(undo_arrays or [], state.get("undo_src_tags", []), strict=False):
            if len(tags) == len(array):
                set_hidden(array, HIDDEN_SRC, tags)
        # Parsing a written assembly renames its chains: map old keys to new ones through the atoms.
        mapping: dict[str, str] = {}
        old_keys = state.get("keys", [])
        if len(old_keys) == len(a):
            for old, new in zip(old_keys, chain_key_array(a).tolist(), strict=True):
                mapping.setdefault(old, new)

        def remap(array: AtomArrayPlus, old: list[str]) -> dict[str, str]:
            out: dict[str, str] = {}
            if len(old) == len(array):
                for o, n in zip(old, chain_key_array(array).tolist(), strict=True):
                    out.setdefault(o, n)
            return out

        arrays = []
        maps = []
        for item in state.get("loaded", []):
            array = parse_annotated_cif(item["cif"])
            arrays.append(array)
            maps.append(remap(array, item.get("keys", [])))
        self._sources = {}
        for old_key, item in state.get("sources", {}).items():
            k = int(item["loaded"])
            self._sources[mapping.get(old_key, old_key)] = ChainSource(
                arrays[k], maps[k].get(item["chain"], item["chain"]), item["label"]
            )
        self._origins = []

        def rekey(value: str | None) -> str | None:
            if value is None:
                return None
            parts = value.rsplit(":", 2)
            return f"{mapping.get(parts[0], parts[0])}:{parts[1]}:{parts[2]}" if len(parts) == 3 else value

        for item in state.get("origins", []):
            array = parse_annotated_cif(item["cif"])
            if len(item.get("src_tags", [])) == len(array):
                set_hidden(array, HIDDEN_SRC, item["src_tags"])
            self._origins.append(
                SegmentOrigin(mapping.get(item["chain"], item["chain"]), rekey(item["prev"]), rekey(item["next"]), array)
            )
