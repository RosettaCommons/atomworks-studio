import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { chromiumLaunchOptions } from "../../../scripts/browser.mjs";

const baseUrl = process.env.ANNOTATION_STUDIO_URL ?? "http://127.0.0.1:8000/";
const output = resolve("artifacts/local/picking");
mkdirSync(output, { recursive: true });
const browser = await chromium.launch(chromiumLaunchOptions());
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${baseUrl}?viewer=molstar`);
  await page.waitForFunction(() => document.querySelector("#status")?.textContent.includes("Ready."));
  await page.locator('[data-example="inverse_folding"]').click();
  await page.waitForFunction(() => document.querySelector("#status")?.textContent.includes("Loaded Inverse folding"));
  await page.waitForFunction(() => !document.querySelector("#viewer-mode").disabled);
  assert.equal(await page.locator("#pick-scope").inputValue(), "atom");
  await page.locator("#pick-scope").selectOption("residue");
  const canvas = page.locator("#viewer canvas").first();

  async function image(name) {
    await page.mouse.move(10, 10);
    await page.waitForTimeout(800);
    const png = await canvas.screenshot({ path: resolve(output, `${name}.png`) });
    return page.evaluate(async data => {
      const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob());
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext("2d");
      context.drawImage(bitmap, 0, 0);
      const rgba = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
      const cartoon = [], atoms = [];
      for (let y = 80; y < bitmap.height - 100; y += 3) {
        for (let x = 100; x < bitmap.width - 100; x += 3) {
          const i = (y * bitmap.width + x) * 4;
          const [r, g, b] = rgba.slice(i, i + 3);
          if (g > 80 && g > r * 1.8 && b > 30) cartoon.push({ x, y });
          if (r > 100 && r > g * 1.8 && r > b * 1.8) atoms.push({ x, y });
        }
      }
      return { cartoon, atoms };
    }, png.toString("base64"));
  }

  function atomCenters(points) {
    const clusters = [];
    for (const point of points) {
      const cluster = clusters.find(points => Math.hypot(point.x - points[0].x, point.y - points[0].y) < 18);
      if (cluster) cluster.push(point);
      else clusters.push([point]);
    }
    return clusters.filter(points => points.length >= 3).map(points => ({
      x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
      y: points.reduce((sum, p) => sum + p.y, 0) / points.length,
    }));
  }

  async function pickAtom(point) {
    const inspected = page.waitForResponse(r => /\/atoms\/\d+\/annotations$/.test(r.url()));
    await canvas.click({ position: point });
    return Number((await inspected).url().match(/\/atoms\/(\d+)\/annotations$/)[1]);
  }

  const initial = await image("cartoon");
  assert.ok(initial.cartoon.length > 20);
  const residuePoint = initial.cartoon[Math.floor(initial.cartoon.length / 2)];
  await canvas.click({ position: residuePoint });
  await page.waitForFunction(() => parseInt(document.querySelector("#selection-count").textContent) > 1);
  const fullResidue = page.locator('.sequence-token[aria-pressed="true"]');
  assert.equal(await fullResidue.count(), 1);
  const fullAtoms = (await fullResidue.getAttribute("data-atoms")).split(",").map(Number);
  const focused = await image("residue-and-local-sticks");
  assert.ok(focused.atoms.length > initial.atoms.length + 10);
  await page.locator("#pick-scope").selectOption("atom");
  const centers = atomCenters(focused.atoms);
  let firstPoint;
  for (const point of centers) {
    const atom = await pickAtom(point);
    const count = parseInt(await page.locator("#selection-count").textContent());
    assert.equal(count, fullAtoms.length + (fullAtoms.includes(atom) ? -1 : 1));
    if (!fullAtoms.includes(atom)) {
      firstPoint = point;
      assert.equal(await page.locator(`.sequence-token[data-atoms="${fullAtoms.join(",")}"]`).getAttribute("aria-pressed"), "true",
        "picking another residue's atom preserves the entire first residue");
      break;
    }
    await pickAtom(point);
  }
  assert.ok(firstPoint, "tested a full cartoon residue followed by an atom in another residue");
  await page.screenshot({ path: resolve(output, "whole-residue-plus-atom.png") });

  await page.locator("#clear-selection").click();
  await page.locator("#pick-scope").selectOption("atom");
  await pickAtom(firstPoint);
  await page.waitForFunction(() => document.querySelector("#selection-count").textContent.startsWith("1 atom selected"));
  const firstAtoms = await page.locator('.sequence-token[aria-pressed="mixed"]').getAttribute("data-atoms");
  const atomSelected = await image("individual-atom");
  let secondPoint;
  for (const point of atomCenters(atomSelected.atoms)) {
    if (Math.hypot(point.x - firstPoint.x, point.y - firstPoint.y) < 25) continue;
    await pickAtom(point);
    const count = parseInt(await page.locator("#selection-count").textContent());
    if (count === 2 && await page.locator('.sequence-token[aria-pressed="mixed"]').count() === 2) {
      secondPoint = point;
      break;
    }
    if (count === 2) await pickAtom(point);
    else if (count === 0) await pickAtom(firstPoint);
    else assert.fail(`unexpected selection size ${count}`);
  }
  assert.ok(secondPoint, "plain atom clicks accumulate across residues");
  await page.screenshot({ path: resolve(output, "two-individual-atoms.png") });
  await pickAtom(firstPoint);
  assert.match(await page.locator("#selection-count").textContent(), /^1 atom selected/);
  await pickAtom(firstPoint);
  assert.match(await page.locator("#selection-count").textContent(), /^2 atoms selected/);

  await page.locator(`.sequence-token[data-atoms="${firstAtoms}"]`).click();
  assert.equal(parseInt(await page.locator("#selection-count").textContent()), firstAtoms.split(",").length + 1);
  await pickAtom(firstPoint);
  assert.equal(parseInt(await page.locator("#selection-count").textContent()), firstAtoms.split(",").length);
  assert.equal(await page.locator('.sequence-token[aria-pressed="mixed"]').count(), 2,
    "removing an atom within the whole residue preserves the atom in the other residue");

  await page.locator("#clear-selection").click();
  const cleared = await image("local-sticks-after-clear");
  assert.ok(cleared.atoms.length > initial.atoms.length + 10);
  const reset = page.waitForResponse(r => r.url().endsWith("/conditions/reset"));
  await page.locator("#reset-conditions").click();
  assert.equal((await reset).status(), 200);
  await page.waitForFunction(() => !document.querySelector("#viewer-mode").disabled);
  const normal = await image("default-view-after-reset");
  assert.ok(normal.atoms.length <= initial.atoms.length + 10);
  const normalResidue = normal.cartoon[Math.floor(normal.cartoon.length / 2)];
  await canvas.click({ position: normalResidue });
  const revealed = await image("atom-mode-focus-only");
  assert.match(await page.locator("#selection-count").innerText(), /^0 atoms/,
    "Atoms mode cartoon clicks reveal sticks without selecting any atoms");
  assert.ok(revealed.atoms.length > normal.atoms.length + 10);

  // Delay a real scope resolution, then clear before it returns.
  await page.locator("#reset-conditions").click();
  await page.waitForFunction(() => !document.querySelector("#viewer-mode").disabled);
  await page.locator("#pick-scope").selectOption("residue");
  const pendingImage = await image("before-delayed-pick");
  let reached, release;
  const requested = new Promise(resolve => { reached = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  await page.route("**/selections/resolve", async route => { reached(); await held; await route.continue(); });
  await canvas.click({ position: pendingImage.cartoon[Math.floor(pendingImage.cartoon.length / 2)] });
  await requested;
  await page.locator("#clear-selection").click();
  const response = page.waitForResponse(r => r.url().endsWith("/selections/resolve"));
  release();
  await response;
  await page.waitForTimeout(200);
  assert.match(await page.locator("#selection-count").innerText(), /^0 atoms/);
  await page.unroute("**/selections/resolve");
  assert.deepEqual(errors, []);
  console.log("Mol*: mixed residue/atom targets, cross-residue accumulation, partial deselection, focus-only atom mode, reset, and late-response cancellation passed");

} finally {
  await browser.close();
}
