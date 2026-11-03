import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createStudio } from './support.mjs';
import { generateTestCases } from '../test-case-generator.mjs';

const requirement={title:'Account registration',url:'https://example.test/register',description:'Email is required. Password must have 8 to 64 characters.',moduleName:'Accounts',pageMetadata:{fields:[{name:'Email',type:'email',constraints:{required:true}},{name:'Password',type:'password',constraints:{minLength:8,maxLength:64}}],controls:[{name:'Register',type:'submit'}]},categories:['Positive','Negative','Validation','Boundary','Security']};
async function fixture(t,port,options={}){
  const studio=await createStudio({port,storage:path.resolve('.test-output',`rule-app-${port}-${Date.now()}`),aiFetcher:async()=>{assert.fail('Local generation called AI');},requirementInspector:async()=>{assert.fail('Local generation launched inspection without opt-in');},...options});
  await studio.listen();t.after(()=>studio.close());
  const base=`http://127.0.0.1:${port}`;
  const api=async(route,method='GET',body)=>{const r=await fetch(base+route,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json()};};
  return {studio,base,api,project:studio.store.projects[0]};
}

test('app uses the shared local service without AI or inspection and preserves generated metadata and edits',async t=>{
  const f=await fixture(t,3520),root=`/api/projects/${f.project.id}/requirements`;
  const invalid=await f.api(root,'POST',{...requirement,pageMetadata:{fields:[{name:'Age',constraints:{min:20,max:10}}]},revision:f.project.revision});
  assert.equal(invalid.status,400);assert.match(invalid.data.error,/Invalid generation input/);
  assert.match(invalid.data.userMessage,/smallest allowed value is higher than the largest/);assert.doesNotMatch(invalid.data.userMessage,/pageMetadata|JSON|schema/);
  const created=await f.api(root,'POST',{...requirement,revision:f.project.revision});assert.equal(created.status,201);
  assert.equal(created.data.requirement.generationMode,'rules');
  const route=root+'/'+created.data.requirement.id+'/generate';
  let generated=await f.api(route,'POST',{revision:created.data.project.revision});assert.equal(generated.status,201,JSON.stringify(generated.data));
  const expected=generateTestCases({requirement:requirement.description,moduleName:requirement.moduleName,pageMetadata:requirement.pageMetadata,categories:requirement.categories});
  let saved=generated.data.project;const req=saved.requirements[0];let cases=req.draftCases;
  assert.equal(req.testIds.length,0);assert.equal(saved.tests.length,f.project.tests.length);
  assert.deepEqual(cases.map(c=>c.qa.generationId),expected.testCases.map(c=>c.id));
  assert.equal(req.generation.pages.length,0);assert.equal(req.needsGeneration,false);
  for(let i=0;i<cases.length;i++){
    const q=cases[i].qa,c=expected.testCases[i];
    for(const key of ['module','category','priority','testData','expectedResult','requirementReference','assumptions'])assert.deepEqual(q[key],c[key]);
    assert.deepEqual(q.manualSteps.map(({instruction,expectedResult})=>({instruction,expectedResult})),c.steps);
    assert.deepEqual(cases[i].steps,[]);assert.equal(cases[i].tcNumber,undefined);
  }
  const approval=await f.api(root+'/'+req.id+'/approve','POST',{revision:saved.revision,draftIds:cases.map(c=>c.id)});assert.equal(approval.status,200);saved=approval.data.project;cases=saved.tests.filter(c=>saved.requirements[0].testIds.includes(c.id));assert.ok(cases.every(c=>c.inTestPlan===false&&c.tcNumber>0));
  const edited=cases[0];edited.name='Manually renamed scenario';edited.qa.category='Functional';edited.qa.assumptions=['Reviewed by QA'];edited.qa.testData=[{field:'Email',value:'reviewed@example.test'}];
  saved=(await f.api(`/api/projects/${saved.id}`,'PUT',saved)).data;
  generated=await f.api(route,'POST',{revision:saved.revision});assert.equal(generated.status,201);assert.equal(generated.data.addedCount,0);
  const kept=generated.data.project.tests.find(c=>c.id===edited.id);assert.equal(kept.name,edited.name);assert.deepEqual(kept.qa.testData,edited.qa.testData);assert.deepEqual(kept.qa.assumptions,edited.qa.assumptions);assert.equal(kept.qa.category,'Functional');
});

