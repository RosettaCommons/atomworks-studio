/**
 * A small mmCIF reader for the Design card: a tokenizer and block parser, and `parseCifToAtoms`, which turns the
 * annotated CIF Studio serves at `GET /sessions/{sid}/cif` into the `AtomArray` the card reads its design from. Pure:
 * text in, plain objects out.
 *
 * The annotated CIF is what AtomWorks writes with its standard annotations: `condition_*` and `annotation_*` scalars
 * as extra `_atom_site` columns, coordinates and other triples in categories of their own (`idx0`, `val0..val2`).
 * Names and defaults follow AtomWorks (and the browser page's parser, which reads the same files).
 */
import type { AnnotationCell, AtomArray } from "./types.ts";

/** category -> column -> values, one per row (a single-row item has one value). */
export type CifBlock = Record<string, Record<string, string[]>>;

type Token = { value: string; quoted: boolean };

const isSpace = (c: string): boolean => c === " " || c === "\t" || c === "\n" || c === "\r";

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const n = text.length;
  let i = 0;
  let lineStart = true;
  while (i < n) {
    // A ";" text block runs to the next line that starts with ";".
    if (lineStart && text[i] === ";") {
      let end = i + 1;
      let closed = false;
      while (end < n) {
        if (text[end] === "\n" || text[end] === "\r") {
          let next = end + 1;
          if (text[end] === "\r" && text[next] === "\n") next += 1;
          if (text[next] === ";") {
            tokens.push({ value: text.slice(i + 1, end), quoted: true });
            i = next + 1;
            lineStart = false;
            closed = true;
            break;
          }
        }
        end += 1;
      }
      if (!closed) break;
      continue;
    }
    const ch = text[i];
    if (ch === "\n" || ch === "\r") { lineStart = true; i += 1; continue; }
    if (ch === " " || ch === "\t") { i += 1; continue; }
    lineStart = false;
    if (ch === "#") {
      while (i < n && text[i] !== "\n" && text[i] !== "\r") i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      // The closing quote is the one followed by whitespace (so "C1'" and 'O5"' keep their inner quotes).
      let j = i + 1;
      while (j < n) {
        if (text[j] === ch && (j + 1 >= n || isSpace(text[j + 1]))) break;
        j += 1;
      }
      tokens.push({ value: text.slice(i + 1, j), quoted: true });
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < n && !isSpace(text[j]) && text[j] !== "#") j += 1;
    tokens.push({ value: text.slice(i, j), quoted: false });
    i = j;
  }
  return tokens;
}

const isKeyword = (t: Token, word: string): boolean => !t.quoted && t.value === word;
const isTag = (t: Token): boolean => !t.quoted && t.value.startsWith("_");
const isDataHeader = (t: Token): boolean => !t.quoted && t.value.startsWith("data_");

function splitTag(tag: string): [string, string] {
  const dot = tag.indexOf(".");
  return dot < 0 ? [tag.slice(1), ""] : [tag.slice(1, dot), tag.slice(dot + 1)];
}

/** The first data block of an mmCIF text: `block[category][column] = values`. */
export function parseCifBlock(text: string): CifBlock {
  const tokens = tokenize(text);
  const block: CifBlock = {};
  const n = tokens.length;
  let seenData = false;
  let i = 0;
  const column = (cat: string, col: string): string[] => {
    const table = (block[cat] ??= {});
    return (table[col] ??= []);
  };
  while (i < n) {
    const tok = tokens[i];
    if (isDataHeader(tok)) {
      if (seenData) break;
      seenData = true;
      i += 1;
      continue;
    }
    if (isKeyword(tok, "loop_")) {
      i += 1;
      const columns: string[][] = [];
      while (i < n && isTag(tokens[i])) {
        const [cat, col] = splitTag(tokens[i].value);
        const values = column(cat, col);
        values.length = 0;
        columns.push(values);
        i += 1;
      }
      if (!columns.length) continue;
      while (i < n) {
        const t = tokens[i];
        if (isKeyword(t, "loop_") || isTag(t) || isDataHeader(t)) break;
        for (let c = 0; c < columns.length && i < n; c += 1, i += 1) columns[c].push(tokens[i].value);
      }
      continue;
    }
    if (isTag(tok)) {
      const [cat, col] = splitTag(tok.value);
      (block[cat] ??= {})[col] = [i + 1 < n ? tokens[i + 1].value : ""];
      i += 2;
      continue;
    }
    i += 1;
  }
  return block;
}

/** A category as rows: `n` rows, `get(column, row)` the value, undefined where the column or row is absent. */
export function catRows(category: Record<string, string[]> | undefined): { n: number; get(col: string, row: number): string | undefined } {
  const columns = category ? Object.values(category) : [];
  const n = columns.length ? Math.max(...columns.map((c) => c.length)) : 0;
  return { n, get: (col, row) => category?.[col]?.[row] };
}

