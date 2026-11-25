import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {createStudio} from './support.mjs';
import {workflow,agentOptions} from '../agent-workflow.mjs';
import {reasonxChat,reasonxModelList} from '../reasonx-client.mjs';
import {requirementWorkflow,automationWorkflow} from '../reasonx-workflows.mjs';
import {requirementFingerprint} from '../requirements.mjs';

const reply=value=>({ok:true,status:200,json:async()=>({choices:[{finish_reason:'stop',message:{content:typeof value==='string'?value:JSON.stringify(value)}}]})});
const options={enabled:true,repairLimit:1,guidance:'Prefer clear assertions',model:'qwen3:1.7b',mode:'fast'};
const settings={provider:'reasonx',model:'reasonx-v1',reasonxMode:'fast',apiKey:'private-reasonx-key'};
const requirement={id:'req',generationMode:'agent',title:'Required name',url:'https://example.test',description:'Name is required. Reject an empty name.',categories:['Validation'],agentOptions:options};
const validCase={title:'Reject an empty name',category:'Validation',criterion:'C1',preconditions:'Form open',testData:[{field:'Name',value:''}],assumptions:[],priority:'high',steps:[{instruction:'Leave Name empty and submit',expectedResult:'Name is required appears'}],expectedResult:'Submission is blocked'};
function requirementReply(body){const system=body.messages[0].content;if(system.startsWith('Analyze'))return {criteria:[{text:'Name required',source:'explicit'},{text:'Name format needs clarification',source:'assumption'},{text:'Submission blocked',source:'explicit'}],assumptions:['Format is not specified'],questions:['Which name formats are allowed?']};if(system.startsWith('Review'))return {issues:[]};return {cases:[{...validCase,criterion:JSON.parse(body.messages[1].content).criteria[0].id}]};}
test('shared orchestration enforces repair limits and cancellation',async()=>{
  for(const repairLimit of [0,1,3]){let calls=0;await assert.rejects(workflow({repairLimit}).generate({generate:async()=>{calls++;return {};},review:async()=>['Missing assertion']}),/Repair limit/);assert.equal(calls,repairLimit+1);}
  assert.throws(()=>agentOptions({repairLimit:4}),/0 to 3/);
  const controller=new AbortController();controller.abort();await assert.rejects(workflow({signal:controller.signal}).step('analysis',()=>assert.fail()),/cancelled/);
  const legacy={title:'Legacy',url:'https://example.test',description:'Preserve generation'};
  assert.equal(requirementFingerprint(legacy),requirementFingerprint({...legacy,agentOptions:agentOptions()}));
  assert.notEqual(requirementFingerprint(legacy),requirementFingerprint({...legacy,agentOptions:options}));
});
test('requirements retain category, data, explicit mappings, questions and non-exhaustive coverage',async()=>{
  const stages=[];const result=await requirementWorkflow({settings,requirement,fetcher:async(_,init)=>requirementReplyResponse(init),onStage:e=>stages.push(e.stage)});
  function requirementReplyResponse(init){const sent=JSON.parse(init.body);assert.equal(sent.model,'qwen3:1.7b');assert.equal(sent.reasoning_mode,'FAST');assert.ok(sent.messages.reduce((n,m)=>n+m.content.length,0)<=6000);return reply(requirementReply(sent));}
  assert.equal(result.cases[0].qa.category,'Validation');assert.equal(result.cases[0].qa.requirementReference,'req:C1');assert.deepEqual(result.cases[0].qa.testData,validCase.testData);
  assert.deepEqual(result.coverage.map(c=>c.status),['covered','uncovered','uncovered']);assert.match(result.summary,/not execution or exhaustive/);assert.ok(result.warnings.some(w=>w.startsWith('Clarification:')));assert.ok(stages.includes('review'));assert.ok(stages.includes('coverage'));
});
test('requirement review repairs contradictions once and rejects malformed or exhausted drafts',async()=>{
  let reviews=0,generations=0;const input={...requirement,description:'Name is required.'};
  const fetcher=async(_,init)=>{const system=JSON.parse(init.body).messages[0].content;if(system.startsWith('Analyze'))return reply({criteria:[{text:'Name required',source:'explicit'}],questions:[],assumptions:[]});if(system.startsWith('Review'))return reply({issues:++reviews===1?['Expected result contradicts required Name']:[]});generations++;return reply({cases:[validCase]});};
  await requirementWorkflow({settings,requirement:input,fetcher});assert.equal(generations,2);assert.equal(reviews,2);
  await assert.rejects(requirementWorkflow({settings,requirement:input,fetcher:async()=>reply('malformed')}),/malformed/);
  await assert.rejects(requirementWorkflow({settings,requirement:{...input,agentOptions:{...options,repairLimit:0}},fetcher:async(_,init)=>JSON.parse(init.body).messages[0].content.startsWith('Analyze')?reply({criteria:[{text:'Name required',source:'explicit'}]}):reply({cases:[{...validCase,steps:[]} ]})}),/Repair limit/);
});

