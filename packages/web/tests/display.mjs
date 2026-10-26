// Exercise actual rendered geometry, not just successful toolbar clicks.
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';
import { chromiumLaunchOptions } from '../../../scripts/browser.mjs';

const base = process.env.ANNOTATION_STUDIO_URL ?? 'http://127.0.0.1:8791/';
const mode = process.env.VIEWER_MODE ?? 'patinae';
const embedded = process.env.STUDIO_GRADIO === '1';
const output = process.env.STUDIO_WORKFLOW_OUTPUT ?? 'workflow-output';
await mkdir(output, {recursive: true});
const browser = await chromium.launch(chromiumLaunchOptions());
let ui;
const errors = [];
const consoleErrors = [];
try {
  const page = await browser.newPage({viewport: {width: 1440, height: 1100}, colorScheme: 'dark'});
  page.on('pageerror', error => errors.push(error.stack ?? error.message));
  page.on('console', message => { if(message.type()==='error') consoleErrors.push(message.text()); });
  if (process.env.HF_TOKEN) await page.route(base + '**', route => route.continue({headers: {
    ...route.request().headers(), Authorization: `Bearer ${process.env.HF_TOKEN}`,
  }}));
  await page.addInitScript(mode => localStorage.setItem('annotation-studio-viewer-v2', mode), mode);
  const url = base + (embedded ? 'design/' : '');
  if (process.env.STUDIO_PARENT_ORIGIN) {
    const host = new URL('/__studio_frame_test__', process.env.STUDIO_PARENT_ORIGIN).href;
    await page.route(host, route => route.fulfill({contentType: 'text/html', body:
      `<html><body style="margin:0"><iframe title="Space" style="width:100%;height:1400px;border:0" src="${url}"></iframe></body></html>`}));
    await page.goto(host);
  } else await page.goto(url);
  const demo = process.env.STUDIO_PARENT_ORIGIN
    ? await page.locator('iframe[title="Space"]').elementHandle().then(element => element.contentFrame()) : page;
  ui = embedded
    ? await demo.locator('iframe[title="AtomWorks Studio"]').elementHandle().then(element => element.contentFrame()) : demo;
  await ui.locator('#status-message').filter({hasText: 'Ready. Open a CIF'}).waitFor({timeout: 120000});
  const loaded = page.waitForResponse(r => r.url().endsWith('/sessions') && r.request().method() === 'POST');
  await ui.locator(".load-options > summary").click();
  await ui.locator("#parse-preset").selectOption("minimal");
  await ui.locator(".load-options > summary").click();
  await ui.locator('#file-input').setInputFiles(fileURLToPath(new URL('../../../tests/fixtures/minimal_multichain.cif', import.meta.url)));
  const session = await (await loaded).json();
  const endpoint = base + 'api/v1/sessions/' + session.session_id;
  const headers = process.env.HF_TOKEN ? {Authorization: `Bearer ${process.env.HF_TOKEN}`} : {};
  const snapshot = async () => (await (await page.request.get(endpoint + '/cif', {headers})).text()).replace(/^_entry\.(date|time).*$/gm, '');
  const original = await snapshot();
  const settle = () => ui.waitForFunction(() => !document.querySelector('#viewer-mode').disabled && !document.querySelector('#download').disabled);
  await settle();
  assert.equal(await ui.locator('#viewer').getAttribute('data-backend'), mode);
  async function style(action, representation, target='all') {
    await ui.locator('#style-menu').evaluate(menu => menu.open = true);
    await ui.locator('#viewer-action-target').selectOption(target);
    await ui.locator(`input[name="representation-action"][value="${action}"]`).check();
    await ui.locator(`[data-representation="${representation}"]`).click();
    const verb = action === 'replace' ? 'Show only' : action === 'hide' ? 'Hide' : 'Show';
    await ui.locator('#status-message').filter({hasText: `${verb} ${representation} ·`}).waitFor();
    await settle();
    await ui.locator('#style-menu').evaluate(menu => menu.open = false);
  }
  async function select(query) {
    await ui.locator('#selection-syntax').selectOption('expression');
    await ui.locator('#viewer-command').fill(query);
    await ui.locator('#run-viewer-command').click();
    await ui.waitForFunction(() => document.querySelector('#viewer-command').value === '');
  }
  async function pixels(name, ready = () => true) {
    const deadline = Date.now() + 15000;
    let count;
    do {
      count = await readPixels(name);
      if (ready(count)) return count;
    } while (Date.now() < deadline);
    return count;
  }
  async function readPixels(name) {
    await ui.locator(".viewer-menu").evaluateAll(menus => menus.forEach(menu => menu.open = false));
    // Let the renderer present a frame after its state update commits.
    await page.waitForTimeout(400);
    const image = await ui.locator('#viewer canvas').first().screenshot({path: `${output}/${mode}-${embedded ? 'gradio' : 'studio'}-${name}.png`});
    return page.evaluate(async data => {
      const image = await createImageBitmap(await (await fetch('data:image/png;base64,' + data)).blob());
      const canvas = new OffscreenCanvas(image.width, image.height);
      const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
      const pixels = ctx.getImageData(0, 0, image.width, image.height).data;
      let count = 0;
      for (let y=3; y<image.height-3; y++) for (let x=150; x<image.width-150; x++) {
        const i=(y*image.width+x)*4;
        if (Math.max(pixels[i],pixels[i+1],pixels[i+2]) > 50) count++;
      }
      return count;
    }, image.toString('base64'));
  }
  await style('replace', 'spheres');
  const full = await pixels('spheres', count => count > 100);
  assert.ok(full > 100, `visible spheres: ${full}`);
  await select("chain_id == 'A'");
  await style('hide', 'spheres', 'selection');
  await ui.locator('#clear-selection').click();
  const partial = await pixels('selection-hidden', count => count > 50 && count < full * .9);
  assert.ok(partial > 50 && partial < full * .9, `selection hide ${partial} < ${full}`);
  await style('show', 'spheres');
  const restored = await pixels('restored', count => Math.abs(count-full) < full*.05);
  assert.ok(Math.abs(restored-full) < full*.05, `show restores geometry: ${restored}, ${full}`);
  await style('hide', 'everything');
  const hidden = await pixels('hidden', count => count < full*.01);
  assert.ok(hidden < full * .01, `hide everything leaves no molecular geometry: ${hidden}`);
  await style('show', 'surface');
  assert.ok(await pixels('surface', count => count > 100) > 100);
  await style('hide', 'surface');
  assert.ok(await pixels('surface-hidden', count => count < full*.01) < full * .01);
  await style('replace', 'sticks');
  assert.ok(await pixels('sticks', count => count > 50) > 50);
  assert.equal(await snapshot(), original, 'styles preserve the annotated document');
  assert.equal(await ui.locator('#undo').isEnabled(), false, 'styles do not enter edit history');
  await style('replace', 'spheres');
  await select("chain_id == 'A'");
  await style('hide', 'spheres', 'selection');
  // Applying an annotation reloads the viewer; hidden A must not follow the new B selection.
  await select("chain_id == 'B'");
  await ui.locator('#editor-tab-annotations').click();
  await ui.locator('#condition').selectOption('hotspot');
  const annotated = page.waitForResponse(r => r.url().endsWith('/conditions') && r.request().method() === 'POST');
  await ui.locator('#apply-condition').click();
  assert.equal((await (await annotated).json()).structure.condition_counts.hotspot, 2);
  await settle();
  await ui.locator('#clear-selection').click();
  assert.ok(await pixels('annotation', count => count < full*.9) < full*.9, 'refresh keeps the originally hidden atoms hidden');
  await style('hide', 'everything');
  const alternate = mode === 'molstar' ? 'patinae' : 'molstar';
  await ui.locator('[data-menu="overflow"]').evaluate(menu => menu.open = true);
  await ui.locator('#viewer-mode').selectOption(alternate);
  await ui.waitForFunction(backend => document.querySelector('#viewer').dataset.backend === backend, alternate);
  await settle();
  assert.ok(await pixels('renderer-switch-hidden', count => count < full*.01) < full*.01, 'renderer switch preserves hidden representations');
  await style('show', 'spheres');
  assert.ok(await pixels('renderer-switch-shown', count => count > 100) > 100);
  await ui.locator('[data-menu="overflow"]').evaluate(menu => menu.open = true);
  await ui.locator('#viewer-mode').selectOption(mode);
  await ui.waitForFunction(backend => document.querySelector('#viewer').dataset.backend === backend, mode);
  await settle();
  await ui.locator('#editor-tab-main').click();
  await ui.locator('#examples-panel').evaluate(panel => panel.open = true);
  const example = page.waitForResponse(r => r.url().endsWith('/sessions') && r.request().method() === 'POST');
  await ui.locator('[data-example="antibody_design"]').click();
  await example;
  await settle();
  await style('replace', 'cartoon');
  assert.ok(await pixels('antibody-cartoon', count => count > 100) > 100, 'new example resets prior display state');
  await style('show', 'ribbon');
  await style('hide', 'ribbon');
  await select("chain_id == 'A'");
  await style('show', 'surface', 'selection');
  assert.ok(await pixels('antibody-target', count => count > 100) > 100);
  await style('hide', 'surface', 'selection');
  await style('show', 'lines', 'selection');
  await style('hide', 'lines', 'selection');
  await ui.locator('#clear-selection').click();
  await ui.locator('#style-menu').evaluate(menu => menu.open = true);
  await page.screenshot({path: `${output}/${mode}-${embedded ? 'gradio' : 'studio'}-controls.png`});
  assert.deepEqual(errors, []);
  console.log(`${mode} ${embedded ? 'Gradio' : 'Studio'}: show/hide/replace, selected geometry, surface, CIF and annotation refresh passed`);
} catch (error) {
  console.error('Display diagnostics:', await ui?.evaluate(() => ({
    status: document.querySelector('#status')?.textContent,
    viewer: { ...document.querySelector('#viewer')?.dataset },
  })).catch(() => null), errors, consoleErrors);
  throw error;
} finally { await browser.close(); }
