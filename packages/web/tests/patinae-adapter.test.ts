import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { AtomIdentity } from "@baker-laboratory/patinae-viewer";
import ts from "typescript";

const STUB_URL = "stub:patinae-viewer";

interface StubState {
  executed: string[];
  identities: AtomIdentity[];
  objects: string[];
  handlers: Map<string, (data: unknown) => void>;
}

const state: StubState = { executed: [], identities: [], objects: [], handlers: new Map() };
(globalThis as { patinaeStub?: StubState }).patinaeStub = state;

// Load the real adapter against a recording PatinaeViewer; the WebGPU build cannot run in Node.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@baker-laboratory/patinae-viewer") return { url: STUB_URL, shortCircuit: true };
    if (specifier.startsWith(".") && !/\.[cm]?[jt]s$|\.json$/.test(specifier) && context.parentURL) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context);
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("file:") && url.endsWith(".ts")) {
      // Node's type stripping cannot load parameter properties, so transpile sources here.
      const { outputText } = ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
        fileName: fileURLToPath(url),
      });
      return { format: "module", shortCircuit: true, source: outputText };
    }
    if (url !== STUB_URL) return nextLoad(url, context);
    return {
      format: "module",
      shortCircuit: true,
      source: `
        const state = globalThis.patinaeStub;
        const ok = { result: { Ok: null }, task_ids: [], messages: [] };
        export function parseAtomSiteBooleanColumn() { return []; }
        export class PatinaeViewer {
          tasks = { wait: async () => ({ state: "succeeded" }) };
          async init() {}
          on(event, callback) { state.handlers.set(event, callback); }
          execute(command) {
            state.executed.push(command);
            const match = /^delete (\\S+)$/.exec(command);
            if (match) state.objects = state.objects.filter((name) => name !== match[1]);
            return Promise.resolve(ok);
          }
          loadData(_data, name) { state.objects.push(name); return ok; }
          getObjectNames() { return [...state.objects]; }
          getAtomIdentityMap() { return state.identities; }
          countAtoms(selection) {
            const ranges = (/index (\\S+)/.exec(selection)?.[1] ?? "").split("+").filter(Boolean);
            return ranges.reduce((sum, range) => {
              const [start, stop = start] = range.split("-").map(Number);
              return sum + stop - start + 1;
            }, 0);
          }
          getMovieState() { return { frame_count: 1 }; }
          getMeasurementList() { return []; }
          addMeasurements() { return []; }
          removeMeasurements() {}
          destroy() {}
        }
      `,
    };
  },
});

const { PatinaeAdapter } = await import("../src/viewers/patinae.ts");
const { MolecularViewer } = await import("../src/viewers/index.ts");

function identities(objectName: string, count: number): AtomIdentity[] {
  return Array.from({ length: count }, (_, index) => ({
    document_index: index,
    object_name: objectName,
    atom_index: index,
    source_atom_id: index + 1,
    atom_name: "C",
    element: "C",
    chain_id: "A",
    residue_name: "GLY",
    residue_number: 1,
    insertion_code: "",
    alternate_location: "",
  }));
}

async function createAdapter(picks: unknown[] = []) {
  state.executed = [];
  state.objects = [];
  state.handlers.clear();
  state.identities = identities("design", 4);
  Object.defineProperty(globalThis.navigator, "gpu", {
    configurable: true,
    value: { requestAdapter: async () => ({ isFallbackAdapter: false }) },
  });
  const adapter = new PatinaeAdapter({
    container: { dataset: {} } as HTMLElement,
    onPick: (pick) => picks.push(pick),
  });
  await adapter.initialize();
  return adapter;
}

const colorCommands = () => state.executed.filter((command) => command.startsWith("color "));

test("selection colors replay on the atoms selected when the color was applied", async () => {
  const adapter = await createAdapter();
  await adapter.loadCif("data_design\n", "design");
  adapter.setSelection([0]);
  adapter.setColor("red", "selection");
  adapter.setSelection([3]);
  state.executed = [];
  await adapter.showAnnotation([]);
  assert.deepEqual(colorCommands(), ["color atomic", "color red, index 0"]);
});

test("coloring all atoms supersedes earlier colors instead of growing the replay list", async () => {
  const adapter = await createAdapter();
  await adapter.loadCif("data_design\n", "design");
  adapter.setSelection([1, 2]);
  adapter.setColor("red", "selection");
  for (let click = 0; click < 5; click += 1) adapter.setColor("blue", "all");
  state.executed = [];
  await adapter.clearAnnotation();
  assert.deepEqual(colorCommands(), ["color atomic", "color blue, all"]);
});

test("opening another document drops colors from the previous one", async () => {
  state.identities = identities("design", 4);
  const viewer = new MolecularViewer(
    { dataset: {}, replaceChildren() {} } as unknown as HTMLElement,
    { textContent: "" } as HTMLElement,
    "patinae",
    () => {},
  );
  await viewer.initialize();
  await viewer.loadCif("data_design\n", "design");
  viewer.setSelection([0]);
  viewer.setColor("red", "selection");
  viewer.setColor("green", "all");
  await viewer.clearAllVisuals();
  state.executed = [];
  await viewer.loadCif("data_other\n", "other");
  assert.deepEqual(colorCommands(), ["color atomic"]);
});

test("picks on objects outside the document identity map are ignored", async () => {
  const picks: unknown[] = [];
  const adapter = await createAdapter(picks);
  await adapter.loadCif("data_design\n", "design");
  const pick = state.handlers.get("atom-picked")!;
  pick({ object_name: "site", atom_index: 0, chain: "A", residue: 1, expression: null });
  assert.deepEqual(picks, []);
  pick({ object_name: "design", atom_index: 2, chain: "A", residue: 1, expression: null });
  assert.deepEqual(picks, [{ atomIndex: 2, label: "A/1: atom 2" }]);
});
