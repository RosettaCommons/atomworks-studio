import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { chromiumLaunchOptions } from "../../../scripts/browser.mjs";

const baseUrl = process.env.ANNOTATION_STUDIO_URL ?? "http://127.0.0.1:8000/";
const backend = process.env.VIEWER_MODE;
assert.ok(["molstar", "patinae"].includes(backend));
const browser = await chromium.launch(chromiumLaunchOptions());
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${baseUrl}?viewer=${backend}`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => document.querySelector("#status")?.textContent?.includes("Ready."));
  assert.deepEqual(await page.locator("#selection-syntax option").allTextContents(), ["PyMOL commands", "AtomWorks query"]);
  assert.equal(await page.locator("#selection-syntax option").first().isDisabled(), backend === "molstar");
  await page.locator("#file-input").setInputFiles(fileURLToPath(new URL("../../../tests/fixtures/minimal_multichain.cif", import.meta.url)));
  await page.waitForFunction(() => !document.querySelector("#download").disabled);
  for (const [syntax, expression, indices] of [
    ["expression", "atom_name == 'CA'", [1, 3]],
    ["path", "[A,B]/*/*/CA", [1, 3]],
    ["path", "A/*/[1-3]", [0, 1]],
    ["path", "A/*/*/N, B/*/*/CA", [0, 3]],
    ["path", "[A,Z]/*/*/CA", [1]],
    ["expression", "sel('[A,B]/*/*/CA')", [1, 3]],
    ["expression", "sel('A') and element == 'N'", [0]],
    ["expression", "element in ['N', 'O']", [0, 2]],
    ["expression", "has_nan_coord()", []],
    ["path", "Z", []],
    ["expression", "chain_id == 'A'", [0, 1]],
  ]) {
    await page.locator("#selection-syntax").selectOption("expression");
    await page.locator("#viewer-command").fill(syntax === "path" ? `sel(${JSON.stringify(expression)})` : expression);
    const response = page.waitForResponse((r) => r.url().endsWith("/selections/query"));
    await page.locator("#run-viewer-command").click();
    const result = await response;
    assert.equal(result.status(), 200, await result.text());
    assert.deepEqual((await result.json()).atom_indices, indices, `${syntax}: ${expression}`);
    await page.waitForFunction((count) => document.querySelector("#selection-count")?.textContent?.startsWith(`${count} atom`), indices.length);
  }
  for (const [syntax, expression] of [["path", "A/*/1-3"], ["expression", "__import__('os')"]]) {
    await page.locator("#selection-syntax").selectOption("expression");
    await page.locator("#viewer-command").fill(syntax === "path" ? `sel(${JSON.stringify(expression)})` : expression);
    const response = page.waitForResponse((r) => r.url().endsWith("/selections/query"));
    await page.locator("#run-viewer-command").click();
    assert.equal((await response).status(), 422);
    await page.waitForFunction(() => document.querySelector("#status")?.textContent?.includes("Error:"));
    assert.match(await page.locator("#selection-count").innerText(), /^2 atoms/, "invalid queries keep the selection");
  }
  if (backend === "patinae") {
    await page.locator("#selection-syntax").selectOption("patinae");
    async function command(text, count) {
      await page.locator("#viewer-command").fill(text);
      await page.locator("#run-viewer-command").click();
      await page.waitForFunction(() => document.querySelector("#viewer-command").value === ""
        || document.querySelector("#status").textContent.split("\n")[0].includes("Command failed"));
      assert.doesNotMatch((await page.locator("#status").textContent()).split("\n")[0], /Command failed/, text);
      assert.match(await page.locator("#selection-count").textContent(), new RegExp(`^${count} atoms? selected`), text);
    }
    for (const [text, count] of [
      ["select sele, name CA", 2],
      ["select site, chain A and name N", 1],
      ["select sele, resi 1", 4],
      ["select sele, (name N or name CA) and chain A", 2],
      ["select sele, none", 0],
      ["select sele, all", 4],
      ["deselect", 0],
      ["select sele, name CA", 2],
      ["show spheres, sele", 2], ["hide spheres, sele", 2],
      ["color blue, sele", 2], ["zoom sele", 2], ["center sele", 2], ["orient sele", 2],
    ]) await command(text, count);
    for (const text of ["select sele, nonsense_keyword foo", "not_a_command all", "alter sele, b=5", "remove none", "remove"]) {
      const previousStatus = await page.locator("#status").textContent();
      await page.locator("#viewer-command").fill(text);
      await page.locator("#run-viewer-command").click();
      await page.waitForFunction(previous => document.querySelector("#status").textContent !== previous
        && document.querySelector("#status").textContent.split("\n")[0].includes("Command failed"), previousStatus);
      assert.equal(await page.locator("#viewer-command").inputValue(), text, "errors keep input for correction");
      assert.match(await page.locator("#selection-count").textContent(), /^2 atoms/, "errors keep editing selection");
    }
    await command("select sele, name CA", 2);
    await page.locator("#editor-tab-annotations").click();
    await page.locator("#condition").selectOption("hotspot");
    const applied = page.waitForResponse(r => r.url().endsWith("/conditions") && r.request().method() === "POST");
    await page.locator("#apply-condition").click();
    const response = await applied;
    assert.deepEqual(response.request().postDataJSON().atom_indices, [1, 3], "PyMOL selection drives the actual edit");
    assert.equal((await response.json()).structure.condition_counts.hotspot, 2);
    await page.waitForFunction(() => !document.querySelector("#viewer-mode").disabled);
    await command("select sele, name CA", 2);
    const deleted = page.waitForResponse(r => r.url().endsWith("/delete"));
    await command("remove sele", 0);
    const deletion = await deleted;
    assert.deepEqual(deletion.request().postDataJSON().atom_indices, [1, 3]);
    assert.equal((await deletion.json()).structure.atom_count, 2, "remove edits the saved document");
    const restored = page.waitForResponse(r => r.url().endsWith("/undo"));
    await page.locator("#undo").click();
    const restoredStructure = (await (await restored).json()).structure;
    assert.equal(restoredStructure.atom_count, 4);
    assert.equal(restoredStructure.condition_counts.hotspot, 2, "Undo restores annotations as well as atoms");
    await page.waitForFunction(() => !document.querySelector("#viewer-mode").disabled);
    const undone = page.waitForResponse(r => r.url().endsWith("/undo"));
    await page.locator("#undo").click();
    assert.equal((await (await undone).json()).structure.undo_depth, 0);
    await page.waitForFunction(() => !document.querySelector("#viewer-mode").disabled);
    console.log("patinae: PyMOL selections, styling, errors, annotation targeting, document removal and Undo passed");
  }
  assert.equal(await page.locator("#undo").isDisabled(), true, "selection does not add document edits");
  assert.equal(await page.locator("#viewer").getAttribute("data-backend"), backend, "test the requested renderer without fallback");
  assert.deepEqual(errors, []);
  console.log(`${backend}: 11 selection workflows, invalid syntax, and unchanged undo history passed`);
} finally {
  await browser.close();
}
