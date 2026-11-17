import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { chromiumLaunchOptions } from "../../../scripts/browser.mjs";

/**
 * Picking in the viewer, as the selection design stands (Sergey's d7e72bb, 7505dee and b090595):
 *
 *  - residues are the default pick scope, and a click on the cartoon selects that residue;
 *  - a whole residue is outlined on the cartoon and its sticks are NOT drawn;
 *  - a partly selected residue (some of its atoms) also shows its sticks, to pick more atoms from;
 *  - clearing leaves nothing behind.
 *
 * This used to be a long script that found atoms to click by the colour of their sticks, which assumed a residue pick
 * draws sticks. That is no longer true, so what it clicked was never drawn. It compares screenshots against the
 * untouched view instead of classifying pixels by colour, so it does not depend on the renderer's palette or theme.
 */
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
  const canvas = page.locator("#viewer canvas").first();

  const shot = async name => {
    await page.mouse.move(10, 10);
    await page.waitForTimeout(900);
    return canvas.screenshot({ path: resolve(output, `${name}.png`) });
  };
  // How many pixels differ between two screenshots, and where the green cartoon is (to find something to click).
  const compare = (a, b) => page.evaluate(async ([first, second]) => {
    const load = async data => {
      const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob());
      const surface = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = surface.getContext("2d");
      context.drawImage(bitmap, 0, 0);
      return { width: bitmap.width, height: bitmap.height, rgba: context.getImageData(0, 0, bitmap.width, bitmap.height).data };
    };
    const [left, right] = [await load(first), await load(second)];
    let changed = 0;
    const cartoon = [];
    for (let y = 0; y < left.height; y += 1) {
      for (let x = 0; x < left.width; x += 1) {
        const i = (y * left.width + x) * 4;
        const delta = Math.abs(left.rgba[i] - right.rgba[i]) + Math.abs(left.rgba[i + 1] - right.rgba[i + 1])
          + Math.abs(left.rgba[i + 2] - right.rgba[i + 2]);
        if (delta > 40) changed += 1;
        if (y > 80 && y < left.height - 100 && x > 100 && x < left.width - 100 && y % 3 === 0 && x % 3 === 0) {
          const [r, g, b] = [left.rgba[i], left.rgba[i + 1], left.rgba[i + 2]];
          if (g > 80 && g > r * 1.8 && b > 30) cartoon.push({ x, y });
        }
      }
    }
    return { changed, cartoon };
  }, [a.toString("base64"), b.toString("base64")]);
  const selectionCount = async () => parseInt(await page.locator("#selection-count").textContent());

  assert.equal(await page.locator("#pick-scope").inputValue(), "residue", "residues are the default pick scope");
  const untouched = await shot("0-untouched");
  const { cartoon } = await compare(untouched, untouched);
  assert.ok(cartoon.length > 20, "found the cartoon to click");
  const point = cartoon[Math.floor(cartoon.length / 2)];

  // A click on the cartoon selects the whole residue, outlined, with no sticks.
  await canvas.click({ position: point });
  await page.waitForFunction(() => parseInt(document.querySelector("#selection-count").textContent) > 1);
  const pressed = page.locator('.sequence-token[aria-pressed="true"]');
  assert.equal(await pressed.count(), 1, "exactly one residue is selected");
  const residueAtoms = (await pressed.getAttribute("data-atoms")).split(",").map(Number);
  assert.equal(await selectionCount(), residueAtoms.length, "all of its atoms are selected");
  const wholeResidue = await shot("1-whole-residue");
  const outline = (await compare(untouched, wholeResidue)).changed;
  assert.ok(outline > 100, `the picked residue is outlined on the cartoon (${outline} pixels changed)`);

  // Clicking it again removes it (the help says "Click again to remove"); the view is exactly as it was.
  await canvas.click({ position: point });
  await page.waitForFunction(() => parseInt(document.querySelector("#selection-count").textContent) === 0);
  const afterToggle = (await compare(untouched, await shot("2-toggled-off"))).changed;
  assert.ok(afterToggle < 30, `a second click leaves nothing behind (${afterToggle} pixels changed)`);

  // Some atoms of a residue, not all of them: the outline and, as well, that residue's sticks to pick more from.
  await page.evaluate(atom => window.atomworksStudio.setSelection([atom]), residueAtoms[0]);
  await page.waitForFunction(() => parseInt(document.querySelector("#selection-count").textContent) === 1);
  const partial = (await compare(untouched, await shot("3-one-atom"))).changed;
  assert.ok(partial > outline + 100,
    `an atom selection also shows its residue's sticks (${partial} pixels changed, a whole residue changes ${outline})`);

  // All of its atoms again: back to the outline alone, so the sticks go when the residue becomes whole.
  await page.evaluate(atoms => window.atomworksStudio.setSelection(atoms), residueAtoms);
  await page.waitForFunction(count => parseInt(document.querySelector("#selection-count").textContent) === count, residueAtoms.length);
  const whole = (await compare(untouched, await shot("4-whole-again"))).changed;
  assert.ok(whole < partial - 100, `a whole residue draws no sticks (${whole} pixels changed, against ${partial} partly selected)`);

  // Clear leaves nothing behind: no outline, no sticks.
  await page.locator("#clear-selection").click();
  await page.waitForFunction(() => parseInt(document.querySelector("#selection-count").textContent) === 0);
  const cleared = (await compare(untouched, await shot("5-cleared"))).changed;
  assert.ok(cleared < 30, `clearing the selection restores the view (${cleared} pixels changed)`);

  assert.deepEqual(errors, []);
  console.log("molstar: residue picking, the outline, sticks for partial residues, toggling and clearing behave as designed");
} finally {
  await browser.close();
}
