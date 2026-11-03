import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { executeStep, executeRun, preflight } from '../runner.mjs';
import http from 'node:http';
import { normalizeProject, prepareRun, sampleProject } from '../model.mjs';
import { createStudio } from './support.mjs';
import { startRecording } from '../recorder.mjs';
import { createVault } from '../storage.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { launchBrowser } from '../browsers.mjs';
import { parseCsv } from '../datasets.mjs';

test('strict locators reject ambiguity and assertions wait for delayed text and values',async t=>{
  const browser=await chromium.launch();t.after(()=>browser.close());const page=await browser.newPage();
  await page.setContent('<button>Save</button><button>Save</button><output id="message">Pending</output><input id="value">');
  await assert.rejects(executeStep(page,{action:'click',locatorType:'text',target:'Save',value:''},{objects:[],timeoutMs:500}),/strict mode violation/);
  await page.evaluate(()=>{setTimeout(()=>{document.querySelector('output').textContent='Ready';document.querySelector('input').value='Loaded';},200);});
  await executeStep(page,{action:'text',locatorType:'id',target:'message',value:'Ready'},{objects:[],timeoutMs:1000});
  await executeStep(page,{action:'value',locatorType:'id',target:'value',value:'Loaded'},{objects:[],timeoutMs:1000});
});

test('dataset expansion, additional suites and readiness detect missing inputs',()=>{
  const raw=sampleProject(3100);raw.tests[0].inTestPlan=true;raw.suites.push({id:'regression',name:'Regression'});raw.tests[0].additionalSuiteIds=['regression'];raw.tests[0].dataRows=[{NAME:'A'},{NAME:'B'}];raw.tests[0].steps[1].valueMode='data';raw.tests[0].steps[1].value='NAME';
  const p=normalizeProject(raw,null,{nextTestNumber:1});const run=prepareRun(p,{suiteId:'regression'});
  assert.equal(run.tests.length,2);assert.notEqual(run.tests[0].id,run.tests[1].id);assert.equal(run.tests[1].dataRow.NAME,'B');assert.equal(preflight(p).ok,true);
  p.tests[0].steps[1].value='MISSING';assert.equal(preflight(p).ok,false);
});

test('CSV handles quoted commas, newlines and escaped quotes and rejects malformed rows',()=>{
  assert.deepEqual(parseCsv('NAME,NOTE\r\nAlex,"hello, world"\r\nJo,"line 1\nline ""2"""'),[{NAME:'Alex',NOTE:'hello, world'},{NAME:'Jo',NOTE:'line 1\nline "2"'}]);
  assert.throws(()=>parseCsv('A,A\n1,2'),/unique/);assert.throws(()=>parseCsv('A,B\n1'),/row 2/);assert.throws(()=>parseCsv('A\n"open'),/unclosed/);
});

