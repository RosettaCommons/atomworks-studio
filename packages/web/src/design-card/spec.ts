/**
 * What a Studio document asks the design model for, read from its condition annotations: per-chain roles, lengths,
 * an RFdiffusion-style contig string and the task it amounts to. Pure (atom array in, plain object out) so the card
 * can recompute it on every edit and tests can pin it on the bundled examples. Port of the page's `design-spec.js`.
 */
import type { AnnotationCell, AtomArray } from "./types.ts";

const BACKBONE_ATOMS = new Set(["N", "CA", "C", "O"]);

/** The atom-level interaction conditions, by the key the card names them with. */
export const INTERACTIONS: ReadonlyArray<readonly [string, string]> = [
  ["hbond", "condition_hbond_1_atom"],
  ["saltbridge", "condition_saltbridge_1_atom"],
  ["pistack", "condition_pistack_1_atom"],
  ["pication", "condition_pication_1_atom"],
  ["hydrophobic", "condition_hydrophobic_1_atom"],
  ["metal_coord", "condition_metal-coord_1_atom"],
];

/** Display names for roles; `detail` is filled in per chain. */
export const ROLE_LABELS = {
  fixed: "Fixed",
  backbone: "Sequence redesigned",
  sequence: "Fold predicted",
  free: "Redesigned",
  motif: "Partly fixed",
  new: "New chain",
  ligand: "Ligand",
} as const;

export type ChainRole = keyof typeof ROLE_LABELS;
export type PolymerKind = "protein" | "dna" | "rna";
export type TaskKey =
  | "partial" | "empty" | "nothing" | "fold" | "redesign_all" | "inverse" | "enzyme" | "antibody" | "binder"
  | "sm_binder" | "motif" | "unconditional" | "custom";
export type TaskInfo = { key: TaskKey; label: string; detail: string };

/** How a kept piece is kept: its coordinates and sequence ("all"), either alone, or its shape only (rigid). */
export type KeepMode = "all" | "backbone" | "sidechain" | "sequence" | "shape";

/** A new-residue segment of a chain (a placeholder atom with a length range). */
export type SegmentSpec = { min: number; max: number; atomIndex: number; where: string };

export type LigandSpec = {
  name: string;
  fixed: boolean;
  pose: "rigid" | "predicted" | "partly fixed" | "fixed";
  atoms: number;
  fixedAtoms: number;
  heldNames: string;
  atomIndices: number[];
};

/** A run of consecutive residues treated alike (`kept`, or `designed` in place). */
export type RunPiece = {
  kind: "kept" | "designed";
  /** For a kept run: how it is kept. */
  keep?: KeepMode | null;
  anywhere?: boolean;
  /** What is held: "all", "backbone", "sidechain" or atom names "CG, OD1"; null for none. */
  atoms?: string | null;
  start: number;
  end: number;
  count: number;
  atomIndices: number[];
  hotspots: number[];
  ss: number;
  rasa: number;
  inter: string;
  /** Where a renumbered run came from ("A38", "A38–40"), when different from where it sits. */
  source?: string;
};

/** One block of new residues (a placeholder atom with a length range). */
export type NewPiece = {
  kind: "new";
  min: number;
  max: number;
  atomIndex: number;
  where: string;
  count: number;
  atomIndices: number[];
  hotspots: number[];
  ss: number;
  rasa: number;
  inter: string;
  fold: string;
  start: number;
  end: number;
};

export type PieceSpec = RunPiece | NewPiece;

export type ChainSpec = {
  id: string;
  role: ChainRole;
  kind: PolymerKind | "ligand";
  residues: number;
  fixed: number;
  backboneOnly: number;
  unresolved: number;
  seqFixed: number;
  designed: number;
  predicted: number;
  unindexed: number;
  hotspots: number;
  segments: SegmentSpec[];
  ligands: LigandSpec[];
  lengthMin: number;
  lengthMax: number;
  fold: string;
  contig: string;
  pieces: PieceSpec[];
  hotspotResIds: number[];
  /** Hotspot residues marked on some of their atoms only: resId -> those atom names. */
  hotspotAtoms: Map<number, string[]>;
  atomIndices: number[];
  polymerAtomIndices: number[];
  backboneAtomIndices: number[];
  ligandAtomIndices: number[];
  firstResId: number | null;
  lastResId: number | null;
};