// ---- values --------------------------------------------------------------------------------------------------------

const isBlank = (s: string | undefined): s is undefined => s === undefined || s === "." || s === "?" || s === "";

function safeInt(s: string | undefined, fallback: number): number {
  if (isBlank(s)) return fallback;
  const v = Number.parseInt(s, 10);
  return Number.isNaN(v) ? fallback : v;
}

function safeFloat(s: string | undefined, fallback: number): number {
  if (isBlank(s) || s === "nan" || s === "NaN") return fallback;
  const v = Number.parseFloat(s);
  return Number.isNaN(v) ? fallback : v;
}

function safeBool(s: string | undefined, fallback: boolean): boolean {
  if (isBlank(s)) return fallback;
  if (s === "True" || s === "true" || s === "1" || s === "Y") return true;
  if (s === "False" || s === "false" || s === "0" || s === "N") return false;
  return fallback;
}

type ScalarSpec = { type: "int" | "float" | "bool" | "str"; default: number | boolean | string };

/** AtomWorks' one-body scalar annotations, as `_atom_site` columns. */
const SCALAR_ANNOTATIONS: Record<string, ScalarSpec> = {
  "annotation_expsegmin_1_residue": { type: "int", default: -1 },
  "annotation_expsegmax_1_residue": { type: "int", default: -1 },
  "annotation_src-component_1_atom": { type: "str", default: "" },
  "annotation_src-index-group_1_atom": { type: "int", default: 0 },
  "annotation_src-coordinate-conditioned-region_1_atom": { type: "int", default: -1 },
  "condition_sequence_1_residue": { type: "str", default: "<M>" },
  "condition_index_1_residue": { type: "bool", default: true },
  "condition_index-group_1_token": { type: "int", default: 0 },
  "condition_hotspot_1_atom": { type: "bool", default: false },
  "condition_hbond_1_atom": { type: "int", default: 0 },
  "condition_rasa-binned_1_atom": { type: "int", default: 0 },
  "condition_pistack_1_atom": { type: "bool", default: false },
  "condition_saltbridge_1_atom": { type: "int", default: 0 },
  "condition_hydrophobic_1_atom": { type: "bool", default: false },
  "condition_pication_1_atom": { type: "int", default: 0 },
  "condition_metal-coord_1_atom": { type: "int", default: 0 },
  "condition_CoordinateGroup_1_atom": { type: "int", default: -1 },
  "condition_secondary-structure_1_residue": { type: "int", default: 0 },
  "mask_sequence_1_residue": { type: "bool", default: false },
  "mask_coordinate_1_atom": { type: "bool", default: false },
  "mask_index_1_residue": { type: "bool", default: true },
};

/** Triples AtomWorks keeps in a category of their own: `idx0` (the atom) and `val0..val2`. */
const TRIPLE_ANNOTATIONS: Record<string, { type: "int" | "float"; default: number }> = {
  "condition_coordinate_1_atom": { type: "float", default: Number.NaN },
  "condition_InternalCoordinate_1_atom": { type: "float", default: Number.NaN },
  "condition_ChainCentroid_1_atom": { type: "float", default: Number.NaN },
  "annotation_coords-with-insertion_1_atom": { type: "float", default: Number.NaN },
};

const CATH = "condition_cath-label_1_residue";

// Chain types as AtomWorks numbers them: polymers are 0..7.
const CHAIN_TYPE = { POLYPEPTIDE_L: 6, DNA: 3, RNA: 7, NON_POLYMER: 8 } as const;
const MAX_POLYMER_CHAIN_TYPE = 7;
const POLY_TYPES: Record<string, number> = {
  "cyclic-pseudo-peptide": 0,
  "other": 1,
  "peptide nucleic acid": 2,
  "polydeoxyribonucleotide": 3,
  "polydeoxyribonucleotide/polyribonucleotide hybrid": 4,
  "polypeptide(d)": 5,
  "polypeptide(l)": 6,
  "polyribonucleotide": 7,
  "branched": 10,
  "macrolide": 11,
  "non-polymer": 8,
  "water": 9,
};
const AA = new Set([
  "ALA", "ARG", "ASN", "ASP", "CYS", "GLN", "GLU", "GLY", "HIS", "ILE", "LEU", "LYS", "MET", "PHE", "PRO", "SER",
  "THR", "TRP", "TYR", "VAL", "UNK",
]);
const RNA = new Set(["A", "C", "G", "U", "N"]);
const DNA = new Set(["DA", "DC", "DG", "DT", "DN"]);

