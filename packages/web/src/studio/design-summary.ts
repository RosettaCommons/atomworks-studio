/**
 * What a document asks the model to design, read back from the conditions already on it: a role per chain, the
 * lengths, a contig string and the task they amount to.
 *
 * Pure — the sequence the server sends in, a plain object out — so it can be recomputed on every edit and pinned in
 * tests against the bundled examples. The conditions it reads are the ones the sequence already carries per residue:
 * `coordinate` holds a residue in place, `sequence` keeps its identity, `index` fixes its position in the chain
 * (every residue has it unless it belongs to an unindexed group), and `hotspot` marks an interface residue.
 */
import type { SequenceChain, SequenceResidue, SequenceSegment } from "../types";

export type ChainRole = "fixed" | "backbone" | "folded" | "designed" | "motif" | "new" | "ligand";

export const ROLE_LABELS: Record<ChainRole, string> = {
  fixed: "Fixed",
  backbone: "Sequence redesigned",
  folded: "Fold predicted",
  designed: "Redesigned",
  motif: "Partly fixed",
  new: "New chain",
  ligand: "Ligand",
};

export type ChainSummary = {
  id: string;
  role: ChainRole;
  residues: number;
  fixed: number;
  sequenceKept: number;
  designed: number;
  unindexed: number;
  hotspots: number;
  ligands: string[];
  segments: Array<{ minimum: number; maximum: number }>;
  atomIndices: number[];
  lengthMin: number;
  lengthMax: number;
  contig: string;
};

export type DesignTask = { key: string; label: string; detail: string };

export type DesignSummary = {
  task: DesignTask;
  chains: ChainSummary[];
  designedMin: number;
  designedMax: number;
  totalMin: number;
  totalMax: number;
  contig: string;
  warnings: string[];
};

const isResidue = (item: SequenceResidue | SequenceSegment): item is SequenceResidue => item.kind === "residue";
// Polymer residues carry a one-letter code; ligands and ions keep their full name ("SAM", "ZN").
const isPolymer = (residue: SequenceResidue): boolean => residue.code.length === 1;

function summariseChain(chain: SequenceChain): ChainSummary {
  const residues = chain.items.filter(isResidue);
  const polymer = residues.filter(isPolymer);
  const segments = chain.items.filter((item): item is SequenceSegment => item.kind === "segment");
  const has = (residue: SequenceResidue, condition: string): boolean => residue.conditions.includes(condition);

  const fixed = polymer.filter(residue => has(residue, "coordinate"));
  const sequenceKept = polymer.filter(residue => has(residue, "sequence"));
  const unindexed = polymer.filter(residue => !has(residue, "index"));
  const hotspots = residues.filter(residue => has(residue, "hotspot"));
  const ligands = residues.filter(residue => !isPolymer(residue));

  let role: ChainRole;
  if (!polymer.length) role = segments.length ? "new" : "ligand";
  else if (segments.length || (fixed.length && fixed.length < polymer.length)) role = "motif";
  else if (fixed.length === polymer.length) role = sequenceKept.length === polymer.length ? "fixed" : "backbone";
  else if (sequenceKept.length === polymer.length) role = "folded";
  else role = sequenceKept.length ? "motif" : "designed";

  // Contig: runs of held residues as "A12-20", designed runs as a count, segments as their length range. Unindexed
  // residues are bracketed — the model places them anywhere, so they do not pin a position.
  const pieces: string[] = [];
  let run: { kind: string; start: number; end: number; count: number } | null = null;
  // Classic contigs name a chain with a single letter ("A5-20"). Chain ids like "A_1" would run into the residue
  // number, so those take a colon instead.
  const label = (first: number, last: number): string => {
    const residues = first === last ? `${first}` : `${first}-${last}`;
    return /^[A-Za-z]$/.test(chain.chain_id) ? `${chain.chain_id}${residues}` : `${chain.chain_id}:${residues}`;
  };
  const flush = (): void => {
    if (!run) return;
    const range = label(run.start, run.end);
    pieces.push(run.kind === "fixed" ? range : run.kind === "unindexed" ? `[${range}]` : String(run.count));
    run = null;
  };
  for (const item of chain.items) {
    if (!isResidue(item)) {
      flush();
      pieces.push(item.minimum === item.maximum ? String(item.minimum) : `${item.minimum}-${item.maximum}`);
      continue;
    }
    if (!isPolymer(item)) continue;
    const kind = !item.conditions.includes("index") ? "unindexed"
      : item.conditions.includes("coordinate") ? "fixed" : "designed";
    if (run && run.kind === kind && (kind === "designed" || item.residue_id === run.end + 1)) {
      run.end = item.residue_id;
      run.count += 1;
    } else {
      flush();
      run = { kind, start: item.residue_id, end: item.residue_id, count: 1 };
    }
  }
  flush();

  const placed = polymer.length - unindexed.length;
  const span = (pick: (segment: SequenceSegment) => number): number =>
    segments.reduce((total, segment) => total + pick(segment), 0);
  return {
    id: chain.chain_id,
    role,
    residues: polymer.length,
    fixed: fixed.length,
    sequenceKept: sequenceKept.length,
    designed: polymer.filter(residue => !has(residue, "coordinate") || !has(residue, "sequence")).length,
    unindexed: unindexed.length,
    hotspots: hotspots.length,
    ligands: ligands.map(residue => residue.residue_name),
    segments: segments.map(({ minimum, maximum }) => ({ minimum, maximum })),
    atomIndices: chain.items.flatMap(item => item.atom_indices),
    lengthMin: placed + span(segment => segment.minimum),
    lengthMax: placed + span(segment => segment.maximum),
    contig: pieces.join("/"),
  };
}

