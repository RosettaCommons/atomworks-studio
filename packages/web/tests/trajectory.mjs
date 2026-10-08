import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright-core";
import { chromiumLaunchOptions } from "../../../scripts/browser.mjs";

const base = new URL(process.env.ANNOTATION_STUDIO_URL ?? "http://127.0.0.1:8000/");
const mode = process.env.VIEWER_MODE;
assert.ok(["patinae", "molstar"].includes(mode));
const finalCif = await readFile(new URL("../../../tests/fixtures/minimal_multichain.cif", import.meta.url), "utf8");
// A small synthetic backbone. Monotonically increasing atom IDs across models
// guard the upstream mmCIF bug that previously discarded all but the first frame.
const header = finalCif.slice(0, finalCif.indexOf("ATOM 1"));
const rows = Array.from({ length: 24 }, (_, row) => {
  const model = Math.floor(row / 8) + 1, residue = row % 8 + 1;
  const x = (residue * 3).toFixed(3);
  const y = (Math.sin(residue + model) * 2).toFixed(3);
  const z = (Math.cos(residue + model) * 2).toFixed(3);
  return `ATOM ${row + 1} C CA . ALA A 1 ${residue} ? ${x} ${y} ${z} 1.00 10.00 ${residue} ALA A CA ${model}`;
});
const trajectory = header + rows.join("\n") + "\n#\n";
const browser = await chromium.launch(chromiumLaunchOptions());
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const response = await page.request.post(new URL("api/v1/sessions", base).href, {
    multipart: { file: { name: "design.cif", mimeType: "chemical/x-cif", buffer: Buffer.from(finalCif) } },
  });
  assert.equal(response.status(), 200, await response.text());
  const { session_id: session } = await response.json();
  const snapshot = async () => {
    const result = await page.request.post(new URL(`api/v1/sessions/${session}/export`, base).href);
    const data = await result.json();
    return { revision: data.revision, cif: data.cif.replace(/^_entry\.(date|time).*$/gm, "") };
  };
  const before = await snapshot();
  const trajectoryUrl = new URL("test-trajectory.cif", base);
  await page.route(trajectoryUrl.href, route => route.fulfill({ contentType: "text/plain", body: trajectory }));
  const url = new URL(base); url.search = new URLSearchParams({ viewer: mode, session, trajectory: trajectoryUrl.pathname }).toString();
  await page.goto(url.href);
  await page.locator("#trajectory-toggle").click({ timeout: 60000 });
  await page.locator("#trajectory-position").filter({ hasText: "Frame 1 / 3" }).waitFor();
  assert.equal(await page.locator("#viewer").getAttribute("data-backend"), mode);
  assert.equal(await page.locator("#atomworks-studio-popover").evaluate(el => el.inert), true);
  await page.waitForTimeout(300);
  const first = await page.locator("#viewer canvas").first().screenshot();
  await page.locator("#trajectory-frame").fill("2");
  await page.locator("#trajectory-position").filter({ hasText: "Frame 3 / 3" }).waitFor();
  await page.waitForTimeout(300);
  assert.notDeepEqual(await page.locator("#viewer canvas").first().screenshot(), first);
  await page.locator("#trajectory-play").click();
  await page.waitForFunction(() => document.querySelector("#trajectory-frame").value !== "2");
  await page.locator("#trajectory-play").click();
  await page.locator("#trajectory-toggle").click();
  await page.locator("#trajectory-toggle").filter({ hasText: "Show trajectory" }).waitFor();
  assert.deepEqual(await snapshot(), before);
  assert.equal(await page.locator("#atomworks-studio-popover").evaluate(el => el.inert), false);
  assert.deepEqual(errors, []);
  console.log(`${mode}: trajectory frames, rendered scrubbing, play/pause, read-only playback and final CIF preservation passed`);
} finally {
  await browser.close();
}
