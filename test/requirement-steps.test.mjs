import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { createStudio } from './support.mjs';

const description='Open the app with valid credentials, click Leave from the Dashboard button, verify the page is redirected to the Leaves page.';
async function fixture(t,port){
  const studio=await createStudio({port,storage:path.resolve('.test-output',`requirement-steps-${port}-${Date.now()}`),aiFetcher:async()=>assert.fail('Step generation must not call an AI service'),requirementInspector:async()=>assert.fail('Step generation must not open a browser')});
  await studio.listen();t.after(()=>studio.close());const base=`http://127.0.0.1:${port}`;
  const api=async(route,method='GET',body)=>{const response=await fetch(base+route,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,data:await response.json()};};
  const project=studio.store.projects[0],root=`/api/projects/${project.id}/requirements`;
  const created=await api(root,'POST',{revision:project.revision,title:'Leave navigation',moduleName:'Leaves',url:'https://example.test/login',description,categories:['Positive','Functional']});assert.equal(created.status,201);
  const route=root+'/'+created.data.requirement.id,generated=await api(route+'/generate','POST',{revision:created.data.project.revision});assert.equal(generated.status,201);
  const candidate=generated.data.requirement.draftCases.find(item=>item.qa.category==='Positive');
  return {studio,base,api,route,candidate,project:generated.data.project,requirement:generated.data.requirement};
}

test('selected-case step generation is a preview; saving and approval preserve its editable steps',async t=>{
  const f=await fixture(t,3532),endpoint=f.route+'/cases/'+f.candidate.id+'/generate-steps',counter=f.studio.store.nextTestNumber;
  const before=structuredClone(f.requirement),preview=await f.api(endpoint,'POST',{revision:f.project.revision});assert.equal(preview.status,200,JSON.stringify(preview.data));assert.equal(preview.data.steps.length,4);
  assert.deepEqual((await f.api(f.route)).data,before);assert.equal(f.studio.store.projects[0].revision,f.project.revision);assert.equal(f.studio.store.nextTestNumber,counter);
  const edited={...f.candidate,qa:{...f.candidate.qa,workflowDetails:description,assumptions:preview.data.assumptions,manualSteps:preview.data.steps.map(step=>({id:randomUUID(),...step}))}};edited.qa.manualSteps[2].instruction='On the Dashboard, click Leave and wait for navigation.';
  const saved=await f.api(f.route+'/drafts/'+f.candidate.id,'PUT',{...edited,revision:f.project.revision});assert.equal(saved.status,200);assert.equal(saved.data.project.tests.length,f.project.tests.length);assert.equal(saved.data.requirement.draftCases.find(item=>item.id===f.candidate.id).qa.manualSteps[2].instruction,edited.qa.manualSteps[2].instruction);
  for(const other of before.draftCases.filter(item=>item.id!==f.candidate.id)){
    const actual=saved.data.requirement.draftCases.find(item=>item.id===other.id),{updatedAt:expectedTime,...expectedQa}=other.qa,{updatedAt:actualTime,...actualQa}=actual.qa;
    assert.deepEqual({...actual,qa:actualQa},{...other,qa:expectedQa});
  }
  assert.equal((await f.api(endpoint,'POST',{revision:f.project.revision})).status,409);
  const approved=await f.api(f.route+'/approve','POST',{revision:saved.data.project.revision,draftIds:[f.candidate.id]});assert.equal(approved.status,200);const testCase=approved.data.project.tests.find(item=>item.id===f.candidate.id);assert.equal(testCase.qa.workflowDetails,description);assert.equal(testCase.qa.manualSteps[2].instruction,edited.qa.manualSteps[2].instruction);
  assert.equal((await f.api(endpoint,'POST',{revision:approved.data.project.revision})).status,200);
  const oversized=await f.api(endpoint,'POST',{revision:approved.data.project.revision,workflow:'x'.repeat(10001)});assert.equal(oversized.status,400);assert.match(oversized.data.userMessage,/Workflow details/);
  assert.equal((await f.api(f.route+'/cases/'+f.project.tests[0].id+'/generate-steps','POST',{revision:approved.data.project.revision})).status,404);
});

