import { TrajectoryController } from "./studio/trajectory-controller";
import initCifCore, { inspect_cif } from "./wasm/annotation_studio_core.js";
import { api, apiText } from "./api";
import { applyCapabilities, element, escapeHtml } from "./dom";
import { SelectionController } from "./selection-controller";
import { AnalysisController } from "./studio/analysis-controller";
import { mutateWithConfirmation } from "./studio/authoring-actions";
import { AnnotationController } from "./studio/annotation-controller";
import { initializeEditorTabs } from "./studio/editor-tabs";
import { ConditionController } from "./studio/condition-controller";
import {
  PENDING_EXAMPLE_KEY,
  parseViewerMode,
  persistSession as persistSessionStorage,
  requestedViewerMode,
} from "./studio/persistence";
import { SequenceController } from "./studio/sequence-controller";
import { SessionFileController } from "./studio/session-file-controller";
import { StructureEditController } from "./studio/structure-edit-controller";
import { ViewerToolbarController } from "./studio/viewer-toolbar-controller";
import type {
  SelectionScope,
  SessionResponse,
  StructureSummary,
  StudioSchema,
} from "./types";
import { MolecularViewer } from "./viewers";
import "./style.css";

const combineInput = element<HTMLInputElement>("combine-input");
const selectionCount = element<HTMLSpanElement>("selection-count");
const viewerBackend = element<HTMLSpanElement>("viewer-backend");
const viewerModeSelect = element<HTMLSelectElement>("viewer-mode");
const pickScope = element<HTMLSelectElement>("pick-scope");
const selectionSyntax = element<HTMLSelectElement>("selection-syntax");
const summaryElement = element<HTMLDivElement>("structure-summary");
const statusElement = element<HTMLPreElement>("status");
const query = new URLSearchParams(window.location.search);
const hostThemes = new Set(["light", "dark", "high-contrast", "high-contrast-light"]);

const hostColorTokens = new Set([
  "--bg-app", "--surface-header", "--surface-panel", "--surface-card", "--surface-raised", "--surface-recessed",
  "--text", "--text-secondary", "--text-muted", "--text-subtle", "--border", "--border-strong",
  "--accent", "--accent-hover", "--accent-ink", "--accent-soft", "--focus",
]);
function applyHostTheme(theme: unknown, tokens?: Record<string, unknown>): void {
  if (typeof theme === "string" && hostThemes.has(theme)) {
    document.body.dataset.hostTheme = theme;
    for (const key of hostColorTokens) {
      const value = tokens?.[key];
      if (typeof value === "string" && CSS.supports("color", value)) {
        document.body.style.setProperty(key, value);
      } else {
        document.body.style.removeProperty(key);
      }
    }
  }
}

window.addEventListener("message", (event) => {
  if (
    query.get("host") === "vscode" &&
    event.source === window.parent &&
    event.data?.source === "atomworks-vscode-host" &&
    event.data?.type === "theme"
  ) {
    applyHostTheme(event.data.theme, event.data.tokens);
  }
});

element<HTMLAnchorElement>("guide-link").addEventListener("click", (event) => {
  if (query.get("host") !== "vscode" || window.parent === window) return;
  event.preventDefault();
  // Only a fixed action is sent; the extension chooses the trusted guide URL.
  window.parent.postMessage({ source: "atomworks-studio", type: "open-guide" }, "*");
});

function notifyHost(type: "ready" | "changed" | "example", task?: string): void {
  const parentOrigin = query.get("parent_origin");
  if (!parentOrigin || window.parent === window || !sessionId) return;
  try {
    const targetOrigin = new URL(parentOrigin).origin;
    window.parent.postMessage(
      { source: "atomworks-annotation-studio", type, session_id: sessionId, ...(task ? { task } : {}) },
      targetOrigin,
    );
  } catch {
    log(`Ignored invalid parent_origin: ${parentOrigin}`);
  }
}

window.addEventListener("studio-example-loaded", (event) => {
  notifyHost("example", (event as CustomEvent<{ task: string }>).detail.task);
});

