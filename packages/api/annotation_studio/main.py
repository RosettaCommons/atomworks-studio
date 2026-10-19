"""FastAPI surface for the exact native AtomWorks editor core."""

from __future__ import annotations

import json
import logging
import os
import re
import secrets
import time
from collections.abc import Awaitable, Callable
from importlib.resources import files
from io import StringIO
from pathlib import Path
from threading import RLock
from typing import Any, Literal
from urllib.parse import urlencode

from atomworks_studio_editing.contracts import DocumentRevisionConflictError, TargetDiscardConfirmationRequiredError
from atomworks_studio_editing.layout import EDITOR_TABS
from atomworks_studio_editing.loading import inspect_import, load_options_schema
from atomworks_studio_editing.providers import load_providers
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse, PlainTextResponse, Response
from fastapi.routing import APIRoute
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator, model_validator

from .contracts import (
    NEUTRAL_VALIDATION_PROVIDER,
    CapacityExceededError,
    ConditionProvider,
    SessionNotFoundError,
    ValidationProvider,
)
from .core import BOND_TYPES, INTERACTION_TYPES, StudioDocument
from .identity import current_owner, reset_current_owner, set_current_owner
from .version import __version__

LOGGER = logging.getLogger("atomworks_studio")

MAX_UPLOAD_BYTES = 32 * 1024 * 1024
MAX_SESSIONS = 64
SESSION_TTL_SECONDS = 2 * 60 * 60
SESSION_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{20,64}$")
IDENTITY_HEADER = os.environ.get("ANNOTATION_STUDIO_IDENTITY_HEADER")
if IDENTITY_HEADER and os.environ.get("ANNOTATION_STUDIO_TRUST_PROXY_IDENTITY") != "1":
    raise RuntimeError(
        "ANNOTATION_STUDIO_IDENTITY_HEADER requires ANNOTATION_STUDIO_TRUST_PROXY_IDENTITY=1; "
        "the proxy must strip client-supplied identity headers"
    )


