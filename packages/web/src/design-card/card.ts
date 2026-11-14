/**
 * The Design card: the RFD4-Proteina page's whole design UI as one component Studio owns. It draws the start screen
 * and the job editor (`panel.ts`), the run settings, Generate and Stop, the status line, the Outputs tab with Studio's
 * Refold panel, "Save all (.zip)", the Studio-editor switch and the theme. It knows nothing of how designs are made:
 * a host supplies a `DesignCardProvider` (types.ts) and the card talks only to Studio's REST API and
 * `window.atomworksStudio`. See docs/INTEGRATIONS.md, "Design card".
 */
import { apiText } from "../api.ts";
import { mountRefoldPanel } from "../refold/panel.ts";
import { frameHotspots, frameResidues, designHotspots, LiveSequenceStrip, runContext, type RunContext } from "./run-context.ts";
import type { RefoldPanelHandle, RefoldPanelOptions } from "../refold/panel.ts";
import type { RefoldDesign, RefoldRecord } from "../refold/types.ts";
import type { ViewerResidue } from "../viewers/contract.ts";
import cardCss from "./card.css?inline";
import cardModeCss from "./card-mode.css?inline";
import { SessionDoc, createSession, deleteSession } from "./doc.ts";
import { cardMarkup } from "./markup.ts";
import { createGuide, guideUrl } from "./guide.ts";
import { DesignPanel } from "./panel.ts";
import type { PanelHost } from "./panel.ts";
import { DEFAULT_RESULTS_MODELS, resultsFiles } from "./results.ts";
import type { ResultsDesign, ResultsRefold } from "./results.ts";
import type { DesignSpec } from "./spec.ts";
import { TASKS } from "./tasks.ts";
import type {
  DesignCardEvent, DesignCardHandle, DesignCardOptions, DesignCardProvider, DesignInfo, DesignOverlay, DesignRecord,
  EngineInfo, FrameOptions, GenerateHooks, ProviderSettings, RunSettings, SettingRange, StudioHandle, ThinkingLevel,
} from "./types.ts";
import { zipStore } from "./zip.ts";

const STYLE_ID = "atomworks-design-card-style";
const MODE_STYLE_ID = "atomworks-design-card-mode-style";
const THINKING_DEFAULT: ThinkingLevel[] = ["none", "low", "medium", "high"];
const NO_ENGINE_MESSAGE = "No design engine is connected to this page. You can still open and edit structures here.";

/** What one design is, as the card keeps it (the page's `generatedViews` entry). */
type View = {
  label: string;
  cif: string;
  pdb?: string | null;
  isInput: boolean;
  name?: string | null;
  revision?: number;
  filenameStem?: string;
  record?: DesignRecord;
  trajectoryUrl?: string | null;
  overlays?: Record<string, DesignOverlay>;
};

type Run = { designs: string[]; inputRevision: number };

const h = <K extends keyof HTMLElementTagNameMap>(
  tag: K, attrs: Record<string, string | boolean | null | undefined | ((e: Event) => void)> = {}, ...children: (Node | string | null)[]
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "text") node.textContent = String(v);
    else if (k === "class") node.className = String(v);
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
};