test('editor exposes readiness, dataset/timeout options, step settings and backup controls', {timeout:60000},async t=>{
  const port=3236,storage=path.resolve('.test-output',`options-${Date.now()}`),studio=await createStudio({port,storage});studio.store.projects[0].tests.forEach(test=>test.inTestPlan=true);await studio.listen();
  const browser=await chromium.launch();t.after(async()=>{await browser.close();await studio.close();});const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/automation`);
  await page.getByRole('button',{name:'Test options',exact:true}).click();
  await page.getByLabel('Default project timeout (ms)').fill('2000');
  await page.getByLabel('Optional CSV dataset (overrides JSON)').fill('NAME\nAlex\nSam');
  await page.locator('#dialog-submit').click();await page.locator('#dialog').waitFor({state:'hidden'});
  assert.equal(studio.store.projects[0].timeoutMs,2000);assert.equal(studio.store.projects[0].tests[0].dataRows.length,2);
  await page.getByRole('button',{name:'Step 2 settings',exact:true}).click();await page.getByLabel('Timeout override (ms)').fill('3000');await page.locator('#dialog-submit').click();await page.locator('#dialog').waitFor({state:'hidden'});
  await page.getByRole('button',{name:'Check readiness',exact:true}).click();await page.getByText('Ready to run',{exact:true}).waitFor();await page.locator('#dialog-submit').click();
  await page.locator('[data-action="view"][data-view="settings"]').click();await page.getByRole('button',{name:'Create backup',exact:true}).click();await page.getByText(/Backup created:/).waitFor();
  assert.deepEqual(errors,[]);
});

test('revision conflicts, encrypted credentials, backups, cancellation and lock release', {timeout:60000}, async t=>{
  const port=3233,base=`http://127.0.0.1:${port}`,storage=path.resolve('.test-output',`reliability-${Date.now()}`);
  const studio=await createStudio({port,storage});studio.store.projects[0].tests.forEach(test=>test.inTestPlan=true);await studio.listen();t.after(()=>studio.close());
  await assert.rejects(createStudio({port:3239,storage}),/already open/);
  const api=async(route,method='GET',body)=>{const response=await fetch(base+route,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,data:await response.json()};};
  let p=(await api('/api/state')).data.projects[0];const stale=structuredClone(p);
  p.globalVariables.PASSWORD='top-secret-test';p.tests[0].steps=[{action:'wait',value:'60000'}];
  const saved=await api(`/api/projects/${p.id}`,'PUT',p);assert.equal(saved.status,200);p=saved.data;
  assert.equal((await api(`/api/projects/${p.id}`,'PUT',stale)).status,409);
  const disk=await readFile(path.join(storage,'data/studio.json'),'utf8');assert.ok(!disk.includes('top-secret-test'));assert.ok(disk.includes('$sealed'));
  const vault=await createVault(path.join(storage,'data'));assert.equal(vault.decode(JSON.parse(disk)).projects[0].globalVariables.PASSWORD,'top-secret-test');
  const backup=(await api('/api/backups','POST',{})).data.name;
  p.name='Changed name';p=(await api(`/api/projects/${p.id}`,'PUT',p)).data;
  assert.equal((await api('/api/backups/restore','POST',{name:backup})).status,200);
  p=(await api('/api/state')).data.projects[0];assert.equal(p.name,'Getting started');
  const started=await api('/api/runs','POST',{projectId:p.id,testId:p.tests[0].id});assert.equal(started.status,202);
  assert.equal((await api(`/api/runs/${started.data.id}/cancel`,'POST',{})).status,202);
  let state;for(let i=0;i<100;i++){state=(await api('/api/status')).data;if(!state.activeRun)break;await new Promise(r=>setTimeout(r,50));}
  assert.equal(state.activeRun,null);assert.equal(state.runs[0].status,'interrupted');
  assert.equal((await api('/api/backups/restore','POST',{name:'../studio.json'})).status,400);
});

test('recording captures frame paths, shadow DOM, distinct passwords and verification mode', {timeout:60000}, async t=>{
  const port=3234,storage=path.resolve('.test-output',`extended-recorder-${Date.now()}`);
  const studio=await createStudio({port,storage});studio.store.projects[0].tests.forEach(test=>test.inTestPlan=true);await studio.listen();t.after(()=>studio.close());
  const session=await startRecording(studio.store.projects[0],studio.store.projects[0].tests[0].id,`http://127.0.0.1:${port}/demo`,{headless:true});t.after(()=>session.stop());
  await session.page.route('**/extended',route=>route.fulfill({contentType:'text/html',body:'<input id="one" type="password"><input id="two" type="password"><div id="host"></div><iframe id="frame" srcdoc="<input id=inner>"></iframe><output id="out">Expected</output>'}));
  await session.page.goto(`http://127.0.0.1:${port}/extended`);
  // setContent keeps the document listeners installed by the navigation init script.
  await session.page.locator('#one').fill('secret-one');await session.page.locator('#two').fill('secret-two');
  await session.page.locator('#host').evaluate(el=>{el.attachShadow({mode:'open'}).innerHTML='<button id="shadow">Shadow</button>';});
  await session.page.locator('#host #shadow').click();
  await session.page.frameLocator('#frame').locator('#inner').fill('Frame input');
  await session.page.evaluate(()=>window.__studioRecorderMode='text');await session.page.locator('#out').click();
  await session.page.evaluate(()=>window.__studioRecord({action:'barrier'}));
  const steps=session.steps;
  assert.ok(steps.some(s=>s.value==='RECORDED_PASSWORD'));assert.ok(steps.some(s=>s.value==='RECORDED_PASSWORD_2'));
  assert.ok(steps.some(s=>s.target==='[id="host"] [id="shadow"]'));
  assert.deepEqual(steps.find(s=>s.value==='Frame input').framePath,['[id="frame"]']);
  assert.ok(steps.some(s=>s.action==='text'&&s.value==='Expected'));
  assert.ok(!JSON.stringify(steps).includes('secret-one'));
  const frameStep=steps.find(s=>s.value==='Frame input');
  await session.page.frameLocator('#frame').locator('#inner').fill('');
  await executeStep(session.page,frameStep,{objects:[]});
  assert.equal(await session.page.frameLocator('#frame').locator('#inner').inputValue(),'Frame input');
});