class DocumentStore:
    """Bounded in-memory documents with optional restart-safe CIF snapshots."""

    def __init__(
        self,
        session_dir: Path | None = None,
        *,
        condition_provider: ConditionProvider | None = None,
        validation_provider: ValidationProvider | None = None,
    ) -> None:
        self._documents: dict[str, tuple[float, str, StudioDocument]] = {}
        self._document_locks: dict[str, RLock] = {}
        self._lock = RLock()
        self._session_dir = session_dir
        from atomworks_studio_editing.conditions import CONDITION_PROVIDER

        self._condition_provider = condition_provider if condition_provider is not None else CONDITION_PROVIDER
        self._validation_provider = validation_provider or NEUTRAL_VALIDATION_PROVIDER
        if self._session_dir is not None:
            self._session_dir.mkdir(parents=True, exist_ok=True)
            for stale_temporary in self._session_dir.glob(".*.tmp"):
                stale_temporary.unlink(missing_ok=True)
            probe = self._session_dir / f".write-probe-{os.getpid()}"
            probe.write_text("ok", encoding="utf-8")
            probe.unlink()

    @property
    def persistent(self) -> bool:
        return self._session_dir is not None

    def _session_file(self, session_id: str) -> Path | None:
        if self._session_dir is None or SESSION_ID_PATTERN.fullmatch(session_id) is None:
            return None
        return self._session_dir / f"{session_id}.session"

    def _forget(self, session_id: str, *, delete_file: bool) -> None:
        self._documents.pop(session_id, None)
        self._document_locks.pop(session_id, None)
        if delete_file and (path := self._session_file(session_id)) is not None:
            path.unlink(missing_ok=True)

    def _prune(self, *, reserve_slot: bool = False) -> None:
        memory_cutoff = time.monotonic() - SESSION_TTL_SECONDS
        for session_id, (used, _, _) in list(self._documents.items()):
            if used < memory_cutoff:
                self._forget(session_id, delete_file=self._session_dir is None)

        if self._session_dir is not None:
            file_cutoff = time.time() - SESSION_TTL_SECONDS
            files = list(self._session_dir.glob("*.session"))
            for path in files:
                if path.stat().st_mtime < file_cutoff:
                    self._forget(path.stem, delete_file=True)
            files = sorted(self._session_dir.glob("*.session"), key=lambda path: path.stat().st_mtime)
            limit = MAX_SESSIONS - 1 if reserve_slot else MAX_SESSIONS
            while len(files) > limit:
                oldest = files.pop(0)
                self._forget(oldest.stem, delete_file=True)
            return

        limit = MAX_SESSIONS - 1 if reserve_slot else MAX_SESSIONS
        while len(self._documents) > limit:
            oldest = min(self._documents, key=lambda key: self._documents[key][0])
            self._forget(oldest, delete_file=False)

    def _persist(self, session_id: str, document: StudioDocument) -> None:
        path = self._session_file(session_id)
        if path is None:
            return
        metadata = json.dumps(
            {"name": document.name, "owner_id": current_owner()},
            separators=(",", ":"),
        )
        temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
        with temporary.open("w", encoding="utf-8") as output:
            output.write(f"{metadata}\n{document.to_cif()}")
            output.flush()
            os.fsync(output.fileno())
        temporary.chmod(0o600)
        temporary.replace(path)

    def _load(self, session_id: str) -> tuple[str, StudioDocument] | None:
        path = self._session_file(session_id)
        if path is None or not path.is_file():
            return None
        try:
            metadata_text, cif = path.read_text(encoding="utf-8").split("\n", 1)
            metadata = json.loads(metadata_text)
            return (
                str(metadata.get("owner_id", "local")),
                StudioDocument.from_cif(
                    cif,
                    str(metadata.get("name", "structure")),
                    condition_provider=self._condition_provider,
                    validation_provider=self._validation_provider,
                ),
            )
        except (IndexError, KeyError, OSError, ValueError):
            path.unlink(missing_ok=True)
            return None

    def add(self, document: StudioDocument) -> str:
        with self._lock:
            self._prune(reserve_slot=True)
            session_id = secrets.token_urlsafe(24)
            self._documents[session_id] = (time.monotonic(), current_owner(), document)
            self._document_locks[session_id] = RLock()
            self._persist(session_id, document)
            return session_id

    def get(self, session_id: str) -> StudioDocument:
        with self._lock:
            self._prune()
            entry = self._documents.get(session_id)
            if entry is None:
                loaded = self._load(session_id)
                if loaded is None:
                    raise KeyError(session_id)
                owner_id, document = loaded
                entry = (time.monotonic(), owner_id, document)
                self._document_locks[session_id] = RLock()
            if entry[1] != current_owner():
                raise KeyError(session_id)
            self._documents[session_id] = (time.monotonic(), entry[1], entry[2])
            if (path := self._session_file(session_id)) is not None:
                path.touch()
            return entry[2]

    def call[T](
        self,
        session_id: str,
        operation: Callable[[StudioDocument], T],
        *,
        persist: bool = False,
    ) -> T:
        with self._lock:
            try:
                document = self.get(session_id)
            except KeyError:
                raise SessionNotFoundError(session_id) from None
            document_lock = self._document_locks[session_id]
        with document_lock:
            with self._lock:
                if self._documents.get(session_id, (None, None, None))[2] is not document:
                    raise SessionNotFoundError(session_id)
            result = operation(document)
            if persist:
                self._persist(session_id, document)
            return result

    def delete(self, session_id: str) -> None:
        """Remove an owned document and snapshot after any active operation finishes."""

        def remove(_document: StudioDocument) -> None:
            with self._lock:
                if (path := self._session_file(session_id)) is not None:
                    path.unlink(missing_ok=True)
                self._forget(session_id, delete_file=False)

        self.call(session_id, remove)


session_dir_value = os.environ.get("ANNOTATION_STUDIO_SESSION_DIR")
providers = load_providers()
condition_provider = providers.condition_provider
validation_provider = providers.validation_provider
condition_operations = providers.condition_operations
store = DocumentStore(
    Path(session_dir_value) if session_dir_value else None,
    condition_provider=condition_provider,
    validation_provider=validation_provider,
)
app = FastAPI(title="AtomWorks Studio", version=__version__)


