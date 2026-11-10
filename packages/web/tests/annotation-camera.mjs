import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { chromiumLaunchOptions } from '../../../scripts/browser.mjs';
const server = await createServer({root:fileURLToPath(new URL('../',import.meta.url)),server:{host:'127.0.0.1',port:0}});
await server.listen();
const base = server.resolvedUrls.local[0];
const cif = await readFile(new URL('../../../tests/fixtures/inverse_folding_2kl8.cif', import.meta.url), 'utf8');
const enzyme = await readFile(new URL('../../../packages/api/annotation_studio/examples/enzyme_design.cif', import.meta.url), 'utf8');
const browser = await chromium.launch(chromiumLaunchOptions());
await mkdir('artifacts/local/annotation-camera', {recursive:true});
try {
 for (const backend of ['molstar','patinae']) {
  const page = await browser.newPage({viewport:{width:1000,height:800}});
  const errors=[];
  page.on('pageerror', error=>errors.push(error.message));
  await page.route('**/__adapter-test', route=>route.fulfill({contentType:'text/html',body:'<div id="viewer" style="width:960px;height:740px"></div>'}));
  await page.route('**/patinae_web_bg.wasm', route=>route.fulfill({contentType:'application/wasm',path:new URL('../dist/assets/patinae_web_bg.wasm',import.meta.url).pathname}));
  await page.goto(`${base}__adapter-test`);
  await page.evaluate(async ({base,backend,cif})=>{
   const module=await import(`${base}src/viewers/${backend}.ts`);
   window.adapter=module[backend==='molstar'?'createMolstarAdapter':'createPatinaeAdapter']({container:document.querySelector('#viewer'),onPick:()=>{}});
   await window.adapter.initialize();
   await window.adapter.loadCif(cif,'protein');
  },{base,backend,cif});
  // Software-rendered CI can take seconds to fit the camera to the structure; wait for it before perturbing the view.
  if(backend==='molstar') await page.waitForFunction(()=>window.adapter.viewer.plugin.canvas3d.camera.getSnapshot().radius>1,null,{timeout:30000});
  const camera = () => page.evaluate(async backend=>{
   if(backend==='patinae') return (await window.adapter.viewer.execute('get_view')).messages;
   const s=window.adapter.viewer.plugin.canvas3d.camera.getSnapshot();
   return {position:s.position,target:s.target,up:s.up,radius:s.radius,fov:s.fov,mode:s.mode};
  },backend);
  // A fixed sleep here would race the render: the camera is written asynchronously, and a sleep that is long
  // enough on today's machine silently stops waiting for anything the moment the render gets faster — which is
  // how this test passed in one CI run and failed in the next on byte-identical code. Poll instead, and treat the
  // camera as settled only once repeated readings agree. QUIET_SAMPLES*INTERVAL is the floor, so the weakest wait
  // here is still longer than the 100 ms sleep it replaces.
  const INTERVAL=50, QUIET_SAMPLES=6, ATTEMPTS=600;
  const settledCamera = async () => {
   let previous=JSON.stringify(await camera()), agreements=0;
   for(let attempt=0; attempt<ATTEMPTS; attempt++) {
    await page.waitForTimeout(INTERVAL);
    const current=JSON.stringify(await camera());
    agreements = current===previous ? agreements+1 : 0;
    previous=current;
    if(agreements>=QUIET_SAMPLES) return JSON.parse(current);
   }
   throw new Error(`${backend}: the camera never stopped moving`);
  };
  await settledCamera();
  // Deliberately use a non-default view, so resetting to the whole structure fails.
  await page.evaluate(async backend=>{
   if(backend==='molstar') {
    const camera=window.adapter.viewer.plugin.canvas3d.camera;
    const snapshot=camera.getSnapshot();
    camera.setState({position:snapshot.position.map((v,i)=>v+[3,4,7][i]), target:snapshot.target.map(v=>v+2)},0);
   } else await window.adapter.executeCommand('turn y, 25');
  },backend);
  const original=await settledCamera();
  const groups=[{label:'Site A',atomIndices:[6,100],showAtoms:true},{label:'Site B',atomIndices:[350],showAtoms:true}];
  const result=await page.evaluate(groups=>window.adapter.showAnnotation(groups),groups);
  assert.equal(result.atomCount,3);
  assert.deepEqual(await settledCamera(),original,`${backend}: condition highlighting must preserve the camera`);
  if(backend==='molstar') {
   const context=await page.evaluate(()=>{
    const plugin=window.adapter.viewer.plugin;
    const component=plugin.state.data.cells.get(window.adapter.annotationComponent);
    const ref=plugin.managers.structure.hierarchy.current.structures[0].components.find(c=>c.cell.transform.ref===component.transform.ref);
    return {atoms:component.obj.data.elementCount,overpaint:ref.representations.map(r=>r.cell.obj.data.repr.state.overpaint.layers.length)};
   });
   assert.ok(context.atoms>3 && context.atoms<100,'sticks cover local residues, not the entire protein');
   assert.ok(context.overpaint.some(count=>count>0),'affected atoms are colored on the temporary sticks');
  }
  await page.screenshot({path:`artifacts/local/annotation-camera/${backend}-highlight.png`});
  await page.evaluate(()=>window.adapter.showAnnotation([{label:'Other site',atomIndices:[200],showAtoms:true}]));
  assert.deepEqual(await settledCamera(),original,`${backend}: switching conditions must preserve the camera`);
  await page.evaluate(()=>window.adapter.clearAnnotation());
  assert.deepEqual(await settledCamera(),original,`${backend}: clearing conditions must preserve the camera`);
  if(backend==='molstar') assert.equal(await page.evaluate(()=>window.adapter.annotationComponent),undefined);
  // Representation changes must not incorporate transient condition sticks into permanent styling.
  await page.evaluate(async groups=>{
   await window.adapter.showAnnotation(groups);
   await window.adapter.setRepresentation('lines','all','show');
   await window.adapter.clearAnnotation();
  },groups);
  if(backend==='molstar') {
   const labels=await page.evaluate(()=>window.adapter.viewer.plugin.managers.structure.hierarchy.current.structures[0].components.map(c=>c.cell.obj.label));
   assert.ok(labels.includes('line'));
   assert.ok(!labels.includes('Condition sites'));
  }
  assert.deepEqual(await settledCamera(),original,`${backend}: styling during an overlay must preserve the camera`);
  await page.evaluate(cif=>window.adapter.loadCif(cif,'enzyme'),enzyme);
  const enzymeCamera=await settledCamera();
  // Atoms 72 and 85 are the `UNK` placeholders carrying `nan` coordinates in enzyme_design.cif; every other index
  // here is positioned. The indices matter: picking four positioned atoms would assert nothing about the filter.
  const positioned=await page.evaluate(()=>window.adapter.showAnnotation([{label:'Mixed coordinates',atomIndices:[0,1,72,85],showAtoms:true}]));
  assert.equal(positioned.atomCount,2,'only positioned atoms enter condition geometry');
  const missing=await page.evaluate(()=>window.adapter.showAnnotation([{label:'Missing coordinates',atomIndices:[72,85],showAtoms:true}]));
  assert.equal(missing.atomCount,0);
  assert.deepEqual(await settledCamera(),enzymeCamera,`${backend}: missing coordinates must not move the camera`);
  assert.deepEqual(errors,[]);
  await page.evaluate(()=>window.adapter.destroy());
  await page.close();
  console.log(`${backend}: multi-residue atom overlays, switching, clearing and styling preserve the camera`);
 }
} finally {await browser.close(); await server.close();}
