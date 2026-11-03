import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {chromium} from 'playwright';
import {createStudio} from './support.mjs';

test('QA requirements sync into an open automation editor without losing unsaved automation changes',{timeout:60000},async t=>{
 const studio=await createStudio({port:3369,storage:path.resolve('.test-output','requirements-sync-'+Date.now())});let browser;t.after(async()=>{await browser?.close();await studio.close();});await studio.listen();
 const base='http://127.0.0.1:3369',p=studio.store.projects[0];p.tests[0].qa.manualSteps=[];
 browser=await chromium.launch();const auto=await browser.newPage(),qa=await browser.newPage(),errors=[];auto.on('pageerror',e=>errors.push(e.message));qa.on('pageerror',e=>errors.push(e.message));
 await auto.goto(base+'/automation?projectId='+p.id);await auto.getByRole('heading',{name:'Test case requirements missing'}).waitFor();
 const href=await auto.getByRole('link',{name:'Add requirements in QA Studio'}).getAttribute('href');
 const value=auto.locator('[data-step="1"][data-key="value"]');await value.fill('UNSAVED_LOCAL_VALUE');
 await qa.goto(base+href);await qa.getByRole('button',{name:'Edit case',exact:true}).click();
 await qa.getByLabel('Description',{exact:true}).fill('Shared requirements from QA Studio');await qa.getByLabel('Action / instruction').first().fill('Open the shared application');await qa.getByLabel('Expected result',{exact:true}).first().fill('The application is visible');await qa.locator('#dialog-submit').click();await qa.locator('#dialog').waitFor({state:'hidden'});
 await auto.getByRole('heading',{name:'Test case requirements',exact:true}).waitFor();await auto.locator('.qa-context > summary').click();await auto.getByText('Shared requirements from QA Studio',{exact:true}).waitFor();assert.match(await auto.locator('.requirements-steps').innerText(),/Open the shared application/);assert.equal(await value.inputValue(),'UNSAVED_LOCAL_VALUE');assert.match(await auto.locator('#save-status').innerText(),/Unsaved changes/);
 await auto.locator('#save-button').click();await auto.waitForFunction(()=>document.querySelector('#save-status').textContent.includes('All changes saved'));
 let saved=(await(await fetch(base+'/api/state')).json()).projects.find(x=>x.id===p.id);assert.equal(saved.tests[0].steps[1].value,'UNSAVED_LOCAL_VALUE');assert.equal(saved.tests[0].qa.manualSteps[0].instruction,'Open the shared application');
 // A later QA-only change also updates a clean editor and keeps the accordion open.
 await qa.reload();await qa.getByRole('button',{name:'Edit case',exact:true}).click();await qa.getByLabel('Action / instruction').first().fill('Updated shared requirement');await qa.locator('#dialog-submit').click();await qa.locator('#dialog').waitFor({state:'hidden'});await auto.getByText('Updated shared requirement',{exact:true}).waitFor();assert.equal(await auto.locator('.qa-context').getAttribute('open'),'');// Unrelated remote edits must still prevent a stale automation save.
 await value.fill('SECOND_LOCAL_EDIT');
 const remote=(await(await fetch(base+'/api/state')).json()).projects.find(x=>x.id===p.id);
 remote.globalVariables.qa='Concurrent external value';remote.tests[0].qa.description='Requirements with concurrent changes';
 const response=await fetch(base+'/api/projects/'+p.id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(remote)});assert.equal(response.status,200);
 await auto.getByText('Requirements with concurrent changes',{exact:true}).waitFor();await auto.locator('#save-button').click();await auto.getByText(/This project changed in another tab/).waitFor();
 saved=(await(await fetch(base+'/api/state')).json()).projects.find(x=>x.id===p.id);assert.equal(saved.globalVariables.qa,'Concurrent external value');assert.equal(saved.tests[0].steps[1].value,'UNSAVED_LOCAL_VALUE');assert.equal(await value.inputValue(),'SECOND_LOCAL_EDIT');
 assert.deepEqual(errors,[]);
});