@app.middleware("http")
async def security_headers(
    request: Request,
    call_next: Callable[[Request], Awaitable[Response]],
) -> Response:
    started = time.monotonic()
    owner_id = "local"
    protected_api = request.url.path.startswith("/api/") and request.url.path not in {
        "/api/health",
        "/api/metrics",
        "/api/ready",
        "/api/v1/health",
        "/api/v1/metrics",
        "/api/v1/ready",
    }
    rejection: Response | None = None
    if IDENTITY_HEADER and protected_api:
        owner_id = request.headers.get(IDENTITY_HEADER, "").strip()
        if not owner_id:
            rejection = JSONResponse(status_code=401, content={"detail": "authenticated user identity is required"})
        elif len(owner_id) > 256 or any(ord(character) < 32 for character in owner_id):
            rejection = JSONResponse(status_code=400, content={"detail": "invalid authenticated user identity"})
    owner_token = set_current_owner(owner_id)
    request_id = request.headers.get("X-Request-ID", "")
    if re.fullmatch(r"[A-Za-z0-9._-]{8,64}", request_id) is None:
        request_id = secrets.token_hex(12)
    try:
        response = rejection or await call_next(request)
    finally:
        reset_current_owner(owner_token)
    response.headers["X-Request-ID"] = request_id
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    elif request.url.path.startswith("/assets/"):
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    else:
        response.headers.setdefault("Cache-Control", "no-cache")
    frame_ancestors = os.environ.get("ANNOTATION_STUDIO_FRAME_ANCESTORS", "'self'")
    response.headers["Content-Security-Policy"] = f"frame-ancestors {frame_ancestors}"
    route = request.scope.get("route")
    LOGGER.info(
        json.dumps(
            {
                "event": "http_request",
                "request_id": request_id,
                "method": request.method,
                "route": getattr(route, "path", "unmatched"),
                "status": response.status_code,
                "duration_ms": round((time.monotonic() - started) * 1000, 2),
            },
            separators=(",", ":"),
        )
    )
    return response


def _session_response(session_id: str, structure: dict) -> dict:
    query = urlencode({"session": session_id, "embed": "1"})
    return {"session_id": session_id, "editor_path": f"/?{query}", "structure": structure}


class SelectionRequest(BaseModel):
    atom_indices: list[int] = Field(min_length=1, max_length=100_000)

    @field_validator("atom_indices")
    @classmethod
    def unique_indices(cls, value: list[int]) -> list[int]:
        if any(index < 0 for index in value):
            raise ValueError("atom indices must be non-negative")
        return sorted(set(value))


class ScopedSelectionRequest(SelectionRequest):
    scope: Literal["atom", "residue", "chain"] = "atom"


class ConfirmableSelectionRequest(ScopedSelectionRequest):
    allow_target_discard: bool = False
    expected_revision: int | None = Field(default=None, ge=0)

    @model_validator(mode="after")
    def confirmation_has_revision(self):
        if self.allow_target_discard and self.expected_revision is None:
            raise ValueError("Confirming target loss requires the preview's expected_revision")
        return self


class ResetConditionsRequest(BaseModel):
    expected_revision: int = Field(ge=0)


class ConditionMutation(ConfirmableSelectionRequest):
    condition: str
    enabled: bool = True
    value: int | float | str | list[float] | None = None

    @field_validator("condition")
    @classmethod
    def valid_condition(cls, value: str) -> str:
        if value not in condition_provider.definitions_by_name:
            raise ValueError(f"unsupported condition: {value}")
        return value

    @field_validator("value", mode="before")
    @classmethod
    def strict_condition_value(cls, value: object, info: Any) -> object:
        definition = condition_provider.definitions_by_name.get(info.data.get("condition", ""))
        if definition is not None and definition.kind == "text" and isinstance(value, str):
            return value
        values = value if isinstance(value, list) else [value]
        if value is not None and any(isinstance(item, bool) or not isinstance(item, int | float) for item in values):
            raise ValueError("condition value must contain only JSON numbers")
        return value


class SelectionResolve(ScopedSelectionRequest):
    pass


class ConditionOperationMutation(ConfirmableSelectionRequest):
    enabled: bool = True


class GroupMutation(ConfirmableSelectionRequest):
    atom_indices: list[int] = Field(default_factory=list, max_length=1000000)
    condition: str
    action: Literal["new", "add", "remove", "delete"]
    group_id: int | None = Field(default=None, strict=True)


class CentroidMutation(BaseModel):
    condition: str
    chain: str
    value: list[float] | None = None
    expected_revision: int = Field(ge=0)


class RestraintsReplacement(BaseModel):
    pairs: list[tuple[int, int]]
    values: list[float]
    expected_revision: int = Field(ge=0)


class ExportResponse(BaseModel):
    cif: str
    name: str
    revision: int
    issues: list[dict[str, str]]


