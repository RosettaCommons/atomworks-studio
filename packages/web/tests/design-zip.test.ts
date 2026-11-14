import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pdbSequences, resultsFiles } from "../src/design-card/results.ts";
import type { ResultsRefold } from "../src/design-card/results.ts";
import { crc32, zipStore } from "../src/design-card/zip.ts";

const has = (cmd: string, args: string[]): boolean => spawnSync(cmd, args, { stdio: "ignore" }).status === 0;

test("crc32 of the standard check string", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});

/** The central directory read back: name, size, crc, local header offset. */
function readDirectory(zip: Uint8Array) {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const eocd = zip.length - 22;
  assert.equal(view.getUint32(eocd, true), 0x06054b50);
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const out = [];
  for (let k = 0; k < count; k += 1) {
    assert.equal(view.getUint32(at, true), 0x02014b50);
    const nameLength = view.getUint16(at + 28, true);
    const offset = view.getUint32(at + 42, true);
    const size = view.getUint32(at + 24, true);
    const name = new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLength));
    assert.equal(view.getUint32(offset, true), 0x04034b50);
    const start = offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true);
    out.push({ name, size, crc: view.getUint32(at + 16, true), data: zip.subarray(start, start + size) });
    at += 46 + nameLength;
  }
  return out;
}

const FILES = [
  { name: "run/a.cif", data: "data_a\n" },
  { name: "run/é-ünï.txt", data: "héllo" },
  { name: "run/bin.dat", data: Uint8Array.from([0, 1, 2, 255, 254]) },
  { name: "run/empty.txt", data: "" },
];

test("zipStore writes a readable central directory", () => {
  const entries = readDirectory(zipStore(FILES));
  assert.deepEqual(entries.map((e) => e.name), FILES.map((f) => f.name));
  assert.equal(new TextDecoder().decode(entries[1].data), "héllo");
  assert.deepEqual([...entries[2].data], [0, 1, 2, 255, 254]);
  for (const e of entries) assert.equal(crc32(e.data), e.crc);
});

test("zipStore output passes unzip -t and python's zipfile", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "zip-"));
  const path = join(dir, "out.zip");
  writeFileSync(path, zipStore(FILES));
  let ran = false;
  if (has("unzip", ["-v"])) {
    ran = true;
    const r = spawnSync("unzip", ["-t", path], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /No errors detected/);
  }
  if (has("python3", ["-V"])) {
    ran = true;
    const script = "import sys,zipfile\nz=zipfile.ZipFile(sys.argv[1])\nassert z.testzip() is None\n"
      + "print('|'.join(z.namelist()))\nprint(z.read('run/a.cif').decode(), end='')\n";
    const r = spawnSync("python3", ["-I", "-c", script, path], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `${FILES.map((f) => f.name).join("|")}\ndata_a\n`);
  }
  if (!ran) t.skip("neither unzip nor python3 available");
  assert.ok(readFileSync(path).length > 0);
});

const atom = (serial: number, name: string, res: string, chain: string, resId: number): string =>
  `ATOM  ${String(serial).padStart(5)} ${name.padEnd(4)} ${res} ${chain}${String(resId).padStart(4)}    ${"1.000".padStart(8)}${"2.000".padStart(8)}${"3.000".padStart(8)}  1.00 90.00           ${name[0]}`;
const pdb = [atom(1, "N", "MET", "A", 1), atom(2, "CA", "MET", "A", 1), atom(3, "CA", "LYS", "A", 2), atom(4, "CA", "GLY", "B", 1)].join("\n");

test("pdbSequences reads one letter per residue, per chain", () => {
  assert.deepEqual(pdbSequences(pdb), { A: "MK", B: "G" });
  assert.deepEqual(pdbSequences(null), {});
});