export type DesignSpec = {
  empty: boolean;
  task: TaskInfo;
  chains: ChainSpec[];
  designedMin: number;
  designedMax: number;
  predicted: number;
  totalMin: number;
  totalMax: number;
  contig: string;
  warnings: string[];
};

export type DesignSpecOptions = { partialDiffusion?: boolean; partialPercent?: number };

type SegmentInfo = { min: number; max: number; atomIndex: number };

/** A residue as the spec reads it (internal). */
type Res = {
  resId: number;
  resName: string;
  kind: PolymerKind | "segment" | null;
  segment: SegmentInfo | null;
  crdAtoms: number;
  crdBackbone: number;
  resolved: boolean;
  seqFixed: boolean;
  unindexed: boolean;
  relative: boolean;
  source: string | null;
  hotspots: number;
  atoms: number;
  atomIndices: number[];
  heavyNames: string[];
  allHeavyNames: string[];
  heldNames: string[];
  hotNames: string[];
  allHot: boolean;
  ss: number;
  rasa: number;
  inter: string;
  fold: string;
};

type ChainAcc = { id: string; residues: Res[]; byKey: Map<string, Res>; atomIndices: number[] };

const isSentinel = (atoms: AtomArray, i: number): boolean => {
  const min = atoms.annotations?.annotation_expsegmin_1_residue?.[i];
  return (typeof min === "number" && Number.isFinite(min) && min > 0) || /^\d+-\d+$/.test(String(atoms.res_name[i]));
};

const hasCrd = (c: AnnotationCell | number[]): boolean =>
  Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1]) && Number.isFinite(c[2]);

/** Polymer kind of a residue name, or null for ligands / ions. */
function polymerKind(resName: string, hetero: boolean): PolymerKind | null {
  if (hetero) return null;
  if (/^D[ACGTU]$/.test(resName)) return "dna";
  if (/^[ACGU]$/.test(resName)) return "rna";
  return "protein";
}

const lengthText = (min: number, max: number): string => (min === max ? String(min) : `${min}–${max}`);