class SelectionQuery(BaseModel):
    expression: str = Field(min_length=1, max_length=4096)
    syntax: Literal["expression", "path"] = "expression"
    scope: Literal["atom", "residue", "chain"] = "atom"


class ProtonationRequest(BaseModel):
    ph: float = Field(default=7.4, ge=0, le=14, allow_inf_nan=False)


class ChargeMutation(SelectionRequest):
    value: int | None = Field(default=None, ge=-10, le=10)
    delta: int | None = Field(default=None, ge=-10, le=10)


class ChainMutation(SelectionRequest):
    chain_id: str = Field(min_length=1, max_length=8)


class BondMutation(BaseModel):
    atom1: int = Field(ge=0)
    atom2: int = Field(ge=0)
    action: Literal["add", "remove"]
    bond_type: str = "SINGLE"

    @field_validator("bond_type")
    @classmethod
    def valid_bond_type(cls, value: str) -> str:
        value = value.upper()
        if value not in BOND_TYPES:
            raise ValueError(f"unsupported bond type: {value}")
        return value


class DistanceRestraintMutation(BaseModel):
    atom1: int = Field(ge=0)
    atom2: int = Field(ge=0)
    action: Literal["set", "remove"] = "set"
    distance: float | None = Field(default=None, gt=0, le=1000)

    @field_validator("distance")
    @classmethod
    def distance_required_for_set(cls, value: float | None, info: Any) -> float | None:
        if info.data.get("action", "set") == "set" and value is None:
            raise ValueError("distance is required when action is set")
        return value


class InteractionAnalysisRequest(BaseModel):
    interaction_types: list[
        Literal[
            "hbond",
            "hydrophobic",
            "pi",
            "salt",
            "halogen",
            "metal",
            "pistacking",
            "pication",
            "saltbridge",
        ]
    ] = Field(
        default_factory=lambda: ["hbond", "hydrophobic", "pi", "salt", "halogen", "metal"],
        min_length=1,
        max_length=9,
    )
    hbond_model: Literal["rosetta", "plip"] = "rosetta"
    inter_chain_only: bool = True
    source_atom_indices: list[int] = Field(default_factory=list, max_length=100_000)
    target_atom_indices: list[int] = Field(default_factory=list, max_length=100_000)

    @field_validator("interaction_types")
    @classmethod
    def unique_interaction_types(cls, value: list[str]) -> list[str]:
        if len(value) != len(set(value)):
            raise ValueError("interaction types must be unique")
        return value

    @field_validator("source_atom_indices", "target_atom_indices")
    @classmethod
    def valid_filter_indices(cls, value: list[int]) -> list[int]:
        if any(index < 0 for index in value):
            raise ValueError("atom indices must be non-negative")
        return sorted(set(value))


class DeleteMutation(SelectionRequest):
    close_residue_gaps: bool = False


class SegmentMutation(BaseModel):
    minimum: int = Field(ge=1, le=10_000)
    maximum: int = Field(ge=1, le=10_000)
    atom_index: int | None = Field(default=None, ge=0)
    before: bool = True
    new_chain: bool = False
    chain_id: str | None = Field(default=None, max_length=8)
    chain_type: str | None = None


class RealizeMutation(BaseModel):
    seed: int | None = None


class CombineMutation(BaseModel):
    session_ids: list[str] = Field(min_length=1, max_length=16)


def _call[T](
    session_id: str,
    operation: Callable[[StudioDocument], T],
    *,
    persist: bool = False,
) -> T:
    try:
        return store.call(session_id, operation, persist=persist)
    except SessionNotFoundError:
        raise HTTPException(status_code=404, detail="session not found or expired") from None


def _apply(session_id: str, operation: Callable[[StudioDocument], Any]) -> dict:
    try:
        previous_revision, result, structure = _call(
            session_id,
            lambda document: (document.revision, operation(document), document.summary()),
            persist=True,
        )
    except TargetDiscardConfirmationRequiredError as error:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "target_discard_confirmation_required",
                "lost_target_count": error.lost_target_count,
                "revision": error.revision,
                "message": str(error),
            },
        ) from error
    except DocumentRevisionConflictError as error:
        raise HTTPException(
            status_code=409,
            detail={"code": "revision_conflict", "revision": error.revision, "message": str(error)},
        ) from error
    except (ValueError, IndexError, KeyError) as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    return {
        **_session_response(session_id, structure),
        "edit_result": {
            **(result if isinstance(result, dict) else {}),
            "changed": structure["revision"] != previous_revision,
        },
    }


