import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium} from 'playwright-core';
import { chromiumLaunchOptions } from '../../../scripts/browser.mjs';
import {designWorkflows} from './design-workflow-driver.mjs';
const mode=process.env.VIEWER_MODE;
assert.ok(['patinae','molstar'].includes(mode));
const base=process.env.ANNOTATION_STUDIO_URL??'http://127.0.0.1:8000/';
const browser=await chromium.launch(chromiumLaunchOptions());
const page=await browser.newPage({viewport:{width:1440,height:1000}});
const output=process.env.STUDIO_WORKFLOW_OUTPUT??'artifacts/workflows';
try{
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`${base}?viewer=${mode}`);
  await page.waitForFunction(()=>document.querySelector('#status')?.textContent.includes('Ready.'));
  await designWorkflows({page,base,label:mode,output});
  assert.deepEqual(errors,[]);
}catch(error){
  const status=await page.locator('#status').textContent().catch(()=>'(page unavailable)');
  console.error(status);
  await mkdir(output,{recursive:true});
  await writeFile(join(output,`${mode}-failure.txt`),`${error}\n${status}`);
  await page.screenshot({path:join(output,`${mode}-failure.png`)}).catch(()=>{});
  throw error;
}finally{await browser.close();}
