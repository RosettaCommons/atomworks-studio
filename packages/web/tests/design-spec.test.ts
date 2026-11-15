import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseCifToAtoms } from "../src/design-card/cif.ts";
import { designSpec, formatResidueList, heldAtomsOf, parseResidueList } from "../src/design-card/spec.ts";
import type { PieceSpec } from "../src/design-card/spec.ts";
import type { AnnotationCell, AtomArray } from "../src/design-card/types.ts";

const studioExample = (file: string): string =>
  readFileSync(new URL(`../../api/annotation_studio/examples/${file}`, import.meta.url), "utf8");
// Two inputs of the page's own examples that Studio's bundled files differ from (the whole 2KL8, the enzyme's pocket).
const pageExample = (file: string): string => readFileSync(new URL(`./fixtures/design-card/${file}`, import.meta.url), "utf8");
const specOf = (cif: string, options?: Parameters<typeof designSpec>[1]) => designSpec(parseCifToAtoms(cif), options);

type Case = [string, string, string | null, [number, number], Record<string, string>];

test("designSpec reads task, roles, lengths and contig from the examples the page's tests pin", () => {
  const cases: Case[] = [
    ["enzyme_design.cif", "enzyme", "180/[A1] + ORO, ZN", [180, 180], { A: "motif", B: "ligand", C: "ligand" }],
    ["inverse_folding.cif", "redesign_all", "59", [59, 59], { A: "free" }],
  ];
  for (const [file, task, contig, [lo, hi], roles] of cases) {
    const spec = specOf(pageExample(file));
    assert.equal(spec.task.key, task, file);
    if (contig) assert.equal(spec.contig, contig, file);
    assert.deepEqual([spec.totalMin, spec.totalMax], [lo, hi], file);
    assert.deepEqual(Object.fromEntries(spec.chains.map((c) => [c.id, c.role])), roles, file);
  }
  assert.equal(specOf(pageExample("inverse_folding.cif"), { partialDiffusion: true }).task.key, "partial");
});

test("designSpec reads Studio's bundled examples", () => {
  const cases: Case[] = [
    ["motif_scaffolding.cif", "motif", "10-20/A1/15-30/A3/15-30/A5/10-20", [53, 103], { A: "motif" }],
    ["small_molecule_binder.cif", "sm_binder", "150 + SAM", [150, 150], { A: "new", B: "ligand" }],
    ["unconditional.cif", "unconditional", "250", [250, 250], { A: "new" }],
    ["protein_binder.cif", "binder", null, [207, 277], { B: "fixed", A: "new" }],
    ["nanobody.cif", "antibody", "A1-113/0 22/11-16/14/8-12/37/8-22/10", [223, 246], { A: "fixed", H: "motif" }],
  ];
  for (const [file, task, contig, [lo, hi], roles] of cases) {
    const spec = specOf(studioExample(file));
    assert.equal(spec.task.key, task, file);
    if (contig) assert.equal(spec.contig, contig, file);
    assert.deepEqual([spec.totalMin, spec.totalMax], [lo, hi], file);
    assert.deepEqual(Object.fromEntries(spec.chains.map((c) => [c.id, c.role])), roles, file);
  }
  assert.equal(specOf(studioExample("antibody_design.cif")).task.key, "antibody");
});

