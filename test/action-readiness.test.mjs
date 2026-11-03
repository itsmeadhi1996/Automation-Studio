import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';
import {executeStep,executeRun,DebugSession} from '../runner.mjs';
import {normalizeSteps,normalizeProject,prepareRun} from '../model.mjs';
import {waitAfterAction} from '../page-readiness.mjs';

async function fixture(t){
 let submissions=0;
 const server=http.createServer((req,res)=>{
  if(req.url==='/work'){submissions++;return setTimeout(()=>res.end('Done'),800);}
  if(req.url==='/background')return;
  res.setHeader('Content-Type','text/html');
  if(req.url==='/done')return res.end('<h1>Destination ready</h1><button id="next">Next action</button>');
  if(req.url==='/middle')return res.end('<p>Redirecting</p><script>setTimeout(()=>location.href="/done",700)</script>');
  res.end(`<button id="submit">Submit</button><button id="timer">Delayed redirect</button><button id="spa">Update route</button><button id="plain">No redirect</button><script>
   window.clicks=0;
   document.querySelector('#submit').onclick=async()=>{window.clicks++;await fetch('/work',{method:'POST'});location.href='/done';};
   document.querySelector('#timer').onclick=()=>{window.clicks++;setTimeout(()=>location.href='/middle',900);};
   document.querySelector('#spa').onclick=async()=>{window.clicks++;await fetch('/work');history.pushState({},'', '/spa-done');document.body.innerHTML='<h1>SPA ready</h1>';};
   document.querySelector('#plain').onclick=()=>window.clicks++;
  </script>`);
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
 const url='http://127.0.0.1:'+server.address().port;
 const browser=await chromium.launch();t.after(()=>browser.close());
 const page=await browser.newPage();await page.goto(url);
 return {url,page,browser,submissions:()=>submissions};
}
const click=(target,extra={})=>({action:'click',locatorType:'id',target,value:'',...extra});

test('automatic waiting follows a slow action request and redirect without submitting twice',async t=>{
 const {page,url,submissions}=await fixture(t);
 await page.evaluate(()=>{void fetch('/background');});
 await executeStep(page,click('submit',{timeoutMs:3500}),{objects:[],timeoutMs:2000});
 assert.equal(page.url(),url+'/done');assert.equal(submissions(),1);
 await executeStep(page,{action:'heading',value:'Destination ready'},{objects:[]});
});

test('explicit redirect waiting follows delayed redirect chains to the configured destination',async t=>{
 const {page,url}=await fixture(t);
 await executeStep(page,click('timer',{waitAfter:'redirect',waitForUrl:'**/done',timeoutMs:4000}),{objects:[]});
 assert.equal(page.url(),url+'/done');
 assert.equal(await page.getByRole('heading').textContent(),'Destination ready');
});

test('automatic waiting supports SPA route changes after an asynchronous action',async t=>{
 const {page,url,submissions}=await fixture(t);
 await executeStep(page,click('spa'),{objects:[]});
 assert.equal(page.url(),url+'/spa-done');assert.equal(submissions(),1);
 assert.equal(await page.getByRole('heading').textContent(),'SPA ready');
});

test('missing redirects fail within the limit, listeners are removed, and actions never retry',async t=>{
 const {page}=await fixture(t),events=['request','requestfinished','requestfailed','response','framenavigated'];
 const before=events.map(name=>page.listenerCount(name));
 await assert.rejects(executeStep(page,click('plain',{waitAfter:'redirect',timeoutMs:1000}),{objects:[]}),/expected page redirect did not occur/);
 assert.equal(await page.evaluate(()=>window.clicks),1);
 assert.deepEqual(events.map(name=>page.listenerCount(name)),before);
 await assert.rejects(waitAfterAction(page,async()=>{throw new Error('Action failed');}),/Action failed/);
 assert.deepEqual(events.map(name=>page.listenerCount(name)),before);
 await executeStep(page,click('plain',{waitAfter:'none',timeoutMs:1000}),{objects:[]});
 assert.equal(await page.evaluate(()=>window.clicks),2);
});

test('run and debug wait before marking redirecting actions complete',{timeout:20000},async t=>{
 const {url,page,browser}=await fixture(t),artifacts=path.resolve('.test-output','redirect-'+Date.now());await mkdir(artifacts,{recursive:true});
 const project=normalizeProject({id:'redirect',name:'Redirect',tests:[{inTestPlan:true,id:'test',name:'Submit and redirect',steps:[{action:'navigate',value:url},click('submit'),{action:'heading',value:'Destination ready'}]}]},null,{nextTestNumber:1});
 const run=prepareRun(project,{testId:'test'});await executeRun(run,artifacts);
 assert.equal(run.status,'passed',JSON.stringify(run));
 const debugRun=prepareRun(project,{testId:'test'}),debug=new DebugSession(debugRun,browser,page.context(),page,artifacts);
 await debug.step();await debug.step();
 assert.equal(debug.summary().currentStep.status,'passed');assert.equal(page.url(),url+'/done');
 await debug.step();assert.equal(debug.summary().status,'passed');await debug.close();
});

test('redirect settings persist in test snapshots and reject invalid configuration',()=>{
 const steps=normalizeSteps([click('submit',{waitAfter:'redirect',waitForUrl:'**/done',timeoutMs:5000})]);
 assert.equal(steps[0].waitAfter,'redirect');assert.equal(steps[0].waitForUrl,'**/done');
 const project=normalizeProject({name:'Redirect',tests:[{inTestPlan:true,id:'test',name:'Redirect',steps}]},null,{nextTestNumber:1});
 assert.equal(prepareRun(project,{testId:'test'}).tests[0].steps[0].waitForUrl,'**/done');
 assert.throws(()=>normalizeSteps([click('submit',{waitAfter:'forever'})]),/automatic waiting/);
 assert.throws(()=>normalizeSteps([click('submit',{waitForUrl:'**/done'})]),/Expected destination/);
});

test('step settings save and reload redirect options in the automation editor',{timeout:15000},async t=>{
 const {createStudio}=await import('./support.mjs');
 const studio=await createStudio({port:3815,storage:path.resolve('.test-output','redirect-ui-'+Date.now())});await studio.listen();t.after(()=>studio.close());
 const browser=await chromium.launch();t.after(()=>browser.close());
 const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
 const base='http://127.0.0.1:3815';await page.goto(base+'/automation');
 await page.getByRole('button',{name:'Step 3 settings',exact:true}).click();
 await page.getByLabel('After action').selectOption('redirect');
 await page.getByLabel('Expected destination URL (optional)').fill('**/dashboard');
 await page.getByLabel('Timeout override (ms)').fill('20000');
 await page.locator('#dialog-submit').click();
 const saved=page.waitForResponse(response=>response.url().includes('/api/projects/')&&response.request().method()==='PUT');
 await page.locator('#save-button').click();assert.equal((await saved).ok(),true);
 await page.reload();await page.getByRole('button',{name:'Step 3 settings',exact:true}).click();
 assert.equal(await page.getByLabel('After action').inputValue(),'redirect');
 assert.equal(await page.getByLabel('Expected destination URL (optional)').inputValue(),'**/dashboard');
 assert.equal(await page.getByLabel('Timeout override (ms)').inputValue(),'20000');assert.deepEqual(errors,[]);
});

test('cancelling during redirect waiting stops promptly and removes listeners',async t=>{
 const {page}=await fixture(t),count=page.listenerCount('framenavigated');
 const pending=waitAfterAction(page,async()=>{}, {mode:'redirect',timeout:30000});
 const stopped=assert.rejects(pending,/Page closed/);await page.close();await stopped;
 assert.equal(page.listenerCount('framenavigated'),count);
});

test('automatic waiting includes an action API hosted on another origin',async t=>{
 const {page,url}=await fixture(t);
 await page.route('https://action-api.test/work',async route=>{
  await new Promise(resolve=>setTimeout(resolve,900));
  await route.fulfill({body:'Done',headers:{'Access-Control-Allow-Origin':'*'}});
 });
 await page.evaluate(()=>{document.querySelector('#submit').onclick=async()=>{await fetch('https://action-api.test/work');location.href='/done';};});
 await executeStep(page,click('submit',{timeoutMs:4000}),{objects:[]});
 assert.equal(page.url(),url+'/done');
});

test('a sensitive fill can redirect without looking for its old field on the destination',async t=>{
 const {page,url}=await fixture(t);
 await page.evaluate(()=>{
  const input=document.createElement('input');input.id='code';document.body.append(input);
  input.oninput=async()=>{await fetch('/work');location.href='/done';};
 });
 await executeStep(page,{action:'fill',locatorType:'id',target:'code',value:'123456',sensitive:true,timeoutMs:4000},{objects:[]});
 assert.equal(page.url(),url+'/done');
});