export function designSpec(
  atoms: AtomArray,
  { partialDiffusion = false, partialPercent = 40 }: DesignSpecOptions = {},
): DesignSpec {
  const n = atoms?.nAtoms ?? atoms?.chain_id?.length ?? 0;
  const ann = atoms?.annotations ?? {};
  const crd = ann.condition_coordinate_1_atom;
  const seqCond = ann.condition_sequence_1_residue;
  const indexCond = ann.condition_index_1_residue;
  const hotspot = ann.condition_hotspot_1_atom;
  const group = ann.condition_CoordinateGroup_1_atom;
  const internal = ann.condition_InternalCoordinate_1_atom;
  const ssCond = ann["condition_secondary-structure_1_residue"];
  const rasaCond = ann["condition_rasa-binned_1_atom"];
  const cath = ann["condition_cath-label_1_residue"];
  // Where a residue came from ("A38"), when a set-up renumbered it.
  const source = ann["annotation_src-component_1_atom"];
  const segMin = ann.annotation_expsegmin_1_residue;
  const segMax = ann.annotation_expsegmax_1_residue;

  // Residues in document order, grouped per chain.
  const chains = new Map<string, ChainAcc>();
  for (let i = 0; i < n; i += 1) {
    const chainId = String(atoms.chain_id[i]);
    let chain = chains.get(chainId);
    if (!chain) {
      chain = { id: chainId, residues: [], byKey: new Map(), atomIndices: [] };
      chains.set(chainId, chain);
    }
    chain.atomIndices.push(i);
    const key = `${atoms.res_id[i]}|${atoms.ins_code?.[i] ?? ""}`;
    let res = chain.byKey.get(key);
    if (!res) {
      const sentinel = isSentinel(atoms, i);
      res = {
        resId: Number(atoms.res_id[i]),
        resName: String(atoms.res_name[i]),
        // is_polymer, not HETATM: modified residues (MSE, SEP, ...) are polymer residues stored as HETATM.
        kind: sentinel ? "segment" : polymerKind(String(atoms.res_name[i]),
          atoms.is_polymer?.length === n ? !atoms.is_polymer[i] : Boolean(atoms.hetero?.[i])),
        segment: sentinel ? { min: Number(segMin?.[i] ?? 0), max: Number(segMax?.[i] ?? 0), atomIndex: i } : null,
        crdAtoms: 0,
        crdBackbone: 0,
        resolved: false,
        seqFixed: false,
        unindexed: false,
        relative: false,
        source: null,
        hotspots: 0,
        atoms: 0,
        atomIndices: [],
        // Atom names: heavy atoms with coordinates, all heavy atoms, those held (absolute or rigid), and hotspot atoms.
        heavyNames: [],
        allHeavyNames: [],
        heldNames: [],
        hotNames: [],
        allHot: true,
        // Asked of the model: secondary structure (1 helix, 2 strand, 3 loop), solvent exposure (1 buried, 2
        // intermediate, 3 exposed) and an interaction its atoms should make ("hbond:2"), when set.
        ss: 0,
        rasa: 0,
        inter: "",
        fold: "",
      };
      if (res.segment && !(res.segment.min > 0)) {
        const m = /^(\d+)-(\d+)$/.exec(res.resName);
        if (m) res.segment = { min: Number(m[1]), max: Number(m[2]), atomIndex: i };
      }
      chain.byKey.set(key, res);
      chain.residues.push(res);
    }
    res.atoms += 1;
    res.atomIndices.push(i);
    const atomName = String(atoms.atom_name[i]);
    const heavy = String(atoms.element?.[i] ?? "").toUpperCase() !== "H";
    if (heavy) res.allHeavyNames.push(atomName);
    if (hasCrd(atoms.coord?.[i])) {
      res.resolved = true;
      if (heavy) res.heavyNames.push(atomName);
    }
    if (hasCrd(crd?.[i])) {
      res.crdAtoms += 1;
      if (BACKBONE_ATOMS.has(atomName)) res.crdBackbone += 1;
    }
    if (heavy && (hasCrd(crd?.[i]) || Number(group?.[i]) > 0 || hasCrd(internal?.[i]))) res.heldNames.push(atomName);
    if (hotspot?.[i]) { if (heavy) res.hotNames.push(atomName); } else if (heavy && hasCrd(atoms.coord?.[i])) res.allHot = false;
    if (Number(ssCond?.[i]) > 0) res.ss = Number(ssCond?.[i]);
    if (Number(rasaCond?.[i]) > 0) res.rasa = Number(rasaCond?.[i]);
    if (!res.inter) {
      for (const [interKey, col] of INTERACTIONS) {
        const v = ann[col]?.[i];
        if (v === true || Number(v) > 0) { res.inter = `${interKey}:${v === true ? 1 : Number(v)}`; break; }
      }
    }
    const fold = String(cath?.[i] ?? "");
    if (fold && !/^x(\.x)*$/.test(fold) && fold !== ".") res.fold = fold;
    const s = seqCond?.[i];
    if (s != null && s !== "<M>" && s !== "." && s !== "" && s !== "?") res.seqFixed = true;
    if (indexCond && indexCond[i] === false) res.unindexed = true;
    // Held by its shape only (a framework): a coordinate group other than the absolute one, or internal coordinates.
    if (Number(group?.[i]) > 0 || hasCrd(internal?.[i])) res.relative = true;
    if (res.source == null && /^[A-Za-z]{1,4}-?\d+$/.test(String(source?.[i] ?? ""))) res.source = String(source?.[i]);
    if (hotspot?.[i]) res.hotspots += 1;
  }

  const out: ChainSpec[] = [];
  for (const chain of chains.values()) {
    const polymer = chain.residues.filter((r) => r.kind && r.kind !== "segment");
    // Where each segment sits relative to the chain's existing residues (for labels).
    const ordered = chain.residues.filter((r) => r.kind);
    const segments: SegmentSpec[] = [];
    ordered.forEach((r, k) => {
      if (r.kind !== "segment" || !r.segment) return;
      const prev = ordered.slice(0, k).reverse().find((x) => x.kind !== "segment");
      const next = ordered.slice(k + 1).find((x) => x.kind !== "segment");
      const where = !prev && !next ? "" : !prev ? "N-terminal" : !next ? "C-terminal"
        : `between ${chain.id}${prev.resId} and ${chain.id}${next.resId}`;
      segments.push({ ...r.segment, where });
    });
    const ligands = chain.residues.filter((r) => !r.kind);
    // Held in place, or held by their shape as a rigid body (a binder's target as upstream sets it up): kept either way.
    const fixed = polymer.filter((r) => r.crdAtoms > 0 || r.relative);
    // Unmodelled residues (no coordinates) cannot be held in place, so roles are judged on the modelled ones.
    const resolved = polymer.filter((r) => r.resolved || r.crdAtoms > 0 || r.relative);
    const allFixed = fixed.length > 0 && fixed.length === resolved.length;
    const seqFixed = polymer.filter((r) => r.seqFixed);
    const freeRes = polymer.filter((r) => !r.crdAtoms && !r.seqFixed);
    const segMinSum = segments.reduce((s, g) => s + g.min, 0);
    const segMaxSum = segments.reduce((s, g) => s + g.max, 0);

    let role: ChainRole;
    if (!polymer.length && !segments.length) role = "ligand";
    else if (!polymer.length) role = "new";
    else if (allFixed && seqFixed.length === polymer.length && !segments.length) role = "fixed";
    else if (allFixed && !seqFixed.length && !segments.length) role = "backbone";
    else if (!fixed.length && seqFixed.length === polymer.length && !segments.length) role = "sequence";
    else if (!fixed.length && !seqFixed.length) role = "free";
    else role = "motif";

    // Contig: fixed residue runs as `A12-20`, designed runs and segments as lengths, `/` between pieces.
    const pieces: string[] = [];
    const open: { run: { type: "fixed" | "unindexed" | "designed"; start: number; end: number; count: number } | null } = { run: null };
    const flush = (): void => {
      const run = open.run;
      if (!run) return;
      const range = run.start === run.end ? `${chain.id}${run.start}` : `${chain.id}${run.start}-${run.end}`;
      pieces.push(run.type === "fixed" ? range : run.type === "unindexed" ? `[${range}]` : String(run.count));
      open.run = null;
    };
    for (const r of chain.residues) {
      if (!r.kind) continue;
      if (r.kind === "segment" && r.segment) {
        flush();
        pieces.push(lengthText(r.segment.min, r.segment.max).replace("–", "-"));
        continue;
      }
      // Unindexed motif residues are placed by the model anywhere in the chain: bracketed, and not counted in length.
      const type = r.unindexed ? "unindexed" : r.crdAtoms > 0 ? "fixed" : "designed";
      const cur = open.run;
      if (cur && cur.type === type && (type === "designed" || r.resId === cur.end + 1)) {
        cur.end = r.resId;
        cur.count += 1;
      } else {
        flush();
        open.run = { type, start: r.resId, end: r.resId, count: 1 };
      }
    }
    flush();

    const placed = polymer.filter((r) => !r.unindexed).length;
    const segmentWhere = new Map(segments.map((g) => [g.atomIndex, g.where]));
    const lengthMin = placed + segMinSum;
    const lengthMax = placed + segMaxSum;
    out.push({
      id: chain.id,
      role,
      kind: polymer[0]?.kind === "segment" ? "protein" : (polymer[0]?.kind ?? (segments.length ? "protein" : "ligand")),
      residues: polymer.length,
      fixed: fixed.length,
      backboneOnly: fixed.filter((r) => r.crdAtoms === r.crdBackbone).length,
      unresolved: polymer.length - resolved.length,
      seqFixed: seqFixed.length,
      designed: freeRes.length + polymer.filter((r) => r.crdAtoms && !r.seqFixed).length,
      // Sequence kept but structure free: not designed, but still built by the model.
      predicted: polymer.filter((r) => !r.crdAtoms && r.seqFixed).length,
      unindexed: polymer.filter((r) => r.unindexed).length,
      hotspots: chain.residues.filter((r) => r.hotspots > 0).length,
      segments,
      ligands: ligands.map((r): LigandSpec => ({
        name: r.resName,
        fixed: r.crdAtoms > 0,
        // Rigid: held by its shape only, its pose the model's (internal coordinates, a coordinate group of its own).
        pose: r.relative ? "rigid" : r.crdAtoms === 0 ? "predicted" : r.crdAtoms < r.atoms ? "partly fixed" : "fixed",
        atoms: r.atoms,
        fixedAtoms: r.crdAtoms,
        // The held atoms' names when only some are ("N1, C2, N3, C4").
        heldNames: r.crdAtoms > 0 && r.crdAtoms < r.atoms ? r.heldNames.join(", ") : "",
        atomIndices: r.atomIndices,
      })),
      lengthMin,
      lengthMax,
      // The fold asked of the chain (CATH, "3.30.70.x"), if any.
      fold: chain.residues.find((r) => r.kind && r.fold)?.fold ?? "",
      contig: pieces.join("/"),
      pieces: chainPieces(chain.residues, segmentWhere),
      hotspotResIds: polymer.filter((r) => r.hotspots > 0).map((r) => r.resId),
      // Hotspot residues marked on some of their atoms only: resId -> those atom names.
      hotspotAtoms: new Map(polymer.filter((r) => r.hotspots > 0 && !r.allHot).map((r) => [r.resId, r.hotNames])),
      atomIndices: chain.atomIndices,
      polymerAtomIndices: polymer.flatMap((r) => r.atomIndices),
      backboneAtomIndices: polymer.flatMap((r) => r.atomIndices.filter((i) => BACKBONE_ATOMS.has(String(atoms.atom_name[i])))),
      ligandAtomIndices: ligands.flatMap((r) => r.atomIndices),
      firstResId: polymer[0]?.resId ?? null,
      lastResId: polymer[polymer.length - 1]?.resId ?? null,
    });
  }

  const polymers = out.filter((c) => c.role !== "ligand");
  const ligandChains = out.filter((c) => c.role === "ligand");
  const designedMin = polymers.reduce((s, c) => s + c.designed + c.segments.reduce((t, g) => t + g.min, 0), 0);
  const designedMax = polymers.reduce((s, c) => s + c.designed + c.segments.reduce((t, g) => t + g.max, 0), 0);
  const predicted = polymers.reduce((s, c) => s + c.predicted, 0);
  const totalMin = polymers.reduce((s, c) => s + c.lengthMin, 0);
  const totalMax = polymers.reduce((s, c) => s + c.lengthMax, 0);
  const anyCondition = out.some((c) => c.fixed || c.seqFixed || c.hotspots || c.ligands.some((l) => l.fixed));
  const ligandNames = ligandChains.flatMap((c) => c.ligands.map((l) => l.name));

  const task = inferTask({
    polymers, ligands: ligandChains, anyCondition, designedMax, predicted, partialDiffusion, partialPercent,
  });
  const warnings: string[] = [];
  if (!n) warnings.push("Open a structure or pick a task to start.");
  else if (task.key === "redesign_all") {
    warnings.push("Nothing in this structure is kept, so all of it will be redesigned. Use a piece's Edit menu to keep what should stay.");
  } else if (task.key === "nothing") {
    warnings.push("Everything is fixed. Click a row to design part of it, or add a chain with + new.");
  }

  return {
    empty: n === 0,
    task,
    chains: out,
    designedMin,
    designedMax,
    predicted,
    totalMin,
    totalMax,
    contig: polymers.filter((c) => c.contig).map((c) => c.contig).join("/0 ") +
      (ligandNames.length ? ` + ${ligandNames.join(", ")}` : ""),
    warnings,
  };
}

