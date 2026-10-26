import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";
import { chromiumLaunchOptions } from "../../../scripts/browser.mjs";

const base = process.env.ANNOTATION_STUDIO_URL ?? "http://127.0.0.1:8001/";
const output = "artifacts/local/interactions";
await mkdir(output, { recursive: true });
const browser = await chromium.launch(chromiumLaunchOptions());
try {
  for (const mode of ["molstar", "patinae"]) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${base}?viewer=${mode}`);
    await page.waitForFunction(() => document.querySelector("#status")?.textContent.includes("Ready."));
    await page.locator('[data-example="antibody_design"]').click();
    await page.waitForFunction(() => !document.querySelector("#download").disabled && !document.querySelector("#viewer-mode").disabled);
    async function analyze(limit) {
      const menu = page.locator('[data-menu="analyze"]');
      if (await menu.getAttribute("open") === null) await menu.locator("summary").click();
      if (limit) await page.locator("#interaction-visual-limit").fill(String(limit));
      const response = page.waitForResponse(r => r.url().endsWith("/interactions/analyze"), { timeout: 120000 });
      await page.locator("#run-analysis").click();
      const result = await response;
      assert.equal(result.status(), 200, await result.text());
      const data = await result.json();
      await page.waitForFunction(count => document.querySelectorAll("#analysis-results button").length === count || !document.querySelector("#error-banner").hidden, data.interaction_count);
      assert.equal(await page.locator("#error-banner").isVisible(), false, await page.locator("#error-message").textContent());
      if (await menu.getAttribute("open") !== null) await menu.locator("summary").click();
      assert.equal(await page.locator("#error-banner").isVisible(), false);
      return data.interaction_count;
    }
    assert.equal(await page.locator("#interaction-visual-limit").inputValue(), "25");
    const count = await analyze();
    assert.ok(count >= 100, `Antibody should exercise many contacts: ${count}`);
    assert.equal(await page.locator("#measurement-list").textContent(), "No measurements.");
    assert.notEqual(await page.locator("#interactions-drawer").getAttribute("open"), null);
    assert.equal(await page.locator("#measurements-drawer").getAttribute("open"), null);
    if (mode === "molstar") {
      assert.equal(await page.locator("#viewer").getAttribute("data-interaction-contacts"), "25");
      assert.equal(await page.locator("#viewer").getAttribute("data-interaction-render-objects"), "1");
    }
    await analyze(100);
    if (mode === "molstar") {
      const displayed = Number(await page.locator("#viewer").getAttribute("data-interaction-contacts"));
      assert.ok(displayed >= 25 && displayed < 100, `Stacking cross-products should collapse before the limit: ${displayed}`);
      assert.equal(await page.locator("#viewer").getAttribute("data-interaction-render-objects"), "1");
    }
    assert.equal(await page.locator("#measurement-list").textContent(), "No measurements.");
    await page.screenshot({ path: `${output}/${mode}-grouped-contacts.png` });

    await page.locator("#editor-tab-structure").click();
    await page.locator("#clear-selection").click();
    await page.locator("button.sequence-token").first().click();
    await page.locator("#inspect-bonds").click();
    await page.locator("#bond-list button").first().click();
    if (await page.locator('[data-menu="analyze"]').getAttribute("open") === null) await page.locator('[data-menu="analyze"] > summary').click();
    await page.locator("#add-measurement").click();
    await page.waitForFunction(() => document.querySelector("#measurement-list").textContent !== "No measurements.");
    const measurement = await page.locator("#measurement-list").textContent();
    assert.equal(measurement.trim().split("\n").length, 1);
    if (await page.locator('[data-menu="analyze"]').getAttribute("open") === null) await page.locator('[data-menu="analyze"] > summary').click();
    await page.locator("#clear-analysis-visuals").click();
    await page.waitForFunction(() => document.querySelectorAll("#analysis-results button").length === 0);
    assert.equal(await page.locator("#measurement-list").textContent(), measurement);
    if (mode === "molstar") assert.equal(await page.locator("#viewer").getAttribute("data-interaction-render-objects"), "0");

    if (await page.locator('[data-menu="analyze"]').getAttribute("open") === null) await page.locator('[data-menu="analyze"] > summary').click();
    await page.locator("#visualize-interactions").uncheck();
    await analyze();
    assert.equal(await page.locator("#measurement-list").textContent(), measurement);
    if (mode === "molstar") assert.equal(await page.locator("#viewer").getAttribute("data-interaction-render-objects"), "0");
    if (await page.locator('[data-menu="analyze"]').getAttribute("open") === null) await page.locator('[data-menu="analyze"] > summary').click();
    await page.locator("#visualize-interactions").check();
    await analyze();
    await page.locator("#editor-tab-main").click();
    await page.locator("#close-structure").click();
    await page.locator('dialog.confirmation button[value="confirm"]').click();
    await page.waitForFunction(() => document.querySelector("#status")?.textContent.includes("Ready.") && document.querySelector("#download").disabled);
    assert.equal(await page.locator("#measurement-list").textContent(), "No measurements.");
    if (mode === "molstar") assert.ok([null, "0"].includes(await page.locator("#viewer").getAttribute("data-interaction-render-objects")));
    assert.equal(await page.locator(".sequence-token").count(), 0);
    assert.deepEqual(errors, []);
    console.log(`${mode}: batched contacts, separate results, preserved user measurement, visualization off, and close passed (${count} contacts)`);
    await page.close();
  }
} finally {
  await browser.close();
}
