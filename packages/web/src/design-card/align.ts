/**
 * Puts a finished design in the input's frame of reference, so it opens over the input and under the reference motif
 * the card draws. A browser engine already returns designs there; a server's model may place them anywhere, which is
 * cosmetic for the model and wrong for the person (the motif ghost floats away from the design). The fit is rigid, over
 * the atoms the input holds in its largest coordinate group (groups are rigid bodies that may move against each other;
 * the model's own alignment takes the largest too), at their coordinates, matched to the design by chain, residue
 * number, residue name and atom name.
 */
import { parseCifToAtoms } from "./cif.ts";
import type { AtomArray } from "./types.ts";

type Vec = [number, number, number];
/** Held atoms by key: where the input has them, and the coordinate group they are held in. */
export type Anchors = Map<string, { xyz: Vec; group: number }>;

const finite3 = (c: unknown): c is Vec => Array.isArray(c) && c.length >= 3 && c.slice(0, 3).every(Number.isFinite);
const key = (a: AtomArray, i: number): string => `${a.chain_id[i]}|${a.res_id[i]}|${a.ins_code[i]}|${a.res_name[i]}|${a.atom_name[i]}`;

/** The atoms the input holds (a coordinate group other than -1), by key, at their input coordinates. */
export function inputAnchors(a: AtomArray): Anchors {
  const group = a.annotations["condition_CoordinateGroup_1_atom"];
  const anchors: Anchors = new Map();
  if (!group) return anchors;
  for (let i = 0; i < a.nAtoms; i += 1) if (group[i] !== -1 && finite3(a.coord[i])) anchors.set(key(a, i), { xyz: [a.coord[i][0], a.coord[i][1], a.coord[i][2]], group: Number(group[i]) });
  return anchors;
}

