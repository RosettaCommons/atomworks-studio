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

import pytest
from design_card_jobs import JOBS, RCSB
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
    """POST /sessions with the rcsb preparation, the assembly and `keep_unresolved`, against `createStudioDocWithCcd`."""
    open_options = {**RCSB, "keep_unresolved": keep_unresolved, **{k: v for k, v in ENTRIES[entry].items() if v}}
    job = {"documents": {"main": {"entry": entry, "name": entry, "open": open_options}}, "ops": []}
    problems = compare(job, tmp_path, skip_open=entry == "5O45")
    assert not problems, "\n".join(problems[:20])