EXAMPLES_DIR = Path(__file__).parent / "examples"
EXAMPLES = json.loads((EXAMPLES_DIR / "examples.json").read_text())


@app.get("/api/examples")
def list_examples() -> list[dict[str, str]]:
    """Return the catalog shared by Studio and model-hosting integrations."""
    return EXAMPLES


@app.get("/api/examples/{example_id}/cif", response_class=PlainTextResponse)
def example_cif(example_id: str) -> str:
    """Read only a named, bundled example; arbitrary paths are not accepted."""
    example = next((item for item in EXAMPLES if item["id"] == example_id), None)
    if example is None:
        raise HTTPException(status_code=404, detail="Unknown example")
    return (EXAMPLES_DIR / example["file"]).read_text()


@app.get("/api/health")
def health() -> dict[str, str]:
    return {
        "status": "ok",
        "version": os.environ.get("ANNOTATION_STUDIO_VERSION", __version__),
        "revision": os.environ.get("ANNOTATION_STUDIO_REVISION", "unknown"),
        "session_store": "persistent" if store.persistent else "memory",
    }


@app.get("/api/ready")
def ready() -> dict[str, str]:
    return {"status": "ready"}


@app.get("/api/schema")
def schema() -> dict:
    return {
        "conditions": {
            definition.key: definition.schema for definition in condition_provider.definitions if definition.visible
        },
        "bond_types": list(BOND_TYPES),
        "document_operations": ["reset_conditions"],
        "editor_tabs": [{"id": key, "label": label} for key, label in EDITOR_TABS],
        "loading": load_options_schema(),
    }


@app.post("/api/import/inspect")
async def inspect_uploaded_import(file: UploadFile = File(...)) -> dict:
    content = await file.read(MAX_UPLOAD_BYTES + 1)
    await file.close()
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail=f"upload exceeds {MAX_UPLOAD_BYTES // 1024 // 1024} MiB")
    try:
        return inspect_import(StringIO(content.decode("utf-8")), file_type="cif")
    except Exception as error:
        raise HTTPException(status_code=422, detail=f"Cannot inspect CIF: {error}") from error


@app.post("/api/sessions")
async def create_session(
    file: UploadFile = File(...),
    parse_preset: Literal["minimal", "rcsb"] = Form("minimal"),
    assembly: str = Form("1"),
    model: int | None = Form(None),
    remove_waters: bool | None = Form(None),
    hydrogen_policy: Literal["keep", "remove"] | None = Form(None),
    advanced_options: str = Form("{}"),
) -> dict:
    filename = Path(file.filename or "structure.cif").name
    if not filename.lower().endswith((".cif", ".mmcif")):
        raise HTTPException(status_code=415, detail="only CIF/mmCIF uploads are accepted")
    content = await file.read(MAX_UPLOAD_BYTES + 1)
    await file.close()
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail=f"upload exceeds {MAX_UPLOAD_BYTES // 1024 // 1024} MiB")
    try:
        text = content.decode("utf-8")
        document = StudioDocument.from_cif(
            text,
            Path(filename).stem,
            parse_options={
                "preset": parse_preset,
                "assembly": assembly,
                "model": model,
                "remove_waters": remove_waters,
                "hydrogen_policy": hydrogen_policy,
                "advanced_options": json.loads(advanced_options),
            },
            condition_provider=condition_provider,
            validation_provider=validation_provider,
        )
    except Exception as error:
        raise HTTPException(status_code=422, detail=f"invalid annotated CIF: {error}") from error
    try:
        session_id = store.add(document)
    except CapacityExceededError as error:
        raise HTTPException(status_code=429, detail=str(error)) from error
    return _session_response(session_id, document.summary())


@app.get("/api/sessions/{session_id}")
def get_session(session_id: str) -> dict:
    return _session_response(session_id, _call(session_id, lambda document: document.summary()))


@app.delete("/api/sessions/{session_id}", status_code=204)
def delete_session(session_id: str) -> Response:
    try:
        store.delete(session_id)
    except SessionNotFoundError:
        raise HTTPException(status_code=404, detail="session not found or expired") from None
    return Response(status_code=204)


@app.get("/api/sessions/{session_id}/annotations/{condition}")
def get_annotation(session_id: str, condition: str) -> dict:
    try:
        details = _call(session_id, lambda document: document.annotation_details(condition))
    except KeyError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    return {"annotation": details[0] if details else None}


