import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { chromiumLaunchOptions } from '../../../scripts/browser.mjs';

const base = process.env.ANNOTATION_STUDIO_URL ?? 'http://127.0.0.1:8000/';
const mode = process.env.VIEWER_MODE ?? 'molstar';
const browser = await chromium.launch(chromiumLaunchOptions());
try {
  const page = await browser.newPage({ serviceWorkers: 'block' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const raw = await readFile(new URL('../../../tests/fixtures/minimal_multichain.cif', import.meta.url));
  const response = await page.request.post(`${base}api/v1/sessions`, { multipart: {
    file: { name: 'close-test.cif', mimeType: 'chemical/x-mmcif', buffer: raw }, parse_preset: 'minimal',
  } });
  assert.equal(response.status(), 200);
  const session = (await response.json()).session_id;
  const endpoint = `${base}api/v1/sessions/${session}`;
  await page.goto(`${base}?viewer=${mode}&session=${session}`);
  await page.waitForFunction(() => !document.querySelector('#close-structure').disabled);
  await page.locator('#close-structure').click();
  await page.locator('dialog button[value="cancel"]').click();
  assert.equal((await page.request.get(endpoint)).status(), 200);

  await page.route(endpoint, route => route.request().method() === 'DELETE'
    ? route.fulfill({ status: 503, contentType: 'application/json', body: '{"detail":"Test server unavailable"}' })
    : route.continue());
  await page.locator('#close-structure').click();
  await page.locator('dialog button[value="confirm"]').click();
  await page.getByText(/Could not close structure:.*The document is still open/).first().waitFor();
  assert.equal(await page.evaluate(() => sessionStorage.getItem('annotation-studio-session')), session);
  assert.ok(await page.locator('.sequence-token').count());
  assert.equal((await page.request.get(endpoint)).status(), 200);
  await page.unroute(endpoint);

  await page.locator('#close-structure').click();
  await Promise.all([
    page.waitForEvent('domcontentloaded'),
    page.locator('dialog button[value="confirm"]').click(),
  ]);
  await page.waitForFunction(() => document.querySelector('#status')?.textContent.includes('Ready.'));
  assert.equal((await page.request.get(endpoint)).status(), 404);
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#status')?.textContent.includes('Ready.'));
  assert.equal(await page.evaluate(() => sessionStorage.getItem('annotation-studio-session')), null);
  assert.equal(await page.locator('.sequence-token').count(), 0);
  assert.equal(await page.locator('#close-structure').isDisabled(), true);
  assert.deepEqual(errors, []);
  console.log(`${mode}: cancel preserves session; failed close stays open; successful close deletes session and stays empty after reload.`);
} finally { await browser.close(); }