/** Eigenvector of the largest eigenvalue of a symmetric 4x4 matrix (cyclic Jacobi). */
function topEigenvector(m: number[][]): number[] {
  const a = m.map((row) => [...row]);
  const v: number[][] = [0, 1, 2, 3].map((i) => [0, 1, 2, 3].map((j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 50; sweep += 1) {
    let off = 0;
    for (let p = 0; p < 3; p += 1) for (let q = p + 1; q < 4; q += 1) off += a[p][q] ** 2;
    if (off < 1e-20) break;
    for (let p = 0; p < 3; p += 1) {
      for (let q = p + 1; q < 4; q += 1) {
        if (Math.abs(a[p][q]) < 1e-30) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < 4; k += 1) { const x = a[k][p], y = a[k][q]; a[k][p] = c * x - s * y; a[k][q] = s * x + c * y; }
        for (let k = 0; k < 4; k += 1) { const x = a[p][k], y = a[q][k]; a[p][k] = c * x - s * y; a[q][k] = s * x + c * y; }
        for (let k = 0; k < 4; k += 1) { const x = v[k][p], y = v[k][q]; v[k][p] = c * x - s * y; v[k][q] = s * x + c * y; }
      }
    }
  }
  const best = [0, 1, 2, 3].reduce((i, j) => (a[j][j] > a[i][i] ? j : i));
  return v.map((row) => row[best]);
}

/** The rigid motion taking `from` onto `to` (Horn's quaternion method), with the RMSD before and after it. */
export function fitRigid(from: Vec[], to: Vec[]): { move: (p: Vec) => Vec; before: number; after: number } {
  const n = from.length;
  const mean = (pts: Vec[]): Vec => [0, 1, 2].map((d) => pts.reduce((s, p) => s + p[d], 0) / n) as Vec;
  const [cf, ct] = [mean(from), mean(to)];
  const s = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let k = 0; k < n; k += 1) for (let i = 0; i < 3; i += 1) for (let j = 0; j < 3; j += 1) s[i][j] += (from[k][i] - cf[i]) * (to[k][j] - ct[j]);
  const [sxx, sxy, sxz, syx, syy, syz, szx, szy, szz] = s.flat();
  const [w, x, y, z] = topEigenvector([
    [sxx + syy + szz, syz - szy, szx - sxz, sxy - syx],
    [syz - szy, sxx - syy - szz, sxy + syx, szx + sxz],
    [szx - sxz, sxy + syx, -sxx + syy - szz, syz + szy],
    [sxy - syx, szx + sxz, syz + szy, -sxx - syy + szz],
  ]);
  const r = [
    [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
    [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
    [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
  ];
  const move = (p: Vec): Vec => {
    const d = [p[0] - cf[0], p[1] - cf[1], p[2] - cf[2]];
    return [0, 1, 2].map((i) => r[i][0] * d[0] + r[i][1] * d[1] + r[i][2] * d[2] + ct[i]) as Vec;
  };
  const rmsd = (f: (p: Vec) => Vec): number => Math.sqrt(from.reduce((sum, p, k) => sum + f(p).reduce((t, c, i) => t + (c - to[k][i]) ** 2, 0), 0) / n);
  return { move, before: rmsd((p) => p), after: rmsd(move) };
}

/** `text` (mmCIF, one atom per line) with every atom's coordinates moved by `move`; unchanged if it cannot be read. */
export function moveCif(text: string, move: (p: Vec) => Vec): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let columns: string[] = [];
  let inLoop = false;
  const token = /'[^']*'|"[^"]*"|\S+/g;
  for (const line of lines) {
    if (line.startsWith("_atom_site.")) { columns.push(line.trim().slice("_atom_site.".length)); out.push(line); continue; }
    const header = columns.length > 0 && !inLoop;
    if (header) inLoop = true;
    const [ix, iy, iz] = ["Cartn_x", "Cartn_y", "Cartn_z"].map((c) => columns.indexOf(c));
    if (inLoop && ix >= 0 && iy >= 0 && iz >= 0 && line && !/^(#|loop_|_|data_)/.test(line)) {
      const fields = line.match(token) ?? [];
      if (fields.length !== columns.length) return text;
      const p = [fields[ix], fields[iy], fields[iz]].map(Number) as Vec;
      if (p.every(Number.isFinite)) [fields[ix], fields[iy], fields[iz]] = move(p).map((c) => c.toFixed(3));
      out.push(fields.join(" "));
      continue;
    }
    if (inLoop && /^(#|loop_|data_)/.test(line)) { columns = []; inLoop = false; }
    out.push(line);
  }
  return out.join("\n");
}

/**
 * The design (and its trajectory, whose last model it is) in the input's frame; both unchanged when it already is
 * (within 0.3 A over the largest group's atoms), when fewer than three of them are found in it, or when the fit is poor.
 */
export function alignToInput(anchors: Anchors, cif: string, trajectoryCif?: string | null): { cif: string; trajectoryCif: string | null } {
  const same = { cif, trajectoryCif: trajectoryCif ?? null };
  if (anchors.size < 3) return same;
  const design = parseCifToAtoms(cif);
  const matched = new Map<number, { from: Vec[]; to: Vec[] }>();
  for (let i = 0; i < design.nAtoms; i += 1) {
    const held = anchors.get(key(design, i));
    if (!held || !finite3(design.coord[i])) continue;
    const m = matched.get(held.group) ?? { from: [], to: [] };
    m.from.push([design.coord[i][0], design.coord[i][1], design.coord[i][2]]);
    m.to.push(held.xyz);
    matched.set(held.group, m);
  }
  const { from, to } = [...matched.values()].reduce((a, b) => (b.from.length > a.from.length ? b : a), { from: [] as Vec[], to: [] as Vec[] });
  if (from.length < 3) return same;
  const fit = fitRigid(from, to);
  if (fit.before < 0.3 || fit.after > 1) return same;
  return { cif: moveCif(cif, fit.move), trajectoryCif: trajectoryCif ? moveCif(trajectoryCif, fit.move) : null };
}
