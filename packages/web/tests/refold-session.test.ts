import assert from "node:assert/strict";
import test from "node:test";
import { passes, rankKey } from "../src/refold/criteria.ts";
import { ALPHAFOLD3_TERMS, resolveModel } from "../src/refold/presets.ts";
import { RefoldSession, resolveLimits, type RefoldStorage, type TermsAnswer } from "../src/refold/session.ts";
import type { RefoldDesign, RefoldProvider, RefoldSettings } from "../src/refold/types.ts";

function memoryStorage(): RefoldStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, get: (key) => data.get(key) ?? null, set: (key, value) => { data.set(key, value); } };
}

type Harness = {
  session: RefoldSession;
  storage: ReturnType<typeof memoryStorage>;
  folded: { id: string; settings: RefoldSettings }[];
  asked: string[];
  revealed: string[];
  prepared: string[];
  answers: TermsAnswer[];
};

function harness(provider: Partial<RefoldProvider> = {}, designs: RefoldDesign[] = []): Harness {
  const storage = memoryStorage();
  const state: Harness = { storage, folded: [], asked: [], revealed: [], prepared: [], answers: [] } as unknown as Harness;
  const full: RefoldProvider = {
    models: [{ id: "af3" }, { id: "openbind0" }],
    async refold(design, settings) {
      state.folded.push({ id: design.id, settings });
      return { cif: `refold of ${design.id}`, metrics: { rmsd: 1.0, plddt: 90 }, text: "ok" };
    },
    prepare: async (model) => { state.prepared.push(model); },
    ...provider,
  };
  state.session = new RefoldSession({
    provider: full,
    storage,
    askTerms: async (model) => { state.asked.push(model.id); return state.answers.shift() ?? "cancel"; },
    reveal: (id) => { state.revealed.push(id); state.session.selectedId = id; },
  });
  state.session.setDesigns(designs);
  return state;
}

const designs = (n: number, kind: RefoldDesign["kind"] = "monomer"): RefoldDesign[] =>
  Array.from({ length: n }, (_, k) => ({ id: `s${k + 1}`, name: String(100 + k), kind, cif: "data_x" }));

test("defaults and option sets are the reference page's", () => {
  const limits = resolveLimits(undefined);
  assert.deepEqual(limits.recycles.options, [0, 1, 2, 3, 5, 10]);
  assert.equal(limits.recycles.default, 3);
  assert.deepEqual(limits.steps.options, [25, 50, 100, 200]);
  assert.equal(limits.steps.default, 25);
  assert.deepEqual([limits.seed.min, limits.seed.max, limits.seed.default], [0, 4294967295, 0]);
  assert.match(limits.steps.title, /25 is LocalFold's default, 200 AlphaFold 3's own/);
  const { session } = harness();
  assert.deepEqual(session.settings, { model: "af3", seed: 0, recycles: 3, steps: 25 });
});

test("a provider's limits replace the choices and an unlisted default falls back", () => {
  const limits = resolveLimits({ steps: { options: [10, 20], default: 99 }, recycles: { options: [1], default: 1 }, seed: { max: 9 } });
  assert.deepEqual(limits.steps.options, [10, 20]);
  assert.equal(limits.steps.default, 10);
  assert.equal(limits.seed.max, 9);
  const { session } = harness({ limits: { seed: { max: 9 } } });
  session.setSettings({ seed: 50 });
  assert.equal(session.settings.seed, 9, "a seed above the limit is clamped");
  session.setSettings({ steps: 77 });
  assert.equal(session.settings.steps, 25, "a value the box does not offer keeps the default");
});

test("known model ids are completed from Studio's presets, and AlphaFold 3 is the gated one", () => {
  const af3 = resolveModel({ id: "af3" });
  assert.equal(af3.label, "AlphaFold 3");
  assert.equal(af3.terms, ALPHAFOLD3_TERMS);
  assert.equal(resolveModel({ id: "openbind0" }).terms, undefined);
  assert.equal(resolveModel({ id: "af3", terms: null }).terms, undefined, "a host that hosts its own weights can drop the gate");
  assert.equal(resolveModel({ id: "mine", label: "Mine", terms: "alphafold3" }).terms, ALPHAFOLD3_TERMS);
  assert.throws(() => resolveModel({ id: "x", terms: "nonsense" }), /Unknown refold terms/);
  assert.equal(ALPHAFOLD3_TERMS.paragraphs[0],
    "These are Google DeepMind's parameters. They are not available for commercial use and carry a prohibited-use policy.");
  assert.equal(ALPHAFOLD3_TERMS.switchTo?.label, "Use OpenBind-0");
  assert.equal(ALPHAFOLD3_TERMS.agreeLabel, "I agree, use AlphaFold 3");
});

