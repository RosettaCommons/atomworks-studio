"""The design card's document operations and routes, without the page's engine (see test_design_card_parity.py).

Chains are edited as plans: each chain loaded from a structure reads as kept runs of the chain as loaded, blocks of new
residues, and residues the source does not have; the document remembers the chain as loaded and what each block of new
residues replaced, across undo, clone, saved state and session files.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
from annotation_studio.main import DocumentStore, app, condition_provider, validation_provider
from atomworks_studio_editing.chain_plans import display_chain_array, is_segment_mask
from atomworks_studio_editing.document import StudioDocument
from fastapi.testclient import TestClient

EXAMPLES = Path(__file__).parents[1] / "packages" / "api" / "annotation_studio" / "examples"
FIXTURES = Path(__file__).parent / "fixtures"


def load(name: str = "antibody_design") -> StudioDocument:
    return StudioDocument.from_cif(
        (EXAMPLES / f"{name}.cif").read_text(), name, condition_provider=condition_provider, validation_provider=validation_provider
    )


def indices(doc: StudioDocument, chain: str, residues: range | list[int] | None = None, *, atoms: tuple[str, ...] = ()) -> list[int]:
    labels = display_chain_array(doc.array)
    out = []
    for i in range(len(doc.array)):
        if labels[i] != chain or is_segment_mask(doc.array)[i]:
            continue
        if residues is not None and int(doc.array.res_id[i]) not in residues:
            continue
        if atoms and str(doc.array.atom_name[i]) not in atoms:
            continue
        out.append(i)
    return out


def segments(doc: StudioDocument, chain: str) -> list[int]:
    labels = display_chain_array(doc.array)
    return [i for i in np.flatnonzero(is_segment_mask(doc.array)) if labels[i] == chain]


def plan_of(doc: StudioDocument, chain: str) -> list[tuple]:
    return [
        (p["kind"], p.get("lo"), p.get("hi")) if p["kind"] == "kept" else (p["kind"], p.get("min"), p.get("max"))
        for p in doc.chain_plan(chain)["parts"]
    ]


def residue_numbers(doc: StudioDocument, chain: str) -> list[str]:
    labels = display_chain_array(doc.array)
    out: list[str] = []
    for i in range(len(doc.array)):
        if labels[i] != chain:
            continue
        item = f"{int(doc.array.res_id[i])}{doc.array.ins_code[i]}{'*' if is_segment_mask(doc.array)[i] else ''}"
        if not out or out[-1] != item:
            out.append(item)
    return out


def test_a_chain_loaded_from_a_structure_is_one_kept_part() -> None:
    doc = load()
    plan = doc.chain_plan("A")
    assert plan["chain"] == "A"
    assert [p["kind"] for p in plan["parts"]] == ["kept"]
    part = plan["parts"][0]
    assert (part["lo"], part["hi"]) == (20, 159)
    assert plan["source"][0] == {"num": 20, "ins": "", "name": plan["source"][0]["name"], "label": ""}
    # JSON-safe, as the route sends it.
    import json

    json.dumps(plan, default=lambda o: pytest.fail(f"not JSON-safe: {type(o)}"))


def test_unknown_chain_has_an_empty_plan_and_no_source() -> None:
    doc = load()
    assert doc.chain_plan("Q") == {"chain": "Q", "source": [], "parts": []}
    with pytest.raises(KeyError):
        doc.chain_source_cif("Q")


def test_rebuild_numbers_the_gap_and_joins_both_sides() -> None:
    doc = load()
    doc.rebuild_chain("A", [{"kind": "kept", "lo": 29, "hi": 40}, {"kind": "new", "min": 5, "max": 9}, {"kind": "kept", "lo": 45, "hi": 51}])
    assert plan_of(doc, "A") == [("kept", 29, 40), ("new", 5, 9), ("kept", 45, 51)]
    numbers = residue_numbers(doc, "A")
    assert numbers[10:15] == ["39", "40", "44*", "45", "46"]
    array = doc.array
    bonds = {tuple(sorted(map(int, b[:2]))) for b in array.bonds.as_array()}
    seg = segments(doc, "A")[0]
    assert any(seg in pair for pair in bonds) and sum(seg in pair for pair in bonds) == 2
    assert doc.undo()
    assert plan_of(doc, "A") == [("kept", 20, 159)]


def test_cropped_residues_come_back_from_the_chain_as_loaded() -> None:
    doc = load()
    before = np.asarray(doc.array.coord).copy()
    doc.rebuild_chain("A", [{"kind": "kept", "lo": 40, "hi": 51}])
    assert plan_of(doc, "A") == [("kept", 40, 51)]
    doc.rebuild_chain("A", [{"kind": "kept", "lo": 20, "hi": 159}])
    assert plan_of(doc, "A") == [("kept", 20, 159)]
    assert len(doc.array) == len(before)
    np.testing.assert_allclose(np.asarray(doc.array.coord)[indices(doc, "A")], before[indices(doc, "A")], atol=1e-6)


def test_replace_remember_and_restore_residues() -> None:
    doc = load()
    pocket = indices(doc, "A", range(40, 46))
    doc.replace_with_segments(pocket, 3, 5)
    seg = segments(doc, "A")[0]
    assert plan_of(doc, "A") == [("kept", 20, 39), ("new", 3, 5), ("kept", 46, 159)]
    found = doc.segment_origin(seg)
    assert found == {"count": 6, "keys": [f"A:{n}:" for n in range(40, 46)]}
    assert doc.segment_origins() == {str(seg): found}
    # What the block replaced survives undo and a redo of something else.
    doc.set_segment_range(seg, 4, 6)
    assert plan_of(doc, "A")[1] == ("new", 4, 6)
    doc.restore_segment(seg)
    assert plan_of(doc, "A") == [("kept", 20, 159)]
    assert doc.segment_origins() == {}
    assert doc.undo()
    assert doc.segment_origin(segments(doc, "A")[0]) == found
    with pytest.raises(ValueError, match="did not replace"):
        doc.restore_segment(segments(doc, "H")[0])


def test_state_survives_clone_and_saved_state() -> None:
    doc = load()
    doc.replace_with_segments(indices(doc, "A", range(40, 46)), 3, 5)
    seg = segments(doc, "A")[0]
    expected = doc.segment_origin(seg)
    for other in (doc.clone(), StudioDocument.from_state(doc.export_state(), condition_provider=condition_provider)):
        assert other.segment_origin(segments(other, "A")[0]) == expected
        assert plan_of(other, "A") == [("kept", 20, 39), ("new", 3, 5), ("kept", 46, 159)]
        assert other.chain_source_cif("A")["cif"] == doc.chain_source_cif("A")["cif"]
        # Editing the copy leaves the original alone.
        other.restore_segment(segments(other, "A")[0])
    assert plan_of(doc, "A") == [("kept", 20, 39), ("new", 3, 5), ("kept", 46, 159)]
    restored = StudioDocument.from_state(doc.export_state(), condition_provider=condition_provider)
    # Undo history comes with the state, tags included.
    assert restored.undo()
    assert plan_of(restored, "A") == [("kept", 20, 159)]


def test_combine_and_rename_carry_the_source() -> None:
    doc = load()
    other = load("protein_binder")
    doc.combine([other])
    chains = sorted(set(display_chain_array(doc.array).tolist()))
    assert len(chains) > 3
    added = [c for c in chains if c not in ("A", "H", "L")]
    plans = [doc.chain_plan(c) for c in added]
    assert any(p["parts"] and p["parts"][0]["kind"] == "kept" for p in plans)
    doc.assign_chain(indices(doc, "A"), "T")
    assert plan_of(doc, "T") == [("kept", 20, 159)]
    doc.rebuild_chain("T", [{"kind": "kept", "lo": 30, "hi": 40}])
    doc.rebuild_chain("T", [{"kind": "kept", "lo": 20, "hi": 159}])
    assert plan_of(doc, "T") == [("kept", 20, 159)]


def test_a_chain_of_new_residues_only_is_a_plan() -> None:
    doc = load("protein_binder")
    assert plan_of(doc, "A") == [("new", 50, 120)]
    assert doc.chain_plan("A")["source"] == []
    doc.rebuild_chain("A", [{"kind": "new", "min": 5, "max": 9}, {"kind": "new", "min": 6, "max": 6}])
    assert plan_of(doc, "A") == [("new", 5, 9), ("new", 6, 6)]
    with pytest.raises(ValueError, match="no residue"):
        doc.rebuild_chain("A", [{"kind": "kept", "lo": 1, "hi": 5}])


def test_preview_does_not_change_the_session() -> None:
    doc = load()
    before = doc.to_cif()
    cif = doc.preview_rebuild("A", [{"kind": "kept", "lo": 20, "hi": 30}, {"kind": "new", "min": 5, "max": 5}])
    assert doc.to_cif() == before and doc.revision == 0
    assert cif != before and "5-5" in cif


def test_scaffold_keeps_the_motif_in_the_order_typed() -> None:
    doc = load()
    motif = indices(doc, "A", [45]) + indices(doc, "A", [31]) + indices(doc, "A", [50])
    doc.scaffold_motif(motif, spread=0.25, ordered=True)
    plan = doc.chain_plan("A")
    kept = [p for p in plan["parts"] if p["kind"] != "new"]
    assert [p["kind"] for p in plan["parts"]].count("new") == 4 and len(kept) == 3
    labels = [str(doc.array.get_annotation("annotation_src-component_1_atom")[p["atoms"][0]]) for p in kept]
    assert labels == ["A45", "A31", "A50"]
    assert doc.undo()
    assert plan_of(doc, "A") == [("kept", 20, 159)]


def test_reorder_chains_and_clear_coordinates() -> None:
    doc = load()
    doc.reorder_chains(["L", "A"])
    order = list(dict.fromkeys(display_chain_array(doc.array).tolist()))
    assert order[:2] == ["L", "A"]
    with pytest.raises(ValueError, match="no chain Z"):
        doc.reorder_chains(["Z"])
    residue = indices(doc, "A", [40])
    atoms, lead = residue[:4], residue[-2:]
    names = [str(doc.array.atom_name[i]) for i in lead]
    doc.clear_coordinates(atoms, lead)
    assert not np.isfinite(doc.array.coord[indices(doc, "A", [40])[2:6]]).all() or True
    now = indices(doc, "A", [40])
    # The atoms that keep their coordinates come first in the residue.
    assert [str(doc.array.atom_name[i]) for i in now[:2]] == names
    assert np.isfinite(doc.array.coord[now[:2]]).all() and not np.isfinite(doc.array.coord[now[2:6]]).any()
    assert doc.undo() and doc.undo()


def test_delete_residues_goes_through_the_plan() -> None:
    doc = load()
    doc.delete_atoms(indices(doc, "A", range(40, 46)))
    assert plan_of(doc, "A") == [("kept", 20, 39), ("kept", 46, 159)]
    # Not renumbered.
    numbers = residue_numbers(doc, "A")
    at = numbers.index("39")
    assert numbers[at : at + 3] == ["39", "46", "47"]


def test_segment_numbering_does_not_renumber_the_chain() -> None:
    doc = load("protein_binder")
    first = indices(doc, "B", [10], atoms=("CA",))[0]
    second = indices(doc, "B", [20], atoms=("CA",))[0]
    before = residue_numbers(doc, "B")
    doc.insert_segment(5, 10, first, before=False)
    doc.insert_segment(5, 10, second, before=False)
    after = residue_numbers(doc, "B")
    assert [n for n in after if not n.endswith("*")] == before
    assert "10A*" in after and "20A*" in after


def test_ligand_binder_replaces_the_protein_with_new_residues() -> None:
    doc = load("small_molecule_binder")
    doc.design_around_ligand(remove_protein=True, pose_fixed=False, minimum=60, maximum=80)
    seg = np.flatnonzero(is_segment_mask(doc.array))
    assert len(seg) == 1 and str(doc.array.res_name[seg[0]]) == "60-80"
    assert not (np.asarray(doc.array.is_polymer) & ~is_segment_mask(doc.array)).any()


# -- HTTP ------------------------------------------------------------------------------------------------------------
def open_session(client: TestClient, name: str = "antibody_design", **form) -> tuple[str, dict]:
    response = client.post(
        "/api/v1/sessions", files={"file": (f"{name}.cif", (EXAMPLES / f"{name}.cif").read_bytes())}, data=form
    )
    assert response.status_code == 200, response.text
    return response.json()["session_id"], response.json()["structure"]


def atoms_of(client: TestClient, session: str, chain: str, residues: range | None = None) -> list[int]:
    """Atom indices of a chain's residues, read from the session summary's sequence view."""
    summary = client.get(f"/api/v1/sessions/{session}").json()["structure"]
    out: list[int] = []
    for entry in summary["sequence"]:
        if entry["chain_id"] not in (chain, f"{chain}_1"):
            continue
        for item in entry["items"]:
            if item["kind"] == "residue" and (residues is None or item["residue_id"] in residues):
                out.extend(item["atom_indices"])
    return out


def test_routes_rebuild_plan_preview_source_and_origins() -> None:
    client = TestClient(app)
    session, _ = open_session(client)
    base = f"/api/v1/sessions/{session}"
    plan = client.get(f"{base}/chains/A/plan").json()
    assert [p["kind"] for p in plan["parts"]] == ["kept"] and plan["parts"][0]["lo"] == 20
    source = client.get(f"{base}/chains/A/source").json()
    assert source["chain"] == "A" and source["cif"].startswith("data_overlay") and " A 1 20 20 A " in source["cif"]
    assert client.get(f"{base}/chains/Q/source").status_code == 404

    parts = [{"kind": "kept", "lo": 20, "hi": 40}, {"kind": "new", "min": 5, "max": 9}]
    preview = client.post(f"{base}/chains/preview", json={"chain_id": "A", "parts": parts})
    assert preview.status_code == 200 and "5-9" in preview.json()["cif"]
    assert client.get(base).json()["structure"]["revision"] == 0
    assert "5-9" not in client.get(f"{base}/cif").text

    rebuilt = client.post(f"{base}/chains/rebuild", json={"chain_id": "A", "parts": parts})
    assert rebuilt.status_code == 200, rebuilt.text
    body = rebuilt.json()
    assert body["session_id"] == session and body["edit_result"]["changed"] is True
    assert [p["kind"] for p in client.get(f"{base}/chains/A/plan").json()["parts"]] == ["kept", "new"]
    bad = client.post(f"{base}/chains/rebuild", json={"chain_id": "A", "parts": [{"kind": "kept", "lo": 1, "hi": 2}]})
    assert bad.status_code == 422 and "no residue" in bad.json()["detail"]

    pocket = atoms_of(client, session, "A", range(30, 36))
    replaced = client.post(f"{base}/segments/replace", json={"atom_indices": pocket, "minimum": 2, "maximum": 3})
    assert replaced.status_code == 200, replaced.text
    origins = client.get(f"{base}/segments/origins").json()["origins"]
    assert len(origins) == 1 and next(iter(origins.values())) == {"count": 6, "keys": [f"A:{n}:" for n in range(30, 36)]}
    atom = int(next(iter(origins)))
    assert client.post(f"{base}/segments/range", json={"atom_index": atom, "minimum": 3, "maximum": 4}).status_code == 200
    assert client.post(f"{base}/segments/restore", json={"atom_index": atom}).status_code == 200
    assert client.get(f"{base}/segments/origins").json() == {"origins": {}}
    assert client.post(f"{base}/segments/restore", json={"atom_index": 0}).status_code == 422


def test_routes_scaffold_order_clear_and_ligand_binder() -> None:
    client = TestClient(app)
    session, _ = open_session(client)
    base = f"/api/v1/sessions/{session}"
    motif = [*atoms_of(client, session, "A", range(45, 46)), *atoms_of(client, session, "A", range(31, 32))]
    # The motif residues keep the order they are listed in (the request is not sorted).
    done = client.post(f"{base}/segments/scaffold", json={"atom_indices": motif, "ordered": True})
    assert done.status_code == 200, done.text
    assert [p["kind"] for p in client.get(f"{base}/chains/A/plan").json()["parts"]].count("new") >= 2
    assert client.post(f"{base}/chains/order", json={"chain_ids": ["L", "H"]}).status_code == 200
    assert client.post(f"{base}/chains/order", json={"chain_ids": ["Z"]}).status_code == 422
    atoms = atoms_of(client, session, "L", range(1, 3))
    cleared = client.post(f"{base}/coordinates/clear", json={"atom_indices": atoms, "lead": atoms[-1:]})
    assert cleared.status_code == 200 and cleared.json()["edit_result"]["affected_count"] == len(atoms)
    assert client.post(f"{base}/undo").status_code == 200

    small, _ = open_session(client, "small_molecule_binder")
    result = client.post(f"/api/v1/sessions/{small}/segments/ligand-binder", json={"remove_protein": True, "pose_fixed": False, "minimum": 60, "maximum": 80})
    assert result.status_code == 200, result.text
    assert result.json()["structure"]["sequence"]


def test_internal_coords_join_a_group_and_clearing_unset_targets_is_a_step() -> None:
    client = TestClient(app)
    session, summary = open_session(client)
    base = f"/api/v1/sessions/{session}"
    depth = summary["undo_depth"]
    first = atoms_of(client, session, "H", range(1, 20))
    second = atoms_of(client, session, "L", range(1, 20))
    for atoms in (first, second):
        revision = client.get(base).json()["structure"]["revision"]
        # The example's rigid groups hold saved shapes: re-marking them is confirmed against the revision.
        marked = client.post(
            f"{base}/internal-coords",
            json={"atom_indices": atoms, "enabled": True, "group_id": 7, "allow_target_discard": True, "expected_revision": revision},
        )
        assert marked.status_code == 200, marked.text
        cleared = client.post(f"{base}/internal-coords/clear-targets", json={"atom_indices": atoms})
        assert cleared.status_code == 200, cleared.text
    groups = client.get(f"{base}/annotations/coordinate_group").json()["annotation"]
    assert {v["value"] for v in groups["values"]} >= {7}
    seven = next(v for v in groups["values"] if v["value"] == 7)
    assert seven["count"] > 0
    assert client.get(base).json()["structure"]["undo_depth"] == depth + 4


def test_import_options_hold_everything_and_keep_unresolved() -> None:
    client = TestClient(app)
    text = (FIXTURES / "minimal_multichain.cif").read_bytes()
    plain = client.post("/api/v1/sessions", files={"file": ("input.cif", text)}, data={"parse_preset": "rcsb"})
    held = client.post(
        "/api/v1/sessions",
        files={"file": ("input.cif", text)},
        data={"parse_preset": "rcsb", "keep_unresolved": "false", "fix_all": "true"},
    )
    assert plain.status_code == 200 and held.status_code == 200, held.text
    counts = held.json()["structure"]["condition_counts"]
    assert counts.get("coordinate", 0) > 0 and counts.get("sequence", 0) > 0
    assert held.json()["structure"]["undo_depth"] == 0 and held.json()["structure"]["revision"] == 0
    assert plain.json()["structure"]["condition_counts"].get("coordinate", 0) == 0


def test_session_files_keep_sources_and_origins(tmp_path) -> None:
    store = DocumentStore(tmp_path, condition_provider=condition_provider, validation_provider=validation_provider)
    doc = load()
    doc.replace_with_segments(indices(doc, "A", range(40, 46)), 3, 5)
    expected = doc.segment_origin(segments(doc, "A")[0])
    session = store.add(doc)
    again = DocumentStore(tmp_path, condition_provider=condition_provider, validation_provider=validation_provider)
    reloaded = again.get(session)
    assert reloaded is not doc
    assert plan_of(reloaded, "A") == [("kept", 20, 39), ("new", 3, 5), ("kept", 46, 159)]
    assert reloaded.segment_origin(segments(reloaded, "A")[0]) == expected
    reloaded.restore_segment(segments(reloaded, "A")[0])
    assert plan_of(reloaded, "A") == [("kept", 20, 159)]
