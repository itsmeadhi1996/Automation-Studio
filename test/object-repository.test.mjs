import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import http from 'node:http';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { createVault } from '../storage.mjs';
import { startRecording } from '../recorder.mjs';
import { createStudio } from './support.mjs';
import { launchBrowser } from '../browsers.mjs';
import { resolveTarget } from '../model.mjs';

const current=async base=>(await (await fetch(base+'/api/state')).json()).projects[0];
async function saveProject(base,p) {
  const response=await fetch(base+'/api/projects/'+p.id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(p)});
  const result=await response.json();assert.equal(response.ok,true,JSON.stringify(result));return result;
}
async function repository(page) {if(!(await page.locator('#workspace-menu').isVisible()))await page.locator('#workspace-toggle').click();await page.locator('[data-view="objects"]').click();}
async function saveUi(page) {await page.locator('#save-button').click();await page.waitForFunction(()=>document.querySelector('#save-status').textContent.includes('All changes saved'));}

test('case accordions isolate mappings, capture steps, hide replacements and survive rename/reload', {timeout:60000}, async t=>{
  const port=3297,base='http://127.0.0.1:'+port;
  const studio=await createStudio({port,storage:path.resolve('.test-output','repository-'+Date.now())});await studio.listen();
  const browser=await launchBrowser('chrome');t.after(async()=>{await browser.close();await studio.close();});
  let p=await current(base);p.tests[0].name='Login';p.tests[0].automation={id:'automation-login',tcNumber:99};p.tests[0].steps=[
    {action:'fill',name:'Username field',locatorType:'css',target:'[name="username"]',value:'Alex'},
    {action:'fill',name:'Password field',locatorType:'css',target:'[name="password"]',value:'secret'}];
  p.tests.push({id:'signup',name:'Signup',steps:[]},{id:'empty',name:'Empty case',steps:[]});p=await saveProject(base,p);
  const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));await page.goto(base+'/automation');
  await page.getByRole('button',{name:'Save step 1 locator to repository',exact:true}).click();
  await page.getByRole('button',{name:'Save step 2 locator to repository',exact:true}).click();
  assert.equal(await page.locator('[data-row="0"] [data-key="replacement"]').inputValue(),'username');
  assert.equal(await page.locator('[data-row="1"] [data-key="replacement"]').inputValue(),'password');
  await page.locator('[data-row="0"] [data-key="replacement"]').fill('another-user');await saveUi(page);
  p=await current(base);assert.equal(p.objects.length,1);assert.equal(p.tests[0].steps[1].replacement,'password');
  assert.equal(p.tests[0].steps[0].target,p.tests[0].steps[1].target);
  await repository(page);
  assert.equal(await page.locator('[data-repository-case]').count(),3);
  const login=page.locator('[data-repository-case="welcome"]');await login.locator('summary').click();
  assert.match(await login.locator('summary').textContent(),/Login.*1 object/);
  assert.equal(await login.locator('tbody tr').count(),1);
  assert.equal(await login.locator('tbody tr td').first().textContent(),'genericCSSNameOnly');
  assert.deepEqual(await login.locator('th').allTextContents(),['Element name','Locator type','Locator template','Actions']);
  assert.equal(await login.getByText('password',{exact:true}).count(),0);
  const empty=page.locator('[data-repository-case="empty"]');await empty.locator('summary').click();assert.equal(await empty.locator('p').textContent(),'No objects mapped to this test case.');
  await login.getByRole('button',{name:'Edit',exact:true}).click();
  assert.equal(await page.locator('#dialog [name="replacement"]').count(),0);
  assert.equal(await page.locator('#dialog [name="container"]').count(),0);
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  async function add(owner,selector) {
    await page.getByRole('button',{name:'Add object',exact:false}).click();
    await page.getByLabel('Test case',{exact:true}).selectOption(owner);
    await page.locator('#dialog [name=locatorType]').selectOption('css');
    await page.getByLabel('Locator template',{exact:true}).fill(selector);
    assert.equal(await page.getByLabel('Element name',{exact:true}).inputValue(),'genericCSSNameOnly');
    await page.locator('#dialog-submit').click();await page.locator('#dialog').waitFor({state:'hidden'});
  }
  await add('welcome','[name="password"]');await add('signup','[name="username"]');await add('signup','[name="password"]');await saveUi(page);
  p=await current(base);assert.equal(p.objects.length,2);assert.equal(p.locatorTemplates.length,1);
  assert.notEqual(p.objects[0].id,p.objects[1].id);
  const signup=page.locator('[data-repository-case="signup"]');await signup.locator('summary').click();
  assert.equal(await signup.locator('tbody tr').count(),1);assert.equal(await login.locator('tbody tr').count(),1);
  await signup.getByRole('button',{name:'Edit',exact:true}).click();await page.getByLabel('Locator template',{exact:true}).fill('[id="XXX"]');await page.locator('#dialog-submit').click();
  assert.equal(await signup.locator('tbody tr td').first().textContent(),'genericCSSIdOnly');
  assert.equal(await login.locator('tbody tr td').first().textContent(),'genericCSSNameOnly');
  page.once('dialog',dialog=>dialog.accept());await signup.getByRole('button',{name:'Remove',exact:true}).click();
  assert.equal(await login.locator('tbody tr').count(),1);
  await page.locator('#explorer [data-view="cases"]').click();
  await page.locator('.tabs [data-view="editor"]').click();await page.getByLabel('Test name',{exact:true}).fill('Renamed Login');await saveUi(page);
  await page.reload();assert.equal(await page.locator('[data-row="0"] [data-key="replacement"]').inputValue(),'another-user');
  assert.equal(await page.locator('[data-row="1"] [data-key="replacement"]').inputValue(),'password');
  await repository(page);assert.match(await page.locator('[data-repository-case="welcome"] summary').textContent(),/Renamed Login.*1 object/);
  await page.goto(base+'/automation?testId=missing');await repository(page);await page.getByRole('button',{name:'Add object',exact:false}).click();
  assert.equal(await page.getByLabel('Test case',{exact:true}).inputValue(),'');
  assert.equal(await page.getByLabel('Test case',{exact:true}).evaluate(el=>el.checkValidity()),false);
  assert.deepEqual(errors,[]);
});