test('assumption-based criteria are only partially covered',async()=>{
  const result=await requirementWorkflow({settings,requirement,fetcher:async(_,init)=>{const system=JSON.parse(init.body).messages[0].content;return reply(system.startsWith('Analyze')?{criteria:[{text:'Assumed name rule',source:'assumption'}],assumptions:['Confirm rule'],questions:['Is Name required?']}:system.startsWith('Review')?{issues:[]}:{cases:[validCase]});}});
  assert.equal(result.coverage[0].status,'partial');assert.equal(result.coverage[0].source,'assumption');
});
test('provider auth, timeout, model failures and cancellation are classified without leaking keys',async()=>{
  for(const [status,kind] of [[401,'auth'],[404,'model'],[503,'upstream']])await assert.rejects(reasonxChat({endpoint:'http://local/v1',fetcher:async()=>({ok:false,status,json:async()=>({error:{message:'private-reasonx-key'}})}),redact:s=>s.replaceAll('private-reasonx-key','[REDACTED]')}),e=>e.kind===kind&&!e.message.includes('private-reasonx-key'));
  await assert.rejects(reasonxChat({fetcher:async()=>{throw new DOMException('Timed out','TimeoutError');}}),e=>e.kind==='timeout');
  const controller=new AbortController();let calls=0;await assert.rejects(reasonxChat({signal:controller.signal,sleep:async()=>{controller.abort();},fetcher:async()=>{calls++;return {ok:false,status:429,json:async()=>({})};}}),/cancelled/);assert.equal(calls,1);
  const status=await reasonxModelList({fetcher:async()=>{throw new DOMException('Timeout','TimeoutError');},baseUrl:'http://local/v1'});assert.match(status.error,/timed out/);
});

