/**
 * The card's job editor, ported from the RFD4-Proteina page's design panel (web/design-panel.js): a "what do you want
 * to design?" start screen, a view of what the open input will generate (chains, pieces, ligands, hotspots, lengths)
 * with the popups that edit it, and the guided examples built from their PDB entries.
 *
 * Unlike the page's, this panel knows no engine and no in-page document: it reads the open session over Studio's REST
 * API (`doc.ts`) and edits it through `window.atomworksStudio.applyEdit` (Studio's own mutate path, so Undo, the viewer
 * and the `atomworks-studio` "changed" event behave exactly as for edits made in Studio's panels). An example being
 * built lives in a session Studio does not show until it is finished, and is edited by the same requests.
 */
import { api, apiText } from "../api.ts";
import { parseCifBlock } from "./cif.ts";
import { SessionDoc, createSession, deleteSession } from "./doc.ts";
import type { ChainPlan, PlanPart, RebuildPart } from "./doc.ts";
import { fetchCcdComponents, isCcdCode, ligandCifFromCcd } from "./ligand.ts";
import { INTERACTIONS, designSpec, formatResidueList, parseResidueList } from "./spec.ts";
import type { ChainSpec, DesignSpec, LigandSpec, NewPiece, PieceSpec, RunPiece } from "./spec.ts";
import {
  ATOM_OPTIONS, CONDITION_KEY, EXPOSURE_OPTIONS, FOLD_OPTIONS, FREE_TRANSPARENCY, HOTSPOT_COLOR, INTERACTION_OPTIONS,
  POSITION_OPTIONS, SEQUENCE_OPTIONS, SHAPE_LETTER, SHAPE_OPTIONS, STRUCTURE_NOTE, STRUCTURE_OPTIONS, TASKS,
} from "./tasks.ts";
import type { Option, Task } from "./tasks.ts";
import type { AtomArray, StudioHandle } from "./types.ts";
import type { ViewerResidue } from "../viewers/contract.ts";

type Child = Node | string | null | undefined | false;
type Attrs = Record<string, string | number | boolean | null | undefined | ((event: Event) => void)>;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = String(v);
    else if (k === "text") node.textContent = String(v);
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) if (c != null && c !== false) node.append(c);
  return node;
};

const SENTINEL = /^\d+-\d+$/;
const msg = (err: unknown): string => String((err as Error | undefined)?.message ?? err).replace(/^Error:\s*/, "");

/** An edit of the conditions (`POST .../conditions/batch`). */
type ConditionEdit = {
  condition: string;
  atom_indices: number[];
  enabled: boolean;
  value?: number | string;
  scope?: "residue" | "atom";
};

/** What a piece is, as its popup and its row name it. */
type Properties = { structure: string; atoms: string; names: string; sequence: string; position: string };
type Want = { structure: string; atoms: string | string[]; sequence: string; position: string };
type PieceChange = { p: PieceSpec | { kind: "kept"; keep?: string }; atoms: number[]; want: Want };
type SourceGroup = { label: string | null; chains: ChainSpec[] };
type AddForm = { form: HTMLFormElement; title: HTMLElement; fetchBtn: HTMLButtonElement; status: HTMLElement; id: HTMLInputElement; replace: number[] | null };
type RangeReach = { lo: number; hi: number; iLo: number; iHi: number; present?: Set<number> };
type Pop = { head: HTMLElement; rows: (HTMLElement | null)[] };

/** What the panel asks of the card around it. */
export interface PanelHost {
  studio(): StudioHandle | undefined;
  /** The session of the input (what Generate uses), or null while Studio has none open. */
  inputSessionId(): string | null;
  /** Whether Studio shows a generated design rather than the input (edits would then fork from that design). */
  isViewingDesign(): boolean;
  /** The partial-diffusion controls. */
  partialDiffusion(): { on: boolean; percent: number };
  setPartialDiffusion(on: boolean, percent?: number | null): void;
  setStatus(text: string, isError?: boolean): void;
  /** Redraw the tabs and the designs after the job changed. */
  renderDesigns(): void;
  /** Keep Generate off while there is nothing to generate. */
  setNothingToGenerate(nothing: boolean): void;
  /** Hotspots to colour while a run's frames are on screen (numbered as the frames are), or null. */
  liveHotspots(): ViewerResidue[] | null;
  /** The shown design's own hotspots, when a design is shown. */
  shownDesignHotspots(): ViewerResidue[] | null;
  /** The job changed: the engine may get ready for it. */
  inputChanged(spec: DesignSpec): void;
  /** Whether the Undo button may go back: false at the point an example was opened at. */
  undoFloor(sessionId: string): number;
  setUndoFloor(sessionId: string, depth: number): void;
}

/** A structure file's text as mmCIF: PDB files are converted, mmCIF is passed on. */
export function structureTextAsCif(text: string, name: string): string {
  if (text.includes("_atom_site.") || !/(?:^|\n)(?:ATOM  |HETATM)/.test(text)) return text;
  const cols = ["group_PDB", "id", "type_symbol", "label_atom_id", "label_alt_id", "label_comp_id", "label_asym_id", "label_entity_id",
    "label_seq_id", "pdbx_PDB_ins_code", "auth_seq_id", "auth_comp_id", "auth_asym_id", "auth_atom_id", "Cartn_x", "Cartn_y", "Cartn_z",
    "occupancy", "B_iso_or_equiv", "pdbx_formal_charge", "pdbx_PDB_model_num"];
  const q = (s: string): string => (/[\s'"]/.test(s) ? (s.includes('"') ? `'${s}'` : `"${s}"`) : s || ".");
  const rows: string[] = [`data_${name.replace(/\s+/g, "_") || "structure"}`, "loop_", ...cols.map((c) => `_atom_site.${c}`)];
  let id = 0;
  let model = 1;
  const entities = new Map<string, number>();
  let lastKey = "";
  let seq = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("ENDMDL")) { model += 1; continue; }
    if (model > 1) break;
    if (!line.startsWith("ATOM") && !line.startsWith("HETATM")) continue;
    const group = line.startsWith("HETATM") ? "HETATM" : "ATOM";
    const atom = line.slice(12, 16).trim();
    const alt = line.slice(16, 17).trim();
    const comp = line.slice(17, 20).trim();
    const chain = line.slice(21, 22).trim() || "A";
    const num = line.slice(22, 26).trim();
    const ins = line.slice(26, 27).trim();
    const x = line.slice(30, 38).trim();
    const y = line.slice(38, 46).trim();
    const z = line.slice(46, 54).trim();
    const occ = line.slice(54, 60).trim() || "1.00";
    const b = line.slice(60, 66).trim() || "0.00";
    const element = (line.slice(76, 78).trim() || atom.replace(/[^A-Za-z]/g, "").slice(0, 1)).toUpperCase();
    const key = `${chain}|${num}|${ins}|${comp}`;
    if (key !== lastKey) { seq += 1; lastKey = key; }
    if (!entities.has(chain)) entities.set(chain, entities.size + 1);
    id += 1;
    rows.push([group, id, element, q(atom), alt || ".", comp, chain, entities.get(chain), group === "ATOM" ? seq : ".", ins || "?", num, comp, chain,
      q(atom), x, y, z, occ, b, "?", 1].join(" "));
  }
  if (!id) throw new Error("no atoms found in the file");
  return `${rows.join("\n")}\n`;
}

/**
 * What "1J79 A C" or "9FJX B LVY" keeps of an entry: the chains named, with the ligands the entry files under them
 * (`pdbx_nonpoly_scheme.pdb_strand_id`: lenalidomide and zinc are label chains J and I, author chain B), and any
 * ligand named by its code. Throws, naming the chains and ligands there are, for a name that is neither.
 */
export function namedAtoms(a: AtomArray, nonpoly: { asym: string[]; strand: string[] }, names: string[]): number[] {
  const strandOf = new Map(nonpoly.asym.map((id, k) => [String(id).toUpperCase(), String(nonpoly.strand[k] ?? "").toUpperCase()]));
  const chainOf = (i: number): string => String(a.chain_id[i]).toUpperCase();
  const present = new Set(Array.from(a.chain_id, (c) => String(c).toUpperCase()));
  const codes = new Set(Array.from(a.res_name, (r) => String(r).toUpperCase()));
  const keepChains = new Set<string>();
  const keepCodes = new Set<string>();
  const missing: string[] = [];
  for (const raw of names) {
    const n = String(raw).toUpperCase();
    if (present.has(n)) {
      keepChains.add(n);
      for (const [label, auth] of strandOf) if (auth === n && present.has(label)) keepChains.add(label);
    } else if (codes.has(n)) keepCodes.add(n);
    else missing.push(raw);
  }
  if (missing.length) {
    const ligands = [...present].filter((c) => strandOf.has(c)).map((c) => {
      const i = Array.from(a.chain_id, (x) => String(x).toUpperCase()).indexOf(c);
      return String(a.res_name[i]);
    });
    const chains = [...present].filter((c) => !strandOf.has(c));
    throw new Error(`no chain or ligand ${missing.join(", ")} (chains ${chains.join(", ")}${ligands.length ? `; ligands ${[...new Set(ligands)].join(", ")}` : ""})`);
  }
  const keep: number[] = [];
  for (let i = 0; i < a.nAtoms; i += 1) if (keepChains.has(chainOf(i)) || keepCodes.has(String(a.res_name[i]).toUpperCase())) keep.push(i);
  return keep;
}

/** Atom `i`'s insertion code as the document's CIF writes it, "" for none ("." and "?" are none). */
const insCodeOf = (atoms: AtomArray, i: number): string => { const c = String(atoms.ins_code?.[i] ?? ""); return c === "." || c === "?" ? "" : c; };

/**
 * Atom `i`'s residue as the viewer names it: chain, the document's auth_seq_id (a fetched entry keeps its authors'
 * numbering there, not res_id: 5O45's A40 is author residue 56) and insertion code, without which an antibody's H82
 * would also be H82A, H82B and H82C.
 */
const viewerResidue = (atoms: AtomArray, i: number): ViewerResidue => ({
  chain: String(atoms.chain_id[i]), residue: Number(atoms.auth_seq_id?.[i] ?? atoms.res_id[i]), insCode: insCodeOf(atoms, i),
});

/** A minimal mmCIF of chain `chain`'s residues numbered `nums` in `atoms` (an overlay: the viewer draws it as given). */
function atomsCif(atoms: AtomArray, chain: string, nums: Set<number>): string | null {
  const rows = ["data_overlay", "loop_", ...["group_PDB", "id", "type_symbol", "label_atom_id", "label_comp_id", "label_asym_id",
    "label_entity_id", "label_seq_id", "auth_seq_id", "auth_asym_id", "Cartn_x", "Cartn_y", "Cartn_z", "occupancy", "B_iso_or_equiv",
    "pdbx_PDB_model_num"].map((k) => `_atom_site.${k}`)];
  let id = 0;
  for (let i = 0; i < atoms.nAtoms; i += 1) {
    if (String(atoms.chain_id[i]) !== chain || !nums.has(Number(atoms.res_id[i]))) continue;
    const c = atoms.coord[i];
    if (!c || !Number.isFinite(c[0])) continue;
    const element = String(atoms.element?.[i] ?? String(atoms.atom_name[i])[0]).toUpperCase() || "C";
    const name = String(atoms.atom_name[i]);
    id += 1;
    rows.push(`ATOM ${id} ${element} ${/['"\s]/.test(name) ? `"${name}"` : name} ${atoms.res_name[i]} ${chain} 1 ${atoms.res_id[i]} ${atoms.res_id[i]} ${chain} ${c[0].toFixed(3)} ${c[1].toFixed(3)} ${c[2].toFixed(3)} 1.00 0.00 1`);
  }
  return id ? `${rows.join("\n")}\n` : null;
}

