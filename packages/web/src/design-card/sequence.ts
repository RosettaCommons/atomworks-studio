/**
 * A protein chain from its sequence alone (a disordered peptide to bind, or any target with no structure), as a
 * one-chain mmCIF Studio can open or combine into a job: every heavy atom of each residue and no coordinates ("?").
 * A residue with no coordinates reads as an entry's unresolved residues do, sequence fixed and structure free, so
 * the model builds the chain while keeping its sequence. The card posts it to `POST /api/v1/sessions` (rcsb preset,
 * `keep_unresolved`), then `/combine`, as it does a ligand (`ligand.ts`); no engine is needed to build it.
 */

/** Heavy atoms of the twenty amino acids, in the PDB dictionary's order. */
const BACKBONE = ["N", "CA", "C", "O"];
const SIDE_CHAINS: Record<string, string[]> = {
  ALA: ["CB"],
  ARG: ["CB", "CG", "CD", "NE", "CZ", "NH1", "NH2"],
  ASN: ["CB", "CG", "OD1", "ND2"],
  ASP: ["CB", "CG", "OD1", "OD2"],
  CYS: ["CB", "SG"],
  GLN: ["CB", "CG", "CD", "OE1", "NE2"],
  GLU: ["CB", "CG", "CD", "OE1", "OE2"],
  GLY: [],
  HIS: ["CB", "CG", "ND1", "CD2", "CE1", "NE2"],
  ILE: ["CB", "CG1", "CG2", "CD1"],
  LEU: ["CB", "CG", "CD1", "CD2"],
  LYS: ["CB", "CG", "CD", "CE", "NZ"],
  MET: ["CB", "CG", "SD", "CE"],
  PHE: ["CB", "CG", "CD1", "CD2", "CE1", "CE2", "CZ"],
  PRO: ["CB", "CG", "CD"],
  SER: ["CB", "OG"],
  THR: ["CB", "OG1", "CG2"],
  TRP: ["CB", "CG", "CD1", "CD2", "NE1", "CE2", "CE3", "CZ2", "CZ3", "CH2"],
  TYR: ["CB", "CG", "CD1", "CD2", "CE1", "CE2", "CZ", "OH"],
  VAL: ["CB", "CG1", "CG2"],
};

const THREE: Record<string, string> = {
  A: "ALA", R: "ARG", N: "ASN", D: "ASP", C: "CYS", Q: "GLN", E: "GLU", G: "GLY", H: "HIS", I: "ILE",
  L: "LEU", K: "LYS", M: "MET", F: "PHE", P: "PRO", S: "SER", T: "THR", W: "TRP", Y: "TYR", V: "VAL",
};

/** The longest sequence taken: a target to design against, not a proteome. */
export const MAX_SEQUENCE = 1000;

/**
 * A typed or pasted sequence as one-letter codes: a FASTA header, spaces, line breaks and numbers dropped, upper
 * case. Throws, naming them, on letters that are not one of the twenty amino acids.
 */
export function cleanSequence(text: unknown): string {
  const body = String(text ?? "").split(/\r?\n/).filter((line) => !line.trimStart().startsWith(">")).join("");
  const seq = body.replace(/[\s\d*]/g, "").toUpperCase();
  if (!seq) throw new Error("type or paste a protein sequence, e.g. GSSPEEDLRKLLEELK");
  const bad = [...new Set([...seq].filter((c) => !THREE[c]))];
  if (bad.length) throw new Error(`not one of the twenty amino acids: ${bad.join(", ")}`);
  if (seq.length > MAX_SEQUENCE) throw new Error(`${seq.length} residues; at most ${MAX_SEQUENCE}`);
  return seq;
}

/** The chain as mmCIF: residues numbered from 1, every heavy atom, no coordinates. */
export function sequenceChainCif(text: unknown, { chainId = "A" }: { chainId?: string } = {}): { cif: string; residues: number; sequence: string } {
  const sequence = cleanSequence(text);
  const rows: string[] = [];
  [...sequence].forEach((letter, r) => {
    const res = THREE[letter];
    for (const name of [...BACKBONE, ...SIDE_CHAINS[res]]) {
      rows.push(["ATOM", rows.length + 1, name[0], name, res, chainId, 1, r + 1, r + 1, res, chainId, name,
        "?", "?", "?", "1.00", "0.00", "?", 1, "?", "."].join(" "));
    }
  });
  const cif = [
    "data_sequence",
    "loop_", "_entity.id", "_entity.type", "1 polymer",
    "loop_", "_entity_poly.entity_id", "_entity_poly.type", "1 'polypeptide(L)'",
    "loop_",
    ...["group_PDB", "id", "type_symbol", "label_atom_id", "label_comp_id", "label_asym_id", "label_entity_id",
      "label_seq_id", "auth_seq_id", "auth_comp_id", "auth_asym_id", "auth_atom_id", "Cartn_x", "Cartn_y", "Cartn_z",
      "occupancy", "B_iso_or_equiv", "pdbx_formal_charge", "pdbx_PDB_model_num", "pdbx_PDB_ins_code", "label_alt_id"].map((c) => `_atom_site.${c}`),
    ...rows,
    "",
  ].join("\n");
  return { cif, residues: sequence.length, sequence };
}