@app.get("/api/sessions/{session_id}/annotation-fields/{field_name}")
def get_annotation_field(session_id: str, field_name: str) -> dict:
    details = _call(session_id, lambda document: document.stored_annotation_fields(field_name))
    if not details:
        raise HTTPException(status_code=404, detail=f"annotation field not found: {field_name}")
    return {"annotation": details[0]}


@app.get("/api/sessions/{session_id}/scalar-fields/{field_name}")
def get_scalar_field(session_id: str, field_name: str) -> dict:
    details = _call(session_id, lambda document: document.scalar_annotation_fields(field_name))
    if not details:
        raise HTTPException(status_code=404, detail=f"scalar field not found: {field_name}")
    return {"annotation": details[0]}


@app.get("/api/sessions/{session_id}/atoms/{atom_index}/annotations")
def get_atom_annotations(session_id: str, atom_index: int) -> dict:
    try:
        return _call(session_id, lambda document: document.atom_annotation_details(atom_index))
    except IndexError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


@app.post("/api/sessions/{session_id}/interactions/analyze")
def analyze_interactions(session_id: str, request: InteractionAnalysisRequest) -> dict:
    expanded_types: list[str] = []
    for interaction_type in request.interaction_types:
        expanded_types.extend(
            {
                "pi": ["pistacking", "pication"],
                "salt": ["saltbridge"],
            }.get(interaction_type, [interaction_type])
        )
    interaction_types = tuple(dict.fromkeys(expanded_types))
    if not set(interaction_types) <= set(INTERACTION_TYPES):
        raise HTTPException(status_code=422, detail="unsupported interaction type")
    try:
        return _call(
            session_id,
            lambda document: document.analyze_interactions(
                interaction_types=interaction_types,
                hbond_model=request.hbond_model,
                inter_chain_only=request.inter_chain_only,
                source_atom_indices=tuple(request.source_atom_indices),
                target_atom_indices=tuple(request.target_atom_indices),
            ),
        )
    except (IndexError, ValueError) as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@app.post("/api/sessions/{session_id}/selections/resolve")
def resolve_selection(session_id: str, selection: SelectionResolve) -> dict:
    try:
        indices = _call(
            session_id,
            lambda document: document.resolve_indices(selection.atom_indices, selection.scope),
        )
    except (ValueError, IndexError) as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    return {"atom_indices": indices.tolist(), "count": len(indices)}


@app.post("/api/sessions/{session_id}/selections/query")
def query_selection(session_id: str, selection: SelectionQuery) -> dict:
    try:
        indices = _call(
            session_id,
            lambda document: document.query_indices(
                selection.expression,
                syntax=selection.syntax,
                scope=selection.scope,
            ),
        )
    except (IndexError, NameError, SyntaxError, TypeError, ValueError) as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    return {"atom_indices": indices.tolist(), "count": len(indices)}


@app.get("/api/sessions/{session_id}/cif", response_class=PlainTextResponse)
def get_cif(session_id: str) -> PlainTextResponse:
    cif, name = _call(session_id, lambda document: (document.to_cif(), document.name))
    return PlainTextResponse(
        cif,
        media_type="chemical/x-mmcif",
        headers={"Content-Disposition": f'attachment; filename="{name}_annotated.cif"'},
    )


@app.post("/api/sessions/{session_id}/export")
def export_cif(session_id: str) -> ExportResponse:
    # Validate and export one snapshot. Later edits cannot change the approved file.
    document = _call(session_id, lambda current: current.clone())
    issues = document.validate(full_pipeline=True)
    return ExportResponse(cif=document.to_cif(), name=document.name, revision=document.revision, issues=issues)


@app.post("/api/sessions/{session_id}/conditions")
def set_condition(session_id: str, mutation: ConditionMutation) -> dict:
    return _apply(
        session_id,
        lambda document: document.set_condition(
            mutation.condition,
            mutation.atom_indices,
            enabled=mutation.enabled,
            value=mutation.value,
            scope=mutation.scope,
            allow_target_discard=mutation.allow_target_discard,
            expected_revision=mutation.expected_revision,
        ),
    )