test("chains read as their pieces, in order, with how each is kept and its hotspots", () => {
  const describe = (p: PieceSpec): string => (p.kind === "new"
    ? `new ${p.min}-${p.max}`
    : `${p.kind}${p.keep ? `/${p.keep}` : ""}${p.anywhere ? "/anywhere" : ""} ${p.start}-${p.end}${p.source ? ` from ${p.source}` : ""}`);
  const pieces = (cif: string, chain: string): string[] => {
    const found = specOf(cif).chains.find((c) => c.id === chain);
    assert.ok(found, `chain ${chain}`);
    return found.pieces.map(describe);
  };
  const nanobody = studioExample("nanobody.cif");
  assert.deepEqual(pieces(nanobody, "A"), ["kept/all 1-113"]);
  assert.deepEqual(pieces(nanobody, "H"),
    ["kept/shape 1-22", "new 11-16", "kept/shape 24-37", "new 8-12", "kept/shape 39-75", "new 8-22", "kept/shape 77-86"]);
  assert.deepEqual(specOf(nanobody).chains.find((c) => c.id === "A")?.hotspotResIds, [38, 97, 105]);
  assert.deepEqual(pieces(studioExample("small_molecule_binder.cif"), "A"), ["new 150-150"]);
  // A set-up renumbers the motif residues it keeps; the pieces still say where they came from.
  assert.deepEqual(pieces(studioExample("motif_scaffolding.cif"), "A"),
    ["new 10-20", "kept/all 1-1 from A38", "new 15-30", "kept/all 3-3 from A14", "new 15-30", "kept/all 5-5 from A99", "new 10-20"]);
  // The catalytic residue: only its side-chain tip held, placed anywhere in the new chain.
  assert.deepEqual(pieces(pageExample("enzyme_design.cif"), "A"), ["new 180-180", "kept/sidechain/anywhere 1-1 from A250"]);
  assert.deepEqual(pieces(pageExample("inverse_folding.cif"), "A"), ["designed 1-7", "designed 28-79"]);
});

// ---- hand-built atoms: what the page's tests got from its engine -------------------------------------------------------

type Res = {
  chain: string;
  id: number;
  name?: string;
  /** Hold these atoms' coordinates: "all", "backbone", or atom names. */
  hold?: "all" | "backbone" | string[];
  seq?: boolean;
  hot?: boolean | string[];
  /** A new-residue segment of this length range instead of a residue. */
  segment?: [number, number];
  hetero?: boolean;
  /** A ligand: HETATM outside the polymer. */
  ligand?: boolean;
  unindexed?: boolean;
  group?: number;
  src?: string;
  ss?: number;
  fold?: string;
};

const BACKBONE = ["N", "CA", "C", "O"];
const ASP = [...BACKBONE, "CB", "CG", "OD1", "OD2"];

/** An atom array as `parseCifToAtoms` makes one, from a list of residues. */
function build(residues: Res[]): AtomArray {
  const a: AtomArray = {
    nAtoms: 0, chain_id: [], res_id: [], ins_code: [], auth_seq_id: [], res_name: [], atom_name: [], element: [],
    hetero: [], is_polymer: [], coord: [], annotations: {},
  };
  const col = (name: string, value: AnnotationCell): void => { (a.annotations[name] ??= []).push(value); };
  let x = 0;
  for (const r of residues) {
    const names = r.segment ? ["CA"] : r.ligand ? ["C1", "C2", "O1"] : r.name === "GLY" ? BACKBONE : ASP;
    for (const atom of names) {
      a.nAtoms += 1;
      a.chain_id.push(r.chain);
      a.res_id.push(r.id);
      a.ins_code.push("");
      a.auth_seq_id.push(r.id);
      a.res_name.push(r.segment ? `${r.segment[0]}-${r.segment[1]}` : (r.name ?? (r.ligand ? "LIG" : "ASP")));
      a.atom_name.push(atom);
      a.element.push(atom[0]);
      a.hetero.push(Boolean(r.hetero || r.ligand || r.segment));
      a.is_polymer.push(!r.ligand);
      const at = r.segment ? [Number.NaN, Number.NaN, Number.NaN] : [x, 0, 0];
      x += 1;
      a.coord.push(at);
      const held = r.hold === "all" || (r.hold === "backbone" && BACKBONE.includes(atom)) || (Array.isArray(r.hold) && r.hold.includes(atom));
      col("condition_coordinate_1_atom", held ? at : [Number.NaN, Number.NaN, Number.NaN]);
      col("condition_sequence_1_residue", r.seq ? (r.name ?? "ASP") : "<M>");
      col("condition_index_1_residue", !r.unindexed);
      col("condition_hotspot_1_atom", Array.isArray(r.hot) ? r.hot.includes(atom) : Boolean(r.hot));
      col("condition_CoordinateGroup_1_atom", r.group ?? -1);
      col("condition_secondary-structure_1_residue", r.ss ?? 0);
      col("condition_cath-label_1_residue", r.fold ?? "");
      col("annotation_src-component_1_atom", r.src ?? "");
      col("annotation_expsegmin_1_residue", r.segment ? r.segment[0] : -1);
      col("annotation_expsegmax_1_residue", r.segment ? r.segment[1] : -1);
    }
  }
  return a;
}

