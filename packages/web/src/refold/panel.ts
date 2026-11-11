/**
 * The Refold panel: the Designs table with each design's refold numbers, and the Refold box under it (model, seed,
 * recycles, steps, "Refold all" / Stop, a failure's line), with the terms dialog a licence-gated model asks for.
 * Everything a person sees lives here once; what folds lives in the host's `RefoldProvider` (types.ts), and `session.ts`
 * holds what the panel decides. A host mounts it with `mountRefoldPanel`, either through Studio's embedding API
 * (`window.atomworksStudio.mountRefoldPanel`) or from the standalone module (`standalone.ts`).
 */
import { finiteMetric, rankKey } from "./criteria.ts";
import panelCss from "./panel.css?inline";
import { RefoldSession, type RefoldStorage, type TermsAnswer } from "./session.ts";
import type {
  RefoldColumnHeader, RefoldDesign, RefoldModel, RefoldProvider, RefoldRecord, RefoldSettings,
} from "./types.ts";

/** The overlay options Studio's `setOverlay` takes (viewers/contract.ts `ViewerOverlayOptions`), as far as the panel uses them. */
export type RefoldOverlayOptions = {
  label?: string; color?: number; alpha?: number; representation?: "ball-and-stick" | "cartoon"; sizeAspectRatio?: number;
};

export type RefoldPanelOptions = {
  /** Called when a row is chosen, or a refold finishes on another design: show that design (open its session). */
  onSelect?: (id: string) => Promise<void> | void;
  /**
   * Draw a display-only structure beside the shown design under `key`, `null` to remove it. Studio's own mount
   * passes its `setOverlay`; a host driving a Studio in an iframe passes that frame's.
   */
  overlay?: (key: string, cif: string | null, options: RefoldOverlayOptions) => Promise<void> | void;
  /** The first column's head: what a design is called ("Seed"). */
  nameHeader?: RefoldColumnHeader;
  /** How a design reads in the progress line and the row buttons' labels ("seed 163509"); its name by default. */
  describe?: (design: RefoldDesign) => string;
  /** A row's download button; by default saves the design's `cif`. */
  onDownload?: (design: RefoldDesign) => void;
  /** Where agreement to a model's terms is remembered; localStorage by default. */
  storage?: RefoldStorage;
  /** Palette override; by default the page's own (Studio's light/dark variables). */
  theme?: "light" | "dark";
  /** Notified after any change a host may want to persist or mirror (a refold finished, settings changed). */
  onChange?: () => void;
};

export type RefoldPanelHandle = {
  readonly element: HTMLElement;
  readonly session: RefoldSession;
  /** The designs on offer, in table order. Refolds already made of a design that stays are kept. */
  setDesigns(designs: RefoldDesign[]): void;
  /** The host showed a design (or none): draw its refold over it, and mark its row. Call once its structure is on screen. */
  setSelected(id: string | null): Promise<void>;
  /** Refold `ids`, or every design not yet refolded with the settings in the box. Resolves when the run ends. */
  refold(ids?: string[] | null): Promise<void>;
  stop(): void;
  settings(): RefoldSettings;
  /** Every refold made of a design, oldest first. */
  records(id: string): RefoldRecord[];
  /** Grey the table while the host is busy with something that would replace the designs. */
  setBusy(busy: boolean): void;
  /** Re-read `provider.available()` and draw again. */
  refresh(): void;
  /** Draw the shown design's refold overlays again, after the host's viewer was reset. */
  reapplyOverlays(): Promise<void>;
  destroy(): void;
};

const STYLE_ID = "atomworks-refold-style";
const MAGENTA = 0xe040fb;

type Attrs = Record<string, string | number | boolean | null | undefined | ((event: Event) => void)>;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: (Node | string | null)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === "text") node.textContent = String(value);
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value as EventListener);
    else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, String(value));
  }
  for (const child of children) if (child != null) node.append(child);
  return node;
}

