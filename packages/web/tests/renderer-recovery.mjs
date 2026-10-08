import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';
import { chromiumLaunchOptions } from '../../../scripts/browser.mjs';

const base=process.env.ANNOTATION_STUDIO_URL??'http://127.0.0.1:8000/';
const browser=await chromium.launch(chromiumLaunchOptions());
try {
  for(const method of ['loadCif','setSelection','showAnnotation','clearAnnotation','showMarkers','setRepresentation']) {
    const page=await browser.newPage();
    await page.goto(`${base}?viewer=patinae`);
    await page.waitForFunction(()=>document.querySelector('#status')?.textContent.includes('Ready.'));
    async function failRenderer() {
      await page.evaluate(async method=>{
        const url=performance.getEntriesByType('resource').map(e=>e.name).find(name=>/\/assets\/patinae-[^/]+\.js$/.test(name));
        const {createPatinaeAdapter}=await import(url);
        const adapter=createPatinaeAdapter({container:document.createElement('div'),onPick(){}});
        Object.getPrototypeOf(adapter)[method]=()=>{throw new Error('Patinae viewer stopped after WASM call render_frame failed; cannot call '+method);};
      },method);
    }
    if(method==='loadCif')await failRenderer();
    const uploaded=page.waitForResponse(r=>r.url().endsWith('/sessions')&&r.request().method()==='POST');
    await page.locator('#file-input').setInputFiles(fileURLToPath(new URL('../../../tests/fixtures/minimal_multichain.cif',import.meta.url)));
    let original=await (await uploaded).json();
    const endpoint=base+'api/v1/sessions/'+original.session_id;
    await page.waitForFunction(()=>!document.querySelector('#download').disabled&&!document.querySelector('#viewer-mode').disabled);
    if(method!=='loadCif') {
      const changed=await page.request.post(endpoint+'/conditions',{data:{condition:'sequence',atom_indices:[0,1],enabled:true,scope:'atom'}});
      assert.equal(changed.status(),200);
      original=await changed.json();
      assert.equal(original.structure.undo_depth,1);
      if(method==='setSelection') await failRenderer();
      else {
        await page.reload();
        await page.waitForFunction(()=>!document.querySelector('#download').disabled&&!document.querySelector('#viewer-mode').disabled);
        await page.locator('#editor-tab-annotations').click();
        if(method==='showMarkers') {
          await page.locator('#condition').selectOption('chain_centroid');
          await page.locator('#centroid-fill').click();
          await page.locator('#centroid-set').click();
          await page.waitForFunction(()=>document.querySelector('#viewer').dataset.centroidMarkers==='1'&&!document.querySelector('#viewer-mode').disabled);
          original=await (await page.request.get(endpoint)).json();
          await failRenderer();
          await page.locator('#centroid-markers').uncheck();
          await page.waitForFunction(()=>document.querySelector('#viewer').dataset.backend==='molstar'&&document.querySelector('#viewer').dataset.centroidMarkers==='0'&&!document.querySelector('#viewer-mode').disabled);
          await page.locator('#centroid-markers').check();
          await page.waitForFunction(()=>document.querySelector('#viewer').dataset.centroidMarkers==='1');
        } else if(method==='setRepresentation') {
          await failRenderer();
          await page.locator('#style-menu').evaluate(menu=>menu.open=true);
          await page.locator('[data-representation="sticks"]').click();
          await page.waitForFunction(()=>document.querySelector('#viewer').dataset.backend==='molstar'&&!document.querySelector('#viewer-mode').disabled);
          await page.locator('#style-menu').evaluate(menu=>menu.open=false);
        } else {
          const annotation=page.locator('#annotation-list > .annotation-row').first();
          if(method==='clearAnnotation') {
            await annotation.click();
            await page.waitForFunction(()=>Number(document.querySelector('#viewer').dataset.annotationAtoms)>0&&!document.querySelector('#viewer-mode').disabled);
          }
          await failRenderer();
          await (method==='clearAnnotation' ? page.locator('#clear-annotation-view') : annotation).click();
          await page.waitForFunction(()=>document.querySelector('#viewer').dataset.backend==='molstar'&&!document.querySelector('#viewer-mode').disabled);
          const colored=Number(await page.locator('#viewer').getAttribute('data-annotation-atoms'));
          assert.equal(colored,method==='clearAnnotation' ? 0 : 2);
          assert.equal(await page.locator('#clear-annotation-view').isDisabled(),method==='clearAnnotation');
        }
      }
    }
    await page.locator('#editor-tab-annotations').click();
    await page.locator('#condition').selectOption('hotspot');
    await page.locator('#selection-syntax').selectOption('expression');
    await page.locator('#viewer-command').fill("chain_id == 'A'");
    await page.locator('#run-viewer-command').click();
    await page.waitForFunction(()=>document.querySelector('#selection-count').textContent.startsWith('2 atoms'));
    await page.waitForFunction(()=>document.querySelector('#viewer').dataset.backend==='molstar'&&!document.querySelector('#viewer-mode').disabled);
    assert.match(await page.locator('#selection-count').textContent(),/^2 atoms/);
    assert.match(await page.locator('#status').textContent(),/Switched to Mol\*/);
    const recovered=await (await page.request.get(endpoint)).json();
    assert.equal(recovered.structure.atom_count,original.structure.atom_count);
    assert.equal(recovered.structure.undo_depth,original.structure.undo_depth);
    assert.deepEqual(recovered.structure.condition_counts,original.structure.condition_counts);
    assert.equal(new URL(page.url()).searchParams.get('viewer'),'molstar');
    const changed=page.waitForResponse(r=>r.url().endsWith('/conditions')&&r.request().method()==='POST');
    await page.locator('#apply-condition').click();
    assert.equal((await (await changed).json()).structure.condition_counts.hotspot,2);
    await page.waitForFunction(()=>!document.querySelector('#viewer-mode').disabled);
    const undo=page.waitForResponse(r=>r.url().endsWith('/undo'));
    await page.locator('#undo').click();
    assert.equal((await (await undo).json()).structure.undo_depth,original.structure.undo_depth);
    console.log(`Patinae ${method} failure: Mol* recovery preserves document/selection/Undo; annotation edit and Undo passed`);
    await page.close();
  }
} finally {await browser.close();}
