import assert from "node:assert/strict";
import test from "node:test";
import { parseCifToAtoms } from "../src/design-card/cif.ts";
import { CCD_URL, fetchCcdComponents, isCcdCode, ligandCifFromCcd } from "../src/design-card/ligand.ts";

// A three-atom stand-in for a dictionary entry: one hydrogen, one quoted name, one atom with only model coordinates.
const CCD = `data_XYZ
_chem_comp.id XYZ
loop_
_chem_comp_atom.comp_id
_chem_comp_atom.atom_id
_chem_comp_atom.type_symbol
_chem_comp_atom.charge
_chem_comp_atom.model_Cartn_x
_chem_comp_atom.model_Cartn_y
_chem_comp_atom.model_Cartn_z
_chem_comp_atom.pdbx_model_Cartn_x_ideal
_chem_comp_atom.pdbx_model_Cartn_y_ideal
_chem_comp_atom.pdbx_model_Cartn_z_ideal
XYZ C1 C 0 9 9 9 0.000 0.000 0.000
XYZ "C1'" C 0 9 9 9 2.000 0.000 0.000
XYZ N1 N 1 4.000 0.000 0.000 ? ? ?
XYZ H1 H 0 9 9 9 1.000 1.000 0.000
`;

test("a dictionary entry becomes a one-residue ligand: heavy atoms, ideal coordinates, centred where asked", () => {
  const { cif, atoms, code } = ligandCifFromCcd(CCD, { chainId: "C", center: [10, 20, 30] });
  assert.equal(code, "XYZ");
  assert.equal(atoms, 3);
  const a = parseCifToAtoms(cif);
  assert.deepEqual(a.atom_name, ["C1", "C1'", "N1"]);
  assert.deepEqual([...new Set(a.chain_id)], ["C"]);
  assert.ok(a.hetero.every(Boolean));
  assert.ok(a.is_polymer.every((p) => !p));
  const mean = [0, 1, 2].map((k) => a.coord.reduce((s, c) => s + c[k], 0) / a.nAtoms);
  mean.forEach((v, k) => assert.ok(Math.abs(v - [10, 20, 30][k]) < 1e-3, `centre ${k}`));
  assert.match(cif, /HETATM 3 N N1 XYZ C 1 \. 1 XYZ C N1 \S+ \S+ \S+ 1\.00 0\.00 1 1/);
});

test("entries without atoms or coordinates are refused", () => {
  assert.throws(() => ligandCifFromCcd("data_E\n_chem_comp.id E\n"), /no atoms/);
  const noCoords = CCD.split("\n").filter((l) => !l.startsWith("XYZ ")).concat("XYZ C1 C 0 ? ? ? ? ? ?", "").join("\n");
  assert.throws(() => ligandCifFromCcd(noCoords), /no coordinates/);
});

test("ligand codes", () => {
  for (const ok of ["SAM", "ZN", "HEM", "A1AAA"]) assert.ok(isCcdCode(ok), ok);
  for (const bad of ["", "sam", "TOOLONG", "S;M", "A B"]) assert.ok(!isCcdCode(bad), bad);
});

test("fetchCcdComponents fetches once per code, reports failures and never throws", async () => {
  const calls: string[] = [];
  const fetchFn = async (url: string): Promise<Response> => {
    calls.push(url);
    return url.includes("NOPE") ? new Response("", { status: 404 }) : new Response(CCD);
  };
  const first = await fetchCcdComponents(["QQQ", "NOPE"], { fetchFn });
  assert.deepEqual([...first.blocks.keys()], ["QQQ"]);
  assert.deepEqual(first.failed, ["NOPE"]);
  const again = await fetchCcdComponents(["QQQ"], { fetchFn });
  assert.ok(again.blocks.has("QQQ"));
  assert.deepEqual(calls.filter((u) => u === CCD_URL("QQQ")).length, 1);
});
