import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { chromiumLaunchOptions } from "../../../scripts/browser.mjs";

const baseUrl = process.env.ANNOTATION_STUDIO_URL ?? "http://127.0.0.1:8000/";
const backend = process.env.VIEWER_MODE;
assert.ok(["molstar", "patinae"].includes(backend));
const browser = await chromium.launch(chromiumLaunchOptions());
let ui;
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(mode => localStorage.setItem("annotation-studio-viewer-v2", mode), backend);
  await page.goto(process.env.GRADIO_URL ?? `${baseUrl}?viewer=${backend}`, { waitUntil: "domcontentloaded" });
  if (process.env.GRADIO_URL) await page.locator('iframe[title="AtomWorks Studio"]').waitFor();
  ui = process.env.GRADIO_URL
    ? await page.locator('iframe[title="AtomWorks Studio"]').elementHandle().then(element => element.contentFrame())
    : page;
  await ui.waitForFunction(() => document.querySelector("#status")?.textContent?.includes("Ready."));
  const upload = page.waitForResponse((r) => r.url().endsWith("/sessions") && r.request().method() === "POST");
  await ui.locator("#file-input").setInputFiles(fileURLToPath(new URL("../../../tests/fixtures/SAM_hbonds.cif", import.meta.url)));
  const loaded = await (await upload).json();
  const session = loaded.session_id;
  await ui.waitForFunction(() => document.querySelector("#structure-summary")?.textContent?.includes("66"));
  assert.ok(await ui.locator("#atomworks-studio-popover").isVisible());

  async function select(expression, count) {
    await ui.locator("#selection-syntax").selectOption("expression");
    await ui.locator("#viewer-command").fill(expression);
    await ui.locator("#run-viewer-command").click();
    await ui.waitForFunction((count) => document.querySelector("#selection-count")?.textContent?.startsWith(`${count} atom`), count);
    const atoms = `${count} atom${count === 1 ? "" : "s"}`;
    assert.equal(await ui.locator("#active-selection-count").textContent(), `${atoms} in active selection`);
    assert.equal(await ui.locator("#structure-edit-feedback").textContent(), `${atoms} selected`);
  }
  async function edit(button, endpoint) {
    const response = page.waitForResponse((r) => r.url().endsWith(endpoint) && r.request().method() === "POST");
    await ui.locator(button).click();
    const result = await response;
    assert.equal(result.status(), 200, await result.text());
    await ui.waitForFunction(() => !document.querySelector("#viewer-mode")?.disabled);
    return result.json();
  }
  async function summary() {
    return (await (await page.request.get(`${baseUrl}api/v1/sessions/${session}`)).json()).structure;
  }

  await select("(atom_id >= 1) & (atom_id <= 10)", 10);
  await ui.locator("#editor-tab-main").click();
  await ui.locator("#selections-drawer > summary").click();
  assert.equal(await ui.locator("#active-selection-count").innerText(), "10 atoms in active selection");
  await ui.locator("#clear-selection").click();
  assert.equal(await ui.locator("#active-selection-count").innerText(), "0 atoms in active selection");
  await ui.locator(".sequence-token").first().click();
  const picked = (await ui.locator("#selection-count").innerText()).split(" selected")[0];
  assert.notEqual(picked, "0 atoms");
  assert.equal(await ui.locator("#active-selection-count").innerText(), `${picked} in active selection`);
  await ui.locator("#clear-selection").click();
  await ui.locator("#editor-tab-annotations").click();
  await ui.locator("#condition").selectOption("index_group");
  await select("atom_id == 1", 1);
  const created = await edit("#group-new", "/groups");
  const group = created.edit_result.group_id;
  assert.match(await ui.locator("#selection-count").innerText(), /^0 atoms/);
  await ui.locator("#condition-group").selectOption(String(group));
  assert.match(await ui.locator("#condition-group option:checked").innerText(), /65 atoms/);
  await select("atom_id == 65", 1);
  await edit("#group-add", "/groups");
  assert.match(await ui.locator("#condition-group option:checked").innerText(), /66 atoms/);
  await ui.locator("#annotation-list > .annotation-row").filter({ hasText: "Index Group" }).click();
  await ui.waitForFunction(() => Number(document.querySelector("#viewer")?.dataset.annotationAtoms) > 0);
  await select("atom_id == 3", 1);
  await edit("#group-add", "/groups");
  assert.match(await ui.locator("#selection-count").innerText(), /^1 atom/);
  const inspected = (await (await page.request.get(`${baseUrl}api/v1/sessions/${session}/annotations/index_group`)).json()).annotation;
  assert.equal(Number(await ui.locator("#viewer").getAttribute("data-annotation-atoms")),
    new Set(inspected.values.flatMap((value) => value.atom_indices)).size);
  await edit("#group-delete", "/groups");
  assert.ok(!(await summary()).condition_editors.groups.index_group.some((entry) => entry.id === group));
  await edit("#undo", "/undo");
  assert.ok((await summary()).condition_editors.groups.index_group.some((entry) => entry.id === group));

  await ui.locator("#condition").selectOption("chain_centroid");
  const centroids = (await summary()).condition_editors.centroids.chain_centroid;
  const chain = centroids.find((entry) => entry.current)?.chain;
  assert.ok(chain);
  await ui.locator("#centroid-chain").selectOption(chain);
  await ui.locator("#centroid-fill").click();
  const values = await Promise.all(["x", "y", "z"].map((axis) => ui.locator(`#condition-value-${axis}`).inputValue()));
  assert.ok(values.every((value) => /^-?\d+\.\d$/.test(value)));
  await edit("#centroid-set", "/centroids");
  assert.equal(await ui.locator("#viewer").getAttribute("data-centroid-markers"), "1");
  assert.deepEqual((await summary()).condition_editors.centroids.chain_centroid.find((entry) => entry.chain === chain).target
    .map((value) => value.toFixed(1)), values);
  if (process.env.ANNOTATION_SCREENSHOT_DIR) {
    await page.screenshot({ path: resolve(process.env.ANNOTATION_SCREENSHOT_DIR, `${backend}-centroid.png`) });
  }
  await ui.locator("#centroid-markers").uncheck();
  await ui.waitForFunction(() => document.querySelector("#viewer")?.dataset.centroidMarkers === "0");
  await ui.locator("#centroid-markers").check();
  await ui.waitForFunction(() => document.querySelector("#viewer")?.dataset.centroidMarkers === "1");
  const field = (await summary()).stored_fields.find((entry) => /centroid/i.test(entry.name));
  assert.ok(field);
  await ui.locator("#annotation-list details > summary").click();
  await ui.locator(".annotation-field-row").filter({ hasText: field.label }).click();
  await ui.waitForFunction(() => document.querySelector("#annotation-detail")?.textContent?.includes("Raw field preview"));
  await edit("#undo", "/undo");
  assert.doesNotMatch(await ui.locator("#status").textContent(), /Error:/);
  assert.equal(await ui.locator("#viewer").getAttribute("data-centroid-markers"), "0");
  await edit("#centroid-set", "/centroids");
  await edit("#centroid-clear", "/centroids");
  assert.equal(await ui.locator("#viewer").getAttribute("data-centroid-markers"), "0");

  if (await ui.locator('#condition option[value="distance"]').count()) {
    await ui.locator("#condition").selectOption("distance");
    await select("(atom_id == 1) | (atom_id == 2)", 2);
    await ui.locator("#pair-use-selection").click();
    await ui.waitForFunction(() => document.querySelector("#pair-atom-0")?.textContent?.includes("/"));
    const distanceResponse = page.waitForResponse((r) => r.url().includes("/atom-distance?"));
    await ui.locator("#pair-actual").click();
    const distance = (await (await distanceResponse).json()).distance;
    await ui.waitForFunction((distance) => document.querySelector("#pair-distance")?.value === distance.toFixed(2), distance);
    await ui.locator("#pair-add").click();
    assert.equal(await ui.locator("#pair-table tbody tr").count(), 1);
    assert.equal((await summary()).condition_editors.restraints.length, 0, "pair editing is staged until Apply");
    let releaseApply;
    let applyReceived;
    const applying = new Promise((resolve) => { applyReceived = resolve; });
    const release = new Promise((resolve) => { releaseApply = resolve; });
    await page.route("**/distance-restraints/replace", async (route) => {
      const response = await route.fetch(); applyReceived(); await release;
      await route.fulfill({ response });
    });
    const applied = edit("#pair-apply", "/distance-restraints/replace");
    await applying;
    for (const id of ["pair-add", "pair-clear", "pair-reload", "pair-apply"]) {
      assert.equal(await ui.locator(`#${id}`).isDisabled(), true, `${id} is disabled while Apply is pending`);
    }
    releaseApply(); await applied;
    await page.unroute("**/distance-restraints/replace");
    assert.equal((await summary()).condition_editors.restraints.length, 1);
    await ui.locator("#pair-table tbody button").first().click();
    assert.match(await ui.locator("#selection-count").innerText(), /^2 atoms/);
    await ui.locator("#pair-delete").click();
    await edit("#pair-apply", "/distance-restraints/replace");
    assert.equal((await summary()).condition_editors.restraints.length, 0);
    await edit("#undo", "/undo");
    assert.equal(await ui.locator("#pair-table tbody tr").count(), 1);
    await ui.locator("#pair-table tbody button").first().click();
    await ui.locator("#pair-delete").click();
    await edit("#undo", "/undo");
    assert.match(await ui.locator("#pair-draft-status").innerText(), /structure changed/);
    assert.equal(await ui.locator("#pair-apply").isDisabled(), true);
    await ui.locator("#pair-reload").click();
    assert.equal(await ui.locator("#pair-apply").isDisabled(), false);
  }

  await ui.locator("#editor-tab-structure").click();
  const beforeProtonation = await summary();
  await ui.locator("#protonation-ph").fill("7.4");
  const protonated = await edit("#protonate", "/protonate");
  assert.ok(protonated.edit_result.hydrogen_count > 0);
  assert.equal(protonated.structure.revision, beforeProtonation.revision + 1);
  await edit("#undo", "/undo");
  assert.equal((await summary()).atom_count, beforeProtonation.atom_count);

  await ui.locator(".load-options > summary").click();
  await ui.locator("#parse-preset").selectOption("rcsb");
  assert.equal(await ui.locator("#parse-add_missing_atoms").isChecked(), true);
  await ui.locator("#parse-preset").selectOption("minimal");
  assert.equal(await ui.locator("#parse-add_missing_atoms").isChecked(), false);
  assert.equal(await ui.locator("#parse-load_standard_annotations").isChecked(), true);
  await ui.locator(".load-options > summary").click();
  assert.deepEqual(errors, []);
  if (process.env.ANNOTATION_SCREENSHOT_DIR) {
    await page.screenshot({ path: resolve(process.env.ANNOTATION_SCREENSHOT_DIR, `${backend}-qol.png`) });
  }
  console.log(`Editor QoL passed (${backend}): group actions, persistent colors, centroids/markers, supported condition editors, protonation/Undo, loading presets.`);
} catch (error) {
  console.error("Editor diagnostics:", await ui?.evaluate(() => ({
    status: document.querySelector("#status")?.textContent,
    viewer: { ...document.querySelector("#viewer")?.dataset },
  })).catch(() => null), errors);
  throw error;
} finally { await browser.close(); }