/** Which chain type each chain is, from the entity tables and, failing those, its first residue's name. */
function chainTypes(block: CifBlock, atomSite: Record<string, string[]>, chainIds: string[], entityIds: string[]): Map<string, number> {
  const entityType = new Map<string, string>();
  const entity = catRows(block.entity);
  for (let r = 0; r < entity.n; r += 1) {
    const id = entity.get("id", r);
    const type = entity.get("type", r);
    if (id !== undefined && type !== undefined) entityType.set(id, type.toLowerCase());
  }
  const entityPolyType = new Map<string, string>();
  const strandType = new Map<string, string>();
  const poly = catRows(block.entity_poly);
  for (let r = 0; r < poly.n; r += 1) {
    const id = poly.get("entity_id", r);
    const type = (poly.get("type", r) ?? "").toLowerCase();
    if (id !== undefined) entityPolyType.set(id, type);
    for (const strand of (poly.get("pdbx_strand_id", r) ?? "").split(",")) {
      if (strand.trim()) strandType.set(strand.trim(), type);
    }
  }
  const out = new Map<string, number>();
  const resNames = atomSite.label_comp_id ?? atomSite.auth_comp_id ?? [];
  const seen = new Set<string>();
  chainIds.forEach((chain, k) => {
    if (seen.has(chain)) return;
    seen.add(chain);
    const entityId = String(safeInt(entityIds[k], 0));
    const name = strandType.get(chain) ?? entityPolyType.get(entityId) ?? entityType.get(entityId);
    let type = name ? POLY_TYPES[name] : undefined;
    if (type === undefined) {
      const resName = resNames[k] ?? "";
      if (DNA.has(resName)) type = CHAIN_TYPE.DNA;
      else if (RNA.has(resName)) type = CHAIN_TYPE.RNA;
      else if (AA.has(resName) || /^\d+-\d+$/.test(resName) || resName === "<M>") type = CHAIN_TYPE.POLYPEPTIDE_L;
      else type = CHAIN_TYPE.NON_POLYMER;
    }
    out.set(chain, type);
  });
  return out;
}

/**
 * Read an annotated CIF (first model, first alternate location of each atom) into an `AtomArray`. Chain ids are the
 * label asym ids; polymer atoms are numbered by `label_seq_id`, ligands and ions by the author's number.
 */
