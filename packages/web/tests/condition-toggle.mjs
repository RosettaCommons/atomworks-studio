import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { chromiumLaunchOptions } from "../../../scripts/browser.mjs";

const base = process.env.ANNOTATION_STUDIO_URL ?? "http://127.0.0.1:8000/";
const browser = await chromium.launch(chromiumLaunchOptions());
try {
  for (const viewer of ["molstar", "patinae"]) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${base}?viewer=${viewer}`);
    await page.waitForFunction(() => document.querySelector("#status")?.textContent?.includes("Ready."));
    await page.locator('[data-example="enzyme_design"]').click();
    await page.waitForFunction(() => !document.querySelector("#download").disabled && !document.querySelector("#viewer-mode").disabled);
    await page.locator("#editor-tab-annotations").click();
    const row = page.locator('[data-view-key="annotations/coordinate"]');
    const sequence = page.locator('[data-view-key="annotations/sequence"]');
    await page.waitForTimeout(400);
    const baseline = await page.locator("#viewer").screenshot();
    await row.click();
    await page.waitForFunction(() => Number(document.querySelector("#viewer").dataset.annotationAtoms) > 0);
    assert.equal(await row.getAttribute("aria-pressed"), "true");
    await row.click();
    await page.waitForFunction(() => document.querySelector("#viewer").dataset.annotationAtoms === "0");
    assert.equal(await row.getAttribute("aria-pressed"), "false");
    assert.equal(await page.locator(".annotation-row.active").count(), 0);
    assert.equal(await page.locator("#clear-annotation-view").isDisabled(), true);
    await page.waitForTimeout(400);
    assert.deepEqual(await page.locator("#viewer").screenshot(), baseline,
      `${viewer}: toggling off restores the original rendered colors, sticks, and camera`);

    await row.focus();
    await row.press("Enter");
    await page.waitForFunction(() => Number(document.querySelector("#viewer").dataset.annotationAtoms) > 0);
    await row.press("Space");
    await page.waitForFunction(() => document.querySelector("#viewer").dataset.annotationAtoms === "0");

    await row.click();
    await page.waitForFunction(() => Number(document.querySelector("#viewer").dataset.annotationAtoms) > 0);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    await page.route("**/annotations/sequence", async route => { await gate; await route.continue(); });
    const requested = page.waitForRequest(request => request.url().endsWith("/annotations/sequence"));
    await sequence.click();
    await requested;
    await row.click();
    await page.waitForFunction(() => document.querySelector("#viewer").dataset.annotationAtoms === "0");
    const response = page.waitForResponse(response => response.url().endsWith("/annotations/sequence"));
    release();
    await response;
    await page.unroute("**/annotations/sequence");
    await page.waitForTimeout(400);
    assert.equal(await page.locator("#viewer").getAttribute("data-annotation-atoms"), "0");
    assert.equal(await page.locator(".annotation-row.active").count(), 0);

    await sequence.click();
    await page.waitForFunction(() => !document.querySelector("#clear-annotation-view").disabled);
    await page.locator("#clear-annotation-view").click();
    await page.waitForFunction(() => document.querySelector("#viewer").dataset.annotationAtoms === "0");
    assert.equal(await page.locator('.annotation-row[aria-pressed="true"]').count(), 0);
    assert.deepEqual(errors, []);
    console.log(`${viewer}: click/keyboard toggle, exact visual restoration, delayed-response cancellation, and Clear colors passed`);
    await page.close();
  }
} finally {
  await browser.close();
}
