import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProject, prepareRun, resolveTarget, sampleProject } from '../model.mjs';
import { executeStep, locator, preflight } from '../runner.mjs';
import { validateGeneratedTest } from '../inspection.mjs';
import { launchBrowser } from '../browsers.mjs';
const {saveObject,saveStepObject,migrateRepository,pattern,resolve,definition,normalizedTemplate}=globalThis.StudioLocators;
const project=()=>({objects:[],tests:[{id:'login',name:'Login',steps:[]},{id:'signup',name:'Signup',steps:[]}],prerequisites:[]});
const input=(selector,extra={})=>({testCaseId:'login',locatorType:'css',selector,...extra});
const capture=(p,target,extra={})=>{const step={name:'Field',action:'fill',locatorType:'css',target,value:'action data',...extra};p.tests[0].steps.push(step);saveStepObject(p,'login',step);return step;};

test('one generic mapping per case and template, with independent step replacements',()=>{
  const p=project(),username=capture(p,'[name="username"]',{name:'Username'}),password=capture(p,'[name="password"]',{name:'Password'});
  assert.equal(p.objects.length,1);assert.equal(p.locatorTemplates.length,1);
  assert.equal(p.objects[0].name,'genericCSSNameOnly');assert.equal(p.objects[0].testCaseId,'login');
  assert.equal(username.target,password.target);assert.equal(username.replacement,'username');assert.equal(password.replacement,'password');
  assert.equal(username.elementName,'Username');assert.equal(password.elementName,'Password');
  assert.equal(Object.hasOwn(p.objects[0],'replacement'),false);
  for(const value of ['username','password'])assert.equal(saveObject(p,input('[name="'+value+'"]')).id,username.target);
  const recaptured=capture(p,'[name="password"]',{replacement:'stale'});assert.equal(recaptured.replacement,'password');assert.equal(p.objects.length,1);
  username.replacement='edited';assert.equal(password.replacement,'password');
  assert.equal(resolveTarget(password,p.objects,p.locatorTemplates),'[name="password"]');
  assert.equal(resolveTarget(username,p.objects,p.locatorTemplates),'[name="edited"]');
  assert.equal(p.locatorTemplates[0].selector,'[name="XXX"]');assert.equal(username.value,'action data');
});

test('ownership requires selection and independent mappings survive edits and merges',()=>{
  const p=project();assert.throws(()=>saveObject(p,{locatorType:'css',selector:'#button'}),/Select a test case/);
  const a=saveObject(p,input('[name="username"]')),b=saveObject(p,input('[name="username"]',{testCaseId:'signup'}));
  assert.notEqual(a.id,b.id);assert.equal(a.templateId,b.templateId);
  const step=capture(p,'[name="password"]');
  const edited=saveObject(p,input('[id="XXX"]',{id:a.id}));assert.equal(edited.name,'genericCSSIdOnly');
  assert.equal(definition(b,p.locatorTemplates).selector,'[name="XXX"]');
  assert.equal(resolveTarget(step,p.objects,p.locatorTemplates),'[id="password"]');
  assert.throws(()=>saveObject(p,input('[name="XXX"]',{id:b.id})),/another test case/);
  const second=saveObject(p,input('[name="XXX"]'));
  saveObject(p,input('[name="XXX"]',{id:edited.id}));
  assert.equal(step.target,second.id);assert.equal(p.objects.filter(o=>o.testCaseId==='login').length,1);
  p.objects=p.objects.filter(o=>o.id!==second.id);assert.equal(p.objects[0].id,b.id);
});

test('normalized structure deduplicates quotes and attribute whitespace without erasing relationships',()=>{
  const p=project();const a=saveObject(p,input('[name="username"]'));
  assert.equal(saveObject(p,input("[ name = 'password' ]")).id,a.id);
  for(const selector of ['[id="username"]','input[name="username"]','input[name="username"][type="text"]','input[name="username"][type="password"]','form[id="login"] > input[name="username"]','form[id="signup"] > input[name="username"]','form[id="login"] input[name="username"]','[name^="username"]','[name^="password"]','input[id="x"][name="username"]','input[id="x"][name="password"]','input:not([name="username"])','input:not([name="password"])'])saveObject(p,input(selector));
  saveObject(p,input('//input[@name="username"]',{locatorType:'xpath'}));
  assert.equal(p.objects.length,15);
  assert.notEqual(normalizedTemplate('form > input','css'),normalizedTemplate('form input','css'));
  for(const selector of ['[name=""]','[class="a"]',':is([name="a"],[name="b"])','input[id="a"][name="b"]'])assert.equal(pattern(selector,'css'),null);
});

