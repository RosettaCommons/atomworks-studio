import { chromium } from 'playwright-core';
import { chromiumLaunchOptions } from '../../../scripts/browser.mjs';
const browser = await chromium.launch(chromiumLaunchOptions());
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
await page.goto('http://127.0.0.1:8795/design/');
await page.waitForSelector('iframe[title="AtomWorks Studio"]');
console.log(await page.evaluate(() => { const out = []; let el = document.querySelector('iframe[title="AtomWorks Studio"]'); while (el && el !== document.documentElement) { const cs = getComputedStyle(el); const r = el.getBoundingClientRect(); out.push(`${el.tagName}.${(el.className||'').toString().slice(0,50)}#${el.id} x=${Math.round(r.x)} y=${Math.round(r.y)} w=${Math.round(r.width)} pad=${cs.padding} mar=${cs.margin} maxw=${cs.maxWidth} gap=${cs.gap}`); el = el.parentElement; } return out.join('\n'); }));
await browser.close();