let trajectoryController: TrajectoryController | null = null;
let molecularViewer: MolecularViewer;
let viewerUpdateQueue: Promise<void> = Promise.resolve();
let sessionId: string | null = null;
let currentName = "structure";
let lastSummary: StructureSummary | null = null;
let viewerToolbarController: ViewerToolbarController | null = null;
let analysisController: AnalysisController | null = null;
let annotationController: AnnotationController | null = null;
let conditionController: ConditionController | null = null;
let sequenceController: SequenceController | null = null;
let structureEditController: StructureEditController | null = null;
let sessionFileController: SessionFileController | null = null;
const selectionController = new SelectionController(
  () => molecularViewer,
  () => updateSelectionUi(),
);

function persistSession(response: SessionResponse, message?: string): void {
  persistSessionStorage(response, message);
}

function log(message: string): void {
  const stamp = new Date().toLocaleTimeString();
  element("status-message").textContent = message.split("\n")[0];
  statusElement.textContent = `[${stamp}] ${message}\n${statusElement.textContent ?? ""}`.slice(0, 5000);
}

function updateSelectionUi(): void {
  const count = selectionController.size;
  const scope = pickScope.value as SelectionScope;
  selectionCount.textContent =
    `${count} atom${count === 1 ? "" : "s"} selected · ${scope} picking`;
  const hasSession = sessionId !== null;
  conditionController?.updateSelectionUi(hasSession);
  structureEditController?.updateSelectionUi(hasSession);
  element<HTMLButtonElement>("run-analysis").disabled = !hasSession;
  analysisController?.updateSelectionUi(hasSession);
  element<HTMLButtonElement>("inspect-bonds").disabled = !hasSession;
  element<HTMLButtonElement>("infer-bonds").disabled = !hasSession;
  element<HTMLButtonElement>("add-restraint").disabled = !hasSession || count !== 2;
  element<HTMLButtonElement>("remove-restraint").disabled = !hasSession || count !== 2;
  sequenceController?.syncSelection();
}

function renderSummary(summary: StructureSummary): void {
  lastSummary = summary;
  element("document-name").textContent = summary.name;
  element("empty-state").hidden = true;
  element<HTMLDetailsElement>("examples-panel").open = false;
  summaryElement.classList.remove("muted");
  summaryElement.innerHTML = `
    <dl class="summary-grid">
      <dt>Name</dt><dd>${escapeHtml(summary.name)}</dd>
      <dt>Atoms</dt><dd>${summary.atom_count.toLocaleString()}</dd>
      <dt>Chains</dt><dd>${escapeHtml(summary.chain_ids.join(", ") || "—")}</dd>
      <dt>Undo</dt><dd>${summary.undo_depth}/10</dd>
    </dl>`;
  sequenceController?.render(summary.sequence);
  annotationController?.render(summary.annotations, summary.stored_fields, summary.scalar_fields);
  structureEditController?.updateKnownChains(summary.chain_ids);
  conditionController?.update(summary);
  element<HTMLButtonElement>("undo").disabled = summary.undo_depth === 0;
  if (summary.validation.length) {
    log(summary.validation.map((issue) => `${issue.check}: ${issue.message}`).join("\n"));
  }
  viewerToolbarController?.renderDrawers();
}

function enableSessionControls(enabled: boolean): void {
  for (const id of [
    "download", "validate", "reset-residues", "realize-segments", "collapse-segments",
  ]) {
    element<HTMLButtonElement>(id).disabled = !enabled;
  }
  combineInput.disabled = !enabled;
  updateSelectionUi();
}

async function loadViewerCif(cif: string, name: string): Promise<void> {
  const wasmSummary = inspect_cif(cif) as {
    atom_count: number;
    finite_atom_count: number;
    condition_categories: string[];
  };
  if (wasmSummary.finite_atom_count === 0) {
    await molecularViewer.loadCifs([]);
    log("No coordinates to display. The design's sequence and conditions remain editable.");
    return;
  }
  await molecularViewer.loadCif(cif, name);
  if (!molecularViewer.initialized) {
    log(
      `Imported ${wasmSummary.atom_count} atoms while the renderer is unavailable; ` +
        `${wasmSummary.condition_categories.length} annotation categories remain editable.`,
    );
    return;
  }
  const backend = molecularViewer.backend === "patinae" ? "Patinae" : "Mol*";
  log(
    `${backend} loaded ${wasmSummary.atom_count} atoms; lossless WASM found ` +
      `${wasmSummary.condition_categories.length} annotation categories.`,
  );
}

