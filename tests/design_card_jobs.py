"""Operation lists the design card builds its recipes from, for the page-engine parity tests.

Each job names the entries it opens (RCSB entries, as the card's recipes fetch them) and applies the operations the card
sends: rebuild a chain from parts, set a length range, replace residues with new residues, restore them, scaffold a
motif, reorder chains, clear coordinates, preview, and an undo after each. Selectors are resolved against each engine's
own atoms at the step (see `tests/parity/js_engine_driver.mjs`).
"""

from __future__ import annotations

from typing import Any

RCSB = {"preset": "rcsb", "assembly": "1", "keep_unresolved": True}


def _entry(entry: str, name: str | None = None, **open_options) -> dict[str, Any]:
    return {"entry": entry, "name": name or entry, "open": {**RCSB, **open_options}}


def _undo(n: int = 1) -> list[dict[str, Any]]:
    return [{"op": "undo"}] * n


def rigid(selector: dict, group_id: int | None = None) -> list[dict[str, Any]]:
    """A rigid body with its saved targets cleared, as the card's `_setRigid` sends it."""
    return [
        {"op": "internal_coords", "select": selector, "enabled": True, "group_id": group_id},
        {"op": "clear_targets", "select": selector},
    ]


# -- the card's recipes ---------------------------------------------------------------------------------------------
def protein_binder() -> dict[str, Any]:
    """5O45 chain A: cropped to 1-115, hotspots, a new chain beside it, its length changed, the target made rigid."""
    return {
        "documents": {"main": _entry("5O45")},
        "ops": [
            {"op": "delete", "select": {"chain": "B"}},
            {"op": "plan", "chain": "A"},
            {"op": "rebuild", "chain": "A", "parts": [{"kind": "kept", "lo": 1, "hi": 115}]},
            {"op": "plan", "chain": "A"},
            {"op": "preview", "chain": "A", "parts": [{"kind": "kept", "lo": 1, "hi": 60}, {"kind": "new", "min": 5, "max": 9}]},
            {"op": "conditions", "edits": [
                {"condition": "hotspot", "select": {"chain": "A", "res": "40", "names": ["CG", "OH"]}},
                {"condition": "hotspot", "select": {"chain": "A", "res": "99", "names": ["CG", "SD"]}},
            ]},
            {"op": "insert_segment", "minimum": 60, "maximum": 100, "new_chain": True, "before": False},
            {"op": "segment_range", "select": {"kind": "segment", "k": 0}, "minimum": 50, "maximum": 120},
            *rigid({"chain": "A", "names": ["N", "CA", "C", "O"]}, group_id=1),
            {"op": "conditions", "edits": [
                {"condition": "coordinate", "select": {"chain": "A"}, "enabled": False},
                {"condition": "coordinate", "select": {"chain": "A", "names": ["N", "CA", "C", "O"]}},
                {"condition": "sequence", "select": {"chain": "A"}},
            ]},
            {"op": "order", "chain_ids": ["B", "A"]},
            {"op": "assign_chain", "select": {"chain": "A"}, "chain_id": "T"},
            *_undo(4),
        ],
    }


def small_molecule_binder() -> dict[str, Any]:
    """1XVA with SAM kept (the ligand binder set-up), then the new chain renamed and the chain order changed."""
    return {
        "documents": {"main": _entry("1XVA")},
        "ops": [
            {"op": "delete", "select": [{"chain": ["A_1", "B_1", "A_2", "B_2", "F_1", "F_2", "D_2"]}]},
            {"op": "ligand_binder", "remove_protein": True, "pose_fixed": False, "minimum": 150, "maximum": 150},
            {"op": "plan", "chain": "A"},
            {"op": "assign_chain", "select": {"chain": "A"}, "chain_id": "B"},
            {"op": "order", "chain_ids": ["D_1", "B"]},
            {"op": "undo"},
            {"op": "order", "chain_ids": ["B", "D_1"]},
        ],
    }


def motif_scaffolding() -> dict[str, Any]:
    """1QJG: three residues kept in the order typed, the rest new residues of about their lengths; lengths edited."""
    keep = [{"chain": "C", "res": "38"}, {"chain": "C", "res": "14"}, {"chain": "C", "res": "99"}]
    return {
        "documents": {"main": _entry("1QJG", drop_names=["H1", "H3"])},
        "ops": [
            {"op": "delete", "select": {"chain": ["D", "J", "K"]}},
            {"op": "scaffold", "select": keep, "spread": 0.25, "ordered": True},
            {"op": "plan", "chain": "C"},
            {"op": "segment_range", "select": {"chain": "C", "kind": "segment", "k": 0}, "minimum": 10, "maximum": 20},
            {"op": "segment_range", "select": {"chain": "C", "kind": "segment", "k": 1}, "minimum": 15, "maximum": 30},
            {"op": "undo"},
            {"op": "undo"},
            {"op": "undo"},
            {"op": "scaffold", "select": keep, "spread": 0.5, "ordered": False},
            {"op": "plan", "chain": "C"},
            {"op": "undo"},
            {"op": "scaffold", "select": keep, "unindexed": True, "total_min": 90, "total_max": 120},
            {"op": "plan", "chain": "C"},
        ],
    }


