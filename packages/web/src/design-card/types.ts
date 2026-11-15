/**
 * Types of the Design card: the atom array it reads from a session's CIF, and (further down) the contract between
 * the card and whatever generates designs. The card speaks only Studio's REST API and `window.atomworksStudio`, so
 * nothing here depends on a design engine.
 */

/** One value of an annotation column: a number, a string, a flag, or a coordinate triple (NaN where not given). */
export type AnnotationCell = number | string | boolean | number[] | null | undefined;

/**
 * A structure as the card reads it from `GET /sessions/{sid}/cif` (see cif.ts): parallel arrays, one entry per atom,
 * in document order. `annotations` holds the `condition_*` and `annotation_*` columns by their AtomWorks names:
 * scalars as one value per atom, `condition_coordinate_1_atom`, `condition_InternalCoordinate_1_atom` and
 * `condition_ChainCentroid_1_atom` as `[x, y, z]` (NaN where not set), `condition_cath-label_1_residue` as a string
 * ("3.30.70.x", "" for none).
 */
export type AtomArray = {
  nAtoms: number;
  chain_id: string[];
  /** The label sequence id for polymer atoms, the author's number for ligands. */
  res_id: number[];
  /** The insertion code, "" for none. */
  ins_code: string[];
  /** The author's residue number (what the viewer names residues by). */
  auth_seq_id: number[];
  res_name: string[];
  atom_name: string[];
  element: string[];
  /** HETATM. Modified residues in a polymer are hetero too: use `is_polymer` to tell polymer residues apart. */
  hetero: boolean[];
  is_polymer: boolean[];
  /** Cartesian coordinates, NaN where the atom has none. */
  coord: number[][];
  annotations: Record<string, AnnotationCell[]>;
  /** The session's name, when known (an example's id, a PDB id). */
  name?: string;
};

// ---- The contract between the card and a host ----------------------------------------------------------------------
//
// The card owns everything a person sees and decides: the start screen and its examples, the job (chains, pieces,
// popups), the run settings, Generate and Stop, the status line, the Outputs tab with Studio's Refold panel, Save all,
// the Studio-editor switch and the theme. A host owns the engine: it supplies a `DesignCardProvider` that makes
// designs. The browser page runs RFD4-Proteina on WebGPU in it, a Gradio Space calls a GPU function on the server
// (docs/INTEGRATIONS.md, "Design card").

import type { DesignSpec } from "./spec.ts";
import type { RefoldColumnHeader, RefoldDesign, RefoldKind, RefoldProvider, RefoldRecord } from "../refold/types.ts";
import type { ViewerOverlayOptions, ViewerResidue } from "../viewers/contract.ts";

export type ThinkingLevel = "none" | "low" | "medium" | "high";

/** A numeric setting's range and where it starts. Anything left out keeps the reference page's value. */
export type SettingRange = { min?: number; max?: number; step?: number; default?: number };

/**
 * Which run settings the engine takes. Omit a key for the page's reference values, give an object to change its range
 * or default, give `false` when the engine does not take it: the control is then hidden (never silently changed) and
 * the setting is left out of `request.settings`.
 */
export type ProviderSettings = {
  /** How many designs one press of Generate makes. Reference: 1, from 1 to 8. */
  samples?: SettingRange | false;
  /** Extra recycling passes. Reference: none, low, medium, high; none by default. */
  thinking?: { options?: ThinkingLevel[]; default?: ThinkingLevel } | false;
  /** The seed, its dice, and "a new random seed is drawn after each run unless you type one". Reference: on. */
  seed?: boolean;
  /** Start from the input structure instead of noise. Reference: on, 40 %. */
  partialDiffusion?: { percent?: number } | false;
  /** Sampling temperature of the backbone (TSR K; lower is hotter). Reference: 1 to 20 step 0.1, 16. */
  backboneK?: SettingRange | false;
  /** Sampling temperature of the sequence latents. Reference: 1 to 6 step 0.1, 4. */
  latentK?: SettingRange | false;
  /** Stop once the structure and sequence stop changing. Reference: on, ticked. */
  earlyStop?: { default?: boolean } | false;
};

/** The settings as a run asks for them; a setting the engine does not take is absent. */
export type RunSettings = {
  samples?: number;
  thinking?: ThinkingLevel;
  /** The first design's seed; the next ones take the next integers. */
  seed?: number;
  /** The share of the way from the input structure to start (1..100), or null when off. Absent when not taken. */
  partialDiffusion?: number | null;
  backboneK?: number;
  latentK?: number;
  earlyStop?: boolean;
};

export type EngineInfo = {
  /** The badge beside the title ("WebGPU FP16"). */
  badge: string;
  /** The card's title; "RFD4-Proteina" by default. */
  title?: string;
  /** When set, Generate is off and this is the status line ("This browser has no WebGPU..."). */
  disabled?: string | null;
};

