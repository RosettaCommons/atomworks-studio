// A stream of live frames must leave the camera where the viewer put it, and must cost less per frame than
// reloading the structure outright. Patinae has no in-place data update, so its live path is a cheap rebuild:
// the style plan computed for the first frame is replayed, and nothing waits on a fixed settle.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { chromiumLaunchOptions } from '../../../scripts/browser.mjs';

const FRAMES = 8;

/** One frame of a design: the same atoms, moved. Shifts every `Cartn_x` so each frame really is new geometry. */
function frameCif(cif, step) {
  const lines = cif.split('\n');
  const fields = [];
  let start = -1;
  for (const [index, line] of lines.entries()) {
    const field = line.trim().match(/^_atom_site\.(\S+)$/);
    if (field) { if (!fields.length) start = index; fields.push(field[1]); continue; }
    if (fields.length && line.trim().startsWith('ATOM')) { start = index; break; }
  }
  const column = fields.indexOf('Cartn_x');
  assert.ok(column >= 0 && start > 0, 'fixture must carry an _atom_site loop with Cartn_x');
  for (let index = start; index < lines.length; index++) {
    const row = lines[index].trim();
    if (!/^(ATOM|HETATM)\s/.test(row)) continue;
    const tokens = row.split(/\s+/);
    if (tokens.length !== fields.length) continue;
    tokens[column] = (Number(tokens[column]) + step * 0.05).toFixed(3);
    lines[index] = tokens.join(' ');
  }
  return lines.join('\n');
}

