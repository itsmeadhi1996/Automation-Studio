import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright';
import { inspectPage, validateGeneratedTest } from '../inspection.mjs';
import { locator } from '../runner.mjs';
import { normalizeSteps } from '../model.mjs';
import { createStudio } from './support.mjs';

test('inspection locators survive duplicate labels, long IDs, shadow roots and nested frames', {timeout:60000}, async t => {
  const longId = 'field-'+'x'.repeat(220);
  const fixture = http.createServer((req,res) => {
    res.setHeader('Content-Type','text/html');
    if(req.url==='/nested')return res.end('<input id="nested-input" aria-label="Nested field">');
    if(req.url==='/frame')return res.end('<input id="framed-input"><iframe name="inner" src="/nested"></iframe>');
    res.end(`<title>Locator fixture</title><input id="${longId}"><input placeholder="Duplicate"><input placeholder="Duplicate"><button>Same</button><button>Same</button><div id="host"></div><iframe id="frame" src="/frame"></iframe><script>document.querySelector('#host').attachShadow({mode:'open'}).innerHTML='<input aria-label="Shadow field">';</script>`);
  });
  await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>fixture.close(resolve)));
  const url='http://127.0.0.1:'+fixture.address().port;
  const project={browser:'chrome',globalVariables:{},environments:[],objects:[]};
  const snapshot=await inspectPage(project,url);
  assert.equal(snapshot.elements.length,8);
  assert.equal(snapshot.elements.find(el=>el.target===longId).target.length,226);
  assert.ok(snapshot.elements.some(el=>el.framePath.length===2));
  assert.ok(snapshot.elements.some(el=>el.label==='Shadow field'));
  assert.equal(snapshot.elements.filter(el=>el.locatorType==='placeholder').length,0);
  const browser=await chromium.launch();t.after(()=>browser.close());
  const page=await browser.newPage();await page.goto(url);
  // Reopen the page and use the persisted runner representation, not inspection handles.
  for(const el of snapshot.elements){
    const step=normalizeSteps([{...el,action:el.tag==='input'?'fill':'click',value:'Replay'}])[0];
    const found=locator(page,step,[]);
    assert.equal(await found.count(),1,JSON.stringify(step));
    if(step.action==='fill'){await found.fill(step.value);assert.equal(await found.inputValue(),'Replay');}
    else await found.click();
  }
});