async function fixture(t,fetcher){const storage=path.resolve('.test-output','agent-workflow-'+Date.now()+'-'+Math.random().toString(16).slice(2));const studio=await createStudio({port:3791,storage,aiFetcher:fetcher});await studio.listen();t.after(()=>studio.close());const base='http://127.0.0.1:'+studio.server.address().port;const api=async(route,method='GET',body)=>{const r=await fetch(base+route,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json()};};await api('/api/settings','PUT',settings);return {studio,storage,base,api};}
test('QA agent options and drafts persist; failed repair preserves drafts; cancellation releases duplicate lock',{timeout:30000},async t=>{
  let fail=false,hold=false,started,release;const began=new Promise(r=>started=r),gate=new Promise(r=>release=r);t.after(()=>release());
  const f=await fixture(t,async(_,init)=>{if(hold){started();await gate;}return fail?reply('bad JSON'):reply(requirementReply(JSON.parse(init.body)));});
  const p=f.studio.store.projects[0],root='/api/projects/'+p.id+'/requirements';
  let r=await f.api(root,'POST',{...requirement,revision:p.revision});assert.equal(r.status,201);const route=root+'/'+r.data.requirement.id;
  r=await f.api(route+'/generate','POST',{revision:r.data.project.revision});assert.equal(r.status,201,JSON.stringify(r.data));assert.equal(r.data.requirement.generation.coverage.length,3);const before=structuredClone(r.data.requirement),revision=r.data.project.revision;
  assert.deepEqual((await f.api(route)).data.agentOptions,options);
  fail=true;r=await f.api(route+'/generate','POST',{revision});assert.equal(r.status,400);assert.deepEqual((await f.api(route)).data,before);
  fail=false;hold=true;const pending=f.api(route+'/generate','POST',{revision});await began;
  assert.equal((await f.api(route+'/generate','POST',{revision})).status,409);
  const job=(await f.api('/api/state')).data.aiGenerations[0];assert.equal((await f.api('/api/generations/'+job.id+'/cancel','POST',{})).status,202);release();await pending;
  assert.equal((await f.api('/api/state')).data.aiGenerations[0].status,'cancelled');assert.deepEqual((await f.api(route)).data,before);
  assert.doesNotMatch(await readFile(path.join(f.storage,'data/studio.json'),'utf8'),/private-reasonx-key/);
});
test('automation uses existing repository objects, rejects unmapped selectors, and reports missing QA mapping',async()=>{
  const project={globalVariables:{},environments:[],objects:[{id:'known',locatorType:'css',selector:'#name'}],locatorTemplates:[]};
  const draft={name:'Name',explanation:'Proposed test',steps:[{action:'navigate',value:'https://example.test'},{action:'fill',locatorType:'object',target:'known',value:'Alex'}]};
  const fetcher=async(_,init)=>reply(JSON.parse(init.body).messages[0].content.startsWith('Analyze')?{missingContext:[],testDataNeeds:[],plan:[]}:{issues:[]});
  const result=await automationWorkflow({settings,options,project,prompt:'Fill Name',targetTest:{qa:{manualSteps:[{id:'r1',instruction:'Fill name'}]}},inspection:{elements:[]},fetcher,generate:async()=>structuredClone(draft),validate:()=>{}});
  assert.equal(result.coverage[0].status,'uncovered');assert.equal(project.objects.length,1);
  await assert.rejects(automationWorkflow({settings,options:{...options,repairLimit:0},project,prompt:'Fill Name',inspection:{elements:[]},fetcher,generate:async()=>({...draft,steps:[{action:'fill',locatorType:'css',target:'#invented'}]}),validate:()=>{}}),/Unmapped element/);
});
test('automation review accepts a message check from the workflow but not invented text or actions on it',async()=>{
  const project={globalVariables:{},environments:[],objects:[],locatorTemplates:[]};
  const fetcher=async(_,init)=>reply(JSON.parse(init.body).messages[0].content.startsWith('Analyze')?{missingContext:[],testDataNeeds:[],plan:[]}:{issues:[]});
  const run=(step,prompt='Sign in and verify the error message Invalid credentials is shown.',targetTest)=>automationWorkflow({settings,options:{...options,repairLimit:0},project,prompt,targetTest,inspection:{elements:[]},fetcher,generate:async()=>({name:'Rejected',explanation:'Proposed',steps:[{action:'navigate',value:'https://example.test'},step]}),validate:()=>{}});
  const message={action:'text',locatorType:'text',target:'Invalid credentials',value:'Invalid credentials'};
  assert.equal((await run(message)).steps[1].target,'Invalid credentials');
  assert.equal((await run(message,'Verify the rejection',{qa:{manualSteps:[{id:'r1',instruction:'Sign in',expectedResult:'Invalid credentials is displayed'}]}})).steps[1].target,'Invalid credentials');
  await assert.rejects(run({...message,target:'Account locked',value:'Account locked'}),/Unmapped element/);
  await assert.rejects(run({action:'click',locatorType:'text',target:'Invalid credentials'}),/Unmapped element/);
});
test('automation review accepts resolved repository selectors and templates but flags unknown objects',async()=>{
  const project={globalVariables:{},environments:[],locatorTemplates:[{id:'field',locatorType:'css',selector:'[name="XXX"]'}],objects:[{id:'known',name:'Name',locatorType:'css',selector:'#name',xpath:''},{id:'email',name:'Email',locatorType:'css',templateId:'field',replacement:'email'}]};
  const fetcher=async(_,init)=>reply(JSON.parse(init.body).messages[0].content.startsWith('Analyze')?{missingContext:[],testDataNeeds:[],plan:[]}:{issues:[]});
  const run=steps=>automationWorkflow({settings,options:{...options,repairLimit:0},project,prompt:'Fill Name and Email',inspection:{elements:[]},fetcher,generate:async()=>({name:'Reuse',explanation:'Draft',steps}),validate:()=>{}});
  const result=await run([{action:'fill',locatorType:'css',target:'#name',value:'Alex'},{action:'fill',locatorType:'css',target:'[name="email"]',value:'a@example.test'},{action:'fill',locatorType:'object',target:'email',value:'b@example.test'}]);
  assert.equal(result.steps.length,3);assert.equal(project.objects.length,2);assert.equal(project.locatorTemplates.length,1);
  await assert.rejects(run([{action:'fill',locatorType:'object',target:'invented',value:'Alex'}]),/Unknown repository object/);
});
test('agent stage labels show progress and repair detail',async()=>{
  await import('../public/reasonx-models.js');
  assert.equal(globalThis.StudioReasonx.agentStageLabel('repair','Repair 1 of 2'),'Agent stage 4 of 6: Repairing review issues (Repair 1 of 2)');
  assert.equal(globalThis.StudioReasonx.agentStageLabel('coverage'),'Agent stage 5 of 6: Checking coverage');
  assert.equal(globalThis.StudioReasonx.agentStageLabel('drafting'),'');
});

