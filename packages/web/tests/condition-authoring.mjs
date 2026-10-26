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
  assert.equal((await upload).status(), 200);
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
  const options = await page.locator("#condition option").allTextContents();
  assert.ok(!options.some(label => /Sequence probability|Nucleic Acid Secondary Structure/i.test(label)));
  assert.equal(await page.locator('#condition option[value^="sequence_probability_"]').count(), 0);
  assert.doesNotMatch(await page.locator("#structure-summary").innerText(), /Undo|\d+\/10/);
  assert.equal(await page.locator("#undo").count(), 1, "undo action remains available");

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
  await page.locator("#clear-selection").click();
  assert.equal(await page.locator("#insert-segment").isEnabled(), false);
  // Sequence picks select whole residues. Reversed clicks must still use structure order.
  for (const before of [true, false]) {
    await page.locator("#segment-before").setChecked(before);
    for (const orders of [[0], [1, 0], [0, 1]]) {
      await page.locator("#clear-selection").click();
      for (const order of orders) await page.locator(`.sequence-token[data-order="${order}"]`).click();
      assert.equal(await page.locator("#insert-segment").isEnabled(), true);
      const request = page.waitForRequest(r => r.url().endsWith("/segments") && r.method() === "POST");
      const result = await edit("#insert-segment", "/segments");
      const anchor = before ? 0 : orders.length === 1 ? 1 : 3;
      assert.equal((await request).postDataJSON().atom_index, anchor);
      const chain = result.structure.sequence.find(chain => chain.chain_id.startsWith(anchor < 2 ? "A" : "B"));
      assert.ok(chain);
      assert.equal(chain.items[before ? 0 : chain.items.length - 1].kind, "segment");
      await edit("#undo", "/undo");
      assert.equal(await page.locator(".sequence-segment").count(), 0);
    }
  }
  await page.locator("#clear-selection").click();
  await page.locator("#segment-new-chain").check();
  assert.equal(await page.locator("#segment-chain-id").inputValue(), "C");
  const inserted = await edit("#insert-segment", "/segments");
  assert.equal(inserted.structure.next_chain_id, "D");
  assert.equal(await page.locator("#segment-chain-id").inputValue(), "D");
  await edit("#undo", "/undo");
  assert.equal(await page.locator("#segment-chain-id").inputValue(), "C");
  await page.locator("#editor-tab-annotations").click();
  await page.locator("#condition").selectOption("sequence");
  const directory = resolve("artifacts/local");
  mkdirSync(directory, { recursive: true });
  await page.screenshot({ path: resolve(directory, `${viewer}-condition-authoring.png`) });
  console.log(`${viewer}: editor filtering, broadcasting, interaction roles, segment selection and chain defaults passed`);
} finally {
  await browser.close();
}
