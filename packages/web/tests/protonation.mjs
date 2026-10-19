import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { chromiumLaunchOptions } from "../../../scripts/browser.mjs";

const baseUrl = process.env.ANNOTATION_STUDIO_URL ?? "http://127.0.0.1:8000/";
const backend = process.env.VIEWER_MODE;
assert.ok(["molstar", "patinae"].includes(backend));
const browser = await chromium.launch(chromiumLaunchOptions());
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${baseUrl}?viewer=${backend}`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => document.querySelector("#status")?.textContent?.includes("Ready."));
  assert.equal(await page.locator("#protonate").isDisabled(), true);
  const uploaded = page.waitForResponse((r) => r.url().endsWith("/sessions") && r.request().method() === "POST");
  await page.locator("#file-input").setInputFiles(fileURLToPath(new URL("../../../tests/fixtures/SAM_hbonds.cif", import.meta.url)));
  const initial = await (await uploaded).json();
  await page.waitForFunction(() => !document.querySelector("#download").disabled);
  await page.locator("#editor-tab-structure").click();
  assert.equal(await page.locator("#protonation-ph").inputValue(), "7.4");
  for (const width of [1440, 760, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const id of ["protonation-ph", "protonate"]) {
      const bounds = await page.locator(`#${id}`).evaluate((node) => {
        const rect = node.getBoundingClientRect();
        return { height: rect.height, left: rect.left, right: rect.right };
      });
      assert.equal(bounds.height, 32, `${id} height at ${width}px`);
      assert.ok(bounds.left >= 0 && bounds.right <= width, `${id} fits at ${width}px`);
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator("#protonation-ph").fill("15");
  assert.equal(await page.locator("#protonate").isDisabled(), true);
  await page.locator("#protonation-ph").fill("7.4");
  const response = page.waitForResponse((r) => r.url().endsWith("/protonate"));
  await page.locator("#protonate").click();
  const protonated = await response;
  assert.equal(protonated.status(), 200, await protonated.text());
  const result = await protonated.json();
  assert.ok(result.edit_result.hydrogen_count > 0);
  await page.waitForFunction(() => document.querySelector("#status-message")?.textContent?.startsWith("Protonated at pH 7.4"));
  assert.match(await page.locator("#selection-count").innerText(), /^0 atoms/);
  if (process.env.PROTONATION_SCREENSHOT) {
    await page.locator("details:has(#protonate) .muted").scrollIntoViewIfNeeded();
    await page.screenshot({ path: process.env.PROTONATION_SCREENSHOT });
  }
  const downloaded = page.waitForEvent("download");
  const checkedExport = page.waitForResponse(r => r.url().endsWith("/export"));
  await page.locator("#download").click();
  if ((await (await checkedExport).json()).issues.length) {
    await page.locator('dialog.confirmation button[value="confirm"]').click();
  }
  const stream = await (await downloaded).createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const cif = Buffer.concat(chunks);
  const undone = page.waitForResponse((r) => r.url().endsWith("/undo"));
  await page.locator("#undo").click();
  assert.equal((await (await undone).json()).structure.atom_count, initial.structure.atom_count);
  await page.waitForFunction(() => !document.querySelector("#viewer-mode").disabled);
  const reopened = page.waitForResponse((r) => r.url().endsWith("/sessions") && r.request().method() === "POST");
  await page.locator("#file-input").setInputFiles({ name: "protonated.cif", mimeType: "chemical/x-mmcif", buffer: cif });
  const restored = await (await reopened).json();
  assert.equal(restored.structure.atom_count, result.structure.atom_count);
  const query = await page.request.post(`${baseUrl}api/v1/sessions/${restored.session_id}/selections/query`, {
    data: { expression: "element == 'H'" },
  });
  assert.equal((await query.json()).count, result.edit_result.hydrogen_count);
  assert.deepEqual(errors, []);
  console.log(`${backend}: protonation button, pH validation, save/reopen, and Undo passed`);
} finally {
  await browser.close();
}
