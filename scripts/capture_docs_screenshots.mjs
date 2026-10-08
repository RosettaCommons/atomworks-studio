import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";

import { chromiumArgs, chromiumExecutable } from "./browser.mjs";

const require = createRequire(resolve("packages/web/package.json"));
const { chromium } = require("playwright-core");

const baseUrl = process.env.ANNOTATION_STUDIO_URL ?? "http://127.0.0.1:8000/";
const outputDir = resolve("docs/images");
const fixture = resolve("packages/api/annotation_studio/examples/protein_binder.cif");
const browser = await chromium.launch({
  executablePath: chromiumExecutable(),
  headless: true,
  args: chromiumArgs,
});
let embeddedPath;

await mkdir(outputDir, { recursive: true });

async function openStudio(viewer) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    deviceScaleFactor: 1,
    colorScheme: "dark",
  });
  const page = await context.newPage();
  const url = new URL(baseUrl);
  url.searchParams.set("viewer", viewer);
  await page.goto(url.toString(), { waitUntil: "networkidle" });
  await page.waitForFunction(() => document.querySelector("#status")?.textContent?.includes("Ready."));
  await page.locator("#file-input").setInputFiles(fixture);
  await page.locator("#download").waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForFunction(() => !document.querySelector("#download")?.hasAttribute("disabled"));
  await page.waitForTimeout(750);
  return { context, page };
}

async function capture(page, filename) {
  await page.screenshot({
    path: resolve(outputDir, filename),
    animations: "disabled",
  });
}

try {
  {
    const { context, page } = await openStudio("molstar");
    const sessionId = await page.evaluate(() => sessionStorage.getItem("annotation-studio-session"));
    const session = await page.request.get(new URL(`/api/sessions/${sessionId}`, baseUrl).toString());
    if (!session.ok()) throw new Error(`Could not read screenshot session: ${session.status()}`);
    const sessionPayload = await session.json();
    if (typeof sessionPayload.editor_path !== "string" || !sessionPayload.editor_path.startsWith("/")) {
      throw new Error("Screenshot session did not include a valid embedded editor path.");
    }
    embeddedPath = sessionPayload.editor_path;
    await page.locator("#editor-tab-annotations").click();
    await capture(page, "web-molstar-editor.png");

    if (!(await page.locator("#atomworks-studio-menu").evaluate((menu) => menu.open))) {
      await page.locator("#atomworks-studio-menu > summary").click();
    }
    await page.waitForFunction(
      () => document.querySelector("#workspace")?.getAttribute("data-studio-tab") === "atomworks",
    );
    await page.locator("#atomworks-studio-popover").evaluate((panel) => {
      const card = panel.querySelector("#annotation-list")?.parentElement;
      if (card) {
        panel.scrollTop += card.getBoundingClientRect().top - panel.getBoundingClientRect().top - 12;
      }
    });
    if (!(await page.locator("#atomworks-studio-popover").isVisible())) {
      throw new Error("AtomWorks Studio panel did not open for its documentation screenshot.");
    }
    await capture(page, "web-annotations.png");

    await context.close();
  }

  {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 960 },
      deviceScaleFactor: 1,
      colorScheme: "dark",
    });
    const page = await context.newPage();
    const url = new URL(embeddedPath, baseUrl);
    url.searchParams.set("viewer", "molstar");
    await page.goto(url.toString(), { waitUntil: "networkidle" });
    await page.waitForFunction(
      () => !document.querySelector("#structure-summary")?.textContent?.includes("No structure"),
    );
    await page.waitForTimeout(750);
    await capture(page, "web-embedded.png");
    await context.close();
  }
} finally {
  await browser.close();
}

console.log(`Captured documentation screenshots in ${outputDir}`);
