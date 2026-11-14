/**
 * The Design card's view of one Studio session, read over the REST API and nothing else: the structure as an
 * `AtomArray` (parsed from the session's annotated CIF), each chain as a plan, where new residues came from, and the
 * chain as it was loaded. The card reads this synchronously while it draws and refreshes it after every edit.
 */
import { api, apiText, postJson } from "../api.ts";
import { parseCifToAtoms } from "./cif.ts";
import type { AtomArray } from "./types.ts";

/** A residue of a chain as it was loaded: its number and insertion code there, its name, and the name a set-up gave it. */
export type SourceResidue = { num: number; ins: string; name: string; label: string };

/**
 * One part of a chain as a plan (`GET /sessions/{sid}/chains/{cid}/plan`): a run of the source kept (`from`..`to` are
 * source indices, `lo`..`hi` source numbers, `atoms` the document atoms holding it), a block of new residues, or
 * residues the source does not have, kept as they are.
 */
export type PlanPart =
  | { kind: "kept"; from: number; to: number; lo: number; hi: number; atoms: number[] }
  | { kind: "new"; atom: number; min: number; max: number }
  | { kind: "own"; atoms: number[] };

export type ChainPlan = { chain: string; source: SourceResidue[]; parts: PlanPart[] };

/** What a chain is rebuilt from (`POST .../chains/rebuild`, `.../chains/preview`). */
export type RebuildPart =
  | { kind: "kept"; lo: number; hi: number }
  | { kind: "own"; atoms: number[] }
  | { kind: "new"; atom?: number | null; min?: number; max?: number };

/** The residues a block of new residues replaced: how many, and their keys ("A:41:"). */
export type SegmentOrigin = { count: number; keys: string[] };

type SessionSummary = {
  revision: number;
  name: string;
  undo_depth: number;
  atom_count: number;
  chain_ids: string[];
};

const SENTINEL = /^\d+-\d+$/;

const enc = encodeURIComponent;

export class SessionDoc {
  readonly sid: string;
  atoms: AtomArray = emptyAtoms();
  name = "";
  revision = -1;
  undoDepth = 0;
  cif = "";
  private origins = new Map<number, SegmentOrigin>();
  private plans = new Map<string, ChainPlan>();
  private sources = new Map<string, Promise<{ chain: string; atoms: AtomArray } | null>>();
  private pending: Promise<void> | null = null;

  constructor(sid: string) {
    this.sid = sid;
  }

  get nAtoms(): number {
    return this.atoms.nAtoms;
  }

  private path(subpath = ""): string {
    return `/api/sessions/${enc(this.sid)}${subpath}`;
  }

  /**
   * Read the session again if it changed (its revision or undo depth moved), plus what hangs off it: the origins of
   * new residues and the plan of each chain that holds kept residues. Concurrent calls share one read.
   */
  refresh(force = false): Promise<void> {
    if (this.pending) {
      const again = this.pending.then(() => this.refresh(force));
      return again;
    }
    const run = this.read(force).finally(() => { this.pending = null; });
    this.pending = run;
    return run;
  }

  private async read(force: boolean): Promise<void> {
    const response = await api<{ structure: SessionSummary }>(this.path());
    const s = response.structure;
    if (!force && s.revision === this.revision && s.undo_depth === this.undoDepth && this.atoms.nAtoms === s.atom_count) return;
    const cif = await apiText(this.path("/cif"));
    const atoms = parseCifToAtoms(cif);
    atoms.name = s.name;
    this.cif = cif;
    this.atoms = atoms;
    this.name = s.name;
    this.revision = s.revision;
    this.undoDepth = s.undo_depth;
    this.plans.clear();
    this.sources.clear();
    this.origins.clear();
    const jobs: Promise<void>[] = [];
    if (atoms.res_name.some((r) => SENTINEL.test(String(r)))) {
      jobs.push(api<{ origins?: Record<string, SegmentOrigin> }>(this.path("/segments/origins")).then((r) => {
        for (const [k, v] of Object.entries(r.origins ?? {})) this.origins.set(Number(k), v);
      }, () => undefined));
    }
    // A chain with residues of its own is edited as a plan: read them now, so the popups open without waiting.
    const chains = new Set<string>();
    for (let i = 0; i < atoms.nAtoms; i += 1) {
      if (atoms.is_polymer[i] && !SENTINEL.test(String(atoms.res_name[i]))) chains.add(String(atoms.chain_id[i]));
    }
    for (const cid of chains) {
      jobs.push(api<ChainPlan>(this.path(`/chains/${enc(cid)}/plan`)).then((plan) => { this.plans.set(cid, plan); }, () => undefined));
    }
    await Promise.all(jobs);
  }