const run = (chain: string, from: number, to: number, props: Partial<Res> = {}): Res[] =>
  Array.from({ length: to - from + 1 }, (_, k) => ({ chain, id: from + k, ...props }));

test("roles: backbone kept with the sequence free is 'Redesign sequence'", () => {
  const spec = designSpec(build(run("A", 1, 10, { hold: "backbone" })));
  assert.equal(spec.task.key, "inverse");
  assert.equal(spec.chains[0].role, "backbone");
  assert.equal(spec.chains[0].backboneOnly, 10);
  assert.equal(spec.chains[0].backboneAtomIndices.length, 40);
  assert.equal(spec.contig, "A1-10");
});

test("a fixed target plus a new chain is binder design; a segment's range sets the designed length", () => {
  let spec = designSpec(build([...run("A", 1, 12, { hold: "all", seq: true }), { chain: "B", id: 1, segment: [60, 100] }]));
  assert.equal(spec.task.key, "binder");
  const seg = spec.chains.find((c) => c.role === "new")?.segments[0];
  assert.deepEqual([seg?.min, seg?.max], [60, 100]);
  spec = designSpec(build([...run("A", 1, 12, { hold: "all", seq: true }), { chain: "B", id: 1, segment: [70, 80] }]));
  assert.deepEqual([spec.designedMin, spec.designedMax], [70, 80]);
  assert.deepEqual([spec.totalMin, spec.totalMax], [82, 92]);
  assert.match(spec.contig, /\/0 70-80$/);
  assert.equal(spec.contig, "A1-12/0 70-80");
});

test("sequence-only chains fold; everything fixed is nothing to design; no conditions is a full redesign", () => {
  const fold = designSpec(build(run("A", 1, 8, { seq: true })));
  assert.equal(fold.task.key, "fold");
  assert.equal(fold.predicted, 8);
  assert.equal(fold.chains[0].role, "sequence");

  const nothing = designSpec(build(run("A", 1, 8, { hold: "all", seq: true })));
  assert.equal(nothing.task.key, "nothing");
  assert.match(nothing.warnings.join(" "), /Everything is fixed/);

  const all = designSpec(build(run("A", 1, 8)));
  assert.equal(all.task.key, "redesign_all");
  assert.match(all.warnings.join(" "), /all of it will be redesigned/);

  const partial = designSpec(build(run("A", 1, 8)), { partialDiffusion: true, partialPercent: 25 });
  assert.equal(partial.task.key, "partial");
  assert.match(partial.task.detail, /25%/);

  assert.equal(designSpec(build([])).empty, true);
  assert.equal(designSpec(build([])).task.key, "empty");
  assert.match(designSpec(build([])).warnings[0], /Open a structure/);
});

test("a motif: kept residues with new residues between them", () => {
  const spec = designSpec(build([
    { chain: "A", id: 1, segment: [10, 20] },
    { chain: "A", id: 38, hold: "all", seq: true, src: "A38" },
    { chain: "A", id: 39, segment: [15, 30] },
    { chain: "A", id: 99, hold: "all", seq: true, src: "A99" },
  ]));
  assert.equal(spec.task.key, "motif");
  assert.equal(spec.contig, "10-20/A38/15-30/A99");
  const [first, kept, second, last] = spec.chains[0].pieces;
  assert.equal(first.kind, "new");
  assert.equal(kept.kind === "kept" && kept.keep, "all");
  assert.equal(kept.kind !== "new" && kept.source, undefined);
  assert.equal(second.kind === "new" && second.where, "between A38 and A99");
  assert.equal(last.kind, "kept");
  assert.equal(spec.chains[0].segments[0].where, "N-terminal");
  assert.deepEqual([spec.totalMin, spec.totalMax], [27, 52]);
});

