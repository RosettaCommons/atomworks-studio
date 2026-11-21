/**
 * What the card shows beside a run that does not depend on the engine: the hotspot residues, the reference motif and the
 * live designed sequence. All of it is read from the input document and from the frames and designs themselves (mmCIF
 * text), so a browser engine and a server engine are drawn the same way, by the same code.
 */
import { inputAnchors, type Anchors } from "./align.ts";
import { parseCifBlock, parseCifToAtoms, catRows } from "./cif.ts";
import type { DesignOverlay } from "./types.ts";
import type { AtomArray } from "./types.ts";
import { isSentinel } from "./spec.ts";
import type { ViewerResidue } from "../viewers/contract.ts";

/** The ghost the reference motif is drawn in: one colour, so it never reads as extra bonds on the sampled side chain. */
export const MOTIF_OVERLAY_OPTIONS = { label: "Motif (reference)", alpha: 0.35, color: 0xe2e8f0, sizeAspectRatio: 0.6 };

const finite3 = (c: unknown): c is number[] =>
  Array.isArray(c) && c.length >= 3 && Number.isFinite(c[0]) && Number.isFinite(c[1]) && Number.isFinite(c[2]);

const tokenKey = (a: AtomArray, i: number): string => `${a.chain_id[i]}|${a.res_id[i]}|${a.ins_code[i]}`;

/** The hotspot residues of the input, as `chain|resId|resName` keys. */
export function hotspotKeys(atoms: AtomArray): Set<string> {
  const keys = new Set<string>();
  const hot = atoms.annotations["condition_hotspot_1_atom"];
  if (!hot) return keys;
  for (let i = 0; i < atoms.nAtoms; i += 1) {
    if (hot[i]) keys.add(`${atoms.chain_id[i]}|${atoms.res_id[i]}|${atoms.res_name[i]}`);
  }
  return keys;
}

/** The keys' residues as a live frame names them (chain and number; a frame's residue names are the model's, not the input's). */
export function frameHotspots(keys: Set<string>): ViewerResidue[] {
  return [...keys].map((key) => {
    const [chain, residue] = key.split("|");
    return { chain, residue: Number(residue) } as ViewerResidue;
  });
}

/** The keys' residues as the viewer names them on a finished design: its CIF's author number and insertion code. */
export function designHotspots(cif: string, keys: Set<string>): ViewerResidue[] {
  if (!keys.size) return [];
  const a = parseCifToAtoms(cif);
  const found = new Map<string, ViewerResidue>();
  for (let i = 0; i < a.nAtoms; i += 1) {
    if (!keys.has(`${a.chain_id[i]}|${a.res_id[i]}|${a.res_name[i]}`)) continue;
    const r = { chain: a.chain_id[i], residue: a.auth_seq_id[i] ?? a.res_id[i], insCode: a.ins_code[i] } as ViewerResidue;
    found.set(`${r.chain}|${r.residue}|${a.ins_code[i]}`, r);
  }
  return [...found.values()];
}

/** Residues with no input coordinates at all (unmodelled, or new): they cannot be held, so they never make a motif. */
function unmodelledTokens(a: AtomArray): Set<string> {
  const modelled = new Set<string>();
  const all = new Set<string>();
  for (let i = 0; i < a.nAtoms; i += 1) {
    const key = tokenKey(a, i);
    all.add(key);
    if (finite3(a.coord[i])) modelled.add(key);
  }
  return new Set([...all].filter((t) => !modelled.has(t)));
}

/** A held part is a motif (not a kept domain the job extends) when it is at most a quarter of its chain. */
const isSmallMotif = (fixed: number, total: number): boolean => fixed > 0 && fixed < total && fixed <= total / 4;

/**
 * The reference motif as a stand-alone non-polymer mmCIF, at its conditioning coordinates (input frame), for drawing
 * beside each frame and design so a motif-scaffolding run keeps showing what it scaffolds. A motif is a
 * coordinate-conditioned residue that is unindexed, or indexed inside a chain that is otherwise designed; a chain whose
 * residues are all coordinate-conditioned is a target and is drawn by the frame itself. Null when there is none.
 */
