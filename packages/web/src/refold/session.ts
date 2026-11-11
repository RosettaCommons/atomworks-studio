/**
 * What the Refold panel decides, with no DOM: the settings, which designs still need folding with them, the queue,
 * Stop, the terms gate, the weights prefetch and the line that reports progress. `panel.ts` draws it; the tests in
 * tests/refold-session.test.ts run it against a fake provider.
 */
import { finiteMetric, passes } from "./criteria.ts";
import { resolveModel } from "./presets.ts";
import type {
  RefoldDesign, RefoldLimits, RefoldModel, RefoldProvider, RefoldRecord, RefoldSettings, RefoldStatus,
} from "./types.ts";

/** The choices and defaults the panel offers when a provider names none: the reference page's. */
export const DEFAULT_LIMITS = {
  seed: { min: 0, max: 4294967295, default: 0, title: "Another seed samples the fold again" },
  recycles: {
    options: [0, 1, 2, 3, 5, 10], default: 3,
    title: "Trunk recycling passes: more is slower, sometimes more confident",
  },
  steps: {
    options: [25, 50, 100, 200], default: 25,
    title: "Diffusion steps of the structure module: 25 is LocalFold's default, 200 AlphaFold 3's own",
  },
};

export type ResolvedLimits = {
  seed: { min: number; max: number; default: number; title: string };
  recycles: { options: number[]; default: number; title: string };
  steps: { options: number[]; default: number; title: string };
  model: { default: string | null };
};

export function resolveLimits(limits: RefoldLimits | undefined): ResolvedLimits {
  const d = DEFAULT_LIMITS;
  const options = (given: number[] | undefined, fallback: number[]): number[] =>
    given?.length ? [...given] : [...fallback];
  const recycles = options(limits?.recycles?.options, d.recycles.options);
  const steps = options(limits?.steps?.options, d.steps.options);
  const pick = (value: number | undefined, choices: number[], fallback: number): number =>
    value != null && choices.includes(value) ? value : (choices.includes(fallback) ? fallback : choices[0]);
  return {
    seed: {
      min: limits?.seed?.min ?? d.seed.min,
      max: limits?.seed?.max ?? d.seed.max,
      default: limits?.seed?.default ?? d.seed.default,
      title: d.seed.title,
    },
    recycles: { options: recycles, default: pick(limits?.recycles?.default, recycles, d.recycles.default),
      title: limits?.recycles?.title ?? d.recycles.title },
    steps: { options: steps, default: pick(limits?.steps?.default, steps, d.steps.default),
      title: limits?.steps?.title ?? d.steps.title },
    model: { default: limits?.model?.default ?? null },
  };
}

export type TermsAnswer = "accept" | "switch" | "cancel";

/** Where the per-browser agreement is kept; localStorage unless a host or a test supplies another. */
export interface RefoldStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export const browserStorage: RefoldStorage = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* asked again next time */ } },
};

export type SessionOptions = {
  provider: RefoldProvider;
  storage?: RefoldStorage;
  /** Ask the person about a model's terms: resolves with what they chose. */
  askTerms: (model: RefoldModel) => Promise<TermsAnswer>;
  /**
   * Show a design (select it, navigate the host's viewer to it, draw its refold). Called after a design is
   * refolded, and when a run finds every design already refolded with the settings.
   */
  reveal: (id: string) => Promise<void> | void;
  /** How a design reads in the progress line ("seed 163509"); its name by default. */
  describe?: (design: RefoldDesign) => string;
  /** How long "All refolded with these settings" stays on the idle button, ms. */
  noteMs?: number;
};

type DesignState = { design: RefoldDesign; records: RefoldRecord[]; shown: RefoldRecord | null; failed: boolean };

type Running = {
  abort: AbortController;
  queue: string[];
  current: string | null;
  label: string | null;
  fraction: number | null;
};

type Prefetch = { model: string; name: string; loadedBytes: number; totalBytes: number; done: boolean };

const mb = (bytes: number): string => (bytes / 1e6).toFixed(0);

export class RefoldSession {
  readonly provider: RefoldProvider;
  readonly models: RefoldModel[];
  readonly limits: ResolvedLimits;
  settings: RefoldSettings;
  selectedId: string | null = null;