function inferTask(chains: ChainSummary[], designedMax: number): DesignTask {
  const task = (key: string, label: string, detail: string): DesignTask => ({ key, label, detail });
  const polymers = chains.filter(chain => chain.role !== "ligand");
  const ligands = chains.filter(chain => chain.role === "ligand");
  if (!polymers.length && !ligands.length) return task("empty", "Nothing loaded", "");
  if (!designedMax) return task("nothing", "Nothing to design", "Everything here is held fixed.");

  const held = polymers.filter(chain => chain.role === "fixed");
  const free = polymers.filter(chain => chain.role !== "fixed");
  const unindexed = polymers.some(chain => chain.unindexed > 0);
  if (polymers.every(chain => chain.role === "backbone")) {
    return task("inverse", "Redesign sequence", "Backbone kept; new sequence and side chains.");
  }
  if (polymers.every(chain => chain.role === "folded")) {
    return task("fold", "Fold from sequence", "Sequences kept; the model predicts the structure.");
  }
  if (unindexed && ligands.length) {
    return task("enzyme", "Enzyme design", "Catalytic residues placed around the ligand.");
  }
  if (held.length && free.length) {
    return free.some(chain => chain.sequenceKept > 0)
      ? task("antibody", "Antibody / VHH design", "Framework sequence kept; loops designed against the target.")
      : task("binder", "Binder design", "New protein designed to bind the fixed target.");
  }
  if (ligands.length && !held.length) {
    return task("sm_binder", "Small-molecule binder", "Protein designed around the ligand.");
  }
  if (polymers.some(chain => chain.role === "motif")) {
    return task("motif", "Motif scaffolding", "Fixed motif residues kept; scaffold designed around them.");
  }
  if (polymers.every(chain => chain.role === "new")) {
    return task("unconditional", "Protein from scratch", "No constraints: a new fold of the length you choose.");
  }
  if (polymers.every(chain => chain.role === "designed")) {
    return task("redesign_all", "Full redesign", "Nothing is held: structure and sequence are both redesigned.");
  }
  return task("custom", "Custom design", "Mixed constraints; see the chains below.");
}

export function designSummary(sequence: SequenceChain[]): DesignSummary {
  const chains = sequence.map(summariseChain);
  const polymers = chains.filter(chain => chain.role !== "ligand");
  const total = (pick: (chain: ChainSummary) => number): number =>
    polymers.reduce((sum, chain) => sum + pick(chain), 0);
  const segmentSpan = (pick: (segment: { minimum: number; maximum: number }) => number) =>
    total(chain => chain.segments.reduce((sum, segment) => sum + pick(segment), 0));

  const designedMin = total(chain => chain.designed) + segmentSpan(segment => segment.minimum);
  const designedMax = total(chain => chain.designed) + segmentSpan(segment => segment.maximum);
  const task = inferTask(chains, designedMax);

  const warnings: string[] = [];
  if (task.key === "redesign_all") {
    warnings.push(
      "Nothing in this structure is held, so a design run will rebuild all of it. Hold what you want to keep, "
      + "or run partial diffusion to stay near this fold.",
    );
  } else if (task.key === "nothing") {
    warnings.push("Everything is held fixed, so there is nothing to design. Free a chain or add new residues.");
  }
  if (task.key === "binder" && !chains.some(chain => chain.hotspots > 0)) {
    warnings.push(
      "No hotspots are marked on the target. Without them the model often returns a copy of the target "
      + "instead of a binder — select a few interface residues and mark them as hotspots.",
    );
  }

  const ligandNames = chains.flatMap(chain => chain.ligands);
  const contig = polymers.filter(chain => chain.contig).map(chain => chain.contig).join("/0 ");
  return {
    task,
    chains,
    designedMin,
    designedMax,
    totalMin: total(chain => chain.lengthMin),
    totalMax: total(chain => chain.lengthMax),
    contig: ligandNames.length ? `${contig} + ${ligandNames.join(", ")}` : contig,
    warnings,
  };
}
