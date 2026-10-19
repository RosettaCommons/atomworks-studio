import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright-core";
import { chromiumLaunchOptions } from "../../../scripts/browser.mjs";

const base = process.env.ANNOTATION_STUDIO_URL ?? "http://127.0.0.1:8001/";
const modes = process.env.VIEWER_MODE ? [process.env.VIEWER_MODE] : ["molstar", "patinae"];
const output = "artifacts/local/example-actions";
await mkdir(output, { recursive: true });
const report = [];
const browser = await chromium.launch(chromiumLaunchOptions());
try {
  for (const mode of modes) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${base}?viewer=${mode}`);
    await page.waitForFunction(() => document.querySelector("#status")?.textContent.includes("Ready."));
    const allExamples = await (await page.request.get(`${base}api/v1/examples`)).json();
    const examples = process.env.STUDIO_AUDIT_EXAMPLES
      ? allExamples.filter(example => process.env.STUDIO_AUDIT_EXAMPLES.split(",").includes(example.id))
      : allExamples;
    const settled = () => page.waitForFunction(() => !document.querySelector("#viewer-mode").disabled);
    async function load(example) {
      await page.locator("#editor-tab-main").click();
      if (await page.locator("#examples-panel").getAttribute("open") === null) {
        await page.locator("#examples-panel > summary").click();
      }
      const response = page.waitForResponse(r => r.url().endsWith("/sessions") && r.request().method() === "POST");
      await page.locator(`[data-example="${example.id}"]`).click();
      const result = await response;
      assert.equal(result.status(), 200, await result.text());
      await page.waitForFunction(label => document.querySelector("#status-message").textContent.includes(`Loaded ${label}`), example.label);
      await settled();
      if (await page.locator("#error-banner").isVisible()) await page.locator("#dismiss-error").click();
      return result.json();
    }
    async function post(button, endpoint) {
      const response = page.waitForResponse(r => new URL(r.url()).pathname.endsWith(endpoint) && r.request().method() === "POST", { timeout: 160000 });
      await page.locator(button).click();
      const result = await response;
      assert.equal(result.status(), 200, await result.text());
      await settled();
      assert.equal(await page.locator("#error-banner").isVisible(), false, await page.locator("#error-message").textContent());
      return result.json();
    }
    async function mainCard(button) {
      await page.locator("#editor-tab-main").click();
      const card = page.locator(`details:has(${button})`).last();
      if (await card.getAttribute("open") === null) await card.locator(":scope > summary").click();
    }
    for (const example of examples) {
      let initial;
      async function check(name, run) {
        const entry = { mode, example: example.id, action: name };
        const errorStart = errors.length;
        try {
          const skipped = await run();
          if (skipped) entry.skipped = skipped;
          assert.deepEqual(errors.slice(errorStart), []);
          entry.ok = true;
        } catch (error) {
          entry.ok = false;
          entry.error = String(error);
          await page.screenshot({ path: `${output}/${mode}-${example.id}-${name}.png` });
          for (const dialog of await page.locator('dialog[open] button[value="cancel"]').all()) await dialog.click();
          await page.reload();
          await page.waitForFunction(() => !document.querySelector("#download").disabled);
          initial = await load(example);
        }
        report.push(entry);
        console.log(JSON.stringify(entry));
        await writeFile(`${output}/report-${mode}${process.env.STUDIO_AUDIT_EXAMPLES ? "-focused" : ""}.json`, JSON.stringify(report.filter(r => r.mode === mode), null, 2));
      }
      await check("load", async () => { initial = await load(example); });
      await check("validate", async () => {
        const result = await post("#validate", "/validate");
        assert.deepEqual(result.issues, []);
      });
      await check("sequence-toggle", async () => {
        if (!await page.locator(".sequence-token[data-atoms]").count()) {
          assert.ok(await page.locator(".sequence-segment").count());
          return "Segment-only example has no residue to select";
        }
        const residue = page.locator(".sequence-token[data-atoms]").first();
        await residue.click();
        assert.doesNotMatch(await page.locator("#selection-count").innerText(), /^0 atoms/);
        await residue.click();
        assert.match(await page.locator("#selection-count").innerText(), /^0 atoms/);
      });
      await check("styles", async () => {
        await page.locator("#style-menu > summary").click();
        await page.locator("#viewer-action-target").selectOption("all");
        if (await page.locator("#style-unavailable").isVisible()) {
          assert.equal(await page.locator('[data-representation]:enabled, [data-color]:enabled').count(), 0);
          await page.keyboard.press("Escape");
          return;
        }
        for (const action of ["show", "hide"]) {
          await page.locator(`input[name="representation-action"][value="${action}"]`).check();
          await page.locator('[data-representation="sticks"]').click();
          await page.waitForFunction(action => document.querySelector("#status-message").textContent.startsWith(`${action === "show" ? "Show" : "Hide"} sticks`), action);
          await settled();
        }
        for (const color of ["atomic", "chain"]) {
          const button = page.locator(`[data-color="${color}"]`);
          if (await button.isVisible()) {
            await button.click();
            await settled();
          }
        }
        await page.keyboard.press("Escape");
        assert.equal(await page.locator("#error-banner").isVisible(), false);
      });
      await check("condition-highlights", async () => {
        await page.locator("#editor-tab-annotations").click();
        for (const row of await page.locator("#annotation-list [data-view-key]").all()) {
          await row.click();
          await page.waitForFunction(() => !document.querySelector("#clear-annotation-view").disabled);
          await row.click();
          await page.waitForFunction(() => document.querySelector("#clear-annotation-view").disabled);
        }
      });
      await check("condition-edit-undo", async () => {
        if (!await page.locator(".sequence-token[data-atoms]").count()) return "No real residue to condition";
        await page.locator("#clear-selection").click();
        await page.locator(".sequence-token[data-atoms]").first().click();
        await page.locator("#editor-tab-annotations").click();
        await page.locator("#condition").selectOption("sequence");
        await page.locator("#enabled").uncheck();
        const result = await post("#apply-condition", "/conditions");
        if (result.structure.undo_depth > initial.structure.undo_depth) await post("#undo", "/undo");
      });
      await check("protonate-save-undo", async () => {
        await page.locator("#editor-tab-structure").click();
        const result = await post("#protonate", "/protonate");
        assert.ok(result.edit_result.hydrogen_count >= 0);
        await page.screenshot({ path: `${output}/${mode}-${example.id}-protonated.png` });
        const downloaded = page.waitForEvent("download");
        const exported = page.waitForResponse(r => r.url().endsWith("/export"));
        await page.locator("#download").click();
        const exportResult = await exported;
        assert.equal(exportResult.status(), 200, await exportResult.text());
        if ((await exportResult.json()).issues.length) await page.locator('dialog.confirmation button[value="confirm"]').click();
        const file = await downloaded;
        await file.saveAs(`${output}/${mode}-${example.id}.cif`);
        const undone = await post("#undo", "/undo");
        assert.equal(undone.structure.atom_count, initial.structure.atom_count);
      });
      await check("charge-undo", async () => {
        if (!await page.locator(".sequence-token[data-atoms]").count()) return "No real atom to charge";
        await page.locator("#editor-tab-structure").click();
        await page.locator("#clear-selection").click();
        await page.locator(".sequence-token[data-atoms]").first().click();
        await page.locator("#charge-action").selectOption("delta");
        await page.locator("#charge").fill("1");
        await post("#apply-charge", "/charges");
        await post("#undo", "/undo");
        await page.locator("#clear-selection").click();
      });
      await check("bonds-inspect-edit-undo", async () => {
        await page.locator("#editor-tab-structure").click();
        const inspected = page.waitForResponse(r => new URL(r.url()).pathname.endsWith("/bonds"));
        await page.locator("#inspect-bonds").click();
        const inspection = await (await inspected).json();
        if (inspection.bonds.length) {
          await page.locator("#bond-list button").first().click();
          await post("#remove-bond", "/bonds");
          await post("#undo", "/undo");
        } else {
          await page.locator("#bond-list").getByText("No bonds found.").waitFor();
          await page.locator("#inspect-bonds").click();
        }
        await page.locator("#clear-selection").click();
        await post("#infer-bonds", "/bonds/infer-ccd");
        await post("#undo", "/undo");
      });
      await check("segment-undo", async () => {
        await mainCard("#insert-segment");
        await page.locator("#segment-new-chain").check();
        assert.ok(await page.locator("#segment-chain-id").inputValue());
        await post("#insert-segment", "/segments");
        await post("#undo", "/undo");
      });
      await check("delete-and-renumber-undo", async () => {
        if (initial.structure.atom_count === 1) return "Cannot delete the sole expandable segment";
        await mainCard("#delete-atoms");
        await page.locator("#clear-selection").click();
        await page.locator(".sequence-token[data-atoms]").first().click();
        await post("#delete-atoms", "/delete");
        await post("#undo", "/undo");
        await post("#reset-residues", "/reset-residue-ids");
        await post("#undo", "/undo");
      });
      await check("analysis", async () => {
        await page.locator('[data-menu="analyze"] > summary').click();
        const result = await post("#run-analysis", "/interactions/analyze");
        assert.ok(Array.isArray(result.interactions));
        await page.locator("#clear-analysis-visuals").click();
        await page.keyboard.press("Escape");
      });
      await check("reset-undo", async () => {
        await post("#reset-conditions", "/conditions/reset");
        assert.match(await page.locator("#selection-count").innerText(), /^0 atoms/);
        await post("#undo", "/undo");
      });
      await check("close", async () => {
        await page.locator("#close-structure").click();
        await page.locator('dialog.confirmation button[value="confirm"]').click();
        await page.waitForFunction(() => document.querySelector("#status")?.textContent.includes("Ready.") && document.querySelector("#download").disabled);
        assert.equal(await page.locator(".sequence-token").count(), 0);
      });
    }
    await context.close();
  }
} finally {
  await browser.close();
}
assert.deepEqual(report.filter(r => !r.ok), []);
console.log(`${report.length} example/action checks passed`);
