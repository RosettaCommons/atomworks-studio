import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { carbonIndicesByChain, unpositionedAtomIndices } from "../src/viewers/unpositioned-atoms.ts";

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
  assert.deepEqual(unpositionedAtomIndices(nimInput), [0, 3, 4, 5, 6, 7, 8, 9, 12, 15, 16, 17, 18, 19, 20]);
});


test("missing atom_site coordinates are excluded even without saved coordinate conditions", () => {
  const cif = `data_missing
loop_
_atom_site.atom_array_index
_atom_site.Cartn_x
_atom_site.Cartn_y
_atom_site.Cartn_z
0 0 0 0
1 nan nan nan
2 1 ? 3
3 1 2 .
4 1 2 3
#`;
  assert.deepEqual(unpositionedAtomIndices(cif), [1, 2, 3]);
});


test("single-atom CIF categories hide unresolved placeholders and retain finite atoms", () => {
  const cif = readFileSync(new URL("../../../packages/api/annotation_studio/examples/unconditional.cif", import.meta.url), "utf8");
  assert.deepEqual(unpositionedAtomIndices(cif), [0]);
  const positioned = cif.replace(/(_atom_site\.Cartn_[xyz]\s+)nan/g, "$1" + "2.0");
  assert.deepEqual(unpositionedAtomIndices(positioned), []);
  const placeholder = positioned.replace(/(_atom_site\.Cartn_[xyz]\s+)2\.0/g, "$1" + "0.0");
  assert.deepEqual(unpositionedAtomIndices(placeholder), [0]);
});


test("the unconditioned SAM conformer is visible while its protein segment stays unpositioned", () => {
  const cif = readFileSync(new URL("../../../packages/api/annotation_studio/examples/small_molecule_binder.cif", import.meta.url), "utf8");
  assert.deepEqual(unpositionedAtomIndices(cif), [0]);
});

test("chain carbons are grouped by label_asym_id in document indices, heteroatoms left out", () => {
  const cif = `data_test
loop_
_atom_site.atom_array_index
_atom_site.label_asym_id
_atom_site.type_symbol
_atom_site.Cartn_x
_atom_site.Cartn_y
_atom_site.Cartn_z
0 A_1 N 1 0 0
1 A_1 C 2 0 0
2 A_1 C 3 0 0
3 B_1 C 4 0 0
4 B_1 O 5 0 0
5 . C 6 0 0
#
`;
  const byChain = carbonIndicesByChain(cif);
  // Only carbons, so the palette matches the Mol* theme's carbonOnly colouring.
  assert.deepEqual(byChain.get("A_1"), [1, 2]);
  assert.deepEqual(byChain.get("B_1"), [3]);
  // A chain id of "." is absent, not a chain of its own.
  assert.equal(byChain.has("."), false);
  assert.deepEqual([...byChain.keys()], ["A_1", "B_1"]);
});

test("without a chain or element column there is nothing to colour by", () => {
  const cif = `data_test
loop_
_atom_site.atom_array_index
_atom_site.Cartn_x
_atom_site.Cartn_y
_atom_site.Cartn_z
0 1 0 0
#
`;
  assert.equal(carbonIndicesByChain(cif).size, 0);
});