def enzyme() -> dict[str, Any]:
    """1J79: a catalytic Asp's tip atoms held anywhere, the rest of the chain new residues, a ligand held as it is."""
    tip = {"chain": "A", "res": "250", "names": ["CG", "OD1"]}
    return {
        "documents": {"main": _entry("1J79")},
        "ops": [
            {"op": "delete", "select": {"chain": ["B", "D", "F", "G", "H", "I"]}},
            {"op": "scaffold", "select": {"chain": "A", "res": "250"}, "unindexed": True, "total_min": 180, "total_max": 180},
            {"op": "plan", "chain": "A"},
            {"op": "clear_coordinates", "select": {"chain": "A", "res": "250", "names": ["N", "CA", "C", "O", "CB"]}, "lead": tip},
            {"op": "conditions", "edits": [{"condition": "coordinate", "select": tip}]},
            {"op": "assign_chain", "select": {"chain": "C"}, "chain_id": "B"},
            {"op": "assign_chain", "select": {"chain": "E"}, "chain_id": "C"},
            {"op": "order", "chain_ids": ["A", "C", "B"]},
            *_undo(5),
        ],
    }


def antibody() -> dict[str, Any]:
    """1N8Z: heavy and light frameworks rigid, CDR H3 replaced with new residues, restored, the antigen cropped."""
    return {
        "documents": {"main": _entry("1N8Z")},
        "ops": [
            {"op": "assign_chain", "select": {"chain": "A"}, "chain_id": "L"},
            {"op": "assign_chain", "select": {"chain": "B"}, "chain_id": "H"},
            {"op": "assign_chain", "select": {"chain": "C"}, "chain_id": "T"},
            {"op": "rebuild", "chain": "H", "parts": [{"kind": "kept", "lo": 1, "hi": 120}]},
            *rigid({"chain": "H"}, group_id=1),
            {"op": "rebuild", "chain": "L", "parts": [{"kind": "kept", "lo": 1, "hi": 107}]},
            *rigid({"chain": "L"}, group_id=1),
            {"op": "replace", "select": {"chain": "H", "res": "99-109"}, "minimum": 11, "maximum": 11},
            {"op": "plan", "chain": "H"},
            {"op": "origins"},
            {"op": "conditions", "edits": [
                {"condition": "cath_label", "select": {"chain": ["H", "L"]}, "value": "2.60.40", "scope": "chain"},
            ]},
            {"op": "restore", "select": {"chain": "H", "kind": "segment", "k": 0}},
            {"op": "plan", "chain": "H"},
            {"op": "rebuild", "chain": "T", "parts": [{"kind": "kept", "lo": 545, "hi": 580}, {"kind": "kept", "lo": 591, "hi": 607}]},
            {"op": "plan", "chain": "T"},
            {"op": "replace", "select": {"chain": "H", "res": "99-109"}, "minimum": 8, "maximum": 22},
            {"op": "segment_range", "select": {"chain": "H", "kind": "segment", "k": 0}, "minimum": 9, "maximum": 20},
            *_undo(3),
        ],
    }


def nanobody() -> dict[str, Any]:
    """4Z18 chain A with 3EAK's nanobody combined in, renamed, CDRs replaced by new residues of a range."""
    return {
        "documents": {"main": _entry("4Z18"), "other": _entry("3EAK")},
        "ops": [
            {"op": "delete", "select": {"chain": ["B_1", "B"]}},
            {"op": "rebuild", "chain": "A", "parts": [{"kind": "kept", "lo": 2, "hi": 114}]},
            {"op": "combine", "with": "other"},
            {"op": "assign_chain", "select": {"chain": "B"}, "chain_id": "H"},
            {"op": "plan", "chain": "H"},
            {"op": "replace", "select": {"chain": "H", "res": "23-38"}, "minimum": 11, "maximum": 16},
            {"op": "replace", "select": {"chain": "H", "res": "53-62"}, "minimum": 8, "maximum": 12},
            {"op": "replace", "select": {"chain": "H", "res": "100-117"}, "minimum": 8, "maximum": 22},
            {"op": "plan", "chain": "H"},
            {"op": "origins"},
            {"op": "restore", "select": {"chain": "H", "kind": "segment", "k": 1}},
            {"op": "undo"},
            {"op": "rebuild", "chain": "H", "parts": [{"kind": "kept", "lo": 1, "hi": 40}]},
            *_undo(2),
        ],
    }


