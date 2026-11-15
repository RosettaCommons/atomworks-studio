import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { catRows, parseCifBlock, parseCifToAtoms } from "../src/design-card/cif.ts";

const EXAMPLES = new URL("../../api/annotation_studio/examples/", import.meta.url);
const example = (name: string): string => readFileSync(new URL(`${name}.cif`, EXAMPLES), "utf8");

test("the tokenizer handles quotes, text blocks, comments, loops and the first data block only", () => {
  const block = parseCifBlock(`# a comment
data_one
_cell.length_a 1.5
_struct.title 'it''s "quoted" # not a comment'
_note.text
;first line
second line
;
loop_
_t.id
_t.name
1 "C1'"
2 'O5"'
3 plain#comment
data_two
_other.x 9
`);
  assert.deepEqual(block.cell.length_a, ["1.5"]);
  assert.equal(block.struct.title[0], `it''s "quoted" # not a comment`);
  assert.equal(block.note.text[0], "first line\nsecond line");
  assert.deepEqual(block.t.id, ["1", "2", "3"]);
  assert.deepEqual(block.t.name, ["C1'", `O5"`, "plain"]);
  assert.equal(block.other, undefined);
  const rows = catRows(block.t);
  assert.equal(rows.n, 3);
  assert.equal(rows.get("name", 1), `O5"`);
  assert.equal(catRows(undefined).n, 0);
});

const SMALL = `data_x
loop_
_entity.id
_entity.type
1 polymer
2 non-polymer
#
loop_
_entity_poly.entity_id
_entity_poly.type
_entity_poly.pdbx_strand_id
1 polypeptide(L) A
#
loop_
_atom_site.group_PDB
_atom_site.id
_atom_site.type_symbol
_atom_site.label_atom_id
_atom_site.label_alt_id
_atom_site.label_comp_id
_atom_site.label_asym_id
_atom_site.label_entity_id
_atom_site.label_seq_id
_atom_site.pdbx_PDB_ins_code
_atom_site.auth_seq_id
_atom_site.Cartn_x
_atom_site.Cartn_y
_atom_site.Cartn_z
_atom_site.pdbx_PDB_model_num
_atom_site.condition_hotspot_1_atom
_atom_site.condition_sequence_1_residue
_atom_site.condition_index_1_residue
_atom_site.condition_cath-label_1_residue
_atom_site.condition_rasa-binned_1_atom
ATOM 1 N N . MET A 1 1 ? 10 1.0 2.0 3.0 1 True MET True 3.30.70.x 2
ATOM 2 C CA A MET A 1 1 ? 10 2.0 2.0 3.0 1 False . False x.x.x.x ?
ATOM 3 C CA B MET A 1 1 ? 10 9.0 9.0 9.0 1 False . False x.x.x.x ?
ATOM 4 C CA . LYS A 1 2 A 11 ? ? ? 1 1 <M> ? . 0
HETATM 5 C "C1'" . XYZ L 2 . . 7 4.0 5.0 6.0 1 N MET Y . 0
ATOM 6 C CA . MET A 1 1 ? 10 5.0 5.0 5.0 2 False . True . 0
`;

test("an annotated CIF becomes an atom array: ids, polymer flag, coordinates, scalar annotations", () => {
  const a = parseCifToAtoms(SMALL);
  // model 2 and the second altloc are dropped
  assert.equal(a.nAtoms, 4);
  assert.deepEqual(a.chain_id, ["A", "A", "A", "L"]);
  assert.deepEqual(a.atom_name, ["N", "CA", "CA", "C1'"]);
  assert.deepEqual(a.res_id, [1, 1, 2, 7]);
  assert.deepEqual(a.auth_seq_id, [10, 10, 11, 7]);
  assert.deepEqual(a.ins_code, ["", "", "A", ""]);
  assert.deepEqual(a.hetero, [false, false, false, true]);
  assert.deepEqual(a.is_polymer, [true, true, true, false]);
  assert.deepEqual(a.coord[0], [1, 2, 3]);
  assert.ok(a.coord[2].every(Number.isNaN));
  const ann = a.annotations;
  assert.deepEqual(ann.condition_hotspot_1_atom, [true, false, true, false]);
  assert.deepEqual(ann.condition_sequence_1_residue, ["MET", "<M>", "<M>", "MET"]);
  assert.deepEqual(ann.condition_index_1_residue, [true, false, true, true], "? takes the default");
  assert.deepEqual(ann["condition_cath-label_1_residue"], ["3.30.70.x", "", "", ""]);
  assert.deepEqual(ann["condition_rasa-binned_1_atom"], [2, 0, 0, 0]);
});