/** What `heldAtomsOf` reads of a residue. */
export type HeldResidue = {
  heldNames: string[];
  heavyNames: string[];
  allHeavyNames?: string[];
  unindexed?: boolean;
};

/**
 * Which of a residue's atoms are held: 'all', 'backbone', 'sidechain', or their names ("CG, OD1"); null for none.
 * A residue with no side chain (glycine) holding its backbone reads 'all'.
 */
export function heldAtomsOf(r: HeldResidue): string | null {
  const held = new Set(r.heldNames);
  if (!held.size) return null;
  // A residue placed anywhere keeps only its held atoms' coordinates, so it is read against all of its atoms.
  const heavy = r.unindexed && r.allHeavyNames?.length ? r.allHeavyNames : r.heavyNames.length ? r.heavyNames : r.heldNames;
  if (heavy.every((name) => held.has(name))) return "all";
  const isBb = (name: string): boolean => BACKBONE_ATOMS.has(name) || name === "OXT";
  const side = heavy.filter((name) => !isBb(name));
  // N, CA, C and O held, with or without the C-terminal OXT (upstream's backbone is [N,CA,C,O]).
  if ([...held].every(isBb) && heavy.filter((name) => BACKBONE_ATOMS.has(name)).every((name) => held.has(name))) return "backbone";
  if (held.size === side.length && side.every((name) => held.has(name))) return "sidechain";
  return heavy.filter((name) => held.has(name)).join(", ");
}

