import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import ts from "typescript";

// main.ts runs against recording stubs for its controllers, renderer and WASM core.
const STUBBED_BY_MAIN = new Set([
  "./selection-controller", "./studio/analysis-controller", "./studio/authoring-actions",
  "./studio/annotation-controller", "./studio/editor-tabs", "./studio/condition-controller",
  "./studio/sequence-controller", "./studio/session-file-controller",
  "./studio/structure-edit-controller", "./studio/viewer-toolbar-controller",
  "./studio/trajectory-controller", "./viewers", "./style.css",
]);

interface Harness {
  instances: Record<string, unknown[]>;
  inspectCif: (cif: string) => unknown;
  viewerInitialized: boolean;
}

const harness: Harness = { instances: {}, inspectCif: () => ({ atom_count: 1, condition_categories: [] }), viewerInitialized: true };
(globalThis as { studioHarness?: Harness }).studioHarness = harness;

const stubSource = (specifier: string): string => {
  if (specifier.endsWith("annotation_studio_core.js")) {
    return `export default async function init() {}
      export function inspect_cif(cif) { return globalThis.studioHarness.inspectCif(cif); }`;
  }
  if (specifier === "./style.css") return "export {};";
  if (specifier === "./viewers") {
    return `export class MolecularViewer {
      get initialized() { return globalThis.studioHarness.viewerInitialized; }
      get backend() { return "molstar"; }
      get capabilities() { return {}; }
      async initialize() {}
      async loadCif() {}
      async loadCifs() {}
      async clearAllVisuals() {}
      async setMarkers() {}
      async switchBackend() {}
    }`;
  }
  return `
    const make = (name) => class {
      constructor(...args) {
        globalThis.studioHarness.instances[name] = args;
        return new Proxy(this, { get: (target, key) => key in target || key === "then" ? target[key] : () => undefined });
      }
    };
    ${["SelectionController", "AnalysisController", "AnnotationController", "ConditionController",
      "SequenceController", "SessionFileController", "StructureEditController",
      "ViewerToolbarController", "TrajectoryController"]
      .map((name) => `export const ${name} = make(${JSON.stringify(name)});`).join("\n")}
    export function initializeEditorTabs() {}
    export async function mutateWithConfirmation() { return null; }
  `;
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    const fromMain = context.parentURL?.split("?")[0].endsWith("/src/main.ts");
    if (specifier.endsWith("wasm/annotation_studio_core.js") || (fromMain && STUBBED_BY_MAIN.has(specifier))) {
      return { url: `stub:${specifier}`, shortCircuit: true };
    }
    if (specifier.startsWith(".") && !/\.[cm]?[jt]s(\?.*)?$|\.json$/.test(specifier) && context.parentURL) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context);
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("stub:")) {
      return { format: "module", shortCircuit: true, source: stubSource(url.slice("stub:".length)) };
    }
    const path = url.startsWith("file:") ? fileURLToPath(url.split("?")[0]) : "";
    if (path.endsWith(".ts") && !path.includes("/tests/")) {
      const source = readFileSync(path, "utf8").replaceAll("import.meta.env.PROD", "false");
      const { outputText } = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
        fileName: path,
      });
      return { format: "module", shortCircuit: true, source: outputText };
    }
    return nextLoad(url, context);
  },
});

class FakeElement {
  dataset: Record<string, string> = {};
  style = { setProperty() {}, removeProperty() {} };
  classList = { toggle() {}, add() {}, remove() {}, contains: () => false };
  hidden = false;
  disabled: boolean | undefined = undefined;
  inert = false;
  checked = false;
  value = "";
  textContent = "";
  addEventListener() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
  setAttribute() {}
  append() {}
  replaceChildren() {}
}

class MemoryStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, String(value)); }
  removeItem(key: string) { this.values.delete(key); }
}

type Route = (url: string, init?: RequestInit) => Response | undefined;
let elements = new Map<string, FakeElement>();

