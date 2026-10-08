import {copyFile,unlink} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {designWorkflows} from './design-workflow-driver.mjs';
assert.ok(process.env.CDP_PORT,'Set CDP_PORT for an isolated VS Code test instance');
assert.ok(['patinae','molstar'].includes(process.env.VIEWER_MODE));
assert.ok(process.env.STUDIO_WORKFLOW_OUTPUT,'Use the fresh directory produced by test_backend_parity.py');
process.env.STUDIO_STRICT_RENDERER='1';
const base=(process.env.ANNOTATION_STUDIO_URL??'http://127.0.0.1:8000/').replace(/\/?$/, '/');
const browser=await chromium.connectOverCDP('http://127.0.0.1:'+process.env.CDP_PORT);
try {
 const page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes('workbench.html'));

 assert.ok(page, 'VS Code workbench is missing');
 await page.locator('.monaco-workbench').waitFor();
 await page.keyboard.press('F1');
 await page.locator('.quick-input-widget input').fill('>AtomWorks: Open Studio');
 const isStudio = frame => frame.url().startsWith(base) &&
   new URL(frame.url()).searchParams.get('viewer') === process.env.VIEWER_MODE;
 const frameReady = page.frames().find(isStudio) ?? page.waitForEvent('framenavigated', {
   predicate: isStudio,
   timeout: 30000,
 });
 const [frame] = await Promise.all([
   frameReady,
   page.locator('.quick-input-list .monaco-list-row').filter({hasText: 'AtomWorks: Open Studio'}).click(),
 ]);
 await frame.locator('#file-input').waitFor({state:'attached'});
 await frame.waitForFunction(()=>document.querySelector('#status')?.textContent.includes('Ready.'));
 assert.equal(await frame.locator('#viewer').getAttribute('data-backend'),process.env.VIEWER_MODE);
 const downloadDir=process.env.STUDIO_WORKFLOW_OUTPUT+'/downloads-'+process.env.VIEWER_MODE;
 const cdp=await browser.newBrowserCDPSession();
 await cdp.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloadDir,eventsEnabled:true});
 const completed=new Map();
 cdp.on('Browser.downloadProgress',event=>{if(event.state==='completed')completed.set(event.guid,event);});
 const started=[];
 cdp.on('Browser.downloadWillBegin',event=>started.push(event));
 async function saveDownload(download,dest){
  for(let i=0;i<100;i++){
   const event=started.find(e=>e.suggestedFilename===download.suggestedFilename()&&completed.has(e.guid));
   if(event){
    const path=downloadDir+'/'+event.suggestedFilename;
    await copyFile(path,dest); await unlink(path); started.splice(started.indexOf(event),1); return;
   }
   await page.waitForTimeout(100);
  }
  throw Error('VS Code download did not complete');
 }
 await designWorkflows({saveDownload,page,ui:frame,base,label:'vscode-'+process.env.VIEWER_MODE,output:process.env.STUDIO_WORKFLOW_OUTPUT});
 assert.equal(await frame.locator('#viewer').getAttribute('data-backend'),process.env.VIEWER_MODE);
 console.log('Strict VS Code renderer check: '+process.env.VIEWER_MODE+' stayed active for every workflow; no fallback.');
}finally{await browser.close();}
