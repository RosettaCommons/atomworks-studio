// (Development aid, not a test.) The RFD4-Proteina page itself, served statically from its clone, for comparing its own
// card against Studio's Design card: `RFD4P_PAGE=/path/to/clone node tests/design-card-pagebed.mjs`.
import http from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { chromium } from 'playwright-core';
import { chromiumLaunchOptions } from '../../../scripts/browser.mjs';
import { CACHE } from './design-card-bed.mjs';

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.webp': 'image/webp', '.png': 'image/png', '.cif': 'text/plain', '.zst': 'application/zstd', '.webmanifest': 'application/manifest+json' };

export async function startPage(dir = process.env.RFD4P_PAGE, { viewport = { width: 1400, height: 1000 }, colorScheme = 'dark' } = {}) {
  const server = http.createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = join(dir, path);
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(readFileSync(file));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch(chromiumLaunchOptions());
  const context = await browser.newContext({ viewport, colorScheme });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route(/https:\/\/files\.rcsb\.org\/.*/, async (route) => {
    const url = route.request().url();
    const m = /\/ligands\/view\/(\w+)\.cif/.exec(url);
    const name = m ? `ccd_${m[1]}.cif` : `${/\/download\/(\w+)\.cif/.exec(url)?.[1]}.cif`;
    const path = join(CACHE, name);
    if (existsSync(path)) await route.fulfill({ status: 200, body: readFileSync(path), headers: { 'access-control-allow-origin': '*' } });
    else await route.continue();
  });
  const open = async () => {
    await page.goto(base);
    await page.waitForFunction(() => window.atomworksStudio && window.rfd4pApp?.designPanel, null, { timeout: 60000 });
  };
  return { page, base, open, errors, close: async () => { await browser.close(); server.close(); } };
}