@app.post("/api/sessions/{session_id}/groups")
def edit_group(session_id: str, mutation: GroupMutation) -> dict:
    return _apply(
        session_id,
        lambda document: document.edit_condition_group(
            mutation.condition,
            mutation.action,
            mutation.atom_indices,
            group_id=mutation.group_id,
            scope=mutation.scope,
            allow_target_discard=mutation.allow_target_discard,
            expected_revision=mutation.expected_revision,
        ),
    )


@app.post("/api/sessions/{session_id}/centroids")
def edit_centroid(session_id: str, mutation: CentroidMutation) -> dict:
    return _apply(
        session_id,
        lambda document: document.edit_chain_centroid(
            mutation.condition,
            mutation.chain,
            mutation.value,
            expected_revision=mutation.expected_revision,
        ),
    )


@app.post("/api/sessions/{session_id}/distance-restraints/replace")
def replace_restraints(session_id: str, mutation: RestraintsReplacement) -> dict:
    return _apply(
        session_id,
        lambda document: document.replace_distance_restraints(
            mutation.pairs,
            mutation.values,
            expected_revision=mutation.expected_revision,
        ),
    )


@app.get("/api/sessions/{session_id}/atom-distance")
def atom_distance(session_id: str, atom1: int, atom2: int) -> dict:
    def inspect(document):
        return {
            "revision": document.revision,
            "distance": document.atom_distance(atom1, atom2),
            "atom1_label": document.atom_label(atom1),
            "atom2_label": document.atom_label(atom2),
        }

    try:
        return _call(session_id, inspect)
    except (IndexError, ValueError) as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@app.post("/api/sessions/{session_id}/protonate")
def protonate(session_id: str, request: ProtonationRequest) -> dict:
    return _apply(session_id, lambda document: document.protonate(request.ph))


@app.post("/api/sessions/{session_id}/charges")
def set_charge(session_id: str, mutation: ChargeMutation) -> dict:
    return _apply(
        session_id,
        lambda document: document.set_charge(mutation.atom_indices, value=mutation.value, delta=mutation.delta),
    )


@app.post("/api/sessions/{session_id}/chains")
def assign_chain(session_id: str, mutation: ChainMutation) -> dict:
    return _apply(
        session_id,
        lambda document: document.assign_chain(mutation.atom_indices, mutation.chain_id),
    )


@app.post("/api/sessions/{session_id}/bonds")
def edit_bond(session_id: str, mutation: BondMutation) -> dict:
    return _apply(
        session_id,
        lambda document: document.edit_bond(
            mutation.atom1,
            mutation.atom2,
            mutation.action,
            mutation.bond_type,
        ),
    )


@app.get("/api/sessions/{session_id}/bonds")
def inspect_bonds(session_id: str, atom_index: int | None = None) -> dict:
    try:
        bonds = _call(session_id, lambda document: document.inspect_bonds(atom_index))
    except IndexError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    return {"bonds": bonds, "count": len(bonds)}


@app.post("/api/sessions/{session_id}/bonds/infer-ccd")
def infer_bonds_from_ccd(session_id: str) -> dict:
    return _apply(session_id, lambda document: document.infer_bonds_from_ccd())


@app.post("/api/sessions/{session_id}/internal-coords")
def set_internal_coordinates(session_id: str, mutation: ConditionOperationMutation) -> dict:
    transform = condition_operations.get("internal_coordinate")
    if transform is None:
        raise HTTPException(status_code=422, detail="internal-coordinate conditioning is not available")
    return _apply(
        session_id,
        lambda document: document.apply_selection_transform(
            mutation.atom_indices,
            mutation.scope,
            transform,
            mutation.enabled,
            allow_target_discard=mutation.allow_target_discard,
            expected_revision=mutation.expected_revision,
        ),
    )


@app.post("/api/sessions/{session_id}/internal-coords/clear-targets")
def clear_internal_targets(session_id: str, mutation: ConditionOperationMutation) -> dict:
    transform = condition_operations.get("clear_internal_targets")
    if transform is None:
        raise HTTPException(status_code=422, detail="internal-coordinate target editing is not available")
    return _apply(
        session_id,
        lambda document: document.apply_selection_transform(
            mutation.atom_indices,
            mutation.scope,
            transform,
            True,
            allow_target_discard=True,
            expected_revision=mutation.expected_revision,
        ),
    )


@app.get("/api/sessions/{session_id}/distance-restraints")
def get_distance_restraints(session_id: str) -> dict:
    restraints = _call(session_id, lambda document: document.distance_restraints())
    return {"restraints": restraints, "count": len(restraints)}