  private readonly options: SessionOptions;
  private readonly storage: RefoldStorage;
  private readonly designs = new Map<string, DesignState>();
  private running: Running | null = null;
  private note: string | null = null;
  private noteTimer: ReturnType<typeof setTimeout> | undefined;
  private statusText: string | null = null;
  private statusIsError = false;
  private prefetchState: Prefetch | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(options: SessionOptions) {
    this.options = options;
    this.provider = options.provider;
    this.storage = options.storage ?? browserStorage;
    this.models = options.provider.models.map(resolveModel);
    if (!this.models.length) throw new Error("A refold provider needs at least one model");
    this.limits = resolveLimits(options.provider.limits);
    const wanted = this.limits.model.default;
    const model = this.models.find((m) => m.id === wanted)?.id ?? this.models[0].id;
    this.settings = {
      model, seed: this.limits.seed.default, recycles: this.limits.recycles.default, steps: this.limits.steps.default,
    };
  }

  /** A design as the progress line and the buttons' labels name it. */
  describe(design: RefoldDesign): string {
    return this.options.describe ? this.options.describe(design) : design.name;
  }

  // --- Observers -----------------------------------------------------------------------------------------------

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  // --- What is on offer ----------------------------------------------------------------------------------------

  available(): boolean {
    return this.provider.available ? this.provider.available() : true;
  }

  modelLabel(id: string): string {
    return this.models.find((m) => m.id === id)?.label ?? id;
  }

  get isRunning(): boolean {
    return this.running !== null;
  }

  get runningId(): string | null {
    return this.running?.current ?? null;
  }

  isQueued(id: string): boolean {
    return this.running?.queue.includes(id) ?? false;
  }

  /** The Designs table's rows, in the host's order. */
  list(): DesignState[] {
    return [...this.designs.values()];
  }

  design(id: string): RefoldDesign | undefined {
    return this.designs.get(id)?.design;
  }

  hasDesigns(): boolean {
    return this.designs.size > 0;
  }

  /** Every refold made of a design, oldest first: what "Save all" keeps. */
  records(id: string): RefoldRecord[] {
    return [...(this.designs.get(id)?.records ?? [])];
  }

  shown(id: string): RefoldRecord | null {
    return this.designs.get(id)?.shown ?? null;
  }

  failed(id: string): boolean {
    return this.designs.get(id)?.failed ?? false;
  }

  /** A design's refold made with exactly `settings` (the latest such), if there is one. */
  recordWith(id: string, settings: RefoldSettings = this.settings): RefoldRecord | null {
    const records = this.designs.get(id)?.records ?? [];
    for (let i = records.length - 1; i >= 0; i -= 1) {
      const r = records[i];
      if (r.model === settings.model && r.seed === settings.seed && r.recycles === settings.recycles && r.steps === settings.steps) return r;
    }
    return null;
  }

  /** The designs Refold all would fold: those with no refold made with the settings now in the box. */
  pending(): string[] {
    return this.list().filter(({ design }) => !this.recordWith(design.id)).map(({ design }) => design.id);
  }

  // --- Designs -------------------------------------------------------------------------------------------------

  /**
   * The designs on offer, in table order. A design that stays keeps its refolds; one that goes loses them. The
   * refold shown for each is the one made with the settings now in the box, if there is one.
   */
  setDesigns(designs: RefoldDesign[]): void {
    const previous = new Map(this.designs);
    this.designs.clear();
    for (const design of designs) {
      const state = previous.get(design.id) ?? { design, records: [], shown: null, failed: false };
      state.design = design;
      this.designs.set(design.id, state);
    }
    for (const state of this.designs.values()) {
      const kept = this.recordWith(state.design.id);
      if (kept) state.shown = kept;
    }
    this.emit();
  }

  /** Make the refold the settings call for the one shown, for every design that has one. Returns the ids that changed. */
  showMatching(): string[] {
    const changed: string[] = [];
    for (const state of this.designs.values()) {
      const kept = this.recordWith(state.design.id);
      if (kept && state.shown !== kept) { state.shown = kept; changed.push(state.design.id); }
    }
    return changed;
  }

  // --- Settings ------------------------------------------------------------------------------------------------

  /** Set some of the settings, each cleaned to what the box would accept; returns the ids whose shown refold changed. */
  setSettings(partial: Partial<RefoldSettings>): string[] {
    const next = { ...this.settings, ...partial };
    const known = this.models.some((m) => m.id === next.model);
    this.settings = {
      model: known ? next.model : this.settings.model,
      seed: this.clampSeed(next.seed),
      recycles: this.nearest(next.recycles, this.limits.recycles.options, this.limits.recycles.default),
      steps: this.nearest(next.steps, this.limits.steps.options, this.limits.steps.default),
    };
    const changed = this.showMatching();
    this.emit();
    return changed;
  }

  private clampSeed(value: number): number {
    const n = Number.isFinite(value) ? Math.trunc(value) : this.limits.seed.default;
    return Math.min(this.limits.seed.max, Math.max(this.limits.seed.min, n));
  }

  private nearest(value: number, options: number[], fallback: number): number {
    return options.includes(value) ? value : fallback;
  }