test("resultsFiles packages input, designs, trajectories, every refold and a summary, as mmCIF only", () => {
  const refold = (model: string, rmsd: number): ResultsRefold => ({
    model, cif: "data_r", rmsd, confidence: { meanPlddt: 80.123, ptm: 0.8, iptm: 0.61 },
    templated: ["A"], partial: [{ chain: "H", residues: 109 }], text: "line",
  });
  const files = resultsFiles({
    input: { cif: "data_in", name: "antibody", revision: 3 },
    designs: [
      { index: 1, label: "Design 1", seed: 7, stepsRun: 50, nsteps: 60, cif: "data_d1", pdb, trajectoryCif: "data_t1",
        designedChains: ["B"], refolds: [refold("af3", 0.5), refold("openbind0", 1.2), refold("af3", 0.7)] },
      { index: 2, label: "Design 2", seed: 8, cif: "data_d2", pdb: null },
    ],
    generatedAt: "2026-10-30T00:00:00Z",
  });
  const names = files.map((f) => f.name);
  assert.deepEqual(names, [
    "input.cif",
    "design-1.cif", "design-1-trajectory.cif",
    "design-1-refold-af3.cif", "design-1-refold-openbind0.cif", "design-1-refold-af3-2.cif",
    "design-2.cif",
    "summary.json", "summary.csv", "README.txt",
  ]);
  const text = (name: string): string => files.find((f) => f.name === name)!.text;
  const summary = JSON.parse(text("summary.json"));
  assert.equal(summary.input.revision, 3);
  assert.equal(summary.designs[0].refolds.length, 3);
  assert.deepEqual(summary.designs[0].sequences, { A: "MK", B: "G" });
  assert.equal(summary.designs[0].refolds[0].plddt, 80.12);
  assert.equal(summary.designs[0].refolds[1].model_name, "OpenBind-0");
  const csv = text("summary.csv").trim().split("\n");
  assert.equal(csv.length, 1 + 3 + 1);
  // no metrics on these refolds: RMSD on target, designed-chain pTM, min iPAE, the motif RMSDs and the verdict are left empty
  assert.ok(csv[1].startsWith("1,7,50,B,A:MK B:G,af3,0,,,0.5,,80.12,0.8,0.61,,,,,,A,H:109"), "refold seed 0 when none was given");
  for (const col of ["rmsd_on_target", "min_ipae", "passes", "motif_rmsd", "motif_backbone_aligned_rmsd"]) assert.ok(csv[0].includes(col), col);
  assert.match(text("README.txt"), /WEIGHTS_TERMS_OF_USE/);
  assert.match(text("README.txt"), /WEIGHTS_PROHIBITED_USE_POLICY/);
  assert.match(text("README.txt"), /^Design results\n/);
  assert.ok(!names.some((n) => n.endsWith(".pdb")));
});

test("without AlphaFold 3 refolds the README carries no AlphaFold 3 terms", () => {
  const files = resultsFiles({ input: null, designs: [{ index: 1, label: "Design 1", cif: "x", pdb: null }] });
  assert.ok(!/AlphaFold 3/.test(files.find((f) => f.name === "README.txt")!.text));
  assert.ok(!files.some((f) => f.name === "input.cif"));
});

test("a refold's own numbers, a title and the host's extra files", () => {
  const files = resultsFiles({
    input: null, title: "RFD4-Proteina (WebGPU) results", generatedAt: "2026-11-11T00:00:00Z",
    designs: [{ index: 1, label: "seed 3", seed: 3, cif: "data_d", designedChains: ["B"],
      refolds: [{ model: "openbind0", seed: 3, recycles: 3, steps: 25, cif: "data_refold", rmsd: 1.1, pass: true,
        confidence: { meanPlddt: 91, ptm: 0.9 }, metrics: { minIpae: 1.4, placedRmsd: Number.NaN }, templated: ["A"] }] }],
    extraFiles: [{ name: "engine.log", text: "ok" }],
  });
  assert.ok(files.some((f) => f.name === "design-1-refold-openbind0.cif" && f.text === "data_refold"));
  assert.deepEqual(files.at(-1), { name: "engine.log", text: "ok" });
  assert.match(files.find((f) => f.name === "README.txt")!.text, /^RFD4-Proteina \(WebGPU\) results\n/);
  const [refold] = JSON.parse(files.find((f) => f.name === "summary.json")!.text).designs[0].refolds;
  assert.deepEqual([refold.model_name, refold.seed, refold.recycles, refold.steps], ["OpenBind-0", 3, 3, 25]);
  assert.deepEqual([refold.rmsd_designed_chain, refold.plddt, refold.ptm, refold.min_ipae, refold.rmsd_on_target, refold.passes],
    [1.1, 91, 0.9, 1.4, null, true]);
});