test('startup migration preserves persisted tests, ownership, parameters and reports through reload', {timeout:60000}, async t=>{
  const site=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end('<input name="username"><input name="password">');});
  await new Promise(resolve=>site.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+site.address().port;
  const port=3298,base='http://127.0.0.1:'+port,storage=path.resolve('.test-output','repository-migration-'+Date.now());
  let studio=await createStudio({port,storage});await studio.listen();let p=await current(base);await studio.close();
  const vault=await createVault(path.join(storage,'data')),file=path.join(storage,'data','studio.json'),store=vault.decode(JSON.parse(await readFile(file,'utf8')));
  p.objects=[{id:'old-user',name:'Username field',locatorType:'css',selector:'[name="username"]'},
    {id:'old-pass',name:'Password field',locatorType:'css',selector:'[name="password"]'},
    {id:'orphan',name:'Needs review',xpath:'//button'}];
  p.tests[0].inTestPlan=true;p.tests[0].steps=[{action:'navigate',value:url},
    {action:'fill',locatorType:'object',target:'old-user',value:'Alex'},
    {action:'fill',locatorType:'object',target:'old-pass',value:'secret'}];
  p.tests.push({id:'other',name:'Other case',tcNumber:2,inTestPlan:true,steps:[{action:'navigate',value:url},{action:'fill',locatorType:'object',target:'old-user',value:'Sam'}]});
  store.projects[0]=p;await writeFile(file,JSON.stringify(vault.encode(store)));
  studio=await createStudio({port,storage});await studio.listen();
  const browser=await launchBrowser('chrome');t.after(async()=>{await browser.close();await studio.close();await new Promise(resolve=>site.close(resolve));});
  p=await current(base);assert.equal(p.objects.length,2);assert.equal(p.locatorTemplates.length,1);assert.equal(p.repositoryLegacyObjects.length,1);
  const backups=(await readdir(path.join(storage,'data'))).filter(name=>name.startsWith('backup-'));
  assert.equal(backups.length,1);
  const recovery=vault.decode(JSON.parse(await readFile(path.join(storage,'data',backups[0]),'utf8')));
  assert.equal(recovery.projects[0].objects[0].id,'old-user');assert.equal(recovery.projects[0].objects[0].testCaseId,undefined);
  assert.equal(p.tests[0].steps[1].target,p.tests[0].steps[2].target);assert.notEqual(p.tests[0].steps[1].target,p.tests[1].steps[1].target);
  assert.equal(resolveTarget(p.tests[0].steps[2],p.objects,p.locatorTemplates),'[name="password"]');
  const page=await browser.newPage();await page.goto(base+'/automation');await repository(page);
  assert.match(await page.locator('#content [role="status"]').textContent(),/Needs review.*No test-case reference/);
  const objects=structuredClone(p.objects);p=await saveProject(base,p);await page.reload();await repository(page);
  assert.deepEqual((await current(base)).objects,objects);
  const response=await fetch(base+'/api/runs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({projectId:p.id})});assert.equal(response.status,202,await response.text());
  let status;for(let i=0;i<200;i++){status=await (await fetch(base+'/api/status')).json();if(!status.activeRun)break;await new Promise(resolve=>setTimeout(resolve,100));}
  assert.equal(status.runs[0].status,'passed',JSON.stringify(status.runs[0]));assert.equal(status.runs[0].tests.length,2);
  const saved=await current(base);await studio.close();studio=await createStudio({port,storage});await studio.listen();
  const reopened=await current(base);assert.deepEqual(reopened.objects,saved.objects);assert.deepEqual(reopened.tests,saved.tests);assert.equal(reopened.revision,saved.revision);
});

