import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium } from 'playwright';
import { normalizeProject } from '../model.mjs';
import { automationProject, mergeAutomationProject } from '../automation-model.mjs';
import { createStudio } from './support.mjs';

const folders = [{id:'root',name:'Release'},{id:'child',name:'Login',parentId:'root'},{id:'other',name:'Login'}];
test('folder parents survive workspace saves; invalid trees and sibling duplicates are rejected',()=>{
  const counter={nextTestNumber:1};
  const project=normalizeProject({name:'Folders',folders,tests:[{id:'case',name:'Sign in',folderId:'child',steps:[]}]},null,counter);
  assert.equal(project.folders[0].parentId,null);
  const saved=normalizeProject(mergeAutomationProject(automationProject(project),project),project,counter);
  assert.equal(saved.folders[1].parentId,'root');
  assert.equal(saved.tests[0].folderId,'child');
  for(const invalid of [
    [{id:'root',name:'A',parentId:'missing'}],
    [{id:'root',name:'A',parentId:'root'}],
    [{id:'root',name:'A',parentId:'child'},{id:'child',name:'B',parentId:'root'}],
    [...folders,{id:'duplicate',name:'login',parentId:'root'}]
  ])assert.throws(()=>normalizeProject({name:'Bad tree',folders:invalid,tests:[]},null,{nextTestNumber:1}),/parent folder|cycle|Duplicate/);
});