def inverse_folding() -> dict[str, Any]:
    """2KL8 cut to residues 1-79, its sequence freed."""
    return {
        "documents": {"main": _entry("2KL8", drop_names=["H1", "H3"])},
        "ops": [
            {"op": "rebuild", "chain": "A", "parts": [{"kind": "kept", "lo": 1, "hi": 79}]},
            {"op": "plan", "chain": "A"},
            {"op": "conditions", "edits": [{"condition": "sequence", "select": {"chain": "A"}, "enabled": False}]},
            {"op": "undo"},
        ],
    }


def partial_diffusion() -> dict[str, Any]:
    """2KL8 cut and given new residues, every block restored (partial diffusion starts from coordinates)."""
    return {
        "documents": {"main": _entry("2KL8", drop_names=["H1", "H3"])},
        "ops": [
            {"op": "rebuild", "chain": "A", "parts": [{"kind": "kept", "lo": 1, "hi": 79}]},
            {"op": "replace", "select": {"chain": "A", "res": "30-40"}, "minimum": 4, "maximum": 6},
            {"op": "replace", "select": {"chain": "A", "res": "60-65"}, "minimum": 3, "maximum": 3},
            {"op": "origins"},
            {"op": "restore", "select": {"chain": "A", "kind": "segment", "k": 1}},
            {"op": "restore", "select": {"chain": "A", "kind": "segment", "k": 0}},
            {"op": "plan", "chain": "A"},
            *_undo(4),
        ],
    }


def rebuild_parts() -> dict[str, Any]:
    """Kept, new and own parts in every order: split around new residues, reordered (a motif in its own order)."""
    return {
        "documents": {"main": _entry("2KL8", drop_names=["H1", "H3"])},
        "ops": [
            {"op": "rebuild", "chain": "A", "parts": [{"kind": "kept", "lo": 1, "hi": 30}, {"kind": "new", "min": 5, "max": 10}, {"kind": "kept", "lo": 41, "hi": 79}]},
            {"op": "plan", "chain": "A"},
            {"op": "rebuild", "chain": "A", "parts": [{"kind": "kept", "lo": 1, "hi": 35}, {"kind": "new", "select": {"chain": "A", "kind": "segment", "k": 0}, "min": 5, "max": 10}, {"kind": "kept", "lo": 41, "hi": 79}]},
            {"op": "plan", "chain": "A"},
            {"op": "preview", "chain": "A", "parts": [{"kind": "kept", "lo": 50, "hi": 60}, {"kind": "kept", "lo": 10, "hi": 20}]},
            {"op": "rebuild", "chain": "A", "parts": [{"kind": "kept", "lo": 50, "hi": 60}, {"kind": "new", "min": 3, "max": 4}, {"kind": "kept", "lo": 10, "hi": 20}]},
            {"op": "plan", "chain": "A"},
            {"op": "rebuild", "chain": "A", "parts": [{"kind": "kept", "lo": 10, "hi": 20}, {"kind": "own", "select": {"chain": "A", "res": "50-52"}}]},
            {"op": "plan", "chain": "A"},
            {"op": "delete", "select": {"chain": "A", "res": "12-14"}},
            {"op": "plan", "chain": "A"},
            {"op": "source", "chain": "A"},
            *_undo(5),
            {"op": "insert_segment", "minimum": 5, "maximum": 10, "select": {"chain": "A", "res": "40", "names": ["CA"]}, "before": False},
            {"op": "insert_segment", "minimum": 5, "maximum": 10, "select": {"chain": "A", "res": "40", "names": ["CA"]}, "before": False},
            {"op": "insert_segment", "minimum": 2, "maximum": 3, "select": {"chain": "A", "res": "1", "names": ["CA"]}, "before": True},
            {"op": "plan", "chain": "A"},
            {"op": "delete", "select": {"chain": "A", "res": "41"}},
            {"op": "delete", "select": {"chain": "A", "kind": "segment", "k": 1}},
            {"op": "plan", "chain": "A"},
        ],
    }


JOBS = {
    "protein_binder": protein_binder,
    "small_molecule_binder": small_molecule_binder,
    "motif_scaffolding": motif_scaffolding,
    "enzyme": enzyme,
    "antibody": antibody,
    "nanobody": nanobody,
    "inverse_folding": inverse_folding,
    "partial_diffusion": partial_diffusion,
    "rebuild_parts": rebuild_parts,
}
