import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseCifToAtoms } from "../src/design-card/cif.ts";
import { MAX_SEQUENCE, cleanSequence, sequenceChainCif } from "../src/design-card/sequence.ts";

test("a typed or pasted sequence is read as one-letter codes: FASTA header, spaces, numbers and case dropped", () => {
  assert.equal(cleanSequence(">pep1 epitope\n gss pee\n10 dlrk*"), "GSSPEEDLRK");
  assert.throws(() => cleanSequence("  \n"), /type or paste/);
  assert.throws(() => cleanSequence("GSXBZ"), /twenty amino acids: X, B, Z/);
  assert.throws(() => cleanSequence("G".repeat(MAX_SEQUENCE + 1)), /at most/);
});

test("a sequence becomes one polymer chain with every heavy atom and no coordinates", () => {
  const { cif, residues, sequence } = sequenceChainCif("GWK", { chainId: "B" });
  assert.equal(residues, 3);
  assert.equal(sequence, "GWK");
  const a = parseCifToAtoms(cif);
  // GLY 4 + TRP 14 + LYS 9 heavy atoms
  assert.equal(a.nAtoms, 4 + 14 + 9);
  assert.deepEqual([...new Set(a.res_name)], ["GLY", "TRP", "LYS"]);
  assert.deepEqual([...new Set(a.res_id.map(Number))], [1, 2, 3]);
  assert.ok(a.chain_id.every((c) => c === "B"));
  assert.ok(a.is_polymer.every(Boolean));
  assert.ok(a.coord.every((c) => c.every((v) => Number.isNaN(v))));
  assert.equal(a.element[a.atom_name.indexOf("NZ")], "N");
});

test("the parity suite's sequence target is this builder's output (tests/fixtures/sequence_target.cif)", () => {
  const fixture = readFileSync(new URL("../../../tests/fixtures/sequence_target.cif", import.meta.url), "utf8");
  assert.equal(fixture, sequenceChainCif("GSSPEEDLRKLLEELKRRSG").cif);
});