/** The index of the last element `f` accepts, or -1. */
const lastIndexOf = <T>(items: T[], f: (item: T) => boolean): number => {
  for (let i = items.length - 1; i >= 0; i -= 1) if (f(items[i])) return i;
  return -1;
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class DesignPanel {
  readonly host: PanelHost;
  private readonly tasks: Task[];
  selectionCount = 0;
  busy = false;
  building = false;
  showStart = false;
  lastError: string | null = null;
  closedSession: string | null = null;
  applying: Promise<unknown> | null = null;
  private buildDoc: SessionDoc | null = null;
  private inputDoc: SessionDoc | null = null;
  private inputToken = 0;
  private lastNotified = "";
  private readonly els: Record<string, HTMLElement | null>;
  private pop: HTMLElement;
  private piecePop: HTMLElement | null = null;
  private lastPointer: { x: number; y: number } | null = null;
  private popSpot: { left: number; top: number } | null = null;
  private addStructure!: AddForm;
  private startStructure!: { form: HTMLFormElement; id: HTMLInputElement; status: HTMLElement };
  private startLigandForm: HTMLFormElement | null = null;
  private addLigandForm: HTMLFormElement | null = null;
  private cardPicking = false;
  private cardSelected = false;
  private cardPickTimer: ReturnType<typeof setTimeout> | undefined;
  private planPreview = false;
  private previewNext: { c: ChainSpec; parts: RebuildPart[]; gen: number } | null = null;
  private previewBusy = false;
  private previewGen = 0;
  private ghostKey: string | null = null;
  private ghostOn = false;
  private highlightSent: Record<string, string> = {};
  private hotspotQueue: Promise<unknown> = Promise.resolve();
  private readonly sources = new Map<string, Map<string, string | null>>();
  private readonly titles = new Map<string, string>();
  private readonly cardAtoms = new WeakMap<HTMLElement, number[]>();
  private readonly cleanups: (() => void)[] = [];
  private readonly root: HTMLElement;

  constructor(host: PanelHost, root: HTMLElement, tasks: Task[] = TASKS) {
    this.host = host;
    this.root = root;
    this.tasks = tasks;
    const $ = (id: string): HTMLElement | null => document.getElementById(id);
    this.els = {
      start: $("rfd4p-start"),
      taskGrid: $("rfd4p-task-grid"),
      fetchStatus: $("rfd4p-fetch-status"),
      design: $("rfd4p-design"),
      taskLabel: $("rfd4p-task-label"),
      taskDetail: $("rfd4p-task-detail"),
      newDoc: $("rfd4p-new"),
      chainList: $("rfd4p-chain-list"),
      addSeq: $("rfd4p-add-seq"),
      startSeq: $("rfd4p-start-seq"),
      startPdb: $("rfd4p-start-pdb"),
      startLig: $("rfd4p-start-lig"),
      addPdb: $("rfd4p-add-pdb"),
      addLig: $("rfd4p-add-lig"),
      undo: $("rfd4p-undo"),
      warnings: $("rfd4p-warnings"),
      runSettings: $("rfd4p-run-settings"),
      advanced: $("rfd4p-advanced"),
    };
    // Floating actions next to the pointer for the current selection (viewer or sequence bar).
    this.pop = el("div", { class: "rfd4p-piece-pop rfd4p-sel-pop", role: "dialog", "aria-label": "Selected residues", hidden: true });
    document.body.append(this.pop);
    this._movable(this.pop);
    this._buildAddStructure();
    this._buildStartStructure();
    this._buildTaskGrid();
    this._bind();
    // The Studio editor is off on every load: the card's editor is the page's.
    this._applyAdvanced(false);
    try { localStorage.removeItem("rfd4p-advanced-editor"); } catch { /* private mode */ }
    this.render();
  }

  destroy(): void {
    for (const fn of this.cleanups.splice(0)) fn();
    this.pop.remove();
    this.piecePop?.remove();
    this._endPreview();
  }

  private studio(): StudioHandle | undefined {
    return this.host.studio();
  }

  private listen<K extends keyof WindowEventMap>(target: Window, type: K, fn: (ev: WindowEventMap[K]) => void, capture?: boolean): void;
  private listen<K extends keyof DocumentEventMap>(target: Document, type: K, fn: (ev: DocumentEventMap[K]) => void, capture?: boolean): void;
  private listen(target: Window | Document, type: string, fn: (ev: never) => void, capture = false): void {
    target.addEventListener(type, fn as EventListener, capture);
    this.cleanups.push(() => target.removeEventListener(type, fn as EventListener, capture));
  }

  // ---- the open input -----------------------------------------------------------------------------------------

  /** The host says which session is the input now (or none): read it, then draw. */
  async setInputSession(sid: string | null): Promise<void> {
    const token = (this.inputToken += 1);
    if (!sid) {
      this.inputDoc = null;
      this.render();
      return;
    }
    if (this.inputDoc?.sid === sid) {
      await this.syncInput();
      return;
    }
    const doc = new SessionDoc(sid);
    try { await doc.refresh(); } catch (err) { console.warn("Could not read the input:", err); return; }
    if (token !== this.inputToken) return;
    this.inputDoc = doc;
    this.render();
  }

  /** Read the input again after Studio changed it (an edit, Undo). */
  async syncInput(): Promise<void> {
    const doc = this.inputDoc;
    if (!doc) return;
    try { await doc.refresh(); } catch (err) { console.warn("Could not refresh the input:", err); return; }
    // Drawn again whether or not the document changed: what Studio shows (the input or a design) decides read-only.
    if (this.inputDoc === doc) this.render();
  }

  /** The input document (what Generate will use), if the Studio has one open. */
  _inputDoc(): SessionDoc | null {
    // An example being built lives in a session Studio does not show until it is finished.
    return this.buildDoc ?? this.inputDoc;
  }

  inputDocument(): SessionDoc | null {
    return this.inputDoc;
  }

  /** What the open input asks for, as `_spec` reads it (null with nothing open). */
  inputSpec(): DesignSpec | null {
    return this._spec();
  }

  _spec(): DesignSpec | null {
    const doc = this._inputDoc();
    if (!doc || !doc.nAtoms) return null;
    const { on, percent } = this.host.partialDiffusion();
    return designSpec(doc.atoms, { partialDiffusion: on, partialPercent: percent });
  }

  /** The Studio session the card is showing the edits of: the build session while an example is made. */
  private _session(): string | null {
    return this._inputDoc()?.sid ?? null;
  }

  // ---- adding structures ----------------------------------------------------------------------------------------

  /**
   * "+ pdb": a structure's chains added to the open job, fixed as they are (a target). Opened from a source caption,
   * the same form replaces that source's chains instead, so an example's target is swapped without setting the job up
   * again.
   */
  private _buildAddStructure(): void {
    const actions = this.els.addPdb?.parentElement;
    if (!actions) return;
    const id = this._structureInput();
    const fileInput = el("input", { type: "file", accept: ".cif,.mmcif,.pdb,.ent", hidden: true });
    const fileBtn = el("button", { type: "button", class: "secondary compact", text: "Open a file…", onclick: () => fileInput.click() });
    const { form, status, title, submit: fetchBtn } = this._addForm({
      label: "Add a structure", button: "Add", input: id, extra: [fileBtn, fileInput], note: STRUCTURE_NOTE,
      onClose: () => { form.hidden = true; },
      onSubmit: async () => {
        const m = /^\s*([0-9][A-Za-z0-9]{3})(?:[\s:_,]+(.*))?$/.exec(id.value);
        if (!m) { status.textContent = "Type a 4-character PDB ID, optionally followed by chains: 5O45 A"; return; }
        const pdb = m[1].toUpperCase();
        const chains = (m[2] ?? "").split(/[\s,;]+/).filter(Boolean);
        status.textContent = `Downloading ${pdb} from RCSB…`;
        try {
          const res = await fetch(`https://files.rcsb.org/download/${pdb}.cif`);
          if (!res.ok) throw new Error(res.status === 404 ? `${pdb} was not found` : `RCSB returned ${res.status}`);
          const text = await res.text();
          this._rememberTitle(`PDB ${pdb}`, text);
          await this._addStructureFrom(text, pdb, chains, this.addStructure.replace);
        } catch (err) {
          status.textContent = `Could not add ${pdb}: ${msg(err)}`;
        }
      },
    });
    form.hidden = true;
    this.addStructure = { form, title, fetchBtn, status, id, replace: null };
    fileInput.addEventListener("change", () => {
      const file = fileInput.files?.[0];
      fileInput.value = "";
      if (file) void this._addFile(file);
    });
    actions.after(form);
  }

  /** A structure file's chains added to the open job (the + pdb form's file, or one dropped on the page). */
  async _addFile(file: File): Promise<void> {
    const { id, status, replace } = this.addStructure;
    const chains = id.value.trim().split(/[\s,;]+/).filter((t) => /^[A-Za-z0-9]{1,4}$/.test(t) && !/^[0-9][A-Za-z0-9]{3}$/.test(t));
    try {
      if (/\.zst$/i.test(file.name)) throw new Error("compressed files (.zst) are not read here; unpack it first");
      const name = file.name.replace(/\.(cif|mmcif|pdb|ent)+$/i, "");
      await this._addStructureFrom(structureTextAsCif(await file.text(), name), name, chains, replace);
    } catch (err) {
      status.textContent = `Could not add ${file.name}: ${msg(err)}`;
      this.host.setStatus(status.textContent, true);
    }
  }

  /**
   * A structure file dropped anywhere on the page does what the visible "Open a file…" would: on the start screen it
   * opens as a new job, with a job open its chains are added (+ pdb). Taken in the capture phase, so Mol*'s own drop
   * (which loads the file into the viewer only, outside any job) never sees it, nor the dragenter that shows its "Load
   * Files" overlay: the overlay goes away on Mol*'s drop, so it stayed up.
   */
  private _bindDrop(): void {
    const isFiles = (e: DragEvent): boolean => [...(e.dataTransfer?.types ?? [])].includes("Files");
    for (const type of ["dragenter", "dragover"] as const) {
      this.listen(window, type, (e) => {
        if (!isFiles(e)) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      }, true);
    }
    this.listen(window, "drop", (e) => {
      if (!isFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      const file = [...(e.dataTransfer?.files ?? [])][0];
      if (!file) return;
      const onStart = !document.getElementById("rfd4p-start")?.hidden;
      if (!onStart && this.addStructure) { void this._addFile(file); return; }
      // Studio opens mmCIF only; + pdb, once a job is open, also takes PDB files.
      if (!/\.(cif|mmcif)$/i.test(file.name)) {
        this.host.setStatus(`${file.name}: a new job opens from an mmCIF file (.cif); PDB files can be added to a job with + pdb`, true);
        return;
      }
      void this._openFile(file);
    }, true);
  }

  /** A file opened as a new job, as Studio's Open button does. */
  private async _openFile(file: File): Promise<void> {
    const studio = this.studio();
    if (!studio?.openFile) return;
    const opened = await studio.openFile(file);
    if (opened !== false) this.showStart = false;
    this.render();
  }

  /** The start screen's + pdb: the same form, opening the structure as a new job. */
  private _buildStartStructure(): void {
    const actions = this.els.startPdb?.parentElement;
    if (!actions) return;
    const id = this._structureInput();
    // Not in the page: opening a file here is Studio's own (`openFile`), as the page uses Studio's file input.
    const fileInput = el("input", { type: "file", accept: ".cif,.mmcif,chemical/x-mmcif" });
    fileInput.addEventListener("change", () => {
      const file = fileInput.files?.[0];
      fileInput.value = "";
      if (file) void this._openFile(file);
    });
    const fileBtn = el("button", { type: "button", class: "secondary compact", text: "Open a file…", onclick: () => fileInput.click() });
    const { form, status } = this._addForm({
      label: "Add a structure", button: "Add", input: id, extra: [fileBtn], note: STRUCTURE_NOTE,
      onClose: () => { form.hidden = true; },
      onSubmit: (st) => { void this._fetchPdb(id.value, st); },
    });
    form.hidden = true;
    this.startStructure = { form, id, status };
    actions.after(form);
  }

  /** The + pdb form; with `group` (a source caption's chains), it replaces them. */
  private _openAddStructure(group: SourceGroup | null = null): void {
    const { form, title, fetchBtn, status, id } = this.addStructure ?? {};
    if (!form) return;
    this.addStructure.replace = group ? group.chains.flatMap((c) => c.atomIndices) : null;
    title.textContent = group ? `Replace ${group.label}` : "Add a structure";
    fetchBtn.textContent = group ? "Replace" : "Add";
    // The source's own ID and chains, ready to edit ("5O45 A" for "PDB 5O45 chain A").
    const m = group?.label ? /^PDB (\S+)(?: chains? (.+))?$/.exec(group.label) : null;
    id.value = m ? [m[1], m[2] ?? ""].join(" ").trim() : "";
    status.textContent = "";
    form.hidden = false;
    id.focus();
    id.select();
  }

  /**
   * An entry opened as AtomWorks does (rcsb preset), in its first biological assembly that has all of `chains` (3EAK's
   * chain B is in assembly 2); the first assembly when no chains are named or none has them all. Resolves to the new
   * session's id and the entry's own tables.
   */
  private async _openEntry(text: string, name: string, chains: string[] = [], extra: { keepUnresolved?: boolean } = {}): Promise<{ doc: SessionDoc; raw: ReturnType<typeof parseCifBlock> }> {
    const wanted = chains.map((c) => String(c).toUpperCase());
    const raw = parseCifBlock(text);
    const open = async (assembly: string): Promise<SessionDoc> => {
      const sid = await createSession(text, name, { preset: "rcsb", assembly, ...extra });
      const doc = new SessionDoc(sid);
      await doc.refresh();
      return doc;
    };
    const has = (doc: SessionDoc): boolean => {
      const present = new Set(Array.from(doc.atoms.chain_id, (c) => String(c).toUpperCase()));
      const codes = new Set(Array.from(doc.atoms.res_name, (r) => String(r).toUpperCase()));
      return wanted.every((c) => present.has(c) || codes.has(c));
    };
    const first = await open("1");
    if (!wanted.length || has(first)) return { doc: first, raw };
    const gen = raw.pdbx_struct_assembly_gen;
    const ids = [...new Set((gen?.assembly_id ?? []).map(String))].filter((id) => id !== "1");
    for (const id of ids) {
      const doc = await open(id);
      if (has(doc)) { void deleteSession(first.sid); return { doc, raw }; }
      void deleteSession(doc.sid);
    }
    return { doc: first, raw };
  }

  /** Keep only what `names` ("B", "LVY") names of an opened entry (`namedAtoms`); all of it when none are named. */
  private async _keepNamed(doc: SessionDoc, raw: ReturnType<typeof parseCifBlock>, names: string[]): Promise<void> {
    if (!names.length) return;
    const col = (key: string): string[] => raw.pdbx_nonpoly_scheme?.[key] ?? [];
    const keep = new Set(namedAtoms(doc.atoms, { asym: col("asym_id"), strand: col("pdb_strand_id") }, names));
    const drop: number[] = [];
    for (let i = 0; i < doc.nAtoms; i += 1) if (!keep.has(i)) drop.push(i);
    if (drop.length) {
      await doc.post("/delete", { atom_indices: drop });
      await doc.refresh();
    }
  }

  /** Add `chains` (all when empty) of a structure's text to the job, fixed as they are; first remove the atoms in `replace`. */
  private async _addStructureFrom(text: string, name: string, chains: string[], replace: number[] | null): Promise<void> {
    const { doc, raw } = await this._openEntry(text, name, chains);
    try {
      await this._keepNamed(doc, raw, chains);
      if (!doc.nAtoms) throw new Error("nothing left to add");
    } catch (err) {
      void deleteSession(doc.sid);
      throw err;
    }
    // Replaced: the new structure goes in first and the old one comes out after, so a job that was only the old one is
    // never emptied (Studio refuses that; an example with one chain could not be replaced). The old atoms are found by
    // chain afterwards, since merging can reorder atoms.
    const a0 = this._inputDoc()?.atoms;
    const oldChains = new Set((replace ?? []).map((i) => String(a0?.chain_id[i])));
    // Opened as a plain structure, it is already fixed throughout, so adding it is one Undo step.
    const added = await this._combine(doc);
    if (oldChains.size) {
      const a = this._inputDoc()!.atoms;
      const addedSet = new Set(added);
      const old: number[] = [];
      for (let i = 0; i < a.nAtoms; i += 1) if (!addedSet.has(i) && oldChains.has(String(a.chain_id[i]))) old.push(i);
      if (old.length && !await this._mutate("/delete", { atom_indices: old })) throw new Error(this.lastError ?? "could not remove the old chains");
      added.splice(0, added.length, ...this._chainAtoms(new Set(added.map((i) => String(a.chain_id[i])))));
    }
    const a = this._inputDoc()!.atoms;
    const newChains = [...new Set(added.map((i) => String(a.chain_id[i])))];
    const original = chains.length === 1 ? ` chain ${chains[0].toUpperCase()}` : "";
    this._rememberSource(newChains, /^[0-9][A-Za-z0-9]{3}$/.test(name) ? `PDB ${name}${original}` : `${name}${original}`);
    // Added beside a chain the job designs from scratch (a binder), the structure is its target, set up as upstream's.
    const binder = (this._spec()?.chains ?? []).some((c) => !newChains.includes(c.id) && c.role === "new");
    if (binder && !this.building) await this._makeTargets(this._asLoaded(newChains));
    this.addStructure.form.hidden = true;
    this.addStructure.replace = null;
    this.render();
  }

  /** + new: a new chain to design, 60–100 residues; structures kept as loaded beside it become its targets. */
  async _addSeq(): Promise<void> {
    const targets = this._asLoaded();
    if (!await this._mutate("/segments", {
      minimum: 60, maximum: 100, atom_index: null, before: false, new_chain: true, chain_id: null,
      chain_type: "polypeptide(L)",
    })) return;
    if (targets.length) await this._makeTargets(targets);
  }

  /**
   * Chains still as loaded (`ids`, or all of the job's): every piece fixed, all atoms, in place, but for residues the
   * entry has no coordinates for, which come in with their sequence only. Chains set up otherwise are left as they
   * are (upstream: preserve explicit choices rather than converting existing inputs silently).
   */
  private _asLoaded(ids: string[] | null = null): string[] {
    const fixedAll = (now: Properties): boolean => now.structure === "fixed" && now.atoms === "all" && now.sequence === "fixed" && now.position === "fixed";
    const seqOnly = (now: Properties): boolean => now.structure === "designed" && now.sequence === "fixed" && now.position === "fixed";
    return (this._spec()?.chains ?? []).filter((c) => (!ids || ids.includes(c.id)) && c.role !== "ligand" && c.pieces.length
      && c.pieces.every((p) => p.kind === "kept" && (fixedAll(this._properties(p)) || seqOnly(this._properties(p))))
      && c.pieces.some((p) => fixedAll(this._properties(p)))).map((c) => c.id);
  }

  /**
   * A binder's targets as upstream sets them up (RFD4-Proteina's protein-binder task and PD-L1 example): the backbone
   * held as one rigid body with internal coordinates, so its shape is kept but not its place, which reduces binders
   * that copy the target; the sequence fixed; side chains free; hotspots as they are. Shown on the card.
   */
  private async _makeTargets(ids: string[]): Promise<void> {
    const parts: PieceChange[] = (this._spec()?.chains ?? []).filter((c) => ids.includes(c.id))
      .flatMap((c) => c.pieces.filter((p) => p.kind === "kept").map((p) => ({
        p, atoms: p.atomIndices, want: { structure: "rigid", atoms: "backbone", sequence: "fixed", position: "fixed" },
      })));
    if (parts.length) await this._applyPieces(parts);
  }

  /** Atom indices of the input in these chains. */
  private _chainAtoms(chains: Set<string>): number[] {
    const a = this._inputDoc()?.atoms;
    const out: number[] = [];
    for (let i = 0; i < (a?.nAtoms ?? 0); i += 1) if (chains.has(String(a!.chain_id[i]))) out.push(i);
    return out;
  }

  /** Merge a session into the job (one undo step); resolves to the added atoms' indices (the chains that are new). */
  private async _combine(other: SessionDoc): Promise<number[]> {
    const chainsOf = (): Set<string> => new Set(Array.from(this._inputDoc()?.atoms?.chain_id ?? [], String));
    const before = chainsOf();
    try {
      if (!await this._mutate("/combine", { session_ids: [other.sid] })) throw new Error(this.lastError ?? "could not add it");
    } finally {
      void deleteSession(other.sid);
    }
    // Merged chains are not always appended at the end (Studio orders polymers before ligands): find them by chain.
    const a = this._inputDoc()!.atoms;
    const added: number[] = [];
    for (let i = 0; i < a.nAtoms; i += 1) if (!before.has(String(a.chain_id[i]))) added.push(i);
    return added;
  }

  /** Centre of `indices` (all atoms when null) with coordinates, or the origin. */
  private _centroid(indices: number[] | null = null): number[] {
    const a = this._inputDoc()?.atoms;
    const sum = [0, 0, 0];
    let n = 0;
    for (const i of indices ?? Array.from({ length: a?.nAtoms ?? 0 }, (_, k) => k)) {
      const c = a?.coord[i];
      if (!c || !Number.isFinite(c[0]) || !Number.isFinite(c[1]) || !Number.isFinite(c[2])) continue;
      sum[0] += c[0]; sum[1] += c[1]; sum[2] += c[2];
      n += 1;
    }
    return n ? sum.map((v) => v / n) : [0, 0, 0];
  }

  /** A ligand's session, from its dictionary code (the PDB's component entry), centred on `center`. */
  private async _ligandSession(code: string, chainId: string, center: number[]): Promise<SessionDoc> {
    if (!isCcdCode(code)) throw new Error("type the ligand's code in the PDB: 1–5 letters or digits, e.g. HEM");
    const { blocks } = await fetchCcdComponents([code]);
    const block = blocks.get(code);
    if (!block) throw new Error(`the PDB has no ligand called ${code}`);
    const { cif } = ligandCifFromCcd(block, { chainId, center });
    const doc = new SessionDoc(await createSession(cif, code));
    await doc.refresh();
    return doc;
  }

  /**
   * A ligand by its dictionary code, its pose free (the model places it). With `replace` (a ligand's atoms), it
   * takes that ligand's place: same chain letter, started from the same spot.
   */
  async _addLigand(rawCode: string, { replace = null, chainId = "L" }: { replace?: number[] | null; chainId?: string } = {}): Promise<string> {
    const code = String(rawCode ?? "").trim().toUpperCase();
    const doc = await this._ligandSession(code, chainId, this._centroid(replace));
    if (replace && !await this._mutate("/delete", { atom_indices: replace })) throw new Error(this.lastError ?? "could not remove the old ligand");
    const added = await this._combine(doc);
    // A ligand added by its code comes from no structure: it sits outside the source groups.
    const a = this._inputDoc()!.atoms;
    this._rememberSource([...new Set(added.map((i) => String(a.chain_id[i])))], null);
    this.render();
    return code;
  }

  /**
   * The one form + pdb and + lig open, on the start screen and under a job: a title with its × (as popups close), one
   * line of what it takes, the input and its button (and any more, a file for a structure), and a status line.
   */
  private _addForm({ label, note, input, button, extra = [], onSubmit, onClose }: {
    label: string; note: string; input: HTMLInputElement; button: string; extra?: HTMLElement[];
    onSubmit: (status: HTMLElement) => void | Promise<void>; onClose: () => void;
  }): { form: HTMLFormElement; status: HTMLElement; title: HTMLElement; submit: HTMLButtonElement } {
    const status = el("p", { class: "rfd4p-add-status muted", "aria-live": "polite" });
    const title = el("strong", { text: label });
    const submit = el("button", { type: "submit", class: "primary compact", text: button });
    const form = el("form", { class: "rfd4p-add-structure" },
      el("div", { class: "rfd4p-add-head" }, title,
        el("button", { type: "button", class: "rfd4p-pop-x", "aria-label": "Close", title: "Close", text: "×", onclick: onClose })),
      el("span", { class: "muted", text: note }),
      el("div", { class: "rfd4p-add-row" }, input, submit),
      extra.length ? el("div", { class: "rfd4p-add-row" }, ...extra) : null,
      status);
    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      void onSubmit(status);
    });
    return { form, status, title, submit };
  }

  /** + lig's form: a ligand by its code. */
  private _ligandCodeForm({ label, button, onSubmit, onCancel }: {
    label: string; button: string; onSubmit: (code: string) => Promise<void>; onCancel: () => void;
  }): HTMLFormElement {
    const input = el("input", {
      type: "text", class: "rfd4p-add-id", spellcheck: "false", autocomplete: "off", maxlength: 5,
      placeholder: "Code, e.g. HEM", "aria-label": "Ligand code",
    });
    const { form } = this._addForm({
      label, button, input, onClose: onCancel,
      note: "Its code in the PDB (HEM, ATP, NAD, ZN…). The model places it; fix its pose afterwards to keep it where it is.",
      onSubmit: async (status) => {
        status.textContent = `Looking up ${input.value.trim().toUpperCase()}…`;
        try {
          await onSubmit(input.value);
          status.textContent = "";
        } catch (err) {
          status.textContent = `Could not add it: ${msg(err)}`;
        }
      },
    });
    queueMicrotask(() => input.focus());
    return form;
  }

  /** + pdb's input: a PDB ID, then any chains. */
  private _structureInput(): HTMLInputElement {
    return el("input", {
      type: "text", class: "rfd4p-add-id", spellcheck: "false", autocomplete: "off", maxlength: 40,
      placeholder: "ID, then chains: 5O45 A", "aria-label": "PDB ID and chains",
    });
  }

  // ---- wiring -------------------------------------------------------------------------------------------------

  private _bind(): void {
    const { els } = this;
    this._bindDrop();
    // The start screen's parts start a new job: a free chain, a structure (the form below), or a ligand.
    els.startSeq?.addEventListener("click", () => void this._startNew(async () => {
      const text = await apiText("/api/examples/unconditional/cif");
      const doc = new SessionDoc(await createSession(text, "design"));
      await doc.refresh();
      const seg = doc.atoms.res_name.findIndex((r) => SENTINEL.test(String(r)));
      if (seg >= 0) {
        await doc.post("/segments/range", { atom_index: seg, minimum: 60, maximum: 100 });
        await doc.refresh(true);
      }
      return doc;
    }));
    els.startPdb?.addEventListener("click", () => {
      const { form, id } = this.startStructure ?? {};
      if (!form) return;
      this.startLigandForm?.remove();
      this.startLigandForm = null;
      form.hidden = false;
      id.focus();
    });
    els.startLig?.addEventListener("click", () => {
      if (this.startStructure) this.startStructure.form.hidden = true;
      this.startLigandForm?.remove();
      this.startLigandForm = this._ligandCodeForm({
        label: "Add a ligand",
        button: "Add",
        onSubmit: (code) => this._startNew(() => this._ligandSession(String(code ?? "").trim().toUpperCase(), "L", [0, 0, 0]), { rethrow: true }),
        onCancel: () => { this.startLigandForm?.remove(); this.startLigandForm = null; },
      });
      els.startLig!.parentElement!.after(this.startLigandForm);
    });
    // Clear empties the viewer and the sequence and shows the start screen; opening anything from it replaces the
    // document, and Undo there brings back what was shown (the session is kept).
    els.newDoc?.addEventListener("click", () => {
      this.closedSession = this.host.inputSessionId();
      this.showStart = true;
      this.render();
      void this.studio()?.closeDocument?.();
    });
    const back = (): void => {
      const sid = this.closedSession;
      this.closedSession = null;
      this.showStart = false;
      this.render();
      if (sid) void this.studio()?.openSession(sid);
    };
    // Kept as the pending edit, so an example being built waits for the whole of it (the chain and its targets).
    els.addSeq?.addEventListener("click", () => { this.applying = this._addSeq(); });
    els.addPdb?.addEventListener("click", () => {
      this.addLigandForm?.remove();
      this.addLigandForm = null;
      this._openAddStructure();
    });
    els.addLig?.addEventListener("click", () => {
      if (this.addStructure) this.addStructure.form.hidden = true;
      this.addLigandForm?.remove();
      this.addLigandForm = this._ligandCodeForm({
        label: "Add a ligand",
        button: "Add",
        onSubmit: async (code) => {
          await this._addLigand(code);
          this.addLigandForm?.remove();
          this.addLigandForm = null;
        },
        onCancel: () => { this.addLigandForm?.remove(); this.addLigandForm = null; },
      });
      els.addLig!.parentElement!.after(this.addLigandForm);
    });
    // Undo on the start screen undoes Clear; otherwise it is Studio's Undo.
    els.undo?.addEventListener("click", () => {
      if (this.showStart && this.closedSession) back();
      else void this._undo();
    });
    (els.advanced as HTMLInputElement | null)?.addEventListener("change", () => this._applyAdvanced((els.advanced as HTMLInputElement).checked));
    this.listen(document, "pointerdown", (ev) => {
      const target = ev.target as Element | null;
      if (target && this.pop.contains(target)) return;
      const src = target?.closest?.("#viewer, #sequence-view");
      this.lastPointer = src ? { x: ev.clientX, y: ev.clientY } : null;
      if (!src) this.pop.hidden = true;
    }, true);
    this.listen(document, "keydown", (ev) => { if (ev.key === "Escape") this.pop.hidden = true; });
    // Starting from the input diversifies what is designed; with nothing designed yet, that is all the protein.
    const partial = document.getElementById("partial-diffusion") as HTMLInputElement | null;
    partial?.addEventListener("change", () => {
      if (partial.checked) document.getElementById("sampling-accordion")?.setAttribute("open", "");
      if (!partial.checked) return;
      const doc = this._inputDoc();
      const spec = doc?.nAtoms ? designSpec(doc.atoms) : null;
      if (spec && !spec.designedMax) {
        void this._batch(spec.chains.filter((c) => c.residues > 0).flatMap((c) => this._roleEdits(c, "free")));
      }
    });
    for (const id of ["partial-diffusion", "partial-diffusion-percent", "partial-diffusion-percent-num"]) {
      document.getElementById(id)?.addEventListener("input", () => this.render());
      document.getElementById(id)?.addEventListener("change", () => this.render());
    }
  }

  /** The host heard Studio's selection change. */
  onSelection(count: number): void {
    this.selectionCount = count;
    queueMicrotask(() => {
      this._markSelected();
      // A row's own pick has its popup open already.
      if (this.cardPicking) { this.cardPicking = false; this.pop.hidden = true; return; }
      // A click in the viewer while a row's popup is open (turning the structure) opens no other popup; on a preview
      // frame its atoms are not the document's, so the pick is let go.
      if (this.piecePop && !this.piecePop.hidden) {
        this.pop.hidden = true;
        if (this.planPreview && this.selectionCount) this.studio()?.setSelection?.([]);
        return;
      }
      this._renderPop();
    });
  }

  /** Undo: Studio's own, which also refreshes its viewer; the card's goes no further back than where it opened. */
  private async _undo(): Promise<void> {
    const studio = this.studio();
    if (studio?.undo) await studio.undo();
    else (document.getElementById("undo") as HTMLButtonElement | null)?.click();
  }

  private _applyAdvanced(on: boolean): void {
    document.body.classList.toggle("rfd4p-advanced", on);
    const box = this.els.advanced as HTMLInputElement | null;
    if (box) box.checked = on;
  }

  private _buildTaskGrid(): void {
    const grid = this.els.taskGrid;
    if (!grid) return;
    grid.replaceChildren(...this.tasks.map((t) => el("button", {
      type: "button",
      class: "rfd4p-task-card",
      "data-example": t.example,
      onclick: () => void this._startTask(t),
    }, el("strong", { text: t.title }), el("span", { text: t.desc }))));
  }

  // ---- state --------------------------------------------------------------------------------------------------

  render(): void {
    const spec = this._spec();
    const { els } = this;
    const hasDoc = Boolean(spec && !spec.empty);
    // An example being built keeps the start screen up; its chains are laid out (hidden) for the build to use.
    const starting = !hasDoc || Boolean(this.showStart) || Boolean(this.building);
    if (els.start) els.start.hidden = !starting;
    if (els.design) els.design.hidden = starting;
    if (els.runSettings) els.runSettings.hidden = starting;
    // A run's results and status belong to the document, so they go with it.
    this.root.classList.toggle("rfd4p-starting", starting);
    if (!hasDoc || (starting && !this.building)) {
      // The start screen sits under the Input tab too, with no Clear, and Undo only when there is a job to go back to.
      if (els.newDoc) els.newDoc.hidden = true;
      const undo = els.undo as HTMLButtonElement | null;
      if (undo) {
        undo.hidden = !this.closedSession;
        undo.disabled = !this.closedSession;
      }
      this.host.renderDesigns();
      return;
    }

    const viewingDesign = this.host.isViewingDesign();
    els.design!.classList.toggle("rfd4p-readonly", viewingDesign);
    els.taskLabel!.textContent = spec!.task.label;
    els.taskDetail!.textContent = viewingDesign ? "A generated design (read-only). Select Input under Designs to edit." : "";
    els.taskDetail!.hidden = !viewingDesign;
    if (els.newDoc) els.newDoc.hidden = viewingDesign;
    const actions = els.addSeq?.parentElement;
    if (actions) actions.hidden = viewingDesign;
    if (viewingDesign && this.addStructure) this.addStructure.form.hidden = true;
    const undo = els.undo as HTMLButtonElement;
    undo.hidden = viewingDesign;
    const doc = this._inputDoc();
    undo.disabled = !doc || doc.undoDepth <= this.host.undoFloor(doc.sid);

    els.chainList!.replaceChildren(...this._sourceGroups(spec!.chains).map((g) => this._groupBlock(g, viewingDesign)));
    this._markSelected();

    const warnings = this.lastError ? [this.lastError, ...spec!.warnings] : [...spec!.warnings];
    const notes = warnings.map((w) => el("p", { class: "rfd4p-warning", text: w }));
    if (spec!.task.key === "partial" && spec!.chains.some((c) => c.segments.length)) {
      // New residues that replaced residues can be those residues again, free in place, which partial diffusion takes.
      const known = Boolean(doc?.hasOrigins());
      notes.push(el("p", { class: "rfd4p-warning" }, "Partial diffusion needs every residue defined; this input has new residues.",
        known && !viewingDesign ? el("button", { type: "button", class: "secondary compact rfd4p-warning-fix",
          onclick: () => void this._restoreAll(), text: "Back to the residues they replaced" }) : null));
    }
    els.warnings!.replaceChildren(...notes);

    this.showHotspots();
    // An edit to the input changes which Input rows the Designs table shows (the input as it is now, or as a run had it).
    // Also with no runs: the Input / Outputs tabs are there from the start.
    this.host.renderDesigns();
    // A job is open: the engine may get ready for it (the page loads its model if the weights are cached).
    const stamp = `${doc?.sid}:${doc?.revision}`;
    if (!viewingDesign && stamp !== this.lastNotified) {
      this.lastNotified = stamp;
      this.host.inputChanged(spec!);
    }

    // Nothing to generate: keep Generate off (a running job keeps its Stop button).
    this.host.setNothingToGenerate(spec!.task.key === "nothing" || spec!.task.key === "empty");
  }

  /**
   * Chains by where their coordinates come from, in the job's order (as the sequence bar shows them, and as they were
   * added); chains made here are uncaptioned, in place.
   */
  private _sourceGroups(chains: ChainSpec[]): SourceGroup[] {
    const groups: SourceGroup[] = [];
    const bySource = new Map<string, SourceGroup>();
    for (const c of chains) {
      const label = this._sourceOf(c);
      let g = label ? bySource.get(label) : groups[groups.length - 1];
      if (!g || (!label && g.label)) {
        g = { label, chains: [] };
        groups.push(g);
        if (label) bySource.set(label, g);
      }
      g.chains.push(c);
    }
    return groups;
  }

  /** A source's caption (click: replace it with another structure), then its chains. */
  private _groupBlock(g: SourceGroup, readonly: boolean): HTMLElement {
    // "PDB 5O45 · A": the entry and the chains of it in the job; its title when pointed at.
    const entry = g.label?.replace(/ chains? .*$/, "");
    const title = entry ? this.titles.get(entry) : null;
    const text = entry ? `${entry} · ${g.chains.map((c) => c.id).join(" ")}` : null;
    // The caption replaces its structure (another entry or file in its place) when clicked, and × beside it, shown
    // while the caption is pointed at, takes its chains out.
    const atoms = g.chains.flatMap((c) => c.atomIndices);
    const caption = !g.label ? null : readonly
      ? el("span", { class: "rfd4p-source", title: title ?? null, text })
      : el("div", { class: "rfd4p-source-row" },
        el("button", { type: "button", class: "rfd4p-source", onclick: () => this._openAddStructure(g), text,
          title: [title, `Click to replace ${g.label}`].filter(Boolean).join("\n") }),
        el("button", { type: "button", class: "rfd4p-x rfd4p-source-x", text: "×", title: `Remove ${g.label}`,
          "aria-label": `Remove ${g.label}`, onclick: () => {
            // The last thing in the job: removing it is Clear (the start screen, with Back), not an empty document.
            if (atoms.length >= (this._inputDoc()?.nAtoms ?? 0)) this.els.newDoc?.click();
            else void this._mutate("/delete", { atom_indices: atoms });
          } }));
    return el("div", { class: "rfd4p-group" }, caption, ...g.chains.map((c) => this._chainRow(c, readonly)));
  }

  /**
   * A chain as its pieces, in order (the contig, spelled out): the chain letter on the left, then one sub-card per
   * piece and ligand. A sub-card opens its popup and has its own ×; a "+" between sub-cards inserts new residues there.
   */
  private _chainRow(c: ChainSpec, readonly: boolean): HTMLElement {
    const remove = (title: string, atoms: number[]): HTMLElement | null => (readonly ? null : el("button", {
      type: "button", class: "rfd4p-x", title, "aria-label": title, text: "×",
      onclick: () => void this._mutate("/delete", { atom_indices: atoms }),
    }));
    const pieces = c.pieces;
    const many = pieces.length + c.ligands.length > 1;
    const items: (HTMLElement | null)[] = [];
    // A slot between any two pieces and at both ends: new residues next to new residues are a block of their own, so
    // a free chain can be built as blocks of different lengths and shapes (a helix, a loop, a strand).
    // A chain from a PDB entry: "+" asks whether to add new residues or bring back residues of the entry (a motif
    // residue removed, say); otherwise it adds new residues straight away.
    const entry = this._entryOf(c);
    const slot = (atom: number, before: boolean): HTMLElement | null => (readonly ? null : el("button", {
      type: "button", class: "rfd4p-slot", title: entry ? "Add residues here" : "New residues here", "aria-label": entry ? "Add residues here" : "New residues here",
      onclick: (ev) => {
        if (entry) { this._openPop(ev.currentTarget as HTMLElement, () => this._slotPop(c, entry, atom, before)); return; }
        void this._mutate("/segments", {
          minimum: 5, maximum: 10, atom_index: atom, before, new_chain: false, chain_id: null, chain_type: "polypeptide(L)",
        });
      },
    }, el("span", { text: "+" })));
    pieces.forEach((p, k) => {
      const prev = pieces[k - 1];
      items.push(prev ? slot(prev.atomIndices[prev.atomIndices.length - 1], false) : slot(p.atomIndices[0], true));
      items.push(this._pieceCard(c, p, readonly, remove(many ? "Remove these residues" : `Remove chain ${c.id}`, p.atomIndices)));
      if (k === pieces.length - 1) items.push(slot(p.atomIndices[p.atomIndices.length - 1], false));
    });
    for (const l of c.ligands) {
      items.push(this._ligandCard(c, l, readonly, remove(many ? `Remove ${l.name}` : `Remove chain ${c.id}`, l.atomIndices)));
    }
    const gutter = el("div", { class: "rfd4p-chain-gutter" },
      el("button", {
        type: "button", class: "rfd4p-chain-id", text: c.id, disabled: readonly,
        title: `Chain ${c.id}${c.fold ? ` · fold ${c.fold.replace(/(\.x)+$/, "")}` : ""}: name, order and fold`,
        onclick: (ev) => this._openPop(ev.currentTarget as HTMLElement, () => this._chainPop(c)),
      }),
      many ? remove(`Remove chain ${c.id}`, c.atomIndices) : null);
    const row = el("div", { class: `rfd4p-chain rfd4p-role-${c.role}` }, gutter, el("div", { class: "rfd4p-chain-items" }, ...items.filter(Boolean)));
    // The chain's colour, as in the viewer and the sequence bar.
    const color = this.studio()?.chainColor?.(c.id);
    if (color) row.style.setProperty("--chain-color", color);
    return row;
  }

  private _range(c: ChainSpec, p: PieceSpec): string {
    return p.start === p.end ? `${c.id}${p.start}` : `${c.id}${p.start}–${p.end}`;
  }

  /** A piece's name, on the left of its row: its residues (where a set-up took them from, if renumbered), or for
   * new residues their length. */
  private _pieceText(c: ChainSpec, p: PieceSpec): string {
    if (p.kind === "new") return p.min === p.max ? `${p.min}` : `${p.min}–${p.max}`;
    // A count only where numbering skips (it would repeat the range otherwise).
    const n = p.count !== p.end - p.start + 1 ? ` (${p.count})` : "";
    return p.source ?? `${this._range(c, p)}${n}`;
  }

  /** What a piece row says after its residues: what is kept, in a few words. */
  private _status(p: PieceSpec): string {
    const word = (options: Option[], v: unknown): string => (v ? options.find(([k]) => k === String(v))?.[1] ?? "" : "");
    // "new" last, so it lines up down a chain of blocks ("H · new", "C · new").
    if (p.kind === "new") {
      const code = String(p.fold ?? "").replace(/(\.x)+$/, "");
      const fold = code ? FOLD_OPTIONS.find(([k]) => k === code)?.[1] ?? code : "";
      return [fold, SHAPE_LETTER[p.ss] ?? "", word(EXPOSURE_OPTIONS, p.rasa), "new"].filter(Boolean).join(" · ");
    }
    const { structure, atoms, names, sequence, position } = this._properties(p);
    // The popup's words: both fixed reads "fixed", both free "free", otherwise which one is fixed; part of the atoms
    // says which.
    const part = atoms === "backbone" ? "backbone" : atoms === "sidechain" ? "side chains" : atoms === "named" ? names : "";
    const what = structure === "designed" && sequence === "designed" ? "free"
      : structure === "rigid" ? (part ? `${part} rigid` : "rigid")
        : structure === "fixed" && sequence === "fixed" ? (part ? `${part} fixed` : "fixed")
          : structure === "fixed" ? "structure fixed" : "sequence fixed";
    return [what, position === "anywhere" ? "position free" : "", SHAPE_LETTER[p.ss] ?? "", word(EXPOSURE_OPTIONS, p.rasa), word(INTERACTION_OPTIONS, p.inter),
      p.hotspots.length ? `${p.hotspots.length} hotspot${p.hotspots.length === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ");
  }

  /** A sub-card: name and status (opens its popup), then its ×. */
  private _card(name: string, status: string, kindClass: string, readonly: boolean, onOpen: (anchor: HTMLElement) => void, remove: HTMLElement | null, atoms: number[] | null = null): HTMLElement {
    const card = el("div", { class: `rfd4p-sub ${kindClass}` },
      el("button", {
        type: "button", class: "rfd4p-sub-open", disabled: readonly, "aria-haspopup": "dialog",
        onclick: (ev) => onOpen(ev.currentTarget as HTMLElement),
      },
      el("span", { class: "rfd4p-sub-name", text: name }),
      el("span", { class: "rfd4p-sub-status", text: status })),
      remove);
    // Its atoms, so the card can show which sub-cards hold selected residues (`_markSelected`).
    if (atoms) this.cardAtoms.set(card, atoms);
    return card;
  }

  /** Outline the sub-cards holding selected residues, as the viewer and the sequence bar outline them. */
  _markSelected(): void {
    const sel = new Set(this.host.isViewingDesign() ? [] : this.studio()?.getSelection?.() ?? []);
    for (const card of this.els.chainList?.querySelectorAll<HTMLElement>(".rfd4p-sub") ?? []) {
      card.classList.toggle("rfd4p-sub-selected", Boolean(sel.size && this.cardAtoms.get(card)?.some((i) => sel.has(i))));
    }
  }

  private _pieceCard(c: ChainSpec, p: PieceSpec, readonly: boolean, remove: HTMLElement | null): HTMLElement {
    return this._card(this._pieceText(c, p), this._status(p), `rfd4p-sub-${p.kind === "kept" ? "kept" : "designed"}`, readonly,
      (anchor) => {
        if (p.kind !== "new") this._selectFromCard(p.atomIndices);
        this._openPop(anchor, () => (p.kind === "new" ? this._newPop(c, p) : this._piecePop(c, p)));
      }, remove, p.atomIndices);
  }

  /** A row's residues selected in the viewer and the sequence too, while its popup is open (not the viewer's popup). */
  private _selectFromCard(atoms: number[], { center = true } = {}): void {
    const studio = this.studio();
    if (typeof studio?.setSelection !== "function" || !atoms?.length || this.building) return;
    this.cardPicking = true;
    this.cardSelected = true;
    clearTimeout(this.cardPickTimer);
    this.cardPickTimer = setTimeout(() => { this.cardPicking = false; }, 400);
    studio.setSelection(atoms);
    // Brought to the middle of the view (the zoom kept), so the popup's residues are in sight.
    if (center) studio.centerOn?.(atoms);
  }

  private _ligandCard(c: ChainSpec, l: LigandSpec, readonly: boolean, remove: HTMLElement | null): HTMLElement {
    // Some atoms held: named, as a residue's are ("N1, C2, N3, C4 fixed"), or counted when the names would not fit.
    const part = l.heldNames && l.heldNames.length <= 24 ? `${l.heldNames} fixed` : `${l.fixedAtoms} of ${l.atoms} atoms fixed`;
    const status = l.pose === "fixed" || l.pose === "rigid" ? l.pose : l.pose === "predicted" ? "free" : part;
    return this._card(l.name, status, "rfd4p-sub-ligand", readonly, (anchor) => {
      this._selectFromCard(l.atomIndices);
      this._openPop(anchor, () => this._ligandPop(c, l));
    }, remove, l.atomIndices);
  }

  /** The PDB entry chain `c` came from, and its chain there ("1QJG", "A"); null when it did not come from one. */
  private _entryOf(c: ChainSpec): { id: string; chain: string } | null {
    const m = /^PDB (\w{4})(?: chains? (\S+))?/.exec(this._sourceOf(c) ?? "");
    if (!m) return null;
    const a = this._inputDoc()?.atoms;
    const SRC = a?.annotations?.["annotation_src-component_1_atom"];
    // A residue's name in the entry ("A38"), not a new residue's placeholder text.
    const label = c.atomIndices.map((i) => String(SRC?.[i] ?? "")).find((x) => /^[A-Za-z]+-?\d/.test(x));
    const chain = /^([A-Za-z]+)/.exec(label ?? "")?.[1] ?? m[2] ?? c.id;
    return { id: m[1].toUpperCase(), chain };
  }

  /** "+" in a chain from an entry: new residues of a length, or residues of the entry brought back where it was pressed. */
  private _slotPop(c: ChainSpec, entry: { id: string; chain: string }, atom: number, before: boolean): (HTMLElement | null)[] {
    const lenMin = el("input", { type: "number", min: 1, max: 1000, value: 5, "aria-label": "Fewest new residues" });
    const lenMax = el("input", { type: "number", min: 1, max: 1000, value: 10, "aria-label": "Most new residues" });
    // Changed through the chain's plan: what is added goes exactly here, and the preview is the chain as Add would
    // leave it. Residues of the entry not in the chain, as from – to boxes like a piece's Residues: the stretch missing
    // here to start with, with a drag bar over it; any others typed (a motif residue removed, put back in place), the
    // boxes empty then.
    const plan = this._plan(c) ?? { chain: c.id, source: [], parts: [] };
    const src = plan.source;
    const gap = this._missingAt(plan, atom, before);
    const keptAt = (x: number, y: number): RebuildPart[] => this._partsWithInsert(plan, atom, before, { kind: "kept", lo: x, hi: y });
    const inChain = new Set(plan.parts.flatMap((q) => (q.kind === "kept"
      ? src.slice(Math.min(q.from, q.to), Math.max(q.from, q.to) + 1).map((r) => r.num) : [])));
    const missing = src.filter((r) => !inChain.has(r.num));
    const from = el("input", { type: "text", class: "rfd4p-pop-text", spellcheck: "false", autocomplete: "off",
      value: gap ? `${gap.lo}–${gap.hi}` : "", "aria-label": `Residues of PDB ${entry.id}` });
    // The range typed, if every residue in it is the entry's and not in the chain; else why not.
    const pick = (): { error: string } | { lo: number; hi: number } => {
      const m = /^\s*(-?\d+)\s*(?:[-–]\s*(-?\d+))?\s*$/.exec(from.value);
      if (!m) return { error: "Residues as from – to" };
      const x = Math.min(Number(m[1]), Number(m[2] ?? m[1]));
      const y = Math.max(Number(m[1]), Number(m[2] ?? m[1]));
      const run = src.filter((r) => r.num >= x && r.num <= y);
      if (!run.length) return { error: `PDB ${entry.id} chain ${entry.chain} has no residues ${x}–${y}` };
      const there = run.find((r) => inChain.has(r.num));
      if (there) return { error: `${entry.chain}${there.num} is in the chain already` };
      return { lo: run[0].num, hi: run[run.length - 1].num };
    };
    const ranges = (): number[][] | null => { const r = pick(); return "error" in r ? null : [[r.lo, r.hi]]; };
    let bar: HTMLElement | null = null;
    if (gap) {
      const iLo = src.findIndex((r) => r.num === gap.lo);
      const iHi = lastIndexOf(src, (r) => r.num === gap.hi);
      const piece = { start: gap.lo, end: gap.hi, atomIndices: [] as number[] };
      bar = this._cropBar(c, piece, src, { lo: gap.lo, hi: gap.hi, iLo, iHi, present: inChain }, from, ranges);
    }
    // Nothing is shown until there is something to add: where none of the entry is missing beside the "+" (after the
    // chain's last residue), the boxes start empty, or the preview joined some far residue onto this end.
    const show = (): void => {
      const r = from.value.trim() ? pick() : { error: "none" };
      // Not a range yet (a box emptied to type a new number): the last preview stays, as a piece's popup keeps it;
      // going back to the document and building the preview again on the next key was a blink.
      if (!("error" in r)) this._previewParts(c, keptAt(r.lo, r.hi));
    };
    if (missing.length) {
      from.addEventListener("input", show);
      queueMicrotask(show);
    }
    const reach = { lo: missing[0]?.num, hi: missing[missing.length - 1]?.num };
    const note = el("p", { class: "rfd4p-pop-note", "aria-live": "polite" });
    const go = (fn: () => Promise<void>) => async (): Promise<void> => {
      note.textContent = "";
      try { await fn(); this._closePop(); } catch (err) { note.textContent = msg(err); }
    };
    const rebuild = async (parts: RebuildPart[], what: string): Promise<void> => {
      if (!await this._mutate("/chains/rebuild", { chain_id: c.id, parts })) throw new Error(this.lastError ?? `could not ${what}`);
    };
    const addNew = go(async () => {
      const lo = Math.max(1, Number(lenMin.value) || 1);
      const hi = Math.max(lo, Number(lenMax.value) || lo);
      await rebuild(this._partsWithInsert(plan, atom, before, { kind: "new", min: lo, max: hi }), "add them");
    });
    const addBack = go(async () => {
      const r = pick();
      if ("error" in r) throw new Error(r.error);
      await rebuild(keptAt(r.lo, r.hi), "bring them back");
    });
    from.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); void addBack(); } });
    const row = (label: string, ...kids: Child[]): HTMLElement => el("div", { class: "rfd4p-pop-row rfd4p-slot-row" }, el("span", { class: "rfd4p-pop-label", text: label }), ...kids);
    return [
      this._popHead("Add here"),
      // A blank as wide as the entry row's chain letter, so both rows' boxes line up.
      row("New", el("span", { class: "rfd4p-pop-inline" }, missing.length ? el("span", { text: entry.chain, style: "visibility:hidden" }) : null,
        lenMin, el("span", { text: "–" }), lenMax),
        el("button", { type: "button", class: "secondary compact", text: "Add", onclick: addNew })),
      // Residues of the entry are offered only when some are not in the chain.
      missing.length ? row(`PDB ${entry.id}`, el("span", { class: "rfd4p-pop-inline" }, el("span", { text: entry.chain }), this._rangeBoxes(from, reach)),
        el("button", { type: "button", class: "secondary compact", text: "Add", onclick: addBack })) : null,
      bar,
      note,
    ];
  }

  /**
   * The entry's residues missing where a "+" sits in `plan` ({ lo, hi, src }): between the nearest kept runs either
   * side (past new residues), after the one before it (to the chain's end) or before the one after it (from the
   * chain's start). Null when none are missing there, or the runs either side are out of the entry's order (a motif).
   */
  private _missingAt(plan: ChainPlan, atom: number, before: boolean): { lo: number; hi: number; src: ChainPlan["source"] } | null {
    const src = plan?.source;
    if (!src?.length) return null;
    const parts = plan.parts;
    const k = parts.findIndex((q) => (q.kind === "new" ? q.atom === atom : q.atoms.includes(atom)));
    if (k < 0) return null;
    // The nearest kept runs either side, past any new residues between (A1–40, 5–10 new, "+": A41 on are missing).
    const kept = (q: PlanPart | undefined): q is Extract<PlanPart, { kind: "kept" }> => q?.kind === "kept";
    let i = before ? k - 1 : k;
    while (i >= 0 && !kept(parts[i])) i -= 1;
    let j = before ? k : k + 1;
    while (j < parts.length && !kept(parts[j])) j += 1;
    const pi = parts[i];
    const pj = parts[j];
    if (!kept(pi) && !kept(pj)) return null;
    const lo = kept(pi) ? Math.max(pi.from, pi.to) + 1 : 0;
    const hi = kept(pj) ? Math.min(pj.from, pj.to) - 1 : src.length - 1;
    if (lo > hi) return null;
    // None of them anywhere else in the chain (in the entry's order, none would be).
    if (parts.some((q) => kept(q) && Math.max(q.from, q.to) >= lo && Math.min(q.from, q.to) <= hi)) return null;
    return { lo: src[lo].num, hi: src[hi].num, src };
  }

  /** Where a chain's coordinates come from, as the card knows it; null for chains made here (+ new, + lig). */
  _sourceOf(c: { id: string; role: string }): string | null {
    if (c.role === "new") return null;
    const doc = this._inputDoc();
    const added = doc ? this.sources.get(doc.sid) : null;
    if (added?.has(c.id)) return added.get(c.id) ?? null;
    const name = String(doc?.name ?? "").replace(/\.(cif|mmcif|pdb|zst)+$/i, "");
    const task = this.tasks.find((t) => t.example === name);
    if (task) return `${task.title} example`;
    return /^[0-9][A-Za-z0-9]{3}$/.test(name) ? `PDB ${name.toUpperCase()}` : name || null;
  }

  /** The entry's title (`_struct.title`), shown when pointing at its caption. */
  private _rememberTitle(label: string, cifText: string): void {
    // A value on the same line or the next, quoted, bare, or a ;-delimited block.
    const m = /^_struct\.title\s+(?:'([^']*)'|"([^"]*)"|;([\s\S]*?)\n;|([^\s?'";_][^\n]*))/m.exec(cifText);
    const title = (m?.[1] ?? m?.[2] ?? m?.[3] ?? m?.[4] ?? "").replace(/\s+/g, " ").trim();
    if (title) this.titles.set(label, title);
  }

  private _rememberSource(chains: string[], label: string | null): void {
    const doc = this._inputDoc();
    if (!doc) return;
    let map = this.sources.get(doc.sid);
    if (!map) { map = new Map(); this.sources.set(doc.sid, map); }
    for (const id of chains) map.set(id, label);
  }

  /**
   * The one popup, next to the row that opened it. `build` makes its content; closed by its ×, Escape or a click outside
   * it other than in the viewer (× on a row means delete).
   */
  private _openPop(anchor: HTMLElement, build: () => (HTMLElement | DocumentFragment | null | false)[]): HTMLElement {
    if (!this.piecePop) {
      const popup = el("div", { class: "rfd4p-piece-pop", role: "dialog", hidden: true });
      this.piecePop = popup;
      document.body.append(popup);
      this._movable(popup);
      this.listen(document, "pointerdown", (ev) => {
        // Not the viewer: the structure is turned to see what the popup changes from another side.
        const target = ev.target as Element | null;
        if (!popup.hidden && target && !popup.contains(target) && !target.closest?.(".rfd4p-sub-open, #viewer")) this._closePop();
      }, true);
      this.listen(document, "keydown", (ev) => { if (ev.key === "Escape") this._closePop(); });
    }
    const pop = this.piecePop;
    this.pop.hidden = true;
    pop.replaceChildren(...build().filter((n): n is HTMLElement | DocumentFragment => Boolean(n)));
    pop.hidden = false;
    const r = anchor.getBoundingClientRect();
    const card = anchor.closest("#rfd4p-studio-card")?.getBoundingClientRect() ?? r;
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    // Beside the card (it sits at the right edge), level with the row, kept on screen.
    const left = card.left - w - 8 >= 8 ? card.left - w - 8 : Math.max(8, Math.min(window.innerWidth - w - 8, r.left));
    pop.style.left = `${left}px`;
    pop.style.top = `${Math.max(8, Math.min(window.innerHeight - h - 8, r.top - 8))}px`;
    this._placeMoved(pop);
    pop.querySelector<HTMLElement>("input:not([type=radio]):not([type=checkbox]), button.primary")?.focus();
    return pop;
  }

  /** Popups move by their title bar; once moved, popups open where it was left (until the page is reloaded). */
  private _movable(pop: HTMLElement): void {
    pop.addEventListener("pointerdown", (ev) => {
      const target = ev.target as Element;
      const head = target.closest<HTMLElement>(".rfd4p-pop-title");
      if (!head || ev.button !== 0 || target.closest("button, input, select")) return;
      ev.preventDefault();
      const r = pop.getBoundingClientRect();
      const dx = ev.clientX - r.left;
      const dy = ev.clientY - r.top;
      try { head.setPointerCapture(ev.pointerId); } catch { /* not an active pointer */ }
      pop.classList.add("rfd4p-pop-moving");
      const move = (e: PointerEvent): void => {
        this.popSpot = { left: e.clientX - dx, top: e.clientY - dy };
        this._placeMoved(pop);
      };
      const up = (): void => {
        pop.classList.remove("rfd4p-pop-moving");
        head.removeEventListener("pointermove", move);
        head.removeEventListener("pointerup", up);
        head.removeEventListener("pointercancel", up);
      };
      head.addEventListener("pointermove", move);
      head.addEventListener("pointerup", up);
      head.addEventListener("pointercancel", up);
    });
  }

  /** Where the user last left a popup, kept on screen. */
  private _placeMoved(pop: HTMLElement): void {
    if (!this.popSpot) return;
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    pop.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, this.popSpot.left))}px`;
    pop.style.top = `${Math.max(8, Math.min(window.innerHeight - Math.min(h, 40) - 8, this.popSpot.top))}px`;
  }

  _closePop(): void {
    if (this.piecePop) this.piecePop.hidden = true;
    this._endPreview();
    // A row's residues were selected only while its popup was open.
    if (this.cardSelected) {
      this.cardSelected = false;
      if (!this.building) this.studio()?.setSelection?.([]);
    }
  }

  /** Chain `c` as a plan (`GET .../chains/{cid}/plan`): kept runs of the chain as loaded and new blocks, in order; or null. */
  private _plan(c: { id: string }): ChainPlan | null {
    return this._inputDoc()?.plan(c.id) ?? null;
  }

  /** `plan`'s parts as `/chains/rebuild` takes them (kept runs by source number, new blocks by their placeholder). */
  private _parts(plan: ChainPlan): RebuildPart[] {
    return plan.parts.map((q): RebuildPart => (q.kind === "kept" ? { kind: "kept", lo: q.lo, hi: q.hi }
      : q.kind === "own" ? { kind: "own", atoms: q.atoms } : { kind: "new", atom: q.atom, min: q.min, max: q.max }));
  }

  /** `plan` with piece `p`'s residues (source numbers `p.start`-`p.end`) replaced by `lo`-`hi`, in the same place. */
  private _partsWithRange(plan: ChainPlan, p: { start: number; end: number }, lo: number, hi: number): RebuildPart[] {
    const out: RebuildPart[] = [];
    let placed = false;
    for (const q of this._parts(plan)) {
      if (q.kind !== "kept" || q.hi < p.start || q.lo > p.end) { out.push(q); continue; }
      if (q.lo < p.start) out.push({ kind: "kept", lo: q.lo, hi: p.start - 1 });
      if (!placed && lo <= hi) { out.push({ kind: "kept", lo, hi }); placed = true; }
      if (q.hi > p.end) out.push({ kind: "kept", lo: p.end + 1, hi: q.hi });
    }
    return out;
  }

  /** `plan` with `part` added where a "+" sits (beside the part holding `atom`, before or after it). */
  private _partsWithInsert(plan: ChainPlan, atom: number, before: boolean, part: RebuildPart): RebuildPart[] {
    const parts = this._parts(plan);
    const k = plan.parts.findIndex((q) => (q.kind === "new" ? q.atom === atom : q.atoms.includes(atom)));
    const at = k < 0 ? parts.length : before ? k : k + 1;
    parts.splice(at, 0, part);
    return parts;
  }

  /**
   * The chain as Apply would leave it (`parts`), shown in the viewer in the document's place, one connected structure,
   * with the chain as loaded faint behind it: its residues not in `parts`. Adding and editing look the same: what
   * Apply keeps solid, the rest faint. `_endPreview` puts the document back.
   */
  private _previewParts(c: ChainSpec, parts: RebuildPart[]): void {
    const studio = this.studio();
    // Not while an example is built: nothing of it is on screen.
    if (typeof studio?.renderFrame !== "function" || this.building) return;
    // Drawn as soon as asked; while a draw is under way only the latest request is kept, drawn when it is done, so a
    // drag never queues up frames behind it.
    this.previewNext = { c, parts, gen: this.previewGen };
    if (this.previewBusy) return;
    this.previewBusy = true;
    void (async () => {
      try {
        while (this.previewNext) {
          const { c: chain, parts: want, gen } = this.previewNext;
          this.previewNext = null;
          if (gen !== this.previewGen) continue;
          const doc = this._inputDoc();
          if (!doc) break;
          let cif: string;
          try { cif = await doc.preview(chain.id, want); } catch { continue; }
          if (gen !== this.previewGen) continue;
          // The first frame of a preview loads a scene of its own, which takes the faint chain with it: drawn again then.
          if (!this.planPreview) this.ghostKey = null;
          this.planPreview = true;
          // The card's selection would draw over the preview (an outline, and sticks where atoms are picked).
          if (this.cardSelected) { this.cardSelected = false; studio.setSelection?.([]); }
          await studio.renderFrame!(cif, doc.name || "preview", { keepCamera: true });
          // Closed while it was drawn: the document back, not this frame (then the next popup's preview, if one is waiting).
          if (gen !== this.previewGen) { this.planPreview = false; await studio.showDocument?.(); continue; }
          // The chain as loaded, faint and a little thinner, drawn once per popup and never changed: the residues Apply
          // keeps hide it inside their own cartoon, so only those left out show, and a drag swaps nothing (an overlay
          // changed per step blinked, or pulsed while two were up; one updated in place, or a lone residue, came out as
          // solid sticks).
          const source = await doc.source(chain.id);
          if (!source) continue;
          const key = chain.id;
          if (key === this.ghostKey) continue;
          this.ghostKey = key;
          this.ghostOn = true;
          const all = new Set<number>();
          for (let i = 0; i < source.atoms.nAtoms; i += 1) if (String(source.atoms.chain_id[i]) === source.chain) all.add(Number(source.atoms.res_id[i]));
          const color = Number.parseInt(String(studio.chainColor?.(chain.id) ?? "#8899aa").replace("#", ""), 16);
          await studio.setOverlay?.("loadedChain", null);
          await studio.setOverlay?.("loadedChain", atomsCif(source.atoms, source.chain, all),
            { representation: "cartoon", alpha: 0.22, color, sizeFactor: 0.17, label: "The chain as loaded" });
        }
      } finally {
        this.previewBusy = false;
      }
    })();
  }

  /** The document back in the viewer after a preview, and the faint chain away. */
  private _endPreview(): void {
    this.previewNext = null;
    this.previewGen += 1;
    this.ghostKey = null;
    const studio = this.studio();
    if (this.ghostOn) { this.ghostOn = false; void studio?.setOverlay?.("loadedChain", null); }
    if (this.planPreview) { this.planPreview = false; void studio?.showDocument?.(); }
  }

  /** A popup's title, and its × (top right) to close it. */
  private _popHead(title: string, close: () => void = () => this._closePop(), detail: string | null = null): HTMLElement {
    return el("div", { class: "rfd4p-pop-title" },
      el("strong", { text: title }),
      detail ? el("span", { class: "muted", text: detail }) : null,
      el("button", { type: "button", class: "rfd4p-pop-x", "aria-label": "Close", title: "Close", text: "×", onclick: close }));
  }

  private _popActions(apply: () => unknown): HTMLElement {
    return el("div", { class: "rfd4p-pop-actions" },
      el("span", { class: "rfd4p-pop-spacer" }),
      el("button", { type: "button", class: "primary compact", text: "Apply", onclick: () => { this.applying = Promise.resolve(apply()); } }));
  }

  /** The rest of a popup, folded: opened by More. Three rows or fewer are not worth folding, and are shown as they are. */
  private _moreFold(...children: (HTMLElement | null | undefined | false)[]): HTMLElement | DocumentFragment {
    const rows = children.filter((n): n is HTMLElement => Boolean(n));
    if (rows.length <= 3) {
      const frag = document.createDocumentFragment();
      frag.append(...rows);
      return frag;
    }
    return el("details", { class: "rfd4p-pop-more" }, el("summary", { text: "More" }), el("div", { class: "rfd4p-pop-more-body" }, ...rows));
  }

  /**
   * Shape (secondary structure), Exposure and Interaction rows, set from `now` ({ss, rasa, inter}, "mixed" where the
   * residues differ). `edits(residueAtoms, interactionAtoms)` gives the condition edits for what changed.
   */
  private _extraFields(now: { ss?: number | string; rasa?: number | string; inter?: string }, { interaction = true } = {}): {
    rows: (HTMLElement | null)[]; edits: (atoms: number[], interactionAtoms?: number[]) => ConditionEdit[];
  } {
    const select = (label: string, options: Option[], value: unknown, title: string): HTMLSelectElement => {
      const s = el("select", { "aria-label": label, title });
      if (value === "mixed") s.append(el("option", { value: "mixed", text: "mixed", selected: true }));
      for (const [v, text] of options) s.append(el("option", { value: v, text, selected: v === String(value) }));
      return s;
    };
    const shape = select("Shape", SHAPE_OPTIONS, now.ss ?? 0, "The secondary structure these residues should take");
    const exposure = select("Exposure", EXPOSURE_OPTIONS, now.rasa ?? 0, "How buried in the design these residues should be");
    const inter = select("Interaction", INTERACTION_OPTIONS, now.inter ?? "", "An interaction their side chains (or the atoms named) should make");
    const row = (label: string, field: HTMLElement): HTMLElement => el("div", { class: "rfd4p-pop-row" }, el("span", { class: "rfd4p-pop-label", text: label }), field);
    return {
      rows: [row("Shape", shape), row("Exposure", exposure), interaction ? row("Interaction", inter) : null],
      edits: (atoms, interactionAtoms = atoms) => {
        const edits: ConditionEdit[] = [];
        if (!atoms.length) return edits;
        if (shape.value !== "mixed" && shape.value !== String(now.ss ?? 0)) {
          const v = Number(shape.value);
          edits.push({ condition: "secondary_structure", atom_indices: atoms, enabled: v > 0, value: v, scope: "residue" });
        }
        if (exposure.value !== "mixed" && exposure.value !== String(now.rasa ?? 0)) {
          const v = Number(exposure.value);
          edits.push({ condition: "rasa", atom_indices: atoms, enabled: v > 0, value: v });
        }
        if (interaction && inter.value !== "mixed" && inter.value !== (now.inter ?? "")) {
          for (const [key] of INTERACTIONS) edits.push({ condition: CONDITION_KEY[key], atom_indices: atoms, enabled: false });
          if (inter.value && interactionAtoms.length) {
            const [key, v] = inter.value.split(":");
            edits.push({ condition: CONDITION_KEY[key], atom_indices: interactionAtoms, enabled: true, value: Number(v) });
          }
        }
        return edits;
      },
    };
  }

  /**
   * The Fold row (CATH): of the whole chain from its chain popup, or with `block` (a new-residues piece) of those new
   * residues only, so a chain can hold domains of different folds (a kept domain and a β-barrel built onto it). The
   * label is per residue, as the model reads it. `apply()` sets it, resolving false on a bad code.
   */
  private _foldField(c: ChainSpec, note: HTMLElement, block: NewPiece | null = null): { row: HTMLElement; apply: () => Promise<boolean> } {
    const now = String((block ? block.fold : c.fold) ?? "").replace(/(\.x)+$/, "");
    const known = FOLD_OPTIONS.some(([v]) => v && v !== "other" && v === now);
    const select = el("select", { "aria-label": "Fold",
      title: block ? "A fold for these new residues to take (CATH); the rest of the chain keeps its own" : "A fold for the whole chain to take (CATH)" });
    for (const [v, text] of FOLD_OPTIONS) {
      select.append(el("option", { value: v, text: v && v !== "other" ? `${text} (${v})` : text,
        selected: v === (known ? now : now ? "other" : "") }));
    }
    const code = el("input", { type: "text", class: "rfd4p-pop-text", spellcheck: "false", autocomplete: "off",
      value: known ? "" : now, placeholder: "e.g. 3.30.70", "aria-label": "Fold code" });
    const show = (): void => { code.hidden = select.value !== "other"; };
    select.addEventListener("change", show);
    show();
    const row = el("div", { class: "rfd4p-pop-row" }, el("span", { class: "rfd4p-pop-label", text: "Fold" }), select, code);
    const apply = async (): Promise<boolean> => {
      const want = select.value === "other" ? code.value.trim() : select.value;
      if (want && !/^\d+(\.\d+){0,3}$/.test(want)) { note.textContent = "A fold code is numbers with dots, e.g. 3.30.70"; return false; }
      const atoms = block ? block.atomIndices : [...c.polymerAtomIndices, ...c.segments.map((g) => g.atomIndex)];
      if (want === now || !atoms.length) return true;
      return this._batch([{ condition: "cath_label", atom_indices: atoms, enabled: Boolean(want), value: want, scope: "residue" }]);
    };
    return { row, apply };
  }

  /** The atoms an interaction is asked of: those named, else the side chains (a glycine's CA). */
  private _interactionAtoms(atoms: number[], which: string | string[]): number[] {
    const a = this._inputDoc()?.atoms;
    if (!a) return [];
    if (Array.isArray(which)) {
      const names = new Set(which);
      return atoms.filter((i) => names.has(String(a.atom_name[i]).toUpperCase()));
    }
    const heavy = (i: number): boolean => String(a.element?.[i] ?? "").toUpperCase() !== "H";
    const bb = new Set(["N", "CA", "C", "O", "OXT"]);
    // Each residue's side chain, or its CA where it has none (a glycine).
    const byRes = new Map<string, number[]>();
    for (const i of atoms) {
      const k = `${a.chain_id[i]}|${a.res_id[i]}|${a.ins_code?.[i] ?? ""}`;
      byRes.set(k, [...(byRes.get(k) ?? []), i]);
    }
    return [...byRes.values()].flatMap((res) => {
      const side = res.filter((i) => heavy(i) && !bb.has(String(a.atom_name[i])));
      return side.length ? side : res.filter((i) => String(a.atom_name[i]) === "CA");
    });
  }

  /** Existing residues: which of them, then three properties (structure, sequence, position), each fixed or designed. */
  private _piecePop(c: ChainSpec, p: RunPiece): (HTMLElement | DocumentFragment | null)[] {
    const a = this._inputDoc()?.atoms;
    // Which residues: one range of the chain as loaded, from – to and a drag bar. Narrowed, the piece is cropped;
    // widened, residues come back as loaded, up to its neighbours. Applied as the chain's plan (`/chains/rebuild`).
    const residuesText = el("input", { type: "text", class: "rfd4p-pop-text", spellcheck: "false", autocomplete: "off",
      value: `${p.start}–${p.end}`, "aria-label": "Residues" });
    const now = this._properties(p);
    const select = (label: string, options: Option[], value: string, title: string): HTMLSelectElement => {
      const s = el("select", { "aria-label": label, title });
      for (const [v, text] of options) s.append(el("option", { value: v, text, selected: v === value }));
      return s;
    };
    const structure = select("Structure", STRUCTURE_OPTIONS,
      now.structure, "Fixed: kept where it is. Rigid: kept as it is, moving as one body (a framework). Free: the model builds it.");
    const sequence = select("Sequence", SEQUENCE_OPTIONS, now.sequence,
      "Fixed: these amino acids. Free: the model writes them.");
    const position = select("Position in chain", POSITION_OPTIONS, now.position,
      "Free: the model chooses where in the chain these residues go.");
    // A residue taken from the entry and renumbered (a motif's "A38") has no range here: its number would not match.
    const plan = p.source ? null : this._plan(c);
    const src = plan?.source?.length ? plan.source : null;
    const reach: RangeReach = (() => {
      const k = c.pieces.indexOf(p);
      const iS = src ? src.findIndex((r) => r.num === p.start) : -1;
      const iE = src ? lastIndexOf(src, (r) => r.num === p.end) : -1;
      if (!src || iS < 0 || iE < 0 || k < 0) return { lo: p.start, hi: p.end, iLo: -1, iHi: -1 };
      const present = new Set((a ? c.polymerAtomIndices : []).map((i) => Number(a!.res_id[i])));
      // Up to the next residue in the job, past new residues too: brought back, they go beside this piece.
      let iLo = iS;
      while (iLo > 0 && !present.has(src[iLo - 1].num)) iLo -= 1;
      let iHi = iE;
      while (iHi < src.length - 1 && !present.has(src[iHi + 1].num)) iHi += 1;
      return { lo: src[iLo].num, hi: src[iHi].num, iLo, iHi, present };
    })();
    const editable = reach.iLo >= 0;
    // The range typed ([lo, hi]); null when not understood.
    const parse = (): number[] | null => {
      const m = /^\s*(?:[A-Za-z_]+)?(-?\d+)\s*(?:[-–]\s*(-?\d+))?\s*$/.exec(residuesText.value);
      return m ? [Number(m[1]), Number(m[2] ?? m[1])] : null;
    };
    // [[lo, hi]], clamped to what the piece can reach; null when not understood.
    const ranges = (): number[][] | null => {
      if (!editable) return [[p.start, p.end]];
      const xy = parse();
      if (!xy) return null;
      const lo = Math.max(reach.lo, Math.min(...xy));
      const hi = Math.min(reach.hi, Math.max(...xy));
      return lo <= hi ? [[lo, hi]] : null;
    };
    // Residues the range holds once applied: the chain's as loaded from lo to hi.
    const count = (): number => {
      const [[lo, hi]] = ranges() ?? [[p.start, p.end]];
      return src && editable ? src.filter((r) => r.num >= lo && r.num <= hi).length : p.count;
    };
    const lenMin = el("input", { type: "number", min: 1, max: 1000, value: count(), "aria-label": "Fewest residues" });
    const lenMax = el("input", { type: "number", min: 1, max: 1000, value: count(), "aria-label": "Most residues" });
    let lenTouched = false;
    for (const input of [lenMin, lenMax]) input.addEventListener("input", () => { lenTouched = true; });
    // The chain as Apply would leave it, drawn as the range is edited, the chain as loaded faint behind it.
    const preview = (): void => {
      const rs = ranges();
      if (rs && plan && editable) this._previewParts(c, this._partsWithRange(plan, p, rs[0][0], rs[0][1]));
    };
    residuesText.addEventListener("input", () => {
      if (!lenTouched) lenMin.value = lenMax.value = String(count());
      preview();
    });
    const lengthRow = el("div", { class: "rfd4p-pop-row", title: "Each design picks one length from this range" },
      el("span", { class: "rfd4p-pop-label", text: "Length" }), el("span", { class: "rfd4p-pop-inline" }, lenMin, el("span", { text: "–" }), lenMax));
    const atomsField = this._atomsField(now.atoms, now.names);
    const atomsRow = el("div", { class: "rfd4p-pop-row" }, el("span", { class: "rfd4p-pop-label", text: "Atoms" }), atomsField.select, atomsField.text);
    const row = (label: string, ...children: Child[]): HTMLElement => el("div", { class: "rfd4p-pop-row" }, el("span", { class: "rfd4p-pop-label", text: label }), ...children);
    const positionRow = row("Position", position);
    // Side chains held means those side chains, so their amino acids; a fully designed piece has no position to keep,
    // only a length.
    const sync = (): void => {
      const sidechain = atomsField.select.value === "sidechain" && structure.value !== "designed";
      if (sidechain) sequence.value = "fixed";
      sequence.disabled = sidechain;
      atomsRow.hidden = structure.value === "designed";
      const free = structure.value === "designed" && sequence.value === "designed";
      if (free) position.value = "fixed";
      positionRow.hidden = free;
      lengthRow.hidden = !free;
    };
    structure.addEventListener("change", sync);
    sequence.addEventListener("change", sync);
    atomsField.select.addEventListener("change", sync);

    const hot = el("input", { type: "text", class: "rfd4p-pop-text", spellcheck: "false", autocomplete: "off",
      value: formatResidueList(c.id, c.hotspotResIds, c.hotspotAtoms), placeholder: "none", "aria-label": "Hotspots",
      title: "Residues of this chain a binder should touch, e.g. A56, A60-62, or some of their atoms: A56(CG,OH)" });
    const keepOnly = el("input", { type: "text", class: "rfd4p-pop-text", spellcheck: "false", autocomplete: "off",
      placeholder: "all", "aria-label": "Keep only these residues",
      title: "Type some residues (e.g. A38, A99) to keep only those, in that order; the rest of the chain becomes new residues (a motif)" });
    const note = el("p", { class: "rfd4p-pop-note", "aria-live": "polite" });
    const extra = this._extraFields({ ss: p.ss, rasa: p.rasa, inter: p.inter });
    const residuesIn = (text: string, inChain: number[]) => {
      const { residues, bad } = parseResidueList(text, c.id);
      const mine = residues.filter((r) => r.chain === c.id);
      // In the order typed; a residue may name some of its atoms.
      const want = new Set(mine.map((r) => r.resId));
      const atomsOf = new Map(mine.filter((r) => r.atoms).map((r) => [r.resId, r.atoms!] as const));
      const byRes = new Map<number, number[]>();
      for (const i of (a ? inChain : [])) {
        const id = Number(a!.res_id[i]);
        if (want.has(id)) byRes.set(id, [...(byRes.get(id) ?? []), i]);
      }
      const atoms = [...want].flatMap((id) => byRes.get(id) ?? []);
      return { want, atomsOf, atoms, bad, missing: [...want].filter((id) => !byRes.has(id)) };
    };

    // Residues typed that this piece cannot reach (they are another piece's): say whose, and offer to open it.
    const elsewhere = (): { num: number; piece: PieceSpec | null } | null => {
      const xy = parse();
      const out = xy?.find((x) => x < reach.lo || x > reach.hi);
      if (out == null) return null;
      return { num: out, piece: c.pieces.find((q) => q !== p && q.kind === "kept" && out >= q.start && out <= q.end) ?? null };
    };
    const apply = async (): Promise<void> => {
      const away = !ranges() && elsewhere();
      if (away) {
        const name = (q: { start: number; end: number }): string => `${c.id}${q.start}${q.end !== q.start ? `–${q.end}` : ""}`;
        note.replaceChildren(away.piece
          ? `${c.id}${away.num} is in ${name(away.piece)}, not this piece. `
          : `${c.id}${away.num} is not in this piece (${name(p)}).`);
        if (away.piece) {
          const target = away.piece;
          note.append(el("button", { type: "button", class: "rfd4p-link-btn", text: `Open ${name(target)}`, onclick: () => {
            const card = [...(this.els.chainList?.querySelectorAll<HTMLElement>(".rfd4p-sub") ?? [])].find((x) => this.cardAtoms.get(x)?.[0] === target.atomIndices[0]);
            this._closePop();
            card?.querySelector<HTMLElement>(".rfd4p-sub-open")?.click();
          } }));
        }
        return;
      }
      const rs = ranges();
      if (!rs) { note.textContent = `Residues from ${reach.lo} to ${reach.hi}`; return; }
      // Hotspots are the chain's, whichever of its pieces the popup was opened from.
      const hotspots = residuesIn(hot.value, c.polymerAtomIndices);
      if (hotspots.bad.length || hotspots.missing.length) {
        note.textContent = hotspots.bad.length ? `Hotspots not understood: ${hotspots.bad.join(" ")}`
          : `Hotspots not in chain ${c.id}: ${formatResidueList(c.id, hotspots.missing)}`;
        return;
      }
      const hotChanged = formatResidueList(c.id, [...hotspots.want], hotspots.atomsOf) !== formatResidueList(c.id, c.hotspotResIds, c.hotspotAtoms);
      // Re-read after each edit: atom indices move when residues are added or removed.
      const chainNow = (): ChainSpec | undefined => this._spec()?.chains.find((x) => x.id === c.id);
      const setHotspots = async (): Promise<boolean> => {
        const cur = chainNow();
        if (!hotChanged || !cur) return true;
        const { res_id: ids, atom_name: names } = this._inputDoc()!.atoms;
        const edits: ConditionEdit[] = [{ condition: "hotspot", atom_indices: cur.polymerAtomIndices, enabled: false }];
        const on = cur.polymerAtomIndices.filter((i) => hotspots.want.has(Number(ids[i]))
          && (!hotspots.atomsOf.has(Number(ids[i])) || hotspots.atomsOf.get(Number(ids[i]))!.includes(String(names[i]).toUpperCase())));
        if (on.length) edits.push({ condition: "hotspot", atom_indices: on, enabled: true });
        return this._batch(edits);
      };
      if (keepOnly.value.trim()) {
        const only = residuesIn(keepOnly.value, c.polymerAtomIndices);
        if (only.bad.length || only.missing.length || !only.atoms.length) {
          note.textContent = only.bad.length ? `Not understood: ${only.bad.join(" ")}` : `Not in chain ${c.id}: ${formatResidueList(c.id, only.missing)}`;
          return;
        }
        this._closePop();
        // Shape, exposure and interaction first: they change no atoms, so the edits after see the same indices.
        const extraEdits = extra.edits(p.atomIndices, this._interactionAtoms(p.atomIndices, atomsField.value()));
        if (extraEdits.length && !await this._batch(extraEdits)) return;
        // The residues kept, in the order typed, take this popup's properties: side chains and anywhere are part of the
        // set-up (an enzyme's site); "can move", other atoms or a designed sequence are set on them after.
        const which = atomsField.value();
        await this._runFlow("scaffold", this._spec()!, {
          atoms: only.atoms, ordered: true, sidechainsOnly: which === "sidechain", unindexed: position.value === "anywhere",
        });
        if (structure.value === "rigid" || sequence.value === "designed" || Array.isArray(which) || which === "backbone") {
          // An ordered motif is renumbered: the kept residues are the chain's non-new residues.
          const cur = chainNow();
          const kept = (cur?.pieces ?? []).filter((x) => x.kind !== "new").flatMap((x) => x.atomIndices);
          if (kept.length) await this._applyPiece({ kind: "kept", keep: "all" }, kept, { structure: structure.value, atoms: which, sequence: sequence.value, position: position.value });
        }
        await setHotspots();
        return;
      }
      this._closePop();
      const [[lo, hi]] = rs;
      // A new range: the chain rebuilt to its plan (order, numbering and bonds all from it); residues brought back come
      // in as loaded and take the popup's settings below with the rest.
      const grew = lo < p.start || hi > p.end;
      if (editable && plan && (lo !== p.start || hi !== p.end)) {
        if (!await this._mutate("/chains/rebuild", { chain_id: c.id, parts: this._partsWithRange(plan, p, lo, hi) })) return;
      }
      const mine = (): number[] => {
        const doc = this._inputDoc()!.atoms;
        return (chainNow()?.polymerAtomIndices ?? [])
          .filter((i) => !SENTINEL.test(String(doc.res_name[i])) && Number(doc.res_id[i]) >= lo && Number(doc.res_id[i]) <= hi);
      };
      const atoms = editable ? mine() : p.atomIndices;
      // Shape, exposure and interaction: they change no atoms, so the edits after see the same indices.
      const extraEdits = extra.edits(atoms, this._interactionAtoms(atoms, atomsField.value()));
      if (extraEdits.length && !await this._batch(extraEdits)) return;
      if (!await setHotspots()) return;
      const want: Want = { structure: structure.value, atoms: atomsField.value(), sequence: sequence.value, position: position.value };
      const atomsNow = now.atoms === "named" ? this._atomNames(now.names).join(",") : now.atoms;
      const atomsWant = Array.isArray(want.atoms) ? want.atoms.join(",") : want.atoms;
      const changed = want.structure !== now.structure || want.sequence !== now.sequence || want.position !== now.position
        || (want.structure !== "designed" && atomsWant !== atomsNow);
      // Residues brought back come as loaded (fixed); they take the popup's settings when those are not that.
      const asLoaded = want.structure === "fixed" && want.sequence === "fixed" && want.position === "fixed" && (want.atoms === "all" || !want.atoms);
      if (atoms.length && (changed || (grew && !asLoaded)) && !await this._applyPieces([{ p, atoms: editable ? mine() : atoms, want }])) return;
      // Lengths last: free residues of another length become new residues.
      if (!lengthRow.hidden && lenTouched) {
        const n = count();
        const min = Math.max(1, Math.round(Number(lenMin.value)) || n);
        const max = Math.max(min, Math.round(Number(lenMax.value)) || n);
        if (min !== n || max !== n) await this._mutate("/segments/replace", { atom_indices: editable ? mine() : atoms, minimum: min, maximum: max });
      }
    };

    const crop = editable && src && src.length > 1 ? this._cropBar(c, p, src, reach, residuesText, ranges) : null;
    sync();
    // The chain as loaded, its residues not in the job see-through, from the moment the popup opens.
    if (plan && editable) queueMicrotask(() => this._previewParts(c, this._parts(plan)));
    const name = `${c.id}${p.start}${p.end !== p.start ? `–${p.end}` : ""}`;
    return [
      this._popHead(this._pieceText(c, p)),
      // The range first: narrowing it is how a loaded structure is cut to the part that matters.
      editable
        ? row("Residues", el("span", { class: "rfd4p-pop-inline" }, el("span", { text: c.id }), this._rangeBoxes(residuesText, reach)))
        : row("Residues", el("span", { class: "rfd4p-pop-static", text: p.source ?? name,
          title: p.source ? `From the entry's ${p.source}; ${name} in this chain` : undefined })),
      crop,
      row("Structure", structure),
      atomsRow,
      row("Sequence", sequence),
      positionRow,
      lengthRow,
      row("Hotspots", hot),
      this._moreFold(
        ...extra.rows,
        row("Keep only", keepOnly)),
      note,
      this._popActions(apply),
    ];
  }

  /** A piece's three properties, as the popup and the row name them. */
  private _properties(p: PieceSpec | { kind: "kept"; keep?: string; anywhere?: boolean; atoms?: string | null }): Properties {
    if (p.kind !== "kept") return { structure: "designed", atoms: "all", names: "", sequence: "designed", position: "fixed" };
    const structure = ({ all: "fixed", backbone: "fixed", sidechain: "fixed", shape: "rigid" } as Record<string, string>)[p.keep ?? ""] ?? "designed";
    const sequence = p.keep === "backbone" ? "designed" : "fixed";
    // Backbone held with a designed sequence is the plain "structure fixed": the side chains change anyway.
    let atoms = p.atoms ?? "all";
    if (sequence === "designed" && atoms === "backbone") atoms = "all";
    const named = !["all", "backbone", "sidechain"].includes(atoms);
    return { structure, atoms: named ? "named" : atoms, names: named ? atoms : "", sequence, position: p.anywhere ? "anywhere" : "fixed" };
  }

  /** Atom names typed as "CG, OD1" or "CG OD1". */
  private _atomNames(text: unknown): string[] {
    return String(text ?? "").split(/[\s,;]+/).filter(Boolean).map((n) => n.toUpperCase());
  }

  /** The Atoms row: a select, and the names it holds when "named". */
  private _atomsField(now = "all", names = ""): { select: HTMLSelectElement; text: HTMLInputElement; value: () => string | string[] } {
    const select = el("select", { "aria-label": "Atoms", title: "Which atoms are held: all of them, the backbone, the side chains, or atoms named here" });
    if (now === "mixed") select.append(el("option", { value: "mixed", text: "mixed", selected: true }));
    for (const [v, text] of ATOM_OPTIONS) select.append(el("option", { value: v, text, selected: v === now }));
    const text = el("input", { type: "text", class: "rfd4p-pop-text", spellcheck: "false", autocomplete: "off",
      value: names, placeholder: "CG, OD1", "aria-label": "Atom names" });
    const show = (): void => { text.hidden = select.value !== "named"; };
    select.addEventListener("change", show);
    show();
    return { select, text, value: () => (select.value === "named" ? this._atomNames(text.value) : select.value) };
  }

  /** Set structure / sequence / position on `atoms` (all or part of piece `p`). Rigid holds are internal coordinates. */
  private async _applyPiece(p: PieceChange["p"], atoms: number[], want: Want): Promise<boolean> {
    return this._applyPieces([{ p, atoms, want }]);
  }

  /** `_applyPiece` for several pieces at once: one condition edit, so one Undo. */
  private async _applyPieces(parts: PieceChange[]): Promise<boolean> {
    // Internal coordinates are their own edit: clear them before anything else, set them before the rest.
    const off = parts.filter(({ p }) => p.kind === "kept" && (p as RunPiece).keep === "shape").flatMap(({ atoms }) => atoms);
    if (off.length && !await this._mutate("/internal-coords", { atom_indices: off, enabled: false })) return false;
    // "Rigid" is one rigid body for the whole job (an antibody's two framework chains, a framework split by
    // CDRs): join the rigid group already there. Separate bodies are the Studio editor's.
    // One rigid body per chain (an antibody's light and heavy frameworks move apart; a framework split by CDRs moves
    // as one), as the bundled examples set them. Only the held atoms join it.
    const rigid = parts.filter(({ want }) => want.structure === "rigid");
    const chains = [...new Set(rigid.flatMap(({ atoms }) => atoms.map((i) => String(this._inputDoc()!.atoms.chain_id[i]))))];
    for (const chain of chains) {
      const a = this._inputDoc()!.atoms;
      const on = rigid.flatMap(({ atoms, want }) => this._heldAtoms(atoms.filter((i) => String(a.chain_id[i]) === chain), want));
      if (on.length && !await this._mutate("/internal-coords", { atom_indices: on, enabled: true, group_id: this._rigidGroup(chain) })) return false;
      // No saved targets: the body's shape is read from its coordinates when the job is built, centred and turned at
      // random, as AtomWorks does for a group without targets (and as the bundled examples are saved).
      if (on.length && !await this._mutate("/internal-coords/clear-targets", { atom_indices: on })) return false;
    }
    if (!await this._batch(parts.flatMap(({ atoms, want }) => this._pieceEdits(atoms, want)))) return false;
    // A residue placed anywhere keeps only its held atoms' coordinates (an enzyme's catalytic tips): where the rest of
    // it sits is the model's to choose, as the motif inputs of RFdiffusion benchmarks give it.
    const loose = parts.filter(({ want }) => want.position === "anywhere" && want.structure === "fixed")
      .flatMap(({ atoms, want }) => { const held = new Set(this._heldAtoms(atoms, want)); return held.size ? atoms.filter((i) => !held.has(i)) : []; });
    // The held atoms lead their residue then: a token is read from its first atom.
    const lead = parts.filter(({ want }) => want.position === "anywhere" && want.structure === "fixed").flatMap(({ atoms, want }) => this._heldAtoms(atoms, want));
    return loose.length ? this._mutate("/coordinates/clear", { atom_indices: loose, lead }) : true;
  }

  /** The atoms of `atoms` a structure setting holds. A fixed structure with a designed sequence holds the backbone. */
  private _heldAtoms(atoms: number[], { structure, atoms: which = "all", sequence }: Want): number[] {
    if (structure === "designed") return [];
    const a = this._inputDoc()?.atoms;
    const backbone = new Set(this._backboneOf(atoms));
    if (Array.isArray(which)) {
      const names = new Set(which);
      return atoms.filter((i) => names.has(String(a!.atom_name[i]).toUpperCase()));
    }
    if (which === "backbone" || (which === "all" && sequence === "designed")) return atoms.filter((i) => backbone.has(i));
    if (which === "sidechain") return atoms.filter((i) => !backbone.has(i));
    return atoms;
  }

  private _pieceEdits(atoms: number[], want: Want): ConditionEdit[] {
    const { structure, sequence, position } = want;
    const edits: ConditionEdit[] = [];
    const held = this._heldAtoms(atoms, want);
    if (structure !== "rigid") {
      edits.push({ condition: "coordinate", atom_indices: atoms, enabled: false });
      if (held.length) edits.push({ condition: "coordinate", atom_indices: held, enabled: true });
    } else {
      // The rigid body is the held atoms with coordinates (set before this edit); the others are free.
      const coord = this._inputDoc()!.atoms.coord;
      const inBody = new Set(held.filter((i) => coord[i]?.every?.(Number.isFinite)));
      const free = atoms.filter((i) => !inBody.has(i));
      if (free.length) edits.push({ condition: "coordinate", atom_indices: free, enabled: false });
    }
    edits.push({ condition: "sequence", atom_indices: atoms, enabled: sequence === "fixed" });
    edits.push({ condition: "index", atom_indices: atoms, enabled: position === "anywhere" });
    return edits;
  }

  /**
   * A range of residues as two boxes (from – to), as new residues take their length, kept in step with `field`, the
   * hidden text the popup reads ("1–40") and the crop bar writes.
   */
  private _rangeBoxes(field: HTMLInputElement, reach: { lo?: number; hi?: number }): HTMLElement {
    field.hidden = true;
    const box = el("span", { class: "rfd4p-ranges" });
    let writing = false;
    const read = (): string[] => {
      const m = /^\s*(-?\d+)\s*(?:[-–]\s*(-?\d+))?\s*$/.exec(String(field.value));
      return m ? [m[1], m[2] ?? m[1]] : ["", ""];
    };
    const write = (): void => {
      const [x, y] = [...box.querySelectorAll("input")].map((i) => i.value.trim());
      writing = true;
      field.value = !x && !y ? "" : x === y || !y ? x : !x ? y : `${x}–${y}`;
      field.dispatchEvent(new Event("input", { bubbles: true }));
      writing = false;
    };
    const draw = (): void => {
      const num = (v: string, label: string): HTMLInputElement => {
        const i = el("input", { type: "number", value: v, min: reach.lo, max: reach.hi, step: 1, "aria-label": label });
        i.addEventListener("input", write);
        return i;
      };
      const [x, y] = read();
      box.replaceChildren(el("span", { class: "rfd4p-range" }, num(x, "From residue"), el("span", { text: "–" }), num(y, "To residue")));
    };
    field.addEventListener("input", () => { if (!writing) draw(); });
    draw();
    return el("span", { class: "rfd4p-ranges-wrap" }, box, field);
  }

  /**
   * The chain as it was loaded, as a bar: this piece's ranges on it, the chain's other residues muted, and a handle at
   * each end. Dragging a handle in crops the piece, out brings residues back (up to its neighbours); it edits the
   * Residues field, so Apply works as typed.
   */
  private _cropBar(c: ChainSpec, p: { start: number; end: number; atomIndices: number[] }, src: ChainPlan["source"], reach: RangeReach, field: HTMLInputElement, ranges: () => number[][] | null): HTMLElement {
    const n = src.length;
    const pct = (k: number): string => `${(k / n) * 100}%`;
    const first = (num: number): number => src.findIndex((r) => r.num === num);
    const last = (num: number): number => lastIndexOf(src, (r) => r.num === num);
    const track = el("div", { class: "rfd4p-crop-track" });
    const bar = el("div", { class: "rfd4p-crop", title: `Drag the ends to crop, or to bring back residues (${c.id}${src[0].num}–${src[src.length - 1].num} as loaded)` }, track);
    const block = (cls: string, i0: number, i1: number): HTMLElement => el("span", { class: cls, style: `left:${pct(i0)};width:${pct(i1 - i0 + 1)}` });
    const handles = ["lo", "hi"].map((side) => el("span", { class: `rfd4p-crop-handle rfd4p-crop-${side}`, role: "slider",
      "aria-label": side === "lo" ? "First residue" : "Last residue" }));
    const draw = (): void => {
      const rs = ranges() ?? [[p.start, p.end]];
      const own = new Set(p.atomIndices.length ? src.filter((r) => r.num >= p.start && r.num <= p.end).map((r) => r.num) : []);
      const parts: HTMLElement[] = [];
      // The chain's other residues, in runs.
      let run: number[] | null = null;
      src.forEach((r, k) => {
        const other = reach.present?.has(r.num) && !own.has(r.num);
        if (other) { if (run) run[1] = k; else run = [k, k]; }
        if ((!other || k === n - 1) && run) { parts.push(block("rfd4p-crop-other", run[0], run[1])); run = null; }
      });
      for (const [x, y] of rs) parts.push(block("rfd4p-crop-sel", first(x), last(y)));
      track.replaceChildren(...parts);
      handles[0].style.left = pct(first(rs[0][0]));
      handles[1].style.left = pct(last(rs[rs.length - 1][1]) + 1);
      handles[0].setAttribute("aria-valuenow", String(rs[0][0]));
      handles[1].setAttribute("aria-valuenow", String(rs[rs.length - 1][1]));
    };
    const set = (side: "lo" | "hi", k: number): void => {
      const rs = (ranges() ?? [[p.start, p.end]]).map((r) => r.slice());
      if (side === "lo") rs[0][0] = src[Math.max(reach.iLo, Math.min(k, last(rs[0][1])))].num;
      else rs[rs.length - 1][1] = src[Math.min(reach.iHi, Math.max(k, first(rs[rs.length - 1][0])))].num;
      field.value = rs.map(([x, y]) => (x === y ? `${x}` : `${x}–${y}`)).join(", ");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    };
    handles.forEach((h, j) => {
      const side = j ? "hi" : "lo";
      h.addEventListener("pointerdown", (ev) => {
        if (ev.button !== 0) return;
        ev.preventDefault();
        ev.stopPropagation();
        try { h.setPointerCapture(ev.pointerId); } catch { /* not an active pointer */ }
        const move = (e: PointerEvent): void => {
          const r = track.getBoundingClientRect();
          const f = (e.clientX - r.left) / r.width;
          set(side, side === "lo" ? Math.round(f * n) : Math.round(f * n) - 1);
        };
        const up = (): void => { h.removeEventListener("pointermove", move); h.removeEventListener("pointerup", up); h.removeEventListener("pointercancel", up); };
        h.addEventListener("pointermove", move);
        h.addEventListener("pointerup", up);
        h.addEventListener("pointercancel", up);
      });
    });
    bar.append(...handles);
    field.addEventListener("input", draw);
    draw();
    return bar;
  }

  /**
   * New residues: how many, or remove them. New residues that replaced residues (a free piece given another length)
   * turn back into them, with their coordinates, at their old count or with a fixed Structure or Sequence.
   */
  private _newPop(c: ChainSpec, p: NewPiece): (HTMLElement | DocumentFragment | null)[] {
    const min = el("input", { type: "number", min: 1, max: 1000, value: p.min, "aria-label": "Fewest new residues" });
    const max = el("input", { type: "number", min: 1, max: 1000, value: p.max, "aria-label": "Most new residues" });
    const origin = this._inputDoc()?.segmentOrigin(p.atomIndex) ?? null;
    const select = (label: string, options: Option[], title: string): HTMLSelectElement => {
      const s = el("select", { "aria-label": label, title });
      for (const [v, text] of options) s.append(el("option", { value: v, text, selected: v === "designed" }));
      return s;
    };
    const structure = origin ? select("Structure", STRUCTURE_OPTIONS, "Fixed or rigid: the residues these replaced, back in place") : null;
    const sequence = origin ? select("Sequence", SEQUENCE_OPTIONS, "Fixed: the residues these replaced, back with their amino acids") : null;
    // New residues can be asked a shape and an exposure: each of them takes it when the job is built.
    const extra = this._extraFields({ ss: p.ss, rasa: p.rasa }, { interaction: false });
    const note = el("p", { class: "rfd4p-pop-note", "aria-live": "polite" });
    // The chain's fold, here too: where a new chain is laid out is where one looks for it.
    const fold = this._foldField(c, note, p);
    const apply = async (): Promise<boolean> => {
      const lo = Math.max(1, Math.round(Number(min.value)) || p.min);
      const hi = Math.max(lo, Math.round(Number(max.value)) || p.max);
      if (!await fold.apply()) return false;
      this._closePop();
      const want: Want | null = origin ? { structure: structure!.value, atoms: "all", sequence: sequence!.value, position: "fixed" } : null;
      if (origin && want && (want.structure !== "designed" || want.sequence !== "designed" || (lo === origin.count && hi === origin.count))) {
        const back = await this._restoreSegment(c.id, p.atomIndex);
        if (!back) return false;
        const edits = extra.edits(back);
        if (edits.length && !await this._batch(edits)) return false;
        const free = want.structure === "designed" && want.sequence === "designed";
        return free || this._applyPieces([{ p: { kind: "kept" }, atoms: back, want }]);
      }
      // Atom indices may have moved if the fold was set: re-read this block's.
      const cur = this._spec()?.chains.find((x) => x.id === c.id)?.pieces.find((x): x is NewPiece => x.kind === "new" && x.atomIndex === p.atomIndex) ?? p;
      const edits = extra.edits(cur.atomIndices);
      if (edits.length && !await this._batch(edits)) return false;
      return lo !== p.min || hi !== p.max ? this._mutate("/segments/range", { atom_index: p.atomIndex, minimum: lo, maximum: hi }) : true;
    };
    const row = (label: string, ...children: Child[]): HTMLElement => el("div", { class: "rfd4p-pop-row" }, el("span", { class: "rfd4p-pop-label", text: label }), ...children);
    // The old count, one click away: set back to it, the residues come back in place.
    const was = origin && el("button", { type: "button", class: "rfd4p-pop-was", text: `was ${origin.count}`,
      title: "The residues these replaced, back in place, free", onclick: () => { min.value = String(origin.count); max.value = String(origin.count); } });
    return [
      this._popHead(`Chain ${c.id}, new residues`),
      el("div", { class: "rfd4p-pop-row", title: "Each design picks one length from this range" },
        el("span", { class: "rfd4p-pop-label", text: "Length" }), el("span", { class: "rfd4p-pop-inline" }, min, el("span", { text: "–" }), max, was)),
      structure && row("Structure", structure),
      sequence && row("Sequence", sequence),
      // Shape first (blocks are drawn with it), then exposure and the chain's fold.
      extra.rows[0],
      this._moreFold(extra.rows[1], fold.row),
      note,
      this._popActions(apply),
    ].filter(Boolean) as (HTMLElement | DocumentFragment)[];
  }

  /** New residues back into the residues they replaced; their atoms after, or null. */
  private async _restoreSegment(_chainId: string, atomIndex: number): Promise<number[] | null> {
    const doc = this._inputDoc();
    const keys = doc?.segmentOrigin(atomIndex)?.keys;
    if (!doc || !keys || !await this._mutate("/segments/restore", { atom_index: atomIndex })) return null;
    const a = this._inputDoc()!.atoms;
    const want = new Set(keys);
    const atoms: number[] = [];
    for (let i = 0; i < a.nAtoms; i += 1) if (want.has(`${a.chain_id[i]}:${a.res_id[i]}:${a.ins_code[i]}`)) atoms.push(i);
    return atoms;
  }

  /** Every remembered segment back into its residues (partial diffusion's fix), last first so indices hold. */
  private async _restoreAll(): Promise<void> {
    const doc = this._inputDoc();
    const segs = doc?.originAtoms() ?? [];
    for (const i of segs.reverse()) if (!await this._restoreSegment(String(this._inputDoc()!.atoms.chain_id[i]), i)) return;
  }

  /** A ligand: where it goes, or another molecule in its place. */
  private _ligandPop(c: ChainSpec, l: LigandSpec): (HTMLElement | null)[] {
    const atoms = l.atomIndices;
    const now = l.pose === "predicted" ? "free" : l.pose === "rigid" ? "rigid" : "fixed";
    const pose = el("select", { "aria-label": "Structure", title: "Fixed: kept where it is. Rigid: its shape kept, the model places it. Free: the model builds and places it." },
      ...["fixed", "rigid", "free"].map((v) => el("option", { value: v, text: v, selected: v === now })));
    // Which atoms a fixed pose holds: all, or some named (the rest placed by the model).
    const held = el("select", { "aria-label": "Atoms", title: "Hold all of the ligand, or only the atoms named here" },
      el("option", { value: "all", text: "all", selected: !l.heldNames }),
      el("option", { value: "named", text: "named", selected: Boolean(l.heldNames) }));
    const names = el("input", { type: "text", class: "rfd4p-pop-text", spellcheck: "false", autocomplete: "off",
      value: l.heldNames ?? "", placeholder: "N1, C2", "aria-label": "Atom names" });
    const code = el("input", { type: "text", class: "rfd4p-pop-text", maxlength: 5, spellcheck: "false", autocomplete: "off",
      placeholder: "another code, e.g. HEM", "aria-label": "Swap for ligand code" });
    const note = el("p", { class: "rfd4p-pop-note", "aria-live": "polite" });
    const atomsRow = el("div", { class: "rfd4p-pop-row" }, el("span", { class: "rfd4p-pop-label", text: "Atoms" }), held, names);
    const sync = (): void => {
      atomsRow.hidden = pose.value === "free";
      names.hidden = held.value !== "named";
    };
    pose.addEventListener("change", sync);
    held.addEventListener("change", sync);
    sync();
    const apply = async (): Promise<void> => {
      if (code.value.trim()) {
        note.textContent = `Looking up ${code.value.trim().toUpperCase()}…`;
        try {
          await this._addLigand(code.value, { replace: atoms, chainId: c.id });
        } catch (err) {
          note.textContent = msg(err);
          return;
        }
        this._closePop();
        return;
      }
      const a = this._inputDoc()!.atoms;
      const wanted = pose.value === "free" ? [] : held.value === "named"
        ? (() => { const set = new Set(this._atomNames(names.value)); return atoms.filter((i) => set.has(String(a.atom_name[i]).toUpperCase())); })()
        : atoms;
      if (pose.value !== "free" && !wanted.length) {
        note.textContent = `No atoms named ${names.value.trim() || "here"} in ${l.name}`;
        return;
      }
      this._closePop();
      const namesChanged = pose.value !== "free" && (held.value === "named" ? names.value.trim() !== (l.heldNames ?? "") : Boolean(l.heldNames));
      if (namesChanged || pose.value !== now) void this._setLigandPose(c.id, atoms, pose.value, wanted);
    };
    return [
      this._popHead(`Ligand ${l.name}`),
      el("div", { class: "rfd4p-pop-row" }, el("span", { class: "rfd4p-pop-label", text: "Structure" }), pose),
      atomsRow,
      el("div", { class: "rfd4p-pop-row" }, el("span", { class: "rfd4p-pop-label", text: "Swap" }), code),
      note,
      this._popActions(apply),
    ];
  }

  /**
   * Ligand atoms `atoms` fixed, rigid or free, `held` (all of them, or some named) holding it. Rigid is the body of the
   * ligand's structure (`_rigidGroup`: a cofactor filed under a rigid target moves with it), as residues are made rigid.
   */
  private async _setLigandPose(chainId: string, atoms: number[], mode: string, held: number[] = atoms): Promise<boolean> {
    const a = this._inputDoc()?.atoms;
    const grp = a?.annotations?.condition_CoordinateGroup_1_atom;
    // Rigid atoms leave their body first; making atoms rigid clears their fixed coordinates.
    const rigidNow = atoms.filter((i) => Number(grp?.[i]) > 0);
    if (rigidNow.length && !await this._mutate("/internal-coords", { atom_indices: rigidNow, enabled: false })) return false;
    if (mode === "rigid") {
      if (!await this._batch([{ condition: "coordinate", atom_indices: atoms, enabled: false }])) return false;
      if (!await this._mutate("/internal-coords", { atom_indices: held, enabled: true, group_id: this._rigidGroup(chainId) })) return false;
      // As a rigid residue's: its shape read from its coordinates when the job is built, centred and turned at random.
      return this._mutate("/internal-coords/clear-targets", { atom_indices: held });
    }
    const edits: ConditionEdit[] = [{ condition: "coordinate", atom_indices: atoms, enabled: false }];
    if (mode === "fixed") edits.push({ condition: "coordinate", atom_indices: held, enabled: true });
    return this._batch(edits);
  }

  /** A chain: its name and its place in the job (the order the model reads the chains in). */
  private _chainPop(c: ChainSpec): (HTMLElement | null)[] {
    const ids = (this._spec()?.chains ?? []).map((x) => x.id);
    const name = el("input", { type: "text", class: "rfd4p-pop-text", maxlength: 4, spellcheck: "false", autocomplete: "off",
      value: c.id, "aria-label": "Chain name" });
    const order = el("select", { "aria-label": "Chain order", title: "Where this chain comes in the job" });
    ids.forEach((id, k) => order.append(el("option", { value: String(k), text: String(k + 1), selected: id === c.id })));
    const note = el("p", { class: "rfd4p-pop-note", "aria-live": "polite" });
    const fold = c.role !== "ligand" ? this._foldField(c, note) : null;
    const apply = async (): Promise<void> => {
      if (fold && !await fold.apply()) return;
      const next = name.value.trim();
      if (!/^[A-Za-z0-9_]{1,4}$/.test(next)) { note.textContent = "A chain name is 1–4 letters or digits"; return; }
      if (next !== c.id && ids.includes(next)) { note.textContent = `There is a chain ${next} already`; return; }
      this._closePop();
      if (next !== c.id) {
        if (!await this._mutate("/chains", { atom_indices: c.atomIndices, chain_id: next })) return;
        // Its caption ("PDB 3EAK · B") follows it too.
        const doc = this._inputDoc();
        const label = doc ? this.sources.get(doc.sid)?.get(c.id) : undefined;
        if (label) this._rememberSource([next], label);
      }
      const at = Number(order.value);
      if (at !== ids.indexOf(c.id)) {
        const rest = ids.filter((id) => id !== c.id).map((id) => (id === c.id ? next : id));
        rest.splice(at, 0, next);
        await this._mutate("/chains/order", { chain_ids: rest });
      }
    };
    return [
      this._popHead(`Chain ${c.id}`),
      el("div", { class: "rfd4p-pop-row" }, el("span", { class: "rfd4p-pop-label", text: "Name" }), name),
      el("div", { class: "rfd4p-pop-row" }, el("span", { class: "rfd4p-pop-label", text: "Order" }), order),
      fold?.row ?? null,
      note,
      this._popActions(apply),
    ];
  }

  /** Chain `chainId`'s rigid group ("fixed, can move"): the one it has, else the next free number. */
  private _rigidGroup(chainId: string): number {
    const a = this._inputDoc()?.atoms;
    const grp = a?.annotations?.condition_CoordinateGroup_1_atom;
    // Chains from the same structure share one body (an antibody's heavy and light chains keep their pairing), as
    // upstream's antibody and VHH examples are set; chains from different structures move apart.
    const chains = this._spec()?.chains ?? [];
    const source = this._sourceOf(chains.find((c) => c.id === String(chainId)) ?? { id: chainId, role: "new" });
    const same = new Set(source ? chains.filter((c) => this._sourceOf(c) === source).map((c) => c.id) : [String(chainId)]);
    same.add(String(chainId));
    let own: number | null = null;
    let top = 0;
    for (let i = 0; i < (grp?.length ?? 0); i += 1) {
      const g = Number(grp![i]);
      if (!(g > 0)) continue;
      top = Math.max(top, g);
      if (same.has(String(a!.chain_id[i])) && (own === null || g < own)) own = g;
    }
    return own ?? top + 1;
  }

  private _backboneOf(indices: number[]): number[] {
    const a = this._inputDoc()?.atoms;
    if (!a) return [];
    return indices.filter((i) => ["N", "CA", "C", "O"].includes(String(a.atom_name[i])));
  }

  /**
   * The shown document's hotspot residues coloured amber in the viewer, in the structure's own cartoon (Studio's
   * `setHighlight`; side-chain sticks were too busy): the input's while editing and while a design runs, a
   * design's own when one is shown. Studio keeps a highlight across loads and live frames.
   */
  showHotspots(): void {
    const studio = this.studio();
    // An example being built is not on screen; it is highlighted once it opens.
    if (typeof studio?.setHighlight !== "function" || this.building) return;
    const viewingDesign = this.host.isViewingDesign();
    const doc = this._inputDoc();
    const atoms = doc?.atoms;
    const hot = atoms?.annotations?.condition_hotspot_1_atom;
    const residues = new Map<string, ViewerResidue>();
    // A run in progress shows live frames over the input, numbered as the job is (past any new residues).
    const live = this.host.liveHotspots();
    if (live && !viewingDesign) {
      for (const r of live) residues.set(`${r.chain}|${r.residue}`, r);
    } else if (viewingDesign) {
      for (const r of this.host.shownDesignHotspots() ?? []) residues.set(`${r.chain}|${r.residue}|${r.insCode ?? ""}`, r);
    } else if (hot && atoms) {
      for (let i = 0; i < atoms.nAtoms; i += 1) {
        if (!hot[i]) continue;
        const r = viewerResidue(atoms, i);
        residues.set(`${r.chain}|${r.residue}|${r.insCode}`, r);
      }
    }
    // Residues the model rebuilds (no atom of theirs held) are faded in the input: what stays is what is solid.
    const free = new Map<string, ViewerResidue>();
    const crd = atoms?.annotations?.condition_coordinate_1_atom as number[][] | undefined;
    // Not with partial diffusion: then the free residues' coordinates are where the model starts.
    if (atoms && !live && !viewingDesign && !this.host.partialDiffusion().on) {
      const held = new Set<string>();
      const key = (i: number): string => `${atoms.chain_id[i]}|${Number(atoms.auth_seq_id?.[i] ?? atoms.res_id[i])}|${insCodeOf(atoms, i)}`;
      // Held in place, or rigid (a body of its own: kept as it is, moved as one).
      const grp = atoms.annotations?.condition_CoordinateGroup_1_atom;
      for (let i = 0; i < atoms.nAtoms; i += 1) if (Number.isFinite(crd?.[i]?.[0]) || Number(grp?.[i]) > 0) held.add(key(i));
      for (let i = 0; i < atoms.nAtoms; i += 1) {
        const k = key(i);
        if (held.has(k) || free.has(k) || SENTINEL.test(String(atoms.res_name[i]))) continue;
        free.set(k, viewerResidue(atoms, i));
      }
    }
    // Sent only when it changes: each one repaints every highlight, and Studio keeps them across loads and live
    // frames, and until its viewer has started.
    const send = (key: string, list: Map<string, ViewerResidue>, options: { color?: number; transparency?: number }): void => {
      const sig = [...list.keys()].join(" ");
      if (this.highlightSent[key] === sig) return;
      this.highlightSent[key] = sig;
      this.hotspotQueue = this.hotspotQueue
        .then(() => studio.setHighlight!(key, list.size ? [...list.values()] : null, options))
        .catch((err) => console.warn("Hotspot highlight failed:", err));
    };
    send("hotspots", residues, { color: HOTSPOT_COLOR });
    send("free", free, { transparency: FREE_TRANSPARENCY });
  }

  /** Take a highlight off (as a run's first frame replaces the input), so `showHotspots` sends it again after. */
  clearHighlight(key: string): Promise<void> | undefined {
    delete this.highlightSent[key];
    return this.studio()?.setHighlight?.(key, null);
  }

  // ---- selection popup ----------------------------------------------------------------------------------------

  /** The popup for the residues picked in the viewer or the sequence bar (or `picked`: atoms, as an example is built). */
  _renderPop(picked: number[] | null = null): void {
    const pop = this.pop;
    const doc = this._inputDoc();
    const sel = picked ?? this.studio()?.getSelection?.() ?? [];
    if (!sel.length || !doc || (!picked && (this.host.isViewingDesign() || document.body.classList.contains("rfd4p-advanced"))) || this.busy) {
      pop.hidden = true;
      return;
    }
    const a = doc.atoms;
    const residues = doc.residueAtoms(sel);
    const sentinel = (i: number): boolean => SENTINEL.test(String(a.res_name[i]));
    const ligandAtoms = residues.filter((i) => a.hetero[i] && !sentinel(i));
    const polymerAtoms = residues.filter((i) => !a.hetero[i]);
    // "A60–65, B3" style summary of the selected residues.
    const byChain = new Map<string, Set<number>>();
    for (const i of polymerAtoms) {
      const ids = byChain.get(a.chain_id[i]) ?? new Set<number>();
      ids.add(a.res_id[i]);
      byChain.set(a.chain_id[i], ids);
    }
    const parts: string[] = [];
    let nRes = 0;
    for (const [chain, ids] of byChain) {
      const sorted = [...ids].sort((x, y) => x - y);
      nRes += sorted.length;
      let start = sorted[0];
      for (let k = 1; k <= sorted.length; k += 1) {
        if (k === sorted.length || sorted[k] !== sorted[k - 1] + 1) {
          parts.push(start === sorted[k - 1] ? `${chain}${start}` : `${chain}${start}–${sorted[k - 1]}`);
          start = sorted[k];
        }
      }
    }
    const ligNames = [...new Set(ligandAtoms.map((i) => a.res_name[i]))];
    const ann = a.annotations ?? {};
    const hasCrd = (i: number): boolean => Array.isArray(ann.condition_coordinate_1_atom?.[i]) && Number.isFinite((ann.condition_coordinate_1_atom![i] as number[])[0]);
    const hotN = polymerAtoms.filter((i) => ann.condition_hotspot_1_atom?.[i]).length;

    // The pieces the selection touches: each keeps what the popup leaves as "mixed".
    const inSel = new Set(polymerAtoms);
    const hits: { c: ChainSpec; p: RunPiece; atoms: number[]; now: Properties }[] = [];
    for (const c of this._spec()?.chains ?? []) {
      for (const p of c.pieces ?? []) {
        if (p.kind === "new" || !p.atomIndices?.length) continue;
        const atoms = p.atomIndices.filter((i) => inSel.has(i));
        if (atoms.length) hits.push({ c, p, atoms, now: this._properties(p) });
      }
    }
    const common = (key: keyof Properties): string => {
      const v = new Set(hits.map((h) => h.now[key]));
      return v.size === 1 ? [...v][0] : "mixed";
    };
    const select = (label: string, options: Option[], value: string): HTMLSelectElement => {
      const s = el("select", { "aria-label": label });
      if (value === "mixed") s.append(el("option", { value: "mixed", text: "mixed", selected: true }));
      for (const [v, text] of options) s.append(el("option", { value: v, text, selected: v === value }));
      return s;
    };
    const row = (label: string, ...children: Child[]): HTMLElement => el("div", { class: "rfd4p-pop-row" }, el("span", { class: "rfd4p-pop-label", text: label }), ...children);
    const rows: HTMLElement[] = [];
    const more: (HTMLElement | null)[] = [];
    const title = [parts.join(", "), ligNames.join(", ")].filter(Boolean).join(" · ");
    // Its × closes it and lets go of the selection.
    const head = this._popHead(title || `${sel.length} atoms`, () => this.studio()?.setSelection?.([]),
      nRes ? `${nRes} residue${nRes === 1 ? "" : "s"}` : null);
    const done = (): void => { pop.hidden = true; };
    let apply: () => Promise<unknown> = async () => {};

    if (hits.length) {
      const structure = select("Structure", STRUCTURE_OPTIONS, common("structure"));
      const sequence = select("Sequence", SEQUENCE_OPTIONS, common("sequence"));
      const position = select("Position in chain", POSITION_OPTIONS, common("position"));
      // One stretch of one chain can become new residues of another length.
      const oneStretch = byChain.size === 1 && parts.length === 1;
      const lenMin = el("input", { type: "number", min: 1, max: 1000, value: nRes, "aria-label": "Fewest residues" });
      const lenMax = el("input", { type: "number", min: 1, max: 1000, value: nRes, "aria-label": "Most residues" });
      const positionRow = row("Position", position);
      const lengthRow = row("Length", el("span", { class: "rfd4p-pop-inline" }, lenMin, el("span", { text: "–" }), lenMax));
      const atomKey = (h: { now: Properties }): string => (h.now.atoms === "named" ? `named:${h.now.names}` : h.now.atoms);
      const atomKeys = new Set(hits.map(atomKey));
      const oneAtoms = atomKeys.size === 1 ? hits[0].now : null;
      const atomsField = this._atomsField(oneAtoms ? oneAtoms.atoms : "mixed", oneAtoms?.names ?? "");
      const atomsRow = row("Atoms", atomsField.select, atomsField.text);
      const sync = (): void => {
        const sidechain = atomsField.select.value === "sidechain" && structure.value !== "designed";
        if (sidechain) sequence.value = "fixed";
        sequence.disabled = sidechain;
        atomsRow.hidden = structure.value === "designed";
        const free = structure.value === "designed" && sequence.value === "designed";
        if (free && position.value !== "mixed") position.value = "fixed";
        positionRow.hidden = free;
        lengthRow.hidden = !free || !oneStretch;
      };
      structure.addEventListener("change", sync);
      sequence.addEventListener("change", sync);
      atomsField.select.addEventListener("change", sync);
      sync();
      const hot = el("input", { type: "checkbox", checked: hotN > 0 && hotN === polymerAtoms.length, "aria-label": "Hotspot" });
      hot.indeterminate = hotN > 0 && hotN < polymerAtoms.length;
      let hotTouched = false;
      hot.addEventListener("change", () => { hotTouched = true; });
      const same = (key: "ss" | "rasa" | "inter"): string | number => { const v = new Set(hits.map((h) => h.p[key] ?? (key === "inter" ? "" : 0))); return v.size === 1 ? [...v][0] : "mixed"; };
      const extra = this._extraFields({ ss: same("ss"), rasa: same("rasa"), inter: same("inter") as string });
      // A pick asks little at first: fixed or free, a hotspot, in or out; the finer settings are under More.
      rows.push(row("Structure", structure), row("Sequence", sequence), lengthRow,
        el("label", { class: "rfd4p-pop-row" }, el("span", { class: "rfd4p-pop-label", text: "Hotspot" }), hot));
      more.push(atomsRow, positionRow, ...extra.rows.filter(Boolean));
      apply = async () => {
        done();
        if (hotTouched && !await this._batch([{ condition: "hotspot", atom_indices: polymerAtoms, enabled: hot.checked }])) return;
        const which = atomsField.select.value === "mixed" ? "all" : atomsField.value();
        const extraEdits = extra.edits(polymerAtoms, this._interactionAtoms(polymerAtoms, which));
        if (extraEdits.length && !await this._batch(extraEdits)) return;
        if (!lengthRow.hidden) {
          const min = Math.max(1, Math.round(Number(lenMin.value)) || nRes);
          const max = Math.max(min, Math.round(Number(lenMax.value)) || nRes);
          if (min !== nRes || max !== nRes) {
            await this._mutate("/segments/replace", { atom_indices: polymerAtoms, minimum: min, maximum: max });
            return;
          }
        }
        const pick = (s: HTMLSelectElement, h: { now: Properties }, key: keyof Properties): string => (s.value === "mixed" ? h.now[key] : s.value);
        const changes: PieceChange[] = [];
        for (const h of hits) {
          const nowAtoms = h.now.atoms === "named" ? this._atomNames(h.now.names) : h.now.atoms;
          const want: Want = {
            structure: pick(structure, h, "structure"), sequence: pick(sequence, h, "sequence"), position: pick(position, h, "position"),
            atoms: atomsField.select.value === "mixed" ? nowAtoms : atomsField.value(),
          };
          if (want.atoms === "sidechain" && want.structure !== "designed") want.sequence = "fixed";
          if (want.structure === "designed" && want.sequence === "designed") want.position = "fixed";
          const sameAtoms = String(want.atoms) === String(nowAtoms) || want.structure === "designed";
          if (want.structure !== h.now.structure || want.sequence !== h.now.sequence || want.position !== h.now.position || !sameAtoms) {
            changes.push({ p: h.p, atoms: h.atoms, want });
          }
        }
        if (changes.length) await this._applyPieces(changes);
      };
    }
    if (ligandAtoms.length) {
      const nFixed = ligandAtoms.filter(hasCrd).length;
      const grp = a.annotations?.condition_CoordinateGroup_1_atom;
      const nRigid = ligandAtoms.filter((i) => Number(grp?.[i]) > 0).length;
      const nowPose = nRigid === ligandAtoms.length ? "rigid" : nFixed === ligandAtoms.length ? "fixed"
        : nFixed === 0 && nRigid === 0 ? "free" : "mixed";
      const pose = select("Structure", [["fixed", "fixed"], ["rigid", "rigid"], ["free", "free"]], nowPose);
      // Beside residues, the row names the ligand; alone, it is the ligand's Structure like any other.
      rows.push(row(!hits.length ? "Structure" : ligNames.length === 1 ? ligNames[0] : "Ligands", pose));
      const polymerApply = apply;
      apply = async () => {
        done();
        if (pose.value !== "mixed" && pose.value !== nowPose) {
          // Each ligand its own: a rigid one joins its own structure's body.
          const cur = this._inputDoc()!.atoms;
          for (const chain of new Set(ligandAtoms.map((i) => String(cur.chain_id[i])))) {
            const mine = ligandAtoms.filter((i) => String(cur.chain_id[i]) === chain);
            if (!await this._setLigandPose(chain, mine, pose.value)) return;
          }
        }
        await polymerApply();
      };
    }
    // Unticked, the selection leaves the job (nothing else is applied then).
    const include = el("input", { type: "checkbox", checked: true, "aria-label": "Include" });
    rows.push(el("label", { class: "rfd4p-pop-row", title: "Untick to take these out of the job" },
      el("span", { class: "rfd4p-pop-label", text: "Include" }), include));
    const applyEdits = apply;
    apply = async () => {
      if (include.checked) return applyEdits();
      done();
      return this._mutate("/delete", { atom_indices: residues });
    };
    pop.replaceChildren(...[head, ...rows, more.length ? this._moreFold(...more) : null, this._popActions(apply)].filter((n): n is HTMLElement | DocumentFragment => Boolean(n)));
    pop.hidden = false;
    // Next to the pointer that made the selection, kept on screen.
    const p = this.lastPointer ?? (() => {
      const r = document.getElementById("viewer")?.getBoundingClientRect();
      return r ? { x: r.left + r.width / 2 - 140, y: r.top + 16 } : { x: 200, y: 120 };
    })();
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    pop.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, p.x + 14))}px`;
    pop.style.top = `${Math.max(8, Math.min(window.innerHeight - h - 8, p.y + 14))}px`;
    this._placeMoved(pop);
  }

  // ---- set-ups (the start screen's "then", and the scaffold flow) ----------------------------------------------

  private async _runFlow(key: string, spec: DesignSpec, opts: {
    atoms?: number[]; ordered?: boolean; sidechainsOnly?: boolean; unindexed?: boolean; rebuild?: boolean; spread?: number;
    totalMin?: number; totalMax?: number;
  } = {}): Promise<void> {
    const polymers = spec.chains.filter((c) => c.residues > 0);
    const selection = opts.atoms ?? this.studio()?.getSelection?.() ?? [];
    // Each step must succeed before the next; a failure keeps the form open with its error shown.
    let ok = true;
    if (key === "scaffold") {
      if (!selection.length) return;
      if (opts.rebuild !== false) {
        ok = await this._mutate("/segments/scaffold", {
          atom_indices: selection, spread: opts.spread ?? 0.25, sidechains_only: Boolean(opts.sidechainsOnly),
          unindexed: Boolean(opts.unindexed), ordered: Boolean(opts.ordered),
          total_min: opts.unindexed ? opts.totalMin : null, total_max: opts.unindexed ? opts.totalMax : null,
        });
      } else {
        // In place: the rest of the selected chains is redesigned at its current length.
        const doc = this._inputDoc()!;
        const a = doc.atoms;
        const residues = doc.residueAtoms(selection);
        const backbone = new Set(["N", "CA", "C", "O", "OXT"]);
        const fixAtoms = opts.sidechainsOnly ? residues.filter((i) => !backbone.has(String(a.atom_name[i]))) : residues;
        const chainsOfSelection = new Set(residues.map((i) => String(a.chain_id[i])));
        const edits = polymers.filter((c) => chainsOfSelection.has(c.id)).flatMap((c) => this._roleEdits(c, "free"));
        if (fixAtoms.length) edits.push({ condition: "coordinate", atom_indices: fixAtoms, enabled: true });
        edits.push({ condition: "sequence", atom_indices: residues, enabled: true, scope: "residue" });
        ok = await this._batch(edits);
      }
    } else if (key === "sequence") {
      ok = await this._batch(polymers.flatMap((c) => this._roleEdits(c, "backbone")));
    }
    if (ok) this.host.setPartialDiffusion(false);
    this.render();
  }

  // ---- edits --------------------------------------------------------------------------------------------------

  private _roleEdits(c: ChainSpec, role: "fixed" | "sequence" | "backbone" | "free"): ConditionEdit[] {
    const all = c.polymerAtomIndices;
    if (!all.length) return [];
    if (role === "fixed") {
      return [
        { condition: "coordinate", atom_indices: all, enabled: true },
        { condition: "sequence", atom_indices: all, enabled: true },
      ];
    }
    if (role === "sequence") {
      return [
        { condition: "coordinate", atom_indices: all, enabled: false },
        { condition: "sequence", atom_indices: all, enabled: true },
      ];
    }
    if (role === "backbone") {
      return [
        { condition: "coordinate", atom_indices: all, enabled: false },
        ...(c.backboneAtomIndices.length
          ? [{ condition: "coordinate", atom_indices: c.backboneAtomIndices, enabled: true }] : []),
        { condition: "sequence", atom_indices: all, enabled: false },
      ];
    }
    return [
      { condition: "coordinate", atom_indices: all, enabled: false },
      { condition: "sequence", atom_indices: all, enabled: false },
    ];
  }

  private _batch(edits: ConditionEdit[]): Promise<boolean> {
    return edits.length ? this._mutate("/conditions/batch", { edits }) : Promise.resolve(true);
  }

  /** One edit through Studio's mutate path; resolves true on success. A failure stays shown until the next success. */
  async _mutate(path: string, body: Record<string, unknown>): Promise<boolean> {
    if ((!this.buildDoc && typeof this.studio()?.applyEdit !== "function") || this.busy) return false;
    // A document cannot be emptied ("cannot delete every atom"): removing the last of it means starting over.
    const total = this._inputDoc()?.nAtoms ?? 0;
    if (path === "/delete" && total && new Set(body.atom_indices as number[]).size >= total) {
      this.lastError = null;
      this.showStart = true;
      this.render();
      return false;
    }
    this.busy = true;
    this.els.design?.classList.add("rfd4p-busy");
    try {
      if (this.buildDoc) {
        // Straight to the session, so the viewer is not redrawn for every step of an example.
        await this.buildDoc.post(path, body);
        await this.buildDoc.refresh(true);
      } else {
        await this.studio()!.applyEdit(path, body);
        await this._inputDoc()?.refresh();
      }
      this.lastError = null;
      return true;
    } catch (err) {
      console.warn("Design edit failed:", err);
      this.lastError = `Edit failed: ${msg(err)}`;
      return false;
    } finally {
      this.busy = false;
      this.els.design?.classList.remove("rfd4p-busy");
      this.render();
    }
  }

  // ---- start screen -------------------------------------------------------------------------------------------

  private async _startTask(task: Task): Promise<void> {
    if (typeof this.studio()?.openExample !== "function" || this.building) return;
    const button = this.els.taskGrid?.querySelector(`[data-example="${task.example}"]`);
    button?.classList.add("loading");
    try {
      // An example with a recipe is built from its entries, or not opened at all (the page says why).
      if (task.recipe) { await this._buildRecipe(task); return; }
      await this.studio()!.openExample(task.example);
      this.showStart = false;
      await this.setInputSession(this.host.inputSessionId());
      if (task.then) {
        const spec = this._spec();
        if (spec) await this._runFlow(task.then, spec);
      }
    } finally {
      button?.classList.remove("loading");
      this.render();
    }
  }

  /** A new job from `make` (a session), opened in place of what was shown. */
  private async _startNew(make: () => Promise<SessionDoc>, { rethrow = false } = {}): Promise<void> {
    const status = this.els.fetchStatus;
    try {
      const doc = await make();
      this.host.setUndoFloor(doc.sid, doc.undoDepth);
      this.startLigandForm?.remove();
      this.startLigandForm = null;
      if (this.startStructure) this.startStructure.form.hidden = true;
      await this.studio()?.openSession(doc.sid);
      this.showStart = false;
      await this.setInputSession(this.host.inputSessionId() ?? doc.sid);
    } catch (err) {
      if (rethrow) throw err;
      if (status) status.textContent = msg(err);
    } finally {
      this.render();
    }
  }

  private async _fetchPdb(raw: string, status: HTMLElement = this.els.fetchStatus!): Promise<boolean | undefined> {
    const [id = "", ...chains] = String(raw ?? "").trim().toUpperCase().split(/[\s,;]+/).filter(Boolean);
    if (!/^[0-9][A-Z0-9]{3}$/.test(id)) {
      status.textContent = "Enter a 4-character PDB ID, e.g. 1QYS, optionally followed by chains: 1J79 A C E.";
      return;
    }
    status.textContent = `Downloading ${id} from RCSB…`;
    try {
      const res = await fetch(`https://files.rcsb.org/download/${id}.cif`);
      if (!res.ok) throw new Error(res.status === 404 ? `${id} was not found` : `RCSB returned ${res.status}`);
      const text = await res.text();
      this._rememberTitle(`PDB ${id}`, text);
      // Opened here rather than by Studio's file loader, so the chains named come from an assembly that has them.
      const { doc, raw: block } = await this._openEntry(text, id, chains);
      if (chains.length) {
        await this._keepNamed(doc, block, chains);
      }
      this.host.setUndoFloor(doc.sid, doc.undoDepth);
      await this.studio()?.openSession(doc.sid);
      status.textContent = "";
      this.showStart = false;
      await this.setInputSession(this.host.inputSessionId() ?? doc.sid);
      return true;
    } catch (err) {
      status.textContent = `Could not fetch ${id}: ${msg(err)}`;
      return false;
    } finally {
      this.render();
    }
  }

  // ---- examples, built from their PDB entries ----------------------------------------------------------------

  /**
   * Build `task` from its PDB entry with the card's own controls while the start screen stays up, then show it
   * finished (an example is a starting point: the card's Undo goes no further back than where it opened). Resolves
   * true once built; false if an entry could not be fetched or a step failed, and then nothing is shown but why.
   */
  private async _buildRecipe(task: Task): Promise<boolean> {
    const chainList = (): HTMLElement => this.els.chainList!;
    const card = (id: string): HTMLElement | undefined => [...chainList().querySelectorAll<HTMLElement>(".rfd4p-chain")]
      .find((c) => c.querySelector(".rfd4p-chain-id")?.textContent === id);
    const subs = (chain: string): HTMLElement[] => [...(card(chain)?.querySelectorAll<HTMLElement>(".rfd4p-sub") ?? [])];
    const isNew = (sub: Element): boolean => /\bnew$/.test(sub.querySelector(".rfd4p-sub-status")?.textContent ?? "");
    const idle = async (): Promise<void> => {
      await this.applying;
      this.applying = null;
      for (let i = 0; i < 600 && this.busy; i += 1) await sleep(50);
    };
    const open = (sub: HTMLElement): HTMLElement => { sub.querySelector<HTMLElement>(".rfd4p-sub-open")!.click(); return this.piecePop!; };
    const fill = (pop: HTMLElement, label: string, value: string | number, event = "input"): void => {
      const field = pop.querySelector<HTMLInputElement | HTMLSelectElement>(`[aria-label="${label}"]`);
      if (!field) return;
      field.value = String(value);
      field.dispatchEvent(new Event(event));
    };
    const apply = async (pop: HTMLElement): Promise<void> => {
      [...pop.querySelectorAll("button")].find((b) => b.textContent === "Apply")!.click();
      await idle();
      const note = pop.hidden ? "" : pop.querySelector(".rfd4p-pop-note")?.textContent;
      if (note) throw new Error(note);
    };
    const click = async (node: HTMLElement): Promise<void> => { node.click(); await idle(); };
    const begin = async (doc: SessionDoc): Promise<void> => {
      this.buildDoc = doc;
      this.render();
    };

    this.building = true;
    document.body.classList.add("rfd4p-building");
    let sessionToShow: SessionDoc | null = null;
    try {
      for (const step of task.recipe ?? []) {
        if (step.fetch) {
          const [id, ...chains] = step.fetch.split(/\s+/);
          let text: string;
          try {
            const res = await fetch(`https://files.rcsb.org/download/${id}.cif`);
            if (!res.ok) throw new Error(`RCSB returned ${res.status}`);
            text = await res.text();
          } catch (err) {
            this.els.fetchStatus!.textContent = `Could not fetch ${id}: ${msg(err)}`;
            return false;
          }
          this._rememberTitle(`PDB ${id}`, text);
          // As upstream's example was set up: its unresolved residues kept, unlike a structure someone loads.
          const { doc } = await this._openEntry(text, id, chains, { keepUnresolved: true });
          if (chains.length) {
            const drop: number[] = [];
            for (let i = 0; i < doc.nAtoms; i += 1) if (!chains.includes(String(doc.atoms.chain_id[i]))) drop.push(i);
            if (drop.length) { await doc.post("/delete", { atom_indices: drop }); await doc.refresh(true); }
          }
          sessionToShow = doc;
          await begin(doc);
        } else if (step.start) {
          // A bundled example as the starting point (Protein from scratch's 250 new residues): nothing to download.
          const text = await apiText(`/api/examples/${encodeURIComponent(step.start)}/cif`);
          const doc = new SessionDoc(await createSession(text, step.start));
          await doc.refresh();
          sessionToShow = doc;
          await begin(doc);
        } else if (step.blocks) {
          // One block per entry: "+" after the last block until there are enough, then each block's length and shape.
          const chainCard = (): HTMLElement => [...chainList().querySelectorAll<HTMLElement>(".rfd4p-chain")].at(-1)!;
          const blocksNow = (): HTMLElement[] => [...chainCard().querySelectorAll<HTMLElement>(".rfd4p-sub")].filter(isNew);
          for (let i = 0; i < 100 && blocksNow().length < step.blocks.length; i += 1) {
            await click([...chainCard().querySelectorAll<HTMLElement>(".rfd4p-slot")].at(-1)!);
          }
          const shapes = Object.fromEntries(SHAPE_OPTIONS.map(([v, text]) => [text.split(" ")[0], v]));
          for (let k = 0; k < step.blocks.length; k += 1) {
            const [len, shape] = step.blocks[k];
            const pop = open(blocksNow()[k]);
            fill(pop, "Fewest new residues", len);
            fill(pop, "Most new residues", len);
            fill(pop, "Shape", shapes[shape] ?? "0", "change");
            await apply(pop);
          }
        } else if (step.add) {
          const [id, ...chains] = step.add.split(/\s+/);
          const res = await fetch(`https://files.rcsb.org/download/${id}.cif`);
          if (!res.ok) throw new Error(`RCSB returned ${res.status} for ${id}`);
          const text = await res.text();
          this._rememberTitle(`PDB ${id}`, text);
          await this._addStructureFrom(text, id, chains, null);
          await idle();
        } else if (step.piece || step.removePiece) {
          const s = step.set ?? {};
          const chain = (step.piece ?? step.removePiece)!;
          const sub = subs(chain).find((x) => {
            const m = /(\d+)(?:–(\d+))?/.exec(x.querySelector(".rfd4p-sub-name")?.textContent ?? "");
            return !isNew(x) && m && step.at! >= Number(m[1]) && step.at! <= Number(m[2] ?? m[1]);
          });
          if (!sub) throw new Error(`chain ${chain} has no residue ${step.at}`);
          if (step.removePiece) {
            await click(sub.querySelector<HTMLElement>(".rfd4p-x")!);
            continue;
          }
          const pop = open(sub);
          if (s.from != null) fill(pop, "Residues", `${s.from}-${s.to}`);
          if (s.structure) fill(pop, "Structure", s.structure, "change");
          if (s.atoms) {
            const named = !ATOM_OPTIONS.some(([v]) => v === s.atoms);
            fill(pop, "Atoms", named ? "named" : s.atoms, "change");
            if (named) fill(pop, "Atom names", s.atoms);
          }
          if (s.sequence) fill(pop, "Sequence", s.sequence, "change");
          if (s.position) fill(pop, "Position in chain", s.position, "change");
          if (s.length) { fill(pop, "Fewest residues", s.length[0]); fill(pop, "Most residues", s.length[1]); }
          if (s.hotspots) fill(pop, "Hotspots", s.hotspots);
          if (s.keepOnly) fill(pop, "Keep only these residues", s.keepOnly);
          await apply(pop);
        } else if (step.pick) {
          // Residues picked, as in the viewer, and the pick's popup: part of a piece freed, or given a length.
          const [, chain, x, y] = /^(\w+?)(-?\d+)-(-?\d+)$/.exec(step.pick)!;
          const a = this._inputDoc()!.atoms;
          const atoms: number[] = [];
          for (let i = 0; i < a.nAtoms; i += 1) {
            if (String(a.chain_id[i]) === chain && a.res_id[i] >= Number(x) && a.res_id[i] <= Number(y) && !SENTINEL.test(String(a.res_name[i]))) atoms.push(i);
          }
          if (!atoms.length) throw new Error(`chain ${chain} has no residues ${x}–${y}`);
          this._renderPop(atoms);
          const pop = this.pop;
          const s = step.set ?? {};
          if (s.structure) fill(pop, "Structure", s.structure, "change");
          if (s.sequence) fill(pop, "Sequence", s.sequence, "change");
          if (s.length) { fill(pop, "Fewest residues", s.length[0]); fill(pop, "Most residues", s.length[1]); }
          await apply(pop);
        } else if (step.removeNew) {
          for (let sub = subs(step.removeNew).find(isNew); sub; sub = subs(step.removeNew).find(isNew)) {
            await click(sub.querySelector<HTMLElement>(".rfd4p-x")!);
          }
        } else if (step.addSeq) {
          await click(this.els.addSeq!);
        } else if (step.newLength) {
          const chains = step.chain ? [card(step.chain)] : [...chainList().querySelectorAll<HTMLElement>(".rfd4p-chain")].reverse();
          const sub = chains.flatMap((c) => [...(c?.querySelectorAll<HTMLElement>(".rfd4p-sub") ?? [])]).filter(isNew)[step.k ?? 0];
          if (!sub) throw new Error(`no new residues #${(step.k ?? 0) + 1} in chain ${step.chain ?? ""}`);
          const pop = open(sub);
          fill(pop, "Fewest new residues", step.newLength[0]);
          fill(pop, "Most new residues", step.newLength[1]);
          await apply(pop);
        } else if (step.ligand) {
          const sub = [...chainList().querySelectorAll<HTMLElement>(".rfd4p-sub")].find((x) => x.querySelector(".rfd4p-sub-name")?.textContent === step.ligand);
          if (!sub) throw new Error(`no ligand ${step.ligand}`);
          const pop = open(sub);
          fill(pop, "Structure", step.pose!, "change");
          if (step.atoms) { fill(pop, "Atoms", "named", "change"); fill(pop, "Atom names", step.atoms); }
          await apply(pop);
        } else if (step.chain && (step.name || step.order || step.fold)) {
          const chip = card(step.chain)?.querySelector<HTMLElement>(".rfd4p-chain-id");
          if (!chip) throw new Error(`no chain ${step.chain}`);
          chip.click();
          const pop = this.piecePop!;
          if (step.name) fill(pop, "Chain name", step.name);
          if (step.order) fill(pop, "Chain order", step.order - 1, "change");
          if (step.fold) fill(pop, "Fold", step.fold, "change");
          await apply(pop);
        } else if (step.partial) {
          const box = document.getElementById("partial-diffusion") as HTMLInputElement;
          box.checked = true;
          box.dispatchEvent(new Event("change"));
          await idle();
        }
      }
      // An example is a starting point: the card's Undo goes no further back than here. Studio shows it once, finished.
      const done = this.buildDoc!;
      this.host.setUndoFloor(done.sid, done.undoDepth);
      this.buildDoc = null;
      this.showStart = false;
      this.inputDoc = done;
      this.inputToken += 1;
      await this.studio()?.openSession(done.sid);
      await this.setInputSession(this.host.inputSessionId() ?? done.sid);
      return true;
    } catch (err) {
      // Nothing half built is shown: the start screen stays, saying what went wrong.
      console.warn("Example set-up stopped:", err);
      if (this.buildDoc) void deleteSession(this.buildDoc.sid);
      this.buildDoc = null;
      this.els.fetchStatus!.textContent = `The ${task.title} example could not be set up: ${msg(err)}`;
      return false;
    } finally {
      this.buildDoc = null;
      this.building = false;
      document.body.classList.remove("rfd4p-building");
      this._closePop();
      this.render();
    }
  }
}

// Kept for hosts that read the unused names.
export type { PlanPart };
void api;
