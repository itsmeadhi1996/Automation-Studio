import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {chromium} from 'playwright';
import {createStudio} from './support.mjs';

const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const reply=base=>({ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify({
  name:'Recovered welcome test',explanation:'Review the saved steps.',
  steps:[{action:'navigate',value:base+'/demo'},{action:'fill',locatorType:'id',target:'name',value:'Alex'}]
})}}]})});
async function fixture(t,port,aiFetcher){
  const storage=path.resolve('.test-output','generation-recovery-'+port+'-'+Date.now());
  const studio=await createStudio({port,storage,aiFetcher});await studio.listen();
  t.after(()=>studio.close());
  const base='http://127.0.0.1:'+port;
  const api=async(route,method='GET',body)=>{
    const response=await fetch(base+route,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,data:await response.json()};
  };
  await api('/api/settings','PUT',{provider:'reasonx',apiKey:'test-generation-key'});
  const projectId=studio.store.projects[0].id;
  return {studio,storage,base,api,projectId,request:{projectId,prompt:'Open '+base+'/demo and fill Your name with Alex.'}};
}

test('generation reports progress, rejects duplicates, persists its result and releases the project lock',{timeout:30000},async t=>{
  const started=deferred(),finish=deferred();let calls=0;
  const f=await fixture(t,3410,async()=>{calls++;started.resolve();await finish.promise;return reply('http://127.0.0.1:3410');});
  t.after(()=>finish.resolve());
  const pending=f.api('/api/ai/create','POST',f.request);
  await started.promise;
  let state=(await f.api('/api/state?workspace=automation')).data;
  const job=state.aiGenerations[0];
  assert.equal(job.status,'running');assert.equal(job.stage,'drafting');assert.ok(Date.parse(job.startedAt));
  assert.equal((await f.api('/api/status')).data.activeGenerations[0].id,job.id);
  const member={username:'unassigned',name:'Unassigned member',password:'Test-password-2026',permissions:{qa:true,automation:true}};
  assert.equal((await f.api('/api/admin/users','POST',member)).status,201);
  const login=await fetch(f.base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(member)});
  const cookie=login.headers.get('set-cookie').split(';')[0];
  const hidden=await (await fetch(f.base+'/api/state?workspace=automation',{headers:{Cookie:cookie}})).json();
  assert.deepEqual(hidden.aiGenerations,[]);
  const duplicate=await f.api('/api/ai/create','POST',f.request);
  assert.equal(duplicate.status,409);assert.equal(duplicate.data.code,'GENERATION_IN_PROGRESS');assert.equal(calls,1);
  finish.resolve();
  const result=await pending;assert.equal(result.status,201);assert.equal(result.data.generationId,job.id);
  state=(await f.api('/api/state?workspace=automation')).data;
  assert.equal(state.aiGenerations[0].status,'completed');
  assert.equal(state.aiGenerations[0].testId,result.data.test.id);
  assert.equal(state.projects[0].tests.find(item=>item.id===result.data.test.id).steps.length,2);
  assert.deepEqual((await f.api('/api/status')).data.activeGenerations,[]);
  assert.equal((await f.api('/api/ai/create','POST',f.request)).status,201);
  await f.studio.close();
  const reopened=await createStudio({port:3410,storage:f.storage});t.after(()=>reopened.close());
  assert.equal(reopened.store.aiGenerations[0].status,'completed');
  assert.equal(reopened.store.aiGenerations[0].explanation,'Review the saved steps.');
});

test('a check step with no locator is corrected automatically using the expected message',{timeout:30000},async t=>{
  const inputs=[];
  const draftWith=(base,check)=>({ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify({
    name:'Rejected sign-in',explanation:'The message appears after the click.',
    steps:[{action:'navigate',value:base+'/demo'},{action:'click',locatorType:'text',target:'Get started'},{action:'text',value:'Invalid credentials',...check}]
  })}}]})});
  const f=await fixture(t,3414,async(url,options)=>{
    if(String(url).endsWith('/models'))return {ok:true,json:async()=>({data:[]})};
    inputs.push(options.body);
    return draftWith('http://127.0.0.1:3414',inputs.length===1?{}:{locatorType:'text',target:'Invalid credentials'});
  });
  const prompt='Open '+f.base+'/demo, select Get started, and verify the error message Invalid credentials is shown.';
  const result=await f.api('/api/ai/create','POST',{projectId:f.projectId,prompt});
  assert.equal(result.status,201,JSON.stringify(result.data));assert.equal(inputs.length,2);
  assert.ok(!inputs[0].includes('validationFeedback'));assert.match(inputs[1],/Step 3: the model did not provide a locator/);
  assert.match(inputs[0],/appears only after an action/);
  const saved=f.studio.store.projects[0].tests.find(item=>item.id===result.data.test.id);
  assert.equal(saved.steps[2].target,'Invalid credentials');assert.equal(saved.steps[2].locatorType,'text');
});

