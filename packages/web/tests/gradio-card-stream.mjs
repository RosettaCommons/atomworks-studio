// A streaming model in the Gradio host's design card (scripts/preview_generation.py --card --stream): the live frames
// reach the viewer one by one and in order, the button says the step, the designs come with their trajectory (Show
// trajectory plays it), Save all (.zip) holds it, and Stop ends the stream.
// Needs a running host: GRADIO_URL (default http://127.0.0.1:8793/design/), started with
//   uv run python scripts/preview_generation.py --card --stream --port 8793 [--steps 12 --frame-delay 0.15]
// STEPS (default 12) must match --steps. With --frame-delay 0 the frames come as fast as the queue carries them (set
// SKIP_STOP=1 then: the run is over before Stop can be pressed).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { chromiumLaunchOptions } from '../../../scripts/browser.mjs';

const url = process.env.GRADIO_URL ?? 'http://127.0.0.1:8793/design/';
const STEPS = Number(process.env.STEPS ?? 12);
const browser = await chromium.launch(chromiumLaunchOptions());
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  page.setDefaultTimeout(90000);
  const errors = [];
  const warnings = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (m) => { if (/missed \d+ bus message/.test(m.text())) warnings.push(m.text()); });
  await page.addInitScript(() => { localStorage.setItem('annotation-studio-viewer-v2', 'molstar'); });
  await page.goto(url);
  const frame = page.frameLocator('iframe[title="AtomWorks Studio"]');
  await frame.locator('.rfd4p-task-card[data-example="unconditional"]').click({ timeout: 120000 });
  await frame.locator('#rfd4p-design:not([hidden])').waitFor({ timeout: 120000 });
  await page.waitForFunction(() => !document.querySelector('iframe[title="AtomWorks Studio"]').contentDocument.body.classList.contains('rfd4p-building'));
  await frame.locator('#samples-input').fill('2');

  // Record, inside the frame, every label the button gets and every frame the viewer draws.
  const handle = await page.locator('iframe[title="AtomWorks Studio"]').elementHandle();
  const inner = await handle.contentFrame();
  await inner.evaluate(() => {
    const seen = { labels: [], live: [] };
    window.__seen = seen;
    new MutationObserver(() => {
      const t = document.querySelector('#predict').textContent.trim();
      if (seen.labels.at(-1) !== t) seen.labels.push(t);
    }).observe(document.querySelector('#predict'), { childList: true, characterData: true, subtree: true });
    new MutationObserver(() => {
      const v = document.querySelector('#viewer').dataset;
      seen.live.push(Number(v.liveUpdates ?? 0));
    }).observe(document.querySelector('#viewer'), { attributes: true, attributeFilter: ['data-live-updates'] });
  });
  const before = Number(await inner.evaluate(() => document.querySelector('#viewer').dataset.liveUpdates ?? 0));

  await inner.locator('#predict').click();
  await inner.locator('#predict', { hasText: /^Stop/ }).waitFor();
  await inner.locator('#rfd4p-tabs button', { hasText: 'Outputs' }).waitFor({ state: 'attached' });
  await inner.waitForFunction(() => document.querySelectorAll('.refold-dtable tbody tr').length >= 2, null, { timeout: 120000 });
  await inner.waitForFunction(() => document.querySelector('#predict').textContent.trim() === 'Generate design');

  const seen = await inner.evaluate(() => window.__seen);
  const steps = seen.labels.filter((l) => /step \d+\/\d+/.test(l)).map((l) => Number(/step (\d+)\//.exec(l)[1]));
  assert.deepEqual(steps, Array.from({ length: STEPS }, (_, k) => k + 1), `the button names every step, in order: ${seen.labels.join(' | ')}`);
  assert.ok(seen.labels.some((l) => l.includes(`design 1 of 2 · step 1/${STEPS}`)), seen.labels.join(' | '));
  const live = Number(await inner.evaluate(() => document.querySelector('#viewer').dataset.liveUpdates ?? 0)) - before;
  assert.ok(live >= STEPS, `every frame was drawn in the viewer (${live} of ${STEPS})`);
  assert.deepEqual(warnings, [], 'no bus message was missed');

  // Two designs, each with its trajectory; Show trajectory plays the first one's.
  assert.equal(await inner.locator('.refold-dtable tbody tr').count(), 2);
  await inner.locator('#trajectory-toggle').waitFor({ state: 'visible' });
  await inner.locator('#trajectory-toggle').click();
  await inner.waitForFunction((n) => Number(document.querySelector('#trajectory-frame')?.max) === n - 1, STEPS);
  await inner.locator('#trajectory-toggle').click();

  // The zip holds both trajectories.
  const [download] = await Promise.all([page.waitForEvent('download'), inner.locator('#download-all-btn').click()]);
  const bytes = readFileSync(await download.path());
  const names = [];
  const eocd = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let at = bytes.readUInt32LE(eocd + 16);
  for (let i = 0, n = bytes.readUInt16LE(eocd + 10); i < n; i += 1) {
    const nameLen = bytes.readUInt16LE(at + 28);
    names.push(bytes.subarray(at + 46, at + 46 + nameLen).toString('utf8').split('/').slice(1).join('/'));
    at += 46 + nameLen + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
  }
  assert.equal(names.filter((n) => /-trajectory\.cif$/.test(n)).length, 2, names.join(', '));

  if (!process.env.SKIP_STOP) {
  // Stop in the middle of a run: the button returns, nothing more arrives, and the next run is not affected.
  await inner.locator('#rfd4p-tabs button', { hasText: 'Input' }).click();
  await inner.locator('#predict').click();
  await inner.locator('#predict', { hasText: /step [2-9]\// }).waitFor();
  await inner.locator('#predict').click();
  await inner.waitForFunction(() => document.querySelector('#predict').textContent.trim() === 'Generate design');
  const drawn = Number(await inner.evaluate(() => document.querySelector('#viewer').dataset.liveUpdates ?? 0));
  await page.waitForTimeout(2500);
  assert.equal(Number(await inner.evaluate(() => document.querySelector('#viewer').dataset.liveUpdates ?? 0)), drawn, 'no frame after Stop');
  await inner.locator('#predict').click();
  await inner.locator('#predict', { hasText: /^Stop/ }).waitFor();
  await inner.waitForFunction(() => document.querySelector('#predict').textContent.trim() === 'Generate design', null, { timeout: 120000 });
  assert.ok(await inner.evaluate(() => document.querySelectorAll('.refold-dtable tbody tr').length) >= 4, 'the run after Stop made its designs');

  }
  assert.deepEqual(errors, []);
  console.log(`ok: ${STEPS} steps, ${live} frames drawn, trajectories in the zip, Stop`);
} finally {
  await browser.close();
}