test("without entity tables chains are told apart by residue names, sentinels counting as protein", () => {
  const a = parseCifToAtoms(`data_x
loop_
_atom_site.group_PDB
_atom_site.type_symbol
_atom_site.label_atom_id
_atom_site.label_comp_id
_atom_site.label_asym_id
_atom_site.label_seq_id
_atom_site.auth_seq_id
_atom_site.Cartn_x
_atom_site.Cartn_y
_atom_site.Cartn_z
ATOM N N 5-10 A 1 1 . . .
HETATM ZN ZN ZN B . 5 1 2 3
ATOM P P DA C 1 1 1 2 3
`);
  assert.deepEqual(a.is_polymer, [true, false, true]);
  assert.equal(a.res_id[1], 5);
});

test("legacy masks become conditions", () => {
  const a = parseCifToAtoms(`data_x
loop_
_atom_site.group_PDB
_atom_site.label_atom_id
_atom_site.label_comp_id
_atom_site.label_asym_id
_atom_site.label_seq_id
_atom_site.auth_seq_id
_atom_site.Cartn_x
_atom_site.Cartn_y
_atom_site.Cartn_z
_atom_site.mask_coordinate_1_atom
_atom_site.mask_sequence_1_residue
_atom_site.mask_index_1_residue
ATOM CA ALA A 1 1 1 2 3 True True False
ATOM CA GLY A 2 2 4 5 6 False False True
`);
  assert.deepEqual(a.annotations.condition_coordinate_1_atom?.[0], [1, 2, 3]);
  assert.ok((a.annotations.condition_coordinate_1_atom?.[1] as number[]).every(Number.isNaN));
  assert.deepEqual(a.annotations.condition_sequence_1_residue, ["ALA", "<M>"]);
  assert.deepEqual(a.annotations.condition_index_1_residue, [false, true]);
  assert.equal(a.annotations.mask_index_1_residue, undefined);
});

test("every bundled example reads, with held coordinates where the examples hold them", () => {
  for (const file of readdirSync(EXAMPLES).filter((f) => f.endsWith(".cif"))) {
    const a = parseCifToAtoms(readFileSync(new URL(file, EXAMPLES), "utf8"));
    assert.ok(a.nAtoms > 0, file);
    for (const key of ["chain_id", "res_id", "ins_code", "res_name", "atom_name", "element", "hetero", "is_polymer", "coord"] as const) {
      assert.equal(a[key].length, a.nAtoms, `${file} ${key}`);
    }
  }
});

test("protein_binder: a fixed target chain and a chain of new residues", () => {
  const a = parseCifToAtoms(example("protein_binder"));
  const chains = [...new Set(a.chain_id)];
  assert.equal(chains.length, 2);
  const sentinel = a.res_name.findIndex((r) => /^\d+-\d+$/.test(r));
  assert.ok(sentinel >= 0, "a new-residue segment is present");
  assert.ok(a.is_polymer[sentinel]);
  assert.ok((a.annotations.annotation_expsegmin_1_residue?.[sentinel] as number) > 0);
  // nothing here is held by absolute coordinates: triples all NaN
  const crd = a.annotations.condition_coordinate_1_atom as number[][];
  assert.equal(crd.length, a.nAtoms);
  assert.ok(crd.every((c) => c.length === 3 && !Number.isFinite(c[0])));
});

test("nanobody: hotspot atoms", () => {
  const a = parseCifToAtoms(example("nanobody"));
  assert.equal((a.annotations.condition_hotspot_1_atom as boolean[]).filter(Boolean).length, 3);
});

test("small_molecule_binder: ligand atoms are hetero, outside the polymer, numbered by the author", () => {
  const a = parseCifToAtoms(example("small_molecule_binder"));
  const lig = a.is_polymer.findIndex((p) => !p);
  assert.ok(lig >= 0);
  assert.ok(a.hetero[lig]);
  assert.equal(a.res_id[lig], a.auth_seq_id[lig]);
});

test("antibody_design: folds as strings, internal coordinates as triples", () => {
  const a = parseCifToAtoms(example("antibody_design"));
  const cath = a.annotations["condition_cath-label_1_residue"];
  assert.ok(cath?.some((v) => typeof v === "string" && v.length > 0));
  assert.ok(cath?.every((v) => typeof v === "string"));
  const internal = a.annotations.condition_InternalCoordinate_1_atom as number[][];
  assert.ok(internal.some((c) => c.length === 3 && Number.isFinite(c[0])));
  const group = a.annotations.condition_CoordinateGroup_1_atom as number[];
  assert.ok(group.some((g) => g > 0));
});

test("enzyme_design: held coordinates are triples on the atoms that are held", () => {
  const a = parseCifToAtoms(example("enzyme_design"));
  const crd = a.annotations.condition_coordinate_1_atom as number[][];
  const held = crd.filter((c) => Number.isFinite(c[0]));
  assert.ok(held.length > 0 && held.length < a.nAtoms);
  assert.ok(held.every((c) => c.length === 3 && c.every(Number.isFinite)));
});
