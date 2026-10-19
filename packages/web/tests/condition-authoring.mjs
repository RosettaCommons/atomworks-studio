import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { chromiumLaunchOptions } from "../../../scripts/browser.mjs";

const baseUrl = process.env.ANNOTATION_STUDIO_URL ?? "http://127.0.0.1:8000/";
const viewer = process.env.VIEWER_MODE ?? "molstar";
const browser = await chromium.launch(chromiumLaunchOptions());
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  await page.goto(`${baseUrl}?viewer=${viewer}`);
  await page.waitForFunction(() => document.querySelector("#status")?.textContent?.includes("Ready."));
  const upload = page.waitForResponse(r => r.url().endsWith("/sessions") && r.request().method() === "POST");
  await page.locator(".load-options > summary").click();
  await page.locator("#parse-preset").selectOption("minimal");
  await page.locator(".load-options > summary").click();
  await page.locator("#file-input").setInputFiles(resolve("tests/fixtures/minimal_multichain.cif"));
  const loaded = await (await upload).json();
  const session = loaded.session_id;
  await page.waitForFunction(() => !document.querySelector("#viewer-mode")?.disabled);
  await page.locator("#editor-tab-annotations").click();

  async function select() {
    await page.locator("#selection-syntax").selectOption("expression");
    await page.locator("#viewer-command").fill("atom_id == 1");
    await page.locator("#run-viewer-command").click();
    await page.waitForFunction(() => document.querySelector("#selection-count")?.textContent?.startsWith("1 atom"));
  }
  async function edit(button, endpoint) {
    const pending = page.waitForResponse(r => r.url().endsWith(endpoint) && r.request().method() === "POST");
    await page.locator(button).click();
    const response = await pending;
    assert.equal(response.status(), 200, await response.text());
    await page.waitForFunction(() => !document.querySelector("#viewer-mode")?.disabled);
    return response.json();
  }

  assert.equal(await page.locator("#scope").count(), 0);
  assert.equal(await page.locator("#pick-scope").inputValue(), "atom");
  await page.locator("#condition").selectOption("sequence");
  await page.locator("#enabled").uncheck();
  await select();
  assert.equal((await edit("#apply-condition", "/conditions")).edit_result.affected_count, 2);
  await page.locator("#enabled").check();
  const groups = await page.locator("#condition option").allTextContents();
  assert.equal(groups.filter(label => label === "Sequence probability").length, 1);
  assert.equal(groups.filter(label => label.startsWith("Sequence Probability ")).length, 0);
  await page.locator("#condition").selectOption({ label: "Sequence probability" });
  assert.equal(await page.locator("#condition-residue-type option").count(), 28);
  assert.equal(await page.locator("#pick-scope").inputValue(), "atom");
  assert.match(await page.locator("#condition-feedback").innerText(), /whole residues/);
  const value = page.locator("#condition-value-input");
  assert.equal(await value.getAttribute("step"), "0.1");
  await value.fill("0.1234");
  await value.press("Tab");
  assert.equal(await value.inputValue(), "0.12");
  await value.fill("0.2");
  await value.press("ArrowUp");
  await value.press("Tab");
  assert.equal(Number(await value.inputValue()), 0.3);
  await page.locator("#condition-residue-type").selectOption("sequence_probability_arg");
  await select();
  assert.equal((await edit("#apply-condition", "/conditions")).edit_result.affected_count, 2);
  const annotation = await (await page.request.get(`${baseUrl}api/sessions/${session}/annotations/sequence_probability_arg`)).json();
  assert.deepEqual(annotation.annotation.values[0].atom_indices, [0, 1]);
  await page.locator("#enabled").uncheck();
  assert.equal(await page.locator("#condition-residue-type").inputValue(), "sequence_probability_arg");
  await select();
  await edit("#apply-condition", "/conditions");
  await page.locator("#enabled").check();

  // Changing future picking granularity must not expand an existing selection during edits.
  for (const scope of ["atom", "residue", "chain"]) {
    for (const condition of ["saltbridge", "metal_coord"]) {
      await select();
      await page.locator("#pick-scope").selectOption(scope);
      await page.locator("#condition").selectOption(condition);
      assert.equal(await page.locator("#pick-scope").inputValue(), scope);
      await page.locator("#condition-value-input").selectOption("2");
      assert.match(await page.locator("#selection-count").innerText(), /^1 atom/);
      assert.equal((await edit("#apply-condition", "/conditions")).edit_result.affected_count, 1);
    }
  }
  await page.locator("#pick-scope").selectOption("atom");
  await page.locator("#editor-tab-main").click();
  await page.getByText("Expandable segments", { exact: true }).click();
  await page.locator("#segment-new-chain").check();
  assert.equal(await page.locator("#segment-chain-id").inputValue(), "C");
  const inserted = await edit("#insert-segment", "/segments");
  assert.equal(inserted.structure.next_chain_id, "D");
  assert.equal(await page.locator("#segment-chain-id").inputValue(), "D");
  await edit("#undo", "/undo");
  assert.equal(await page.locator("#segment-chain-id").inputValue(), "C");
  await page.locator("#editor-tab-annotations").click();
  await page.locator("#condition").selectOption({ label: "Sequence probability" });
  const directory = resolve("artifacts/local");
  mkdirSync(directory, { recursive: true });
  await page.screenshot({ path: resolve(directory, `${viewer}-condition-authoring.png`) });
  console.log(`${viewer}: probability grouping, precision, step, broadcasting, interaction roles and chain defaults passed`);
} finally {
  await browser.close();
}