test('scheduled tests, CLI exit status, JSON/JUnit reports and trace artifacts', {timeout:60000},async t=>{
  const port=3235,base=`http://127.0.0.1:${port}`,storage=path.resolve('.test-output',`cli-${Date.now()}`);
  const studio=await createStudio({port,storage});studio.store.projects[0].tests.forEach(test=>test.inTestPlan=true);await studio.listen();t.after(()=>studio.close());
  const api=async(route,method='GET',body)=>{const r=await fetch(base+route,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});assert.ok(r.ok,await r.clone().text());return r.json();};
  const p=(await api('/api/state')).projects[0];
  const schedule=await api('/api/schedules','POST',{projectId:p.id,testId:p.tests[0].id,intervalMinutes:60});
  studio.store.schedules[0].nextRunAt=new Date(0).toISOString();await studio.tickSchedules();
  assert.ok(studio.store.schedules[0].lastRunId);
  for(let i=0;i<200&&(await api('/api/status')).activeRun;i++)await new Promise(r=>setTimeout(r,50));
  const count=studio.store.runs.length;await studio.tickSchedules();assert.equal(studio.store.runs.length,count);
  await api(`/api/schedules/${schedule.id}`,'DELETE');
  const report=path.join(storage,'results.json'),junitFile=path.join(storage,'results.xml');
  const {stdout}=await promisify(execFile)(process.execPath,['studio-cli.mjs','--url',base,'--project',p.id,'--test',p.tests[0].id,'--json',report,'--junit',junitFile],{timeout:30000,windowsHide:true});
  assert.equal(JSON.parse(stdout).status,'passed');assert.equal(JSON.parse(await readFile(report,'utf8')).status,'passed');assert.match(await readFile(junitFile,'utf8'),/<testsuite/);
  const run=await api('/api/runs','POST',{projectId:p.id,testId:p.tests[0].id,trace:true});let completed;
  for(let i=0;i<200;i++){completed=await api(`/api/runs/${run.id}`);if(completed.status!=='running')break;await new Promise(r=>setTimeout(r,50));}
  assert.equal(completed.status,'passed');assert.ok(completed.tests[0].trace);assert.equal((await fetch(base+'/artifacts/'+completed.tests[0].trace)).status,200);
});

for(const browserName of ['chrome','edge','firefox'])test(`${browserName} executes input and delayed assertions`,{timeout:30000},async t=>{
  let browser;try{browser=await launchBrowser(browserName);}catch(error){if(/not installed|not.*found/i.test(error.message)){t.skip(error.message);return;}throw error;}
  t.after(()=>browser.close());const page=await browser.newPage();await page.setContent('<input aria-label="Name"><output id="result"></output>');
  await executeStep(page,{action:'fill',locatorType:'label',target:'Name',value:'Cross browser'},{objects:[]});
  await page.evaluate(()=>setTimeout(()=>document.querySelector('output').textContent=document.querySelector('input').value,100));
  await executeStep(page,{action:'text',locatorType:'id',target:'result',value:'Cross browser'},{objects:[],timeoutMs:2000});
});

test('recorded popup interactions replay in the correct tab', {timeout:30000},async t=>{
  const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end('<a id="new" target="_blank" href="/popup">Open tab</a><input id="field"><output id="result"></output><button id="submit" onclick="document.querySelector(\'output\').textContent=document.querySelector(\'input\').value">Save</button>');});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const project=normalizeProject(sampleProject(server.address().port),null,{nextTestNumber:1});
  const session=await startRecording(project,project.tests[0].id,`http://127.0.0.1:${server.address().port}`,{headless:true});t.after(()=>session.stop());
  const popupPromise=session.context.waitForEvent('page');await session.page.locator('#new').click();const popup=await popupPromise;await popup.waitForLoadState();
  await popup.locator('#field').fill('Popup value');await popup.locator('#submit').click();
  await popup.evaluate(()=>window.__studioRecorderMode='text');await popup.locator('#result').click();
  await popup.evaluate(()=>window.__studioRecord({action:'barrier'}));
  assert.ok(session.steps.some(s=>s.pageIndex===1&&s.action==='text'));
  project.tests[0].steps=structuredClone(session.steps);await session.stop();
  const artifacts=path.resolve('.test-output',`popup-${Date.now()}`);await mkdir(artifacts,{recursive:true});
  project.tests[0].inTestPlan=true;const run=prepareRun(project);await executeRun(run,artifacts);assert.equal(run.status,'passed',run.tests[0].error);
});