  /** Chain `cid` as a plan, or null when the server has none to give. Read by `refresh`. */
  plan(cid: string): ChainPlan | null {
    return this.plans.get(String(cid)) ?? null;
  }

  /** What new-residue segment `atomIndex` replaced, when the server remembers it. */
  segmentOrigin(atomIndex: number): SegmentOrigin | null {
    return this.origins.get(atomIndex) ?? null;
  }

  hasOrigins(): boolean {
    return this.origins.size > 0;
  }

  /** Every new-residue segment atom with a known origin, in ascending order. */
  originAtoms(): number[] {
    return [...this.origins.keys()].sort((a, b) => a - b);
  }

  /** The chain as it was loaded (its own atoms and its id there), or null for a chain made here. */
  source(cid: string): Promise<{ chain: string; atoms: AtomArray } | null> {
    const key = String(cid);
    let found = this.sources.get(key);
    if (!found) {
      found = api<{ chain: string; cif: string }>(this.path(`/chains/${enc(key)}/source`)).then(
        (r) => ({ chain: r.chain, atoms: parseCifToAtoms(r.cif) }), () => null);
      this.sources.set(key, found);
    }
    return found;
  }

  /** The chain as `parts` would leave it, as an mmCIF; the session is unchanged. */
  async preview(cid: string, parts: RebuildPart[]): Promise<string> {
    const r = await postJson<{ cif: string }>(this.path("/chains/preview"), { chain_id: cid, parts });
    return r.cif;
  }

  /** `scope: "residue"` of `POST /selections/resolve`, computed here: every atom of every residue `indices` touch. */
  residueAtoms(indices: number[]): number[] {
    const a = this.atoms;
    const key = (i: number): string => `${a.chain_id[i]}|${a.res_id[i]}|${a.ins_code[i]}`;
    const want = new Set(indices.filter((i) => i >= 0 && i < a.nAtoms).map(key));
    const out: number[] = [];
    for (let i = 0; i < a.nAtoms; i += 1) if (want.has(key(i))) out.push(i);
    return out;
  }

  /** Apply `path` to this session directly (not through Studio's viewer): an edit made out of sight. */
  async post(path: string, body: unknown): Promise<void> {
    await postJson(this.path(path), body ?? {});
  }
}

function emptyAtoms(): AtomArray {
  return {
    nAtoms: 0, chain_id: [], res_id: [], ins_code: [], auth_seq_id: [], res_name: [], atom_name: [], element: [],
    hetero: [], is_polymer: [], coord: [], annotations: {},
  };
}

/** Create a session from mmCIF text (`POST /sessions`, multipart), with the import options a form takes. */
export async function createSession(
  cif: string,
  name: string,
  options: { preset?: "minimal" | "rcsb"; assembly?: string; keepUnresolved?: boolean } = {},
): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([cif], { type: "chemical/x-mmcif" }), `${name.replace(/[^\w.-]+/g, "_") || "structure"}.cif`);
  form.append("parse_preset", options.preset ?? "minimal");
  if (options.assembly != null) form.append("assembly", options.assembly);
  if (options.keepUnresolved != null) form.append("keep_unresolved", options.keepUnresolved ? "true" : "false");
  const r = await api<{ session_id: string }>("/api/sessions", { method: "POST", body: form, timeoutMs: 120_000 });
  return r.session_id;
}

/** Forget a session the card made only to read from or merge (best effort). */
export async function deleteSession(sid: string): Promise<void> {
  try {
    await fetch(`/api/v1/sessions/${enc(sid)}`, { method: "DELETE" });
  } catch {
    // The server expires sessions anyway.
  }
}
