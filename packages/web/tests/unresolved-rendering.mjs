import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { chromiumLaunchOptions } from '../../../scripts/browser.mjs';
const base = process.env.ANNOTATION_STUDIO_URL ?? 'http://127.0.0.1:8000/';
const browser = await chromium.launch(chromiumLaunchOptions());
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, serviceWorkers: 'block' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}?viewer=molstar`);
  await page.waitForFunction(() => document.querySelector('#status')?.textContent.includes('Ready.'));
  const raw = await readFile(fileURLToPath(new URL('../../../tests/fixtures/minimal_multichain.cif', import.meta.url)));
  const seed = await (await page.request.post(`${base}api/v1/sessions`, { multipart: {
    file: { name: 'old-dummy.cif', mimeType: 'chemical/x-mmcif', buffer: raw }, parse_preset: 'minimal',
  } })).json();
  await page.request.post(`${base}api/v1/sessions/${seed.session_id}/conditions`, { data: { condition: 'hotspot', atom_indices: [0] } });
  const annotated = Buffer.from(await (await page.request.get(`${base}api/v1/sessions/${seed.session_id}/cif`)).text());
  await page.locator('#file-input').setInputFiles({ name: 'old-dummy.cif', mimeType: 'chemical/x-mmcif', buffer: annotated });
  await page.locator('dialog #parse-preset').selectOption('rcsb');
  await page.locator('dialog button[value="import"]').click();
  await page.waitForFunction(() => !document.querySelector('#download').disabled && !document.querySelector('#workspace').inert);
  assert.equal(await page.locator('#viewer').getAttribute('data-rendered-atoms'), '4');
  assert.equal(await page.locator('#viewer').getAttribute('data-rendered-structures'), '1');
  assert.match(await page.locator('#coordinate-summary').innerText(), /19 atoms have no coordinates/);
  const closedSession = await page.evaluate(() => sessionStorage.getItem('annotation-studio-session'));
  await page.locator('#close-structure').click();
  await Promise.all([
    page.waitForEvent('domcontentloaded'),
    page.locator('dialog button[value="confirm"]').click(),
  ]);
  await page.waitForFunction(() => document.querySelector('#status')?.textContent.includes('Ready.'));
  assert.equal(await page.evaluate(() => sessionStorage.getItem('annotation-studio-session')), null);
  assert.equal(await page.locator('.sequence-token').count(), 0);
  assert.equal(await page.locator('#viewer').getAttribute('data-rendered-structures'), '0');
  assert.equal(await page.locator('#viewer').getAttribute('data-rendered-atoms'), '0');
  assert.equal(await page.locator('#close-structure').isDisabled(), true);
  assert.equal((await page.request.get(`${base}api/v1/sessions/${closedSession}`)).status(), 404);
  assert.equal((await page.request.get(`${base}api/v1/sessions/${closedSession}/cif`)).status(), 404);

  await page.locator('[data-example="inverse_folding"]').click();
  await page.waitForFunction(() => !document.querySelector('#download').disabled && !document.querySelector('#workspace').inert);
  assert.equal(await page.locator('#viewer').getAttribute('data-rendered-structures'), '1');
  assert.equal(await page.locator('#viewer').getAttribute('data-rendered-atoms'), '481');
  assert.match(await page.locator('#coordinate-summary').innerText(), /508 atoms have no coordinates/);
  const sequence = await page.locator('.sequence-token').evaluateAll(tokens => tokens.flatMap(t => t.dataset.atoms.split(',').map(Number)));
  assert.equal(new Set(sequence).size, 989, 'all document atoms are accounted for by the sequence');
  const session = await page.evaluate(() => sessionStorage.getItem('annotation-studio-session'));
  const structure = (await (await page.request.get(`${base}api/v1/sessions/${session}`)).json()).structure;
  assert.equal(structure.atom_count, 989);
  assert.deepEqual(structure.chain_ids, ['A_1']);
  assert.equal(structure.condition_counts.hotspot ?? 0, 0);

  await mkdir('artifacts/local/unresolved-rendering', { recursive: true });
  await page.mouse.move(10, 10);
  const canvas = page.locator('#viewer canvas').first();
  const png = await canvas.screenshot({ path: 'artifacts/local/unresolved-rendering/after-close-and-load.png' });
  const points = await page.evaluate(async data => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob());
    const output = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = output.getContext('2d'); context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    const points = [];
    for (let y = 80; y < bitmap.height - 80; y += 3) for (let x = 100; x < bitmap.width - 100; x += 3) {
      const i = (y * bitmap.width + x) * 4;
      const [r, g, b] = pixels.slice(i, i + 3);
      if (g > 80 && g > r * 1.8 && b > 30) points.push({x, y});
    }
    return points;
  }, png.toString('base64'));
  assert.ok(points.length > 100, 'the protein is visible immediately, before picking');
  await canvas.click({position: points[Math.floor(points.length / 2)]});
  await page.waitForFunction(() => parseInt(document.querySelector('#selection-count').textContent) > 1);
  assert.equal(await page.locator('.sequence-token[aria-pressed="true"]').count(), 1);
  assert.equal(await page.locator('#viewer').getAttribute('data-rendered-atoms'), '481');
  await page.screenshot({path: 'artifacts/local/unresolved-rendering/focused-residue.png'});
  await page.locator('#style-menu > summary').click();
  await page.locator('[data-representation="sticks"]').click();
  await page.waitForFunction(() => !document.querySelector('#viewer-mode').disabled);
  assert.equal(await page.locator('#viewer').getAttribute('data-rendered-atoms'), '481');
  assert.deepEqual(errors, []);
  console.log('Mol*: close/reopen has one fresh structure; unresolved atoms never enter render root; initial camera, sequence coverage, picking and Show sticks remain consistent.');
} finally { await browser.close(); }