test('local requirement UI generates, filters, edits, exports and keeps edits on regeneration',{timeout:60000},async t=>{
  const f=await fixture(t,3521),browser=await chromium.launch({channel:'chrome'});t.after(()=>browser.close());
  const page=await browser.newPage({acceptDownloads:true}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(f.base+'/#requirements');await page.getByRole('button',{name:'Add requirement',exact:true}).first().click();
  await page.getByLabel('Requirement title',{exact:true}).fill(requirement.title);await page.getByLabel('URL',{exact:true}).fill(requirement.url);await page.getByLabel('Description',{exact:true}).fill(requirement.description);await page.getByLabel('Module (optional)',{exact:true}).fill(requirement.moduleName);
  await page.getByLabel('Generation method',{exact:true}).selectOption('rules');
  await page.getByText('Fields, controls, and constraints (optional)',{exact:true}).click();
  await page.getByLabel('Page metadata',{exact:true}).fill('{invalid');await page.getByRole('button',{name:'Generate Test Cases',exact:true}).click();
  await page.locator('#requirement-feedback').filter({hasText:'The optional page details could not be read.'}).waitFor();
  await page.getByText('Fields, controls, and constraints (optional)',{exact:true}).click();
  await page.getByLabel('Page metadata',{exact:true}).fill('{"fields":"incorrect"}');await page.getByRole('button',{name:'Generate Test Cases',exact:true}).click();
  await page.locator('#requirement-feedback').filter({hasText:'The list of page fields could not be read.'}).waitFor();
  assert.doesNotMatch(await page.locator('#requirement-feedback').innerText(),/pageMetadata|must be an array|Invalid generation input/);
  await page.getByText('Fields, controls, and constraints (optional)',{exact:true}).click();
  await page.getByLabel('Page metadata',{exact:true}).fill(JSON.stringify({title:'Registration page',url:requirement.url,...requirement.pageMetadata,fields:[requirement.pageMetadata.fields[0],{name:'Password',type:'password',constraints:{minLength:4,maxLength:6}}]}));
  await page.getByRole('button',{name:'Generate Test Cases',exact:true}).click();await page.locator('.requirement-cases tbody tr').first().waitFor();
  assert.match(await page.locator('.requirement-coverage').innerText(),/needed reconciliation/);
  const requirementHash=new URL(page.url()).hash;
  await page.getByLabel('Filter generated cases by category').selectOption('Security');assert.equal(await page.locator('.requirement-cases tbody tr').count(),1);
  await page.locator('.requirement-cases a.case-link').click();await page.getByRole('dialog',{name:'Review test case',exact:true}).waitFor();
  await page.getByLabel('Test case title',{exact:true}).fill('Reviewed password display');await page.getByLabel('Category',{exact:true}).selectOption('Validation');
  await page.getByLabel('Test data (JSON array)',{exact:true}).fill('[{"field":"Password","value":"dummy-only"}]');await page.getByLabel('Assumptions (one per line)',{exact:true}).fill('Display policy confirmed by QA');
  await page.getByRole('button',{name:'Save changes',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
  assert.ok((await f.api('/api/state')).data.projects[0].requirements[0].draftCases.some(item=>item.name==='Reviewed password display'&&item.qa.assumptions.includes('Display policy confirmed by QA')));
  await page.goto(f.base+'/'+requirementHash);await page.getByLabel('Filter generated cases by category').selectOption('Validation');
  await page.getByRole('link',{name:'Reviewed password display',exact:true}).waitFor();
  const downloaded=page.waitForEvent('download');await page.getByRole('button',{name:'Export CSV',exact:true}).click();
  const download=await downloaded,csv=await readFile(await download.path(),'utf8');assert.match(csv,/Generation ID/);assert.match(csv,/Reviewed password display/);assert.match(csv,/Draft [a-f0-9]{8}/);assert.match(csv,/dummy-only/);assert.match(csv,/Display policy confirmed by QA/);assert.doesNotMatch(csv,/response-time scenario/);
  await page.getByRole('button',{name:'Generate Test Cases',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#requirement-feedback')?.textContent.startsWith('0 drafts generated.'));
  await page.getByRole('link',{name:'Reviewed password display',exact:true}).waitFor();
  await page.goto(f.base+'/#cases');await page.getByLabel('Filter by category',{exact:true}).selectOption('Validation');assert.equal(await page.locator('#case-results .case-title').filter({hasText:'Reviewed password display'}).count(),0);
  await page.goto(f.base+'/'+requirementHash);await page.getByLabel('Filter generated cases by category').selectOption('Validation');
  await page.getByLabel('Description',{exact:true}).fill('Unsaved acceptance criteria to keep while approving');
  await page.locator('.requirement-cases tbody tr').filter({has:page.getByRole('link',{name:'Reviewed password display',exact:true})}).getByRole('button',{name:'Approve',exact:true}).click();await page.getByRole('dialog',{name:'Review and approve test case',exact:true}).getByRole('button',{name:'Confirm approval',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});await page.waitForFunction(()=>document.querySelector('#requirement-feedback')?.textContent.includes('1 test cases approved'));
  assert.equal(await page.getByLabel('Description',{exact:true}).inputValue(),'Unsaved acceptance criteria to keep while approving');
  await page.goto(f.base+'/#cases');await page.getByLabel('Filter by category',{exact:true}).selectOption('Security');assert.equal(await page.locator('#case-results .case-title').filter({hasText:'Reviewed password display'}).count(),0);
  await page.getByLabel('Filter by category',{exact:true}).selectOption('Validation');await page.locator('#case-results .case-title').filter({hasText:'Reviewed password display'}).waitFor();assert.deepEqual(errors,[]);
});

test('saved requirements generate through inspected conflicts and repeated generation keeps reviewed cases',async t=>{
  const page={url:requirement.url,title:'Registration',status:200,controls:[{tag:'input',label:'Email',type:'email',required:false},{tag:'input',label:'Password',type:'text',minLength:'1',maxLength:'6'},{tag:'button',label:'Register',type:'submit',disabled:true}]};
  const f=await fixture(t,3522,{requirementInspector:async()=>({pages:[page],context:{pages:[page]},warnings:[]})}),root=`/api/projects/${f.project.id}/requirements`;
  const fields={...requirement,description:requirement.description+' Age must be between 18 and 65.',inspectBeforeGeneration:true,pageMetadata:{...requirement.pageMetadata,fields:[{name:'Email',type:'email',constraints:{required:false}},{name:'Password',type:'password',constraints:{minLength:2,maxLength:4}},{name:'Age',type:'integer'}],controls:[{name:'Register',type:'submit',disabled:false}]}};
  const created=await f.api(root,'POST',{...fields,revision:f.project.revision});assert.equal(created.status,201);
  const route=root+'/'+created.data.requirement.id+'/generate';let response=await f.api(route,'POST',{revision:created.data.project.revision});assert.equal(response.status,201,JSON.stringify(response.data));
  let saved=response.data.project;const req=saved.requirements[0],cases=req.draftCases;
  assert.match(req.generation.warnings.join(' '),/needed reconciliation/);assert.equal(req.generation.pages.length,1);
  assert.ok(cases.some(c=>c.name==='Email: required value is missing'));
  for(const count of [7,8,64,65])assert.ok(cases.some(c=>c.qa.category==='Boundary'&&c.qa.manualSteps.some(s=>s.instruction.includes(`exactly ${count} characters`))));
  assert.ok(cases.some(c=>c.name==='Register: review conflicting control definitions'));assert.equal(req.needsGeneration,false);
  cases[0].name='Reviewed conflict scenario';saved=(await f.api(`/api/projects/${saved.id}`,'PUT',saved)).data;
  response=await f.api(route,'POST',{revision:saved.revision});assert.equal(response.status,201);assert.equal(response.data.addedCount,0);assert.equal(response.data.project.requirements[0].draftCases.find(c=>c.id===cases[0].id).name,'Reviewed conflict scenario');
});

test('saved and legacy optional metadata normalize before generation and stay current',async t=>{
  const f=await fixture(t,3523),root=`/api/projects/${f.project.id}/requirements`;
  let revision=f.project.revision;
  const variants=[null,'   ',JSON.stringify(requirement.pageMetadata),{pageMetadata:requirement.pageMetadata},{...requirement.pageMetadata,title:'Registration page',url:requirement.url}];
  for(const pageMetadata of variants){
    const created=await f.api(root,'POST',{...requirement,pageMetadata,revision});assert.equal(created.status,201,JSON.stringify(created.data));
    assert.equal(typeof created.data.requirement.pageMetadata,'object');
    // Exercise the direct Generate action for data stored by an older client.
    const stored=f.studio.store.projects.find(p=>p.id===f.project.id).requirements.find(r=>r.id===created.data.requirement.id);stored.pageMetadata=pageMetadata;
    const route=root+'/'+created.data.requirement.id+'/generate',response=await f.api(route,'POST',{revision:created.data.project.revision});assert.equal(response.status,201,JSON.stringify(response.data));
    assert.equal(response.data.requirement.needsGeneration,false);assert.ok(response.data.addedCount>0);assert.equal(typeof response.data.requirement.pageMetadata,'object');
    if(pageMetadata?.title){assert.match(response.data.requirement.generation.warnings.join(' '),/Additional page annotations/);assert.ok(!Object.hasOwn(response.data.requirement.pageMetadata,'title'));}
    const repeated=await f.api(route,'POST',{revision:response.data.project.revision});assert.equal(repeated.status,201);assert.equal(repeated.data.addedCount,0);assert.equal(repeated.data.requirement.needsGeneration,false);revision=repeated.data.project.revision;
  }
  const invalid=await f.api(root,'POST',{...requirement,pageMetadata:{fields:'invalid'},revision});assert.equal(invalid.status,400);assert.match(invalid.data.error,/pageMetadata\.fields must be an array/);
});
