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
  assert.deepEqual(await page.locator("#selection-syntax option").allTextContents(),
    backend === "molstar" ? ["AtomWorks query"] : ["PyMOL commands", "AtomWorks query"]);
  await page.locator(".load-options > summary").click();
  await page.locator("#parse-preset").selectOption("minimal");
  await page.locator(".load-options > summary").click();
  await page.locator("#file-input").setInputFiles(fileURLToPath(new URL("../../../tests/fixtures/minimal_multichain.cif", import.meta.url)));
  await page.waitForFunction(() => !document.querySelector("#download").disabled);
  async function assertSelection(count) {
    await page.waitForFunction((count) => document.querySelector("#selection-count")?.textContent?.startsWith(`${count} atom`), count);
    const atoms = `${count} atom${count === 1 ? "" : "s"}`;
    assert.equal(await page.locator("#active-selection-count").textContent(), `${atoms} in active selection`);
    assert.equal(await page.locator("#structure-edit-feedback").textContent(), `${atoms} selected`);
  }
  await assertSelection(0);
  assert.deepEqual(await page.locator("#pick-scope option").allTextContents(), ["Atoms", "Residues", "Chains"]);
  assert.equal(await page.locator("#pick-scope").inputValue(), "atom");
  const residues = page.locator(".sequence-token[data-atoms]");
  const first = residues.nth(0);
  const second = residues.nth(1);
  await first.click();
  await assertSelection(2);
  await first.click();
  await assertSelection(0);
  assert.equal(await first.getAttribute("aria-pressed"), "false");
  await first.click();
  await second.click();
  await assertSelection(4);
  await first.click();
  await assertSelection(2);
  assert.equal(await second.getAttribute("aria-pressed"), "true", "unrelated residue remains selected");
  await second.press("Enter");
  await assertSelection(0);
  await second.press("Space");
  await assertSelection(2);
  await second.press("Space");
  await assertSelection(0);
  await page.locator("#selection-syntax").selectOption("expression");
  await page.locator("#viewer-command").fill("atom_name == 'CA'");
  await page.locator("#run-viewer-command").click();
  await assertSelection(2);
  assert.equal(await first.getAttribute("aria-pressed"), "mixed");
  await first.click();
  await assertSelection(3);
  assert.equal(await first.getAttribute("aria-pressed"), "true");
  await first.click();
  await assertSelection(1);
  assert.equal(await second.getAttribute("aria-pressed"), "mixed", "other residue's individual atom remains selected");
  await page.locator("#clear-selection").click();
  await assertSelection(0);
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
    await assertSelection(indices.length);
    for (const token of await page.locator(".sequence-token[data-atoms]").all()) {
      const atoms = (await token.getAttribute("data-atoms")).split(",").map(Number);
      const selected = atoms.filter(index => indices.includes(index)).length;
      const expected = selected === 0 ? "false" : selected === atoms.length ? "true" : "mixed";
      assert.equal(await token.getAttribute("aria-pressed"), expected);
    }
  }
  for (const [syntax, expression] of [["path", "A/*/1-3"], ["expression", "__import__('os')"]]) {
    await page.locator("#selection-syntax").selectOption("expression");
    await page.locator("#viewer-command").fill(syntax === "path" ? `sel(${JSON.stringify(expression)})` : expression);
    const response = page.waitForResponse((r) => r.url().endsWith("/selections/query"));
    await page.locator("#run-viewer-command").click();
    assert.equal((await response).status(), 422);
    await page.waitForFunction(() => document.querySelector("#status")?.textContent?.includes("Error:"));
    await assertSelection(2);
  }
  if (backend === "patinae") {
    await page.locator("#selection-syntax").selectOption("patinae");
    async function command(text, count) {
      await page.locator("#viewer-command").fill(text);
      await page.locator("#run-viewer-command").click();
      await page.waitForFunction(() => document.querySelector("#viewer-command").value === ""
        || document.querySelector("#status").textContent.split("\n")[0].includes("Command failed"));
      assert.doesNotMatch((await page.locator("#status").textContent()).split("\n")[0], /Command failed/, text);
      await assertSelection(count);
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
      await assertSelection(2);
    }
    await command("select site, chain A and name N", 1);
    await command("select sele, name CA", 2);
    await page.locator("#editor-tab-main").click();
    await page.locator("#selections-drawer > summary").click();
    await page.locator("#selection-list button").filter({ hasText: /^site(?: ·|$)/ }).click();
    await assertSelection(1);
    await command("select sele, name CA", 2);
    await page.locator("#editor-tab-annotations").click();
    await page.locator("#condition").selectOption("hotspot");
    const applied = page.waitForResponse(r => r.url().endsWith("/conditions") && r.request().method() === "POST");
    await page.locator("#apply-condition").click();
    const response = await applied;
    assert.deepEqual(response.request().postDataJSON().atom_indices, [1, 3], "PyMOL selection drives the actual edit");
    assert.equal((await response.json()).structure.condition_counts.hotspot, 2);
    await page.waitForFunction(() => !document.querySelector("#viewer-mode").disabled);
    await assertSelection(0);
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
    await assertSelection(0);
    console.log("patinae: PyMOL selections, styling, errors, annotation targeting, document removal and Undo passed");
  }
  assert.equal(await page.locator("#undo").isDisabled(), true, "selection does not add document edits");
  assert.equal(await page.locator("#viewer").getAttribute("data-backend"), backend, "test the requested renderer without fallback");
  let reached, release;
  const requested = new Promise(resolve => { reached = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  await page.route("**/selections/query", async route => { reached(); await held; await route.continue(); });
  await page.locator("#selection-syntax").selectOption("expression");
  await page.locator("#viewer-command").fill("chain_id == 'A'");
  await page.locator("#run-viewer-command").click();
  await requested;
  await page.locator("#clear-selection").click();
  const resolved = page.waitForResponse(r => r.url().endsWith("/selections/query"));
  release();
  await resolved;
  await page.waitForTimeout(100);
  await assertSelection(0);
  await page.unroute("**/selections/query");
  assert.deepEqual(errors, []);
  console.log(`${backend}: 11 selection workflows, invalid syntax, and unchanged undo history passed`);
} finally {
  await browser.close();
}
