import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { chromiumLaunchOptions } from "../../../scripts/browser.mjs";

const base = process.env.ANNOTATION_STUDIO_URL ?? "http://127.0.0.1:8000/";
const backend = process.env.VIEWER_MODE;
assert.ok(["molstar", "patinae"].includes(backend));
const browser = await chromium.launch(chromiumLaunchOptions());
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${base}?viewer=${backend}`);
  await page.waitForFunction(() => document.querySelector("#status")?.textContent.includes("Ready."));
  assert.equal(await page.locator("#reset-conditions").isDisabled(), true);
  await page.locator(".load-options > summary").click();
  await page.locator("#parse-preset").selectOption("minimal");
  await page.locator(".load-options > summary").click();
  await page.locator("#file-input").setInputFiles(fileURLToPath(new URL("../../../tests/fixtures/minimal_multichain.cif", import.meta.url)));
  await page.waitForFunction(() => !document.querySelector("#download").disabled);
  const session = await page.evaluate(() => sessionStorage.getItem("annotation-studio-session"));
  const endpoint = `${base}api/sessions/${session}`;
  for (const [condition, atom_indices, value] of [["sequence", [0], null], ["saltbridge", [0], 1], ["distance", [0, 2], 3.5]]) {
    const response = await page.request.post(`${endpoint}/conditions`, { data: { condition, atom_indices, value } });
    assert.equal(response.status(), 200, await response.text());
  }
  await page.reload();
  await page.waitForFunction(() => !document.querySelector("#download").disabled);
  await page.locator("#editor-tab-annotations").click();
  await page.locator('[data-view-key="annotations/sequence"]').click();
  await page.waitForFunction(() => document.querySelector("#viewer").dataset.annotationAtoms === "2");
  await page.locator("#selection-syntax").selectOption("expression");
  await page.locator("#viewer-command").fill("chain_id == 'A'");
  await page.locator("#run-viewer-command").click();
  await page.waitForFunction(() => document.querySelector("#selection-count").textContent.startsWith("2 atoms"));
  await page.locator("#editor-tab-main").click();
  const reset = page.waitForResponse(r => r.url().endsWith("/conditions/reset"));
  await page.locator("#reset-conditions").click();
  const result = await (await reset).json();
  assert.equal(result.session_id, session);
  assert.equal(result.structure.atom_count, 4);
  assert.equal(result.structure.undo_depth, 4);
  await page.waitForFunction(() => !document.querySelector("#viewer-mode").disabled);
  assert.match(await page.locator("#selection-count").textContent(), /^0 atoms/);
  assert.equal(await page.locator("#active-selection-count").textContent(), "0 atoms in active selection");
  assert.equal(await page.locator(".sequence-token.selected, .sequence-token.partially-selected").count(), 0);
  assert.equal(await page.locator("#viewer").getAttribute("data-annotation-atoms"), "0");
  assert.equal(await page.locator("#viewer").getAttribute("data-backend"), backend);
  assert.equal(await page.locator("#download").isEnabled(), true);
  assert.equal(await page.locator("#clear-annotation-view").isDisabled(), true);
  const undo = page.waitForResponse(r => r.url().endsWith("/undo"));
  await page.locator("#undo").click();
  const restored = await (await undo).json();
  assert.equal(restored.structure.condition_counts.sequence, 1);
  assert.equal(restored.structure.condition_counts.saltbridge, 1);
  assert.equal(restored.structure.condition_counts.distance, 1);
  await page.waitForFunction(() => !document.querySelector("#viewer-mode").disabled);
  assert.deepEqual(errors, []);
  console.log(`${backend}: reset preserves the loaded document, clears selections/colors, and supports one-step Undo`);
} finally {
  await browser.close();
}