/** What a provider hands the card for a finished design. */
export type DesignInfo = {
  /** The row's label: the seed that makes it again ("163509"). The card adds " (2)" when a name repeats. */
  name: string;
  /** The design as mmCIF; the card opens it as a session of its own to show it. */
  cif: string;
  /** Every step of the run, as a multi-model mmCIF, for Studio's Show trajectory and the zip. */
  trajectoryCif?: string | null;
  /** The design as PDB, read for the summary's sequences in the zip. */
  pdb?: string | null;
  /** The download's file name without ".cif". */
  filenameStem?: string;
  /** Which pass criteria judge it in the Refold panel. */
  kind?: RefoldKind;
  seed?: number | null;
  stepsRun?: number | null;
  nsteps?: number | null;
  designedChains?: string[];
  /** Residues to colour amber while this design is shown. */
  hotspots?: ViewerResidue[];
  /** Display-only structures drawn beside this design while it is shown, by key (`setOverlay`). */
  overlays?: Record<string, DesignOverlay>;
  /** Whatever the provider wants back with the design (`RefoldDesign.data`, the zip's refold record); never read. */
  data?: unknown;
};

export type DesignOverlay = { cif: string | null; options?: ViewerOverlayOptions };

/** A design the card holds: what the provider gave, and where the card keeps it. */
export type DesignRecord = DesignInfo & {
  /** The id of the session that shows it (also the id of its Refold row). */
  id: string;
  /** Its name as the table shows it, with the repeat suffix. */
  label: string;
  /** 1 for the first design made on this input, counting on. */
  index: number;
};

export type FrameOptions = {
  /** The frame's name for the viewer ("step_3.cif"). */
  name?: string;
  /** Leave the camera where the person put it. */
  keepCamera?: boolean;
  /** Residues to colour amber from this design's first frame on (numbered as the frames are). */
  hotspots?: ViewerResidue[];
  overlays?: Record<string, DesignOverlay>;
};

export type GenerateHooks = {
  /** The status line under Generate. `visible: false` keeps the box closed (the button already says how far it is). */
  status(text: string, options?: { error?: boolean; visible?: boolean }): void;
  /** How far the run is (0..1): the Generate button, now Stop, fills up. `label` is what it says after "Stop · ". */
  progress(fraction: number, label?: string): void;
  /** What the engine is loading ("Downloading weights 40%"), or null when it is done. */
  loading(text: string | null): void;
  /** Draw a live frame in the viewer. Resolves once drawn; the card keeps frames in order. */
  frame(cif: string, options?: FrameOptions): Promise<void>;
  /** A design is finished: the card opens it, adds its row and hands it to the Refold panel. */
  design(design: DesignInfo): Promise<DesignRecord>;
};

export type GenerateRequest = {
  /** The Studio session of the input. */
  sessionId: string;
  /** The input as annotated mmCIF (`GET /sessions/{sid}/cif`), conditions included. */
  cif: string;
  /** The input's name and the number of its edits; designs of an unchanged input join the earlier ones. */
  name: string;
  revision: number;
  /** What the input asks for, as the card reads it (task, chains, lengths). */
  spec: DesignSpec;
  settings: RunSettings;
  /** Aborted when the person presses Stop. */
  signal: AbortSignal;
};

/** What `generate` may resolve with: the line the status box ends on. */
export type GenerateResult = { message?: string } | void;

export interface DesignCardProvider {
  engine: EngineInfo;
  settings?: ProviderSettings;
  /**
   * Make `request.settings.samples` designs of the input, reporting through `hooks`. Resolve when done; reject when it
   * fails (an error with a `userMessage` string says it in the person's words); reject (anything) when `signal`
   * aborts. Never called while another run is under way.
   */
  generate(request: GenerateRequest, hooks: GenerateHooks): Promise<GenerateResult>;
  /** Folds designs again; the card hosts Studio's Refold panel in its Outputs tab. Without it there is no Refold box. */
  refold?: RefoldProvider;
  /** The Refold panel's own options (column head, row names, terms storage); the card sets `onSelect`, `onDownload`. */
  refoldPanel?: { nameHeader?: RefoldColumnHeader; describe?: (design: RefoldDesign) => string; storage?: unknown };
  /** An engine-specific box beside Generate (the page's speed hint). Called once; may return a cleanup. */
  renderExtras?(container: HTMLElement): void | (() => void);
  /**
   * The Guide button, shown only when this exists: a function the host runs, or `{ url }` for the card's own popup
   * (the guide page at `url`, its `<main>` in a dialog over the designer; relative to the page the card is in).
   */
  guide?: (() => void | Promise<void>) | { url: string };
  /** Files added to "Save all (.zip)". */
  zipFiles?(context: { input: { cif: string; name: string; revision: number } | null; designs: DesignRecord[] }): { name: string; text: string }[];
  /** The zip's README title ("RFD4-Proteina (WebGPU) results"). */
  zipTitle?: string;
  /** The zip's refold record of one panel record, when the default (the record's own numbers and `cif`) is not it. */
  zipRefold?(record: RefoldRecord, design: DesignRecord): ZipRefold;
  /** Called when the job changed (a model may be got ready while the person reads); never for design views. */
  inputChanged?(spec: DesignSpec): void;
  /** Called once designs exist and the engine is idle, to get the refold model ready. */
  designsReady?(): void;
}

