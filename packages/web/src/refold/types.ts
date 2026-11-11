/**
 * The contract between Studio's Refold panel and whatever folds the structures.
 *
 * The panel owns everything a person sees and decides: the model, seed, recycles and steps controls, the terms
 * dialog a licence-gated model asks for, "Refold all" and Stop, the progress line, one row of numbers per design, and
 * the refold drawn over the design. A host owns the folding. It supplies a `RefoldProvider`: the browser page runs
 * LocalFold's WebGPU model in it, a Gradio Space calls a GPU function on the server (docs/INTEGRATIONS.md,
 * "Refold panel").
 */

/** One link in a model's terms dialog. */
export type RefoldTermsLink = { label: string; href: string };

/**
 * What a licence-gated model asks of the person before it is used, shown once per browser (`storageKey`). Choosing the
 * model without having agreed opens the dialog; "I agree" remembers it and goes on, `switchTo` offers another model
 * as the way past instead of only through, Cancel leaves everything as it was.
 */
export type RefoldTerms = {
  title: string;
  /** Paragraphs, plain text except for `**bold**` runs. */
  paragraphs: string[];
  links: RefoldTermsLink[];
  /** localStorage key that remembers agreement in this browser. */
  storageKey: string;
  /** The model id the dialog's first button switches to, and what it says ("Use OpenBind-0"). */
  switchTo?: { model: string; label: string };
  /** What the agree button says ("I agree, use AlphaFold 3"). */
  agreeLabel: string;
};

export type RefoldModel = {
  id: string;
  label: string;
  /** Present when the model's parameters carry terms that must be agreed to first. */
  terms?: RefoldTerms;
};

/** A model as a provider names it: an id alone (or with a `terms` preset name) is completed from Studio's presets. */
export type RefoldModelInput = Partial<Omit<RefoldModel, "terms">> & { id: string; terms?: RefoldTerms | string | null };

export type RefoldSettings = {
  model: string;
  /** The seed samples the fold again: 0..4294967295. */
  seed: number;
  /** Trunk recycling passes. */
  recycles: number;
  /** Diffusion steps of the structure module. */
  steps: number;
};

/** The choices each setting offers, and where it starts. Anything left out keeps the page's reference values. */
export type RefoldLimits = {
  seed?: { min?: number; max?: number; default?: number };
  recycles?: { options?: number[]; default?: number; title?: string };
  steps?: { options?: number[]; default?: number; title?: string };
  model?: { default?: string };
};

/** What a refold reports, by the names upstream's pass criteria use. A number that does not apply is left out or NaN. */
export type RefoldMetrics = {
  /** The designed chains' shape fitted on themselves, Å. */
  rmsd?: number | null;
  /** The designed chains after fitting on everything else, so where a binder sits counts, Å. */
  placedRmsd?: number | null;
  /** The refold model's confidence: pLDDT 0-100. */
  plddt?: number | null;
  ptm?: number | null;
  iptm?: number | null;
  /** The designed chain's own pTM, the lowest when several were designed. */
  chainPtm?: number | null;
  /** The lowest predicted aligned error between a designed residue and any other chain's, Å. */
  minIpae?: number | null;
  [other: string]: number | null | undefined;
};

/** Which of upstream's pass criteria judge a design (`criteria.ts`). `null` shows numbers and no verdict. */
export type RefoldKind = "monomer" | "binder" | "antibody" | null;

/** A design the panel can refold. Everything a provider needs beyond these fields travels in `data`, untouched. */
export type RefoldDesign = {
  /** Unique among the panel's designs; the host's own key for it (a session id). */
  id: string;
  /** The row's label ("163509"). */
  name: string;
  /** The structure, for the row's download button and for a provider that folds from it. */
  cif?: string;
  /** The file name the download gets, without ".cif". */
  filenameStem?: string;
  kind?: RefoldKind;
  /** Whatever the provider wants back with the design. The panel never reads it. */
  data?: unknown;
};

/** What a provider returns for one design. */
export type RefoldResult = {
  /** The refold's polymer chains, in the design's frame, drawn as a cartoon over the design. */
  cif: string | null;
  /** Its ligands, where the refold put them: drawn as sticks beside the cartoon. */
  ligandCif?: string | null;
  metrics: RefoldMetrics;
  /** One line describing the result, kept with the record ("AlphaFold 3 refold: 1.2 Å RMSD · pLDDT 91"). */
  text?: string;
  /** A verdict the provider already reached. Otherwise the panel judges `metrics` by the design's `kind`. */
  pass?: boolean | null;
  /** The provider's own extras (the refolded PDB, a confidence file), kept on the record and handed back untouched. */
  data?: unknown;
};

/** What the progress line says: a phrase, and how far along (0..1) when that is known. */
export type RefoldStatus = { text: string; fraction?: number | null };

export type RefoldContext = {
  /** Aborted when the person presses Stop; stop and reject as soon as it can. */
  signal: AbortSignal;
  /** Say what the fold is doing: shown on the button, which fills as `fraction` does. */
  onStatus: (status: RefoldStatus | string) => void;
};

/** A parameters download, for `prepare`: the button fills with it and says where it is. */
export type RefoldPrepareProgress = { loadedBytes: number; totalBytes: number };

export interface RefoldProvider {
  /** The models on offer, in menu order. The first listed without `limits.model.default` is selected. */
  models: RefoldModelInput[];
  limits?: RefoldLimits;
  /**
   * Fold one design. Resolve with the result, reject on failure; reject (any error) when `signal` aborts. Designs are
   * folded one after another, never two at once.
   */
  refold(design: RefoldDesign, settings: RefoldSettings, context: RefoldContext): Promise<RefoldResult>;
  /**
   * Get ready for a model ahead of the click (download its parameters, say), reporting as it goes. Called when a
   * model is chosen and again before a run; the panel never calls it for a licence-gated model whose terms were not
   * agreed to, so nothing is fetched on the person's behalf before they decide.
   */
  prepare?(model: string, onProgress: (progress: RefoldPrepareProgress) => void, signal?: AbortSignal): Promise<void>;
  /** False when this browser or server cannot refold: the Refold box and each row's refold button stay away. */
  available?(): boolean;
}

/** A refold kept for a design, with the settings it was made with. */
export type RefoldRecord = RefoldSettings & RefoldResult & {
  /** The verdict: true, false, or null with no criteria or a missing number. */
  pass: boolean | null;
  /** The model's label, for the overlay and the summary. */
  modelLabel: string;
};

/** A design's name for the table's head cell. */
export type RefoldColumnHeader = { label: string; title?: string };
