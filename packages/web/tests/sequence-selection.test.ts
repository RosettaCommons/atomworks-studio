import assert from "node:assert/strict";
import test from "node:test";
import { sequenceRangeSelection } from "../src/studio/sequence-selection.ts";

const residues = [
  { atoms: [0, 1] }, { atoms: [2] }, { atoms: [3, 4] },
  { atoms: [5] }, { atoms: [6, 7] },
];
const sorted = (values: ReadonlySet<number>) => [...values].sort((a, b) => a - b);

test("a pointer jump selects every intervening residue in either direction", () => {
  for (const [start, end] of [[0, 4], [4, 0]]) {
    assert.deepEqual(sorted(sequenceRangeSelection(residues, start, end, new Set(), false)),
      [0, 1, 2, 3, 4, 5, 6, 7]);
  }
});

test("backtracking shrinks the range; revisiting an endpoint cannot toggle holes", () => {
  const baseline = new Set<number>();
  for (const end of [4, 2, 4, 2]) {
    const expected = end === 4 ? [2, 3, 4, 5, 6, 7] : [2, 3, 4];
    assert.deepEqual(sorted(sequenceRangeSelection(residues, 1, end, baseline, false)), expected);
  }
  assert.deepEqual(sorted(sequenceRangeSelection(residues, 1, 0, baseline, false)), [0, 1, 2]);
});

test("additive dragging preserves the initial selection without toggling overlaps", () => {
  const baseline = new Set([0, 1, 5]);
  assert.deepEqual(sorted(sequenceRangeSelection(residues, 2, 4, baseline, false)),
    [0, 1, 3, 4, 5, 6, 7]);
  assert.deepEqual(sorted(sequenceRangeSelection(residues, 2, 2, baseline, false)), [0, 1, 3, 4, 5]);
  assert.deepEqual(sorted(baseline), [0, 1, 5]);
});

test("subtractive dragging restores the initial selection when the range contracts", () => {
  const baseline = new Set([0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(sorted(sequenceRangeSelection(residues, 1, 3, baseline, true)), [0, 1, 6, 7]);
  assert.deepEqual(sorted(sequenceRangeSelection(residues, 1, 1, baseline, true)), [0, 1, 3, 4, 5, 6, 7]);
  assert.equal(baseline.size, 8);
});


test("adding a range completes partially selected residues and preserves unrelated atoms", () => {
  const baseline = new Set([0, 3, 99]);
  assert.deepEqual(sorted(sequenceRangeSelection(residues, 0, 2, baseline, false)), [0, 1, 2, 3, 4, 99]);
  assert.deepEqual(sorted(sequenceRangeSelection(residues, 0, 0, baseline, false)), [0, 1, 3, 99]);
  assert.deepEqual(sorted(baseline), [0, 3, 99]);
});