test('Auto generator updates the QA case and retains requirements and identity', {timeout:60000}, async t => {
  const port=3234,base='http://127.0.0.1:'+port;
  let fail=false,requests=0;
  const studio=await createStudio({port,storage:path.resolve('.test-output','auto-generator-'+Date.now()),aiFetcher:async(url,options)=>{
    requests++;
    assert.match(options.body,/requirement-name/);
    const steps=[{action:'navigate',value:'BASE_URL',valueMode:'environment'}, {action:'fill',locatorType:'id',target:fail?'invented':'name',value:'Alex',qaRequirementId:'requirement-name'}].map(step=>({name:'Generated action',locatorType:'css',target:'',replacement:'',value:'',valueMode:'static',framePath:[],...step}));
    return {ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify({name:'Must not rename QA case',explanation:'Inspected controls.',steps})}}]})};
  }});
  await studio.listen();let browser;
  t.after(async()=>{await browser?.close();await studio.close();});
  const api=async(route,method='GET',body)=>{const response=await fetch(base+route,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,data:await response.json()};};
  const project=structuredClone(studio.store.projects[0]),original=project.tests[0];
  original.qa.manualSteps=[{id:'requirement-name',instruction:'Fill Your name with Alex',expectedResult:'Alex is entered'}];
  original.qa.description='Existing QA case';original.steps=[];original.automation=null;
  await api('/api/projects/'+project.id,'PUT',project);
  const opened=await api('/api/automation/handoff','POST',{projectId:project.id,testId:original.id});
  const automationId=opened.data.testIds[0];assert.notEqual(automationId,original.id);
  await api('/api/settings','PUT',{provider:'groq',apiKey:'mock-key'});
  browser=await chromium.launch();const page=await browser.newPage();
  await page.goto(base+'/automation');
  assert.equal(await page.locator('.tabs [data-view="ai"]').count(),0);
  assert.equal(await page.locator('.workspace-pickers [data-action="ai-assistance"]').count(),1);
  assert.equal(await page.locator('.qa-context').getAttribute('open'),null);
  await page.locator('.qa-context > summary').click();
  await page.getByRole('button',{name:'Auto generator',exact:true}).click();
  assert.match(await page.locator('#ai-prompt').inputValue(),/Fill Your name with Alex/);
  await page.getByRole('button',{name:'Generate steps'}).click();
  await page.getByRole('button',{name:'Open test editor'}).waitFor({timeout:30000});
  let saved=(await api('/api/state')).data;
  const updated=saved.projects[0].tests[0];
  assert.equal(saved.projects[0].tests.length,1);assert.equal(saved.runs.length,0);
  assert.equal(updated.id,original.id);assert.equal(updated.tcNumber,original.tcNumber);assert.equal(updated.name,original.name);
  assert.deepEqual(updated.qa.manualSteps,original.qa.manualSteps);
  assert.equal(updated.steps[1].qaRequirementId,'requirement-name');assert.equal(updated.steps[1].name,'Fill Your name with Alex');
  await page.getByRole('button',{name:'Open test editor'}).click();
  assert.equal(await page.locator('[data-step="1"][data-key="target"]').inputValue(),'name');
  assert.equal(await page.locator('[data-action="auto-generator"]').count(),0);
  assert.equal(updated.automationNeedsUpdate,false);
  const changed=structuredClone(saved.projects[0]);changed.tests[0].qa.expectedResult='The entered name is visible.';
  await api('/api/projects/'+project.id,'PUT',changed);
  await page.locator('[data-action="auto-generator"]').waitFor();
  assert.equal((await api('/api/state')).data.projects[0].tests[0].automationNeedsUpdate,true);
  await page.getByRole('button',{name:'Auto generator',exact:true}).click();
  await page.getByRole('button',{name:'Generate steps'}).click();
  await page.getByRole('button',{name:'Open test editor'}).waitFor({timeout:30000});
  saved=(await api('/api/state')).data;
  assert.equal(saved.projects[0].tests[0].automationNeedsUpdate,false);
  const regenerated=structuredClone(saved.projects[0].tests[0]);
  await page.getByRole('button',{name:'Open test editor'}).click();
  assert.equal(await page.locator('[data-action="auto-generator"]').count(),0);
  fail=true;
  const rejected=await api('/api/ai/create','POST',{projectId:project.id,testId:automationId,prompt:'Fill Your name with Alex'});
  assert.equal(rejected.status,400);
  saved=(await api('/api/state')).data;assert.deepEqual(saved.projects[0].tests[0],regenerated);assert.equal(requests,4);
});

test('generation rejects ambiguous and wrong-frame controls and transient MCP refs',()=>{
  const project={globalVariables:{},environments:[],objects:[]};
  const steps=normalizeSteps([{action:'navigate',value:'https://example.com'},{action:'fill',locatorType:'id',target:'name',value:'Alex'}]);
  const observed={locatorType:'id',target:'name',matched:true,matchCount:2};
  assert.throws(()=>validateGeneratedTest(project,{steps},{elements:[observed]}),/not observed/);
  observed.matchCount=1;observed.framePath=['iframe'];
  assert.throws(()=>validateGeneratedTest(project,{steps},{elements:[observed]}),/not observed/);
  steps[1].framePath=['iframe'];assert.deepEqual(validateGeneratedTest(project,{steps},{elements:[observed]}),[]);
  steps[1].locatorType='css';steps[1].target='ref=e123';
  assert.throws(()=>validateGeneratedTest(project,{steps}),/temporary MCP/);
});
