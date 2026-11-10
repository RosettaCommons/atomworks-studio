/**
 * The embedding API a host drives Studio through (`window.atomworksStudio`, documented in docs/INTEGRATIONS.md).
 *
 * A host page is written against this surface and keeps working across releases only if the surface is pinned. The
 * RFD4-Proteina page calls 14 of these members; four of them (`centerOn`, `closeDocument`, `setHighlight`, `setTheme`)
 * were missing from the 0.0.6 release, and because the page reaches them with optional chaining it did not fail: its
 * hotspot highlighting, Clear, light theme and recentring silently did nothing. Nothing in Studio's own suite noticed.
 *
 * This checks what each member does, not that it exists, through state the page itself can read: the selection, the
 * `data-*` attributes the Mol* adapter keeps for tests, and the elements the UI changes.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";
import { chromiumLaunchOptions } from "../../../scripts/browser.mjs";

const baseUrl = process.env.ANNOTATION_STUDIO_URL ?? "http://127.0.0.1:8000/";
const packageVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const MEMBERS = [
  "renderFrame", "setOverlay", "setHighlight", "setLiveMode", "showDocument", "closeDocument", "openSession",
  "openFile", "openExample", "applyEdit", "getSelection", "setSelection", "centerOn", "setTheme", "chainColor",
];

const browser = await chromium.launch(chromiumLaunchOptions());
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${baseUrl}?viewer=molstar`);
  await page.waitForFunction(() => document.querySelector("#status")?.textContent.includes("Ready."));

  // The surface: every documented member is a function, and `version` says which build this is.
  const surface = await page.evaluate((members) => {
    const api = window.atomworksStudio;
    return { version: api?.version, missing: members.filter((name) => typeof api?.[name] !== "function") };
  }, MEMBERS);
  assert.deepEqual(surface.missing, [], "documented members the page does not provide");
  assert.equal(surface.version, packageVersion, "the API reports the version it was built from");

  await page.evaluate(() => window.atomworksStudio.openExample("inverse_folding"));
  await page.waitForFunction(() => document.querySelector("#status")?.textContent.includes("Loaded Inverse folding"));
  await page.waitForFunction(() => Number(document.querySelector("#viewer").dataset.renderedAtoms) > 0);

  // How many atoms the sequence bar says a residue holds, to compare with what the viewer painted.
  const atomsOf = async (number) => (await page.locator(`.sequence-token[aria-label$=" ${number} in chain A_1"]`)
    .first().getAttribute("data-atoms")).split(",").length;
  const viewer = (name) => page.evaluate((key) => document.querySelector("#viewer").dataset[key], name);

  // --- Selection: replaces, sorts, drops what is not an atom index, and the host hears about it.
  const heard = await page.evaluate(() => {
    window.__heard = [];
    window.addEventListener("atomworks-studio", (event) => {
      if (event.detail?.type === "selection") window.__heard.push(event.detail);
    });
    return true;
  });
  assert.equal(heard, true);
  assert.deepEqual(await page.evaluate(() => window.atomworksStudio.getSelection()), [], "nothing is selected at first");
  await page.evaluate(() => window.atomworksStudio.setSelection([5, 1, 3, -4, 2.5]));
  assert.deepEqual(await page.evaluate(() => window.atomworksStudio.getSelection()), [1, 3, 5],
    "ascending, and negative or fractional indices are dropped");
  assert.match(await page.locator("#selection-count").textContent(), /^3 atoms selected/);
  assert.ok(await page.evaluate(() => window.__heard.length) >= 1, "the host hears a `selection` event");
  await page.evaluate(() => window.atomworksStudio.setSelection([0]));
  assert.deepEqual(await page.evaluate(() => window.atomworksStudio.getSelection()), [0], "setSelection replaces");
  await page.evaluate(() => window.atomworksStudio.setSelection([]));
  assert.deepEqual(await page.evaluate(() => window.atomworksStudio.getSelection()), []);

  // --- Highlights: painted on the residues named, by author chain and residue number.
  const first = await atomsOf(1);
  const second = await atomsOf(2);
  const third = await atomsOf(5);
  await page.evaluate(() => window.atomworksStudio.setHighlight("hot", [{ chain: "A", residue: 1 }, { chain: "A", residue: 2 }]));
  assert.equal(await viewer("highlight_hot"), String(first + second), "a highlight paints every atom of its residues");
  assert.equal(await viewer("highlightResidues"), "A1 A2");
  assert.equal(await viewer("highlightLayers"), "1");

  await page.evaluate(() => window.atomworksStudio.setHighlight("fade", [{ chain: "A", residue: 5 }], { transparency: 0.7 }));
  assert.equal(await viewer("highlight_fade"), String(third), "a transparency fades residues instead of colouring them");
  assert.equal(await viewer("highlightLayers"), "2", "a second key adds its own layer");
  assert.equal(await viewer("highlightResidues"), "A1 A2", "a faded residue is not one of the coloured ones");

  // Setting a key again replaces it; a chain that is not there is ignored rather than an error.
  await page.evaluate(() => window.atomworksStudio.setHighlight("hot", [{ chain: "A", residue: 1 }, { chain: "Z", residue: 99 }]));
  assert.equal(await viewer("highlight_hot"), String(first));
  assert.equal(await viewer("highlightResidues"), "A1");

  // An insertion code narrows a residue to that one: a hotspot on H82 must not paint H82A, H82B and H82C, and the
  // reverse -- naming a code the structure does not have -- paints nothing at all.
  await page.evaluate(() => window.atomworksStudio.setHighlight("hot", [{ chain: "A", residue: 1, insCode: "B" }]));
  assert.equal(await viewer("highlight_hot"), "0", "an insertion code that is not in the structure matches nothing");
  assert.equal(await viewer("highlightResidues"), "");

  await page.evaluate(() => window.atomworksStudio.setHighlight("hot", null));
  await page.evaluate(() => window.atomworksStudio.setHighlight("fade", null));
  assert.equal(await viewer("highlightLayers"), "0", "null removes a highlight, and the last one removes the layers");
  assert.equal(await viewer("highlight_hot"), undefined);

  // --- Look and feel.
  await page.evaluate(() => window.atomworksStudio.setTheme("light"));
  assert.equal(await page.evaluate(() => document.body.dataset.hostTheme), "light");
  await page.evaluate(() => window.atomworksStudio.setTheme("dark"));
  assert.equal(await page.evaluate(() => document.body.dataset.hostTheme), "dark");
  const colours = await page.evaluate(() => ["A", "B", "C"].map((chain) => window.atomworksStudio.chainColor(chain)));
  for (const colour of colours) assert.match(colour, /^#[0-9a-f]{6}$/, "a chain colour is a CSS colour");
  assert.equal(new Set(colours).size, 3, "neighbouring chains are told apart");
  assert.equal(await page.evaluate(() => window.atomworksStudio.chainColor("A")), colours[0], "and a chain keeps its colour");
  await page.evaluate(() => window.atomworksStudio.centerOn([0, 1]));
  await page.evaluate(() => window.atomworksStudio.centerOn([]));

  // --- Closing: the editor goes back to having nothing open, and a new document opens normally afterwards.
  await page.evaluate(() => window.atomworksStudio.setSelection([1, 2]));
  await page.evaluate(() => window.atomworksStudio.closeDocument());
  assert.equal(await page.locator("#document-name").textContent(), "No structure open");
  assert.equal(await page.locator("#empty-state").isVisible(), true, "the empty state is shown");
  assert.equal(await viewer("renderedAtoms"), "0", "nothing is drawn");
  assert.deepEqual(await page.evaluate(() => window.atomworksStudio.getSelection()), [], "the selection is cleared");
  assert.equal(await page.locator("#undo").isDisabled(), true);
  assert.equal(await page.locator(".sequence-token").count(), 0, "the sequence bar is emptied");

  await page.evaluate(() => window.atomworksStudio.openExample("protein_binder"));
  await page.waitForFunction(() => document.querySelector("#status")?.textContent.includes("Loaded Protein binder"));
  await page.waitForFunction(() => Number(document.querySelector("#viewer").dataset.renderedAtoms) > 0);
  assert.equal(await page.locator("#empty-state").isVisible(), false, "a document opened after closing is shown");

  assert.deepEqual(errors, [], "no page errors while driving the API");
  console.log(`molstar: ${MEMBERS.length} embedding API members, highlights, selection, theme and close behave as documented`);
} finally {
  await browser.close();
}
