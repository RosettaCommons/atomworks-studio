"""The Python Studio server against the page's in-browser engine, for everything the design card does.

The RFD4-Proteina page serves Studio's REST API itself (`web/studio-api.js`, `StudioDoc`); the design card is written
against that engine, so a Space running this server must behave the same way. These tests run the card's recipes at the
operation level through both engines and compare atom order, chain names, residue numbers and names, coordinates, bonds
between residues and to new residues, the conditions the card reads, plans, origins and previews.

They need node and a checkout of the page (`RFD4P_PAGE_DIR=/path/to/rfd4-proteina-webgpu`), and the RCSB entries the
recipes open (cached copies are looked up first: `STUDIO_PARITY_CIF_DIR`, `tests/fixtures/rcsb`, the temp directory;
otherwise they are downloaded once); each test skips when something is missing.

Known differences, left alone because they come from AtomWorks or the RFD4 provider rather than from the card's
operations: atom order inside a nonstandard residue (5O45's CCS), the N-terminal H1/H3 of an NMR entry (AtomWorks drops
them), the index groups the RFD4 provider assigns, and the page's engine counting a new-residue placeholder as
sequence-conditioned.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from design_card_jobs import JOBS, LABEL_JOBS, RCSB, ligand_cif
from design_card_support import (
    EntryUnavailableError,
    compare_runs,
    materialize,
    node_available,
    page_dir,
    run_job,
    run_js_job,
)

pytestmark = pytest.mark.skipif(
    not node_available() or page_dir() is None,
    reason="needs node and RFD4P_PAGE_DIR (a checkout of the RFD4-Proteina page)",
)

# 5O45's chain B has a nonstandard residue whose atoms AtomWorks orders by its CCD entry: not compared as opened.
SKIP_OPEN = {"protein_binder"}

ENTRIES = {
    "5O45": {"drop_names": []},
    "1J79": {},
    "1N8Z": {},
    "4Z18": {},
    "3EAK": {},
    "2KL8": {"drop_names": ["H1", "H3"]},
    "1QJG": {"drop_names": ["H1", "H3"]},
    "1XVA": {},
}


def compare(job: dict, tmp_path, *, skip_open: bool = False) -> list[str]:
    try:
        job = materialize(job)
    except EntryUnavailableError as error:
        pytest.skip(f"RCSB entry not available: {error}")
    return compare_runs(run_job(job), run_js_job(job, tmp_path), skip_open=skip_open)


@pytest.mark.parametrize("name", sorted(JOBS))
def test_card_recipe_matches_the_page_engine(name, tmp_path):
    problems = compare(JOBS[name](), tmp_path, skip_open=name in SKIP_OPEN)
    assert not problems, "\n".join(problems[:20])


@pytest.mark.parametrize("keep_unresolved", [True, False])
@pytest.mark.parametrize("entry", sorted(ENTRIES))
def test_entry_opens_as_the_page_opens_it(entry, keep_unresolved, tmp_path):
    """POST /sessions with the rcsb preparation, assembly and `keep_unresolved`, against the page's opening."""
    open_options = {**RCSB, "keep_unresolved": keep_unresolved, **{k: v for k, v in ENTRIES[entry].items() if v}}
    job = {"documents": {"main": {"entry": entry, "name": entry, "open": open_options}}, "ops": []}
    problems = compare(job, tmp_path, skip_open=entry == "5O45")
    assert not problems, "\n".join(problems[:20])


FIXTURES = Path(__file__).parent / "fixtures"


# -- chain labels ---------------------------------------------------------------------------------------------------
def with_ligand_file(job: dict, tmp_path) -> dict:
    path = tmp_path / "ligand.cif"
    path.write_text(ligand_cif())
    return {
        **job,
        "documents": {
            key: {**spec, "path": str(path)} if spec.get("path") == "<ligand>" else spec
            for key, spec in job["documents"].items()
        },
    }