test('repeated web recording imports share field templates and execute with separate password data', {timeout:60000}, async t=>{
  const site=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end('<title>Login</title><label>Username field<input name="username"></label><label>Password field<input name="password" type="password"></label>');});
  await new Promise(resolve=>site.listen(0,'127.0.0.1',resolve));
  const url='http://127.0.0.1:'+site.address().port;
  const port=3299,base='http://127.0.0.1:'+port;let session;
  const studio=await createStudio({port,storage:path.resolve('.test-output','repository-recording-'+Date.now()),recordingLauncher:async(...args)=>{
    session=await startRecording(args[0],args[1],args[2],{...args[3],headless:true});return session;
  }});
  studio.store.projects[0].tests[0].inTestPlan=true;
  studio.store.projects[0].environments[0].variables.RECORDED_PASSWORD='execution-password';
  await studio.listen();const browser=await launchBrowser('chrome');
  t.after(async()=>{await browser.close();await studio.close();await new Promise(resolve=>site.close(resolve));});
  const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));await page.goto(base+'/automation');
  for(const mode of ['Replace test steps','Append to test']) {
    await page.getByRole('button',{name:'Record Web',exact:true}).click();
    await page.getByLabel('Starting URL',{exact:true}).fill(url);
    await page.getByRole('button',{name:'Start recording',exact:true}).click();
    await page.getByRole('button',{name:'Stop and review',exact:true}).waitFor();
    await session.page.getByLabel('Username field').fill('Alex');
    await session.page.getByLabel('Password field').fill('never-store-recorded-password');
    await session.page.evaluate(()=>window.__studioRecord({action:'barrier'}));
    await page.getByRole('button',{name:'Stop and review',exact:true}).click();
    await page.getByRole('button',{name:mode,exact:true}).click();
    await page.getByRole('button',{name:'Record Web',exact:true}).waitFor();
  }
  const p=(await (await fetch(base+'/api/state')).json()).projects[0];
  assert.equal(p.objects.length,1);assert.equal(p.locatorTemplates.length,1);
  assert.equal(p.locatorTemplates[0].selector,'[name="XXX"]');
  assert.equal(p.tests[0].steps.length,6);
  const password=p.objects.find(o=>o.name==='genericCSSNameOnly');
  const passwordSteps=p.tests[0].steps.filter(s=>s.target===password.id&&s.replacement==='password');
  assert.equal(passwordSteps.length,2);
  assert.ok(passwordSteps.every(s=>s.replacement==='password'&&s.value==='RECORDED_PASSWORD'&&s.valueMode==='environment'));
  assert.ok(!JSON.stringify(p).includes('never-store-recorded-password'));
  const started=await fetch(base+'/api/runs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({projectId:p.id,testId:p.tests[0].id})});
  assert.equal(started.status,202,await started.text());
  let state;
  for(let i=0;i<150;i++){state=await (await fetch(base+'/api/status')).json();if(!state.activeRun)break;await new Promise(resolve=>setTimeout(resolve,100));}
  assert.equal(state.runs[0].status,'passed',JSON.stringify(state.runs[0]));
  assert.deepEqual(errors,[]);
});