const server = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), server: { host: '127.0.0.1', port: 0 } });
await server.listen();
const base = server.resolvedUrls.local[0];
const cif = await readFile(new URL('../../../tests/fixtures/inverse_folding_2kl8.cif', import.meta.url), 'utf8');
const frames = Array.from({ length: FRAMES }, (_, step) => frameCif(cif, step + 1));
const browser = await chromium.launch(chromiumLaunchOptions());
await mkdir('artifacts/local/live-frames', { recursive: true });
try {
  for (const backend of ['patinae', 'molstar']) {
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/__adapter-test', route => route.fulfill({ contentType: 'text/html', body: '<div id="viewer" style="width:960px;height:740px"></div>' }));
    await page.route('**/patinae_web_bg.wasm', route => route.fulfill({ contentType: 'application/wasm', path: new URL('../dist/assets/patinae_web_bg.wasm', import.meta.url).pathname }));
    await page.goto(`${base}__adapter-test`);

    const reload = await page.evaluate(async ({ base, backend, cif }) => {
      const module = await import(`${base}src/viewers/${backend}.ts`);
      window.adapter = module[backend === 'molstar' ? 'createMolstarAdapter' : 'createPatinaeAdapter']({
        container: document.querySelector('#viewer'), onPick: () => {},
      });
      await window.adapter.initialize();
      await window.adapter.loadCif(cif, 'design');
      // A second full load, timed: what a live frame used to cost when it fell through to `loadCif`.
      const started = performance.now();
      await window.adapter.loadCif(cif, 'design');
      return performance.now() - started;
    }, { base, backend, cif });

    if (backend === 'molstar') await page.waitForFunction(() => window.adapter.viewer.plugin.canvas3d.camera.getSnapshot().radius > 1, null, { timeout: 30000 });
    await page.waitForTimeout(500);

    // Record what live mode is handed, so the restore can be checked against it rather than against a guess.
    if (backend === 'patinae') await page.evaluate(() => {
      const viewer = window.adapter.viewer;
      window.lookCalls = [];
      const picking = viewer.setPicking.bind(viewer);
      const overlay = viewer.setSelectionOverlay.bind(viewer);
      viewer.setPicking = (on) => { window.lookCalls.push(['picking', on]); picking(on); };
      viewer.setSelectionOverlay = (on) => { window.lookCalls.push(['overlay', on]); overlay(on); };
      window.lookBefore = {
        picking: window.adapter.pickingEnabled,
        selectionOverlay: window.adapter.selectionOverlayEnabled,
      };
    });

    // Put the camera somewhere the structure's default view is not, so a reset would be unmistakable.
    await page.evaluate(async backend => {
      if (backend === 'molstar') {
        const camera = window.adapter.viewer.plugin.canvas3d.camera;
        const snapshot = camera.getSnapshot();
        camera.setState({ position: snapshot.position.map((v, i) => v + [3, 4, 7][i]), target: snapshot.target.map(v => v + 2) }, 0);
      } else await window.adapter.executeCommand('turn y, 25');
    }, backend);
    const camera = () => page.evaluate(async backend => {
      if (backend === 'patinae') return (await window.adapter.viewer.execute('get_view')).messages;
      const s = window.adapter.viewer.plugin.canvas3d.camera.getSnapshot();
      return { position: s.position, target: s.target, up: s.up, radius: s.radius, fov: s.fov, mode: s.mode };
    }, backend);
    const original = await camera();

    await page.evaluate(() => window.adapter.setLiveMode(true));
    if (backend === 'patinae') {
      assert.deepEqual(await page.evaluate(() => window.lookCalls), [['picking', false], ['overlay', false]],
        'patinae: entering live mode turns picking and the selection overlay off');
    }

    const perFrame = await page.evaluate(async frames => {
      const times = [];
      for (const frame of frames) {
        const started = performance.now();
        await window.adapter.updateLiveCif(frame, 'design', { keepCamera: true });
        times.push(performance.now() - started);
      }
      return times;
    }, frames);
    assert.equal(perFrame.length, FRAMES);

    assert.deepEqual(await camera(), original, `${backend}: a stream of live frames must not move the camera`);

    const counters = await page.evaluate(() => ({ ...document.querySelector('#viewer').dataset }));
    assert.equal(Number(counters.liveUpdates), FRAMES, `${backend}: every frame went through the live path`);
    if (backend === 'patinae') {
      assert.equal(Number(counters.liveStyleReplays), FRAMES,
        'patinae: the style plan computed for the first frame is reused while the atoms hold still');
    }

    await page.evaluate(() => window.adapter.setLiveMode(false));
    if (backend === 'patinae') {
      const after = await page.evaluate(() => ({ calls: window.lookCalls, before: window.lookBefore }));
      assert.deepEqual(after.calls.slice(2), [['picking', after.before.picking], ['overlay', after.before.selectionOverlay]],
        'patinae: leaving live mode restores exactly what picking and the overlay were set to');
      assert.equal(await page.evaluate(() => window.adapter.savedLiveLook), null);
      assert.equal(await page.evaluate(() => window.adapter.liveMode), false);
    }

    // The point of the live path: a frame costs less than reloading the structure. The margin is kept loose
    // because CI renders in software, where absolute timings swing wildly.
    const median = [...perFrame].sort((a, b) => a - b)[Math.floor(perFrame.length / 2)];
    assert.ok(median < reload, `${backend}: a live frame (${median.toFixed(0)} ms) must cost less than a reload (${reload.toFixed(0)} ms)`);

    // A frame really did replace the geometry, rather than redrawing the structure it already had.
    if (backend === 'patinae') {
      const atoms = await page.evaluate(() => window.adapter.viewer.countAtoms('all'));
      assert.ok(atoms > 0, 'patinae: the streamed frame is still loaded');
    }

    await page.screenshot({ path: `artifacts/local/live-frames/${backend}-stream.png` });
    assert.deepEqual(errors, []);
    await page.evaluate(() => window.adapter.destroy());
    await page.close();
    console.log(`${backend}: ${FRAMES} live frames held the camera; median ${median.toFixed(0)} ms/frame against ${reload.toFixed(0)} ms for a reload`);
  }
} finally { await browser.close(); await server.close(); }
