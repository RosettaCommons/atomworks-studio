import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

import { chromiumLaunchOptions } from "../../../scripts/browser.mjs";

const baseUrl = process.env.ANNOTATION_STUDIO_URL ?? "http://127.0.0.1:8000/";
const browser = await chromium.launch(chromiumLaunchOptions());

try {
  for (const viewer of ["patinae", "molstar"]) {
    const context = await browser.newContext({
      viewport: { width: 1000, height: 700 },
      serviceWorkers: "block",
    });
    const page = await context.newPage();
    if (viewer === "patinae") {
      await page.route(/\/assets\/patinae[^/]*\.js(?:\?.*)?$/, (route) => route.abort("failed"));
    } else {
      await page.addInitScript(() => {
        const getContext = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (kind, ...args) {
          return /webgl/i.test(kind) ? null : getContext.call(this, kind, ...args);
        };
      });
    }
    const url = new URL(baseUrl);
    url.searchParams.set("viewer", viewer);
    await page.goto(url.toString(), { waitUntil: "networkidle" });
    await page.waitForFunction(
      () => document.querySelector("#status")?.textContent?.includes("Renderer initialization failed"),
    );
    await page.waitForFunction(() => document.querySelector("#status")?.textContent?.includes("Ready."));

    assert.equal(await page.locator(".example-load").first().isEnabled(), true);
    assert.equal(await page.locator("#workspace").getAttribute("data-studio-tab"), "atomworks");
    await page.locator('.example-load[data-example="antibody_design"]').click();
    await page.waitForFunction(
      () => document.querySelector("#structure-summary")?.textContent?.includes("Atoms"),
    );
    assert.equal(await page.locator("#validate").isEnabled(), true);

    await page.locator(".load-options > summary").click();
    await page.locator("#parse-assembly").fill("asym");
    await page.locator("#parse-hydrogen_policy").selectOption("remove");
    await page.locator("#file-input").setInputFiles(
      fileURLToPath(new URL("../../../examples/mcsa_ph2.cif", import.meta.url)),
    );
    await page.waitForFunction(
      () => document.querySelector("#structure-summary")?.textContent?.includes("mcsa_ph2"),
    );
    assert.match((await page.locator("#status").textContent()), /renderer is unavailable/);
    if (viewer === "patinae") {
      const session = await page.evaluate(() => sessionStorage.getItem("annotation-studio-session"));
      const cifUrl = new URL(`/api/v1/sessions/${session}/cif`, baseUrl).href;
      const snapshot = async () => (await (await page.request.get(cifUrl)).text())
        .replace(/^_entry\.(date|time).*$/gm, "");
      const original = await snapshot();
      for (const mode of ["molstar", "patinae"]) {
        await page.locator('[data-menu="overflow"]').evaluate(menu => { menu.open = true; });
        await page.locator("#viewer-mode").selectOption(mode);
        await page.waitForFunction(() => !document.querySelector("#viewer-mode").disabled);
      }
      await page.waitForFunction(() => document.querySelector("#status").textContent.includes("Renderer switch failed")
        && !document.querySelector("#viewer-mode").disabled);
      assert.equal(await page.locator("#viewer-mode").inputValue(), "molstar");
      assert.equal(await page.locator("#viewer canvas").first().isVisible(), true,
        "an unavailable renderer must not leave the working view blank");
      assert.equal(await page.locator("#download").isEnabled(), true);
      assert.equal(await snapshot(), original,
        "a failed renderer switch preserves the document");
    }
    await context.close();
  }
} finally {
  await browser.close();
}
