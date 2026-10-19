import assert from 'node:assert/strict';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';

export async function designWorkflows({page, ui=page, base, label, output, saveDownload=(download,path)=>download.saveAs(path), request=page.request, onLoaded=async()=>{}}) {
  const cases=process.env.STUDIO_RECONSTRUCTION
    ? JSON.parse(await readFile(process.env.STUDIO_RECONSTRUCTION,'utf8'))
    : JSON.parse(await readFile(fileURLToPath(new URL('../../../tests/fixtures/workflow_cases.json',import.meta.url)),'utf8'));
  if(!process.env.STUDIO_RECONSTRUCTION) cases.push(...JSON.parse(await readFile(fileURLToPath(new URL('../../../tests/fixtures/nim_workflow_cases.json',import.meta.url)),'utf8')));
  await mkdir(output,{recursive:true});
  const logs=[];
  const expectedRenderer=label.endsWith('patinae')?'patinae':'molstar';
  const strict=process.env.STUDIO_STRICT_RENDERER==='1';
  await ui.evaluate(()=>{
    window.workflowRenderers=[document.querySelector('#viewer').dataset.backend];
    window.workflowRendererObserver?.disconnect();
    window.workflowRendererObserver=new MutationObserver(records=>{
      for(const record of records)window.workflowRenderers.push(record.oldValue);
      window.workflowRenderers.push(document.querySelector('#viewer').dataset.backend);
    });
    window.workflowRendererObserver.observe(document.querySelector('#viewer'),{
      attributes:true,attributeFilter:['data-backend'],attributeOldValue:true,
    });
  });
  async function rendererCheck(){
    const actual=await ui.locator('#viewer').getAttribute('data-backend');
    if(strict){
      assert.equal(actual,expectedRenderer,'Requested renderer must stay active');
      const observed=await ui.evaluate(()=>window.workflowRenderers);
      assert.ok(observed.every(value=>value===expectedRenderer),`Renderer changed: ${observed}`);
    }
    return actual;
  }
  await rendererCheck();
  async function settled(){await ui.waitForFunction(()=>!document.querySelector('#viewer-mode').disabled && !document.querySelector('#download').disabled);}
  async function post(button, endpoint){
    const pending=page.waitForResponse(r=>new URL(r.url()).pathname.endsWith(endpoint)&&r.request().method()==='POST');
    await ui.locator(button).click();
    const response=await pending;
    assert.equal(response.status(),200,await response.text());
    await settled();
    return response.json();
  }
  async function select(query){
    await ui.locator('#selection-syntax').selectOption('expression');
    await ui.locator('#viewer-command').fill(query);
    const response=page.waitForResponse(r=>r.url().endsWith('/selections/query'));
    await ui.locator('#run-viewer-command').click();
    const resolved=await response;
    assert.equal(resolved.status(),200,await resolved.text());
    const selected=await resolved.json();
    assert.ok(selected.count>0,query);
    await ui.waitForFunction(count=>document.querySelector('#selection-count').textContent.startsWith(`${count} atom`),selected.count);
    return selected;
  }
  for(const scenario of cases){
    const loaded=page.waitForResponse(r=>r.url().endsWith('/sessions')&&r.request().method()==='POST');
    if(scenario.example_id){
      await ui.locator('#editor-tab-main').click();
      await ui.locator('#examples-panel').evaluate(panel=>{panel.open=true});
      await ui.locator(`[data-example="${scenario.example_id}"]`).click();
    } else await ui.locator('#file-input').setInputFiles(scenario.source ?? fileURLToPath(new URL('../../../examples/'+scenario.file,import.meta.url)));
    const session=await (await loaded).json();
    assert.equal(session.structure.atom_count,scenario.atoms);
    await settled();
    await onLoaded(scenario);
    const endpoint=`${base}api/v1/sessions/${session.session_id}`;
    async function snapshot(stage){
      const response=await request.get(endpoint+'/cif');
      assert.equal(response.status(),200);
      await writeFile(join(output,`${label}-${scenario.name}-${stage}.cif`),await response.body());
    }
    await snapshot('00');
    for(const [i,action] of scenario.actions.entries()){
      let result;
      let indices=[];
      if(['condition','internal','group','pair'].includes(action.kind)){
        await ui.locator('#editor-tab-annotations').click();
        await ui.locator('#condition').selectOption(action.key??'distance');
        const selected=await select(action.query);
        indices=selected.atom_indices;
        if(['condition','internal'].includes(action.kind)){
          if (action.key === 'index') {
            result=await post(action.enabled ? '#unindex-selection' : '#restore-indexing','/conditions');
          } else {
            await ui.locator('#enabled').setChecked(action.enabled);
            if(action.value!==undefined) await ui.locator('#condition-value-input').selectOption(String(action.value));
            result=await post('#apply-condition',action.kind==='internal'?'/internal-coords':'/conditions');
          }
        }else if(action.kind==='group')result=await post('#group-new','/groups');
        else{
          assert.equal(selected.count,2);
          await ui.locator('#pair-use-selection').click();
          await ui.locator('#pair-distance').fill(String(action.value));
          await ui.locator('#pair-add').click();
          result=await post('#pair-apply','/distance-restraints/replace');
        }
      }else if(action.kind==='charge'){
        await ui.locator('#editor-tab-structure').click();
        indices=(await select(action.query)).atom_indices;
        await ui.locator('#charge').fill(String(action.value));
        result=await post('#apply-charge','/charges');
      }else if(action.kind==='delete'){
        await ui.locator('#editor-tab-main').click();
        await ui.getByText('Structure editing',{exact:true}).evaluate(el=>el.parentElement.open=true);
        indices=(await select(action.query)).atom_indices;
        result=await post('#delete-atoms','/delete');
      }else if(action.kind==='segment'){
        await ui.locator('#editor-tab-main').click();
        await ui.getByText('Expandable segments',{exact:true}).evaluate(el=>el.parentElement.open=true);
        await ui.locator('#segment-min').fill(String(action.minimum));
        await ui.locator('#segment-max').fill(String(action.maximum));
        if(action.chain){
          await ui.locator('#segment-new-chain').check();
          await ui.locator('#segment-chain-id').fill(action.chain);
        }else{
          await ui.locator('#segment-new-chain').uncheck();
          await ui.locator('#segment-before').setChecked(action.before);
          indices=(await select(action.query)).atom_indices;
        }
        result=await post('#insert-segment','/segments');
      }else if(action.kind==='undo')result=await post('#undo','/undo');
      await snapshot(String(i+1).padStart(2,'0'));
      logs.push({scenario:scenario.name,step:i+1,action:action.kind,indices,
        atoms:result.structure.atom_count,renderer:await rendererCheck()});
    }
    await ui.locator('#editor-tab-annotations').click();
    await ui.locator('#condition').selectOption(scenario.name==='ppi'?'hotspot':'rasa');
    const download=page.waitForEvent('download');
    const checked=page.waitForResponse(r=>r.url().endsWith('/export'));
    await ui.locator('#download').click();
    if((await (await checked).json()).issues.length)await ui.locator('dialog.confirmation button[value="confirm"]').click();
    await saveDownload(await download,join(output,`${label}-${scenario.name}-saved.cif`));
    const reopenedResponse=page.waitForResponse(r=>r.url().endsWith('/sessions')&&r.request().method()==='POST');
    await ui.locator('#file-input').setInputFiles(join(output,`${label}-${scenario.name}-saved.cif`));
    const reopened=await (await reopenedResponse).json();
    await settled();
    const reopenedCif=await request.get(`${base}api/v1/sessions/${reopened.session_id}/cif`);
    assert.equal(reopenedCif.status(),200);
    await writeFile(join(output,`${label}-${scenario.name}-reopened.cif`),await reopenedCif.body());
    await rendererCheck();
    await page.screenshot({path:join(output,`${label}-${scenario.name}.png`)});
    console.log(`${label} (${await ui.locator('#viewer').getAttribute('data-backend')}): ${scenario.name} edits, restraint/group, segment expansion, Undo and Save passed`);
  }
  await rendererCheck();
  await writeFile(join(output,`${label}-actions.json`),JSON.stringify(logs,null,2));
  await writeFile(join(output,`${label}-renderers.json`),JSON.stringify({
    strict,requested:expectedRenderer,observed:await ui.evaluate(()=>window.workflowRenderers),
  }));
}