function installStyle(id: string, css: string): void {
  if (document.getElementById(id)) return;
  const style = document.createElement("style");
  style.id = id;
  style.textContent = css;
  // First in the head, as the page's own stylesheet is: Studio's rules of equal weight (its `.card`) come after and win,
  // so the card sits in the sidebar as Studio's cards do.
  document.head.prepend(style);
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** The range a numeric setting has once the provider's overrides are laid over the page's reference. */
function rangeOf(given: SettingRange | false | undefined, ref: Required<SettingRange>): Required<SettingRange> | null {
  if (given === false) return null;
  return { ...ref, ...(given ?? {}) };
}

export function mountDesignCard(
  container: HTMLElement | null,
  provider: DesignCardProvider | null,
  options: DesignCardOptions = {},
): DesignCardHandle {
  const sidebar = (options.mode ?? (container ? "inline" : "sidebar")) === "sidebar";
  const listeners = new Set<(e: DesignCardEvent) => void>();
  const cleanups: (() => void)[] = [];
  const studio = (): StudioHandle | undefined => options.studio ?? (window.atomworksStudio as StudioHandle | undefined);
  const emit = (event: DesignCardEvent): void => { for (const l of listeners) { try { l(event); } catch (err) { console.warn(err); } } };

  installStyle(STYLE_ID, cardCss);
  if (sidebar) {
    installStyle(MODE_STYLE_ID, cardModeCss);
    document.body.classList.add("studio-card-mode");
  }

  // ---- markup -------------------------------------------------------------------------------------------------
  const root = h("section", { id: "rfd4p-studio-card", class: "card rfd4p-card", "aria-label": "RFD4-Proteina generation controls" });
  root.innerHTML = cardMarkup();
  const titleRow = root.querySelector<HTMLElement>(".card-title-row")!;
  // The title row may move into Studio's header, so it is looked in too.
  const $ = <T extends HTMLElement = HTMLElement>(id: string): T => (root.querySelector<T>(`#${id}`) ?? titleRow.querySelector<T>(`#${id}`)) as T;

  const popover = sidebar ? (container ?? document.getElementById("atomworks-studio-popover")) : container;
  if (!popover) throw new Error("mountDesignCard: no container, and no Studio sidebar to mount into");
  let engine: EngineInfo = { ...(provider?.engine ?? { badge: "No engine", disabled: NO_ENGINE_MESSAGE }) };
  if (!provider) engine.disabled = NO_ENGINE_MESSAGE;

  const mountIntoStudio = (): void => {
    if (!sidebar) return;
    if (root.parentElement !== popover) popover.prepend(root);
    // The title row (title, engine, light/dark, Guide) goes to the right end of Studio's header, which had room to
    // spare, so the card starts with the design.
    const header = document.querySelector(".app-shell > header") ?? document.querySelector("header");
    if (header && titleRow.parentElement !== header) {
      titleRow.classList.add("rfd4p-head");
      header.append(titleRow);
    }
  };
  if (sidebar) mountIntoStudio();
  else popover.append(root);

  // ---- state --------------------------------------------------------------------------------------------------
  const views = new Map<string, View>();
  let runs: Run[] = [];
  let runsInput: string | null = null;
  let designCounter = 0;
  let studioSid: string | null = null;
  let inputSid: string | null = null;
  let lastDesignSid: string | null = null;
  let active: AbortController | null = null;
  let seedPinned = false;
  let theme: "light" | "dark" = "dark";
  let refoldPanel: RefoldPanelHandle | null = null;
  let liveHotspots: ViewerResidue[] | null = null;
  // What a run shows beside its frames and designs, read from the input: hotspots, the reference motif, the live sequence.
  let runCtx: RunContext | null = null;
  let strip: LiveSequenceStrip | null = null;
  let frameQueue: Promise<unknown> = Promise.resolve();
  let firstFrame = true;
  let shownOverlays = new Set<string>();
  let nothingToGenerate = false;
  const undoFloors = new Map<string, number>();
  let destroyed = false;
  let extrasCleanup: void | (() => void);

  const els = {
    predict: $<HTMLButtonElement>("predict"),
    thinking: $("thinking-radio-group"),
    samples: $<HTMLInputElement>("samples-input"),
    seed: $<HTMLInputElement>("seed-input"),
    seedRandom: $("seed-random"),
    backboneK: $<HTMLInputElement>("backbone-k"),
    backboneKNum: $<HTMLInputElement>("backbone-k-num"),
    latentK: $<HTMLInputElement>("latent-k"),
    latentKNum: $<HTMLInputElement>("latent-k-num"),
    partial: $<HTMLInputElement>("partial-diffusion"),
    partialPercent: $<HTMLInputElement>("partial-diffusion-percent"),
    partialPercentNum: $<HTMLInputElement>("partial-diffusion-percent-num"),
    earlyStop: $<HTMLInputElement>("early-stop"),
    statusBox: $("generation-status"),
    statusMessage: $("rfd4p-status-message"),
    modelLoad: $("rfd4p-model-load"),
    modelLoadText: $("rfd4p-model-load-text"),
    results: $("design-results"),
    job: $("rfd4p-job"),
    tabs: $("rfd4p-tabs"),
    refoldMount: $("rfd4p-refold-mount"),
    downloads: $("downloads"),
    downloadAll: $("download-all-btn"),
    badge: $("webgpu-badge"),
    themeBtn: $("rfd4p-theme-btn"),
    guideBtn: $("rfd4p-guide-btn"),
    accordion: $<HTMLDetailsElement>("sampling-accordion"),
  };

  // ---- settings: which the engine takes, their ranges and defaults ------------------------------------------------
  const cfg: ProviderSettings = provider?.settings ?? {};
  const samplesCfg = rangeOf(cfg.samples, { min: 1, max: 8, step: 1, default: 1 });
  const bbCfg = rangeOf(cfg.backboneK, { min: 1, max: 20, step: 0.1, default: 16 });
  const latCfg = rangeOf(cfg.latentK, { min: 1, max: 6, step: 0.1, default: 4 });
  const thinkingCfg = cfg.thinking === false ? null : { options: cfg.thinking?.options ?? THINKING_DEFAULT, default: cfg.thinking?.default ?? "none" };
  const seedOn = cfg.seed !== false;
  const partialCfg = cfg.partialDiffusion === false ? null : { percent: cfg.partialDiffusion?.percent ?? 40 };
  const earlyCfg = cfg.earlyStop === false ? null : { default: cfg.earlyStop?.default ?? true };

  const hide = (node: Element | null, hidden = true): void => { if (node) (node as HTMLElement).hidden = hidden; };
  const setSlider = (slider: HTMLInputElement, num: HTMLInputElement, r: Required<SettingRange>): void => {
    for (const input of [slider, num]) {
      input.min = String(r.min); input.max = String(r.max); input.step = String(r.step); input.value = String(r.default);
    }
  };
  if (samplesCfg) {
    els.samples.min = String(samplesCfg.min); els.samples.max = String(samplesCfg.max); els.samples.value = String(samplesCfg.default);
  } else {
    hide(els.samples);
    els.samples.style.display = "none";
  }
  if (thinkingCfg) {
    const allowed = new Set<string>(thinkingCfg.options);
    for (const radio of els.thinking.querySelectorAll<HTMLInputElement>("input[name=thinking-radio]")) {
      if (!allowed.has(radio.value)) radio.closest("label")?.remove();
      else radio.checked = radio.value === thinkingCfg.default;
    }
  } else hide(els.thinking);
  if (!seedOn) hide(els.seed.closest(".rfd4p-settings-row"));
  if (partialCfg) {
    els.partialPercent.value = els.partialPercentNum.value = String(partialCfg.percent);
  } else hide(els.partial.closest(".rfd4p-partial-setting"));
  if (bbCfg) setSlider(els.backboneK, els.backboneKNum, bbCfg); else hide(els.backboneK.closest("label"));
  if (latCfg) setSlider(els.latentK, els.latentKNum, latCfg); else hide(els.latentK.closest("label"));
  if (!bbCfg && !latCfg) hide(root.querySelector(".rfd4p-sampling-note"));
  if (earlyCfg) els.earlyStop.checked = earlyCfg.default; else hide(els.earlyStop.closest("label"));
  // "More settings" holds nothing the engine takes: leave it out.
  if (!seedOn && !partialCfg && !bbCfg && !latCfg && !earlyCfg) hide(els.accordion);

  const bindSliderPair = (slider: HTMLInputElement, num: HTMLInputElement): void => {
    slider.oninput = () => { num.value = slider.value; };
    num.oninput = () => { slider.value = num.value; };
  };
  bindSliderPair(els.backboneK, els.backboneKNum);
  bindSliderPair(els.latentK, els.latentKNum);
  bindSliderPair(els.partialPercent, els.partialPercentNum);

  /** Tick or clear Partial diffusion (optionally setting its %); the % controls are live only when ticked. */
  const setPartialDiffusion = (enabled: boolean, percent: number | null = null): void => {
    els.partial.checked = Boolean(enabled);
    if (percent != null) {
      els.partialPercent.value = String(Math.round(percent));
      els.partialPercentNum.value = els.partialPercent.value;
    }
    els.partialPercent.disabled = !enabled;
    els.partialPercentNum.disabled = !enabled;
    // It lives under More settings: shown whenever it is turned on, so it is never on out of sight.
    if (enabled) els.accordion.setAttribute("open", "");
  };
  els.partial.onchange = () => setPartialDiffusion(els.partial.checked);

  const rollSeed = (): void => { els.seed.value = String(Math.floor(Math.random() * 1e6)); };
  if (seedOn) {
    // Seeds start random so every visitor gets their own designs. A new one is drawn after each run, unless the user
    // typed a seed (then it stays, to reproduce a design); the dice button draws one and returns to random.
    rollSeed();
    els.seed.addEventListener("input", () => {
      seedPinned = els.seed.value.trim() !== "";
      if (!seedPinned) rollSeed();
    });
    els.seedRandom.addEventListener("click", () => { seedPinned = false; rollSeed(); });
  }

  const readSettings = (): RunSettings => {
    const s: RunSettings = {};
    if (samplesCfg) s.samples = clamp(Number.parseInt(els.samples.value, 10) || samplesCfg.default, samplesCfg.min, samplesCfg.max);
    if (thinkingCfg) {
      const checked = els.thinking.querySelector<HTMLInputElement>("input[name=thinking-radio]:checked");
      s.thinking = (checked?.value as ThinkingLevel | undefined) || thinkingCfg.default;
    }
    if (seedOn) {
      const typed = Number.parseInt(els.seed.value, 10);
      s.seed = Number.isFinite(typed) && typed >= 0 ? typed : 42;
    }
    if (partialCfg) {
      const percent = clamp(Number.parseFloat(els.partialPercent.value) || partialCfg.percent, 1, 100);
      s.partialDiffusion = els.partial.checked ? percent : null;
    }
    if (bbCfg) s.backboneK = clamp(Number.parseFloat(els.backboneK.value) || bbCfg.default, bbCfg.min, bbCfg.max);
    if (latCfg) s.latentK = clamp(Number.parseFloat(els.latentK.value) || latCfg.default, latCfg.min, latCfg.max);
    if (earlyCfg) s.earlyStop = els.earlyStop.checked;
    return s;
  };
  const settingsChanged = (): void => emit({ type: "settings", settings: readSettings() });
  for (const node of [els.samples, els.seed, els.backboneK, els.backboneKNum, els.latentK, els.latentKNum, els.partial,
    els.partialPercent, els.partialPercentNum, els.earlyStop, els.thinking]) {
    node.addEventListener("change", settingsChanged);
  }

  // ---- status, progress, engine ----------------------------------------------------------------------------------
  const setStatus = (text: string, isError = false, { visible = true } = {}): void => {
    els.statusMessage.textContent = text;
    els.statusMessage.classList.toggle("error", Boolean(isError));
    els.statusBox.hidden = !visible;
    const footer = visible && sidebar ? document.getElementById("status-message") : null;
    if (footer) {
      footer.textContent = text;
      footer.classList.toggle("error-text", Boolean(isError));
    }
  };
  /** How far a run is, drawn as the Generate (now Stop) button filling up. */
  const setProgress = (fraction: number, state: "running" | "idle" = "running"): void => {
    els.predict.style.setProperty("--rfd4p-progress", `${(clamp(fraction, 0, 1) * 100).toFixed(1)}%`);
    els.predict.classList.toggle("rfd4p-running", state === "running");
  };
  const syncGenerateEnabled = (): void => {
    if (active) return;
    els.predict.disabled = Boolean(engine.disabled) || nothingToGenerate;
  };
  const applyEngine = (): void => {
    els.badge.textContent = engine.badge;
    const heading = titleRow.querySelector("h2");
    if (engine.title && heading) heading.textContent = engine.title;
    syncGenerateEnabled();
    if (engine.disabled) setStatus(engine.disabled, true);
  };
  applyEngine();
  if (!engine.disabled) setStatus("Ready to generate.", false, { visible: false });

  // ---- theme ----------------------------------------------------------------------------------------------------
  const themeKey = options.themeKey ?? "rfd4p.theme";
  const stored = (): string | null => { try { return localStorage.getItem(themeKey); } catch { return null; } };
  const query = window.matchMedia?.("(prefers-color-scheme: light)");
  const initial = options.theme ?? (stored() === "light" || stored() === "dark" ? (stored() as "light" | "dark") : query?.matches ? "light" : "dark");
  theme = initial;
  const applyTheme = (): void => {
    const light = theme === "light";
    // Without Studio's page around it (an inline card) the card carries its theme itself.
    if (!sidebar) root.dataset.rfd4pTheme = theme;
    if (sidebar) {
      document.documentElement.dataset.hostTheme = theme;
      document.body.dataset.hostTheme = theme;
    }
    studio()?.setTheme?.(theme);
    els.themeBtn.textContent = light ? "☾" : "☀";
    els.themeBtn.title = light ? "Dark mode" : "Light mode";
    els.themeBtn.setAttribute("aria-label", els.themeBtn.title);
  };
  const setTheme = (next: "light" | "dark", remember = false): void => {
    theme = next;
    if (remember) { try { localStorage.setItem(themeKey, theme); } catch { /* storage blocked: this page only */ } }
    applyTheme();
    emit({ type: "theme", theme });
  };
  const onScheme = (): void => { if (!stored() && !options.theme) { theme = query?.matches ? "light" : "dark"; applyTheme(); } };
  query?.addEventListener?.("change", onScheme);
  cleanups.push(() => query?.removeEventListener?.("change", onScheme));
  els.themeBtn.addEventListener("click", () => setTheme(theme === "light" ? "dark" : "light", true));
  applyTheme();

  if (provider?.guide) {
    // `{ url }`: the card's own popup; a function: the host's.
    const address = guideUrl(provider.guide);
    const popup = address ? createGuide(address) : null;
    const openGuide = (): void => { void (popup ? popup.open() : (provider.guide as () => void | Promise<void>)()); };
    if (popup) cleanups.push(() => popup.destroy());
    els.guideBtn.hidden = false;
    els.guideBtn.addEventListener("click", openGuide);
    // Studio's own footer link opens the same guide.
    const link = sidebar ? document.getElementById("guide-link") : null;
    const open = (ev: Event): void => { ev.preventDefault(); openGuide(); };
    link?.addEventListener("click", open);
    cleanups.push(() => link?.removeEventListener("click", open));
  }
  if (options.studioEditor === false) hide(root.querySelector(".rfd4p-advanced-toggle"));
  if (options.noExamples) hide($("rfd4p-examples"));

  // ---- designs --------------------------------------------------------------------------------------------------
  const isViewingDesign = (): boolean => Boolean(studioSid && studioSid !== inputSid && views.get(studioSid));
  const designName = (v: View): string => {
    const base = v.record?.name ?? v.label;
    const same = [...views.values()].filter((x) => !x.isInput && x.record && x.record.name === base)
      .sort((a, b) => (a.record!.index - b.record!.index));
    const k = same.indexOf(v);
    return k > 0 ? `${base} (${k + 1})` : base;
  };

  const showOverlays = async (overlays: Record<string, DesignOverlay> | undefined): Promise<void> => {
    const s = studio();
    if (!s?.setOverlay) return;
    const next = new Set(Object.keys(overlays ?? {}));
    for (const key of shownOverlays) if (!next.has(key)) await s.setOverlay(key, null);
    for (const [key, o] of Object.entries(overlays ?? {})) await s.setOverlay(key, o.cif, o.options);
    shownOverlays = next;
  };

  const navigateTo = async (sid: string): Promise<void> => {
    const s = studio();
    if (!sid || !s) return;
    const view = views.get(sid);
    if (view?.record?.trajectoryCif && !view.trajectoryUrl) {
      view.trajectoryUrl = URL.createObjectURL(new Blob([view.record.trajectoryCif], { type: "chemical/x-mmcif" }));
    }
    try {
      await s.openSession(sid, view?.trajectoryUrl ? { trajectoryUrl: view.trajectoryUrl } : undefined);
      // Display-only reference motif and motif side chains beside a finished design (not part of the saved document).
      await showOverlays(view?.overlays);
      // ...and, if it has one, the design's refold over it (Studio's Refold panel draws it).
      await refoldPanel?.setSelected(sid);
      panel.showHotspots();
    } catch (err) {
      console.warn("Showing a design failed:", err);
    }
  };

  /** Select a row of the Designs table and show it. */
  const selectDesign = async (sid: string): Promise<void> => {
    studioSid = sid;
    if (sid !== inputSid) lastDesignSid = sid;
    renderDesigns();
    await navigateTo(sid);
  };

  const mountRefold = (): void => {
    const s = studio();
    if (refoldPanel || !provider?.refold || !els.refoldMount) return;
    const mount = s?.mountRefoldPanel ?? mountRefoldPanel;
    const panelOptions: RefoldPanelOptions = {
      ...(provider.refoldPanel as RefoldPanelOptions | undefined),
      onSelect: (sid) => selectDesign(sid),
      onDownload: (design) => downloadText(design.cif ?? "", `${design.filenameStem || "design"}.cif`, "chemical/x-mmcif"),
      ...(options.studio ? { overlay: (key, cif, o) => options.studio!.setOverlay?.(key, cif, o) } : {}),
    };
    refoldPanel = mount(els.refoldMount, provider.refold, panelOptions);
  };

  const downloadText = (text: string, filename: string, mime: string): void => {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = h("a", { href: url, download: filename });
    a.click();
    URL.revokeObjectURL(url);
  };

  /**
   * The job box's tabs, and the designs of the runs on this input handed to Studio's Refold panel, which draws the
   * Designs table (a row each, its refold's numbers) and the Refold box. Earlier runs are folded away.
   */
  function renderDesigns(): void {
    if (destroyed) return;
    mountRefold();
    // Runs belong to the input they were made from; another input opened shows none until it has its own.
    const current = runsInput === inputSid ? runs.filter((r) => r.designs.length) : [];
    const designs = current.flatMap((r) => r.designs).map((sid) => views.get(sid)).filter((v): v is View => Boolean(v));
    // One box, two tabs from the start: Input (the start screen, then the design being edited) and Outputs (this
    // table; greyed out until there are designs). The structure shown says which is open, and opening a tab shows its
    // structure (Outputs: the design last looked at).
    const input = inputSid ? views.get(inputSid) : undefined;
    const designSids = current[0]?.designs ?? [];
    const onInput = !designs.length || studioSid === inputSid;
    const tab = (label: string, on: boolean, sid: string | null): HTMLElement => h("button", {
      type: "button", role: "tab", class: `rfd4p-dtab${on ? " is-on" : ""}`, "aria-selected": String(on), text: label,
      disabled: !on && !sid, onclick: () => { if (!on && sid) void selectDesign(sid); },
    });
    const lastSeen = lastDesignSid && designSids.includes(lastDesignSid) ? lastDesignSid : designSids[0];
    els.tabs.replaceChildren(tab("Input", onInput, input?.isInput ? inputSid : null),
      tab(designSids.length ? `Outputs (${designSids.length})` : "Outputs", !onInput, lastSeen ?? null));
    els.job.dataset.tab = onInput ? "input" : "outputs";
    refoldPanel?.setDesigns(designSids.map((sid) => views.get(sid)).filter((v): v is View => Boolean(v && v.record)).map((v): RefoldDesign => ({
      id: v.record!.id, name: designName(v), cif: v.cif, filenameStem: v.filenameStem, kind: v.record!.kind, data: v.record!.data,
    })));
    refoldPanel?.setBusy(Boolean(active));
    els.downloads.hidden = designs.length < 1;
    els.results.hidden = designs.length < 1;
    emit({ type: "designs", designs: designs.map((v) => ({ ...v.record!, label: designName(v) })) });
  }

  // ---- the job editor -------------------------------------------------------------------------------------------
  const host: PanelHost = {
    studio,
    inputSessionId: () => inputSid,
    isViewingDesign,
    partialDiffusion: () => ({
      on: els.partial.checked,
      percent: Number.parseFloat(els.partialPercent.value ?? "40") || 40,
    }),
    setPartialDiffusion,
    setStatus: (text, isError) => setStatus(text, isError),
    renderDesigns,
    setNothingToGenerate: (nothing) => { nothingToGenerate = nothing; syncGenerateEnabled(); },
    liveHotspots: () => liveHotspots,
    shownDesignHotspots: () => (studioSid ? views.get(studioSid)?.record?.hotspots ?? null : null),
    inputChanged: (spec: DesignSpec) => provider?.inputChanged?.(spec),
    undoFloor: (sid) => undoFloors.get(sid) ?? 0,
    setUndoFloor: (sid, depth) => { undoFloors.set(sid, depth); },
  };
  const panel = new DesignPanel(host, root, options.examples ?? TASKS);

  // ---- Studio's events --------------------------------------------------------------------------------------------
  const onStudioEvent = (ev: Event): void => {
    const d = (ev as CustomEvent<{ type?: string; session_id?: string; task?: string; count?: number }>).detail ?? {};
    if (d.type === "selection") { panel.onSelection(d.count ?? 0); return; }
    if (d.type === "ready") applyTheme();
    if (d.type && ["ready", "changed", "example"].includes(d.type)) {
      mountIntoStudio();
      const sid = d.session_id;
      if (sid) {
        studioSid = sid;
        // Studio showed another document: the refold drawn over the last design goes, or the new design's comes.
        void refoldPanel?.setSelected(sid);
        const explicit = d.type === "changed" || d.type === "example";
        if (explicit || !views.has(sid) || views.get(sid)?.isInput) {
          const previous = inputSid;
          inputSid = sid;
          const view = views.get(sid);
          if (explicit && view) view.isInput = true;
          if (previous && previous !== sid && d.type === "example") els.results.hidden = true;
          if (d.type === "example") {
            active?.abort();
            setPartialDiffusion(d.task === "partial_diffusion");
            if (engine.disabled) setStatus(engine.disabled, true);
            else setStatus("Ready to generate.", false, { visible: false });
          }
          void panel.setInputSession(sid).then(() => emit({ type: "input", sessionId: sid }));
        } else {
          // A generated design is on show: the card goes read-only.
          panel.render();
        }
      }
    }
  };
  window.addEventListener("atomworks-studio", onStudioEvent);
  cleanups.push(() => window.removeEventListener("atomworks-studio", onStudioEvent));
  // Studio's Close structure ends the job.
  const closeBtn = sidebar ? document.getElementById("close-structure") : null;
  const onClose = (): void => { inputSid = null; studioSid = null; els.results.hidden = true; void panel.setInputSession(null); };
  closeBtn?.addEventListener("click", onClose);
  cleanups.push(() => closeBtn?.removeEventListener("click", onClose));
  // The document Studio already shows when the card is mounted.
  const current = studio()?.getSessionId?.() ?? null;
  if (current) { inputSid = current; studioSid = current; void panel.setInputSession(current); }

  // ---- generate -------------------------------------------------------------------------------------------------
  const hooksFor = (controller: AbortController, run: Run): GenerateHooks => ({
    status: (text, o) => setStatus(text, Boolean(o?.error), { visible: o?.visible ?? true }),
    progress: (fraction, label) => {
      setProgress(fraction, "running");
      els.predict.textContent = label ? `Stop · ${label}` : "Stop";
    },
    loading: (text) => {
      els.modelLoad.hidden = !text;
      els.modelLoadText.textContent = text ?? "";
    },
    frame: async (cif: string, o: FrameOptions = {}) => {
      const s = studio();
      if (!s?.renderFrame) return;
      // A frame waits for the one before it to be drawn, so none are dropped, and does not wait for its own.
      await frameQueue;
      const first = firstFrame;
      firstFrame = false;
      if (runCtx) {
        o = {
          ...o,
          hotspots: o.hotspots ?? frameHotspots(runCtx.hotspots),
          overlays: { ...runCtx.overlays, ...o.overlays },
        };
      }
      try { strip?.update(frameResidues(cif)); } catch { /* a frame without residues */ }
      // The first frame's hotspots: none while it replaces the input, then in the job's numbering.
      frameQueue = (first ? Promise.resolve(panel.clearHighlight("hotspots")) : Promise.resolve())
        .then(() => s.renderFrame!(cif, o.name ?? "frame.cif", { keepCamera: o.keepCamera }))
        .then(() => {
          if (!first || active !== controller) return;
          liveHotspots = o.hotspots ?? null;
          panel.showHotspots();
        })
        .then(() => showOverlays(o.overlays))
        // The frames replace the design on show, and its refold with it.
        .then(() => (first ? refoldPanel?.setSelected(null) : undefined))
        .catch(() => undefined);
    },
    design: async (given: DesignInfo): Promise<DesignRecord> => {
      await frameQueue;
      const info: DesignInfo = runCtx ? {
        ...given,
        hotspots: given.hotspots ?? designHotspots(given.cif, runCtx.hotspots),
        overlays: { ...runCtx.overlays, ...given.overlays },
      } : given;
      const index = (designCounter += 1);
      const stem = info.filenameStem ?? `design-${index}${info.seed != null ? `-seed${info.seed}` : ""}`;
      const sid = await createSession(info.cif, stem);
      const record: DesignRecord = { ...info, id: sid, label: info.name, index };
      const view: View = {
        label: info.name, cif: info.cif, pdb: info.pdb, isInput: false, filenameStem: stem, record,
        overlays: info.overlays,
      };
      views.set(sid, view);
      record.label = designName(view);
      run.designs.push(sid);
      // The next design's first frame is a first again.
      firstFrame = true;
      renderDesigns();
      return record;
    },
  });

  const run = async (): Promise<void> => {
    if (!provider || engine.disabled) {
      if (engine.disabled) setStatus(engine.disabled, true);
      return;
    }
    // A refold shares the GPU and shows designs this run is about to replace.
    refoldPanel?.stop();
    active?.abort();
    const controller = new AbortController();
    active = controller;
    const s = studio();
    try {
      els.predict.textContent = "Stop";
      els.predict.classList.add("secondary");
      els.predict.disabled = false;
      const settings = readSettings();
      await panel.syncInput();
      const doc: SessionDoc | null = panel.inputDocument();
      if (!doc || !inputSid || doc.sid !== inputSid) throw new Error("Open a structure or pick an example first.");
      const spec = panel.inputSpec();
      if (!spec) throw new Error("Open a structure or pick an example first.");
      const cif = await apiText(`/api/sessions/${encodeURIComponent(doc.sid)}/cif`);
      const revision = doc.revision;
      views.set(doc.sid, { label: "Input", cif, pdb: null, isInput: true, name: doc.name, revision, filenameStem: "input" });
      // One list of designs: generated again from the input unchanged, the new designs join it, numbered on; from an
      // edited or another input, it starts over.
      const last = runs[0];
      if (runsInput !== doc.sid || !last || last.inputRevision !== revision) {
        for (const [sid, v] of views) {
          if (sid === doc.sid) continue;
          if (v.trajectoryUrl) URL.revokeObjectURL(v.trajectoryUrl);
          views.delete(sid);
          // The sessions of designs that are no longer listed go with them.
          if (v.record) void deleteSession(sid);
        }
        runs = [{ designs: [], inputRevision: revision }];
        designCounter = 0;
        runsInput = doc.sid;
      }
      const thisRun = runs[0];
      const firstNew = thisRun.designs.length;
      renderDesigns();
      firstFrame = true;
      runCtx = runContext(doc.atoms);
      strip = new LiveSequenceStrip();
      strip.start(runCtx.hotspots);
      s?.setLiveMode?.(true);
      emit({ type: "run", running: true });
      let result: { message?: string } | void = undefined;
      try {
        result = await provider.generate({ sessionId: doc.sid, cif, name: doc.name, revision, spec, settings, signal: controller.signal },
          hooksFor(controller, thisRun));
      } finally {
        await frameQueue;
        s?.setLiveMode?.(false);
      }
      // Shown: this Generate's first design, also when it joined earlier ones.
      const firstDesign = thisRun.designs[firstNew];
      if (firstDesign) await selectDesign(firstDesign);
      setProgress(1, "idle");
      // There is now something to refold, and the Refold button has just appeared.
      refoldPanel?.prefetch();
      provider.designsReady?.();
      const count = thisRun.designs.length - firstNew;
      setStatus(result?.message ?? `Generated ${count} design${count === 1 ? "" : "s"} from input revision ${revision}.`);
      if (seedOn && !seedPinned) rollSeed();
    } catch (err) {
      setProgress(0, "idle");
      try {
        await s?.showDocument?.();
        await showOverlays(undefined);
        await refoldPanel?.setSelected(null);
      } catch {
        // Ignore
      }
      const text = String((err as Error | undefined)?.message ?? err);
      if (controller.signal.aborted || text.includes("aborted")) {
        setStatus("Generation stopped. Your input is unchanged.", false);
      } else {
        console.error("Design run failed:", err);
        const own = (err as { userMessage?: string } | undefined)?.userMessage;
        setStatus(own ?? `Generation failed. ${text} Your input is unchanged.`, true);
      }
    } finally {
      if (active === controller) {
        active = null;
        strip?.stop();
        strip = null;
        runCtx = null;
        liveHotspots = null;
        panel.showHotspots();
      }
      els.predict.textContent = "Generate design";
      els.predict.classList.remove("secondary");
      els.predict.disabled = false;
      setProgress(0, "idle");
      els.modelLoad.hidden = true;
      // A run stopped before its first design leaves nothing to list.
      runs = runs.filter((r) => r.designs.length);
      renderDesigns();
      panel.render();
      syncGenerateEnabled();
      emit({ type: "run", running: false });
    }
  };
  els.predict.onclick = () => {
    if (active) { active.abort(); return; }
    void run();
  };

  // ---- Save all (.zip) --------------------------------------------------------------------------------------------
  const refoldForZip = (record: RefoldRecord, design: DesignRecord): ResultsRefold => {
    if (provider?.zipRefold) return provider.zipRefold(record, design);
    const m = record.metrics ?? {};
    return {
      model: record.model, seed: record.seed, recycles: record.recycles, steps: record.steps, cif: record.cif,
      rmsd: m.rmsd, confidence: { meanPlddt: m.plddt, ptm: m.ptm, iptm: m.iptm },
      metrics: { placedRmsd: m.placedRmsd, chainPtm: m.chainPtm, minIpae: m.minIpae, motifRmsd: m.motifRmsd, motifBackboneRmsd: m.motifBackboneRmsd },
      pass: record.pass, text: record.text,
    };
  };
  const buildZip = (): { name: string; bytes: Uint8Array } | null => {
    const entries = [...views.entries()];
    const input = entries.find(([, v]) => v.isInput)?.[1];
    const designs: ResultsDesign[] = entries.filter(([, v]) => !v.isInput && v.record && v.cif)
      .map(([sid, v]): ResultsDesign => {
        const r = v.record!;
        return {
          index: r.index, label: r.seed != null ? `seed ${r.seed}` : r.name, seed: r.seed ?? undefined, stepsRun: r.stepsRun ?? undefined, nsteps: r.nsteps ?? undefined,
          cif: v.cif, pdb: v.pdb ?? null, trajectoryCif: r.trajectoryCif ?? null, designedChains: r.designedChains,
          refolds: (refoldPanel?.records(sid) ?? []).map((rec) => refoldForZip(rec, r)),
        };
      }).sort((a, b) => a.index - b.index);
    if (!designs.length) return null;
    const records = designs.map((d) => [...views.values()].find((v) => v.record?.index === d.index)!.record!);
    const files = resultsFiles({
      input: input ? { cif: input.cif, name: input.name ?? undefined, revision: input.revision } : null,
      designs, page: window.location.href.split("?")[0], title: provider?.zipTitle, models: DEFAULT_RESULTS_MODELS,
      extraFiles: provider?.zipFiles?.({ input: input ? { cif: input.cif, name: input.name ?? "", revision: input.revision ?? 0 } : null, designs: records }) ?? [],
    });
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
    const folder = `rfd4p-results-${stamp}`;
    return { name: `${folder}.zip`, bytes: zipStore(files.map((f) => ({ name: `${folder}/${f.name}`, data: f.text }))) };
  };
  const saveAll = (): void => {
    const zip = buildZip();
    if (!zip) return;
    const url = URL.createObjectURL(new Blob([zip.bytes as BlobPart], { type: "application/zip" }));
    const a = h("a", { href: url, download: zip.name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  };
  els.downloadAll.onclick = saveAll;

  // ---- the engine's own boxes ---------------------------------------------------------------------------------------
  if (provider?.renderExtras) {
    // A container with no box of its own (`display: contents`), where the status box would otherwise start.
    const extras = h("div", { id: "rfd4p-extras", class: "rfd4p-extras" });
    $("generation-status").before(extras);
    extrasCleanup = provider.renderExtras(extras);
  }

  panel.render();
  renderDesigns();

  return {
    element: root,
    get refold() { return refoldPanel; },
    setEngine(next) {
      engine = { ...engine, ...next };
      applyEngine();
      if (!engine.disabled && !active) setStatus("Ready to generate.", false, { visible: false });
    },
    setTheme: (next) => setTheme(next, true),
    theme: () => theme,
    designs: () => runs.flatMap((r) => r.designs).map((sid) => views.get(sid)).filter((v): v is View => Boolean(v?.record)).map((v) => ({ ...v.record!, label: designName(v) })),
    settings: readSettings,
    inputSessionId: () => inputSid,
    spec: () => panel.inputSpec(),
    generate: async () => { if (active) active.abort(); else await run(); },
    stop: () => active?.abort(),
    zip: buildZip,
    setStatus: (text, o) => setStatus(text, Boolean(o?.error), { visible: o?.visible ?? true }),
    onChange(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    destroy() {
      destroyed = true;
      active?.abort();
      for (const fn of cleanups.splice(0)) fn();
      if (typeof extrasCleanup === "function") extrasCleanup();
      refoldPanel?.destroy();
      panel.destroy();
      for (const v of views.values()) if (v.trajectoryUrl) URL.revokeObjectURL(v.trajectoryUrl);
      titleRow.remove();
      root.remove();
      document.body.classList.remove("studio-card-mode", "rfd4p-advanced");
      listeners.clear();
    },
  };
}
