// Render only positioned atoms: missing coordinates and design placeholders
// remain in the editable document but must never participate in 3D geometry.
export function unpositionedAtomIndices(cif: string): number[] {
  const lines = cif.split(/\r?\n/);
  const loops = new Map<string, { fields: string[]; rows: string[][] }>();
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
    const category = fields[0]?.split(".", 1)[0];
    if (category !== "_atom_site" && category !== "_condition_coordinate_1_atom") continue;
    const rows: string[][] = [];
    while (lines[i + 1] && !/^(#|loop_|_|data_)/.test(lines[i + 1].trim())) {
      const row = lines[++i].trim();
      if (row) rows.push(row.match(/"(?:[^"]|"")*"|'(?:[^']|'')*'|\S+/g) ?? []);
    }
    loops.set(category, { fields, rows });
  }
  const atoms = loops.get("_atom_site");
  const coordinates = loops.get("_condition_coordinate_1_atom");
  if (!atoms) return [];
  const field = (columns: string[], name: string) => columns.indexOf(name);
  const atomIndex = field(atoms.fields, "_atom_site.atom_array_index");
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
      if (/^(false|0|no|n)$/i.test(row[mask])) {
        unknown.add(atomIndex < 0 ? index : Number(row[atomIndex]));
      }
    });
  }
  return atoms.rows.flatMap((row, index) => {
    const source = atomIndex < 0 ? index : Number(row[atomIndex]);
    const unresolved = positions.some(column => !Number.isFinite(Number(row[column])));
    const placeholder = unknown.has(source) && positions.every(column => Number(row[column]) === 0);
    return unresolved || placeholder ? [source] : [];
  });
}
