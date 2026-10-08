import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { chromiumLaunchOptions } from "../../../scripts/browser.mjs";

const base = process.env.ANNOTATION_STUDIO_URL ?? "http://127.0.0.1:8000/";
const browser = await chromium.launch(chromiumLaunchOptions());
try {
  const context = await browser.newContext({ viewport: { width: 1500, height: 1100 }, permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(new URL("guide/INTEGRATIONS.html", base).href);
  await page.getByRole("button", { name: "Copy code example" }).first().click();
  await page.getByRole("button", { name: "Copy code example" }).first().filter({ hasText: "Copied" }).waitFor();
  assert.match(await page.evaluate(() => navigator.clipboard.readText()), /StudioDocument.from_cif/);
  await page.goto(new URL("guide/TUTORIAL.html", base).href);
  await page.getByRole("button", { name: "Open 2KL8 example" }).click();
  const frame = page.frameLocator(".studio-example iframe");
  await frame.locator("#download:not([disabled])").waitFor({ timeout: 120000 });
  assert.equal(await frame.locator("#viewer").getAttribute("data-backend"), "molstar");
  await frame.locator("#selection-syntax").selectOption("expression");
  await frame.locator("#viewer-command").fill("sel('*/*/*/CA')");
  const selected = page.waitForResponse(r => r.url().endsWith("/selections/query"));
  await frame.locator("#run-viewer-command").click();
  assert.equal((await (await selected).json()).count, 59);
  await frame.locator("#editor-tab-annotations").click();
  await frame.locator("#condition").selectOption("hotspot");
  const applied = page.waitForResponse(r => r.url().endsWith("/conditions") && r.request().method() === "POST");
  await frame.locator("#apply-condition").click();
  assert.equal((await (await applied).json()).structure.condition_counts.hotspot, 59);
  await frame.locator("#viewer-mode:not([disabled])").waitFor({ state: "attached" });
  const undone = page.waitForResponse(r => r.url().endsWith("/undo"));
  await frame.locator("#undo").click();
  assert.equal((await (await undone).json()).structure.undo_depth, 0);
  await page.goto(new URL("guide/search.html?q=protonate", base).href);
  await page.locator("#search-results li").first().waitFor();
  assert.ok(await page.locator("#search-results a").count() > 0);
  await page.goto(new URL("guide/TUTORIAL.html", base).href);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, "mobile guide should not overflow");
  await page.route("**/api/ready", route => route.fulfill({ status: 503, body: "unavailable" }));
  await page.getByRole("button", { name: "Open 2KL8 example" }).click();
  await page.getByRole("status").filter({ hasText: "Start atomworks-studio" }).waitFor();
  assert.equal(await page.locator("iframe").count(), 0);
  assert.deepEqual(errors, []);
  console.log("Docs: clipboard, real embedded query/annotation/Undo, search, mobile layout, and unavailable-backend guidance passed");
} finally {
  await browser.close();
}