test('selecting a requirement case opens a popup with generated action steps, editable preview and approval',{timeout:60000},async t=>{
  const f=await fixture(t,3533),browser=await chromium.launch({channel:'chrome'});t.after(()=>browser.close());const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(f.base+'/#requirement/'+f.requirement.id);await page.getByRole('link',{name:f.candidate.name,exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Review test case',exact:true});await dialog.waitFor();assert.equal(await page.getByLabel('Test case title',{exact:true}).inputValue(),f.candidate.name);
  await page.getByLabel('Workflow details (optional)',{exact:true}).fill(description);await page.getByRole('button',{name:'Generate test steps',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#requirement-step-feedback')?.textContent.startsWith('4 steps generated.'));
  const instructions=await page.locator('#step-editors [data-instruction]').evaluateAll(nodes=>nodes.map(node=>node.value));
  assert.match(instructions[0],/Open the application.*example\.test/);assert.match(instructions[1],/Sign in with valid test credentials/);assert.match(instructions[2],/Dashboard, click Leave/);assert.match(instructions[3],/Leaves page is displayed/);
  assert.equal((await f.api(f.route)).data.draftCases.find(item=>item.id===f.candidate.id).qa.manualSteps.length,1);
  await page.locator('#step-editors [data-instruction]').nth(2).fill('On the Dashboard, click Leave and wait for navigation.');await page.getByRole('button',{name:'Save changes',exact:true}).click();await dialog.waitFor({state:'hidden'});
  const stored=(await f.api(f.route)).data;assert.equal(stored.draftCases.find(item=>item.id===f.candidate.id).qa.manualSteps.length,4);assert.equal(stored.testIds.length,0);
  await page.locator('.requirement-cases tbody tr').filter({has:page.getByRole('link',{name:f.candidate.name,exact:true})}).getByRole('button',{name:'Approve',exact:true}).click();
  const approvalDialog=page.getByRole('dialog',{name:'Review and approve test case',exact:true});await approvalDialog.waitFor();assert.equal(await approvalDialog.locator('[data-instruction]').count(),4);assert.equal((await f.api(f.route)).data.testIds.length,0);
  await approvalDialog.getByRole('button',{name:'Confirm approval',exact:true}).click();await approvalDialog.waitFor({state:'hidden'});await page.waitForFunction(()=>document.querySelector('#requirement-feedback')?.textContent.includes('1 test cases approved'));
  await page.getByRole('link',{name:f.candidate.name,exact:true}).click();await dialog.waitFor();assert.equal(await page.getByLabel('Workflow details (optional)',{exact:true}).inputValue(),description);await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await page.goto(f.base+'/#cases');await page.locator('#case-results .case-title').filter({hasText:f.candidate.name}).click();await page.getByRole('heading',{name:'Test steps',exact:true}).waitFor();assert.match(await page.locator('.detail-steps').innerText(),/Dashboard, click Leave and wait for navigation/);assert.deepEqual(errors,[]);
});

test('Approve opens a cancellable review and can generate, edit and approve detailed steps in one save',{timeout:60000},async t=>{
  const f=await fixture(t,3535),browser=await chromium.launch({channel:'chrome'});t.after(()=>browser.close());
  const page=await browser.newPage(),errors=[],writes=[];page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{if(request.url().startsWith(f.base+f.route)&&['POST','PUT'].includes(request.method()))writes.push(request.url());});
  await page.goto(f.base+'/#requirement/'+f.requirement.id);
  const approve=()=>page.locator('.requirement-cases tbody tr').filter({has:page.getByRole('link',{name:f.candidate.name,exact:true})}).getByRole('button',{name:'Approve',exact:true}).click();
  await approve();const dialog=page.getByRole('dialog',{name:'Review and approve test case',exact:true});await dialog.waitFor();
  assert.equal(await dialog.getByLabel('Test case title',{exact:true}).inputValue(),f.candidate.name);assert.equal(await dialog.getByLabel('Overall expected result',{exact:true}).inputValue(),f.candidate.qa.expectedResult);
  assert.match(await dialog.innerText(),/If detailed steps are missing, click Generate test steps/);assert.equal(writes.length,0);
  await dialog.getByRole('button',{name:'Generate test steps',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#requirement-step-feedback')?.textContent.startsWith('4 steps generated.'));
  await dialog.getByLabel('Test case title',{exact:true}).fill('Unsaved cancelled review');await dialog.getByRole('button',{name:'Cancel',exact:true}).click();await dialog.waitFor({state:'hidden'});
  assert.deepEqual((await f.api(f.route)).data,f.requirement);assert.equal(f.studio.store.projects[0].revision,f.project.revision);
  await approve();await dialog.waitFor();assert.equal(await dialog.locator('[data-instruction]').count(),1);
  await dialog.getByLabel('Workflow details (optional)',{exact:true}).fill(description);await dialog.getByRole('button',{name:'Generate test steps',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#requirement-step-feedback')?.textContent.includes('then confirm approval'));
  const instructions=await dialog.locator('[data-instruction]').evaluateAll(nodes=>nodes.map(node=>node.value));assert.equal(instructions.length,4);
  assert.match(instructions[0],/Open the application/);assert.match(instructions[1],/Sign in with valid test credentials/);assert.match(instructions[2],/Dashboard, click Leave/);assert.match(instructions[3],/Leaves page is displayed/);
  assert.ok((await dialog.locator('[data-expected]').evaluateAll(nodes=>nodes.map(node=>node.value))).every(Boolean));
  await dialog.getByLabel('Test case title',{exact:true}).fill('Reviewed Leave navigation');await dialog.locator('[data-instruction]').nth(2).fill('On the Dashboard, click Leave and wait for the Leaves page.');
  await dialog.locator('[data-expected]').nth(2).fill('The Leaves page opens without an error.');await dialog.getByLabel('Overall expected result',{exact:true}).fill('The signed-in user reaches the Leaves page.');
  assert.equal((await f.api(f.route)).data.testIds.length,0);const counter=f.studio.store.nextTestNumber;
  await dialog.getByRole('button',{name:'Confirm approval',exact:true}).click();await dialog.waitFor({state:'hidden'});
  const stored=f.studio.store.projects[0],requirement=(await f.api(f.route)).data,approved=stored.tests.find(item=>item.id===f.candidate.id);
  assert.equal(stored.revision,f.project.revision+1);assert.equal(stored.tests.length,f.project.tests.length+1);assert.equal(f.studio.store.nextTestNumber,counter+1);assert.deepEqual(requirement.testIds,[f.candidate.id]);assert.ok(!requirement.draftCases.some(item=>item.id===f.candidate.id));
  assert.equal(approved.name,'Reviewed Leave navigation');assert.equal(approved.qa.workflowDetails,description);assert.equal(approved.qa.manualSteps.length,4);assert.equal(approved.qa.manualSteps[2].expectedResult,'The Leaves page opens without an error.');assert.equal(approved.qa.expectedResult,'The signed-in user reaches the Leaves page.');
  assert.equal(writes.filter(url=>url.endsWith('/approve')).length,1);assert.equal(writes.filter(url=>url.includes('/drafts/')).length,0);
  await page.goto(f.base+'/#cases');await page.locator('#case-results .case-title').filter({hasText:approved.name}).click();await page.getByRole('heading',{name:'Test steps',exact:true}).waitFor();assert.match(await page.locator('.detail-steps').innerText(),/The Leaves page opens without an error/);assert.deepEqual(errors,[]);
});

test('stale approval keeps the review open and does not save edits or approve a draft',{timeout:60000},async t=>{
  const f=await fixture(t,3536),browser=await chromium.launch({channel:'chrome'});t.after(()=>browser.close());const page=await browser.newPage();
  await page.goto(f.base+'/#requirement-draft/'+f.requirement.id+'~'+f.candidate.id);await page.getByRole('button',{name:'Approve test case',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Review and approve test case',exact:true});await dialog.waitFor();await dialog.getByLabel('Test case title',{exact:true}).fill('Unsaved stale review');
  const changed=await f.api(f.route+'/drafts/'+f.candidate.id,'PUT',{revision:f.project.revision,...f.candidate,name:'Changed by another reviewer'});assert.equal(changed.status,200);
  await dialog.getByRole('button',{name:'Confirm approval',exact:true}).click();await dialog.getByRole('alert').filter({hasText:'Someone changed this project'}).waitFor();
  assert.equal(await dialog.getByLabel('Test case title',{exact:true}).inputValue(),'Unsaved stale review');const stored=(await f.api(f.route)).data;assert.equal(stored.testIds.length,0);assert.equal(stored.draftCases.find(item=>item.id===f.candidate.id).name,'Changed by another reviewer');assert.equal(f.studio.store.projects[0].revision,changed.data.project.revision);
});