test("residues placed anywhere are bracketed, not counted, and a ligand makes it an enzyme", () => {
  const spec = designSpec(build([
    { chain: "A", id: 1, segment: [180, 180] },
    { chain: "A", id: 250, hold: ["CG", "OD1"], seq: true, unindexed: true, src: "A250" },
    { chain: "B", id: 1, ligand: true, hold: "all" },
  ]));
  assert.equal(spec.task.key, "enzyme");
  assert.match(spec.contig, /^180\/\[A250\] \+ LIG$/);
  assert.equal(spec.chains[0].unindexed, 1);
  assert.deepEqual([spec.totalMin, spec.totalMax], [180, 180]);
  const piece = spec.chains[0].pieces[1];
  assert.equal(piece.kind === "kept" && piece.keep, "sidechain");
  assert.equal(piece.kind !== "new" && piece.anywhere, true);
  assert.equal(piece.kind !== "new" && piece.atoms, "CG, OD1");
  const lig = spec.chains.find((c) => c.id === "B")?.ligands[0];
  assert.deepEqual([lig?.name, lig?.pose, lig?.fixed], ["LIG", "fixed", true]);
});

test("ligand poses: free, rigid, some atoms fixed", () => {
  const pose = (props: Partial<Res>, atoms?: AtomArray) => designSpec(atoms ?? build([
    ...run("A", 1, 4, { hold: "all", seq: true }), { chain: "B", id: 1, segment: [5, 5] }, { chain: "L", id: 1, ligand: true, ...props },
  ])).chains.find((c) => c.id === "L")?.ligands[0];
  assert.equal(pose({})?.pose, "predicted");
  assert.equal(pose({ group: 1 })?.pose, "rigid");
  const partly = pose({ hold: ["C1", "C2"] });
  assert.equal(partly?.pose, "partly fixed");
  assert.equal(partly?.heldNames, "C1, C2");
  assert.equal(partly?.fixedAtoms, 2);
});

test("a rigid framework (held by its shape) is kept; shape pieces and hotspots are read per run", () => {
  const spec = designSpec(build([
    ...run("H", 1, 3, { group: 1, seq: true }),
    ...run("H", 4, 6),
    ...run("H", 7, 9, { group: 1, seq: true, hot: true }),
    ...run("T", 1, 4, { hold: "all", seq: true }),
  ]));
  const h = spec.chains.find((c) => c.id === "H");
  assert.equal(h?.role, "motif");
  const desc = h?.pieces.map((p) => `${p.kind}${p.kind === "kept" ? `/${p.keep}` : ""} ${p.start}-${p.end}`);
  assert.deepEqual(desc, ["kept/shape 1-3", "designed 4-6", "kept/shape 7-9"]);
  assert.deepEqual(h?.hotspotResIds, [7, 8, 9]);
  assert.deepEqual(h?.pieces[2].hotspots, [7, 8, 9]);
  assert.equal(spec.task.key, "antibody");
});

test("hotspots on some atoms only, shape, and the chain's fold are read", () => {
  const spec = designSpec(build([
    ...run("A", 1, 3, { hold: "all", seq: true, hot: ["CG", "OD1"] }),
    { chain: "A", id: 4, hold: "all", seq: true, hot: true },
    ...run("B", 1, 4, { ss: 2, fold: "3.30.70.x" }),
  ]));
  const a = spec.chains.find((c) => c.id === "A");
  assert.deepEqual(a?.hotspotResIds, [1, 2, 3, 4]);
  assert.deepEqual([...(a?.hotspotAtoms ?? [])], [[1, ["CG", "OD1"]], [2, ["CG", "OD1"]], [3, ["CG", "OD1"]]]);
  const b = spec.chains.find((c) => c.id === "B");
  assert.equal(b?.fold, "3.30.70.x");
  assert.equal(b?.pieces[0].ss, 2);
  // An unset fold ("x.x.x.x") is none.
  assert.equal(designSpec(build(run("A", 1, 2, { fold: "x.x.x.x" }))).chains[0].fold, "");
});