test('a model failure is recoverable after reload, releases the lock, and an interrupted job is never restored as busy',{timeout:30000},async t=>{
  let fail=true;
  const f=await fixture(t,3411,async()=>{if(fail)throw new Error('Model unavailable');return reply('http://127.0.0.1:3411');});
  const originalCount=f.studio.store.projects[0].tests.length;
  assert.equal((await f.api('/api/ai/create','POST',f.request)).status,400);
  const state=(await f.api('/api/state?workspace=automation')).data;
  assert.equal(state.aiGenerations[0].status,'failed');assert.match(state.aiGenerations[0].error,/Model unavailable/);
  assert.equal(f.studio.store.projects[0].tests.length,originalCount);
  const browser=await chromium.launch();t.after(()=>browser.close());
  const page=await browser.newPage();
  await page.goto(f.base+'/automation?projectId='+f.projectId+'&view=ai');
  await page.getByRole('alert').filter({hasText:'Model unavailable'}).waitFor();
  assert.equal(await page.locator('[data-action=generate-ai]').isDisabled(),false);
  await page.getByRole('alert').filter({hasText:'Model unavailable'}).screenshot({path:'.test-output/generation-failure.png'});
  await browser.close();
  fail=false;assert.equal((await f.api('/api/ai/create','POST',f.request)).status,201);
  // Reproduce a process ending with an in-flight record on disk.
  f.studio.store.aiGenerations[0].status='running';
  await f.api('/api/settings','PUT',{reasonxMode:'auto'});
  await f.studio.close();
  const reopened=await createStudio({port:3411,storage:f.storage});t.after(()=>reopened.close());
  assert.equal(reopened.store.aiGenerations[0].status,'interrupted');
  assert.match(reopened.store.aiGenerations[0].error,/restarted/);
});

test('refreshing during generation reconnects progress and displays saved steps without another model request',{timeout:45000},async t=>{
  const started=deferred(),finish=deferred();let calls=0;
  const f=await fixture(t,3412,async url=>{
    if(String(url).endsWith('/models'))return {ok:true,json:async()=>({data:[]})};
    calls++;started.resolve();await finish.promise;return reply('http://127.0.0.1:3412');
  });
  t.after(()=>finish.resolve());
  const browser=await chromium.launch();t.after(()=>browser.close());
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(f.base+'/automation?projectId='+f.projectId+'&view=ai');
  await page.locator('#ai-prompt').fill(f.request.prompt);
  await page.getByRole('button',{name:'Generate test',exact:true}).click();
  await started.promise;
  await page.reload();
  await page.locator('.ai-progress').filter({hasText:'Generating with reasonx-v1'}).waitFor();
  assert.equal(await page.locator('[data-action=generate-ai]').isDisabled(),true);
  await page.setViewportSize({width:390,height:844});
  await page.locator('.ai-progress').screenshot({path:'.test-output/generation-progress.png'});
  await page.setViewportSize({width:1280,height:900});
  const second=await browser.newPage();await second.goto(page.url());
  await second.locator('.ai-progress').waitFor();
  assert.equal(await second.locator('[data-action=generate-ai]').isDisabled(),true);
  finish.resolve();
  await page.getByRole('button',{name:'Open test editor'}).waitFor();
  await second.getByRole('button',{name:'Open test editor'}).waitFor();
  assert.equal(await page.locator('.draft-step').count(),2);assert.equal(calls,1);
  await page.getByRole('button',{name:'Open test editor'}).locator('xpath=../..').screenshot({path:'.test-output/generation-result.png'});
  const other=(await f.api('/api/projects','POST',{name:'Other generation project'})).data;
  assert.equal((await f.api('/api/ai/create','POST',{...f.request,projectId:other.id})).status,201);
  await page.locator('#project-select').selectOption(other.id);
  await page.getByRole('button',{name:'AI Assistance',exact:true}).click();
  await page.getByRole('button',{name:'Open test editor'}).waitFor();
  await page.locator('#project-select').selectOption(f.projectId);
  await page.getByRole('button',{name:'AI Assistance',exact:true}).click();
  await page.getByRole('button',{name:'Open test editor'}).waitFor();
  await page.reload();
  await page.getByRole('button',{name:'Open test editor'}).click();
  assert.equal(await page.locator('[data-step="1"][data-key="target"]').inputValue(),'name');
  assert.deepEqual(errors,[]);
});

test('rapid Generate clicks during a pending workspace save send only one request',{timeout:45000},async t=>{
  const saveStarted=deferred(),saveFinished=deferred();let calls=0;
  const f=await fixture(t,3413,async url=>{
    if(String(url).endsWith('/models'))return {ok:true,json:async()=>({data:[]})};
    calls++;return reply('http://127.0.0.1:3413');
  });
  t.after(()=>saveFinished.resolve());
  const browser=await chromium.launch();t.after(()=>browser.close());
  const page=await browser.newPage();
  await page.goto(f.base+'/automation?projectId='+f.projectId);
  await page.locator('[data-step="0"][data-key="name"]').fill('Open the edited welcome page');
  await page.getByRole('button',{name:'AI Assistance',exact:true}).click();
  await page.locator('#ai-prompt').fill(f.request.prompt);
  await page.route('**/api/projects/'+f.projectId,async route=>{
    if(route.request().method()==='PUT'){saveStarted.resolve();await saveFinished.promise;}
    await route.continue();
  });
  let posts=0;page.on('request',r=>{if(r.url().endsWith('/api/ai/create'))posts++;});
  await page.evaluate(()=>{const button=document.querySelector('[data-action=generate-ai]');button.click();button.click();});
  await saveStarted.promise;
  assert.equal(await page.locator('[data-action=generate-ai]').isDisabled(),true);
  saveFinished.resolve();
  await page.getByRole('button',{name:'Open test editor'}).waitFor();
  assert.equal(posts,1);assert.equal(calls,1);
});