test('legacy migration splits shared mappings, consolidates patterns, and moves all defaults to steps',()=>{
  const raw=sampleProject(3200);raw.tests[0].inTestPlan=true;
  raw.objects=[{id:'user',name:'Username',locatorType:'css',selector:'[name="username"]',frame:'iframe#one',container:'section',pageIndex:1,pageUrl:'https://app/login'},
    {id:'pass',name:'Password',locatorType:'css',selector:'[name="password"]',framePath:['iframe#two']}];
  raw.tests[0].steps=[{action:'fill',locatorType:'object',target:'user',value:'Alex'},{action:'fill',locatorType:'object',target:'pass',value:'secret'}];
  raw.tests.push({id:'other',name:'Other case',steps:[{action:'fill',locatorType:'object',target:'user',replacement:'override',frame:'iframe#override',value:'separate'}]});
  const p=normalizeProject(raw,null,{nextTestNumber:1}),a=p.tests[0].steps,b=p.tests[1].steps[0];
  assert.equal(p.objects.length,2);assert.equal(p.locatorTemplates.length,1);
  assert.equal(a[0].target,a[1].target);assert.notEqual(a[0].target,b.target);
  assert.equal(a[0].replacement,'username');assert.equal(a[1].replacement,'password');assert.equal(b.replacement,'override');
  assert.equal(a[0].elementName,'Username');assert.equal(a[1].elementName,'Password');
  assert.equal(a[0].frame,'iframe#one');assert.equal(a[0].container,'section');assert.equal(a[0].pageIndex,1);assert.equal(b.frame,'iframe#override');
  assert.deepEqual(a[1].framePath,['iframe#two']);
  for(const o of p.objects)for(const key of ['replacement','pageUrl','frame','framePath','pageIndex','container','elementName'])assert.equal(Object.hasOwn(o,key),false);
  const again=normalizeProject(p,p,{nextTestNumber:3});assert.deepEqual(again.objects,p.objects);assert.deepEqual(again.tests.map(t=>t.steps),p.tests.map(t=>t.steps));
  p.tests[0].name='Renamed';migrateRepository(p);assert.equal(p.objects[0].testCaseId,'welcome');
  assert.equal(preflight(p).ok,true);const run=prepareRun(p,{});p.locatorTemplates[0].selector='[id="XXX"]';
  assert.equal(resolveTarget(run.tests[0].steps[0],run.context.objects,run.context.locatorTemplates),'[name="username"]');
});

test('orphan records are reported and prerequisites retain inline locators without arbitrary ownership',()=>{
  const p=project();p.objects=[{id:'orphan',name:'Orphan',xpath:'//button'}, {id:'pre',name:'Prerequisite field',locatorType:'css',selector:'[name="user"]',container:'form'}];
  p.prerequisites=[{id:'setup',steps:[{action:'fill',locatorType:'object',target:'pre',value:'Alex'}]}];
  migrateRepository(p);assert.equal(p.objects.length,0);assert.equal(p.repositoryLegacyObjects.length,2);
  assert.ok(p.repositoryLegacyObjects.every(entry=>entry.reason));
  const step=p.prerequisites[0].steps[0];assert.equal(step.locatorType,'css');assert.equal(step.target,'[name="XXX"]');assert.equal(step.replacement,'user');assert.equal(step.container,'form');
  const before=structuredClone(p);migrateRepository(p);assert.deepEqual(p,before);
});

test('copying test cases produces independent mappings using stable QA case IDs',()=>{
  const p=project();p.tests[0].qaCaseId='qa-login';p.tests[0].id='automation-login';
  const step={action:'fill',locatorType:'css',target:'[name="username"]',value:'Alex'};
  p.tests[0].steps.push(step);saveStepObject(p,'qa-login',step);
  const copy=structuredClone(p.tests[0]);copy.id='copy';delete copy.qaCaseId;p.tests.push(copy);migrateRepository(p);
  assert.notEqual(step.target,copy.steps[0].target);assert.equal(p.objects[0].testCaseId,'qa-login');
  assert.equal(p.objects.find(o=>o.id===copy.steps[0].target).testCaseId,'copy');
});

test('API normalization prevents shared template mutation and ownership reassignment',()=>{
  const raw=sampleProject(3200);raw.objects=[];const p=normalizeProject(raw,null,{nextTestNumber:1});
  saveObject(p,{testCaseId:'welcome',locatorType:'css',selector:'[name="XXX"]'});
  const edited=structuredClone(p);edited.locatorTemplates[0].selector='[id="XXX"]';
  assert.throws(()=>normalizeProject(edited,p,{nextTestNumber:2}),/immutable/);
  const moved=structuredClone(p);moved.objects[0].testCaseId='different';
  assert.throws(()=>normalizeProject(moved,p,{nextTestNumber:2}),/another test case/);
});

test('explicit repeated parameters reuse compatible entries while retaining fixed conditions',()=>{
  const p=project();saveObject(p,input('input[id="XXX"][name="XXX"][type="text"]'));
  const step=capture(p,'input[id="username"][name="username"][type="text"]');
  assert.equal(p.objects.length,1);assert.equal(step.replacement,'username');
  saveObject(p,input('input[id="account"][name="username"][type="text"]'));assert.equal(p.objects.length,2);
});

