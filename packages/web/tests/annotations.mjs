import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { chromiumLaunchOptions } from "../../../scripts/browser.mjs";

const base = process.env.ANNOTATION_STUDIO_URL ?? "http://127.0.0.1:8000/";
const backend = process.env.VIEWER_MODE;
assert.ok(["patinae", "molstar"].includes(backend));
const browser = await chromium.launch(chromiumLaunchOptions());
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${base}?viewer=${backend}`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => document.querySelector("#status")?.textContent?.includes("Ready."));
  await page.locator("#editor-tab-annotations").click();
  assert.equal(await page.getByRole("heading", { name: "Conditions on this structure" }).isVisible(), true);
  assert.equal(await page.locator("#annotation-search").count(), 0);
  for (const key of ["sequence", "coordinate", "index", "distance", "hotspot"]) {
    assert.equal(await page.locator(`#condition option[value="${key}"]`).count(), 1, `${key} is installed`);
  }
  const fixture = fileURLToPath(new URL("../../../tests/fixtures/minimal_multichain.cif", import.meta.url));
  async function upload(file) {
    const response = page.waitForResponse(r => r.url().endsWith("/sessions") && r.request().method() === "POST");
    await page.locator("#file-input").setInputFiles(file);
    const result = await response;
    assert.equal(result.status(), 200, await result.text());
    await page.waitForFunction(() => !document.querySelector("#download").disabled && !document.querySelector("#viewer-mode").disabled);
    return result.json();
  }
  async function select(expression) {
    await page.locator("#selection-syntax").selectOption("expression");
    await page.locator("#viewer-command").fill(expression);
    const response = page.waitForResponse(r => r.url().endsWith("/selections/query"));
    await page.locator("#run-viewer-command").click();
    const selected = await (await response).json();
    await page.waitForFunction(count => document.querySelector("#selection-count")?.textContent?.startsWith(`${count} atom`), selected.count);
    await page.waitForFunction(() => !document.querySelector("#apply-condition").disabled);
  }
  async function apply(enabled) {
    const index = await page.locator("#condition").inputValue() === "index";
    if (!index) await page.locator("#enabled").setChecked(enabled);
    const response = page.waitForResponse(r => r.url().endsWith("/conditions") && r.request().method() === "POST");
    await page.locator(index ? (enabled ? "#unindex-selection" : "#restore-indexing") : "#apply-condition").click();
    const result = await response;
    assert.equal(result.status(), 200, await result.text());
    await page.waitForFunction(() => !document.querySelector("#viewer-mode").disabled);
    return result.json();
  }
  for (const key of ["sequence", "coordinate", "index", "hotspot"]) {
    await upload(fixture);
    await page.locator("#condition").selectOption(key);
    await select("atom_name != ''");
    await apply(false);
    await select("chain_id == 'A'");
    const result = await apply(true);
    assert.equal(result.structure.condition_counts[key], ["coordinate", "hotspot"].includes(key) ? 2 : 1);
    const row = page.locator(`[data-view-key="annotations/${key}"]`);
    assert.equal(await row.isVisible(), true, "active conditions can be browsed without searching");
    assert.equal(await page.locator("#annotation-list details").count(), 0);
    await row.click();
    await page.waitForFunction(() => document.querySelector("#viewer")?.dataset.annotationAtoms === "2");
    assert.match(await page.locator("#selection-count").innerText(), /^0 atoms/);
    const download = page.waitForEvent("download");
    const checkedExport = page.waitForResponse(r => r.url().endsWith("/export"));
    await page.locator("#download").click();
    if ((await (await checkedExport).json()).issues.length) {
      await page.locator('dialog.confirmation button[value="confirm"]').click();
    }
    const chunks = [];
    for await (const chunk of await (await download).createReadStream()) chunks.push(chunk);
    await select("chain_id == 'A'");
    await apply(false);
    assert.equal(await row.count(), 0);
    const undone = page.waitForResponse(r => r.url().endsWith("/undo"));
    await page.locator("#undo").click();
    assert.equal((await (await undone).json()).structure.condition_counts[key], result.structure.condition_counts[key]);
    await page.waitForFunction(() => !document.querySelector("#viewer-mode").disabled);
    const reopened = await upload({ name: "annotated.cif", mimeType: "chemical/x-mmcif", buffer: Buffer.concat(chunks) });
    assert.equal(reopened.structure.condition_counts[key], result.structure.condition_counts[key]);
    console.log(`${backend}: ${key} apply, inspect, remove, Undo, save/reopen passed`);
  }
  await upload(fixture);
  await page.locator("#condition").selectOption("distance");
  await select("chain_id == 'A'");
  await page.locator("#pair-use-selection").click();
  await page.waitForFunction(() => document.querySelector("#pair-atom-0")?.textContent?.includes("GLY"));
  await page.locator("#pair-distance").fill("3.5");
  await page.locator("#pair-add").click();
  async function applyPairs() {
    const response = page.waitForResponse(r => r.url().endsWith("/distance-restraints/replace"));
    await page.locator("#pair-apply").click();
    const result = await response;
    assert.equal(result.status(), 200, await result.text());
    await page.waitForFunction(() => !document.querySelector("#viewer-mode").disabled);
    return result.json();
  }
  const restrained = await applyPairs();
  assert.equal(restrained.structure.condition_counts.distance, 1);
  await page.locator('[data-view-key="annotations/distance"]').click();
  await page.waitForFunction(() => document.querySelector("#viewer")?.dataset.annotationAtoms === "2");
  await page.locator("#pair-clear").click();
  assert.equal((await applyPairs()).structure.condition_counts.distance ?? 0, 0);
  const restoredPairs = page.waitForResponse(r => r.url().endsWith("/undo"));
  await page.locator("#undo").click();
  assert.equal((await (await restoredPairs).json()).structure.condition_counts.distance, 1);
  await page.waitForFunction(() => !document.querySelector("#viewer-mode").disabled);
  console.log(`${backend}: distance restraint add, inspect, clear and Undo passed`);
  await page.locator("#condition").selectOption("sequence");
  await select("chain_id == 'A'");
  await page.locator("#enabled").check();
  await page.route("**/conditions", route => route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ detail: "Annotation test rejection" }) }));
  await page.locator("#apply-condition").click();
  await page.waitForFunction(() => document.querySelector("#condition-feedback")?.textContent?.includes("Annotation test rejection"));
  assert.match(await page.locator("#selection-count").innerText(), /^2 atoms/);
  await page.unroute("**/conditions");
  await apply(true);
  assert.deepEqual(errors, []);
  console.log(`${backend}: rejected edit displays its error and retains selection for retry`);
} finally { await browser.close(); }