async function handleAtomPicked(atomIndex: number, label?: string): Promise<void> {
  if (!sessionId || trajectoryController?.active) return;
  if (await conditionController?.handleAtomPicked(atomIndex)) return;
  if (await analysisController?.handleAtomPicked(atomIndex, label)) return;
  const scope = pickScope.value as SelectionScope;
  try {
    const resolved = scope === "atom"
      ? { atom_indices: [atomIndex] }
      : await api<{ atom_indices: number[]; count: number }>(
        `/api/sessions/${sessionId}/selections/resolve`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ atom_indices: [atomIndex], scope }),
        },
      );
    const remove = selectionController.toggle(resolved.atom_indices);
    log(
      `${label ?? `Atom ${atomIndex}`} · ${remove ? "removed" : "selected"} ` +
      `${resolved.atom_indices.length} atom${resolved.atom_indices.length === 1 ? "" : "s"} (${scope})`,
    );
    void annotationController?.inspectAtom(atomIndex);
  } catch (error) {
    log(`Could not resolve ${scope} selection: ${String(error)}`);
  }
}

async function recoverRenderer(error: unknown): Promise<void> {
  if (!molecularViewer.initialized
    || !String(error).includes("Patinae viewer stopped after WASM call")) throw error;
  if (molecularViewer.backend === "molstar") return;
  await molecularViewer.switchBackend("molstar");
  viewerModeSelect.value = "molstar";
  const url = new URL(window.location.href);
  url.searchParams.set("viewer", "molstar");
  history.replaceState(null, "", url);
  viewerToolbarController?.refreshCapabilities();
  selectionController.restore();
  log("Patinae rendering stopped. Switched to Mol*; your document and Undo history are preserved.");
}

async function refreshFromServer(summary?: StructureSummary, preserveSelection = true): Promise<void> {
  if (!sessionId) return;
  const cif = await apiText(`/api/sessions/${sessionId}/cif`);
  const refresh = async () => {
    await loadViewerCif(cif, currentName);
    if (summary) renderSummary(summary);
    if (preserveSelection) {
      if (summary) selectionController.retainValid(summary.atom_count);
      await annotationController?.restore();
    } else {
      annotationController?.reset();
      selectionController.clear();
    }
    await refreshCentroidMarkers();
  };
  try {
    await refresh();
  } catch (error) {
    await recoverRenderer(error);
    await refresh();
  }
}

async function refreshCentroidMarkers(): Promise<void> {
  const colors = [0xffd54f, 0x4dd0e1, 0xce93d8, 0xffa726, 0x66bb6a, 0xef5350, 0x42a5f5];
  const chains = Object.values(lastSummary?.condition_editors.centroids ?? {}).flat();
  await molecularViewer.setMarkers(conditionController?.markersVisible ? chains.flatMap((entry, index) =>
    entry.target ? [{ label: entry.chain, position: entry.target as [number, number, number], color: colors[index % colors.length] }] : [],
  ) : []);
}

function runViewerUpdate(operation: () => Promise<void>): Promise<void> {
  const update = viewerUpdateQueue.then(async () => {
    viewerModeSelect.disabled = true;
    try {
      await operation();
    } finally {
      viewerModeSelect.disabled = false;
    }
  });
  viewerUpdateQueue = update.catch(() => undefined);
  return update;
}

// Retry display-only actions after recovery; document mutations use runViewerUpdate.
function runVisualUpdate(operation: () => Promise<void>): Promise<void> {
  return runViewerUpdate(async () => {
    try {
      await operation();
    } catch (error) {
      await recoverRenderer(error);
      await operation();
    }
  });
}

