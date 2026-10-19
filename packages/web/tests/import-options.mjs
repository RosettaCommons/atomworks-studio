import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { chromiumLaunchOptions } from '../../../scripts/browser.mjs';

const base = process.env.ANNOTATION_STUDIO_URL ?? 'http://127.0.0.1:8000/';
const mode = process.env.VIEWER_MODE ?? 'molstar';
const browser = await chromium.launch(chromiumLaunchOptions());
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}?viewer=${mode}`);
  await page.waitForFunction(() => document.querySelector('#status')?.textContent.includes('Ready.'));
  const raw = await readFile(fileURLToPath(new URL('../../../tests/fixtures/minimal_multichain.cif', import.meta.url)));
  const seed = await (await page.request.post(`${base}api/v1/sessions`, { multipart: {
    file: { name: 'partial.cif', mimeType: 'chemical/x-mmcif', buffer: raw }, parse_preset: 'minimal',
  } })).json();
  const changed = await page.request.post(`${base}api/v1/sessions/${seed.session_id}/conditions`, {
    data: { condition: 'hotspot', atom_indices: [0], enabled: true },
  });
  assert.equal(changed.status(), 200, await changed.text());
  const annotated = Buffer.from(await (await page.request.get(`${base}api/v1/sessions/${seed.session_id}/cif`)).text());
  const upload = buffer => page.locator('#file-input').setInputFiles({ name: 'test.cif', mimeType: 'chemical/x-mmcif', buffer });
  const ready = () => page.waitForFunction(() => !document.querySelector('#download').disabled && !document.querySelector('#workspace').inert);
  const summary = async () => {
    const session = await page.evaluate(() => sessionStorage.getItem('annotation-studio-session'));
    return (await (await page.request.get(`${base}api/v1/sessions/${session}`)).json()).structure;
  };
  async function importAndWait(buffer, choose) {
    const response = page.waitForResponse(r => r.url().endsWith('/sessions') && r.request().method() === 'POST');
    await upload(buffer);
    if (choose) {
      await page.locator('dialog #parse-preset').selectOption(choose);
      await page.locator('dialog button[value="import"]').click();
    }
    const result = await response;
    assert.equal(result.status(), 200, await result.text());
    await ready();
    return (await result.json()).structure;
  }

  // No annotations: automatic preparation fills missing atom records.
  const prepared = await importAndWait(raw);
  assert.ok(prepared.atom_count > 4);
  const previousSession = await page.evaluate(() => sessionStorage.getItem('annotation-studio-session'));
  let importRequests = 0;
  page.on('request', r => { if (r.url().endsWith('/sessions') && r.method() === 'POST') importRequests++; });
  await upload(annotated);
  await page.locator('dialog').waitFor();
  assert.match(await page.locator('dialog').innerText(), /saved StandardAnnotations and \d+ missing heavy atoms/);
  assert.equal(await page.locator('dialog button[value="import"]').isDisabled(), true);
  await mkdir('artifacts/local/import-options', { recursive: true });
  await page.screenshot({ path: `artifacts/local/import-options/${mode}-choice.png` });
  await page.locator('dialog button[value="cancel"]').click();
  assert.equal(importRequests, 0);
  assert.equal(await page.evaluate(() => sessionStorage.getItem('annotation-studio-session')), previousSession);

  const preserved = await importAndWait(annotated, 'minimal');
  assert.equal(preserved.atom_count, 4);
  assert.equal(preserved.condition_counts.hotspot, 1);
  const rebuilt = await importAndWait(annotated, 'rcsb');
  assert.ok(rebuilt.atom_count > 4);
  assert.equal(rebuilt.condition_counts.hotspot ?? 0, 0);

  // Manual settings reject incompatible combinations without submitting a document.
  await upload(annotated);
  await page.locator('dialog #parse-preset').selectOption('manual');
  await page.locator('#parse-add_missing_atoms').check();
  const beforeInvalid = importRequests;
  await page.locator('dialog button[value="import"]').click();
  assert.match(await page.locator('dialog [role="alert"]').innerText(), /cannot be combined/);
  assert.equal(importRequests, beforeInvalid);
  await page.locator('#parse-add_missing_atoms').uncheck();
  const manualResponse = page.waitForResponse(r => r.url().endsWith('/sessions') && r.request().method() === 'POST');
  await page.locator('dialog button[value="import"]').click();
  assert.equal((await manualResponse).status(), 200);
  await ready();
  assert.equal((await summary()).condition_counts.hotspot, 1);

  // Annotated complete inputs (including NaN placeholders) infer preservation.
  const completeSeed = await (await page.request.post(`${base}api/v1/sessions`, { multipart: {
    file: { name: 'complete.cif', mimeType: 'chemical/x-mmcif', buffer: raw }, parse_preset: 'rcsb',
  } })).json();
  await page.request.post(`${base}api/v1/sessions/${completeSeed.session_id}/conditions`, { data: { condition: 'hotspot', atom_indices: [0] } });
  const complete = Buffer.from(await (await page.request.get(`${base}api/v1/sessions/${completeSeed.session_id}/cif`)).text());
  const kept = await importAndWait(complete);
  assert.equal(kept.condition_counts.hotspot, 1);
  assert.equal(kept.atom_count, completeSeed.structure.atom_count);

  // Failed commands are prominent and stay visible through subsequent success.
  await page.locator('#selection-syntax').selectOption('expression');
  await page.locator('#viewer-command').fill('(');
  await page.locator('#run-viewer-command').click();
  await page.locator('#error-banner').waitFor();
  assert.match(await page.locator('#error-message').innerText(), /Command failed/);
  assert.equal(await page.locator('#error-banner').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(67, 28, 32)');
  await page.locator('#viewer-command').fill("chain_id == 'A'");
  await page.locator('#run-viewer-command').click();
  await page.waitForFunction(() => document.querySelector('#status-message').textContent.includes('query applied'));
  assert.equal(await page.locator('#error-banner').isVisible(), true);
  await page.screenshot({ path: `artifacts/local/import-options/${mode}-error.png` });
  await page.locator('#dismiss-error').click();
  assert.equal(await page.locator('#error-banner').isVisible(), false);
  assert.deepEqual(errors, []);
  console.log(`${mode}: automatic presets, conflict/cancel, both choices, manual validation, annotation preservation, and persistent red errors passed`);
} finally { await browser.close(); }
