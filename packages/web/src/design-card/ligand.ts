/**
 * A ligand from its Chemical Component Dictionary code, as a one-residue mmCIF Studio can open or combine into a job:
 * the dictionary's ideal coordinates (its model coordinates where an ideal one is missing), heavy atoms only, moved so
 * its centre sits at `center`. The card fetches the entry from RCSB in the browser (`fetchCcdComponents`), builds the
 * file here, and posts it to `POST /api/v1/sessions` (then `/combine`), so no engine is needed.
 */
import { catRows, parseCifBlock } from "./cif.ts";
import type { CifBlock } from "./cif.ts";

/** CCD codes are 1-5 letters or digits ("SAM", "ZN", "HEM", "A1AAA"). */
export const isCcdCode = (code: unknown): boolean => /^[A-Z0-9]{1,5}$/.test(String(code ?? ""));

const num = (v: string | undefined): number | null => {
  const x = Number.parseFloat(v ?? "");
  return Number.isFinite(x) ? x : null;
};

type LigandAtom = { code: string; name: string; element: string; charge: number; xyz: number[] };

export function ligandCifFromCcd(
  ccd: string | CifBlock,
  { chainId = "L", center = null }: { chainId?: string; center?: number[] | null } = {},
): { cif: string; atoms: number; code: string } {
  const block = typeof ccd === "string" ? parseCifBlock(ccd) : ccd;
  const t = catRows(block.chem_comp_atom);
  if (!t.n) throw new Error("the dictionary entry has no atoms");
  const atoms: LigandAtom[] = [];
  for (let r = 0; r < t.n; r += 1) {
    const element = String(t.get("type_symbol", r) ?? "").toUpperCase();
    if (element === "H" || element === "D") continue;
    const ideal = ["pdbx_model_Cartn_x_ideal", "pdbx_model_Cartn_y_ideal", "pdbx_model_Cartn_z_ideal"].map((c) => num(t.get(c, r)));
    const model = ["model_Cartn_x", "model_Cartn_y", "model_Cartn_z"].map((c) => num(t.get(c, r)));
    const xyz = ideal.every((v) => v !== null) ? ideal : model.every((v) => v !== null) ? model : null;
    if (!xyz) continue;
    atoms.push({
      code: String(t.get("comp_id", r)),
      name: String(t.get("atom_id", r)),
      element,
      charge: Number.parseInt(t.get("charge", r) ?? "", 10) || 0,
      xyz: xyz as number[],
    });
  }
  if (!atoms.length) throw new Error("the dictionary entry has no coordinates");
  const code = atoms[0].code;
  const shift = [0, 1, 2].map((k) => (center ? center[k] : 0) - atoms.reduce((s, a) => s + a.xyz[k], 0) / atoms.length);
  // Atom names may hold quotes or spaces in the dictionary ("C1'"): quote them the way mmCIF does.
  const q = (s: string): string => (/[\s'"]/.test(s) ? (s.includes('"') ? `'${s}'` : `"${s}"`) : s);
  const lines = [
    `data_${code}`,
    "loop_",
    ...["group_PDB", "id", "type_symbol", "label_atom_id", "label_comp_id", "label_asym_id", "label_entity_id",
      "label_seq_id", "auth_seq_id", "auth_comp_id", "auth_asym_id", "auth_atom_id", "Cartn_x", "Cartn_y", "Cartn_z",
      "occupancy", "B_iso_or_equiv", "pdbx_formal_charge", "pdbx_PDB_model_num", "pdbx_PDB_ins_code", "label_alt_id"].map((c) => `_atom_site.${c}`),
    ...atoms.map((a, k) => {
      const [x, y, z] = a.xyz.map((v, j) => (v + shift[j]).toFixed(3));
      return ["HETATM", k + 1, a.element, q(a.name), code, chainId, 1, ".", 1, code, chainId, q(a.name), x, y, z,
        "1.00", "0.00", a.charge, 1, "?", "."].join(" ");
    }),
    "",
  ];
  return { cif: lines.join("\n"), atoms: atoms.length, code };
}

// ---- fetching ------------------------------------------------------------------------------------------------------

/** Where a component's dictionary entry is served (CORS-open, ~2-20 KB each). */
export const CCD_URL = (id: string): string => `https://files.rcsb.org/ligands/view/${encodeURIComponent(id)}.cif`;
const CACHE_NAME = "rfd4p-ccd-v1";
const memory = new Map<string, Promise<CifBlock>>();

type FetchFn = (url: string) => Promise<Response>;

async function fetchText(id: string, fetchFn: FetchFn): Promise<string> {
  const url = CCD_URL(id);
  let cache: Cache | null = null;
  try {
    cache = globalThis.caches ? await globalThis.caches.open(CACHE_NAME) : null;
    const hit = cache && (await cache.match(url));
    if (hit) return await hit.text();
  } catch {
    cache = null; // storage unavailable (private window, Node): fetch every time
  }
  const resp = await fetchFn(url);
  if (!resp.ok) throw new Error(`${id}: HTTP ${resp.status}`);
  const text = await resp.text();
  try {
    if (cache) await cache.put(url, new Response(text, { headers: { "Content-Type": "chemical/x-cif" } }));
  } catch {
    // best effort
  }
  return text;
}

/**
 * Fetch CCD entries; resolves to `{ blocks, failed }`. Never throws: a component that cannot be fetched is listed in
 * `failed`. Results are kept in memory (and in the Cache API where there is one) for later calls.
 */
export async function fetchCcdComponents(
  ids: string[],
  { fetchFn = globalThis.fetch?.bind(globalThis) as FetchFn }: { fetchFn?: FetchFn } = {},
): Promise<{ blocks: Map<string, CifBlock>; failed: string[] }> {
  const blocks = new Map<string, CifBlock>();
  const failed: string[] = [];
  await Promise.all(ids.map(async (id) => {
    try {
      if (!memory.has(id)) memory.set(id, fetchText(id, fetchFn).then(parseCifBlock));
      const block = await memory.get(id)!;
      if (!block.chem_comp_atom) throw new Error(`${id}: no _chem_comp_atom`);
      blocks.set(id, block);
    } catch (err) {
      memory.delete(id);
      failed.push(id);
      console.warn("CCD fetch failed:", err instanceof Error ? err.message : err);
    }
  }));
  return { blocks, failed };
}