def label_problems(run: dict) -> list[str]:
    """What the server shows as chain names, against the CIF it writes: the same names after every step."""
    problems = []
    for k, step in enumerate(run["steps"]):
        summary = step["state"]["summary"]
        cif = summary["cif_chains"]
        shown = summary["chain_ids"]
        where = f"step {k} ({step['op']}): "
        if cif["label_asym_id"] != cif["auth_asym_id"]:
            problems.append(
                f"{where}the CIF's label_asym_id {cif['label_asym_id']} != auth_asym_id {cif['auth_asym_id']}"
            )
        if shown != sorted(cif["label_asym_id"]):
            problems.append(f"{where}summary.chain_ids {shown} != the CIF's chains {sorted(cif['label_asym_id'])}")
        sequence = [c["chain_id"] for c in summary["sequence"]]
        if sorted(set(sequence)) != shown or len(sequence) != len(set(sequence)):
            problems.append(f"{where}sequence chains {sequence} != summary.chain_ids {shown}")
        if summary["next_chain_id"] in shown:
            problems.append(f"{where}next_chain_id {summary['next_chain_id']} is taken")
    return problems


@pytest.mark.parametrize("name", sorted(LABEL_JOBS))
def test_chain_labels_match_the_page_engine_and_the_cif(name, tmp_path):
    """Summary chain ids, the sequence bar's chain ids and next_chain_id, step by step, against the page's engine."""
    job = with_ligand_file(LABEL_JOBS[name](), tmp_path)
    try:
        job = materialize(job)
    except EntryUnavailableError as error:
        pytest.skip(f"RCSB entry not available: {error}")
    py = run_job(job)
    problems = compare_runs(py, run_js_job(job, tmp_path)) + label_problems(py)
    assert not problems, "\n".join(problems[:20])


@pytest.mark.parametrize("name", ["protein_binder", "small_molecule_binder", "enzyme"])
def test_card_recipe_labels_are_the_cifs(name, tmp_path):
    try:
        job = materialize(JOBS[name]())
    except EntryUnavailableError as error:
        pytest.skip(f"RCSB entry not available: {error}")
    problems = label_problems(run_job(job))
    assert not problems, "\n".join(problems[:20])


def test_enzyme_chains_are_named_as_the_card_shows_them():
    """1J79's chains A, C and E renamed A, B and C: the sequence bar says so, not `A_1`, `B_1`, `C_1`."""
    try:
        job = materialize(JOBS["enzyme"]())
    except EntryUnavailableError as error:
        pytest.skip(f"RCSB entry not available: {error}")
    steps = run_job(job)["steps"]
    summaries = [s["state"]["summary"] for s in steps]
    assert summaries[0]["chain_ids"] == list("ABCDEFGHI")
    assert [c["chain_id"] for c in summaries[0]["sequence"]] == list("ABCDEFGHI")
    renamed = next(s for step, s in zip(steps, summaries, strict=True) if step["op"] == "order")
    assert renamed["chain_ids"] == ["A", "B", "C"]
    assert [c["chain_id"] for c in renamed["sequence"]] == ["A", "C", "B"]
    assert renamed["next_chain_id"] == "D"


def test_single_chain_and_ligand_only_documents_are_labelled_by_their_chain(tmp_path):
    from design_card_support import open_document

    from_file = open_document({"path": str(FIXTURES / "inverse_folding_2kl8.cif")})
    assert from_file.summary()["chain_ids"] == ["A"]
    assert [c["chain_id"] for c in from_file.summary()["sequence"]] == ["A"]
    path = tmp_path / "ligand.cif"
    path.write_text(ligand_cif())
    ligand = open_document({"path": str(path)})
    summary = ligand.summary()
    assert summary["chain_ids"] == ["L"]
    assert [c["chain_id"] for c in summary["sequence"]] == ["L"]
    assert ligand.atom_label(0).startswith("L/")
    info = ligand.atom_annotation_details(0)
    assert (info["chain"], info["chain_id"], info["chain_iid"]) == ("L", "L", "L_1")
    assert ligand.chain_centroids("chain_centroid")[0]["chain"] == "L"
