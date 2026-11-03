import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium } from 'playwright';
import { createStudio } from './support.mjs';

test('the case editor folder dropdown can add a folder and approval saves the case into it',{timeout:60000},async t=>{
  const port=3561,studio=await createStudio({port,storage:path.resolve('.test-output',`case-folder-create-${port}-${Date.now()}`),aiFetcher:async()=>assert.fail('No AI call expected'),requirementInspector:async()=>assert.fail('No inspection expected')});
  await studio.listen();t.after(()=>studio.close());const base=`http://127.0.0.1:${port}`;
  const api=async(route,method='GET',body)=>{const response=await fetch(base+route,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,data:await response.json()};};
  const project=studio.store.projects[0],root=`/api/projects/${project.id}/requirements`;
  const created=await api(root,'POST',{revision:project.revision,title:'Login roles',url:'https://example.test/login',description:'User can login by using different roles.',categories:['Positive']});assert.equal(created.status,201);
  const generated=await api(root+'/'+created.data.requirement.id+'/generate','POST',{revision:created.data.project.revision});assert.equal(generated.status,201);
  const candidate=generated.data.requirement.draftCases[0];
  const browser=await chromium.launch({channel:'chrome'});t.after(()=>browser.close());
  const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(base+'/#requirement/'+created.data.requirement.id);
  await page.locator('.requirement-cases tbody tr').filter({has:page.getByRole('link',{name:candidate.name,exact:true})}).getByRole('button',{name:'Approve',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Review and approve test case',exact:true});await dialog.waitFor();
  const folder=dialog.getByLabel('Folder',{exact:true}),name=dialog.getByLabel('New folder name',{exact:true});
  assert.ok((await folder.locator('option').allInnerTexts()).some(text=>text.includes('Add folder')));
  await folder.selectOption({label:'＋ Add folder…'});await name.waitFor();
  await dialog.getByRole('button',{name:'Cancel',exact:true}).first().click();await name.waitFor({state:'hidden'});assert.equal(await folder.inputValue(),'');
  await folder.selectOption({label:'＋ Add folder…'});await name.fill('Login');await name.press('Enter');await name.waitFor({state:'hidden'});
  const saved=studio.store.projects[0].folders.find(item=>item.name==='Login');assert.ok(saved);assert.equal(await folder.inputValue(),saved.id);
  await dialog.getByRole('button',{name:'Confirm approval',exact:true}).click();await dialog.waitFor({state:'hidden'});
  const approved=studio.store.projects[0].tests.find(item=>item.id===candidate.id);assert.ok(approved);assert.equal(approved.folderId,saved.id);
  assert.deepEqual(errors,[]);
});
