import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { chromiumLaunchOptions } from '../../../scripts/browser.mjs';
const base = process.env.ANNOTATION_STUDIO_URL ?? 'http://127.0.0.1:8001/';
const browser = await chromium.launch(chromiumLaunchOptions());
await mkdir('artifacts/local/group-colors', { recursive: true });
try {
  for (const mode of ['molstar', 'patinae']) {
    const page = await browser.newPage({ serviceWorkers: 'block' });
    const created = await page.request.post(`${base}api/v1/sessions`, { multipart: {
      file: { name: 'groups.cif', mimeType: 'chemical/x-mmcif', buffer: await readFile(new URL('../../../tests/fixtures/SAM_hbonds.cif', import.meta.url)) }, parse_preset: 'minimal',
    } });
    assert.equal(created.status(), 200);
    const session = (await created.json()).session_id;
    const endpoint = `${base}api/v1/sessions/${session}`;
    for (let i = 0; i < 7; i++) {
      const response = await page.request.post(endpoint + '/conditions', { data: { condition: 'coordinate_group', atom_indices: [i], enabled: true, value: i + 1 } });
      assert.equal(response.status(), 200, await response.text());
    }
    await page.goto(`${base}?viewer=${mode}&session=${session}`);
    await page.waitForFunction(() => !document.querySelector('#viewer-mode').disabled && !document.querySelector('#download').disabled);
    await page.locator('#editor-tab-annotations').click();
    const row = page.locator('[data-view-key="annotations/coordinate_group"]');
    await row.click();
    await page.waitForFunction(() => document.querySelector('[data-view-key="annotations/coordinate_group"]').getAttribute('aria-pressed') === 'true');
    assert.equal(await page.locator('#annotation-value').count(), 0);
    const legend = await page.locator('#annotation-detail').innerText();
    const colors = [...legend.matchAll(/\(([^)]+)\)/g)].map(m => m[1]);
    assert.equal(colors.length, 7);
    assert.equal(new Set(colors).size, 7);
    const response = await page.request.post(endpoint + '/conditions', { data: { condition: 'coordinate_group', atom_indices: [7], enabled: true, value: 8 } });
    assert.equal(response.status(), 200);
    const original = (await response.json()).structure;
    await page.reload();
    await page.waitForFunction(() => !document.querySelector('#viewer-mode').disabled && !document.querySelector('#download').disabled);
    await page.locator('#editor-tab-annotations').click();
    await row.click();
    await page.locator('#annotation-value').waitFor();
    assert.equal(await page.locator('#annotation-value option').count(), 8);
    await page.locator('#annotation-value').selectOption('Group 8');
    await page.waitForFunction(() => document.querySelector('#annotation-detail').textContent.endsWith('Group 8: 1 atom (magenta)'));
    await page.waitForFunction(() => !document.querySelector('#viewer-mode').disabled);
    assert.deepEqual((await (await page.request.get(endpoint)).json()).structure, original);
    await page.screenshot({ path: `artifacts/local/group-colors/${mode}.png` });
    await row.click();
    await page.waitForFunction(() => document.querySelector('[data-view-key="annotations/coordinate_group"]').getAttribute('aria-pressed') === 'false');
    assert.equal(await page.locator('#annotation-value').count(), 0);
    await page.close();
    console.log(`${mode}: seven distinct colors; eight groups use single-group inspection; toggling restores the view without edits`);
  }
} finally { await browser.close(); }
