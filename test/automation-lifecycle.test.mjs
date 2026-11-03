import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium } from 'playwright';
import { createStudio } from './support.mjs';
import { automationProject, mergeAutomationProject, ensureAutomationCases } from '../automation-model.mjs';
import { normalizeProject, sampleProject } from '../model.mjs';

test('automation deletion preserves QA identity and recreates one empty mapping',()=>{
  const counter={nextTestNumber:1};
  const original=normalizeProject(sampleProject(3258),null,counter),qa=original.tests[0];
  const view=automationProject(original);
  const deleted=normalizeProject(mergeAutomationProject({...view,tests:[]},original),original,counter);
  assert.equal(deleted.tests.length,1);assert.equal(deleted.tests[0].id,qa.id);
  assert.equal(deleted.tests[0].tcNumber,qa.tcNumber);assert.equal(deleted.tests[0].automation,null);
  assert.deepEqual(deleted.tests[0].steps,[]);assert.equal(automationProject(deleted).tests.length,0);
  const handoff=ensureAutomationCases(deleted,{testId:qa.id},counter);
  assert.equal(handoff.created.length,1);assert.notEqual(handoff.testIds[0],qa.id);
  const mapped=automationProject(deleted).tests[0];
  assert.equal(mapped.qaCaseId,qa.id);assert.notEqual(mapped.tcNumber,qa.tcNumber);assert.deepEqual(mapped.steps,[]);
  assert.deepEqual(ensureAutomationCases(deleted,{testId:qa.id},counter).created,[]);
  assert.equal(automationProject(deleted).tests[0].id,mapped.id);
  assert.throws(()=>mergeAutomationProject(view,deleted),/deleted or replaced/);
  assert.throws(()=>ensureAutomationCases(deleted,{testId:'deleted-qa-case'},counter),/no longer exists/);
});