test('both browser workflows persist choices; automation preview survives reload and applies only on review',{timeout:45000},async t=>{
  let base='',fail=false;
  const f=await fixture(t,async(url,init)=>{
    if(url.endsWith('/models'))return {ok:true,status:200,json:async()=>({data:[{id:'reasonx-v1'},{id:'qwen3:1.7b'}]})};
    if(fail)return reply('malformed');
    const sent=JSON.parse(init.body),system=sent.messages[0].content;
    if(system.startsWith('Analyze this automation'))return reply({missingContext:[],testDataNeeds:[],plan:['Open page','Fill Name']});
    if(system.startsWith('Review automation'))return reply({issues:[]});
    if(system.startsWith('Draft a browser'))return reply({name:'Agent welcome',explanation:'Not executed.',steps:[{action:'navigate',value:base+'/demo'},{action:'fill',locatorType:'id',target:'name',value:'Alex'}]});
    if(system.startsWith('Analyze'))return reply({criteria:[{text:'Name is required',source:'explicit'}],assumptions:[],questions:[]});
    if(system.startsWith('Review'))return reply({issues:[]});
    return reply({cases:[validCase]});
  });base=f.base;
  const browser=await chromium.launch();t.after(()=>browser.close());const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/#requirements');await page.getByRole('button',{name:'Add requirement',exact:true}).first().click();
  await page.getByLabel('Requirement title',{exact:true}).fill(requirement.title);await page.getByLabel('URL',{exact:true}).fill(base+'/demo');await page.getByLabel('Description',{exact:true}).fill(requirement.description);
  await page.getByText('ReasonX agent options',{exact:true}).click();await page.getByLabel('Agent model',{exact:true}).selectOption('qwen3:1.7b');await page.getByLabel('Agent reasoning mode',{exact:true}).selectOption('fast');await page.getByLabel('Repair limit',{exact:true}).fill('2');await page.getByLabel('Agent workflow guidance (optional)',{exact:true}).fill('Use synthetic names');
  await page.getByRole('button',{name:'Generate Test Cases',exact:true}).click();await page.getByRole('heading',{name:'Requirement coverage',exact:true}).waitFor();
  await page.reload();await page.getByText('ReasonX agent options',{exact:true}).click();assert.equal(await page.getByLabel('Repair limit',{exact:true}).inputValue(),'2');assert.equal(await page.getByLabel('Agent model',{exact:true}).inputValue(),'qwen3:1.7b');
  await page.screenshot({path:path.join(f.storage,'requirements-agents.png'),fullPage:true});
  const original=f.studio.store.projects[0].tests.length;
  await page.goto(base+'/automation?view=ai');await page.getByText('ReasonX agent workflow',{exact:true}).click();await page.getByLabel('Use ReasonX agents',{exact:true}).check();await page.getByLabel('Agent workflow guidance (optional)',{exact:true}).fill('Prefer Name field');await page.getByLabel('Repair limit',{exact:true}).fill('2');
  await page.getByRole('button',{name:'Save agent options',exact:true}).click();await page.reload();await page.getByText('ReasonX agent workflow',{exact:true}).click();assert.equal(await page.getByLabel('Use ReasonX agents',{exact:true}).isChecked(),true);assert.equal(await page.getByLabel('Repair limit',{exact:true}).inputValue(),'2');assert.equal(await page.getByLabel('Agent workflow guidance (optional)',{exact:true}).inputValue(),'Prefer Name field');
  await page.locator('#ai-prompt').fill('Open '+base+'/demo and fill Your name with Alex.');await page.getByRole('button',{name:'Generate test',exact:true}).click();await page.getByRole('button',{name:'Apply reviewed draft',exact:true}).waitFor();
  assert.equal(f.studio.store.projects[0].tests.length,original);assert.equal(f.studio.store.runs.length,0);const preview=structuredClone(f.studio.store.agentDrafts[0]);
  await page.reload();await page.getByRole('button',{name:'Apply reviewed draft',exact:true}).waitFor();await page.screenshot({path:path.join(f.storage,'automation-preview.png'),fullPage:true});
  fail=true;const failed=await f.api('/api/ai/create','POST',{projectId:preview.projectId,prompt:'Open '+base+'/demo',agentOptions:{...options,repairLimit:0}});assert.equal(failed.status,400);assert.deepEqual(f.studio.store.agentDrafts[0],preview);fail=false;
  await page.getByRole('button',{name:'Apply reviewed draft',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('[data-action=apply-agent-draft]'));
  assert.equal(f.studio.store.projects[0].tests.length,original+1);assert.equal(f.studio.store.runs.length,0);assert.deepEqual(errors,[]);
});

test('automation cancellation, permissions, stale preview and disabled mode protect saved scripts',{timeout:30000},async t=>{
  let base='',hold=false,release,started;const gate=new Promise(r=>release=r),began=new Promise(r=>started=r);t.after(()=>release());
  const f=await fixture(t,async(_,init)=>{const system=JSON.parse(init.body).messages[0].content;if(hold){started();await gate;}if(system.startsWith('Analyze'))return reply({missingContext:[],testDataNeeds:[],plan:[]});if(system.startsWith('Review'))return reply({issues:[]});return reply({name:'Preview only',explanation:'Not executed',steps:[{action:'navigate',value:base+'/demo'},{action:'fill',locatorType:'id',target:'name',value:'Alex'}]});});base=f.base;
  const p=f.studio.store.projects[0],request={projectId:p.id,prompt:'Open '+base+'/demo and fill Name',agentOptions:options};
  let response=await f.api('/api/ai/create','POST',request);assert.equal(response.status,201,JSON.stringify(response.data));const preview=structuredClone(f.studio.store.agentDrafts[0]);const count=p.tests.length;
  const member={username:'outside',name:'Outside',password:'Test-password-2026',permissions:{qa:true,automation:true}};await f.api('/api/admin/users','POST',member);const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(member)});const headers={'Content-Type':'application/json',Cookie:login.headers.get('set-cookie').split(';')[0]};
  const hidden=await(await fetch(base+'/api/state?workspace=automation',{headers})).json();assert.deepEqual(hidden.agentDrafts,[]);
  assert.equal((await fetch(base+'/api/ai/apply',{method:'POST',headers,body:JSON.stringify({id:preview.id})})).status,403);
  hold=true;const pending=f.api('/api/ai/create','POST',request);await began;assert.equal((await f.api('/api/ai/create','POST',request)).status,409);const job=(await f.api('/api/state?workspace=automation')).data.aiGenerations[0];await f.api('/api/generations/'+job.id+'/cancel','POST',{});release();await pending;hold=false;
  assert.deepEqual(f.studio.store.agentDrafts[0],preview);assert.equal(f.studio.store.projects[0].tests.length,count);assert.equal(f.studio.store.aiGenerations[0].status,'cancelled');
  await f.api('/api/projects/'+p.id,'PUT',{...f.studio.store.projects[0],name:'Edited after preview'});
  const stale=await f.api('/api/ai/apply','POST',{id:preview.id});assert.equal(stale.status,400);assert.match(stale.data.error,/changed since/);assert.equal(f.studio.store.projects[0].tests.length,count);
  response=await f.api('/api/ai/create','POST',{...request,agentOptions:{...options,enabled:false}});assert.equal(response.status,201,JSON.stringify(response.data));assert.equal(response.data.status,'not_run');assert.equal(f.studio.store.projects[0].tests.length,count+1);assert.equal(f.studio.store.runs.length,0);
  await f.studio.close();const reopened=await createStudio({port:3791,storage:f.storage});t.after(()=>reopened.close());assert.deepEqual(reopened.store.agentDrafts[0],preview);
});
