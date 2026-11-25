import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright';
import { createStudio } from './support.mjs';
import { normalizeProject } from '../model.mjs';
import { requirementFields, validateRequirementDraft } from '../requirements.mjs';
import { inspectRequirementApp } from '../requirement-inspection.mjs';
import { generateRequirementDraft } from '../requirement-generation.mjs';

const fields={generationMode:'ai',title:'Customer sign-in',url:'https://example.test/login',description:'Active customers can sign in. Reject invalid credentials and require an email address.'};
const draft={summary:'Sign-in success, rejection, and email validation.',warnings:['Authentication must be exercised with a test account.'],cases:[
  {title:'Sign in with valid credentials',description:'Valid customer sign-in',preconditions:'An active test account',priority:'high',steps:[{instruction:'Open the sign-in page',expectedResult:'Email, Password and Sign in are visible'},{instruction:'Enter a valid test email and password and select Sign in',expectedResult:'The customer dashboard is displayed'}],expectedResult:'The customer dashboard is displayed'},
  {title:'Reject an invalid email address',description:'Email format validation',preconditions:'Sign-in form is open',priority:'medium',steps:[{instruction:'Enter not-an-email in Email and select Sign in',expectedResult:'Email format validation prevents submission'}],expectedResult:'The email validation message is shown'}
]};
const inspection={pages:[{url:fields.url,title:'Sign in',status:200,controls:[{label:'Email',type:'email',required:true},{label:'Password',type:'password'},{label:'Sign in',tag:'button'}]}],warnings:['Submissions have not been executed.'],context:{pages:[{url:fields.url,title:'Sign in',controls:[{label:'Email',type:'email',required:true}]}]}};
const response=value=>({ok:true,json:async()=>({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify(value)}]}]})});
let nextPort=3490;
async function fixture(t,extra={}){
  const storage=path.resolve('.test-output',`requirement-module-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const studio=await createStudio({port:nextPort++,storage,requirementInspector:async()=>structuredClone(inspection),aiFetcher:async()=>response(draft),...extra});await studio.listen();t.after(()=>studio.close());
  studio.store.settings={...studio.store.settings,provider:'openai',apiKey:'test-key',apiKeys:{openai:'test-key'}};
  const base='http://127.0.0.1:'+studio.server.address().port;
  const api=async(route,method='GET',body,cookie)=>{const r=await fetch(base+route,{method,headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};};
  return {studio,base,api,project:studio.store.projects[0]};
}
test('requirements validate URLs, unique IDs, stale coverage and deleted case links',()=>{
  for(const url of ['javascript:alert(1)','file:///tmp/a','https://user:password@example.test','not a URL'])assert.throws(()=>requirementFields({...fields,url}));
  assert.throws(()=>requirementFields({...fields,title:'  '}));
  let p=normalizeProject({name:'Requirements',requirements:[{id:'req',...fields}],tests:[]},null,{nextTestNumber:1});assert.equal(p.requirements[0].needsGeneration,true);
  assert.throws(()=>normalizeProject({...p,requirements:[...p.requirements,...p.requirements]},p,{nextTestNumber:1}),/unique/);
  assert.throws(()=>validateRequirementDraft({...draft,cases:[draft.cases[0],draft.cases[0]]}),/duplicate/);
  assert.throws(()=>validateRequirementDraft({...draft,cases:[{...draft.cases[0],steps:[{instruction:'Do it',expectedResult:''}]}]}),/Expected result|expected result/);
});
test('QA-only users generate durable cases; repeated generation preserves manual edits; stale updates and unauthorized access fail',async t=>{
  let calls=0;
  const f=await fixture(t,{aiFetcher:async(url,options)=>{calls++;assert.match(options.body,/Active customers/);assert.match(options.body,/Email/);return response(draft);}}),{api,studio}=f;
  const p=f.project;delete p.requirements; // Workspace created before this module existed.
  const user=(await api('/api/admin/users','POST',{name:'QA member',username:'requirements-qa',password:'Requirement-test-password',permissions:{qa:true},active:true})).data;
  studio.store.projectMembers[p.id]=[user.id];
  const cookie=(await api('/api/auth/login','POST',{username:'requirements-qa',password:'Requirement-test-password'})).cookie;
  const root=`/api/projects/${p.id}/requirements`;
  assert.equal((await api('/api/inspect','POST',{projectId:p.id,url:fields.url},cookie)).status,403);
  let r=await api(root,'POST',{...fields,revision:p.revision},cookie);assert.equal(r.status,201);let saved=r.data.project;const id=r.data.requirement.id,route=root+'/'+id;
  r=await api(route+'/generate','POST',{revision:saved.revision},cookie);assert.equal(r.status,201,JSON.stringify(r.data));saved=r.data.project;
  assert.equal(r.data.addedCount,2);assert.equal(saved.requirements[0].testIds.length,0);assert.equal(saved.requirements[0].draftCases.length,2);assert.ok(saved.requirements[0].generation.pages.length);assert.equal(saved.requirements[0].needsGeneration,false);
  r=await api(route+'/approve','POST',{revision:saved.revision,draftIds:saved.requirements[0].draftCases.map(item=>item.id)},cookie);assert.equal(r.status,200);saved=r.data.project;assert.equal(saved.requirements[0].testIds.length,2);
  const generated=saved.tests.filter(t=>saved.requirements[0].testIds.includes(t.id));assert.equal(new Set(generated.map(t=>t.tcNumber)).size,2);assert.equal(generated[0].qa.manualSteps[1].expectedResult,draft.cases[0].steps[1].expectedResult);
  generated[0].qa.manualSteps[0].instruction='Manually refined setup';
  saved=(await api('/api/projects/'+p.id,'PUT',saved,cookie)).data;
  r=await api(route+'/generate','POST',{revision:saved.revision},cookie);assert.equal(r.status,201);assert.equal(r.data.addedCount,0);assert.equal(r.data.project.tests.length,saved.tests.length);assert.equal(r.data.project.tests.find(t=>t.id===generated[0].id).qa.manualSteps[0].instruction,'Manually refined setup');saved=r.data.project;
  assert.equal((await api(route,'PUT',{...fields,title:'Stale',revision:1},cookie)).status,409);
  r=await api(route,'PUT',{...fields,description:fields.description+' Lock accounts after five failures.',revision:saved.revision},cookie);assert.equal(r.status,200);assert.equal(r.data.requirement.needsGeneration,true);saved=r.data.project;
  saved.tests=saved.tests.filter(t=>t.id!==generated[0].id);saved=(await api('/api/projects/'+p.id,'PUT',saved,cookie)).data;assert.equal(saved.requirements[0].testIds.length,1);
  studio.store.projectMembers[p.id]=[];assert.equal((await api(route+'/generate','POST',{revision:saved.revision},cookie)).status,403);assert.equal(calls,2);
  assert.equal((await api(route+'/approve','POST',{revision:saved.revision,draftIds:[generated[1].id]},cookie)).status,403);
  assert.equal((await api(route+'/cases/'+generated[1].id+'/generate-steps','POST',{revision:saved.revision},cookie)).status,403);
  studio.store.projectMembers[p.id]=[user.id];r=await api(route,'DELETE',{revision:saved.revision},cookie);assert.equal(r.status,200);assert.equal(r.data.project.requirements.length,0);assert.equal(r.data.project.tests.length,saved.tests.length);
});
test('concurrent generation and project edits cannot create partial or duplicate cases',async t=>{
  let unblock,started;const began=new Promise(resolve=>started=resolve);
  const f=await fixture(t,{requirementInspector:async()=>{started();await new Promise(resolve=>unblock=resolve);return inspection;}});
  const root=`/api/projects/${f.project.id}/requirements`;const created=(await f.api(root,'POST',{...fields,revision:f.project.revision})).data;
  const route=root+'/'+created.requirement.id,revision=created.project.revision;
  const pending=f.api(route+'/generate','POST',{revision});await began;
  assert.equal((await f.api(route+'/generate','POST',{revision})).status,409);
  assert.equal((await f.api(route,'PUT',{...fields,title:'Changed during inspection',revision})).status,200);
  unblock();assert.equal((await pending).status,409);
  const stored=(await f.api('/api/state')).data.projects[0];assert.equal(stored.requirements[0].title,'Changed during inspection');assert.equal(stored.tests.length,created.project.tests.length);assert.equal(stored.requirements[0].testIds.length,0);
});
test('invalid provider output never saves cases and the generation lock is released',async t=>{
  let valid=false;const f=await fixture(t,{aiFetcher:async()=>response(valid?draft:{...draft,cases:[]})});
  const root=`/api/projects/${f.project.id}/requirements`,created=(await f.api(root,'POST',{...fields,revision:f.project.revision})).data;
  const route=root+'/'+created.requirement.id+'/generate';assert.equal((await f.api(route,'POST',{revision:created.project.revision})).status,400);
  assert.equal(f.studio.store.projects[0].revision,created.project.revision);valid=true;assert.equal((await f.api(route,'POST',{revision:created.project.revision})).status,201);
});
test('browser inspection follows navigation, captures constraints and does not submit forms',{timeout:45000},async t=>{
  const visited=[];let writes=0;
  const site=http.createServer((req,res)=>{visited.push(req.url);if(req.method!=='GET')writes++;res.setHeader('Content-Type','text/html');res.end(req.url==='/help'?'<title>Help</title><h1>Account help</h1>':'<title>Sign in</title><form method="post" action="/submit"><label>Email<input type="email" required maxlength="60"></label><label>Password<input type="password" required></label><button>Sign in</button></form><a href="/help">Help</a><a href="/logout">Log out</a>');});await new Promise(resolve=>site.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>site.close(resolve)));
  const result=await inspectRequirementApp({browser:'chrome'},'http://127.0.0.1:'+site.address().port,{launcher:()=>chromium.launch({channel:'chrome'})});
  assert.equal(result.pages.length,2);assert.ok(result.pages[0].controls.some(c=>c.label==='Email'&&c.required&&c.maxLength==='60'));assert.ok(visited.includes('/help'));assert.ok(!visited.includes('/logout'));assert.equal(writes,0);assert.ok(result.warnings.some(w=>w.includes('Authenticated')));
});
async function assetSite(t,handleAsset){
  const site=http.createServer((req,res)=>{if(req.url.startsWith('/app.js'))return handleAsset(res);res.setHeader('Content-Type','text/html');res.end('<title>Sign in</title><div id="app"></div><script src="/app.js"></script>');});
  await new Promise(resolve=>site.listen(0,'127.0.0.1',resolve));t.after(()=>{site.closeAllConnections();return new Promise(resolve=>site.close(resolve));});
  return 'http://127.0.0.1:'+site.address().port;
}
const launcher=()=>chromium.launch({channel:'chrome'});
const renderedForm='setTimeout(()=>{document.getElementById("app").innerHTML="<label>Username<input name=username></label><button>Login</button>";},700);';
test('browser inspection waits for a client-rendered form after the document is complete',{timeout:45000},async t=>{
  const url=await assetSite(t,res=>{res.setHeader('Content-Type','text/javascript');res.end(renderedForm);});
  const result=await inspectRequirementApp({browser:'chrome'},url,{launcher});
  assert.ok(result.pages[0].controls.some(c=>c.label==='Username'));assert.ok(!result.warnings.some(w=>w.includes('No fields or controls')));
});
test('browser inspection retries once when a blocking asset stalls after the server answers',{timeout:45000},async t=>{
  let requests=0;
  const url=await assetSite(t,res=>{requests++;if(requests===1)return;res.setHeader('Content-Type','text/javascript');res.end(renderedForm);});
  const result=await inspectRequirementApp({browser:'chrome'},url,{launcher,contentTimeout:1000});
  assert.equal(requests,2);assert.ok(result.pages[0].controls.some(c=>c.label==='Username'));
});
test('browser inspection reports an unfinished page instead of saying the site cannot be opened',{timeout:45000},async t=>{
  const url=await assetSite(t,()=>{});
  const result=await inspectRequirementApp({browser:'chrome'},url,{launcher,contentTimeout:500});
  assert.equal(result.pages.length,1);assert.equal(result.pages[0].title,'Sign in');assert.equal(result.pages[0].controls.length,0);assert.ok(result.warnings.some(w=>w.includes('No fields or controls')));
});
test('browser inspection still fails for an unreachable site or an error response',{timeout:45000},async t=>{
  const site=http.createServer((req,res)=>{res.statusCode=500;res.end('Server error');});await new Promise(resolve=>site.listen(0,'127.0.0.1',resolve));
  const port=site.address().port,url='http://127.0.0.1:'+port;
  await assert.rejects(inspectRequirementApp({browser:'chrome'},url,{launcher}),/Could not inspect.*HTTP 500/);
  await new Promise(resolve=>site.close(resolve));
  await assert.rejects(inspectRequirementApp({browser:'chrome'},url,{launcher}),/Could not inspect/);
});
test('requirement UI saves an older project, generates, shows required columns and keeps unsaved text during polling',{timeout:45000},async t=>{
  const f=await fixture(t,{aiFetcher:async()=>({ok:true,status:200,json:async()=>({done:true,done_reason:'stop',message:{content:JSON.stringify(draft)}})})});delete f.project.requirements;
  const browser=await chromium.launch({channel:'chrome'});t.after(()=>browser.close());const page=await browser.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(f.base+'/#requirements');await page.getByRole('heading',{name:'Requirement',exact:true}).waitFor();
  const nav=await page.locator('nav[aria-label="Main navigation"] a').allTextContents();assert.equal(nav[1].trim(),'Requirement');
  await page.getByRole('button',{name:'Add requirement',exact:true}).first().click();
  await page.getByLabel('Requirement title',{exact:true}).fill(fields.title);await page.getByLabel('URL',{exact:true}).fill(fields.url);await page.getByLabel('Description',{exact:true}).fill(fields.description);
  assert.equal(await page.getByRole('combobox',{name:'Generation method',exact:true}).inputValue(),'agent');
  await page.getByRole('combobox',{name:'Generation method',exact:true}).selectOption('qwen');
  await page.getByRole('button',{name:'Generate Test Cases',exact:true}).click();await page.getByRole('link',{name:draft.cases[0].title,exact:true}).waitFor();
  await page.getByRole('button',{name:'Approve shown drafts',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.requirement-cases tbody')?.textContent.includes('TC-'));
  for(const name of ['TC No.','Title','Steps','Expected result'])assert.equal(await page.getByRole('columnheader',{name,exact:true}).count(),1);
  assert.match(await page.locator('.requirement-cases').innerText(),/TC-\d{4}/);assert.match(await page.locator('.requirement-cases').innerText(),/The customer dashboard is displayed/);
  await page.getByLabel('Description',{exact:true}).fill('Unsaved workflow text');await page.getByRole('heading',{name:'Test cases',exact:true}).click();
  await page.evaluate(async()=>{await poll();});assert.equal(await page.getByLabel('Description',{exact:true}).inputValue(),'Unsaved workflow text');
  await page.getByRole('button',{name:'Save requirement',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#requirement-feedback')?.textContent==='Requirement saved.');
  await page.reload();await page.getByLabel('Description',{exact:true}).waitFor();assert.equal(await page.getByLabel('Description',{exact:true}).inputValue(),'Unsaved workflow text');assert.deepEqual(errors,[]);
});
for(const provider of ['google','groq'])test(`${provider} uses the configured adapter for structured requirement cases`,async()=>{
  let request;
  const result=await generateRequirementDraft({provider,model:'test-model',apiKey:'key',apiKeys:{[provider]:'key'}},fields,inspection,async(url,options)=>{request={url,body:JSON.parse(options.body)};return {ok:true,json:async()=>provider==='google'?{status:'completed',output_text:JSON.stringify(draft)}:{choices:[{finish_reason:'stop',message:{content:JSON.stringify(draft)}}]}};});
  assert.equal(result.cases.length,2);assert.match(JSON.stringify(request.body),/Active customers/);assert.ok(request.url.startsWith(provider==='reasonx'?'http://127.0.0.1:8080/v1/':'https://'));
});