test('deleting in Automation Studio persists immediately; stale QA handoff opens a fresh empty case', {timeout:90000}, async t=>{
  const port=3258,base=`http://127.0.0.1:${port}`,storage=path.resolve('.test-output','automation-lifecycle-'+Date.now());
  let studio=await createStudio({port,storage});await studio.listen();
  let browser;t.after(async()=>{await browser?.close();await studio.close();});
  const api=async(route,method='GET',body)=>{const res=await fetch(base+route,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:res.status,data:await res.json()};};
  const original=structuredClone(studio.store.projects[0]),qa=original.tests[0];
  qa.inTestPlan=true;qa.qa.manualSteps=[{id:'req-name',instruction:'Enter a name and submit',expectedResult:'Welcome message appears'}];
  original.tests.push({...structuredClone(qa),id:'unrelated',name:'Unrelated executable case'});
  await api('/api/projects/'+original.id,'PUT',original);
  browser=await chromium.launch();const page=await browser.newPage(),qaPage=await browser.newPage();
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await qaPage.goto(base+`/?projectId=${original.id}#case/${qa.id}`);
  await page.goto(base+'/automation');
  const stale=(await api('/api/state?workspace=automation')).data.projects[0];
  page.once('dialog',dialog=>dialog.accept());
  await page.locator('[data-action="delete-test"]').click();
  await page.getByText('Automation case deleted. The QA Studio case and run history are preserved.').waitFor();
  let saved=(await api('/api/state')).data;
  assert.equal(saved.projects[0].tests.length,2);assert.ok(saved.projects[0].tests.some(test=>test.id===qa.id));
  assert.deepEqual(saved.projects[0].tests.find(test=>test.id===qa.id).qa.manualSteps,qa.qa.manualSteps);
  assert.deepEqual(saved.projects[0].tests.find(test=>test.id===qa.id).steps,[]);
  assert.equal((await api('/api/state?workspace=automation')).data.projects[0].tests.length,1);
  assert.equal((await api('/api/runs','POST',{projectId:original.id,testId:qa.id})).status,400);
  assert.equal((await api('/api/projects/'+original.id,'PUT',{...stale,workspace:'automation'})).status,409);
  await page.goto(base+`/automation?projectId=${original.id}&testId=${qa.id}&intent=execute`);
  await page.getByRole('heading',{name:'Your test workspace'}).waitFor();
  assert.equal((await api('/api/state')).data.runs.length,0);
  // The QA page was opened before deletion; the server must decide whether a mapping exists.
  await qaPage.getByRole('button',{name:'Run test case',exact:true}).click();
  await qaPage.getByRole('radio',{name:/Automation Studio/}).check();
  await qaPage.locator('#dialog-submit').click();await qaPage.waitForURL('**/automation?**');
  await qaPage.getByRole('heading',{name:'Test case requirements'}).waitFor();
  saved=(await api('/api/state')).data;
  const mapped=(await api('/api/state?workspace=automation')).data.projects[0].tests.find(test=>test.qaCaseId===qa.id);
  assert.notEqual(mapped.id,qa.id);assert.notEqual(mapped.tcNumber,qa.tcNumber);assert.equal(mapped.qaCaseId,qa.id);
  assert.deepEqual(mapped.steps,[]);assert.equal(saved.runs.length,0);
  if(!(await qaPage.locator('#workspace-menu').isVisible()))await qaPage.locator('#workspace-toggle').click();await qaPage.locator('#qa-return').click();await qaPage.waitForURL('**#case/'+qa.id);
  await qaPage.getByRole('heading',{name:qa.name,exact:true}).waitFor();
  const repeated=await api('/api/automation/handoff','POST',{projectId:original.id,testId:qa.id});
  assert.deepEqual(repeated.data.created,[]);assert.deepEqual(repeated.data.testIds,[mapped.id]);
  // Saving the fresh script updates its QA owner's row and never revives the old automation ID.
  const fresh=structuredClone(repeated.data.project);fresh.tests.find(test=>test.id===mapped.id).steps=qa.steps;
  const configured=await api('/api/projects/'+original.id,'PUT',{...fresh,workspace:'automation'});
  assert.equal(configured.status,200);assert.equal(configured.data.tests.find(test=>test.qaCaseId===qa.id).id,mapped.id);
  assert.equal((await api('/api/runs','POST',{projectId:original.id,testId:qa.id})).status,400);
  const run=await api('/api/runs','POST',{projectId:original.id,testId:mapped.id});assert.equal(run.status,202);
  for(let i=0;i<200;i++){saved=(await api('/api/state')).data;if(!saved.activeRun)break;await new Promise(r=>setTimeout(r,100));}
  assert.equal(saved.runs[0].status,'passed',JSON.stringify(saved.runs[0]));
  assert.equal(saved.runs[0].tests[0].qaCaseId,qa.id);
  assert.equal((await api('/api/runs?projectId='+original.id+'&testId='+qa.id)).data.runs.length,1);
  // Persisted links remain distinct after restart.
  await studio.close();studio=await createStudio({port,storage});await studio.listen();
  assert.equal((await api('/api/state?workspace=automation')).data.projects[0].tests.find(test=>test.qaCaseId===qa.id).id,mapped.id);
  const qaProject=(await api('/api/state')).data.projects[0];assert.equal(qaProject.tests.find(test=>test.id===qa.id).inTestPlan,true);
  qaProject.tests=qaProject.tests.filter(test=>test.id!==qa.id);
  assert.equal((await api('/api/projects/'+original.id,'PUT',qaProject)).status,200);
  assert.equal((await api('/api/automation/handoff','POST',{projectId:original.id,testId:qa.id})).status,400);
  assert.equal((await api('/api/runs','POST',{projectId:original.id,testId:mapped.id})).status,400);
  assert.equal((await api('/api/state')).data.runs.length,1);
  assert.deepEqual(errors,[]);
});
