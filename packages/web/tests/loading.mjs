import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';
import { chromiumLaunchOptions } from '../../../scripts/browser.mjs';

const base=process.env.ANNOTATION_STUDIO_URL??'http://127.0.0.1:8000/';
const mode=process.env.VIEWER_MODE;
assert.ok(['molstar','patinae'].includes(mode));
const browser=await chromium.launch(chromiumLaunchOptions());
let release;
try {
  const page=await browser.newPage();
  await page.goto(`${base}?viewer=${mode}`);
  await page.waitForFunction(()=>document.querySelector('#status')?.textContent.includes('Ready.'));
  const fixture=fileURLToPath(new URL('../../../tests/fixtures/minimal_multichain.cif',import.meta.url));
  await page.locator(".load-options > summary").click();
  await page.locator("#parse-preset").selectOption("minimal");
  await page.locator(".load-options > summary").click();
  await page.locator('#file-input').setInputFiles(fixture);
  await page.waitForFunction(()=>!document.querySelector('#download').disabled);
  let reached;
  const requested=new Promise(resolve=>{reached=resolve;});
  const held=new Promise(resolve=>{release=resolve;});
  await page.route('**/sessions/*/cif',async route=>{reached();await held;await route.continue();});
  await page.locator('#file-input').setInputFiles({name:'replacement.cif',mimeType:'chemical/x-mmcif',buffer:await readFile(fixture)});
  await requested;
  assert.equal(await page.locator('#download').isEnabled(),false,'Save must wait for the new document to finish loading');
  assert.equal(await page.locator('#workspace').evaluate(el=>el.inert),true,'Editing must wait for the new document');
  release();
  await page.waitForFunction(()=>!document.querySelector('#viewer-mode').disabled&&!document.querySelector('#workspace').inert);
  await page.unroute('**/sessions/*/cif');
  await page.locator('#editor-tab-annotations').click();
  await page.locator('#condition').selectOption('hotspot');
  await page.locator('#selection-syntax').selectOption('expression');
  await page.locator('#viewer-command').fill("chain_id == 'A'");
  await page.locator('#run-viewer-command').click();
  await page.waitForFunction(()=>document.querySelector('#selection-count').textContent.startsWith('2 atoms'));
  const response=page.waitForResponse(r=>r.url().endsWith('/conditions'));
  await page.locator('#apply-condition').click();
  assert.equal((await (await response).json()).structure.condition_counts.hotspot,2);
  const editedSession = await page.evaluate(() => sessionStorage.getItem('annotation-studio-session'));
  await page.reload();
  await page.waitForFunction(() => !document.querySelector('#download').disabled);
  assert.equal(await page.evaluate(() => sessionStorage.getItem('annotation-studio-session')), editedSession);
  assert.equal((await (await page.request.get(`${base}api/sessions/${editedSession}`)).json()).structure.condition_counts.hotspot, 2);

  // Reopening the identical file creates a fresh document on each selection.
  for (let attempt = 0; attempt < 2; attempt++) {
    const previous = await page.evaluate(() => sessionStorage.getItem('annotation-studio-session'));
    await page.locator('#file-input').setInputFiles(fixture);
    await page.waitForFunction(previous => sessionStorage.getItem('annotation-studio-session') !== previous
      && !document.querySelector('#workspace').inert && !document.querySelector('#download').disabled, previous);
    assert.equal(await page.locator('#file-input').inputValue(), '');
    assert.equal(await page.locator('#undo').isDisabled(), true);
  }
  const freshSession = await page.evaluate(() => sessionStorage.getItem('annotation-studio-session'));
  assert.equal((await (await page.request.get(`${base}api/sessions/${freshSession}`)).json()).structure.condition_counts.hotspot ?? 0, 0);
  // URL-backed sessions and pending examples must not reopen after closing.
  await page.evaluate(session => {
    history.replaceState(null, '', `${location.pathname}?viewer=${document.querySelector('#viewer-mode').value}&session=${session}&example=inverse-folding&trajectory=unused`);
    sessionStorage.setItem('annotation-studio-pending-example', 'inverse-folding');
  }, freshSession);
  await page.locator('#editor-tab-main').click();
  await page.locator('#close-structure').click();
  await page.locator('dialog button[value="cancel"]').click();
  assert.equal(await page.evaluate(() => sessionStorage.getItem('annotation-studio-session')), freshSession);
  assert.equal(await page.locator('#download').isEnabled(), true);
  await page.locator('#close-structure').click();
  await Promise.all([
    page.waitForURL(url => !url.searchParams.has('session')),
    page.locator('dialog button[value="confirm"]').click(),
  ]);
  await page.waitForFunction(() => document.querySelector('#status')?.textContent.includes('Ready.'));
  assert.equal(await page.locator('#download').isDisabled(), true);
  assert.equal(await page.locator('#close-structure').isDisabled(), true);
  assert.equal(await page.evaluate(() => sessionStorage.getItem('annotation-studio-session')), null);
  for (const key of ['session', 'example', 'trajectory']) assert.equal(new URL(page.url()).searchParams.has(key), false);
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#status')?.textContent.includes('Ready.'));
  assert.equal(await page.locator('#download').isDisabled(), true);
  console.log(`${mode}: replacement, session restoration, same-file reset, and close/cancel workflows passed`);
} finally {release?.();await browser.close();}
