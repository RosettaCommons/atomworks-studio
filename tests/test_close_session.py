"""Closing removes the document, its snapshot, and access through old session links."""

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Event

import pytest
from annotation_studio import main
from annotation_studio.core import StudioDocument
from annotation_studio.identity import reset_current_owner, set_current_owner
from annotation_studio.main import DocumentStore, SessionNotFoundError
from fastapi.testclient import TestClient

FIXTURE = Path(__file__).parent / "fixtures" / "minimal_multichain.cif"


@pytest.mark.parametrize("persistent", [False, True])
@pytest.mark.parametrize("prefix", ["/api", "/api/v1"])
def test_close_removes_session_and_snapshot(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, persistent: bool, prefix: str
) -> None:
    documents = DocumentStore(tmp_path if persistent else None)
    monkeypatch.setattr(main, "store", documents)
    client = TestClient(main.app)
    session_id = documents.add(StudioDocument.from_cif(FIXTURE.read_text()))
    other_id = documents.add(StudioDocument.from_cif(FIXTURE.read_text()))
    assert client.delete(f"{prefix}/sessions/{session_id}").status_code == 204
    for suffix in ["", "/cif"]:
        assert client.get(f"{prefix}/sessions/{session_id}{suffix}").status_code == 404
    assert client.post(f"{prefix}/sessions/{session_id}/undo").status_code == 404
    assert client.delete(f"{prefix}/sessions/{session_id}").status_code == 404
    assert client.get(f"{prefix}/sessions/{other_id}").status_code == 200
    assert not (tmp_path / f"{session_id}.session").exists()
    with pytest.raises(SessionNotFoundError):
        DocumentStore(tmp_path).call(session_id, lambda document: document.summary())


def test_close_requires_owner_even_after_restart(tmp_path: Path) -> None:
    owner = set_current_owner("alice")
    try:
        documents = DocumentStore(tmp_path)
        session_id = documents.add(StudioDocument.from_cif(FIXTURE.read_text()))
    finally:
        reset_current_owner(owner)
    documents = DocumentStore(tmp_path)
    owner = set_current_owner("bob")
    try:
        with pytest.raises(SessionNotFoundError):
            documents.delete(session_id)
        assert (tmp_path / f"{session_id}.session").exists()
    finally:
        reset_current_owner(owner)
    owner = set_current_owner("alice")
    try:
        documents.delete(session_id)
        assert not (tmp_path / f"{session_id}.session").exists()
    finally:
        reset_current_owner(owner)


def test_inflight_mutation_cannot_restore_closed_session(tmp_path: Path) -> None:
    documents = DocumentStore(tmp_path)
    session_id = documents.add(StudioDocument.from_cif(FIXTURE.read_text()))
    started, finish = Event(), Event()

    def mutate(document: StudioDocument) -> None:
        started.set()
        assert finish.wait(5)
        document.name = "updated before close"

    with ThreadPoolExecutor(max_workers=2) as pool:
        mutation = pool.submit(documents.call, session_id, mutate, persist=True)
        assert started.wait(5)
        closing = pool.submit(documents.delete, session_id)
        finish.set()
        mutation.result(timeout=5)
        closing.result(timeout=5)
    assert not (tmp_path / f"{session_id}.session").exists()
    with pytest.raises(SessionNotFoundError):
        documents.call(session_id, lambda document: document.summary(), persist=True)