function resetEnvironment(route: Route, savedSession: string | null = null): void {
  elements = new Map();
  harness.instances = {};
  harness.inspectCif = () => ({ atom_count: 1, condition_categories: [] });
  const byId = (id: string) => elements.get(id) ?? elements.set(id, new FakeElement()).get(id)!;
  const fakeWindow = {
    location: { search: "", href: "http://studio.test/" },
    addEventListener() {},
    parent: null as unknown,
    innerWidth: 1024,
  };
  fakeWindow.parent = fakeWindow;
  Object.assign(globalThis, {
    window: fakeWindow,
    document: {
      body: new FakeElement(),
      getElementById: byId,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => new FakeElement(),
    },
    history: { replaceState() {} },
    sessionStorage: new MemoryStorage(),
    localStorage: new MemoryStorage(),
    fetch: async (input: string, init?: RequestInit) => {
      const response = route(String(input), init);
      if (!response) throw new Error(`Unexpected request ${init?.method ?? "GET"} ${input}`);
      return response;
    },
  });
  if (savedSession) sessionStorage.setItem("annotation-studio-session", savedSession);
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
});
const sessionResponse = (sessionId: string, name = "design") => ({
  session_id: sessionId,
  structure: { name, atom_count: 1, chain_ids: ["A"], sequence: [], annotations: [], validation: [], undo_depth: 0 },
});
const schemaRoute: Route = (url) => url.endsWith("/api/v1/schema")
  ? json({ editor_tabs: [], loading: { fields: {} }, bond_types: [] })
  : undefined;

