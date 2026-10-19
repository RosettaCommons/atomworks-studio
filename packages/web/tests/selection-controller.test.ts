import assert from "node:assert/strict";
import { test } from "node:test";
import { SelectionController } from "../src/selection-controller.ts";

Object.defineProperty(globalThis, "document", { value: { querySelector: () => null }, configurable: true });

const makeSelection = () => new SelectionController(() => undefined, () => {});
const sorted = (atoms: Iterable<number>) => [...atoms].sort((a, b) => a - b);

test("residue and atom picks only change their targets, regardless of earlier clicks", () => {
  const selection = makeSelection();
  selection.toggle([0, 1, 2]);
  selection.toggle([11]);
  assert.deepEqual(sorted(selection.values), [0, 1, 2, 11]);
  selection.toggle([1]);
  assert.deepEqual(sorted(selection.values), [0, 2, 11]);
  selection.toggle([11]);
  assert.deepEqual(sorted(selection.values), [0, 2]);
  selection.toggle([0, 1, 2]);
  assert.deepEqual(sorted(selection.values), [0, 1, 2]);
  selection.toggle([0, 1, 2]);
  assert.equal(selection.size, 0);
});

test("all small selection/target combinations obey the target-only rule", () => {
  const subsets = Array.from({ length: 16 }, (_, mask) => [0, 1, 2, 3].filter(i => mask & (1 << i)));
  for (const selected of subsets) {
    for (const target of subsets) {
      const selection = makeSelection();
      selection.replace(selected);
      const removed = selection.toggle(target);
      const allSelected = target.length > 0 && target.every(i => selected.includes(i));
      const expected = allSelected
        ? selected.filter(i => !target.includes(i)) : [...new Set([...selected, ...target])];
      assert.equal(removed, allSelected);
      assert.deepEqual(sorted(selection.values), sorted(expected));
      for (const atom of [0, 1, 2, 3].filter(i => !target.includes(i))) {
        assert.equal(selection.values.has(atom), selected.includes(atom), "outside atoms never change");
      }
    }
  }
});

test("disjoint residue/atom picks commute and identical current state has identical behavior", () => {
  for (const first of [[0], [0, 1], [0, 1, 2]]) {
    for (const second of [[10], [10, 11], [10, 11, 12]]) {
      const forward = makeSelection(), reverse = makeSelection();
      forward.toggle(first); forward.toggle(second);
      reverse.toggle(second); reverse.toggle(first);
      assert.deepEqual(sorted(forward.values), sorted(reverse.values));
      const replaced = makeSelection();
      replaced.replace(forward.values);
      for (const target of [[1], [10], [0, 1, 2]]) {
        forward.toggle(target); reverse.toggle(target); replaced.toggle(target);
        assert.deepEqual(sorted(forward.values), sorted(reverse.values));
        assert.deepEqual(sorted(forward.values), sorted(replaced.values));
      }
    }
  }
});

test("asynchronous picks commit in click order", async () => {
  const selection = makeSelection();
  let release!: (atoms: number[]) => void;
  const first = selection.applyResolved("toggle", () => new Promise<number[]>(resolve => { release = resolve; }));
  let secondStarted = false;
  const second = selection.applyResolved("toggle", async () => { secondStarted = true; return [1]; });
  await Promise.resolve();
  assert.equal(secondStarted, false);
  release([0, 1, 2]);
  await Promise.all([first, second]);
  assert.deepEqual(sorted(selection.values), [0, 2]);
});

for (const action of ["clear", "replace", "toggle", "add", "scope", "document"] as const) {
  test(`${action} cancels pending picks; late responses cannot overwrite newer intent`, async () => {
    const selection = makeSelection();
    let release!: (atoms: number[]) => void;
    const pending = selection.applyResolved("toggle", () => new Promise<number[]>(resolve => { release = resolve; }));
    await Promise.resolve();
    switch (action) {
      case "clear": selection.clear(); break;
      case "replace": selection.replace([7]); break;
      case "toggle": selection.toggle([7]); break;
      case "add": selection.add([7]); break;
      case "scope": selection.setScope("atom"); break;
      case "document": selection.retainValid(2); break;
    }
    const expected = [...selection.values];
    await selection.applyResolved("toggle", async () => [8]);
    release([0, 1]);
    assert.equal(await pending, null);
    assert.deepEqual(sorted(selection.values), sorted([...expected, 8]));
  });
}

test("failed resolution leaves the selection intact and does not poison later picks", async () => {
  const selection = makeSelection();
  selection.replace([4]);
  const failed = selection.applyResolved("toggle", async () => { throw new Error("network failure"); });
  const next = selection.applyResolved("toggle", async () => [5]);
  await assert.rejects(failed, /network failure/);
  await next;
  assert.deepEqual(sorted(selection.values), [4, 5]);
});


test("a replacement query supersedes earlier picks and later picks follow its result", async () => {
  const selection = makeSelection();
  let releasePick!: (atoms: number[]) => void;
  const oldPick = selection.applyResolved("toggle", () => new Promise<number[]>(resolve => { releasePick = resolve; }));
  await Promise.resolve();
  let releaseQuery!: (atoms: number[]) => void;
  const query = selection.applyResolved("replace", () => new Promise<number[]>(resolve => { releaseQuery = resolve; }));
  const nextPick = selection.applyResolved("toggle", async () => [9]);
  await Promise.resolve();
  releaseQuery([4, 5]);
  await Promise.all([query, nextPick]);
  releasePick([0, 1]);
  assert.equal(await oldPick, null);
  assert.deepEqual(sorted(selection.values), [4, 5, 9]);
});

test("Clear cancels an in-flight replacement query", async () => {
  const selection = makeSelection();
  let release!: (atoms: number[]) => void;
  const query = selection.applyResolved("replace", () => new Promise<number[]>(resolve => { release = resolve; }));
  await Promise.resolve();
  selection.clear();
  release([1, 2]);
  assert.equal(await query, null);
  assert.equal(selection.size, 0);
});
