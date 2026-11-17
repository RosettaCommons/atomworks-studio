// The Refold panel inside the Gradio host (scripts/preview_generation.py --refold): the panel appears with the
// designs a run produced, Refold all goes through Gradio's queue to the deployment's refold callback, the numbers
// land in the table, and the refold is drawn over the design in the editor's frame, again after another design opens.
// Needs a running host: GRADIO_URL (default http://127.0.0.1:8792/design/).
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { chromiumLaunchOptions } from '../../../scripts/browser.mjs';

const url = process.env.GRADIO_URL ?? 'http://127.0.0.1:8792/design/';
const browser = await chromium.launch(chromiumLaunchOptions());
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1500 } });
  page.setDefaultTimeout(60000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('annotation-studio-viewer-v2', 'molstar'));
  await page.goto(url);
  const frame = () => page.frameLocator('iframe[title="AtomWorks Studio"]');
  // The editor opens on the provider's example; it has announced its session once it is ready.
  await page.waitForFunction(() => document.querySelector('iframe[title="AtomWorks Studio"]')?.dataset.sessionId, null, { timeout: 120000 });

  // Before there is a design the panel is there but has nothing to show.
  await page.locator('#refold-panel .refold-panel').waitFor({ state: 'attached' });
  assert.equal(await page.locator('#refold-box').isVisible(), false);

  await page.getByRole('spinbutton', { name: 'Designs' }).fill('2');
  await page.getByRole('button', { name: 'Generate design', exact: true }).click();
  await page.locator('#generation-status').filter({ hasText: 'Generated from input revision' }).waitFor({ timeout: 120000 });
  await page.locator('.refold-dtable tbody tr').first().waitFor();
  assert.deepEqual(await page.locator('.refold-dtable tbody .refold-dt-name').allTextContents(), ['Design 1', 'Design 2']);
  assert.equal(await page.locator('.refold-dtable th.refold-dt-name').textContent(), 'Design');
  // The defaults the reference page has.
  assert.equal(await page.locator('#refold-model').inputValue(), 'af3');
  assert.deepEqual(await page.locator('#refold-model option').allTextContents(), ['AlphaFold 3', 'OpenBind-0']);
  assert.equal(await page.locator('#refold-recycles').inputValue(), '3');
  assert.equal(await page.locator('#refold-steps').inputValue(), '25');
  assert.equal(await page.locator('#refold-seed').inputValue(), '0');

  // AlphaFold 3 asks for its terms; "Use OpenBind-0" is the way past without them.
  await page.locator('#refold-btn').click();
  const dialog = page.locator('#refold-terms');
  await dialog.waitFor({ state: 'visible' });
  assert.equal(await dialog.locator('h2').textContent(), 'AlphaFold 3 model parameters');
  await dialog.getByRole('button', { name: 'Use OpenBind-0' }).click();
  await page.locator('#refold-btn').filter({ hasText: /^Stop/ }).waitFor();
  assert.equal(await page.locator('#refold-model').inputValue(), 'openbind0');
  assert.deepEqual(await page.locator('.refold-dt-state').allTextContents(), ['refolding…', 'queued']);
  await page.locator('#refold-btn').filter({ hasText: /^Refold all$/ }).waitFor();
  for (const row of [1, 2]) {
    assert.deepEqual(await page.locator(`.refold-dtable tbody tr:nth-child(${row}) .refold-dt-num`).allTextContents(), ['0.8', '87'],
      'seed 0, three recycles: the simulated deployment\'s numbers');
  }

  // The refold is drawn in the editor, over the design.
  const drawn = () => frame().locator('#viewer').evaluate((el) => el.dataset.overlay_refold);
  await page.waitForFunction(() => Number(document.querySelector('iframe[title="AtomWorks Studio"]')
    .contentDocument.querySelector('#viewer').dataset.overlay_refold) > 0, null, { timeout: 30000 });
  assert.ok(Number(await drawn()) > 0);

  // The design refolded last is the one shown, in its own frame of the editor, with its refold over it.
  assert.equal(await page.getByRole('radio', { name: 'Design 2', exact: true }).first().isChecked(), true, 'the View selector follows the panel');
  assert.equal(await page.locator('.refold-dtable tbody tr:nth-child(2) input').isChecked(), true);
  // Choosing the other design opens it in a new frame, and the refold is drawn over that one too.
  const sessionBefore = await page.locator('iframe[title="AtomWorks Studio"]').getAttribute('data-session-id');
  await page.locator('.refold-dtable tbody tr[data-design] .refold-dt-name').nth(0).click();
  await page.waitForFunction((before) => {
    const frame = document.querySelector('iframe[title="AtomWorks Studio"]');
    return frame?.dataset.sessionId && frame.dataset.sessionId !== before
      && Number(frame.contentDocument?.querySelector('#viewer')?.dataset.overlay_refold) > 0;
  }, sessionBefore, { timeout: 60000 });
  assert.equal(await page.getByRole('radio', { name: 'Design 1', exact: true }).first().isChecked(), true);
  assert.equal(await page.locator('.refold-dtable tbody tr:nth-child(1) input').isChecked(), true);
  await page.screenshot({ path: process.env.REFOLD_SCREENSHOT ?? 'refold-gradio.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log('gradio host: refold panel lists designs, folds through the queue, draws the refold in the editor');
} finally {
  await browser.close();
}