type PieceKind = { kind: "new" } | { kind: "kept"; keep: KeepMode; anywhere: boolean; atoms: string | null }
  | { kind: "designed" };

/** A residue's piece kind ('kept', 'designed', 'new') and, for a kept one, its keep mode and held atoms. */
function pieceOf(r: Res): PieceKind {
  if (r.kind === "segment") return { kind: "new" };
  let keep: KeepMode | null = null;
  if (r.relative) keep = "shape";
  else if (r.crdAtoms > 0) keep = r.crdBackbone === 0 ? "sidechain" : r.seqFixed ? "all" : "backbone";
  else if (r.seqFixed) keep = "sequence";
  return keep ? { kind: "kept", keep, anywhere: r.unindexed, atoms: heldAtomsOf(r) } : { kind: "designed" };
}

/** "A38" -> ["A", 38] */
const splitSource = (s: string | null | undefined): [string, number] | null => {
  const m = /^([A-Za-z]{1,4})(-?\d+)$/.exec(s ?? "");
  return m ? [m[1], Number(m[2])] : null;
};

/** The piece being built (internal): a `PieceSpec` with its run bookkeeping. */
type Run = {
  kind: "kept" | "designed";
  keep?: KeepMode;
  anywhere?: boolean;
  atoms?: string | null;
  ss: number;
  rasa: number;
  inter: string;
  start: number;
  end: number;
  count: number;
  atomIndices: number[];
  hotspots: number[];
  src: [string, number] | null;
  srcEnd: number | null;
  glycine: boolean;
  source?: string;
};