export type ZipRefold = {
  model: string; cif?: string | null; seed?: number | null; recycles?: number | null; steps?: number | null;
  rmsd?: number | null; confidence?: { meanPlddt?: number | null; ptm?: number | null; iptm?: number | null };
  metrics?: { placedRmsd?: number | null; chainPtm?: number | null; minIpae?: number | null; motifRmsd?: number | null; motifBackboneRmsd?: number | null };
  pass?: boolean | null; templated?: string[]; partial?: { chain: string; residues: number | string }[]; text?: string | null;
};

/** The pieces of Studio the card drives. By default `window.atomworksStudio`; a host with Studio in a frame passes its own. */
export type StudioHandle = {
  openSession(sessionId: string, options?: { trajectoryUrl?: string | null }): Promise<void>;
  openExample(id: string): Promise<void>;
  openFile?(file: File): Promise<boolean>;
  closeDocument?(): Promise<void>;
  applyEdit(path: string, body?: unknown): Promise<void>;
  renderFrame?(cif: string, name: string, options?: { keepCamera?: boolean }): Promise<void>;
  showDocument?(): Promise<void>;
  setOverlay?(key: string, cif: string | null, options?: ViewerOverlayOptions): Promise<void>;
  setHighlight?(key: string, residues: ViewerResidue[] | null, options?: { color?: number; transparency?: number }): Promise<void>;
  setLiveMode?(on: boolean): void;
  setSelection?(atomIndices: number[]): void;
  getSelection?(): number[];
  centerOn?(atomIndices: number[]): void;
  setTheme?(theme: "light" | "dark"): void;
  chainColor?(chainId: string): string;
  mountRefoldPanel?: typeof import("../refold/panel.ts").mountRefoldPanel;
  /** The session Studio shows, if the page can say; the card also follows `atomworks-studio` events. */
  getSessionId?(): string | null;
  undo?(): Promise<void>;
};

export type DesignCardOptions = {
  /**
   * `"sidebar"` (the default when `container` is null): the card goes into Studio's right sidebar, its title row into
   * Studio's header, and Studio's own panels fold away unless "Studio editor" is ticked. `"inline"`: the card is a
   * block in `container` and leaves the rest of the page alone.
   */
  mode?: "sidebar" | "inline";
  /** Studio, when it is not `window.atomworksStudio` (a Studio in an iframe, a test double). */
  studio?: StudioHandle;
  /** Initial theme; otherwise the person's last choice (`themeKey`), else the computer's. */
  theme?: "light" | "dark";
  /** localStorage key that remembers the theme. Default "rfd4p.theme". */
  themeKey?: string;
  /** The examples on the start screen; by default Studio's ten (`TASKS`). */
  examples?: import("./tasks.ts").Task[];
  /** Show the "Studio editor" switch (default true). */
  studioEditor?: boolean;
  /** Hide the Examples box. */
  noExamples?: boolean;
  /** The page's address, written into the zip's README. */
  page?: string;
};

export type DesignCardEvent =
  | { type: "input"; sessionId: string | null }
  | { type: "designs"; designs: DesignRecord[] }
  | { type: "run"; running: boolean }
  | { type: "settings"; settings: RunSettings }
  | { type: "theme"; theme: "light" | "dark" };

export type DesignCardHandle = {
  readonly element: HTMLElement;
  /** Studio's Refold panel inside the card (null when the provider has no `refold`). */
  readonly refold: import("../refold/panel.ts").RefoldPanelHandle | null;
  /** Change what the card says about the engine ("WebGL2", or "No WebGPU" with `disabled`). */
  setEngine(engine: Partial<EngineInfo>): void;
  setTheme(theme: "light" | "dark"): void;
  theme(): "light" | "dark";
  /** The designs of the runs on the current input, in table order. */
  designs(): DesignRecord[];
  /** The run settings as set now. */
  settings(): RunSettings;
  /** The Studio session of the input, if one is open. */
  inputSessionId(): string | null;
  /** What the job asks for, read from the open input; null with nothing open. */
  spec(): DesignSpec | null;
  /** Press Generate (or Stop, while a run goes). */
  generate(): Promise<void>;
  stop(): void;
  /** "Save all (.zip)" without the click: the file's bytes and name. */
  zip(): { name: string; bytes: Uint8Array } | null;
  /** Say something in the status box. */
  setStatus(text: string, options?: { error?: boolean; visible?: boolean }): void;
  onChange(listener: (event: DesignCardEvent) => void): () => void;
  destroy(): void;
};