export function motifOverlayCif(a: AtomArray): string | null {
  const crd = a.annotations["condition_coordinate_1_atom"];
  if (!crd) return null;
  const indexed = a.annotations["condition_index_1_residue"];
  const unmodelled = unmodelledTokens(a);
  const tokenChain = new Map<string, string>();
  const tokenHasCrd = new Map<string, boolean>();
  const tokenIndexed = new Map<string, boolean>();
  for (let i = 0; i < a.nAtoms; i += 1) {
    const t = tokenKey(a, i);
    if (unmodelled.has(t)) continue;
    tokenChain.set(t, a.chain_id[i]);
    if (finite3(crd[i])) tokenHasCrd.set(t, true);
    if (!tokenIndexed.has(t)) tokenIndexed.set(t, indexed ? Boolean(indexed[i]) : true);
  }
  const chains = new Map<string, { total: number; fixed: number }>();
  for (const [t, chain] of tokenChain) {
    const c = chains.get(chain) ?? { total: 0, fixed: 0 };
    c.total += 1;
    if (tokenHasCrd.get(t)) c.fixed += 1;
    chains.set(chain, c);
  }
  // A block of new residues is one placeholder in the input; it counts for the length it asks for (its range's middle).
  const segMin = a.annotations["annotation_expsegmin_1_residue"];
  const segMax = a.annotations["annotation_expsegmax_1_residue"];
  const counted = new Set<string>();
  for (let i = 0; i < a.nAtoms; i += 1) {
    const t = tokenKey(a, i);
    if (counted.has(t) || !unmodelled.has(t) || !isSentinel(a, i)) continue;
    counted.add(t);
    const c = chains.get(a.chain_id[i]) ?? { total: 0, fixed: 0 };
    c.total += ((Number(segMin?.[i]) || 1) + (Number(segMax?.[i]) || 1)) / 2;
    chains.set(a.chain_id[i], c);
  }
  const isMotif = (t: string): boolean => {
    if (!tokenHasCrd.get(t)) return false;
    const c = chains.get(tokenChain.get(t)!)!;
    return !tokenIndexed.get(t) || isSmallMotif(c.fixed, c.total);
  };
  const used = new Set(tokenChain.values());
  const chainId = [..."MNOPQRSTUVWXYZ"].find((c) => !used.has(c)) ?? "MOTIF";
  const rows: string[] = [];
  for (let i = 0; i < a.nAtoms; i += 1) {
    const c = crd[i];
    const name = a.atom_name[i];
    if (!finite3(c) || a.hetero[i] || !isMotif(tokenKey(a, i)) || !name || name === "UNK") continue;
    const q = /['"\s]/.test(name) ? `"${name}"` : name;
    const element = a.element[i] || name[0];
    rows.push(`HETATM ${rows.length + 1} ${element} ${q} ${a.res_name[i]} ${chainId} 1 ${a.res_id[i]} ${a.res_id[i]} ${chainId} ${c[0].toFixed(3)} ${c[1].toFixed(3)} ${c[2].toFixed(3)} 1.00 0.00 1`);
  }
  if (!rows.length) return null;
  return ["data_motif", "loop_", "_entity.id", "_entity.type", "1 non-polymer", "#", "loop_",
    ...["group_PDB", "id", "type_symbol", "label_atom_id", "label_comp_id", "label_asym_id", "label_entity_id", "label_seq_id",
      "auth_seq_id", "auth_asym_id", "Cartn_x", "Cartn_y", "Cartn_z", "occupancy", "B_iso_or_equiv", "pdbx_PDB_model_num"]
      .map((k) => `_atom_site.${k}`),
    ...rows, "#", ""].join("\n");
}

/** What a run shows beside every frame and design, made once from the input. */
export type RunContext = { hotspots: Set<string>; overlays: Record<string, DesignOverlay>; anchors: Anchors };

export function runContext(a: AtomArray): RunContext {
  const motif = motifOverlayCif(a);
  return {
    hotspots: hotspotKeys(a),
    overlays: motif ? { motif: { cif: motif, options: MOTIF_OVERLAY_OPTIONS } } : {},
    anchors: inputAnchors(a),
  };
}

// ---- The live designed sequence ----------------------------------------------------------------------------------

const ONE_LETTER: Record<string, string> = {
  ALA: "A", ARG: "R", ASN: "N", ASP: "D", CYS: "C", GLN: "Q", GLU: "E", GLY: "G", HIS: "H", ILE: "I",
  LEU: "L", LYS: "K", MET: "M", PHE: "F", PRO: "P", SER: "S", THR: "T", TRP: "W", TYR: "Y", VAL: "V",
  MSE: "M", UNK: "X", DA: "A", DC: "C", DG: "G", DT: "T", A: "A", C: "C", G: "G", U: "U",
};

export type StripResidue = { chainId: string; resId: number; resName: string; code: string };

/** The polymer residues of a frame (mmCIF text), in order. */
export function frameResidues(cif: string): StripResidue[] {
  const atomSite = catRows(parseCifBlock(cif)["atom_site"]);
  const out = new Map<string, StripResidue>();
  for (let r = 0; r < atomSite.n; r += 1) {
    const resName = atomSite.get("auth_comp_id", r) ?? atomSite.get("label_comp_id", r) ?? "";
    const code = ONE_LETTER[resName];
    if (!code) continue;
    const chainId = atomSite.get("auth_asym_id", r) ?? atomSite.get("label_asym_id", r) ?? "A";
    const resId = Number(atomSite.get("auth_seq_id", r) ?? atomSite.get("label_seq_id", r));
    const key = `${chainId}:${resId}`;
    if (!out.has(key)) out.set(key, { chainId, resId, resName, code });
  }
  return [...out.values()];
}

/**
 * The designed sequence of each live frame, drawn in Studio's sequence dock while a design runs. It sits beside
 * Studio's own (interactive) `#sequence-view`, which is only hidden meanwhile, so finishing, stopping or failing just
 * removes the strip and Studio's view is back untouched. Residues that changed since the previous frame are
 * highlighted, which shows the sequence settling.
 */
export class LiveSequenceStrip {
  private readonly dock = document.getElementById("sequence-dock");
  private readonly view = document.getElementById("sequence-view");
  private el: HTMLElement | null = null;
  private tokens = new Map<string, HTMLElement>();
  private hotspots = new Set<string>();

  /** @param hotspots `chain|resId|resName` keys of the input, marked as in Studio's view */
  start(hotspots: Set<string> = new Set()): void {
    this.hotspots = hotspots;
    if (!this.view || this.el) return;
    document.getElementById("rfd4p-live-sequence")?.remove();
    this.el = document.createElement("div");
    this.el.id = "rfd4p-live-sequence";
    this.el.className = "sequence-view";
    this.el.setAttribute("aria-live", "off");
    this.view.after(this.el);
    // On the dock, not the view: Studio's sequence render resets the view's className.
    this.dock?.classList.add("rfd4p-live");
    this.tokens.clear();
  }

  update(residues: StripResidue[]): void {
    if (!this.el) return;
    const next = new Map(residues.map((r) => [`${r.chainId}:${r.resId}`, r]));
    if (this.tokens.size !== next.size || [...next.keys()].some((k) => !this.tokens.has(k))) {
      this.build(next);
      return;
    }
    for (const [key, r] of next) {
      const tok = this.tokens.get(key)!;
      const diff = tok.textContent !== r.code;
      if (diff) {
        tok.textContent = r.code;
        tok.title = `${r.chainId}/${r.resName} ${r.resId}`;
      }
      tok.classList.toggle("rfd4p-changed", diff);
    }
  }

  private build(residues: Map<string, StripResidue>): void {
    if (!this.el) return;
    this.el.replaceChildren();
    this.tokens.clear();
    const tracks = new Map<string, HTMLElement>();
    for (const [key, r] of residues) {
      let track = tracks.get(r.chainId);
      if (!track) {
        const chain = document.createElement("div");
        chain.className = "sequence-chain";
        const color = (window as unknown as { atomworksStudio?: { chainColor?: (c: string) => string } }).atomworksStudio?.chainColor?.(r.chainId);
        if (color) chain.style.setProperty("--chain-color", color);
        const label = document.createElement("span");
        label.className = "sequence-chain-label";
        label.textContent = r.chainId;
        track = document.createElement("div");
        track.className = "sequence-track";
        chain.append(label, track);
        this.el.appendChild(chain);
        tracks.set(r.chainId, track);
      }
      const tok = document.createElement("span");
      tok.className = "sequence-token";
      if (this.hotspots.has(`${r.chainId}|${r.resId}|${r.resName}`)) tok.classList.add("condition-hotspot");
      tok.textContent = r.code;
      tok.title = `${r.chainId}/${r.resName} ${r.resId}`;
      track.appendChild(tok);
      this.tokens.set(key, tok);
    }
  }

  stop(): void {
    if (!this.el) return;
    this.el.remove();
    this.el = null;
    this.tokens.clear();
    this.dock?.classList.remove("rfd4p-live");
  }
}