function mutate(path: string, body?: unknown, propagateError = false): Promise<void> {
  if (!sessionId) return Promise.resolve();
  const targetSession = sessionId;
  return runViewerUpdate(async () => {
    if (sessionId !== targetSession) return;
    try {
      const response = await mutateWithConfirmation<SessionResponse>(
        `/api/sessions/${targetSession}${path}`, body, () => sessionId === targetSession,
      );
      if (!response || sessionId !== targetSession) return;
      trajectoryController?.dispose();
      trajectoryController = null;
      conditionController?.acceptMutation(path, response);
      persistSession(response);
      const structural = /^\/(?:delete|segments|reset-residue-ids|protonate)/.test(path)
        || response.structure.atom_count !== lastSummary?.atom_count;
      if (structural) await molecularViewer.clearAllVisuals();
      const annotationEdit = path === "/internal-coords"
        || /^\/(?:conditions|groups|centroids|distance-restraints)(?:\/|$)/.test(path);
      if (annotationEdit && response.edit_result?.changed !== false) {
        selectionController.clear();
      }
      await refreshFromServer(response.structure, !structural);
      const message = response.edit_result?.message ?? "Annotation Studio state updated.";
      conditionController?.setFeedback(message);
      log(message);
      notifyHost("changed");
    } catch (error) {
      if (sessionId === targetSession) {
        const message = `Error: ${String(error)}`;
        conditionController?.setFeedback(message);
        log(message);
      }
      if (propagateError) throw error;
    }
  });
}

