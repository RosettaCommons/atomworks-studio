import { chromium } from 'playwright-core';
import { chromiumLaunchOptions } from '../../../scripts/browser.mjs';
import { writeFileSync } from 'node:fs';
const OUT = process.env.OUT;
const browser = await chromium.launch(chromiumLaunchOptions());
async function open(kind, scheme) {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 }, colorScheme: scheme });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(kind === 'page' ? 'http://127.0.0.1:4173/' : 'http://127.0.0.1:8795/design/');
  const f = kind === 'page' ? page : page.frameLocator('iframe[title="AtomWorks Studio"]');
  const frame = kind === 'page' ? page.mainFrame() : (await (await page.waitForSelector('iframe[title="AtomWorks Studio"]')).contentFrame());
  await f.locator('.rfd4p-task-card').first().waitFor({ timeout: 90000 });
  return { ctx, page, f, frame, errors };
}
const results = {};
for (const scheme of ['dark', 'light']) {
  for (const kind of ['page', 'space']) {
    const s = await open(kind, scheme);
    // The card's own theme toggle sets the theme; ensure the scheme asked for.
    const label = await s.f.locator('#rfd4p-theme-btn').getAttribute('aria-label');
    const isDark = label === 'Light mode';
    if ((scheme === 'dark') !== isDark) { await s.f.locator('#rfd4p-theme-btn').click(); await s.page.waitForTimeout(600); }
    await s.page.screenshot({ path: `${OUT}/${kind}-${scheme}-start.png` });
    await s.f.locator('.rfd4p-task-card', { hasText: 'Protein binder' }).click();
    await s.f.locator('#rfd4p-run-settings:not([hidden])').waitFor({ timeout: 120000 });
    await s.f.locator('#predict:not([disabled])').waitFor({ timeout: 120000 }).catch(() => {});
    await s.page.waitForTimeout(3000);
    await s.page.screenshot({ path: `${OUT}/${kind}-${scheme}-binder.png` });
    // Structure of the card: normalised markup and the boxes of its controls.
    results[`${kind}-${scheme}`] = await s.frame.evaluate(() => {
      const card = document.querySelector('#rfd4p-studio-card, .rfd4p-card');
      const html = card.outerHTML.replace(/\s+/g, ' ');
      const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
      const boxes = [...card.querySelectorAll('button, input, select, summary, label, legend, h2, .rfd4p-task-card, .viewer-backend')].filter(vis).map((el) => {
        const r = el.getBoundingClientRect();
        return [el.id || el.className?.toString().slice(0, 30) || el.tagName, (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 40), Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
      });
      return { html, boxes, theme: document.documentElement.dataset.theme ?? null };
    });
    if (s.errors.length) console.log(kind, scheme, 'pageerrors', s.errors.slice(0, 3));
    await s.ctx.close();
  }
}
writeFileSync(`${OUT}/structure.json`, JSON.stringify(results));
await browser.close();
