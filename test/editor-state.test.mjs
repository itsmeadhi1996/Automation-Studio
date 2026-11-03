import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium } from 'playwright';
import { normalizeProject } from '../model.mjs';
import { automationProject, mergeAutomationProject } from '../automation-model.mjs';
import { createStudio } from './support.mjs';

test('requirements flag survives unrelated saves and mapped names until automation changes',()=>{
  const counter={nextTestNumber:1};
  let p=normalizeProject({name:'Requirements',tests:[{id:'case',name:'Case',qa:{manualSteps:[{id:'req',instruction:'Original requirement',expectedResult:'Original result'}]},steps:[{action:'wait',value:'0',qaRequirementId:'req'}]}]},null,counter);
  assert.equal(p.tests[0].automationNeedsUpdate,false);
  let input=structuredClone(p);input.tests[0].qa.owner='Someone';input.tests[0].qa.priority='high';
  p=normalizeProject(input,p,counter);assert.equal(p.tests[0].automationNeedsUpdate,false);
  input=structuredClone(p);input.tests[0].qa.manualSteps[0].instruction='Updated requirement';
  p=normalizeProject(input,p,counter);assert.equal(p.tests[0].automationNeedsUpdate,true);
  assert.equal(p.tests[0].steps[0].name,'Updated requirement');
  input=automationProject(structuredClone(p));input.tests[0].automationNeedsUpdate=false;input.tests[0].folderId=null;
  p=normalizeProject(mergeAutomationProject(input,p),p,counter);
  assert.equal(p.tests[0].automationNeedsUpdate,true,'no-op automation saves cannot clear the flag');
  input=automationProject(structuredClone(p));input.tests[0].steps[0].value='1';
  p=normalizeProject(mergeAutomationProject(input,p),p,counter);assert.equal(p.tests[0].automationNeedsUpdate,false);
  for(const field of ['description','preconditions','expectedResult']){
    input=structuredClone(p);input.tests[0].qa[field]='Changed '+field;
    p=normalizeProject(input,p,counter);assert.equal(p.tests[0].automationNeedsUpdate,true);
  }
  input=structuredClone(p);input.tests[0].steps=[];
  p=normalizeProject(input,p,counter);assert.equal(p.tests[0].automationNeedsUpdate,false);assert.equal(p.tests[0].steps.length,0);
});

test('debug controls lock immediately, stay locked across views and recover after close or failure',{timeout:60000},async t=>{
  const studio=await createStudio({port:3814,storage:path.resolve('.test-output','editor-state-'+Date.now())});studio.store.projects[0].tests.forEach(test=>test.inTestPlan=true);await studio.listen();
  const browser=await chromium.launch();t.after(async()=>{await browser.close();await studio.close();});
  const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  let active=null,starts=0,fail=false,release;
  const gate=new Promise(resolve=>release=resolve);
  await page.route('**/api/state?workspace=automation',async route=>{
    const headers={...route.request().headers()};delete headers['if-none-match'];
    const response=await route.fetch({headers});const body=await response.json();body.activeDebug=active;
    const responseHeaders={...response.headers()};delete responseHeaders.etag;delete responseHeaders['content-encoding'];delete responseHeaders['content-length'];
    await route.fulfill({response,headers:responseHeaders,json:body});
  });
  await page.route('**/api/status',async route=>{
    const headers={...route.request().headers()};delete headers['if-none-match'];
    const response=await route.fetch({headers});const body=await response.json();body.activeDebug=active;
    const responseHeaders={...response.headers()};delete responseHeaders.etag;delete responseHeaders['content-encoding'];delete responseHeaders['content-length'];
    await route.fulfill({response,headers:responseHeaders,json:body});
  });
  await page.route('**/api/debug',async route=>{
    starts++;await gate;
    if(fail)return route.fulfill({status:400,json:{error:'Debug startup failed'}});
    active={id:'debug-session',testName:'Debug case',projectId:studio.store.projects[0].id,browser:'chrome',stepIndex:0,stepCount:4,status:'running'};
    await route.fulfill({status:201,json:active});
  });
  await page.route('**/api/debug/debug-session/close',async route=>{active=null;await route.fulfill({json:{status:'interrupted'}});});
  await page.goto('http://127.0.0.1:3814/automation');
  const debug=page.locator('[data-action="debug-test"]'),stop=page.locator('#stop-debug-button');await debug.waitFor();
  assert.equal(await stop.isVisible(),false);
  await debug.click();
  assert.equal(await debug.isDisabled(),true);
  assert.equal(await stop.isVisible(),true);assert.equal(await stop.isDisabled(),true);
  assert.equal(await page.locator('#run-button').isDisabled(),true);
  await debug.dispatchEvent('click');
  release();await page.getByRole('heading',{name:'Debug case',exact:true}).waitFor();
  assert.equal(starts,1);assert.equal(await stop.isEnabled(),true);
  assert.equal(await stop.evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(182, 54, 54)');
  await page.locator('.tabs [data-view="editor"]').click();assert.equal(await debug.isDisabled(),true);
  await page.locator('#explorer [data-view="suites"]').click();assert.equal(await stop.isVisible(),true);
  await page.reload();await debug.waitFor();assert.equal(await debug.isDisabled(),true);assert.equal(await stop.isVisible(),true);
  await stop.click();await page.waitForFunction(()=>document.querySelector('#stop-debug-button').hidden);
  await page.locator('#explorer [data-view="cases"]').click();
  await page.locator('.tabs [data-view="editor"]').click();assert.equal(await debug.isEnabled(),true);assert.equal(await page.locator('#run-button').isEnabled(),true);
  fail=true;await debug.click();await page.getByText('Debug startup failed',{exact:true}).waitFor();
  assert.equal(await debug.isEnabled(),true);assert.equal(await stop.isVisible(),false);assert.equal(starts,2);
  // Closing the browser externally is reflected by polling too.
  fail=false;await debug.click();await page.getByRole('heading',{name:'Debug case',exact:true}).waitFor();
  active=null;await page.waitForFunction(()=>document.querySelector('#stop-debug-button').hidden);
  await page.locator('.tabs [data-view="editor"]').click();assert.equal(await debug.isEnabled(),true);
  assert.deepEqual(errors,[]);
});
