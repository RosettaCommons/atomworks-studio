// The Refold panel (src/refold/panel.ts) in a browser, against a fake provider: the controls, their defaults and option
// sets as the reference page has them, the terms dialog (accept / switch / cancel), Refold all and Stop, the numbers
// and pass marks in each row, and the overlays drawn for the design shown. Runs without Studio's server: the panel is
// a module of its own.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { chromiumLaunchOptions } from '../../../scripts/browser.mjs';

const server = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), server: { host: '127.0.0.1', port: 0 } });
await server.listen();
const base = server.resolvedUrls.local[0];
const TERMS_KEY = 'atomworks-studio.refoldTerms.af3';

const browser = await chromium.launch(chromiumLaunchOptions());
try {
  const page = await browser.newPage({ viewport: { width: 520, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/__refold-test', (route) => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><body style="background:#161719;color:#ededef;margin:12px"><div id="host" style="width:440px"></div></body>',
  }));
  await page.goto(`${base}__refold-test`);

  // A provider whose folds wait for the test: each call records its settings and resolves on `release()`.
  await page.evaluate(async (root) => {
    const { mountRefoldPanel } = await import(`${root}src/refold/index.ts`);
    const state = { calls: [], overlays: [], selected: [], aborted: 0, waiting: null, prepared: [], hold: false };
    window.__fake = state;
    const provider = {
      models: [{ id: 'af3' }, { id: 'openbind0' }],
      prepare: async (model) => { state.prepared.push(model); },
      refold: (design, settings, { signal, onStatus }) => new Promise((resolve, reject) => {
        state.calls.push({ id: design.id, settings });
        if (state.fail) { reject(new Error('the fold failed')); return; }
        onStatus({ text: 'trunk', fraction: 0.5 });
        const finish = () => resolve({
          cif: `data_refold_${design.id}\n`, ligandCif: design.id === 's1' ? `data_lig_${design.id}\n` : null,
          metrics: { rmsd: design.id === 's2' ? 3.2 : 0.9, plddt: 91.4 + Number(design.id.slice(1)), iptm: NaN },
        });
        signal.addEventListener('abort', () => { state.aborted += 1; reject(new Error('aborted')); });
        if (state.hold) state.waiting = finish; else setTimeout(finish, 5);
      }),
    };
    window.__panel = mountRefoldPanel(document.querySelector('#host'), provider, {
      nameHeader: { label: 'Seed', title: 'Each design is named by its seed' },
      overlay: async (key, cif, options) => { state.overlays.push({ key, cif, options }); },
      onSelect: async (id) => { state.selected.push(id); window.__panel.setSelected(id); },
    });
  }, base);

  const panel = page.locator('.refold-panel');
  assert.equal(await page.locator('#refold-box').isVisible(), false, 'no designs: no Refold box');

  await page.evaluate(() => window.__panel.setDesigns([
    { id: 's1', name: '101', kind: 'monomer', cif: 'data_d1\n' },
    { id: 's2', name: '102', kind: 'monomer', cif: 'data_d2\n' },
    { id: 's3', name: '103', kind: 'monomer', cif: 'data_d3\n' },
  ]));
  await page.evaluate(() => window.__panel.setSelected('s1'));
  assert.equal(await page.locator('#refold-box').isVisible(), true);

  // --- Defaults, options and tooltips: the reference page's --------------------------------------------------------
  const read = (selector) => page.locator(selector).evaluate((el) => (el.tagName === 'SELECT'
    ? { value: el.value, options: [...el.options].map((o) => [o.value, o.textContent]) } : { value: el.value, min: el.min, max: el.max, step: el.step, type: el.type }));
  assert.deepEqual(await read('#refold-model'), { value: 'af3', options: [['af3', 'AlphaFold 3'], ['openbind0', 'OpenBind-0']] });
  assert.deepEqual(await read('#refold-seed'), { value: '0', min: '0', max: '4294967295', step: '1', type: 'number' });
  assert.deepEqual(await read('#refold-recycles'),
    { value: '3', options: [0, 1, 2, 3, 5, 10].map((n) => [String(n), String(n)]) });
  assert.deepEqual(await read('#refold-steps'),
    { value: '25', options: [25, 50, 100, 200].map((n) => [String(n), String(n)]) });
  assert.equal(await page.locator('#refold-seed-label').getAttribute('title'), 'Another seed samples the fold again');
  assert.equal(await page.locator('#refold-recycles-label').getAttribute('title'), 'Trunk recycling passes: more is slower, sometimes more confident');
  assert.equal(await page.locator('#refold-steps-label').getAttribute('title'),
    "Diffusion steps of the structure module: 25 is LocalFold's default, 200 AlphaFold 3's own");
  assert.equal(await page.locator('#refold-box > strong').textContent(), 'Refold');
  assert.equal(await page.locator('#refold-btn').textContent(), 'Refold all');
  assert.equal(await page.locator('#refold-btn').getAttribute('title'), 'Refold every design not yet refolded with these settings');
  assert.deepEqual(await page.locator('.refold-dtable th').allTextContents(), ['Seed', 'RMSD', 'pLDDT', '']);
  assert.equal(await page.locator('.refold-dtable th.refold-dt-name').getAttribute('title'), 'Each design is named by its seed');
  assert.deepEqual(await page.locator('.refold-dtable tbody tr .refold-dt-name').allTextContents(), ['101', '102', '103']);
  assert.equal(await page.locator('.refold-dtable tbody tr:first-child input:checked').count(), 1, 'the shown design is marked');
  assert.deepEqual(await page.evaluate(() => window.__fake.prepared), [], 'AlphaFold 3 is not fetched before its terms are agreed to');

  // --- Terms: Cancel ------------------------------------------------------------------------------------------------
  await page.locator('#refold-btn').click();
  const dialog = page.locator('#refold-terms');
  await dialog.waitFor({ state: 'visible' });
  assert.equal(await dialog.locator('h2').textContent(), 'AlphaFold 3 model parameters');
  const paragraphs = await dialog.locator('form > p').allTextContents();
  assert.equal(paragraphs[0], "These are Google DeepMind's parameters. They are not available for commercial use and carry a prohibited-use policy.");
  assert.equal(paragraphs[1], 'OpenBind-0 runs the same architecture under Apache 2.0. It is a different model.');
  assert.equal(await dialog.locator('p strong').textContent(), 'OpenBind-0');
  const links = await dialog.locator('a').evaluateAll((as) => as.map((a) => [a.textContent, a.href, a.target, a.rel]));
  assert.deepEqual(links, [
    ['AlphaFold 3 weights terms', 'https://github.com/google-deepmind/alphafold3/blob/main/WEIGHTS_TERMS_OF_USE.md', '_blank', 'noopener noreferrer'],
    ['prohibited use policy', 'https://github.com/google-deepmind/alphafold3/blob/main/WEIGHTS_PROHIBITED_USE_POLICY.md', '_blank', 'noopener noreferrer'],
  ]);
  assert.deepEqual(await dialog.locator('button').evaluateAll((bs) => bs.map((b) => [b.value, b.textContent, b.className])), [
    ['switch', 'Use OpenBind-0', 'primary compact'],
    ['accept', 'I agree, use AlphaFold 3', 'secondary compact'],
    ['cancel', 'Cancel', 'secondary compact'],
  ]);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal((await page.evaluate(() => window.__fake.calls)).length, 0, 'Cancel folds nothing');
  assert.equal(await page.locator('#refold-model').inputValue(), 'af3', 'and leaves the model alone');
  assert.equal(await page.evaluate((k) => localStorage.getItem(k), TERMS_KEY), null, 'and remembers nothing');

  // Escape is Cancel too.
  await page.locator('#refold-btn').click();
  await dialog.waitFor({ state: 'visible' });
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  assert.equal((await page.evaluate(() => window.__fake.calls)).length, 0);

  // --- Terms: switch to OpenBind-0 -----------------------------------------------------------------------------------
  await page.locator('#refold-btn').click();
  await dialog.waitFor({ state: 'visible' });
  await dialog.getByRole('button', { name: 'Use OpenBind-0' }).click();
  await page.waitForFunction(() => window.__fake.calls.length === 3);
  assert.equal(await page.locator('#refold-model').inputValue(), 'openbind0', 'the box follows the switch');
  assert.deepEqual((await page.evaluate(() => window.__fake.calls)).map((c) => [c.id, c.settings.model]),
    [['s1', 'openbind0'], ['s2', 'openbind0'], ['s3', 'openbind0']]);
  assert.equal(await page.evaluate((k) => localStorage.getItem(k), TERMS_KEY), null, 'switching is not agreeing');
  await page.waitForFunction(() => document.querySelector('#refold-btn').textContent === 'Refold all' && document.querySelector('#refold-btn').disabled);
  assert.equal(await page.locator('#refold-btn').getAttribute('title'), 'Every design is refolded with these settings');

  // Numbers in the rows, a tick on those that pass, the others greyed.
  const rows = await page.locator('.refold-dtable tbody tr').evaluateAll((trs) => trs.map((tr) => ({
    cells: [...tr.querySelectorAll('td.refold-dt-num')].map((td) => td.textContent),
    pass: Boolean(tr.querySelector('.refold-pass')), fail: tr.classList.contains('refold-fail'),
  })));
  assert.deepEqual(rows, [
    { cells: ['0.9', '92'], pass: true, fail: false },
    { cells: ['3.2', '93'], pass: false, fail: true },
    { cells: ['0.9', '94'], pass: true, fail: false },
  ]);
  // Columns for an interface only appear with an interface number: none of these has one.
  assert.deepEqual(await page.locator('.refold-dtable th').allTextContents(), ['Seed', 'RMSD', 'pLDDT', '']);

  // The shown design's refold is drawn over it in magenta, a cartoon, with its ligands as sticks.
  const overlays = await page.evaluate(() => window.__fake.overlays);
  const lastRefold = overlays.findLast((o) => o.key === 'refold');
  assert.equal(lastRefold.cif, 'data_refold_s1\n'.replace('s1', 's3'), 'the last refold shown is the last design folded');
  assert.deepEqual(lastRefold.options, { label: 'OpenBind-0 refold', color: 0xe040fb, alpha: 0.75, representation: 'cartoon' });
  assert.deepEqual(await page.evaluate(() => window.__fake.selected), ['s2', 's3'], 'the panel asks its host to show each design as it finishes');

  // Selecting a design with a ligand draws both overlays; one without removes the ligand overlay.
  await page.locator('.refold-dtable tbody tr[data-design="s1"] .refold-dt-name').click();
  await page.waitForFunction(() => window.__fake.overlays.at(-1)?.key === 'refoldLigands');
  const tail = (await page.evaluate(() => window.__fake.overlays)).slice(-2);
  assert.deepEqual(tail.map((o) => [o.key, o.cif]), [['refold', 'data_refold_s1\n'], ['refoldLigands', 'data_lig_s1\n']]);
  assert.deepEqual(tail[1].options, { label: 'OpenBind-0 refold ligands', color: 0xe040fb, sizeAspectRatio: 0.6 });
  await page.locator('.refold-dtable tbody tr[data-design="s2"] .refold-dt-name').click();
  await page.waitForFunction(() => window.__fake.overlays.at(-1)?.key === 'refoldLigands' && window.__fake.overlays.at(-1).cif === null);

  // --- Sorting by a column head ------------------------------------------------------------------------------------
  await page.getByRole('button', { name: /^pLDDT/ }).click();
  assert.deepEqual(await page.locator('.refold-dtable tbody .refold-dt-name').allTextContents(), ['103 ✓', '102', '101 ✓'], 'pLDDT sorts high to low first');

  // --- Terms: agree ------------------------------------------------------------------------------------------------------
  await page.locator('#refold-model').selectOption('af3');
  await page.locator('#refold-seed').fill('5');
  await page.locator('#refold-seed').dispatchEvent('change');
  assert.equal(await page.locator('#refold-btn').isDisabled(), false, 'a new seed leaves designs to fold');
  await page.locator('#refold-btn').click();
  await dialog.waitFor({ state: 'visible' });
  await dialog.getByRole('button', { name: 'I agree, use AlphaFold 3' }).click();
  await page.waitForFunction(() => window.__fake.calls.length === 6);
  assert.equal(await page.evaluate((k) => localStorage.getItem(k), TERMS_KEY), 'accepted');
  assert.deepEqual((await page.evaluate(() => window.__fake.calls)).slice(3).map((c) => c.settings),
    Array(3).fill({ model: 'af3', seed: 5, recycles: 3, steps: 25 }));
  const prepared = await page.evaluate(() => window.__fake.prepared);
  assert.ok(prepared.includes('openbind0') && prepared.includes('af3'), `parameters are fetched for the model chosen, once it may be: ${prepared}`);
  // Agreed once: a further run does not ask again.
  await page.waitForFunction(() => document.querySelector('#refold-btn').disabled);
  await page.locator('#refold-seed').fill('6');
  await page.locator('#refold-seed').dispatchEvent('change');
  await page.locator('#refold-btn').click();
  await page.waitForFunction(() => window.__fake.calls.length === 9);
  assert.equal(await dialog.isVisible(), false, 'agreement is remembered');

  // --- Refold all, then Stop -----------------------------------------------------------------------------------------------
  await page.waitForFunction(() => document.querySelector('#refold-btn').disabled);
  await page.evaluate(() => { window.__fake.hold = true; });
  await page.locator('#refold-seed').fill('7');
  await page.locator('#refold-seed').dispatchEvent('change');
  await page.locator('#refold-btn').click();
  await page.waitForFunction(() => /^Stop/.test(document.querySelector('#refold-btn').textContent));
  assert.match(await page.locator('#refold-btn').textContent(), /^Stop · seed 1\d\d \(1 of 3\) · 50%$/);
  assert.ok(await page.locator('#refold-btn').evaluate((b) => b.classList.contains('refold-running')));
  assert.equal(await page.locator('.refold-dtable tbody tr[data-design="s3"] .refold-dt-state').textContent().catch(() => 'none'), 'queued');
  const states = await page.locator('.refold-dt-state').allTextContents();
  assert.ok(states.includes('refolding…') && states.includes('queued'), `rows say what is happening: ${states}`);
  assert.equal(await page.locator('.refold-design-refold').first().isDisabled(), true, 'per-design refold waits while one runs');
  await page.locator('#refold-btn').click(); // Stop
  await page.waitForFunction(() => document.querySelector('#refold-btn').textContent === 'Refold all');
  assert.equal(await page.evaluate(() => window.__fake.aborted), 1, 'the running fold saw its signal abort');
  assert.equal(await page.evaluate(() => window.__fake.calls.length), 10, 'and no further design was started');
  assert.equal(await page.locator('#refold-result').isVisible(), false, 'stopping is not an error');
  assert.equal(await page.locator('#refold-btn').isDisabled(), false, 'the unfinished designs are still to fold');

  // --- A failure gets a line ------------------------------------------------------------------------------------------------
  await page.evaluate(() => { window.__fake.hold = false; window.__fake.fail = true; });
  await page.locator('#refold-seed').fill('8');
  await page.locator('#refold-seed').dispatchEvent('change');
  await page.locator('#refold-btn').click();
  await page.locator('#refold-result').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#refold-result').textContent(), 'Refolded 0 designs with AlphaFold 3; 3 failed.');
  assert.ok(await page.locator('#refold-result').evaluate((p) => p.classList.contains('error')));
  assert.deepEqual(await page.locator('.refold-dt-state').allTextContents(), ['refold failed', 'refold failed', 'refold failed']);
  assert.deepEqual(errors.filter((e) => !/the fold failed/.test(e)), []);
  await page.close();
  console.log('refold panel: defaults, terms dialog (cancel / switch / agree), Refold all / Stop, rows and overlays as the reference page');
} finally {
  await browser.close();
  await server.close();
}
