import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";
import { chromiumLaunchOptions } from "../../../scripts/browser.mjs";

const base = process.env.ANNOTATION_STUDIO_URL ?? "http://127.0.0.1:8001/";
const output = "artifacts/local/condition-presentation";
await mkdir(output, { recursive: true });
const browser = await chromium.launch(chromiumLaunchOptions());
try {
  for (const mode of ["molstar", "patinae"]) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const created = await page.request.post(`${base}api/v1/sessions`, { multipart: {
      file: { name: "presentation.cif", mimeType: "chemical/x-mmcif", buffer: await readFile(new URL("../../../tests/fixtures/minimal_multichain.cif", import.meta.url)) },
      parse_preset: "minimal",
    } });
    assert.equal(created.status(), 200);
    const { session_id: session } = await created.json();
    for (const [atoms, value] of [[[0, 1], 3], [[2], 1]]) {
      const edited = await page.request.post(`${base}api/v1/sessions/${session}/conditions`, {
        data: { condition: "hbond", atom_indices: atoms, enabled: true, value },
      });
      assert.equal(edited.status(), 200, await edited.text());
    }
    await page.goto(`${base}?viewer=${mode}&session=${session}`);
    await page.waitForFunction(() => !document.querySelector("#download").disabled && !document.querySelector("#viewer-mode").disabled);
    await page.locator("#editor-tab-annotations").click();
    for (const key of ["n_terminus", "c_terminus", "internal_coordinate"]) {
      assert.equal(await page.locator(`#condition option[value="${key}"]`).count(), 0);
    }
    assert.equal(await page.locator('#condition option[value="na_ss_state"]').textContent(), "Nucleic Acid Secondary Structure");
    await page.locator("#condition").selectOption("hbond");
    await page.locator("#condition-value-input").selectOption("3");
    await page.locator("#enabled").uncheck();
    assert.equal(await page.locator("#condition-value-input").isVisible(), false);
    await page.locator("#enabled").check();
    assert.equal(await page.locator("#condition-value-input").inputValue(), "3");
    await page.locator('[data-view-key="annotations/hbond"]').click();
    await page.waitForFunction(() => document.querySelector("#annotation-detail").textContent.includes("BOTH"));

    const detail = await page.locator("#annotation-detail").textContent();
    assert.match(detail, /BOTH: 2 atoms \(cyan\)/);
    assert.match(detail, /DONOR: 1 atom \(magenta\)/);
    assert.doesNotMatch(detail, /=\s*[123]/);
    await page.waitForFunction(() => !document.querySelector("#viewer-mode").disabled);
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${output}/${mode}.png` });
    await page.locator("#condition").selectOption({ label: "Sequence probability" });
    await page.locator("#enabled").uncheck();
    assert.equal(await page.locator("#condition-value-input").isVisible(), false);
    assert.equal(await page.locator("#condition-residue-type").isVisible(), true);
    await page.locator("#condition").selectOption("coordinate_group");
    assert.equal(await page.locator("#group-new").isVisible(), true);
    assert.equal(await page.locator("#clear-internal-targets").count(), 0);
    await page.locator("#condition").selectOption("index");
    assert.equal(await page.locator("#enabled").isVisible(), false);
    assert.match(await page.locator("#condition-value").innerText(), /All residues are indexed by default/);
    const indexRow = page.locator('[data-view-key="annotations/index"]');
    assert.equal(await indexRow.count(), 0);
    for (const [button, unindexed] of [["#unindex-selection", true], ["#restore-indexing", false]]) {
      await page.locator("#clear-selection").click();
      await page.locator(".sequence-token[data-atoms]").first().click();
      const pending = page.waitForResponse(r => r.url().endsWith("/conditions") && r.request().method() === "POST");
      await page.locator(button).click();
      const result = await pending;
      assert.equal(result.status(), 200, await result.text());
      await page.waitForFunction(() => !document.querySelector("#viewer-mode").disabled);
      assert.equal(await indexRow.count(), unindexed ? 1 : 0);
      if (unindexed) {
        assert.match(await indexRow.innerText(), /Unindexed residues/);
        const detail = await (await page.request.get(`${base}api/v1/sessions/${session}/annotations/index`)).json();
        assert.deepEqual(detail.annotation.values[0].atom_indices, [0, 1]);
      }
    }
    const absolute = await page.request.post(`${base}api/v1/sessions/${session}/conditions`, {
      data: { condition: "coordinate", atom_indices: [0, 1, 2, 3], enabled: true },
    });
    assert.equal(absolute.status(), 200, await absolute.text());
    await page.reload();
    await page.waitForFunction(() => !document.querySelector("#download").disabled && !document.querySelector("#viewer-mode").disabled);
    await page.locator("#editor-tab-annotations").click();
    await page.locator("#condition").selectOption("coordinate_group");
    assert.equal(await page.locator("#condition-group").isDisabled(), true);
    assert.match(await page.locator("#condition-group").innerText(), /No groups yet/);
    await page.locator(".sequence-token[data-atoms]").first().click();
    assert.equal(await page.locator("#group-add").isDisabled(), true);
    for (const action of ["new", "add"]) {
      if (action === "add") await page.locator(".sequence-token[data-atoms]").nth(1).click();
      const pending = page.waitForResponse(r => r.url().endsWith("/groups") && r.request().method() === "POST");
      await page.locator(`#group-${action}`).click();
      const response = await pending;
      assert.equal(response.status(), 200, await response.text());
      const result = await response.json();
      assert.equal(result.structure.condition_counts.coordinate ?? 0, action === "new" ? 2 : 0);
      assert.deepEqual(result.structure.condition_editors.groups.coordinate_group.map(g => g.id), [1]);
      await page.waitForFunction(() => !document.querySelector("#viewer-mode").disabled);
      assert.equal(await page.locator("#condition-group").isEnabled(), true);
      assert.equal(await page.locator("#condition-group").inputValue(), "1");
    }
    assert.deepEqual(errors, []);
    console.log(`${mode}: hidden conditions, readable labels and colors, disabled values, preserved drafts, and group controls passed`);
    await page.close();
  }
} finally {
  await browser.close();
}
