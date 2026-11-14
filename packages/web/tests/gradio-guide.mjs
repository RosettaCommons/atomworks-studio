// The Guide button of the design card inside the Gradio host (scripts/preview_generation.py --card): the guide pages are
// served by the host itself at /help/, the card (in the editor frame) fetches the page and shows it as a popup over the
// designer, with its pictures, closes on the × and on Escape, and the parent page opens no new tab. A card of a host
// without a guide has no button (the same preview with --no-guide).
// Needs two running hosts: GRADIO_URL (default http://127.0.0.1:8795/design/) with the guide and GRADIO_NO_GUIDE_URL
// (default http://127.0.0.1:8796/design/) without.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { chromiumLaunchOptions } from '../../../scripts/browser.mjs';

const url = process.env.GRADIO_URL ?? 'http://127.0.0.1:8795/design/';
const plainUrl = process.env.GRADIO_NO_GUIDE_URL ?? 'http://127.0.0.1:8796/design/';
const browser = await chromium.launch(chromiumLaunchOptions());
const open = async (address) => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(60000);
  page.errors = [];
  page.on('pageerror', (error) => page.errors.push(error.message));
  page.popups = 0;
  page.context().on('page', () => { page.popups += 1; });
  await page.addInitScript(() => localStorage.setItem('annotation-studio-viewer-v2', 'molstar'));
  await page.goto(address);
  const frame = page.frameLocator('iframe[title="AtomWorks Studio"]');
  await frame.locator('#webgpu-badge').waitFor({ state: 'attached', timeout: 120000 });
  return { page, frame };
};
try {
  {
    const { page, frame } = await open(url);
    const origin = new URL(url).origin;
    // The host serves the guide itself.
    const served = await page.request.get(`${origin}/help/index.html`);
    assert.equal(served.status(), 200);
    assert.equal((await page.request.get(`${origin}/help/`)).status(), 200);
    assert.equal((await page.request.get(`${origin}/help/img/sample.svg`)).headers()['content-type'].startsWith('image/svg'), true);
    const requests = [];
    page.on('request', (request) => requests.push(request.url()));

    assert.equal(await frame.locator('#rfd4p-guide-btn').isVisible(), true, 'the Guide button, since the host has a guide');
    await frame.locator('#rfd4p-guide-btn').click();
    const dialog = frame.locator('dialog.rfd4p-guide');
    await dialog.waitFor({ state: 'visible' });
    assert.equal(await dialog.locator('h1').textContent(), 'Sample guide');
    assert.match(await dialog.locator('.lead').textContent(), /small guide/);
    assert.equal(await dialog.locator('a', { hasText: 'Back to the designer' }).count(), 0);
    // The picture is the host's, loaded.
    await frame.locator('dialog.rfd4p-guide img').evaluate((img) => img.decode());
    assert.equal(await frame.locator('dialog.rfd4p-guide img').evaluate((img) => img.naturalWidth), 200);
    assert.equal(await dialog.locator('img').getAttribute('src'), `${origin}/help/img/sample.svg`);
    assert.equal(await dialog.locator('a', { hasText: 'full documentation' }).getAttribute('target'), '_blank');
    // It is a popup over the designer, inside the card's frame: the dialog is modal and covers the editor.
    const box = await dialog.boundingBox();
    assert.ok(box.width > 400 && box.height > 200, `popup size ${box.width}x${box.height}`);
    await page.screenshot({ path: process.env.GUIDE_SCREENSHOT ?? 'guide-gradio.png' });
    // × closes, Escape closes, the page behind got no new tab and fetched no other site.
    await dialog.locator('.rfd4p-guide-x').click();
    assert.equal(await dialog.isVisible(), false, 'the × closes it');
    await frame.locator('#rfd4p-guide-btn').click();
    await dialog.waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    assert.equal(await dialog.isVisible(), false, 'Escape closes it');
    await page.waitForTimeout(300);
    assert.equal(page.popups, 0, 'no new tab');
    const foreign = requests.filter((u) => /^https?:/.test(u) && new URL(u).origin !== origin && !/^https?:\/\/(files\.rcsb\.org|fonts\.)/.test(u));
    assert.deepEqual(foreign, [], 'the guide is read from the host alone');
    assert.deepEqual(page.errors, []);
    await page.close();
  }
  {
    const { page, frame } = await open(plainUrl);
    assert.equal(await frame.locator('#rfd4p-guide-btn').count(), 1);
    assert.equal(await frame.locator('#rfd4p-guide-btn').isHidden(), true, 'a host without a guide has no Guide button');
    const origin = new URL(plainUrl).origin;
    assert.notEqual((await page.request.get(`${origin}/help/index.html`)).status(), 200, 'and serves none');
    assert.deepEqual(page.errors, []);
    await page.close();
  }
  console.log('gradio host: the Guide popup opens in the editor frame from the host\'s own /help/, closes on × and Escape; none without a guide');
} finally {
  await browser.close();
}
