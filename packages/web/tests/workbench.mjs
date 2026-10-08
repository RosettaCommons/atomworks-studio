import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { chromium } from "playwright-core";
import { chromiumLaunchOptions } from "../../../scripts/browser.mjs";

const base = process.env.ANNOTATION_STUDIO_URL ?? "http://127.0.0.1:8000/";
const screenshots = process.env.STUDIO_SCREENSHOTS;
if (screenshots) await mkdir(screenshots, { recursive: true });
const browser = await chromium.launch(chromiumLaunchOptions());
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 950 }, serviceWorkers: "block" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${base}?viewer=molstar`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => document.querySelector("#status")?.textContent?.includes("Ready."));
  assert.ok(await page.locator("#empty-state").isVisible());
  assert.equal(await page.locator("#workspace").getAttribute("data-studio-tab"), "atomworks");
  await page.locator("#file-input").focus();
  assert.equal(await page.evaluate(() => document.activeElement.id), "file-input");
  if (screenshots) await page.screenshot({ path: resolve(screenshots, "studio-empty.png") });
  await page.locator('[data-example="antibody_design"]').click();
  await page.waitForFunction(() => !document.querySelector("#download").disabled);
  assert.ok(await page.locator("#empty-state").isHidden());
  for (const viewport of [{ width: 1440, height: 950 }, { width: 760, height: 800 }, { width: 608, height: 620 }]) {
    await page.setViewportSize(viewport);
    await page.waitForFunction(() => {
      const viewport = document.querySelector("#viewer").getBoundingClientRect();
      const canvas = document.querySelector("#viewer canvas").getBoundingClientRect();
      return Math.abs(viewport.width - canvas.width) <= 2 && Math.abs(viewport.height - canvas.height) <= 2;
    });
    const canvas = await page.locator("#viewer").boundingBox();
    const inspector = await page.locator("#atomworks-studio-popover").boundingBox();
    assert.ok(canvas.width > 300 && canvas.height > 100, "molecule remains visible");
    assert.ok(canvas.x + canvas.width <= inspector.x + 1 || canvas.y + canvas.height <= inspector.y + 1,
      "inspector never overlays the molecule");
    assert.ok(inspector.y + inspector.height <= viewport.height, "inspector stays inside viewport");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    if (screenshots) {
      await page.waitForTimeout(750);
      await page.screenshot({ path: resolve(screenshots, `studio-${viewport.width}.png`) });
    }
  }
  await page.setViewportSize({ width: 1440, height: 950 });
  const schema = await (await page.request.get(`${base}api/v1/schema`)).json();
  assert.deepEqual(await page.getByRole("tab").allTextContents(), schema.editor_tabs.map(tab => tab.label));
  for (const { id } of schema.editor_tabs) {
    await page.locator(`#editor-tab-${id}`).click();
    assert.equal(await page.getByRole("tabpanel").count(), 1);
    assert.equal(await page.locator(`#editor-panel-${id}`).isVisible(), true);
  }
  await page.locator("#editor-tab-main").focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(await page.locator("#editor-tab-annotations").getAttribute("aria-selected"), "true");
  await page.locator("#editor-tab-bonds").click();
  const bonds = page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/bonds"));
  await page.locator("#inspect-bonds").click();
  assert.ok((await (await bonds).json()).bonds.length > 0);
  await page.locator("#bond-list button").first().click();
  assert.match(await page.locator("#selection-count").innerText(), /^2 atoms/);
  await page.locator("#editor-tab-annotations").click();

  for (let toggle = 0; toggle < 2; toggle++) {
    await page.locator("#atomworks-studio-menu > summary").click();
    await page.waitForFunction(() => {
      const viewport = document.querySelector("#viewer").getBoundingClientRect();
      const canvas = document.querySelector("#viewer canvas").getBoundingClientRect();
      return Math.abs(viewport.width - canvas.width) <= 2 && Math.abs(viewport.height - canvas.height) <= 2;
    });
  }
  await page.locator('[data-menu="select"] > summary').click();
  await page.locator("#pick-scope").selectOption("residue");
  assert.ok(await page.locator("#condition").isVisible(), "viewer menus keep editing controls open");
  await page.keyboard.press("Escape");
  assert.equal(await page.locator('[data-menu="select"]').evaluate((menu) => menu.open), false);
  if (screenshots) await page.screenshot({ path: resolve(screenshots, "studio-editor.png") });
  await page.locator("#editor-tab-main").click();
  await page.getByText("Activity log", { exact: true }).click();
  assert.ok(await page.locator("#status").isVisible());
  assert.match(await page.locator("#status").innerText(), /Native AtomWorks session ready/);
  await page.getByText("Activity log", { exact: true }).click();
  const host = await context.newPage();
  await host.goto(base);
  await host.setContent('<!doctype html><html lang="en"><head><title>Studio host</title></head><body style="margin:0"><iframe title="Studio" style="width:100vw;height:100vh;border:0"></iframe></body></html>');
  await host.locator("iframe").evaluate((frame, base) => {
    frame.src = `${base}?viewer=molstar&embed=1&host=vscode`;
  }, base);
  const frame = host.frameLocator("iframe");
  await frame.locator("#file-input").setInputFiles(fileURLToPath(new URL("../../../tests/fixtures/SAM_hbonds.cif", import.meta.url)));
  await host.frames()[1].waitForFunction(() => !document.querySelector("#download").disabled);
  for (const theme of ["light", "dark", "high-contrast", "high-contrast-light"]) {
    await host.evaluate(({ theme, origin }) => document.querySelector("iframe").contentWindow.postMessage({
      source: "atomworks-vscode-host", type: "theme", theme,
    }, origin), { theme, origin: new URL(base).origin });
    await host.frames()[1].waitForFunction((theme) => document.body.dataset.hostTheme === theme, theme);
    const report = await new AxeBuilder({ page: host }).analyze();
    assert.deepEqual(report.violations.filter((issue) => ["serious", "critical"].includes(issue.impact))
      .map((issue) => ({ id: issue.id, targets: issue.nodes.map((node) => node.target) })), [], `${theme} accessibility`);
    if (screenshots) await host.screenshot({ path: resolve(screenshots, `studio-vscode-${theme}.png`) });
  }
  await host.evaluate((origin) => document.querySelector("iframe").contentWindow.postMessage({
    source: "atomworks-vscode-host", type: "theme", theme: "dark",
    tokens: { "--surface-panel": "#253244", "--text": "#f0f4f8", "--border": "url(https://invalid.test)" },
  }, origin), new URL(base).origin);
  await host.frames()[1].waitForFunction(() => getComputedStyle(document.querySelector("aside")).backgroundColor === "rgb(37, 50, 68)");
  assert.equal(await frame.locator("body").evaluate((body) => body.style.getPropertyValue("--border")), "");
  assert.deepEqual(errors, []);
  console.log("Workbench passed: docked editing, keyboard file input, responsive layouts, four host themes.");
} finally {
  await browser.close();
}
