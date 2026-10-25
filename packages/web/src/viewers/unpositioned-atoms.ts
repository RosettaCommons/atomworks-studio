// Render only positioned atoms: missing coordinates and design placeholders
// remain in the editable document but must never participate in 3D geometry.

type Loop = { fields: string[]; rows: string[][] };

const CATEGORIES = /^_(?:atom_site|condition_coordinate_1_atom)\./;

/** The `_atom_site` and coordinate-condition loops, keyed by category. Scalar forms are read as a single row. */
function parseLoops(cif: string): Map<string, Loop> {
  const lines = cif.split(/\r?\n/);
  const loops = new Map<string, Loop>();
  for (let i = 0; i < lines.length; i++) {
    const scalar = lines[i].trim().match(/^(_(?:atom_site|condition_coordinate_1_atom)\.\S+)\s+(\S+)/);
    if (scalar) {
      const category = scalar[1].split(".", 1)[0];
      const table = loops.get(category) ?? { fields: [], rows: [[]] };
      table.fields.push(scalar[1]);
      table.rows[0].push(scalar[2]);
      loops.set(category, table);
      continue;
    }
    if (lines[i].trim() !== "loop_") continue;
    const fields: string[] = [];
    while (lines[i + 1]?.trim().startsWith("_")) fields.push(lines[++i].trim());
    if (!CATEGORIES.test(fields[0] ?? "")) continue;
    const rows: string[][] = [];
    while (lines[i + 1] && !/^(#|loop_|_|data_)/.test(lines[i + 1].trim())) {
      const row = lines[++i].trim();
      if (row) rows.push(row.match(/"(?:[^"]|"")*"|'(?:[^']|'')*'|\S+/g) ?? []);
    }
    loops.set(fields[0].split(".", 1)[0], { fields, rows });
  }
  return loops;
}

/** Document index of a row: the stored atom-array index where the file carries one, else the row's position. */
function documentIndex(atoms: Loop, row: string[], position: number): number {
  const column = atoms.fields.indexOf("_atom_site.atom_array_index");
  return column < 0 ? position : Number(row[column]);
}

export function unpositionedAtomIndices(cif: string): number[] {
  const loops = parseLoops(cif);
  const atoms = loops.get("_atom_site");
  const coordinates = loops.get("_condition_coordinate_1_atom");
  if (!atoms) return [];
  const field = (columns: string[], name: string) => columns.indexOf(name);
  const positions = ["Cartn_x", "Cartn_y", "Cartn_z"].map(name =>
    field(atoms.fields, `_atom_site.${name}`));
  if (positions.includes(-1)) return [];
  const unknown = new Set<number>();
  if (coordinates) {
    const coordinateIndex = field(coordinates.fields, "_condition_coordinate_1_atom.idx0");
    const values = ["val0", "val1", "val2"].map(name =>
      field(coordinates.fields, `_condition_coordinate_1_atom.${name}`));
    if (coordinateIndex >= 0 && !values.includes(-1)) {
      for (const row of coordinates.rows) {
        if (values.some(index => !Number.isFinite(Number(row[index])))) {
          unknown.add(Number(row[coordinateIndex]));
        }
      }
    }
  } else {
    const mask = field(atoms.fields, "_atom_site.mask_coordinate_1_atom");
    if (mask >= 0) atoms.rows.forEach((row, index) => {
      if (/^(false|0|no|n)$/i.test(row[mask])) unknown.add(documentIndex(atoms, row, index));
    });
  }
  return atoms.rows.flatMap((row, index) => {
    const source = documentIndex(atoms, row, index);
    const unresolved = positions.some(column => !Number.isFinite(Number(row[column])));
    const placeholder = unknown.has(source) && positions.every(column => Number(row[column]) === 0);
    return unresolved || placeholder ? [source] : [];
  });
}

/**
 * Carbon atoms per chain, in document indices, for backends that colour by running commands rather than by theme.
 * Carbons only, so the chain palette reads the same as the Mol* theme and heteroatoms keep their element colours.
 */
export function carbonIndicesByChain(cif: string): Map<string, number[]> {
  const atoms = parseLoops(cif).get("_atom_site");
  const chainColumn = atoms?.fields.indexOf("_atom_site.label_asym_id") ?? -1;
  const elementColumn = atoms?.fields.indexOf("_atom_site.type_symbol") ?? -1;
  if (!atoms || chainColumn < 0 || elementColumn < 0) return new Map();
  const byChain = new Map<string, number[]>();
  atoms.rows.forEach((row, position) => {
    if (row[elementColumn]?.replace(/^["']|["']$/g, "").toUpperCase() !== "C") return;
    const chain = row[chainColumn]?.replace(/^["']|["']$/g, "");
    if (!chain || chain === "." || chain === "?") return;
    const indices = byChain.get(chain);
    if (indices) indices.push(documentIndex(atoms, row, position));
    else byChain.set(chain, [documentIndex(atoms, row, position)]);
  });
  return byChain;
}
