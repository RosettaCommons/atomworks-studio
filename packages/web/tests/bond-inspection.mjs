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
    await page.locator("#editor-tab-structure").click();
    const toggle = page.locator("#inspect-bonds");
    const list = page.locator("#bond-list");
    assert.equal(await list.isHidden(), true);
    assert.equal(await toggle.getAttribute("aria-expanded"), "false");
    await toggle.click();
    await list.locator("button").first().waitFor();
    assert.equal(await toggle.getAttribute("aria-expanded"), "true");
    await list.locator("button").first().click();
    await page.waitForFunction(() => document.querySelector("#selection-count").textContent.startsWith("2 atoms"));
    await toggle.click();
    assert.equal(await list.isHidden(), true);
    assert.equal(await list.locator("button").count(), 0);
    assert.equal(await toggle.getAttribute("aria-expanded"), "false");
    assert.match(await page.locator("#selection-count").innerText(), /^2 atoms/);

    await toggle.focus();
    await toggle.press("Enter");
    await list.locator("button").first().waitFor();
    await toggle.press("Space");
    assert.equal(await list.isHidden(), true);

    let release;
    const gate = new Promise(resolve => { release = resolve; });
    await page.route("**/bonds", async route => { await gate; await route.continue(); });
    const requested = page.waitForRequest(request => new URL(request.url()).pathname.endsWith("/bonds"));
    await toggle.click();
    await requested;
    await toggle.click();
    const response = page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/bonds"));
    release();
    await response;
    await page.unroute("**/bonds");
    await page.waitForTimeout(300);
    assert.equal(await list.isHidden(), true);
    assert.equal(await list.locator("button").count(), 0);
    assert.equal(await toggle.getAttribute("aria-expanded"), "false");
    await toggle.click();
    await list.locator("button").first().waitFor();
    assert.deepEqual(errors, []);
    console.log(`${viewer}: click/keyboard toggle, preserved selection, late-response cancellation, and reopening passed`);
    await page.close();
  }
} finally {
  await browser.close();
}
