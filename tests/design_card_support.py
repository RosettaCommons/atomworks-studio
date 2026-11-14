"""Operation-level driver shared by the design-card tests: the Python twin of `tests/parity/js_engine_driver.mjs`.

A job is `{documents: {main: {path, name, open}}, ops: [...]}` (see the driver for the operations and the selector
language); `run_job` applies it to `StudioDocument`s and returns the state after every step in the driver's format.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any

import numpy as np
from atomworks_studio_editing.chain_plans import (
    display_chain_array,
    is_polymer_mask,
    is_segment_mask,
)
from atomworks_studio_editing.document import StudioDocument
from atomworks_studio_editing.providers import load_providers

DRIVER = Path(__file__).parent / "parity" / "js_engine_driver.mjs"


def providers():
    return load_providers()


def open_document(spec: dict[str, Any], **kwargs) -> StudioDocument:
    text = Path(spec["path"]).read_text()
    o = spec.get("open") or {}
    options: dict[str, Any] = {}
    if o.get("preset") == "rcsb":
        options = {"preset": "rcsb", "assembly": str(o.get("assembly", "1"))}
        if "keep_unresolved" in o:
            options["keep_unresolved"] = bool(o["keep_unresolved"])
        options["fix_all"] = bool(o.get("fix_all", True))
    p = providers()
    doc = StudioDocument.from_cif(
        text,
        spec.get("name", "structure"),
        parse_options=options,
        condition_provider=p.condition_provider,
        validation_provider=p.validation_provider,
        **kwargs,
    )
    if o.get("drop_names"):
        # AtomWorks drops the N-terminal H1/H3 of an NMR entry as not in the CCD; the page's engine keeps them.
        names = set(o["drop_names"])
        drop = [i for i, n in enumerate(doc.array.atom_name) if str(n) in names]
        if drop:
            doc.delete_atoms(drop)
        doc.clear_history()
    return doc


def _res_ranges(text: str) -> list[tuple[int, int]]:
    out = []
    for part in str(text).split(","):
        part = part.strip()
        if not part:
            continue
        m = re.fullmatch(r"(-?\d+)(?:-(-?\d+))?", part)
        if not m:
            raise ValueError(f"bad residue range {part}")
        out.append((int(m.group(1)), int(m.group(2) or m.group(1))))
    return out


def resolve(doc: StudioDocument, sel: Any) -> list[int]:
    """Atom indices a selector names, in document order (the driver's selector language)."""
    a = doc.array
    labels = display_chain_array(a)
    ins = np.asarray(a.ins_code).astype(str)
    segment = is_segment_mask(a)
    polymer = is_polymer_mask(a)
    out: set[int] = set()
    for s in sel if isinstance(sel, list) else [sel]:
        if "atoms" in s:
            out.update(int(i) for i in s["atoms"])
            continue
        chains = (
            None
            if "chain" not in s
            else {str(c) for c in (s["chain"] if isinstance(s["chain"], list) else [s["chain"]])}
        )
        ranges = _res_ranges(s["res"]) if "res" in s else None
        names = set(s["names"]) if "names" in s else None
        hits = []
        for i in range(len(a)):
            if chains is not None and labels[i] not in chains:
                continue
            if ranges is not None and not any(lo <= int(a.res_id[i]) <= hi for lo, hi in ranges):
                continue
            if names is not None and str(a.atom_name[i]) not in names:
                continue
            kind = s.get("kind")
            if kind in ("polymer", "residue") and not polymer[i]:
                continue
            if kind == "ligand" and (polymer[i] or segment[i]):
                continue
            if kind == "segment" and not segment[i]:
                continue
            hits.append(i)
        if "k" in s:
            groups: list[list[int]] = []
            last = None
            for i in hits:
                key = f"{labels[i]}:{int(a.res_id[i])}:{ins[i]}:{a.res_name[i]}"
                if key != last:
                    groups.append([])
                    last = key
                groups[-1].append(i)
            k = int(s["k"])
            group = groups[k if k >= 0 else len(groups) + k]
            out.update(group)
        else:
            out.update(hits)
    return sorted(out)


def _nanround(v: float):
    return None if not np.isfinite(v) else round(float(v), 4)


def state_of(doc: StudioDocument) -> dict[str, Any]:
    """Everything the parity test compares, in the driver's JSON shape."""
    a = doc.array
    n = len(a)
    labels = display_chain_array(a)
    ins = np.asarray(a.ins_code).astype(str)
    ins = np.where(np.isin(ins, [".", "?"]), "", ins)
    from atomworks_studio_editing.chain_plans import _src_labels

    atoms = {
        "chain": [str(x) for x in labels],
        "res_id": [int(x) for x in a.res_id],
        "ins": [str(x) for x in ins],
        "res_name": [str(x) for x in a.res_name],
        "atom_name": [str(x) for x in a.atom_name],
        "element": [str(x) for x in a.element],
        "coord": [[_nanround(v) for v in row[:3]] for row in a.coord],
        "segment": [bool(x) for x in is_segment_mask(a)],
        "polymer": [bool(x) for x in is_polymer_mask(a)],
        "src": [str(x) for x in _src_labels(a)],
    }
    from atomworks.io.utils.standard_annotations import S_SEGMAX, S_SEGMIN

    atoms["seg_min"] = [int(x) for x in S_SEGMIN.annotation(a)] if S_SEGMIN.has_annotation(a) else [-1] * n
    atoms["seg_max"] = [int(x) for x in S_SEGMAX.annotation(a)] if S_SEGMAX.has_annotation(a) else [-1] * n
    bonds = sorted(
        {tuple(sorted((int(u), int(v)))) for u, v, _t in (a.bonds.as_array() if a.bonds is not None else [])}
    )
    annotations = {}
    for entry in doc.annotation_details():
        annotations[entry["name"]] = {
            "count": entry["count"],
            "values": [
                {"label": v["label"], "value": v.get("value"), "atom_indices": v["atom_indices"]}
                for v in entry["values"]
            ],
        }
    summary = doc.summary()
    return {
        "atoms": atoms,
        "bonds": [list(b) for b in bonds],
        "annotations": annotations,
        "summary": {
            "atom_count": summary["atom_count"],
            "chain_ids": sorted({str(x) for x in labels}),
            "next_chain_id": summary["next_chain_id"],
            "condition_counts": summary["condition_counts"],
            "undo_depth": summary["undo_depth"],
            "sequence": summary["sequence"],
        },
    }


def _parts(doc: StudioDocument, parts: list[dict]) -> list[dict]:
    out = []
    for p in parts:
        if p["kind"] == "own":
            out.append({"kind": "own", "atoms": resolve(doc, p["select"])})
        elif p["kind"] == "new" and "select" in p:
            out.append({**{k: v for k, v in p.items() if k != "select"}, "atom": resolve(doc, p["select"])[0]})
        else:
            out.append(p)
    return out


def apply_op(doc: StudioDocument, docs: dict[str, StudioDocument], op: dict[str, Any]) -> Any:
    """One operation of a job through the Python document (the same operations as the driver's `apply`)."""
    name = op["op"]
    sel = lambda s: resolve(doc, s)  # noqa: E731
    if name == "rebuild":
        return doc.rebuild_chain(op["chain"], _parts(doc, op["parts"]))
    if name == "order":
        return doc.reorder_chains(op["chain_ids"])
    if name == "clear_coordinates":
        return doc.clear_coordinates(sel(op["select"]), sel(op["lead"]) if op.get("lead") else [])
    if name == "segment_range":
        return doc.set_segment_range(sel(op["select"])[0], op["minimum"], op["maximum"])
    if name == "replace":
        return doc.replace_with_segments(sel(op["select"]), op["minimum"], op["maximum"])
    if name == "restore":
        return doc.restore_segment(sel(op["select"])[0])
    if name == "scaffold":
        return doc.scaffold_motif(
            sel(op["select"]),
            spread=op.get("spread", 0.25),
            sidechains_only=bool(op.get("sidechains_only")),
            unindexed=bool(op.get("unindexed")),
            ordered=bool(op.get("ordered")),
            total_min=op.get("total_min"),
            total_max=op.get("total_max"),
        )
    if name == "ligand_binder":
        return doc.design_around_ligand(
            remove_protein=op.get("remove_protein", True),
            pose_fixed=op.get("pose_fixed", True),
            minimum=op.get("minimum", 100),
            maximum=op.get("maximum", 150),
        )
    if name == "delete":
        return doc.delete_atoms(sel(op["select"]), bool(op.get("close_residue_gaps")))
    if name == "insert_segment":
        return doc.insert_segment(
            op["minimum"],
            op["maximum"],
            sel(op["select"])[0] if op.get("select") else None,
            before=op.get("before", True),
            new_chain=op.get("new_chain", False),
            chain_id=op.get("chain_id"),
            chain_type=op.get("chain_type", "polypeptide(L)"),
        )
    if name == "combine":
        return doc.combine([docs[op["with"]].clone()])
    if name == "assign_chain":
        return doc.assign_chain(sel(op["select"]), op["chain_id"])
    if name == "conditions":
        return doc.set_conditions(
            [
                {
                    "condition": e["condition"],
                    "atom_indices": sel(e["select"]),
                    "enabled": e.get("enabled", True),
                    "value": e.get("value"),
                    "scope": e.get("scope", "atom"),
                }
                for e in op["edits"]
            ],
            allow_target_discard=True,
        )
    if name == "internal_coords":
        return doc.set_internal_coordinates(sel(op["select"]), op.get("enabled", True), group_id=op.get("group_id"))
    if name == "clear_targets":
        return doc.clear_internal_targets(sel(op["select"]))
    if name == "undo":
        if not doc.undo():
            raise ValueError("undo history is empty")
        return {"changed": True}
    raise ValueError(f"unknown op {name}")


def run_job(job: dict[str, Any]) -> dict[str, Any]:
    docs = {key: open_document(spec) for key, spec in job["documents"].items()}
    for d in docs.values():
        d.clear_history()
    doc = docs["main"]
    steps: list[dict[str, Any]] = [{"op": "open", "state": state_of(doc)}]
    for op in job["ops"]:
        step: dict[str, Any] = {"op": op["op"]}
        try:
            if op["op"] == "preview":
                before = doc.to_cif()
                cif = doc.preview_rebuild(op["chain"], _parts(doc, op["parts"]))
                step["extra"] = {"cif": cif, "unchanged": doc.to_cif() == before}
            elif op["op"] == "plan":
                step["extra"] = {"plan": json.loads(json.dumps(doc.chain_plan(op["chain"]), default=int))}
            elif op["op"] == "origins":
                step["extra"] = {"origins": doc.segment_origins()}
            elif op["op"] == "source":
                found = doc.chain_source_cif(op["chain"])
                step["extra"] = {"source": found}
            else:
                result = apply_op(doc, docs, op)
                step["result"] = result if isinstance(result, dict) else None
        except (ValueError, KeyError, IndexError) as error:
            step["error"] = str(error)
        step["state"] = state_of(doc)
        steps.append(step)
    return {"steps": steps}


def node_available() -> bool:
    return shutil.which("node") is not None


def page_dir() -> Path | None:
    value = os.environ.get("RFD4P_PAGE_DIR")
    return Path(value) if value and (Path(value) / "web" / "studio-api.js").is_file() else None


def run_js_job(job: dict[str, Any], tmp_path: Path) -> dict[str, Any]:
    path = tmp_path / "job.json"
    path.write_text(json.dumps(job))
    result = subprocess.run(
        ["node", str(DRIVER), str(path)],
        capture_output=True,
        text=True,
        check=False,
        env={**os.environ, "RFD4P_PAGE_DIR": str(page_dir())},
        timeout=300,
    )
    if result.returncode:
        raise RuntimeError(f"js engine failed: {result.stderr[-2000:]}")
    return json.loads(result.stdout)


# ---------------------------------------------------------------------------------------------------------------------
# Comparison
# ---------------------------------------------------------------------------------------------------------------------
# `index_group` is not compared: the RFD4 provider assigns index groups to residues placed anywhere as it syncs
# them with the index condition; the page's engine only has what the group editor sets, and the card never reads it.
KEY_CONDITIONS = (
    "sequence",
    "coordinate",
    "index",
    "hotspot",
    "rasa",
    "hbond",
    "pistack",
    "pication",
    "saltbridge",
    "hydrophobic",
    "metal_coord",
    "secondary_structure",
    "cath_label",
    "chain_centroid",
    "coordinate_group",
    "internal_coordinate",
)


def _residue_ids(atoms: dict[str, list]) -> list[int]:
    out, last, k = [], None, -1
    for key in zip(atoms["chain"], atoms["res_id"], atoms["ins"], atoms["res_name"], strict=True):
        if key != last:
            k += 1
            last = key
        out.append(k)
    return out


def _annotation_map(state: dict[str, Any]) -> dict[str, dict[str, list[int]]]:
    """Condition values by atom. Atoms without coordinates are left out of the coordinate conditions: the page's engine
    marks them as held (a group-0 member without a position), this one does not."""
    out: dict[str, dict[str, list[int]]] = {}
    unresolved = {i for i, c in enumerate(state["atoms"]["coord"]) if c[0] is None}
    placeholders = {i for i, s in enumerate(state["atoms"]["segment"]) if s}
    for name in KEY_CONDITIONS:
        entry = state["annotations"].get(name)
        if not entry:
            continue
        skip = unresolved if name in ("coordinate", "coordinate_group") else set()
        if name == "sequence":
            # The page's engine counts a placeholder as sequence-conditioned (it holds the text "x.x.x.x"): not here.
            skip = placeholders
        values = {
            json.dumps(v["value"] if v["value"] is not None else v["label"]): sorted(set(v["atom_indices"]) - skip)
            for v in entry["values"]
        }
        out[name] = {k: v for k, v in values.items() if v}
    return out


def compare_states(
    py: dict[str, Any], js: dict[str, Any], *, tolerance: float = 1e-3, where: str = "", bonds: bool = True
) -> list[str]:
    """Differences between the two engines' states (an empty list: they agree)."""
    problems: list[str] = []
    pa, ja = py["atoms"], js["atoms"]
    if len(pa["chain"]) != len(ja["chain"]):
        return [f"{where}atom count: py {len(pa['chain'])} js {len(ja['chain'])}"]
    n = len(pa["chain"])
    for field in ("chain", "res_id", "ins", "res_name", "atom_name", "segment", "polymer"):
        bad = [i for i in range(n) if pa[field][i] != ja[field][i]]
        if bad:
            i = bad[0]
            problems.append(
                f"{where}{field}: {len(bad)} atoms differ, first at {i}: py {pa[field][i]!r} js {ja[field][i]!r}"
            )
    bad = []
    for i in range(n):
        for p, j in zip(pa["coord"][i], ja["coord"][i], strict=True):
            if (p is None) != (j is None) or (p is not None and abs(p - j) > tolerance):
                bad.append(i)
                break
    if bad:
        i = bad[0]
        problems.append(f"{where}coord: {len(bad)} atoms differ, first at {i}: py {pa['coord'][i]} js {ja['coord'][i]}")
    # (A placeholder's source name is text in the page's engine, "x.x.x.x": not compared.)
    bad = [i for i in range(n) if not pa["segment"][i] and pa["src"][i] != ja["src"][i]]
    if bad:
        problems.append(
            f"{where}src labels: {len(bad)} differ, first {bad[0]}: py {pa['src'][bad[0]]!r} js {ja['src'][bad[0]]!r}"
        )
    bad = [
        i
        for i in range(n)
        if pa["segment"][i] and (pa["seg_min"][i], pa["seg_max"][i]) != (ja["seg_min"][i], ja["seg_max"][i])
    ]
    if bad:
        problems.append(f"{where}segment ranges differ at {bad[:3]}")
    # Bonds between residues and any to a placeholder (bonds inside a residue come from a CCD table).
    res = _residue_ids(pa)

    def cross(state):
        return {tuple(b) for b in state["bonds"] if res[b[0]] != res[b[1]] or pa["segment"][b[0]]}

    only_py, only_js = cross(py) - cross(js), cross(js) - cross(py)
    if bonds and (only_py or only_js):
        problems.append(f"{where}bonds: py-only {sorted(only_py)[:5]} js-only {sorted(only_js)[:5]}")
    pm, jm = _annotation_map(py), _annotation_map(js)
    for name in sorted(set(pm) | set(jm)):
        if pm.get(name) != jm.get(name):
            keys = sorted(set(pm.get(name, {})) | set(jm.get(name, {})))
            detail = [k for k in keys if pm.get(name, {}).get(k) != jm.get(name, {}).get(k)][:3]
            problems.append(f"{where}condition {name}: differs at values {detail}")
    ps, js_ = py["summary"], js["summary"]
    for field in ("atom_count", "chain_ids", "next_chain_id"):
        if ps[field] != js_[field]:
            problems.append(f"{where}summary.{field}: py {ps[field]} js {js_[field]}")
    counts = lambda s: {k: v for k, v in s["condition_counts"].items() if k in KEY_CONDITIONS}  # noqa: E731
    if counts(ps) != counts(js_) and not any(i for i in (pm, jm)):
        problems.append(f"{where}condition_counts: py {counts(ps)} js {counts(js_)}")
    return problems


def _plan_shape(plan: dict[str, Any]) -> dict[str, Any]:
    return {
        "chain": plan["chain"],
        "source": [{k: r[k] for k in ("num", "ins", "name", "label")} for r in plan["source"]],
        "parts": plan["parts"],
    }


def compare_runs(
    py: dict[str, Any], js: dict[str, Any], *, tolerance: float = 1e-3, skip_open: bool = False
) -> list[str]:
    """Differences between two `run_job` results, step by step (`skip_open`: not the state as opened)."""
    problems: list[str] = []
    if len(py["steps"]) != len(js["steps"]):
        return [f"step count: py {len(py['steps'])} js {len(js['steps'])}"]
    for k, (ps, js_) in enumerate(zip(py["steps"], js["steps"], strict=True)):
        where = f"step {k} ({ps['op']}): "
        if bool(ps.get("error")) != bool(js_.get("error")):
            problems.append(f"{where}error: py {ps.get('error')!r} js {js_.get('error')!r}")
            continue
        if not (skip_open and k == 0):
            problems.extend(compare_states(ps["state"], js_["state"], tolerance=tolerance, where=where))
        ep, ej = ps.get("extra"), js_.get("extra")
        if ep and ej:
            if "cif" in ep and "state" in ej:
                # The preview's CIF read back is the page's preview.
                provider = providers()
                shown = state_of(
                    StudioDocument.from_cif(ep["cif"], "preview", condition_provider=provider.condition_provider)
                )
                problems.extend(
                    compare_states(shown, ej["state"], tolerance=tolerance, where=f"{where}preview: ", bonds=False)
                )
            if "plan" in ep and _plan_shape(ep["plan"]) != _plan_shape(ej["plan"]):
                problems.append(f"{where}plan: py {_plan_shape(ep['plan'])} js {_plan_shape(ej['plan'])}")
            if "origins" in ep and ep["origins"] != ej["origins"]:
                problems.append(f"{where}origins: py {ep['origins']} js {ej['origins']}")
            if "cif" in ep and not ep.get("unchanged", True):
                problems.append(f"{where}preview changed the session")
    return problems


# ---------------------------------------------------------------------------------------------------------------------
# Entries
# ---------------------------------------------------------------------------------------------------------------------
class EntryUnavailableError(RuntimeError):
    """An RCSB entry is not cached and could not be fetched."""


def entry_path(entry: str) -> Path:
    """A CIF of an RCSB entry: a cached copy (`STUDIO_PARITY_CIF_DIR`, `tests/fixtures/rcsb`, the system temp dir)
    or, failing that, the entry downloaded once. Raises `EntryUnavailableError` when it is not to be had."""
    import tempfile
    import urllib.request

    name = entry.upper()
    folders = [Path(p) for p in (os.environ.get("STUDIO_PARITY_CIF_DIR"),) if p]
    folders += [Path(__file__).parent / "fixtures" / "rcsb", Path(tempfile.gettempdir()) / "atomworks-studio-rcsb"]
    for folder in folders:
        path = folder / f"{name}.cif"
        if path.is_file() and path.stat().st_size > 1000:
            return path
    cache = folders[-1]
    try:
        cache.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(f"https://files.rcsb.org/download/{name}.cif", timeout=20) as response:
            data = response.read()
        if len(data) < 1000:
            raise OSError("short response")
        (cache / f"{name}.cif").write_bytes(data)
        return cache / f"{name}.cif"
    except OSError as error:
        raise EntryUnavailableError(f"{name}: {error}") from error


def materialize(job: dict[str, Any]) -> dict[str, Any]:
    """The job with its `entry` names replaced by file paths."""
    documents = {}
    for key, spec in job["documents"].items():
        spec = dict(spec)
        if "entry" in spec:
            spec["path"] = str(entry_path(spec.pop("entry")))
        documents[key] = spec
    return {**job, "documents": documents}
