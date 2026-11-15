// Designs one at a time through the Gradio host's card (scripts/preview_generation.py --card --stream --sequential
// --steps 8 --frame-delay 0.2): each design joins Outputs the moment it is done, the button reads "design k of n ·
// step i/8" and the bar runs across all designs, the live designed sequence shows while it runs and is gone after.
//   uv run python scripts/preview_generation.py --card --stream --sequential --steps 8 --frame-delay 0.2 --port 8794
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { chromiumLaunchOptions } from '../../../scripts/browser.mjs';

const url = process.env.GRADIO_URL ?? 'http://127.0.0.1:8794/design/';
const STEPS = Number(process.env.STEPS ?? 8);
const browser = await chromium.launch(chromiumLaunchOptions());
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  page.setDefaultTimeout(90000);
  await page.addInitScript(() => { localStorage.setItem('annotation-studio-viewer-v2', 'molstar'); });
  await page.goto(url);
  const frame = page.frameLocator('iframe[title="AtomWorks Studio"]');
  await frame.locator('.rfd4p-task-card[data-example="unconditional"]').click({ timeout: 120000 });
  await frame.locator('#rfd4p-design:not([hidden])').waitFor({ timeout: 120000 });
  await page.waitForFunction(() => !document.querySelector('iframe[title="AtomWorks Studio"]').contentDocument.body.classList.contains('rfd4p-building'));
  await frame.locator('#samples-input').fill('2');
  const handle = await page.locator('iframe[title="AtomWorks Studio"]').elementHandle();
  const inner = await handle.contentFrame();
  await inner.evaluate(() => {
    const seen = { labels: [], rowsAtDesign2: null, strip: 0, stripResidues: 0 };
    window.__seen = seen;
    new MutationObserver(() => {
      const t = document.querySelector('#predict').textContent.trim();
      if (seen.labels.at(-1) !== t) {
        seen.labels.push(t);
        if (/design 2 of 2 · step 1\//.test(t)) seen.rowsAtDesign2 = document.querySelectorAll('.refold-dtable tbody tr').length;
      }
      const strip = document.getElementById('rfd4p-live-sequence');
      if (strip) { seen.strip += 1; seen.stripResidues = Math.max(seen.stripResidues, strip.querySelectorAll('.sequence-token').length); }
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  await inner.locator('#predict').click();
  await inner.waitForFunction(() => document.querySelectorAll('.refold-dtable tbody tr').length >= 2, null, { timeout: 120000 });
  await inner.waitForFunction(() => document.querySelector('#predict').textContent.trim() === 'Generate design');
  const seen = await inner.evaluate(() => window.__seen);
  for (const design of [1, 2]) {
    const steps = seen.labels.filter((l) => l.includes(`design ${design} of 2 · step`)).map((l) => Number(/step (\d+)\//.exec(l)[1]));
    assert.deepEqual(steps, Array.from({ length: STEPS }, (_, k) => k + 1), `design ${design}: ${seen.labels.join(' | ')}`);
  }
  assert.equal(seen.rowsAtDesign2, 1, 'the first design was listed before the second one started');
  assert.ok(seen.strip > 0 && seen.stripResidues > 10, `the live sequence was shown (${seen.stripResidues} residues)`);
  assert.equal(await inner.evaluate(() => document.getElementById('rfd4p-live-sequence')), null, 'and removed after the run');
  console.log('ok: two designs one after the other, each in Outputs when done, live sequence shown and removed');
} finally {
  await browser.close();
}
