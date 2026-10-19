import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { chromiumLaunchOptions } from '../../../scripts/browser.mjs';

const base = process.env.ANNOTATION_STUDIO_URL ?? 'http://127.0.0.1:8001/';
const fixture = fileURLToPath(new URL('../../../tests/fixtures/minimal_multichain.cif', import.meta.url));
const browser = await chromium.launch(chromiumLaunchOptions());
try {
  for (const mode of ['molstar', 'patinae']) {
    const page = await browser.newPage({ serviceWorkers: 'block' });
    await page.goto(`${base}?viewer=${mode}`);
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Ready.'));
    await page.locator('.load-options > summary').click();
    await page.locator('#parse-preset').selectOption('minimal');
    await page.locator('.load-options > summary').click();
    await page.locator('#file-input').setInputFiles(fixture);
    await page.waitForFunction(() => !document.querySelector('#download').disabled && !document.querySelector('#viewer-mode').disabled);
    const session = await page.evaluate(() => sessionStorage.getItem('annotation-studio-session'));
    const endpoint = `${base}api/v1/sessions/${session}`;
    for (const fail of [false, true]) {
      if (fail) await page.route(`${endpoint}/combine`, route => route.fulfill({ status: 422, json: { detail: 'Test combine failure' } }));
      const created = page.waitForResponse(r => r.url().endsWith('/sessions') && r.request().method() === 'POST');
      const deleted = page.waitForResponse(r => r.request().method() === 'DELETE');
      await page.locator('#combine-input').setInputFiles(fixture);
      const temporary = (await (await created).json()).session_id;
      assert.equal((await deleted).status(), 204);
      assert.equal((await page.request.get(`${base}api/sessions/${temporary}`)).status(), 404);
      const current = await page.request.get(endpoint);
      assert.equal(current.status(), 200);
      assert.equal((await current.json()).structure.atom_count, 8);
      assert.equal(await page.evaluate(() => sessionStorage.getItem('annotation-studio-session')), session);
      if (fail) await page.unroute(`${endpoint}/combine`);
    }
    await page.close();
    console.log(`${mode}: successful and failed Combine remove their temporary sessions and preserve the target`);
  }
} finally { await browser.close(); }