@app.post("/api/sessions/{session_id}/distance-restraints")
def edit_distance_restraint(session_id: str, mutation: DistanceRestraintMutation) -> dict:
    return _apply(
        session_id,
        lambda document: document.edit_distance_restraint(
            mutation.atom1,
            mutation.atom2,
            mutation.action,
            mutation.distance,
        ),
    )


@app.post("/api/sessions/{session_id}/delete")
def delete_atoms(session_id: str, mutation: DeleteMutation) -> dict:
    return _apply(
        session_id,
        lambda document: document.delete_atoms(mutation.atom_indices, mutation.close_residue_gaps),
    )


@app.post("/api/sessions/{session_id}/segments")
def insert_segment(session_id: str, mutation: SegmentMutation) -> dict:
    if mutation.maximum < mutation.minimum:
        raise HTTPException(status_code=422, detail="maximum must be at least minimum")
    return _apply(
        session_id,
        lambda document: document.insert_segment(
            mutation.minimum,
            mutation.maximum,
            mutation.atom_index,
            before=mutation.before,
            new_chain=mutation.new_chain,
            chain_id=mutation.chain_id,
            chain_type=mutation.chain_type,
        ),
    )


@app.post("/api/sessions/{session_id}/segments/realize")
def realize_segments(session_id: str, mutation: RealizeMutation) -> dict:
    return _apply(session_id, lambda document: document.realize_segments(mutation.seed))


@app.post("/api/sessions/{session_id}/segments/collapse")
def collapse_segments(session_id: str) -> dict:
    return _apply(session_id, lambda document: document.collapse_segments())


@app.post("/api/sessions/{session_id}/conditions/reset")
def reset_conditions(session_id: str, mutation: ResetConditionsRequest) -> dict:
    return _apply(session_id, lambda document: document.reset_conditions(expected_revision=mutation.expected_revision))


@app.post("/api/sessions/{session_id}/reset-residue-ids")
def reset_residue_ids(session_id: str) -> dict:
    return _apply(session_id, lambda document: document.reset_residue_ids())


@app.post("/api/sessions/{session_id}/undo")
def undo(session_id: str) -> dict:
    structure = _call(
        session_id,
        lambda document: document.summary() if document.undo() else None,
        persist=True,
    )
    if structure is None:
        raise HTTPException(status_code=409, detail="undo history is empty")
    return {"session_id": session_id, "structure": structure}


@app.post("/api/sessions/{session_id}/combine")
def combine(session_id: str, mutation: CombineMutation) -> dict:
    if session_id in mutation.session_ids:
        raise HTTPException(status_code=422, detail="cannot combine a session with itself")
    others = [_call(key, lambda document: document.clone()) for key in mutation.session_ids]
    return _apply(session_id, lambda document: document.combine(others))


@app.post("/api/sessions/{session_id}/validate")
def validate(session_id: str, full: bool = False) -> dict:
    return {"issues": _call(session_id, lambda document: document.validate(full_pipeline=full))}


for legacy_route in list(app.routes):
    if not isinstance(legacy_route, APIRoute) or not legacy_route.path.startswith("/api/"):
        continue
    versioned_path = "/api/v1" + legacy_route.path.removeprefix("/api")
    include_versioned_in_schema = legacy_route.include_in_schema
    legacy_route.include_in_schema = False
    app.add_api_route(
        versioned_path,
        legacy_route.endpoint,
        methods=list(legacy_route.methods or ()),
        response_model=legacy_route.response_model,
        status_code=legacy_route.status_code,
        response_class=legacy_route.response_class,
        tags=legacy_route.tags,
        name=f"v1_{legacy_route.name}",
        include_in_schema=include_versioned_in_schema,
    )


source_guide = Path(__file__).resolve().parents[3] / "docs/_build/html"
packaged_guide = Path(str(files("annotation_studio").joinpath("guide")))
guide = source_guide if source_guide.is_dir() else packaged_guide
if guide.is_dir():
    app.mount("/guide", StaticFiles(directory=str(guide), html=True), name="guide")

packaged_web = files("annotation_studio").joinpath("web")
source_web = Path(__file__).resolve().parents[2] / "web" / "dist"
web_dist = source_web if source_web.is_dir() else Path(str(packaged_web))
if web_dist.is_dir():
    app.mount("/", StaticFiles(directory=web_dist, html=True), name="studio")