/** `**bold**` runs of plain text, as nodes: the terms' wording needs nothing more, and nothing is parsed as HTML. */
function richText(text: string): (Node | string)[] {
  return text.split(/(\*\*[^*]+\*\*)/).filter(Boolean)
    .map((part) => (part.startsWith("**") ? h("strong", { text: part.slice(2, -2) }) : part));
}

function installStyle(root: Document | ShadowRoot): void {
  const scope = root instanceof Document ? root.head : root;
  if (scope.querySelector(`#${STYLE_ID}`)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = panelCss;
  scope.append(style);
}

function defaultDownload(design: RefoldDesign): void {
  if (!design.cif) return;
  const url = URL.createObjectURL(new Blob([design.cif], { type: "chemical/x-mmcif" }));
  const link = h("a", { href: url, download: `${design.filenameStem || "design"}.cif` });
  link.click();
  URL.revokeObjectURL(url);
}

export function mountRefoldPanel(container: HTMLElement, provider: RefoldProvider, options: RefoldPanelOptions = {}): RefoldPanelHandle {
  installStyle(container.getRootNode() instanceof ShadowRoot ? (container.getRootNode() as ShadowRoot) : document);
  const overlayFn = options.overlay ?? ((key, cif, overlayOptions) => window.atomworksStudio?.setOverlay(key, cif, overlayOptions));

  // --- Markup: the reference page's, with Studio's ids ------------------------------------------------------------
  const designsBox = h("div", { id: "refold-designs", class: "refold-designs", role: "radiogroup", "aria-label": "Designs" });
  const modelSelect = h("select", { id: "refold-model", class: "refold-model" });
  const seedInput = h("input", { id: "refold-seed", type: "number", step: 1 });
  const recyclesSelect = h("select", { id: "refold-recycles" });
  const stepsSelect = h("select", { id: "refold-steps" });
  const button = h("button", { id: "refold-btn", class: "secondary compact", type: "button" });
  const result = h("p", { id: "refold-result", class: "refold-result", "aria-live": "polite", hidden: true });
  const box = h("div", { id: "refold-box", class: "refold-box", hidden: true },
    h("strong", { text: "Refold" }),
    h("div", { class: "refold-grid" },
      h("label", {}, "Model", modelSelect),
      h("label", { id: "refold-seed-label" }, "Seed", seedInput),
      h("label", { id: "refold-recycles-label" }, "Recycles", recyclesSelect),
      h("label", { id: "refold-steps-label" }, "Steps", stepsSelect)),
    button, result);
  const dialog = h("dialog", { id: "refold-terms", class: "refold-terms", "aria-labelledby": "refold-terms-title" });
  const root = h("div", { class: "refold-panel", "data-refold-panel": "" }, designsBox, box, dialog);
  if (options.theme) root.dataset.refoldTheme = options.theme;
  container.append(root);

  // --- The terms dialog --------------------------------------------------------------------------------------------
  const askTerms = async (model: RefoldModel): Promise<TermsAnswer> => {
    const terms = model.terms;
    if (!terms || typeof dialog.showModal !== "function") return "cancel";
    const links = h("p", { class: "refold-terms-links" });
    terms.links.forEach((link, index) => {
      if (index) links.append(" · ");
      links.append(h("a", { href: link.href, target: "_blank", rel: "noopener noreferrer", text: link.label }));
    });
    dialog.replaceChildren(h("form", { method: "dialog" },
      h("h2", { id: "refold-terms-title", text: terms.title }),
      ...terms.paragraphs.map((paragraph) => h("p", {}, ...richText(paragraph))),
      links,
      h("div", { class: "button-row" },
        terms.switchTo ? h("button", { value: "switch", class: "primary compact", text: terms.switchTo.label }) : null,
        h("button", { value: "accept", class: "secondary compact", text: terms.agreeLabel }),
        h("button", { value: "cancel", class: "secondary compact", text: "Cancel" }))));
    dialog.dataset.model = model.id;
    dialog.returnValue = "";
    dialog.showModal();
    await new Promise<void>((resolve) => dialog.addEventListener("close", () => resolve(), { once: true }));
    return dialog.returnValue === "accept" ? "accept" : dialog.returnValue === "switch" ? "switch" : "cancel";
  };

  // --- Overlays: the shown design's refold, in magenta, a cartoon plus its ligands ----------------------------------
  let overlayChain: Promise<void> = Promise.resolve();
  const applyOverlays = (): Promise<void> => {
    const apply = async (): Promise<void> => {
      const id = session.selectedId;
      const shown = id ? session.shown(id) : null;
      const label = shown ? `${shown.modelLabel} refold` : "Refold";
      try {
        // Magenta is in no chain colour, so the refold reads against any binder.
        await overlayFn("refold", shown?.cif ?? null, { label, color: MAGENTA, alpha: 0.75, representation: "cartoon" });
        // Its ligands, where the refold put them, in the same magenta: a cartoon draws polymers only.
        await overlayFn("refoldLigands", shown?.ligandCif ?? null, { label: `${label} ligands`, color: MAGENTA, sizeAspectRatio: 0.6 });
      } catch (error) {
        console.error("Refold overlay failed:", error);
      }
    };
    overlayChain = overlayChain.then(apply, apply);
    return overlayChain;
  };

  const select = async (id: string | null, notifyHost: boolean): Promise<void> => {
    session.selectedId = id;
    render();
    if (notifyHost && id) await options.onSelect?.(id);
    await applyOverlays();
  };

  const session = new RefoldSession({
    provider,
    storage: options.storage,
    describe: options.describe,
    askTerms,
    reveal: async (id) => {
      // The design just refolded is shown, its refold over it.
      if (session.selectedId === id) await applyOverlays();
      else await select(id, true);
    },
  });

  // --- Fields ------------------------------------------------------------------------------------------------------
  const { limits } = session;
  for (const model of session.models) modelSelect.append(h("option", { value: model.id, text: model.label }));
  for (const n of limits.recycles.options) recyclesSelect.append(h("option", { value: n, text: String(n) }));
  for (const n of limits.steps.options) stepsSelect.append(h("option", { value: n, text: String(n) }));
  seedInput.min = String(limits.seed.min);
  seedInput.max = String(limits.seed.max);
  seedInput.value = String(session.settings.seed);
  modelSelect.value = session.settings.model;
  recyclesSelect.value = String(session.settings.recycles);
  stepsSelect.value = String(session.settings.steps);
  (seedInput.parentElement as HTMLElement).title = limits.seed.title;
  (recyclesSelect.parentElement as HTMLElement).title = limits.recycles.title;
  (stepsSelect.parentElement as HTMLElement).title = limits.steps.title;
  // The reference page's markup: Model carries no tooltip of its own.

  const readFields = (): Partial<RefoldSettings> => ({
    model: modelSelect.value,
    seed: Number.parseInt(seedInput.value, 10),
    recycles: Number.parseInt(recyclesSelect.value, 10),
    steps: Number.parseInt(stepsSelect.value, 10),
  });

  const settingsChanged = async (): Promise<void> => {
    const modelBefore = session.settings.model;
    const changed = session.setSettings(readFields());
    // The fields show what was kept (a seed out of range comes back clamped).
    seedInput.value = String(session.settings.seed);
    modelSelect.value = session.settings.model;
    if (session.settings.model !== modelBefore) session.prefetch();
    if (session.selectedId && changed.includes(session.selectedId)) await applyOverlays();
    options.onChange?.();
  };
  for (const field of [modelSelect, seedInput, recyclesSelect, stepsSelect]) {
    field.addEventListener("change", () => { void settingsChanged(); });
    field.addEventListener("input", () => renderBox(false));
  }
  button.addEventListener("click", () => { void session.run(null); });

  // --- Drawing -----------------------------------------------------------------------------------------------------
  let sort: { key: string; dir: 1 | -1 } | null = null;
  let busy = false;
  let tableKey = "";
  let sawDesigns = false;

  function renderBox(syncModel = false): void {
    // The session can change the model itself (the terms dialog's "Use OpenBind-0"). Not on a field's own `input`
    // event, which arrives before its `change` has been read.
    if (syncModel && modelSelect.value !== session.settings.model) modelSelect.value = session.settings.model;
    const any = session.hasDesigns();
    box.hidden = !any || !session.available();
    const state = session.button();
    button.textContent = state.label;
    button.disabled = state.disabled;
    button.title = state.title;
    button.classList.toggle("refold-running", state.fraction !== null);
    button.style.setProperty("--refold-progress", `${(Math.max(0, Math.min(1, state.fraction ?? 0)) * 100).toFixed(1)}%`);
    const line = session.errorLine();
    result.textContent = line ?? "";
    result.classList.toggle("error", Boolean(line));
    result.hidden = !line;
  }

  function renderTable(): void {
    const states = session.list();
    const kind = states.find((s) => s.design.kind != null)?.design.kind ?? null;
    const placed = kind === "binder" || kind === "antibody";
    const iface = placed || states.some((s) => finiteMetric(s.shown?.metrics, "iptm") !== null);
    const cols = [
      { key: placed ? "placedRmsd" : "rmsd", label: "RMSD", dir: 1 as const, fmt: (x: number) => x.toFixed(1),
        title: placed ? "Å: the designed chain against its refold, fitted on the rest, so where it sits counts"
          : "Å: the designed chains against their refold" },
      { key: "plddt", label: "pLDDT", dir: -1 as const, fmt: (x: number) => x.toFixed(0), title: "The refold model's confidence, 0–100" },
      ...(iface ? [
        { key: "iptm", label: "ipTM", dir: -1 as const, fmt: (x: number) => x.toFixed(2), title: "The refold model's confidence in the interface, 0–1" },
        { key: "minIpae", label: "iPAE", dir: 1 as const, fmt: (x: number) => x.toFixed(1),
          title: "Å: the lowest predicted error between a designed residue and the rest (min iPAE)" },
      ] : []),
    ];
    const order = (): typeof states => {
      if (!sort) return states;
      const active = sort;
      const index = (s: (typeof states)[number]): number => states.indexOf(s);
      return [...states].sort((a, b) => {
        const x = finiteMetric(a.shown?.metrics, active.key);
        const y = finiteMetric(b.shown?.metrics, active.key);
        if (x === null || y === null) return Number(x === null) - Number(y === null) || index(a) - index(b);
        return (x - y) * active.dir || index(a) - index(b);
      });
    };
    const header = options.nameHeader ?? { label: "Design" };
    const refoldable = session.available();
    const running = session.isRunning;
    const head = h("thead", {}, h("tr", {},
      h("th", { class: "refold-dt-name", title: header.title, text: header.label }),
      ...cols.map((c) => h("th", { class: "refold-dt-num", title: c.title }, h("button", {
        type: "button", class: `refold-sort${sort?.key === c.key ? " is-sorted" : ""}`,
        text: `${c.label}${sort?.key === c.key ? (sort.dir === c.dir ? "▾" : "▴") : ""}`,
        onclick: () => {
          sort = sort?.key === c.key ? { key: c.key, dir: (-sort.dir) as 1 | -1 } : { key: c.key, dir: c.dir };
          tableKey = "";
          render();
        },
      }))),
      h("th", { class: "refold-dt-act" })));
    const row = (state: (typeof states)[number]): HTMLElement => {
      const { design } = state;
      const id = design.id;
      const radio = h("input", { type: "radio", name: "refold-design-radio", value: id });
      radio.checked = id === session.selectedId;
      radio.addEventListener("change", () => { if (radio.checked) void select(id, true); });
      const passed = state.shown?.pass;
      const tr = h("tr", { class: passed === false ? "refold-fail" : null, "data-design": id });
      tr.append(h("td", { class: "refold-dt-name" },
        h("label", {}, radio, h("span", { text: design.name }),
          passed === true ? h("span", { class: "refold-pass", title: "Meets upstream's pass criteria", "aria-label": "passes", text: " ✓" }) : null)));
      const stateText = session.runningId === id ? "refolding…" : session.isQueued(id) ? "queued"
        : session.failed(id) ? "refold failed" : null;
      if (stateText !== null) tr.append(h("td", { class: "refold-dt-state", colspan: cols.length, text: stateText }));
      else {
        for (const c of cols) {
          const x = finiteMetric(state.shown?.metrics, c.key);
          tr.append(h("td", { class: "refold-dt-num", text: x === null ? "" : c.fmt(x) }));
        }
      }
      const stop = (fn: () => void) => (event: Event): void => { event.preventDefault(); event.stopPropagation(); fn(); };
      const done = Boolean(session.recordWith(id));
      tr.append(h("td", { class: "refold-dt-act" },
        refoldable ? h("button", {
          type: "button", class: "refold-act refold-design-refold", text: "↻", disabled: running || done,
          title: done ? "Refolded with the settings below" : "Refold this design with the settings below",
          "aria-label": `Refold ${session.describe(design)}`,
          onclick: stop(() => { void session.run([id]); }),
        }) : null,
        design.cif || options.onDownload ? h("button", {
          type: "button", class: "refold-act", text: "⤓", title: "Download this structure (CIF)",
          "aria-label": `Download ${session.describe(design)}`,
          onclick: stop(() => (options.onDownload ?? defaultDownload)(design)),
        }) : null));
      // Anywhere on the row shows it.
      tr.addEventListener("click", (event) => {
        if (!(event.target as HTMLElement).closest("button, label, input") && !radio.checked) { radio.checked = true; void select(id, true); }
      });
      return tr;
    };
    const table = h("table", { class: "refold-dtable" }, head, h("tbody", {}, ...order().map(row)));
    designsBox.replaceChildren(...(states.length ? [table] : []));
  }

  function render(): void {
    // The table is rebuilt only when something it shows changed: progress ticks reach the button alone.
    const key = JSON.stringify([
      session.list().map((s) => [s.design.id, s.design.name, s.design.kind, s.records.length, s.records.indexOf(s.shown as RefoldRecord),
        s.failed, session.recordWith(s.design.id) !== null]),
      session.selectedId, sort, session.isRunning, session.runningId, session.list().filter((s) => session.isQueued(s.design.id)).length,
      session.available(),
    ]);
    if (key !== tableKey) { tableKey = key; renderTable(); }
    designsBox.classList.toggle("refold-designs-busy", busy);
    renderBox(true);
  }
  session.subscribe(render);
  render();

  return {
    element: root,
    session,
    setDesigns(designs) {
      session.setDesigns(designs);
      if (designs.length && !sawDesigns) {
        // There is now something to refold: start pulling the model's parameters while the person reads the designs.
        sawDesigns = true;
        session.prefetch();
      }
      if (!designs.length) sawDesigns = false;
      if (session.selectedId && !designs.some((d) => d.id === session.selectedId)) void applyOverlays();
    },
    async setSelected(id) {
      session.selectedId = id;
      render();
      await applyOverlays();
    },
    refold: (ids = null) => session.run(ids ?? null),
    stop: () => session.stop(),
    settings: () => ({ ...session.settings }),
    records: (id) => session.records(id),
    setBusy(value) { busy = value; render(); },
    refresh() { tableKey = ""; render(); },
    reapplyOverlays: applyOverlays,
    destroy() {
      session.stop();
      root.remove();
    },
  };
}

export { rankKey };