test('QA nested creation defaults to the folder and Automation Studio preserves the tree',{timeout:90000},async t=>{
  const storage=path.resolve('.test-output',`folders-${Date.now()}`);
  const studio=await createStudio({port:3811,storage});await studio.listen();
  const browser=await chromium.launch();t.after(async()=>{await browser.close();await studio.close();});
  const base='http://127.0.0.1:3811';
  const api=async(route,method='GET',body)=>{const response=await fetch(base+route,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});assert.ok(response.ok,await response.clone().text());return response.json();};
  let p=await api('/api/projects','POST',{name:'Folder browser',folders:[],tests:[]});
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`${base}/?projectId=${p.id}#cases`);
  async function addFolder(name,parentId=''){
    const scope=parentId?page.locator(`.qa-folder-branch[data-folder="${parentId}"] > .qa-folder-row`):page.locator('.folder-browser-head');
    await scope.locator('.folder-add > summary').click();
    await page.getByRole('button',{name:'Add File',exact:true}).click();
    assert.equal(await page.getByLabel('Parent folder',{exact:true}).inputValue(),parentId);
    await page.getByLabel('Folder name',{exact:true}).fill(name);
    await page.locator('#dialog-submit').click();await page.locator('#dialog').waitFor({state:'hidden'});
    p=(await api('/api/state')).projects.find(x=>x.id===p.id);
    return p.folders.find(f=>f.name===name&&(f.parentId||'')===parentId).id;
  }
  const root=await addFolder('Release'),child=await addFolder('Login',root),leaf=await addFolder('Errors',child);
  const leafRow=page.locator(`.qa-folder-branch[data-folder="${leaf}"] > .qa-folder-row`);
  await leafRow.locator('.folder-add > summary').click();
  await page.getByRole('button',{name:'Add Test Case',exact:true}).click();
  assert.equal(await page.getByLabel('Folder',{exact:true}).inputValue(),leaf);
  assert.equal(await page.getByLabel('Folder',{exact:true}).locator('option:checked').innerText(),'Release / Login / Errors');
  await page.getByLabel('Test case title').fill('Invalid password');
  await page.getByLabel('Action / instruction').fill('Submit an invalid password');
  await page.locator('#dialog-submit').click();await page.locator('#dialog').waitFor({state:'hidden'});
  await page.getByRole('heading',{name:'Invalid password',exact:true}).waitFor();
  assert.match(await page.locator('.meta-list').innerText(),/Release \/ Login \/ Errors/);
  p=(await api('/api/state')).projects.find(x=>x.id===p.id);const savedCase=p.tests[0];assert.equal(savedCase.folderId,leaf);
  await page.getByRole('link',{name:'Back to test cases',exact:true}).click();
  await page.getByRole('button',{name:'Create test case',exact:true}).click();assert.equal(await page.getByLabel('Folder',{exact:true}).inputValue(),leaf);await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await page.reload();
  const nested=page.locator(`.qa-folder-branch[data-folder="${root}"] .qa-folder-branch[data-folder="${child}"] .qa-folder-branch[data-folder="${leaf}"]`);
  await nested.getByRole('link',{name:/Invalid password/}).waitFor();
  for(const width of [1440,390]){await page.setViewportSize({width,height:1000});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`QA overflow at ${width}`);}
  await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:path.join(storage,'qa-folders.png'),fullPage:true});
  await nested.getByRole('link',{name:/Invalid password/}).click();
  await page.getByRole('link',{name:'Open in Automation Studio',exact:true}).click();
  await page.getByRole('heading',{name:'Test case requirements',exact:true}).waitFor();
  assert.equal(await page.locator('#explorer .tree-folder').count(),0);
  await page.locator('.tabs [data-view="cases"]').click();
  const autoLeaf=page.locator('.auto-cases-folders [data-folder="'+leaf+'"]');
  await autoLeaf.waitFor();assert.equal(await autoLeaf.getAttribute('title'),'Release / Login / Errors');
  await page.locator('#content [data-action="select-test"][data-id="'+savedCase.id+'"]').click();
  assert.equal(await page.getByLabel('Folder',{exact:true}).inputValue(),leaf);
  await page.getByLabel('Add to Test cases',{exact:true}).click();
  await page.getByRole('button',{name:'Add Test Case',exact:true}).click();
  assert.equal(await page.locator('#dialog').getByLabel('Folder',{exact:true}).inputValue(),leaf);
  await page.locator('#dialog').getByLabel('Name',{exact:true}).fill('Automation child case');await page.locator('#dialog-submit').click();await page.locator('#dialog').waitFor({state:'hidden'});
  await page.locator('#save-button').click();await page.getByText('Workspace saved',{exact:true}).waitFor();
  p=(await api('/api/state')).projects.find(x=>x.id===p.id);assert.equal(p.tests.find(x=>x.name==='Automation child case').folderId,leaf);assert.equal(p.folders.find(x=>x.id===leaf).parentId,child);
  await page.getByLabel('Add to Test cases',{exact:true}).click();
  await page.getByRole('button',{name:'Add File',exact:true}).click();
  assert.equal(await page.getByLabel('Parent folder',{exact:true}).inputValue(),leaf);
  await page.locator('#dialog').getByLabel('Name',{exact:true}).fill('Browser checks');
  await page.locator('#dialog-submit').click();await page.locator('#dialog').waitFor({state:'hidden'});
  await page.locator('#save-button').click();await page.getByText('Workspace saved',{exact:true}).waitFor();
  p=(await api('/api/state')).projects.find(x=>x.id===p.id);
  assert.equal(p.folders.find(x=>x.name==='Browser checks').parentId,leaf);
  await page.reload();await page.locator('.tabs [data-view="cases"]').click();await page.locator('.auto-cases-folders').waitFor();await page.screenshot({path:path.join(storage,'automation-folders.png'),fullPage:true});
  const label=page.locator('.auto-case-text strong').filter({hasText:'Invalid password'});
  assert.ok((await label.boundingBox()).width>60,'Nested test names remain readable');
  await page.goto(base+'/?projectId='+p.id+'#cases');
  await page.locator('.qa-folder-branch[data-folder="'+leaf+'"] .folder-select').filter({hasText:'Browser checks'}).waitFor();
  await page.locator('.qa-folder-row > .folder-select[data-id="'+root+'"]').click();
  assert.equal(await page.locator('#case-results tbody tr').count(),2);
  assert.deepEqual(errors,[]);
});