test("a modified residue stored as HETATM is still a polymer residue, not a ligand", () => {
  const atoms = build(run("A", 1, 5));
  for (let i = 0; i < atoms.nAtoms; i += 1) if (atoms.res_id[i] === 3) atoms.hetero[i] = true;
  const spec = designSpec(atoms);
  assert.equal(spec.chains.length, 1);
  assert.equal(spec.chains[0].ligands.length, 0);
  assert.equal(spec.chains[0].residues, 5);
  // Without is_polymer, HETATM is what says "ligand".
  atoms.is_polymer = [];
  assert.equal(designSpec(atoms).chains[0].ligands.length, 1);
});

test("unresolved residues do not count as unfixed when roles are judged", () => {
  const atoms = build([...run("A", 1, 3, { hold: "all", seq: true }), ...run("A", 4, 5, { seq: true })]);
  for (let i = 0; i < atoms.nAtoms; i += 1) if (atoms.res_id[i] >= 4) atoms.coord[i] = [Number.NaN, Number.NaN, Number.NaN];
  const chain = designSpec(atoms).chains[0];
  assert.equal(chain.unresolved, 2);
  assert.equal(chain.role, "fixed");
});

test("typed residue lists parse and format both ways", () => {
  assert.deepEqual(parseResidueList("A56, A115-117 B7;9 x?", "T"), {
    residues: [
      { chain: "A", resId: 56 }, { chain: "A", resId: 115 }, { chain: "A", resId: 116 }, { chain: "A", resId: 117 },
      { chain: "B", resId: 7 }, { chain: "T", resId: 9 },
    ],
    bad: ["x?"],
  });
  assert.deepEqual(parseResidueList("A5–3").bad, ["A5–3"]);
  assert.deepEqual(parseResidueList("12").bad, ["12"]);
  assert.deepEqual(parseResidueList("A56(cg, oh) A57").residues, [
    { chain: "A", resId: 56, atoms: ["CG", "OH"] }, { chain: "A", resId: 57 },
  ]);
  assert.equal(formatResidueList("A", [117, 56, 115, 116]), "A56, A115–117");
  assert.equal(formatResidueList("A", [56, 57, 58], new Map([[57, ["CG", "OH"]]])), "A56, A57(CG,OH), A58");
  const again = parseResidueList(formatResidueList("A", [56, 115, 116, 117])).residues.map((r) => r.resId);
  assert.deepEqual(again, [56, 115, 116, 117]);
});

test("held atoms of a residue placed anywhere are read against all its atoms, not only those with coordinates", () => {
  const asp = ["N", "CA", "C", "O", "CB", "CG", "OD1", "OD2"];
  // Placed anywhere, only the held atoms keep coordinates.
  assert.equal(heldAtomsOf({ unindexed: true, allHeavyNames: asp, heavyNames: ["CG", "OD1"], heldNames: ["CG", "OD1"] }), "CG, OD1");
  assert.equal(heldAtomsOf({ unindexed: true, allHeavyNames: asp, heavyNames: ["N", "CA", "C", "O"], heldNames: ["N", "CA", "C", "O"] }), "backbone");
  // In place, atoms without coordinates (unresolved) are not counted.
  assert.equal(heldAtomsOf({ unindexed: false, allHeavyNames: asp, heavyNames: ["N", "CA", "C", "O"], heldNames: ["N", "CA", "C", "O"] }), "all");
  assert.equal(heldAtomsOf({ heavyNames: asp, heldNames: [] }), null);
});

test("a C-terminal residue holding N, CA, C and O reads backbone, its OXT or not", () => {
  // 6MRR held rigid by its backbone split into three pieces: A68 (with an OXT) read "N, CA, C, O".
  const heavy = ["N", "CA", "C", "O", "CB", "CG", "OXT"];
  assert.equal(heldAtomsOf({ heldNames: ["N", "CA", "C", "O"], heavyNames: heavy }), "backbone");
  assert.equal(heldAtomsOf({ heldNames: ["N", "CA", "C", "O", "OXT"], heavyNames: heavy }), "backbone");
  assert.equal(heldAtomsOf({ heldNames: ["N", "CA", "C"], heavyNames: heavy }), "N, CA, C");
  assert.equal(heldAtomsOf({ heldNames: ["CB", "CG"], heavyNames: heavy }), "sidechain");
});