test("pass criteria follow upstream's thresholds", () => {
  assert.equal(passes({ rmsd: 1.5 }, "monomer"), true);
  assert.equal(passes({ rmsd: 1.51 }, "monomer"), false);
  assert.equal(passes({ chainPtm: 0.8, minIpae: 1.5, placedRmsd: 2.5 }, "binder"), true);
  assert.equal(passes({ chainPtm: 0.79, minIpae: 1.5, placedRmsd: 2.5 }, "binder"), false);
  assert.equal(passes({ minIpae: 2, placedRmsd: 2.01 }, "antibody"), false);
  assert.equal(passes({ rmsd: null }, "monomer"), null, "a missing number is no verdict");
  assert.equal(passes({ rmsd: 0.1 }, null), null, "no criteria, no verdict");
  assert.deepEqual(rankKey("binder"), { key: "minIpae", dir: 1 });
  assert.deepEqual(rankKey(null), { key: "plddt", dir: -1 });
});

test("Refold all folds each pending design once, in order, with the settings in the box", async () => {
  const h = harness({}, designs(3));
  h.storage.set(ALPHAFOLD3_TERMS.storageKey, "accepted");
  h.session.setSettings({ seed: 7, recycles: 5, steps: 50 });
  assert.deepEqual(h.session.pending(), ["s1", "s2", "s3"]);
  await h.session.run(null);
  assert.deepEqual(h.folded.map((f) => f.id), ["s1", "s2", "s3"]);
  assert.deepEqual(h.folded[0].settings, { model: "af3", seed: 7, recycles: 5, steps: 50 });
  assert.deepEqual(h.session.pending(), []);
  assert.equal(h.session.button().disabled, true);
  assert.equal(h.session.records("s2")[0].pass, true, "rmsd 1.0 meets the monomer criterion");
  assert.equal(h.session.metric("s1", "plddt"), 90);
  assert.deepEqual(h.revealed, ["s1", "s2", "s3"], "each refold is shown as it finishes");

  // Same settings: nothing is folded again.
  await h.session.run(null);
  assert.equal(h.folded.length, 3);
  assert.equal(h.session.button().label, "All refolded with these settings");

  // Another seed folds them again; going back brings the first results back without folding.
  h.session.setSettings({ seed: 8 });
  assert.deepEqual(h.session.pending(), ["s1", "s2", "s3"]);
  await h.session.run(["s2"]);
  assert.equal(h.folded.length, 4);
  assert.equal(h.session.records("s2").length, 2);
  h.session.setSettings({ seed: 7 });
  assert.equal(h.session.shown("s2"), h.session.records("s2")[0], "settings changed back: the earlier refold is shown");
});

test("Stop ends the queue and the current fold sees its signal abort", async () => {
  let signal: AbortSignal | undefined;
  let release: () => void = () => {};
  const h = harness({
    async refold(design, _settings, context) {
      signal = context.signal;
      await new Promise<void>((resolve) => { release = resolve; context.signal.addEventListener("abort", () => resolve()); });
      if (context.signal.aborted) throw new Error("aborted");
      return { cif: "x", metrics: { rmsd: 1 } };
    },
  }, designs(3));
  h.storage.set(ALPHAFOLD3_TERMS.storageKey, "accepted");
  const finished = h.session.run(null);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(h.session.isRunning, true);
  assert.equal(h.session.runningId, "s1");
  assert.ok(h.session.isQueued("s2"));
  assert.match(h.session.button().label, /^Stop · 100 \(1 of 3\)/);
  await h.session.run(null); // pressed again: Stop
  await finished;
  assert.equal(signal?.aborted, true);
  assert.equal(h.session.isRunning, false);
  assert.equal(h.session.errorLine(), null, "stopping is not a failure");
  assert.deepEqual(h.session.pending(), ["s1", "s2", "s3"]);
  release();
});

test("progress fills the button within each design's share", async () => {
  const labels: string[] = [];
  const h = harness({
    async refold(_design, _settings, context) {
      context.onStatus({ text: "recycle 1", fraction: 0.4 });
      labels.push(h.session.button().label + "|" + h.session.button().fraction);
      context.onStatus("trunk · 80%");
      labels.push(h.session.button().label + "|" + h.session.button().fraction);
      return { cif: "x", metrics: {} };
    },
  }, designs(2));
  h.storage.set(ALPHAFOLD3_TERMS.storageKey, "accepted");
  await h.session.run(null);
  assert.deepEqual(labels, ["Stop · 100 (1 of 2) · 40%|0.2", "Stop · 100 (1 of 2) · 80%|0.4",
    "Stop · 101 (2 of 2) · 40%|0.7", "Stop · 101 (2 of 2) · 80%|0.9"]);
});

