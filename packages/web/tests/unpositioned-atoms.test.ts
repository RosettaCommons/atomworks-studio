import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { unpositionedAtomIndices } from "../src/viewers/unpositioned-atoms.ts";

test("dummy origin coordinates are hidden but generated coordinates stay visible", () => {
  const cif = `data_test
loop_
_atom_site.atom_array_index
_atom_site.Cartn_x
_atom_site.Cartn_y
_atom_site.Cartn_z
0 0 0 0
1 1 0 0
2 0 0 0
#
loop_
_condition_coordinate_1_atom.idx0
_condition_coordinate_1_atom.val0
_condition_coordinate_1_atom.val1
_condition_coordinate_1_atom.val2
0 nan nan nan
1 nan nan nan
2 0 0 0
#`;
  assert.deepEqual(unpositionedAtomIndices(cif), [0]);
  assert.deepEqual(unpositionedAtomIndices(cif.replace("0 0 0 0\n", "0 2 3 4\n")), []);
  const nimInput = readFileSync(new URL("../../../packages/api/annotation_studio/examples/enzyme_design.cif", import.meta.url), "utf8");
  assert.deepEqual(unpositionedAtomIndices(nimInput), [5, 8, 9, 10, 11, 12, 13]);
});
