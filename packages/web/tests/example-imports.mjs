import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { chromiumLaunchOptions } from '../../../scripts/browser.mjs';
const base = process.env.ANNOTATION_STUDIO_URL ?? 'http://127.0.0.1:8000/';
const mode = process.env.VIEWER_MODE ?? 'molstar';
const browser = await chromium.launch(chromiumLaunchOptions());
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, serviceWorkers: 'block' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}?viewer=${mode}`);
  await page.waitForFunction(() => document.querySelector('#status')?.textContent.includes('Ready.'));
  const examples = await (await page.request.get(`${base}api/v1/examples`)).json();
  await mkdir('artifacts/local/example-imports', {recursive: true});
  for (const example of examples) {
    console.log(`${mode}: opening ${example.id}`);
    await page.locator('#editor-tab-main').click();
    if (await page.locator('#examples-panel').getAttribute('open') === null) {
      await page.locator('#examples-panel > summary').click();
    }
    await page.locator(`[data-example="${example.id}"]`).click();
    try {
      await page.waitForFunction(label => document.querySelector('#status-message')?.textContent.includes(`Loaded ${label}`), example.label);
    } catch (error) {
      console.error({example: example.id, status: await page.locator('#status').innerText(), errors});
      await page.screenshot({path: `artifacts/local/example-imports/${mode}-failure.png`});
      throw error;
    }
    assert.equal(await page.locator('dialog[open]').count(), 0);
    const unpositioned = example.id === 'unconditional';
    assert.equal(await page.locator('#unpositioned-state').isVisible(), unpositioned, `${example.id}: explain an empty viewport`);
    if (unpositioned) {
      assert.match(await page.locator('#unpositioned-state').innerText(), /No 3D coordinates to display/);
      assert.equal(await page.locator('[data-representation]:enabled, [data-color]:enabled').count(), 0);
      assert.equal(await page.locator('#download').isEnabled(), true);
      await page.screenshot({path: `artifacts/local/example-imports/${mode}-${example.id}-unpositioned.png`});
    }
    if (example.id === 'small_molecule_binder') {
      assert.equal(await page.locator('[data-representation="sticks"]').isEnabled(), true);
      if (mode === 'molstar') assert.equal(await page.locator('#viewer').getAttribute('data-rendered-atoms'), '27');
      assert.equal(await page.locator('#viewer canvas').first().isVisible(), true);
      await page.screenshot({path: `artifacts/local/example-imports/${mode}-sam-conformer.png`});
    }
    if (example.id === 'enzyme_design') {
      assert.match(await page.locator('#structure-summary').innerText(), /107/);
      assert.match(await page.locator('#coordinate-summary').innerText(), /2 atoms/);
      await page.screenshot({path: `artifacts/local/example-imports/${mode}-enzyme.png`});
    }
    if (example.id === 'protein_binder') {
      await page.locator('#editor-tab-annotations').click();
      const annotations = await page.locator('#annotation-list').innerText();
      assert.doesNotMatch(annotations, /raw CIF|Structure values|B-factor|confidence/);
      const keys = await page.locator('#annotation-list [data-view-key]').evaluateAll(rows => rows.map(row => row.dataset.viewKey));
      assert.ok(keys.length > 0 && keys.every(key => key.startsWith('annotations/')));
      await page.locator('.sequence-token[data-atoms]').first().click();
      await page.waitForFunction(() => document.querySelector('#annotation-detail').textContent.includes('(atom '));
      assert.doesNotMatch(await page.locator('#annotation-detail').innerText(), /B-factor|condition_|annotation_|mask_/);
      const reset = page.waitForResponse(response => response.url().endsWith('/conditions/reset'));
      await page.locator('#reset-conditions').click();
      const result = await (await reset).json();
      assert.deepEqual(result.structure.annotations, []);
      assert.ok(result.structure.stored_fields.length > 0, 'stored default fields remain intact');
      assert.ok(result.structure.scalar_fields.some(field => field.name === 'b_factor'), 'B-factors remain intact');
      await page.waitForFunction(() => document.querySelector('#annotation-list').textContent.includes('No non-default conditions'));
      assert.equal(await page.locator('#annotation-list button, #annotation-list details').count(), 0);
      await page.locator('.sequence-token[data-atoms]').first().click();
      await page.waitForFunction(() => document.querySelector('#annotation-detail').textContent.includes('No active conditions on this atom.'));
      assert.doesNotMatch(await page.locator('#annotation-detail').innerText(), /B-factor|condition_|annotation_|mask_/);
      await page.screenshot({path: `artifacts/local/example-imports/${mode}-conditions-only.png`});
    }
  }
  await page.locator('#editor-tab-main').click();
  await page.locator('#examples-panel > summary').click();
  await page.locator('[data-example="inverse_folding"]').click();
  await page.waitForFunction(() => document.querySelector('#status-message')?.textContent.includes('Loaded Inverse folding'));
  assert.equal(await page.locator('#unpositioned-state').isVisible(), false);
  assert.equal(await page.locator('[data-representation="sticks"]').isEnabled(), true);
  assert.deepEqual(errors, []);
  console.log(`${mode}: all ${examples.length} examples load with Infer and no popup; the editor shows only conditions.`);
} finally { await browser.close(); }