test("a failed fold is counted, named in the line, and does not stop the others", async () => {
  const h = harness({
    async refold(design) {
      if (design.id === "s2") throw new Error("boom");
      return { cif: "x", metrics: { rmsd: 1 } };
    },
  }, designs(3));
  h.storage.set(ALPHAFOLD3_TERMS.storageKey, "accepted");
  const log = console.error;
  console.error = () => {};
  try { await h.session.run(null); } finally { console.error = log; }
  assert.equal(h.session.errorLine(), "Refolded 2 designs with AlphaFold 3; 1 failed.");
  assert.equal(h.session.failed("s2"), true);
  assert.deepEqual(h.session.pending(), ["s2"]);
});

test("a provider that throws in prepare reports one failure line", async () => {
  const h = harness({ prepare: async () => { throw new Error("WebGPU is not available"); } }, designs(1));
  h.storage.set(ALPHAFOLD3_TERMS.storageKey, "accepted");
  const log = console.error;
  console.error = () => {};
  try { await h.session.run(null); } finally { console.error = log; }
  assert.equal(h.session.errorLine(), "Refold failed: WebGPU is not available");
  assert.equal(h.folded.length, 0);
});

test("AlphaFold 3 asks for its terms first; Cancel folds nothing, switching folds with OpenBind-0, agreeing is remembered", async () => {
  const h = harness({}, designs(1));
  h.answers.push("cancel");
  await h.session.run(null);
  assert.deepEqual(h.asked, ["af3"]);
  assert.equal(h.folded.length, 0);
  assert.equal(h.session.settings.model, "af3", "Cancel leaves the model as it was");
  assert.equal(h.storage.data.size, 0);

  h.answers.push("switch");
  await h.session.run(null);
  assert.equal(h.session.settings.model, "openbind0", "the box follows the switch");
  assert.equal(h.folded[0].settings.model, "openbind0");
  assert.equal(h.storage.data.size, 0, "switching does not record agreement");

  h.session.setSettings({ model: "af3" });
  h.answers.push("accept");
  await h.session.run(null);
  assert.equal(h.storage.data.get(ALPHAFOLD3_TERMS.storageKey), "accepted");
  assert.equal(h.folded[1].settings.model, "af3");
  h.session.setSettings({ seed: 1 });
  await h.session.run(null);
  assert.deepEqual(h.asked, ["af3", "af3", "af3"], "agreement is not asked again once given");
});

test("OpenBind-0 never shows the dialog", async () => {
  const h = harness({}, designs(1));
  h.session.setSettings({ model: "openbind0" });
  await h.session.run(null);
  assert.deepEqual(h.asked, []);
  assert.equal(h.folded.length, 1);
});

test("parameters are not fetched for AlphaFold 3 until its terms are agreed to", async () => {
  const h = harness({}, designs(1));
  h.session.prefetch();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(h.prepared, [], "AlphaFold 3 is selected and not agreed to");
  h.session.setSettings({ model: "openbind0" });
  h.session.prefetch();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(h.prepared, ["openbind0"]);
  h.session.prefetch();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(h.prepared, ["openbind0"], "once per model");
  h.session.setSettings({ model: "af3" });
  h.storage.set(ALPHAFOLD3_TERMS.storageKey, "accepted");
  h.session.prefetch();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(h.prepared, ["openbind0", "af3"]);
});

test("the button says how much of the parameters have come down", async () => {
  let report: (p: { loadedBytes: number; totalBytes: number }) => void = () => {};
  let finish: () => void = () => {};
  const h = harness({
    prepare: (_model, onProgress) => new Promise<void>((resolve) => { report = onProgress; finish = resolve; }),
  }, designs(1));
  h.session.setSettings({ model: "openbind0" });
  h.session.prefetch();
  report({ loadedBytes: 50e6, totalBytes: 200e6 });
  const button = h.session.button();
  assert.equal(button.label, "Refold all · OpenBind-0 50 / 200 MB");
  assert.equal(button.fraction, 0.25);
  assert.match(button.title, /Downloading OpenBind-0 parameters/);
  finish();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(h.session.button().label, "Refold all");
});

test("designs keep their refolds across a new list and lose them when they go", async () => {
  const h = harness({}, designs(2));
  h.storage.set(ALPHAFOLD3_TERMS.storageKey, "accepted");
  await h.session.run(null);
  h.session.setDesigns([...designs(3)]);
  assert.equal(h.session.records("s1").length, 1);
  assert.deepEqual(h.session.pending(), ["s3"]);
  h.session.setDesigns([designs(3)[2]]);
  assert.equal(h.session.records("s1").length, 0);
});