/**
 * A chain as the pieces a contig is made of, in order: runs of consecutive residues treated alike (`kept`, with a
 * keep mode and whether it may sit anywhere, or `designed` in place), and each new-residue segment (`new`) on its
 * own. A run renumbered by a set-up carries where it came from (`source`, e.g. "A38" or "A38–40"). Ligands are not
 * pieces (they are listed per chain).
 */
function chainPieces(residues: Res[], segmentWhere: Map<number, string>): PieceSpec[] {
  const out: Array<NewPiece | Run> = [];
  let run: Run | null = null;
  const isBackboneOnly = (r: Res): boolean => r.heavyNames.every((nm) => BACKBONE_ATOMS.has(nm) || nm === "OXT");
  for (const r of residues) {
    if (!r.kind) continue;
    const p = pieceOf(r);
    if (p.kind === "new") {
      run = null;
      const seg = r.segment as SegmentInfo;
      out.push({
        kind: "new", min: seg.min, max: seg.max, atomIndex: seg.atomIndex,
        where: segmentWhere.get(seg.atomIndex) ?? "", count: 0, atomIndices: r.atomIndices, hotspots: [],
        ss: r.ss, rasa: r.rasa, inter: r.inter, fold: r.fold, start: 0, end: 0,
      });
      continue;
    }
    const src = splitSource(r.source);
    const q: { kind: "kept" | "designed"; keep?: KeepMode; anywhere?: boolean; atoms?: string | null } = p;
    // A glycine has no side chain to hold, so "side chains only" leaves it with its amino acid alone: it belongs to
    // the side-chain run it sits in rather than splitting it.
    if (run?.keep === "sidechain" && q.kind === "kept" && q.keep && ["sequence", "all"].includes(q.keep)
      && q.anywhere === run.anywhere && isBackboneOnly(r)) {
      q.keep = "sidechain";
      q.atoms = run.atoms;
    }
    // A residue missing some of the atoms a run names (a glycine's CB) holds the rest of them: it belongs to the run.
    if (run?.kind === "kept" && q.kind === "kept" && run.keep === q.keep && run.anywhere === q.anywhere
      && typeof run.atoms === "string" && !["all", "backbone", "sidechain"].includes(run.atoms) && run.atoms !== q.atoms) {
      const names = run.atoms.split(", ");
      const have = new Set(r.unindexed ? r.allHeavyNames : r.heavyNames);
      const want = names.filter((nm) => have.has(nm));
      if (want.length && want.length === r.heldNames.length && want.every((nm) => r.heldNames.includes(nm))) q.atoms = run.atoms;
    }
    // Likewise a glycine holding its backbone ("all" of it) belongs to a backbone-only run.
    if (run?.atoms === "backbone" && q.atoms === "all" && isBackboneOnly(r)) {
      q.atoms = "backbone";
      if (q.keep === "all" && run.keep === "backbone") q.keep = "backbone";
    }
    // A glycine holding its backbone at the head of a run (the chain's first residue) joins the backbone-only run
    // after it, as one inside a run does.
    if (run?.glycine && run.count === 1 && run.atoms === "all" && q.atoms === "backbone"
      && run.keep === (q.keep === "backbone" ? "all" : q.keep) && run.anywhere === q.anywhere) {
      run.atoms = "backbone";
      if (run.keep === "all") run.keep = q.keep;
    }
    const sameRun = run && run.kind === q.kind && run.keep === q.keep && run.anywhere === q.anywhere && run.atoms === q.atoms
      && run.ss === r.ss && run.rasa === r.rasa && run.inter === r.inter
      && r.resId === run.end + 1
      && ((!run.src && !src) || (run.src && src && src[0] === run.src[0] && src[1] === (run.srcEnd as number) + 1));
    if (run && sameRun) {
      run.end = r.resId;
      run.count += 1;
      if (src) run.srcEnd = src[1];
      run.atomIndices.push(...r.atomIndices);
    } else {
      run = {
        kind: q.kind, keep: q.keep, anywhere: q.anywhere, atoms: q.atoms,
        ss: r.ss, rasa: r.rasa, inter: r.inter,
        start: r.resId, end: r.resId, count: 1, atomIndices: [...r.atomIndices], hotspots: [],
        src, srcEnd: src?.[1] ?? null, glycine: isBackboneOnly(r),
      };
      out.push(run);
    }
    if (r.hotspots > 0) run.hotspots.push(r.resId);
  }
  const pieces: PieceSpec[] = [];
  for (const p of out) {
    if (p.kind === "new") { pieces.push(p); continue; }
    const { src, srcEnd, glycine: _glycine, ...piece } = p;
    if (src && (src[1] !== p.start || srcEnd !== p.end)) {
      piece.source = src[1] === srcEnd ? `${src[0]}${src[1]}` : `${src[0]}${src[1]}–${srcEnd}`;
    }
    pieces.push(piece);
  }
  return pieces;
}

