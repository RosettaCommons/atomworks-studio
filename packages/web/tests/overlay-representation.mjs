// What the viewer actually draws, for the two paths a host drives: an overlay it asks to be a cartoon, and the
// live frames of a run. Both are host-facing (`window.atomworksStudio`), neither had any coverage, and both have
// failed silently in ways a screenshot would not catch — an overlay drawn as sticks is legible but wrong, and a
// run drawn as sticks looks like a rendering choice rather than a bug.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { chromiumLaunchOptions } from '../../../scripts/browser.mjs';

const server = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), server: { host: '127.0.0.1', port: 0 } });
await server.listen();
const base = server.resolvedUrls.local[0];
// A design document whose designed residues have no coordinates yet: "auto" judges it broken up and picks atomic
// detail. This is the document state a run actually starts from, and the reason the live path needs its own preset.
const document = await readFile(new URL('../../api/annotation_studio/examples/small_molecule_binder.cif', import.meta.url), 'utf8');
// A fully positioned structure, standing in for a frame the model produced.
const frame = await readFile(new URL('../../../tests/fixtures/inverse_folding_2kl8.cif', import.meta.url), 'utf8');

const browser = await chromium.launch(chromiumLaunchOptions());
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/__adapter-test', route => route.fulfill({ contentType: 'text/html', body: '<div id="viewer" style="width:860px;height:640px"></div>' }));
  await page.goto(`${base}__adapter-test`);
  await page.evaluate(async ({ base, cif }) => {
    const module = await import(`${base}src/viewers/molstar.ts`);
    window.adapter = module.createMolstarAdapter({ container: document.querySelector('#viewer'), onPick: () => {} });
    await window.adapter.initialize();
    await window.adapter.loadCif(cif, 'document');
  }, { base, cif: document });

  // Components and their representation types, keyed by component label, across every structure in the scene.
  const drawn = () => page.evaluate(() => Object.fromEntries(
    window.adapter.viewer.plugin.managers.structure.hierarchy.current.structures.flatMap(structure =>
      structure.components.map(component => [
        component.cell.obj?.label,
        component.representations.map(representation => representation.cell.transform.params?.type?.name).sort(),
      ]))));

  assert.deepEqual(await drawn(), { All: ['ball-and-stick'] },
    'the document itself is left to the "auto" preset, which is what this example looks like to it');

  // --- Live frames of a run -------------------------------------------------------------------------------
  // The regression this guards: frames used to update the document's structure in place and so inherited its
  // representations, which left an entire run drawn as sticks. A frame gets its own structure instead.
  await page.evaluate(cif => window.adapter.updateLiveCif(cif, 'frame-1'), frame);
  assert.deepEqual(await drawn(), { Polymer: ['cartoon'] },
    'the first frame of a run is drawn as cartoon, not inherited from the document');
  await page.evaluate(cif => window.adapter.updateLiveCif(cif, 'frame-2'), frame);
  assert.deepEqual(await drawn(), { Polymer: ['cartoon'] },
    'later frames update in place and keep the cartoon');

  // --- Overlays -------------------------------------------------------------------------------------------
  // `representation: "cartoon"` is what a host uses to put a whole refolded structure over the design; without it
  // a full structure in ball-and-stick is unreadable.
  await page.evaluate(cif => window.adapter.setOverlayCif('refold', cif, { label: 'Refold', representation: 'cartoon', color: 0xe040fb, alpha: 0.75 }), frame);
  assert.deepEqual((await drawn())['Refold'], ['cartoon'], 'an overlay honours the representation the host asked for');
  assert.ok(Number(await page.evaluate(() => document.querySelector('#viewer').dataset.overlay_refold)) > 0,
    'the overlay actually drew atoms');

  // The default is unchanged, and `sizeAspectRatio` still applies to it.
  await page.evaluate(cif => window.adapter.setOverlayCif('ligands', cif, { label: 'Refold ligands', color: 0xe040fb, sizeAspectRatio: 0.6 }), frame);
  assert.deepEqual((await drawn())['Refold ligands'], ['ball-and-stick'], 'ball-and-stick stays the default');

  // Removing one leaves the other, and the frame, alone.
  await page.evaluate(() => window.adapter.setOverlayCif('refold', null));
  const remaining = await drawn();
  assert.equal(remaining['Refold'], undefined, 'null removes that overlay');
  assert.deepEqual(remaining['Refold ligands'], ['ball-and-stick'], 'and leaves the others');
  assert.deepEqual(remaining['Polymer'], ['cartoon'], 'and leaves the run alone');
  assert.equal(await page.evaluate(() => document.querySelector('#viewer').dataset.overlay_refold), undefined);

  assert.deepEqual(errors, []);
  await page.evaluate(() => window.adapter.destroy());
  await page.close();
  console.log('molstar: live frames draw as cartoon, and overlays honour the requested representation');

  // --- Patinae --------------------------------------------------------------------------------------------
  // Patinae implements no overlay path at all — here or upstream — and `ViewerAdapter.setOverlayCif` is optional,
  // so `setOverlay` silently draws nothing on the WebGPU backend. Asserted rather than assumed: when someone
  // implements it, this line fails and says to cover it above instead of leaving the gap untested.
  const patinae = await browser.newPage({ viewport: { width: 900, height: 700 } });
  await patinae.route('**/__adapter-test', route => route.fulfill({ contentType: 'text/html', body: '<div id="viewer" style="width:860px;height:640px"></div>' }));
  await patinae.route('**/patinae_web_bg.wasm', route => route.fulfill({ contentType: 'application/wasm', path: new URL('../dist/assets/patinae_web_bg.wasm', import.meta.url).pathname }));
  await patinae.goto(`${base}__adapter-test`);
  assert.equal(await patinae.evaluate(async base => {
    const module = await import(`${base}src/viewers/patinae.ts`);
    const adapter = module.createPatinaeAdapter({ container: document.querySelector('#viewer'), onPick: () => {} });
    return typeof adapter.setOverlayCif;
  }, base), 'undefined', 'Patinae still has no overlay path: a host overlay draws nothing on WebGPU');
  await patinae.close();
  console.log('patinae: no overlay path (known gap, asserted so it cannot change unnoticed)');
} finally { await browser.close(); await server.close(); }