async function initialize(): Promise<void> {
  document.body.classList.toggle("embedded", query.get("embed") === "1");
  const host = query.get("host");
  document.body.classList.toggle("host-vscode", host === "vscode");
  if (host === "vscode") applyHostTheme(query.get("hostTheme"));
  // Respect an explicit choice; otherwise use Mol* across browser and embedded hosts.
  const urlPinnedViewer = parseViewerMode(query.get("viewer"));
  const mode = requestedViewerMode(query) ?? "molstar";
  viewerModeSelect.value = mode;
  await initCifCore();
  const schema = await api<StudioSchema>("/api/schema");
  initializeEditorTabs(schema.editor_tabs);
  molecularViewer = new MolecularViewer(
    element("viewer"),
    viewerBackend,
    mode,
    handleAtomPicked,
    (error) => void runViewerUpdate(async () => {
      await recoverRenderer(error);
      if (sessionId) {
        const response = await api<SessionResponse>(`/api/sessions/${sessionId}`);
        await refreshFromServer(response.structure);
        enableSessionControls(true);
      }
    }).catch((failure) => log(`Renderer recovery failed: ${String(failure)}`)),
  );
  viewerToolbarController = new ViewerToolbarController({
    viewer: () => molecularViewer,
    selection: selectionController,
    getSessionId: () => sessionId,
    getSummary: () => lastSummary,
    requestedMode: () => requestedViewerMode(query),
    runViewerUpdate: runVisualUpdate,
    mutate: (path, body) => mutate(path, body, true),
    log,
  });
  analysisController = new AnalysisController({
    viewer: () => molecularViewer,
    selection: selectionController,
    getSessionId: () => sessionId,
    getAtomCount: () => lastSummary?.atom_count ?? 0,
    mutate,
    renderViewerDrawers: () => viewerToolbarController?.renderDrawers(),
    log,
    onSelectionUiChange: updateSelectionUi,
  });
  annotationController = new AnnotationController({
    runViewerUpdate: runVisualUpdate,
    viewer: () => molecularViewer,
    selection: selectionController,
    getSessionId: () => sessionId,
    log,
  });
  conditionController = new ConditionController({
    selection: selectionController, mutate, getRevision: () => lastSummary?.revision, getSessionId: () => sessionId,
    onMarkersChanged: () => void runVisualUpdate(refreshCentroidMarkers).catch((error) => log(String(error))),
  });
  sequenceController = new SequenceController({
    selection: selectionController,
    mutate,
    inspectAtom: (atomIndex) => annotationController!.inspectAtom(atomIndex),
  });
  structureEditController = new StructureEditController({
    selection: selectionController,
    getSessionId: () => sessionId,
    mutate,
    log,
  });
  sessionFileController = new SessionFileController({
    runViewerUpdate,
    getSessionId: () => sessionId,
    onOpened: (response) => runViewerUpdate(async () => {
      const workspace = element("workspace");
      workspace.inert = true;
      enableSessionControls(false);
      try {
        trajectoryController?.dispose();
        trajectoryController = null;
        sessionId = response.session_id;
        currentName = response.structure.name;
        selectionController.clear();
        await molecularViewer.clearAllVisuals();
        persistSession(response);
        await refreshFromServer(response.structure, false);
        enableSessionControls(true);
        notifyHost("ready");
      } catch (error) {
        await recoverRenderer(error);
        persistSession(response);
        await refreshFromServer(response.structure, false);
        enableSessionControls(true);
        notifyHost("ready");
      } finally {
        workspace.inert = false;
      }
    }),
    onCombined: async (response, filename) => {
      trajectoryController?.dispose();
      trajectoryController = null;
      selectionController.clear();
      await molecularViewer.clearAllVisuals();
      persistSession(response);
      await refreshFromServer(response.structure, false);
      log(`Combined ${filename}; conflicting chain IDs were reassigned.`);
      notifyHost("changed");
    },
    log,
  });
  conditionController.initialize(schema);
  sessionFileController.initializeLoading(schema.loading);
  structureEditController.initializeBondTypes(schema.bond_types);
  viewerToolbarController.bind();
  element("empty-open").addEventListener("click", () => element<HTMLInputElement>("file-input").click());
  analysisController.bind();
  annotationController.bind();
  conditionController.bind();
  sequenceController.bind();
  structureEditController.bind();
  sessionFileController.bind();
  await sessionFileController.initializeExamples();
  pickScope.addEventListener("change", () => {
    selectionController.setScope(pickScope.value as SelectionScope);
  });
  element("clear-selection").addEventListener("click", () => selectionController.clear());
  for (const button of document.querySelectorAll<HTMLButtonElement>(".example-load")) {
    button.disabled = false;
  }
  const degradeToEditingOnly = (error: unknown): void => {
    applyCapabilities({});
    element("style-menu").hidden = true;
    pickScope.disabled = true;
    selectionSyntax.querySelector<HTMLOptionElement>('option[value="patinae"]')!.disabled = true;
    if (selectionSyntax.value === "patinae") {
      selectionSyntax.value = "expression";
      selectionSyntax.dispatchEvent(new Event("change"));
    }
    log(`Renderer initialization failed; editing remains available: ${String(error)}`);
  };
  try {
    await molecularViewer.initialize();
    viewerToolbarController.refreshCapabilities();
    updateSelectionUi();
  } catch (error) {
    // Recover a saved Patinae preference when WebGPU is unavailable, unless URL-pinned.
    if (mode === "patinae" && urlPinnedViewer === null) {
      try {
        await molecularViewer.switchBackend("molstar");
        viewerModeSelect.value = "molstar";
        viewerToolbarController.refreshCapabilities();
        updateSelectionUi();
        log(`Patinae (WebGPU) unavailable; using Mol* (WebGL) instead: ${String(error)}`);
      } catch (fallbackError) {
        degradeToEditingOnly(fallbackError);
      }
    } else {
      degradeToEditingOnly(error);
    }
  }
  let restoredSession = false;
  const example = query.get("example");
  const savedSession = query.get("session") ?? (example ? null : sessionStorage.getItem("annotation-studio-session"));
  if (savedSession) {
    try {
      sessionId = savedSession;
      const restored = await api<SessionResponse>(`/api/sessions/${sessionId}`);
      currentName = restored.structure.name;
      await refreshFromServer(restored.structure);
      persistSession(restored);
      enableSessionControls(true);
      notifyHost("ready");
      const message = sessionStorage.getItem("annotation-studio-message");
      sessionStorage.removeItem("annotation-studio-message");
      log(message ?? "Restored native AtomWorks session.");
      restoredSession = true;
    } catch {
      sessionStorage.removeItem("annotation-studio-session");
      sessionStorage.removeItem("annotation-studio-name");
    }
  }
  if (restoredSession && query.get("trajectory")) {
    trajectoryController = new TrajectoryController(molecularViewer, async () => {
      await molecularViewer.clearAllVisuals();
      await refreshFromServer();
    }, log);
    trajectoryController.bind(query.get("trajectory")!);
  }
  if (!restoredSession) log("Ready. Open a CIF to start.");
  const pendingExample = query.has("session") ? null : example ?? sessionStorage.getItem(PENDING_EXAMPLE_KEY);
  if (pendingExample) {
    sessionStorage.removeItem(PENDING_EXAMPLE_KEY);
    await sessionFileController.loadPendingExample(pendingExample);
  }
}

if (import.meta.env.PROD && window.parent === window && "serviceWorker" in navigator) {
  void navigator.serviceWorker.register("/sw.js").catch(error => console.warn("Offline installation unavailable", error));
}

void initialize().catch((error) => log(`Initialization failed: ${String(error)}`));
