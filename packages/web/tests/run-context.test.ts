import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseCifToAtoms } from "../src/design-card/cif.ts";
import { motifOverlayCif } from "../src/design-card/run-context.ts";

const example = (file: string): string => readFileSync(new URL(`../../api/annotation_studio/examples/${file}`, import.meta.url), "utf8");
const motifResidues = (file: string): string[] => {
  const cif = motifOverlayCif(parseCifToAtoms(example(file)));
  return cif ? [...new Set(cif.split("\n").filter((l) => l.startsWith("HETATM")).map((l) => `${l.split(" ")[4]}${l.split(" ")[7]}`))] : [];
};

test("a scaffold's held residues are its motif, though its new residues are one placeholder each", () => {
  assert.equal(motifResidues("motif_scaffolding.cif").length, 3);
});

test("a chain that is all held is a target, not a motif", () => {
  assert.deepEqual(motifResidues("protein_binder.cif"), []);
});
