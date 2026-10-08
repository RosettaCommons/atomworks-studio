// Run against the RFD4 Gradio wrapper; editing assertions are shared with desktop parity tests.
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';
import { chromiumLaunchOptions } from '../../../scripts/browser.mjs';
import {designWorkflows} from './design-workflow-driver.mjs';

const base = new URL(process.env.ANNOTATION_STUDIO_URL ?? 'http://127.0.0.1:8791/').href;
const mode = process.env.VIEWER_MODE ?? 'patinae';
const output = process.env.STUDIO_WORKFLOW_OUTPUT ?? 'workflow-output';
const labels = {
  unconditional: 'Protein design', motif_scaffolding: 'Motif scaffolding', enzyme_design: 'Enzyme design',
  small_molecule_binder: 'Small-molecule binder', antibody_design: 'Antibody / VHH',
  partial_diffusion: 'Partial diffusion (40%)', inverse_folding: 'Inverse folding',
};
await mkdir(output, {recursive: true});
const browser = await chromium.launch(chromiumLaunchOptions());
try {
  const context = await browser.newContext({viewport: {width: 1440, height: 1100}, colorScheme: 'dark'});
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  if (process.env.HF_TOKEN) {
    await page.route(base + '**', route => route.continue({headers: {
      ...route.request().headers(), Authorization: `Bearer ${process.env.HF_TOKEN}`,
    }}));
  }
  await page.addInitScript(mode => localStorage.setItem('annotation-studio-viewer-v2', mode), mode);
  const url = process.env.GRADIO_URL ?? base + 'design/';
  if (process.env.STUDIO_PARENT_ORIGIN) {
    const host = new URL('/__studio_frame_test__', process.env.STUDIO_PARENT_ORIGIN).href;
    await page.route(host, route => route.fulfill({contentType: 'text/html', body:
      `<html><body style="margin:0"><iframe title="Space" style="width:100%;height:1400px;border:0" src="${url}"></iframe></body></html>`}));
    await page.goto(host);
  } else await page.goto(url);
  const demo = process.env.STUDIO_PARENT_ORIGIN
    ? await page.locator('iframe[title="Space"]').elementHandle().then(element => element.contentFrame()) : page;
  await demo.locator('iframe[title="AtomWorks Studio"]').waitFor({timeout: 120000});
  let ui = await demo.locator('iframe[title="AtomWorks Studio"]').elementHandle().then(element => element.contentFrame());
  await ui.locator('#status-message').filter({hasText: 'Ready. Open a CIF'}).waitFor({timeout: 120000});
  assert.equal(await ui.locator('.example-load').count(), 9);
  const api = context.request;
  // The browser request client does not inherit route authentication.
  const authenticated = {
    get: url => {
      assert.equal(new URL(url).origin, new URL(base).origin);
      return api.get(url, {headers: process.env.HF_TOKEN ? {Authorization: `Bearer ${process.env.HF_TOKEN}`} : {}});
    },
  };
  const examples = await (await authenticated.get(base + 'api/v1/examples')).json();
  await designWorkflows({page, ui, base, label: 'gradio-' + mode, output, request: authenticated,
    onLoaded: async scenario => {
      if (!scenario.example_id) return;
      const task = examples.find(example => example.id === scenario.example_id).task;
      await demo.waitForFunction(label => [...document.querySelectorAll('input')].some(input => input.value === label), labels[task]);
    },
  });
  await demo.getByRole('combobox').first().click();
  await demo.getByRole('option', {name: 'Inverse folding', exact: true}).click();
  await demo.waitForFunction(() => !document.querySelector('iframe[title="AtomWorks Studio"]').dataset.task);
  assert.equal(await demo.getByRole('combobox').first().inputValue(), 'Inverse folding');
  if (process.env.STUDIO_TEST_GENERATE === '1') {
    const generationExample = process.env.STUDIO_TEST_EXAMPLE ?? 'antibody_design';
    await ui.locator('#editor-tab-main').click();
    await ui.locator('#examples-panel').evaluate(element => element.open = true);
    await ui.locator(`[data-example="${generationExample}"]`).click();
    const task = examples.find(example => example.id === generationExample).task;
    await demo.waitForFunction(label => [...document.querySelectorAll('input')].some(input => input.value === label), labels[task]);
    await page.screenshot({path: join(output, 'gradio-input.png'), fullPage: true});
    const inputSession = await demo.locator('iframe[title="AtomWorks Studio"]').getAttribute('data-session-id');
    await demo.getByRole('button', {name: 'Generate design', exact: true}).click();
    await demo.locator('#generation-status [data-testid="status-tracker"]').waitFor();
    assert.equal(await demo.locator('#studio-editor [data-testid="status-tracker"]').isVisible(), false);
    await demo.locator('#generation-status').filter({hasText: 'Generated from input revision'}).waitFor({timeout: 300000});
    await demo.frameLocator('iframe[title="AtomWorks Studio"]').locator('#status-message').filter({hasText: 'Restored native AtomWorks session.'}).waitFor({timeout: 120000});
    assert.equal(await demo.getByRole('radio', {name: 'Design 1', exact: true}).isChecked(), true);
    await demo.waitForFunction(id => { const current = document.querySelector('iframe[title="AtomWorks Studio"]').dataset.sessionId; return current && current !== id; }, inputSession);
    const resultSession = await demo.locator('iframe[title="AtomWorks Studio"]').getAttribute('data-session-id');
    await demo.getByRole('radio', {name: 'Input', exact: true}).check();
    await demo.waitForFunction(id => document.querySelector('iframe[title="AtomWorks Studio"]').dataset.sessionId === id, inputSession);
    await demo.getByRole('radio', {name: 'Design 1', exact: true}).check();
    await demo.waitForFunction(id => document.querySelector('iframe[title="AtomWorks Studio"]').dataset.sessionId === id, resultSession);
    await demo.frameLocator('iframe[title="AtomWorks Studio"]').locator('#status-message').filter({hasText: 'Restored native AtomWorks session.'}).waitFor({timeout: 120000});
    ui = await demo.locator('iframe[title="AtomWorks Studio"]').elementHandle().then(element => element.contentFrame());
    let visiblePixels = 0;
    const renderDeadline = Date.now() + 30000;
    do {
      await page.waitForTimeout(400);
      const frame = await ui.locator('#viewer canvas').first().screenshot();
      visiblePixels = await page.evaluate(async data => {
        const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob());
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext('2d');
        context.drawImage(bitmap, 0, 0);
        const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
        let count = 0;
        for (let y = 3; y < bitmap.height - 3; y++) for (let x = 150; x < bitmap.width - 150; x++) {
          const i = (y * bitmap.width + x) * 4;
          if (Math.max(pixels[i], pixels[i + 1], pixels[i + 2]) > 50) count++;
        }
        return count;
      }, frame.toString('base64'));
    } while (visiblePixels <= 100 && Date.now() < renderDeadline);
    assert.ok(visiblePixels > 100, `Generated design is visible (${visiblePixels} pixels)`);
    await ui.locator('#viewer canvas').first().screenshot({path: join(output, 'gradio-rendered-canvas.png')});
    await demo.evaluate(() => window.scrollTo(0, 0));
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({path: join(output, 'gradio-result.png'), fullPage: true});
    await ui.locator('#file-input').setInputFiles(fileURLToPath(new URL('../../../tests/fixtures/SAM_hbonds.cif', import.meta.url)));
    await demo.locator('#design-results').waitFor({state: 'hidden'});
    await ui.locator('#editor-tab-main').click();
    await ui.locator('#examples-panel').evaluate(element => element.open = true);
    await ui.locator('[data-example="inverse_folding"]').click();
    await demo.waitForFunction(() => [...document.querySelectorAll('input')].some(input => input.value === 'Inverse folding'));
    assert.equal(await demo.locator('#design-results').isVisible(), false);
  }
  assert.deepEqual(errors, []);
  console.log(`Gradio ${mode}: shared workflows, example task synchronization${process.env.STUDIO_TEST_GENERATE === '1' ? ', generation, reopen and stale-result reset' : ''} passed`);
} finally { await browser.close(); }
