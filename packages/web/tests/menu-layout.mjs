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
    assert.deepEqual(await page.locator(".viewer-menu > summary").allTextContents(), ["Style", "Analyze", "Backend"]);
    for (const width of [1440, 760, 608, 390, 320]) {
      await page.setViewportSize({ width, height: 620 });
      for (const id of ["style", "analyze", "overflow"]) {
        const menu = page.locator(`[data-menu="${id}"]`);
        await menu.locator(":scope > summary").click();
        await page.waitForFunction(() => {
          const menu = document.querySelector(".viewer-menu[open]");
          if (!menu) return false;
          const panel = menu.querySelector(".viewer-menu-popover").getBoundingClientRect();
          const button = menu.querySelector("summary").getBoundingClientRect();
          const left = Math.max(8, Math.min(button.left, innerWidth - panel.width - 8));
          return Math.abs(panel.top - button.bottom - 5) < 1 && Math.abs(panel.left - left) < 1;
        });
        const panel = await menu.locator(".viewer-menu-popover").boundingBox();
        const button = await menu.locator(":scope > summary").boundingBox();
        assert.ok(panel.x >= 8 && panel.x + panel.width <= width - 8 + 1,
          `${viewer} ${id} at ${width}px: menu stays horizontally inside viewport`);
        assert.ok(panel.y >= button.y + button.height && panel.y + panel.height <= 613,
          `${viewer} ${id} at ${width}px: menu ${JSON.stringify(panel)}, button ${JSON.stringify(button)}`);
        assert.equal(await page.locator(".viewer-menu[open]").count(), 1);
        await page.keyboard.press("Escape");
      }
    }
    await page.setViewportSize({ width: 1440, height: 950 });
    await page.locator('[data-menu="overflow"] > summary').click();
    await page.setViewportSize({ width: 320, height: 620 });
    await page.waitForFunction(() => {
      const panel = document.querySelector('[data-menu="overflow"] .viewer-menu-popover').getBoundingClientRect();
      const button = document.querySelector('[data-menu="overflow"] > summary').getBoundingClientRect();
      return panel.left >= 8 && panel.right <= innerWidth - 7 && panel.top >= button.bottom;
    });
    assert.equal(await page.locator("#viewer-mode").isVisible(), true);
    assert.deepEqual(errors, []);
    console.log(`${viewer}: all toolbar menus fit at five viewport widths and reposition while open`);
    await page.close();
  }
} finally {
  await browser.close();
}
