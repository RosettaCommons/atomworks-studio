import assert from "node:assert/strict";
import test from "node:test";
import { alignToInput, fitRigid, inputAnchors, moveCif } from "../src/design-card/align.ts";
import { parseCifToAtoms } from "../src/design-card/cif.ts";

const HEAD = ["group_PDB", "id", "type_symbol", "label_atom_id", "label_comp_id", "label_asym_id", "label_entity_id", "label_seq_id",
  "auth_seq_id", "auth_asym_id", "Cartn_x", "Cartn_y", "Cartn_z", "occupancy", "B_iso_or_equiv", "pdbx_PDB_model_num"];
const POINTS: [number, number, number][] = [[0, 0, 0], [3.8, 0, 0], [5, 3.2, 1], [8, 4, 2.5], [9, 7, 1], [12, 7.5, 3]];
const cif = (points: number[][], group?: number[]): string => [
  "data_t", "loop_", ...HEAD.map((h) => `_atom_site.${h}`), ...(group ? ["_atom_site.condition_CoordinateGroup_1_atom"] : []),
  ...points.map((p, i) => `ATOM ${i + 1} C CA ALA A 1 ${i + 1} ${i + 1} A ${p[0].toFixed(3)} ${p[1].toFixed(3)} ${p[2].toFixed(3)} 1.00 0.00 1${group ? ` ${group[i]}` : ""}`),
  "#", "",
].join("\n");
// A rotation of 90 degrees about z, then a shift.
const place = (p: number[]): number[] => [-p[1] + 20, p[0] - 5, p[2] + 30];

test("fitRigid recovers a rotation and a shift", () => {
  const fit = fitRigid(POINTS.map((p) => place(p) as [number, number, number]), POINTS);
  assert.ok(fit.before > 10);
  assert.ok(fit.after < 1e-6);
});

test("a design placed elsewhere is brought back onto the input's held atoms, trajectory with it", () => {
  const input = parseCifToAtoms(cif(POINTS, [2, 2, 2, -1, -1, -1]));
  const anchors = inputAnchors(input);
  assert.equal(anchors.size, 3);
  const design = cif(POINTS.map(place));
  const out = alignToInput(anchors, design, design);
  const moved = parseCifToAtoms(out.cif);
  POINTS.forEach((p, i) => p.forEach((c, d) => assert.ok(Math.abs(moved.coord[i][d] - c) < 2e-3)));
  assert.equal(out.trajectoryCif, out.cif);
});

test("a design already in the input's frame, one with too few held atoms, and an unreadable one are left alone", () => {
  const anchors = inputAnchors(parseCifToAtoms(cif(POINTS, [2, 2, 2, -1, -1, -1])));
  const same = cif(POINTS);
  assert.equal(alignToInput(anchors, same).cif, same);
  assert.equal(alignToInput(inputAnchors(parseCifToAtoms(cif(POINTS, [2, 2, -1, -1, -1, -1]))), cif(POINTS.map(place))).cif, cif(POINTS.map(place)));
  assert.equal(moveCif("not a cif", (p) => p), "not a cif");
});

test("moveCif can move a subset of atoms, addressed by their atom_site row order", () => {
  const before = parseCifToAtoms(cif(POINTS));
  const moved = parseCifToAtoms(moveCif(cif(POINTS), (p) => [p[0] + 10, p[1], p[2]], (index) => index === 1 || index === 4));
  POINTS.forEach((_p, i) => {
    const shift = i === 1 || i === 4 ? 10 : 0;
    assert.ok(Math.abs(moved.coord[i][0] - (before.coord[i][0] + shift)) < 2e-3,
      `atom ${i} x moved by ${moved.coord[i][0] - before.coord[i][0]}, expected ${shift}`);
    assert.ok(Math.abs(moved.coord[i][1] - before.coord[i][1]) < 2e-3);
    assert.ok(Math.abs(moved.coord[i][2] - before.coord[i][2]) < 2e-3);
  });
});

test("moveCif with no selector still moves every atom", () => {
  const moved = parseCifToAtoms(moveCif(cif(POINTS), (p) => [p[0], p[1], p[2] + 1]));
  POINTS.forEach((p, i) => assert.ok(Math.abs(moved.coord[i][2] - (p[2] + 1)) < 2e-3));
});