/** A residue as typed ("A56", "A115-123", "A56(CG,OH)"). */
export type TypedResidue = { chain: string; resId: number; atoms?: string[] };

/**
 * Residues as typed: "A56, A115-123, B7" (chain letter then number or range; a bare number takes `defaultChain`), in
 * the order typed. A residue may name some of its atoms: "A56(CG,OH)". Returns
 * `{residues: [{chain, resId, atoms?}], bad: ['tokens not understood']}`.
 */
export function parseResidueList(
  text: string | null | undefined,
  defaultChain: string | null = null,
): { residues: TypedResidue[]; bad: string[] } {
  const residues: TypedResidue[] = [];
  const bad: string[] = [];
  // Atom lists may hold commas: join their names with "+" so they stay inside one token.
  const joined = String(text ?? "").replace(/\(([^)]*)\)/g, (_, names: string) => `(${names.split(/[\s,;+]+/).filter(Boolean).join("+")})`);
  for (const token of joined.split(/[\s,;]+/).filter(Boolean)) {
    const m = /^([A-Za-z]{1,4})?:?(-?\d+)(?:[-–](-?\d+))?(?:\(([^()\s]+)\))?$/.exec(token.replace(/^([A-Za-z]+)(\d)/, "$1:$2"));
    const chain = m?.[1] ?? defaultChain;
    if (!m || !chain) { bad.push(token.replace(/\+/g, ",")); continue; }
    const lo = Number(m[2]);
    const hi = m[3] == null ? lo : Number(m[3]);
    if (hi < lo || hi - lo > 2000) { bad.push(token.replace(/\+/g, ",")); continue; }
    const atomNames = m[4] ? m[4].split("+").map((a) => a.toUpperCase()) : null;
    for (let id = lo; id <= hi; id += 1) residues.push(atomNames ? { chain, resId: id, atoms: atomNames } : { chain, resId: id });
  }
  return { residues, bad };
}

