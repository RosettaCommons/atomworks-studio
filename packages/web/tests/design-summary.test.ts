import assert from "node:assert/strict";
import test from "node:test";
import { designSummary } from "../src/studio/design-summary.ts";
import type { SequenceChain, SequenceResidue, SequenceSegment } from "../src/types.ts";

// Shapes taken from the bundled examples as the API serves them: every residue carries "index" unless it belongs to
// an unindexed group, "coordinate" holds it in place and "sequence" keeps its identity.
const residue = (id: number, conditions: string[], code = "A", name = "ALA"): SequenceResidue => ({
  kind: "residue", atom_indices: [id], residue_id: id, residue_name: name, code, conditions,
});
const run = (from: number, to: number, conditions: string[]): SequenceResidue[] =>
  Array.from({ length: to - from + 1 }, (_, offset) => residue(from + offset, conditions));
const segment = (minimum: number, maximum: number): SequenceSegment => ({
  kind: "segment", atom_indices: [], minimum, maximum, realized: false, realized_length: null,
});
const chain = (chain_id: string, items: SequenceChain["items"]): SequenceChain => ({ chain_id, items });

const HELD = ["coordinate", "index", "sequence"];

test("a fixed target plus a new chain is binder design, and warns when no hotspots are marked", () => {
  const summary = designSummary([
    chain("A_1", run(1, 115, HELD)),
    chain("B_1", [segment(50, 120)]),
  ]);
  assert.equal(summary.task.key, "binder");
  assert.deepEqual(summary.chains.map(entry => entry.role), ["fixed", "new"]);
  assert.equal(summary.contig, "A_1:1-115/0 50-120");
  assert.deepEqual([summary.totalMin, summary.totalMax], [165, 235]);
  assert.match(summary.warnings.join(" "), /copy of the target/);
});

test("marking hotspots on the target clears the binder warning", () => {
  const target = [...run(1, 112, HELD), ...run(113, 115, [...HELD, "hotspot"])];
  const summary = designSummary([chain("A_1", target), chain("B_1", [segment(50, 120)])]);
  assert.equal(summary.task.key, "binder");
  assert.equal(summary.chains[0].hotspots, 3);
  assert.deepEqual(summary.warnings, []);
});

test("a few held residues among new segments is motif scaffolding", () => {
  const summary = designSummary([chain("A_1", [
    segment(10, 20), residue(1, HELD), segment(15, 30), residue(3, HELD), segment(15, 30), residue(5, HELD), segment(10, 20),
  ])]);
  assert.equal(summary.task.key, "motif");
  assert.equal(summary.chains[0].role, "motif");
  assert.equal(summary.contig, "10-20/A_1:1/15-30/A_1:3/15-30/A_1:5/10-20");
  assert.deepEqual([summary.totalMin, summary.totalMax], [53, 103]);
});

test("a structure with no conditions is a full redesign, and says so", () => {
  const summary = designSummary([chain("A_1", run(1, 59, ["index"]))]);
  assert.equal(summary.task.key, "redesign_all");
  assert.equal(summary.chains[0].role, "designed");
  assert.equal(summary.contig, "59");
  assert.match(summary.warnings.join(" "), /rebuild all of it/);
});

test("holding every backbone but no sequence is sequence redesign", () => {
  const summary = designSummary([chain("A_1", run(1, 59, ["coordinate", "index"]))]);
  assert.equal(summary.task.key, "inverse");
  assert.equal(summary.chains[0].role, "backbone");
  assert.deepEqual(summary.warnings, []);
});

test("a ligand with a designed chain is a small-molecule binder, and the ligand is named in the contig", () => {
  const summary = designSummary([
    chain("A_1", [segment(60, 120)]),
    chain("B_1", [residue(1, ["index", "sequence"], "SAM", "SAM")]),
  ]);
  assert.equal(summary.task.key, "sm_binder");
  assert.deepEqual(summary.chains.map(entry => entry.role), ["new", "ligand"]);
  assert.match(summary.contig, /\+ SAM$/);
  // The ligand is not a polymer, so it adds nothing to the designed length.
  assert.deepEqual([summary.totalMin, summary.totalMax], [60, 120]);
});

test("unindexed residues are bracketed in the contig and do not pin a length", () => {
  const summary = designSummary([
    chain("A_1", [residue(1, ["coordinate", "sequence"]), segment(40, 80)]),
    chain("B_1", [residue(1, ["coordinate", "index", "sequence"], "ORO", "ORO")]),
  ]);
  assert.equal(summary.task.key, "enzyme");
  assert.equal(summary.chains[0].unindexed, 1);
  assert.match(summary.chains[0].contig, /^\[A_1:1\]\/40-80$/);
  assert.deepEqual([summary.totalMin, summary.totalMax], [40, 80]);
});

test("a document with everything held has nothing to design", () => {
  const summary = designSummary([chain("A_1", run(1, 20, HELD))]);
  assert.equal(summary.task.key, "nothing");
  assert.match(summary.warnings.join(" "), /nothing to design/);
});

test("an empty document reports nothing loaded without warning noise", () => {
  const summary = designSummary([]);
  assert.equal(summary.task.key, "empty");
  assert.deepEqual(summary.warnings, []);
  assert.equal(summary.contig, "");
});

test("a single-letter chain keeps the classic contig form, longer ids take a separator", () => {
  const plain = designSummary([chain("A", run(1, 12, HELD))]);
  assert.equal(plain.chains[0].contig, "A1-12");
  const suffixed = designSummary([chain("A_1", run(1, 12, HELD))]);
  assert.equal(suffixed.chains[0].contig, "A_1:1-12");
});