  // --- Terms ---------------------------------------------------------------------------------------------------

  termsAccepted(model: RefoldModel | string): boolean {
    const m = typeof model === "string" ? this.models.find((x) => x.id === model) : model;
    if (!m?.terms) return true;
    return this.storage.get(m.terms.storageKey) === "accepted";
  }

  /** The model to fold with once its terms are settled: the same model, the one the dialog switched to, or null to cancel. */
  async settleTerms(id: string): Promise<string | null> {
    const model = this.models.find((m) => m.id === id);
    if (!model?.terms || this.termsAccepted(model)) return id;
    const answer = await this.options.askTerms(model);
    if (answer === "accept") {
      this.storage.set(model.terms.storageKey, "accepted");
      return id;
    }
    if (answer === "switch" && model.terms.switchTo) {
      const target = this.models.find((m) => m.id === model.terms?.switchTo?.model);
      if (target) {
        this.settings = { ...this.settings, model: target.id };
        this.showMatching();
        this.emit();
        return target.id;
      }
    }
    return null;
  }

  // --- Progress line -------------------------------------------------------------------------------------------

  /** What the button says and how full it is: Stop with the run's progress, the weights coming down, or Refold all. */
  button(): { label: string; fraction: number | null; disabled: boolean; title: string } {
    const prefetch = this.prefetchState;
    const fetching = prefetch && !prefetch.done && prefetch.totalBytes ? prefetch : null;
    let label = this.running ? "Stop" : (this.note ?? "Refold all");
    let fraction: number | null = null;
    if (this.running && this.running.label) {
      label = `Stop · ${this.running.label}`;
      fraction = this.running.fraction ?? 0;
    } else if (fetching) {
      label = `${label} · ${fetching.name} ${mb(fetching.loadedBytes)} / ${mb(fetching.totalBytes)} MB`;
      fraction = fetching.loadedBytes / fetching.totalBytes;
    }
    // Only when there is something to fold: every design refolded with these settings leaves it off.
    const nothing = !this.running && this.pending().length === 0;
    const title = fetching && !this.running
      ? `Downloading ${fetching.name} parameters: first time only, kept for next time`
      : nothing ? "Every design is refolded with these settings" : "Refold every design not yet refolded with these settings";
    return { label, fraction, disabled: nothing, title };
  }

  /** A failure's line, or null. */
  errorLine(): string | null {
    return this.statusIsError ? this.statusText : null;
  }

  private setStatus(text: string | null, isError = false, progress: { label?: string | null; fraction?: number | null } = {}): void {
    this.statusText = text;
    this.statusIsError = isError;
    if (this.running) {
      this.running.label = progress.label ?? null;
      this.running.fraction = progress.fraction ?? null;
    }
    this.emit();
  }

  private flashNote(text: string): void {
    this.note = text;
    this.emit();
    clearTimeout(this.noteTimer);
    this.noteTimer = setTimeout(() => { this.note = null; this.emit(); }, this.options.noteMs ?? 2500);
  }

  // --- Prefetch ------------------------------------------------------------------------------------------------

  /**
   * Get the selected model ready ahead of the click and say so on the button. A licence-gated model is not touched
   * until its terms are agreed to: fetching in the background first would take that decision away.
   */
  prefetch(): void {
    const id = this.settings.model;
    if (!this.provider.prepare || !this.available() || this.running) return;
    if (!this.termsAccepted(id)) return;
    if (this.prefetchState?.model === id) return;
    const state: Prefetch = { model: id, name: this.modelLabel(id), loadedBytes: 0, totalBytes: 0, done: false };
    this.prefetchState = state;
    void (async () => {
      try {
        await this.provider.prepare?.(id, (p) => {
          state.loadedBytes = p.loadedBytes ?? 0;
          state.totalBytes = p.totalBytes ?? 0;
          this.emit();
        });
      } catch {
        // A failed prefetch costs nothing: the refold itself will try again and report properly.
        if (this.prefetchState === state) this.prefetchState = null;
      } finally {
        state.done = true;
        this.emit();
      }
    })();
  }

  // --- Running -------------------------------------------------------------------------------------------------

  /** Stop the refolds that are running. */
  stop(): void {
    this.running?.abort.abort();
  }