/**
 * The inverse of parseResidueList for one chain: [56, 115, 116, 117] -> "A56, A115–117". `atomsOf` (resId -> atom
 * names) marks residues meant on some atoms only: "A56(CG,OH)".
 */
export function formatResidueList(
  chain: string,
  resIds: Iterable<number>,
  atomsOf: Map<number, string[]> | null = null,
): string {
  const ids = [...new Set(resIds)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let k = 0; k < ids.length;) {
    const named = atomsOf?.get(ids[k]);
    if (named?.length) {
      parts.push(`${chain}${ids[k]}(${named.join(",")})`);
      k += 1;
      continue;
    }
    let j = k;
    while (j + 1 < ids.length && ids[j + 1] === ids[j] + 1 && !atomsOf?.get(ids[j + 1])?.length) j += 1;
    parts.push(j === k ? `${chain}${ids[k]}` : `${chain}${ids[k]}–${ids[j]}`);
    k = j + 1;
  }
  return parts.join(", ");
}

type TaskInput = {
  polymers: ChainSpec[];
  ligands: ChainSpec[];
  anyCondition: boolean;
  designedMax: number;
  predicted: number;
  partialDiffusion: boolean;
  partialPercent: number;
};

function inferTask(
  { polymers, ligands, anyCondition, designedMax, predicted, partialDiffusion, partialPercent }: TaskInput,
): TaskInfo {
  const T = (key: TaskKey, label: string, detail: string): TaskInfo => ({ key, label, detail });
  if (partialDiffusion) {
    return T("partial", "Diversify (partial diffusion)", `Starts ${partialPercent}% of the way from this structure.`);
  }
  if (!polymers.length && !ligands.length) return T("empty", "Nothing loaded", "");
  // Kept coordinates with nothing designed: only residues missing from the structure (if any) are built.
  if (designedMax === 0 && (predicted === 0 || polymers.some((c) => c.fixed > 0))) return T("nothing", "Nothing to design", "");
  if (designedMax === 0) {
    return T("fold", "Fold from sequence", "Sequences kept; the model predicts the structure.");
  }
  // A structure as fetched (no conditions, no new residues) is "everything redesigned", whatever it contains.
  if (!anyCondition && !polymers.some((c) => c.segments.length) && !polymers.every((c) => c.role === "new")) {
    return T("redesign_all", "Full redesign", "No constraints: structure and sequence are both redesigned.");
  }
  const roles = new Set(polymers.map((c) => c.role));
  const unindexed = polymers.some((c) => c.unindexed > 0);
  const hasLigand = ligands.length > 0;
  const fixedChains = polymers.filter((c) => c.role === "fixed");
  const designedChains = polymers.filter((c) => c.role !== "fixed");
  if (polymers.every((c) => c.role === "backbone")) {
    return T("inverse", "Redesign sequence", "Backbone kept; new sequence and side chains.");
  }
  if (unindexed && hasLigand) return T("enzyme", "Enzyme design", "Catalytic residues placed around the ligand.");
  if (fixedChains.length && designedChains.length) {
    // A framework is most of a chain kept by sequence; a few kept residues in a designed chain are a motif.
    const framework = designedChains.some((c) => c.seqFixed > c.designed + c.segments.reduce((t, g) => t + g.min, 0));
    return framework
      ? T("antibody", "Antibody / VHH design", "Framework sequence kept; loops designed against the target.")
      : T("binder", "Binder design", "New protein designed to bind the fixed target.");
  }
  if (hasLigand && !fixedChains.length) {
    return T("sm_binder", "Small-molecule binder", "Protein designed around the ligand.");
  }
  if (roles.has("motif") || unindexed) {
    return T("motif", "Motif scaffolding", "Fixed motif residues kept; scaffold designed around them.");
  }
  if (!anyCondition) {
    const onlyNew = polymers.every((c) => c.role === "new");
    return onlyNew
      ? T("unconditional", "Protein from scratch", "No constraints: a new fold of the given length.")
      : T("redesign_all", "Full redesign", "No constraints: structure and sequence are both redesigned.");
  }
  return T("custom", "Custom design", "Mixed constraints; see the chains below.");
}