test('CSS and XPath quotes, missing parameters and ordinary legacy objects execute correctly',async t=>{
  const browser=await launchBrowser('chrome');t.after(()=>browser.close());const page=await browser.newPage();
  const value='a"b\'c\\d $& XXX';await page.setContent('<input><button id="ordinary">Plain</button>');
  await page.locator('input').evaluate((el,value)=>el.setAttribute('name',value),value);
  for(const type of ['css','xpath']) {
    const p=project(),o=saveObject(p,input(type==='css'?'[name="XXX"]':'//input[@name="XXX"]',{locatorType:type}));
    const step={action:'fill',locatorType:'object',target:o.id,replacement:value,value:'separate action data'};
    assert.equal(await locator(page,step,p.objects,p.locatorTemplates).count(),1);
    await executeStep(page,step,{objects:p.objects,locatorTemplates:p.locatorTemplates,timeoutMs:1000});
    assert.equal(await page.locator('input').inputValue(),'separate action data');
    assert.throws(()=>resolve({...step,replacement:''},p.objects,p.locatorTemplates),/Unresolved.*XXX/);
  }
  await executeStep(page,{action:'click',locatorType:'object',target:'plain'},{objects:[{id:'plain',locatorType:'css',selector:'#ordinary'}],timeoutMs:1000});
  for(const target of ['.//input[@name="XXX"]','./descendant::input[@name="{{value}}"]'])assert.equal(await locator(page,{locatorType:'custom',target,replacement:value}).count(),1);
});

test('migrated saved tests execute in frame/container scope and retain waiting and strictness',async t=>{
  const browser=await launchBrowser('chrome');t.after(()=>browser.close());const page=await browser.newPage();
  const p=project();p.objects=[{id:'old',name:'Field',locatorType:'css',selector:'[name="delayed"]',framePath:['iframe'],container:'section'}];
  p.tests[0].steps=[{action:'fill',locatorType:'object',target:'old',value:'waited',timeoutMs:1200}];migrateRepository(p);
  await page.setContent('<iframe srcdoc="<section><input name=delayed></section><input name=delayed>"></iframe>');
  const step=p.tests[0].steps[0];await executeStep(page,step,{objects:p.objects,locatorTemplates:p.locatorTemplates});
  assert.equal(await page.frameLocator('iframe').locator('section input').inputValue(),'waited');
  delete step.framePath;delete step.container;await page.setContent('<main></main>');
  await page.evaluate(()=>setTimeout(()=>document.querySelector('main').innerHTML='<input name="delayed">',200));
  await executeStep(page,step,{objects:p.objects,locatorTemplates:p.locatorTemplates});
  await page.evaluate(()=>document.querySelector('main').append(document.querySelector('input').cloneNode()));
  await assert.rejects(executeStep(page,step,{objects:p.objects,locatorTemplates:p.locatorTemplates}),/strict mode violation/);
});

test('generated-test validation resolves step-owned parameters',()=>{
  const p={...project(),environments:[],globalVariables:{}};const step=capture(p,'[name="username"]',{valueMode:'static'});
  const steps=[{action:'navigate',target:'',valueMode:'static',value:'https://example.com'},step];
  const inspection={elements:[{matched:true,matchCount:1,locatorType:'css',target:'[name="username"]',framePath:[]}]};
  assert.deepEqual(validateGeneratedTest(p,{steps},inspection),[]);step.replacement='';
  assert.throws(()=>validateGeneratedTest(p,{steps},inspection),/Unresolved.*XXX/);
});


test('ambiguous or invalid legacy records do not corrupt valid mappings',()=>{
  const p=project();p.objects=[
    {id:'good',name:'Good',locatorType:'css',selector:'[name="username"]'},
    {id:'broken',name:'Missing template',locatorType:'css',templateId:'missing'},
    {id:'duplicate',name:'First candidate',locatorType:'css',selector:'#one'},
    {id:'duplicate',name:'Second candidate',locatorType:'css',selector:'#two'}];
  p.tests[0].steps=[{action:'fill',locatorType:'object',target:'good',value:'Alex'}];
  migrateRepository(p);assert.equal(p.objects.length,1);assert.equal(p.objects[0].id,'good');
  assert.equal(p.repositoryLegacyObjects.length,3);
  assert.equal(p.repositoryLegacyObjects.filter(entry=>/ambiguous/.test(entry.reason)).length,2);
  assert.equal(resolveTarget(p.tests[0].steps[0],p.objects,p.locatorTemplates),'[name="username"]');
  const snapshot=JSON.stringify(p);migrateRepository(p);assert.equal(JSON.stringify(p),snapshot);
});