  /**
   * Refold designs one after another with the chosen model: `ids`, or every design not yet refolded with these
   * settings. Pressed again while refolds run, it stops them. Resolves when the run ends, however it ends.
   */
  async run(ids: string[] | null): Promise<void> {
    if (this.running) {
      this.running.abort.abort();
      return;
    }
    const model = await this.settleTerms(this.settings.model);
    if (!model) return;
    const settings: RefoldSettings = { ...this.settings, model };
    const name = this.modelLabel(model);
    const all = this.list().map(({ design }) => design.id);
    // A design refolded before with these settings is not folded again: that refold is shown (its numbers back in
    // the table), and every other refold of it is kept for the zip.
    const asked = (ids ?? all).filter((id) => this.designs.has(id));
    const todo: string[] = [];
    let shown: string | null = null;
    for (const id of asked) {
      const state = this.designs.get(id) as DesignState;
      const kept = this.recordWith(id, settings);
      if (!kept) todo.push(id);
      else if (state.shown !== kept) { state.shown = kept; shown = id; }
    }
    if (!todo.length) {
      this.setStatus(null);
      const target = ids ? ids[0] : shown;
      if (target && (shown || this.selectedId !== target)) await this.options.reveal(target);
      this.flashNote(ids ? "Already refolded with these settings" : "All refolded with these settings");
      return;
    }
    const abort = new AbortController();
    const running: Running = { abort, queue: [...todo], current: null, label: null, fraction: null };
    this.running = running;
    this.emit();
    let done = 0;
    let failed = 0;
    try {
      // Ask for the parameters here, not inside the refold, so the wait is visible and reports.
      await this.provider.prepare?.(model, (progress) => {
        const loaded = progress.loadedBytes ?? 0;
        const total = progress.totalBytes ?? 0;
        if (!total) return;
        this.setStatus(null, false, { label: `${name} ${mb(loaded)} / ${mb(total)} MB`, fraction: loaded / total });
      }, abort.signal);
      for (let k = 0; k < todo.length && !abort.signal.aborted; k += 1) {
        const id = todo[k];
        const state = this.designs.get(id);
        if (!state) continue;
        running.queue = todo.slice(k + 1);
        running.current = id;
        this.emit();
        const tag = todo.length > 1 ? ` (${k + 1} of ${todo.length})` : "";
        const what = `${this.describe(state.design)}${tag}`;
        this.setStatus(null, false, { label: what, fraction: k / todo.length });
        const ok = await this.foldOne(state, settings, abort, (status) => {
          const fraction = status.fraction == null ? 0 : Math.min(1, Math.max(0, status.fraction));
          const pct = status.fraction == null ? "" : ` · ${Math.round(fraction * 100)}%`;
          this.setStatus(null, false, { label: `${what}${pct}`, fraction: (k + fraction) / todo.length });
        });
        if (ok) done += 1;
        else if (!abort.signal.aborted) failed += 1;
      }
      const stopped = abort.signal.aborted ? " Stopped." : "";
      this.setStatus(failed ? `Refolded ${done} design${done === 1 ? "" : "s"} with ${name}; ${failed} failed.${stopped}` : null,
        failed > 0);
    } catch (error) {
      if (!abort.signal.aborted) console.error("Refold failed:", error);
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus(abort.signal.aborted ? null : `Refold failed: ${message}`, !abort.signal.aborted);
    } finally {
      if (this.running === running) this.running = null;
      this.emit();
    }
  }

  /** One design's refold: scored, kept, shown. False if it failed. */
  private async foldOne(
    state: DesignState, settings: RefoldSettings, abort: AbortController, report: (status: RefoldStatus) => void,
  ): Promise<boolean> {
    const { design } = state;
    const name = this.modelLabel(settings.model);
    try {
      const result = await this.provider.refold(design, settings, {
        signal: abort.signal,
        onStatus: (status) => {
          const next = typeof status === "string" ? { text: status } : status;
          report({ text: next.text || `refolding with ${name}`, fraction: next.fraction ?? percentIn(next.text) });
        },
      });
      if (abort.signal.aborted) return false;
      const record: RefoldRecord = {
        ...settings, ...result,
        pass: typeof result.pass === "boolean" ? result.pass : passes(result.metrics, design.kind),
        modelLabel: name,
      };
      state.records.push(record);
      state.failed = false;
      state.shown = record;
      this.emit();
      await this.options.reveal(design.id);
      return true;
    } catch (error) {
      if (abort.signal.aborted) return false;
      state.failed = true;
      console.error(`Refold of ${design.name} failed:`, error);
      return false;
    }
  }

  /** The number a design is sorted by in a column, from its shown refold. */
  metric(id: string, key: string): number | null {
    return finiteMetric(this.designs.get(id)?.shown?.metrics, key);
  }
}

/** A status string's trailing "40%": the page's LocalFold reports "phase · 40%". */
function percentIn(text: string | undefined): number | null {
  const match = text ? /(\d+)%/.exec(text) : null;
  return match ? Math.min(1, Number(match[1]) / 100) : null;
}