let mainInstance = 0;
async function startStudio(): Promise<void> {
  await import(`../src/main.ts?instance=${++mainInstance}`);
  const status = () => elements.get("status")?.textContent ?? "";
  for (let attempt = 0; attempt < 200 && !/Ready\.|Restored|could not be displayed/.test(status()); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
}

type SessionOptions = { getSessionId: () => string | null; onOpened: (response: unknown) => Promise<void> };
const sessionOptions = () => harness.instances.SessionFileController[0] as SessionOptions;

test("an expired saved session is forgotten instead of staying active", async () => {
  resetEnvironment((url) => schemaRoute(url)
    ?? (url.endsWith("/api/v1/sessions/expired") ? json({ detail: "Unknown session" }, 404) : undefined), "expired");
  await startStudio();
  assert.equal(sessionOptions().getSessionId(), null);
  assert.equal(sessionStorage.getItem("annotation-studio-session"), null);
});

test("a renderer failure during restore keeps the live session savable", async () => {
  resetEnvironment((url) => schemaRoute(url)
    ?? (url.endsWith("/api/v1/sessions/live") ? json(sessionResponse("live")) : undefined)
    ?? (url.endsWith("/api/v1/sessions/live/cif") ? new Response("data_design\n") : undefined), "live");
  harness.inspectCif = () => { throw new Error("CIF parse error"); };
  await startStudio();
  assert.equal(sessionOptions().getSessionId(), "live");
  assert.equal(sessionStorage.getItem("annotation-studio-session"), "live");
  for (const id of ["download", "close-structure"]) assert.equal(elements.get(id)?.disabled, false, id);
});

test("an opened session stays savable and closable when it cannot be displayed", async () => {
  resetEnvironment((url) => schemaRoute(url)
    ?? (url.endsWith("/api/v1/sessions/opened/cif") ? new Response("data_design\n") : undefined));
  await startStudio();
  harness.inspectCif = () => { throw new Error("CIF parse error"); };
  await assert.rejects(sessionOptions().onOpened(sessionResponse("opened")), /CIF parse error/);
  assert.equal(sessionOptions().getSessionId(), "opened");
  assert.equal(sessionStorage.getItem("annotation-studio-session"), "opened");
  for (const id of ["download", "close-structure"]) assert.equal(elements.get(id)?.disabled, false, id);
});

test("combine posts and refreshes inside the viewer update queue", async () => {
  let queued = false;
  const events: string[] = [];
  resetEnvironment((url, init) => {
    if (url.endsWith("/api/v1/sessions") && init?.method === "POST") return json(sessionResponse("imported", "part"));
    if (url.endsWith("/api/v1/sessions/target/combine")) {
      events.push(`combine:${queued}`);
      return json(sessionResponse("target"));
    }
    if (url.endsWith("/api/v1/sessions/imported") && init?.method === "DELETE") return new Response(null, { status: 204 });
    return undefined;
  });
  const { SessionFileController } = await import("../src/studio/session-file-controller.ts");
  const controller = new SessionFileController({
    getSessionId: () => "target",
    onOpened: async () => {},
    onCombined: async () => { events.push(`refresh:${queued}`); },
    log: (message: string, level?: string) => { if (level === "error") events.push(`error:${message}`); },
    runViewerUpdate: async (operation: () => Promise<void>) => {
      queued = true;
      try { await operation(); } finally { queued = false; }
    },
  });
  const open = (controller as unknown as {
    openFile(file: File, target: string, annotated: boolean): Promise<boolean>;
  }).openFile.bind(controller);
  assert.equal(await open(new File(["data_part\n"], "part.cif"), "target", true), true);
  assert.deepEqual(events, ["combine:true", "refresh:true"]);
});

// Embed the studio in a host frame and record the ready/changed notifications it posts upward.
type HostMessage = { source?: string; type?: string; session_id?: string };
function embedInHost(parentOrigin = "http://host.test"): HostMessage[] {
  const messages: HostMessage[] = [];
  const win = globalThis.window as unknown as { location: { search: string }; parent: unknown };
  win.location.search = `?parent_origin=${encodeURIComponent(parentOrigin)}`;
  win.parent = { postMessage: (message: HostMessage) => { messages.push(message); } };
  return messages;
}
const readyNotifications = (messages: HostMessage[]) => messages.filter((message) => message.type === "ready");

test("a terminal display failure during restore notifies the host exactly once", async () => {
  resetEnvironment((url) => schemaRoute(url)
    ?? (url.endsWith("/api/v1/sessions/live") ? json(sessionResponse("live")) : undefined)
    ?? (url.endsWith("/api/v1/sessions/live/cif") ? new Response("data_design\n") : undefined), "live");
  const messages = embedInHost();
  harness.inspectCif = () => { throw new Error("CIF parse error"); };
  await startStudio();
  const ready = readyNotifications(messages);
  assert.equal(ready.length, 1);
  assert.equal(ready[0].session_id, "live");
});

test("a terminal display failure on open notifies the host exactly once", async () => {
  resetEnvironment((url) => schemaRoute(url)
    ?? (url.endsWith("/api/v1/sessions/opened/cif") ? new Response("data_design\n") : undefined));
  const messages = embedInHost();
  await startStudio();
  harness.inspectCif = () => { throw new Error("CIF parse error"); };
  await assert.rejects(sessionOptions().onOpened(sessionResponse("opened")), /CIF parse error/);
  const ready = readyNotifications(messages);
  assert.equal(ready.length, 1);
  assert.equal(ready[0].session_id, "opened");
});

test("a recovered display failure on open notifies the host exactly once", async () => {
  resetEnvironment((url) => schemaRoute(url)
    ?? (url.endsWith("/api/v1/sessions/opened/cif") ? new Response("data_design\n") : undefined));
  const messages = embedInHost();
  await startStudio();
  // The first two refresh attempts fail with a recoverable Patinae error; recovery then succeeds.
  let attempts = 0;
  harness.inspectCif = () => {
    attempts += 1;
    if (attempts <= 2) throw new Error("Patinae viewer stopped after WASM call");
    return { atom_count: 1, condition_categories: [] };
  };
  const recovered = sessionResponse("opened");
  (recovered.structure as { condition_editors?: unknown }).condition_editors = { centroids: {} };
  await sessionOptions().onOpened(recovered);
  const ready = readyNotifications(messages);
  assert.equal(ready.length, 1);
  assert.equal(ready[0].session_id, "opened");
});
