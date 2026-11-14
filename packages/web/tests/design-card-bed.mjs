// The bed the Design card's browser tests run on: Studio's page in card mode (`?card=1`) with a REST backend behind it.
//
//   ANNOTATION_STUDIO_URL=http://127.0.0.1:8000/   Studio's Python server (serving the built bundle), as the other tests.
//   RFD4P_PAGE=/path/to/rfd4-proteina-webgpu-refold   otherwise: vite serves Studio, and the page's in-browser engine
//                                                    (web/studio-api.js) answers /api/v1 in the browser, the same
//                                                    contract. It has every endpoint the card uses.
//
// RCSB entries and ligand dictionary files are served from tests/.cache/rcsb (fetched once from files.rcsb.org when
// missing), so the examples build the same way without a network once cached.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import { chromiumLaunchOptions } from '../../../scripts/browser.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const CACHE = process.env.DESIGN_CARD_FIXTURES ?? join(here, '.cache', 'rcsb');

async function rcsbFixture(url) {
  const name = /\/ligands\/view\/(\w+)\.cif/.exec(url) ? `ccd_${/\/ligands\/view\/(\w+)\.cif/.exec(url)[1]}.cif` : `${/\/download\/(\w+)\.cif/.exec(url)?.[1]}.cif`;
  const path = join(CACHE, name);
  if (existsSync(path)) return readFileSync(path);
  const res = await fetch(url);
  if (!res.ok) return null;
  const body = Buffer.from(await res.arrayBuffer());
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(path, body);
  return body;
}

export async function startBed({ viewport = { width: 1400, height: 1000 }, colorScheme = 'dark' } = {}) {
  const external = process.env.ANNOTATION_STUDIO_URL;
  const pageDir = process.env.RFD4P_PAGE;
  let server = null;
  let base = external;
  if (!external) {
    if (!pageDir) throw new Error('set ANNOTATION_STUDIO_URL (Studio\'s server) or RFD4P_PAGE (the RFD4-Proteina page clone, whose in-browser engine answers the API)');
    const engine = `/@fs${join(pageDir, 'web/studio-api.js')}`;
    server = await createServer({
      root: fileURLToPath(new URL('../', import.meta.url)),
      server: { host: '127.0.0.1', port: 0, fs: { strict: false } },
      plugins: [{
        // The page's engine does not read `keep_unresolved` from POST /sessions yet (its own examples pass it as an
        // option): read it from the form, as the Python server does.
        name: 'design-card-test-engine-keep-unresolved',
        transform(code, id) {
          if (!id.endsWith('web/studio-api.js') || code.includes("get('keep_unresolved')")) return null;
          return code.replace("assembly: String(form?.get('assembly') ?? parsedOptions.assembly ?? '1'),", "assembly: String(form?.get('assembly') ?? parsedOptions.assembly ?? '1'), keepUnresolved: form?.get('keep_unresolved') === 'true',");
        },
      }, {
        name: 'design-card-test-engine',
        transformIndexHtml: { order: 'pre', handler: (html) => html.replace('<script type="module" src="/src/main.ts">', `<script type="module" src="${engine}"></script>\n    <script type="module" src="/src/main.ts">`) },
      }],
    });
    await server.listen();
    base = server.resolvedUrls.local[0];
  }
  const browser = await chromium.launch(chromiumLaunchOptions());
  const context = await browser.newContext({ viewport, colorScheme });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const rcsb = { requests: [] };
  await page.route(/https:\/\/files\.rcsb\.org\/.*/, async (route) => {
    const url = route.request().url();
    rcsb.requests.push(url);
    const body = await rcsbFixture(url).catch(() => null);
    if (!body) { await route.fulfill({ status: 404, body: 'not found' }); return; }
    await route.fulfill({ status: 200, body, headers: { 'access-control-allow-origin': '*', 'content-type': 'chemical/x-mmcif' } });
  });
  const open = async (query = 'card=1&viewer=molstar') => {
    await page.goto(`${base}?${query}`);
    await page.waitForFunction(() => document.querySelector('#status')?.textContent.includes('Ready.') && window.atomworksStudio);
  };
  const close = async () => {
    await browser.close();
    await server?.close();
  };
  return { page, base, open, close, errors, rcsb, engine: external ? 'server' : 'page' };
}

/** A provider whose designs the test controls: each generate() records its request and waits for `release()`. */
export const fakeProviderSource = `
(() => {
  const state = { requests: [], hold: false, waiting: null, settingsConfig: undefined, frames: 0, guided: 0, aborted: 0, extras: 0 };
  window.__fake = state;
  const provider = {
    engine: { badge: 'WebGPU FP16' },
    get settings() { return state.settingsConfig; },
    async generate(request, hooks) {
      state.requests.push({ sessionId: request.sessionId, name: request.name, revision: request.revision, settings: request.settings, task: request.spec.task.key, cifLength: request.cif.length });
      const n = request.settings.samples ?? 1;
      hooks.status('Generating design (fake)...', { visible: false });
      for (let k = 0; k < n; k += 1) {
        for (let step = 0; step < 3; step += 1) {
          if (request.signal.aborted) { state.aborted += 1; throw new Error('aborted'); }
          hooks.progress((k + (step + 1) / 3) / n, (n > 1 ? 'design ' + (k + 1) + ' of ' + n + ' · ' : '') + 'step ' + (step + 1) + '/3');
          if (state.frames < 2) { state.frames += 1; await hooks.frame(request.cif, { name: 'step_' + step + '.cif', keepCamera: step > 0, hotspots: [{ chain: 'A', residue: 3 }] }); }
          if (state.hold) await new Promise((resolve, reject) => { state.waiting = resolve; request.signal.addEventListener('abort', () => { state.aborted += 1; reject(new Error('aborted')); }); });
          else await new Promise((r) => setTimeout(r, 5));
        }
        const seed = (request.settings.seed ?? 0) + k;
        await hooks.design({ name: String(seed), cif: request.cif, pdb: null, trajectoryCif: null, filenameStem: 'design-' + (k + 1) + '-seed' + seed, kind: 'monomer', seed, stepsRun: 3, nsteps: 3, designedChains: ['A'], data: { seed } });
      }
      return { message: 'Generated ' + n + ' fake design(s) from input revision ' + request.revision + '.' };
    },
    refold: {
      models: [{ id: 'af3' }, { id: 'openbind0' }],
      async refold(design, settings, ctx) { ctx.onStatus({ text: 'fold', fraction: 0.5 }); return { cif: design.cif ?? null, metrics: { rmsd: 1.2, plddt: 90 }, data: { cif: design.cif } }; },
    },
    renderExtras(container) {
      state.extras += 1;
      container.insertAdjacentHTML('beforeend', [
        '<div id="rfd4p-speed-hint" class="rfd4p-speed-hint" role="note" hidden>',
        '<p><strong>Up to 1.5× faster designs:</strong> turn on Chrome\\u0027s experimental WebGPU. Paste',
        '<code>chrome://flags/#enable-unsafe-webgpu</code> into the address bar, set it to <em>Enabled</em> and relaunch Chrome.</p>',
        '<div class="rfd4p-speed-hint-actions">',
        '<button id="rfd4p-speed-copy" type="button" class="secondary compact">Copy address</button>',
        '<button id="rfd4p-speed-dismiss" type="button" class="secondary compact">Not now</button>',
        '</div></div>'].join(' '));
    },
    guide() { state.guided += 1; },
  };
  window.__fakeProvider = provider;
  return provider;
})()
`;