export function parseCifToAtoms(text: string): AtomArray {
  const block = parseCifBlock(text);
  const site = block.atom_site;
  if (!site) throw new Error("CIF block does not contain _atom_site category");
  const col = (name: string): string[] | undefined => site[name];
  const nRows = (col("label_atom_id") ?? col("auth_atom_id") ?? []).length;

  const models = col("pdbx_PDB_model_num");
  const firstModel = models?.length ? models[0] : null;
  const altIds = col("label_alt_id");
  const rows: number[] = [];
  const seenAlt = new Set<string>();
  for (let i = 0; i < nRows; i += 1) {
    if (firstModel !== null && models?.[i] !== firstModel) continue;
    const alt = altIds?.[i] ?? ".";
    if (alt !== "." && alt !== "?" && alt !== "") {
      const key = [col("label_asym_id")?.[i], col("label_seq_id")?.[i], col("auth_seq_id")?.[i], col("label_comp_id")?.[i],
        col("label_atom_id")?.[i]].join("_");
      if (seenAlt.has(key)) continue;
      seenAlt.add(key);
    }
    rows.push(i);
  }
  const n = rows.length;
  const pick = (name: string, alt: string | undefined, r: number): string =>
    col(name)?.[r] ?? (alt ? col(alt)?.[r] : undefined) ?? "";

  const chain_id = new Array<string>(n);
  const res_id = new Array<number>(n);
  const ins_code = new Array<string>(n);
  const auth_seq_id = new Array<number>(n);
  const res_name = new Array<string>(n);
  const atom_name = new Array<string>(n);
  const element = new Array<string>(n);
  const hetero = new Array<boolean>(n);
  const is_polymer = new Array<boolean>(n);
  const coord = new Array<number[]>(n);
  const entityIds = new Array<string>(n);

  for (let k = 0; k < n; k += 1) {
    const r = rows[k];
    hetero[k] = (col("group_PDB")?.[r] || "ATOM") === "HETATM";
    element[k] = col("type_symbol")?.[r] || "C";
    atom_name[k] = pick("label_atom_id", "auth_atom_id", r);
    res_name[k] = pick("label_comp_id", "auth_comp_id", r);
    chain_id[k] = col("label_asym_id")?.[r] || col("auth_asym_id")?.[r] || "A";
    entityIds[k] = col("label_entity_id")?.[r] ?? "0";
    res_id[k] = safeInt(col("label_seq_id")?.[r], -1);
    const ins = col("pdbx_PDB_ins_code")?.[r];
    ins_code[k] = isBlank(ins) ? "" : ins;
    auth_seq_id[k] = safeInt(col("auth_seq_id")?.[r], res_id[k]);
    coord[k] = [safeFloat(col("Cartn_x")?.[r], Number.NaN), safeFloat(col("Cartn_y")?.[r], Number.NaN),
      safeFloat(col("Cartn_z")?.[r], Number.NaN)];
  }

  const types = chainTypes(block, site, chain_id, entityIds);
  for (let k = 0; k < n; k += 1) {
    is_polymer[k] = (types.get(chain_id[k]) ?? CHAIN_TYPE.NON_POLYMER) <= MAX_POLYMER_CHAIN_TYPE;
    // Ligands and ions are numbered by the author's residue number.
    if (!is_polymer[k]) res_id[k] = auth_seq_id[k];
  }

  const annotations: Record<string, AnnotationCell[]> = {};
  for (const [name, values] of Object.entries(site)) {
    let spec: ScalarSpec | undefined = SCALAR_ANNOTATIONS[name];
    if (!spec && name.startsWith("condition_sequence-probability-")) spec = { type: "float", default: Number.NaN };
    if (!spec && name.startsWith("mask_sequence-probability-")) spec = { type: "bool", default: false };
    if (!spec && name === CATH) spec = { type: "str", default: "" };
    if (!spec) continue;
    const arr = new Array<AnnotationCell>(n);
    for (let k = 0; k < n; k += 1) {
      const raw = values[rows[k]];
      if (spec.type === "int") arr[k] = safeInt(raw, spec.default as number);
      else if (spec.type === "float") arr[k] = safeFloat(raw, spec.default as number);
      else if (spec.type === "bool") arr[k] = safeBool(raw, spec.default as boolean);
      else arr[k] = isBlank(raw) ? (spec.default as string) : raw;
    }
    annotations[name] = arr;
  }
  if (annotations[CATH]) {
    annotations[CATH] = annotations[CATH].map((v) => (typeof v === "string" && /^x(\.x)*$/.test(v) ? "" : v));
  }

  for (const [name, spec] of Object.entries(TRIPLE_ANNOTATIONS)) {
    const cat = block[name];
    if (!cat) continue;
    const arr: AnnotationCell[] = Array.from({ length: n }, () => [spec.default, spec.default, spec.default]);
    const idx = cat.idx0;
    const count = idx ? idx.length : (cat.val0?.length ?? 0);
    for (let r = 0; r < count; r += 1) {
      const atom = idx ? safeInt(idx[r], -1) : r;
      if (atom < 0 || atom >= n) continue;
      arr[atom] = [0, 1, 2].map((c) => safeFloat(cat[`val${c}`]?.[r], spec.default));
    }
    annotations[name] = arr;
  }

  // The fold asked of a residue, when AtomWorks kept it as three integers (class, architecture, topology).
  if (!annotations[CATH] && block[CATH]) {
    const cat = block[CATH];
    const arr: AnnotationCell[] = new Array<AnnotationCell>(n).fill("");
    const idx = cat.idx0;
    const count = idx ? idx.length : (cat.val0?.length ?? 0);
    for (let r = 0; r < count; r += 1) {
      const atom = idx ? safeInt(idx[r], -1) : r;
      if (atom < 0 || atom >= n) continue;
      const [a, b, c] = [0, 1, 2].map((q) => safeInt(cat[`val${q}`]?.[r], -1));
      arr[atom] = a >= 0 ? `${a}.${b >= 0 ? b : "x"}.${c >= 0 ? c : "x"}.x` : "";
    }
    annotations[CATH] = arr;
  }

  // Legacy masks become the conditions they stand for.
  const maskIndex = annotations.mask_index_1_residue;
  if (maskIndex) {
    annotations.condition_index_1_residue = maskIndex.map(Boolean);
    delete annotations.mask_index_1_residue;
  }
  const maskSeq = annotations.mask_sequence_1_residue;
  if (maskSeq) {
    const existing = annotations.condition_sequence_1_residue;
    annotations.condition_sequence_1_residue = maskSeq.map((m, i) => (m ? (existing && existing[i] !== "<M>" ? existing[i] : res_name[i]) : "<M>"));
    delete annotations.mask_sequence_1_residue;
  }
  const maskCoord = annotations.mask_coordinate_1_atom;
  if (maskCoord) {
    const existing = annotations.condition_coordinate_1_atom;
    annotations.condition_coordinate_1_atom = maskCoord.map((m, i) => (m ? (existing ? existing[i] : coord[i].slice()) : [Number.NaN, Number.NaN, Number.NaN]));
    delete annotations.mask_coordinate_1_atom;
  }

  return { nAtoms: n, chain_id, res_id, ins_code, auth_seq_id, res_name, atom_name, element, hetero, is_polymer, coord, annotations };
}
