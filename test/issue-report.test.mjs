import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {chromium} from 'playwright';
import {createStudio} from './support.mjs';
import {attachmentName} from '../issue-report.mjs';

const config={siteUrl:'https://qa-example.atlassian.net',email:'tester@example.com',apiKey:'jira-private-token',projectKey:'QA',issueTypeName:'Bug'};
function fakeJira(){
 const calls=[],control={severity:'select',attachPermission:true,failUpload:null};
 const severityField={
  select:{fieldId:'customfield_9',name:'Severity',schema:{type:'option'},allowedValues:[{id:'s1',value:'Blocker'},{id:'s2',value:'Low'}]},
  text:{fieldId:'customfield_9',name:'Severity',schema:{type:'string',custom:'textfield'}},
 };
 const fetcher=async(url,options)=>{
  calls.push({url,options});
  const route=new URL(url).pathname;
  const response=(data,status=200)=>({ok:status<300,status,json:async()=>data});
  if(route.endsWith('/myself'))return response({accountId:'account',active:true,displayName:'QA tester'});
  if(route.endsWith('/project/QA'))return response({id:'10001',key:'QA',name:'Quality project'});
  if(route.endsWith('/mypermissions'))return response({permissions:{BROWSE_PROJECTS:{havePermission:true},CREATE_ISSUES:{havePermission:true},CREATE_ATTACHMENTS:{havePermission:control.attachPermission}}});
  if(route.endsWith('/issuetypes'))return response({issueTypes:[{id:'10004',name:'Bug',subtask:false},{id:'10005',name:'Improvement',subtask:false},{id:'10006',name:'Sub-task',subtask:true}],startAt:0,maxResults:100,total:3});
  if(/\/issuetypes\/\d+$/.test(route)){
   const fields=[{fieldId:'summary',name:'Summary'},{fieldId:'priority',name:'Priority',defaultValue:{id:'3'},allowedValues:[{id:'1',name:'Highest'},{id:'3',name:'Medium'}]}];
   if(severityField[control.severity])fields.push(severityField[control.severity]);
   return response({fields,startAt:0,maxResults:100,total:fields.length});
  }
  if(route.endsWith('/attachments')){
   const name=options.body.get('file').name;
   assert.equal(options.headers['X-Atlassian-Token'],'no-check');
   if(control.failUpload===name)return response({errorMessages:['Upload refused']},400);
   return response([{id:'1',filename:name}]);
  }
  if(route.endsWith('/issue'))return response({id:'20001',key:'QA-42'},201);
  throw new Error('Unexpected Jira route: '+route);
 };
 return {fetcher,calls,control};
}
async function fixture(t,port){
 const jira=fakeJira(),storage=path.resolve('.test-output',`issue-report-${port}-${Date.now()}`);
 const studio=await createStudio({port,storage,bugTrackerFetcher:jira.fetcher});await studio.listen();t.after(()=>studio.close());
 const base='http://127.0.0.1:'+port;
 const api=async(route,method='GET',body)=>{
  const res=await fetch(base+route,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {status:res.status,data:await res.json()};
 };
 const p=(await api('/api/state')).data.projects[0],testCase=p.tests[0];
 // Runs need a real browser to fail, so this seeds the record a failed run leaves behind.
 const run={id:randomUUID(),projectId:p.id,status:'failed',mode:'automation',browser:'chrome',environmentName:'Staging',startedAt:new Date().toISOString(),duration:10,tests:[
  {id:randomUUID(),sourceTestId:testCase.id,name:testCase.name+' (row 1)',status:'failed',trace:'big-trace.zip',steps:[
   {name:'Open page',status:'passed',screenshot:'open.png',value:'secret-typed-value'},
   {name:'Check heading',status:'failed',screenshot:'failed.png',expectedResult:'Welcome shown',actualResult:'Error shown',error:'Heading mismatch',value:'secret-typed-value'},
  ]},
  {id:randomUUID(),sourceTestId:testCase.id,name:testCase.name+' (row 2)',status:'passed',steps:[{name:'Open page',status:'passed'},{name:'Check heading',status:'passed'}]},
 ]};
 studio.store.runs.unshift(run);
 const artifacts=path.join(storage,'artifacts');
 await writeFile(path.join(artifacts,'open.png'),'open');
 await writeFile(path.join(artifacts,'failed.png'),'failed');
 await writeFile(path.join(artifacts,'big-trace.zip'),Buffer.alloc(10*1024*1024+1));
 return {jira,studio,base,api,p,testCase,run,storage};
}
const connect=async api=>{await api('/api/bug-tracker','PUT',config);assert.equal((await api('/api/bug-tracker/connect','POST',{})).data.connected,true);};
const issuePost=jira=>JSON.parse(jira.calls.filter(call=>new URL(call.url).pathname.endsWith('/issue')&&call.options.method==='POST').at(-1).options.body);

test('attachment names keep only the base name and allowed file types',()=>{
 assert.equal(attachmentName('C:\\temp\\log.txt'),'log.txt');assert.equal(attachmentName('../../shot.PNG'),'shot.PNG');
 for(const name of ['run.exe','page.html','','noextension','a"b.png'])assert.equal(attachmentName(name),null,name);
});

test('options list creatable issue types with their priority and severity fields',{timeout:30000},async t=>{
 const {api,jira}=await fixture(t,3831);
 assert.equal((await api('/api/issues/options')).status,400);
 await connect(api);
 let options=(await api('/api/issues/options')).data;
 assert.deepEqual(options.issueTypes.map(type=>type.name),['Bug','Improvement']);assert.equal(options.issueTypeId,'10004');
 assert.equal(options.priority.defaultId,'3');assert.equal(options.severity.inJira,true);assert.deepEqual(options.severity.options.map(item=>item.name),['Blocker','Low']);assert.equal(options.canAttach,true);
 assert.equal((await api('/api/issues/options?issueTypeId=10005')).data.issueTypeId,'10005');
 jira.control.severity='none';jira.control.attachPermission=false;
 options=(await api('/api/issues/options')).data;
 assert.equal(options.severity.inJira,false);assert.ok(options.severity.options.some(item=>item.name==='Critical'));assert.equal(options.canAttach,false);
});

test('draft is prefilled from the failed run, without test values, and only ticks the failed screenshot',{timeout:30000},async t=>{
 const {api,p,testCase,run}=await fixture(t,3832);
 const {draft,evidence,runId,testId}=(await api(`/api/issues/draft?projectId=${p.id}&testId=${testCase.id}&runId=${run.id}`)).data;
 assert.equal(runId,run.id);assert.equal(testId,testCase.id);
 assert.match(draft.summary,/^TC-\d{4}: .*Check heading failed$/);
 assert.match(draft.stepsToReproduce,/1\. Open page\n2\. Check heading  <-- FAILED HERE/);
 assert.match(draft.results,/Expected: Welcome shown/);assert.match(draft.results,/Actual: Error shown/);assert.match(draft.results,/Error: Heading mismatch/);
 assert.match(draft.runDetails,/Environment: Staging/);assert.match(draft.runDetails,/Browser: chrome/);assert.match(draft.runDetails,/Failed dataset rows: .*row 1/);assert.match(draft.runDetails,/Raised by: Test administrator/);
 assert.doesNotMatch(JSON.stringify(draft),/secret-typed-value/);
 assert.deepEqual(evidence.filter(item=>item.checked).map(item=>item.id),['failed.png']);
 const trace=evidence.find(item=>item.id==='big-trace.zip');assert.equal(trace.tooLarge,true);
 assert.ok(evidence.some(item=>item.id==='report'&&!item.tooLarge));
 assert.ok(evidence.every(item=>!('file' in item)));
 assert.equal((await api(`/api/issues/draft?projectId=${p.id}&testId=${testCase.id}&runId=${randomUUID()}`)).status,404);
});

test('reports send chosen fields to Jira and keep severity in the description when there is no field',{timeout:30000},async t=>{
 const {api,jira,p,testCase,run}=await fixture(t,3833);
 await connect(api);
 const base={projectId:p.id,testId:testCase.id,runId:run.id,summary:'Heading is wrong',stepsToReproduce:'1. Open page',results:'Actual: error',runDetails:'Run details here',issueTypeId:'10005',priorityId:'1'};
 assert.equal((await api('/api/issues','POST',{...base,severity:'s1',requestId:randomUUID()})).status,201);
 let sent=issuePost(jira).fields;
 assert.equal(sent.issuetype.id,'10005');assert.deepEqual(sent.priority,{id:'1'});assert.deepEqual(sent.customfield_9,{id:'s1'});
 assert.deepEqual(sent.description.content.map(line=>line.content[0]?.text).slice(0,2),['Steps to reproduce:','1. Open page']);
 jira.control.severity='text';
 assert.equal((await api('/api/issues','POST',{...base,severity:'Major',requestId:randomUUID()})).status,201);
 assert.equal(issuePost(jira).fields.customfield_9,'Major');
 jira.control.severity='none';
 assert.equal((await api('/api/issues','POST',{...base,severity:'Critical',requestId:randomUUID()})).status,201);
 sent=issuePost(jira).fields;assert.equal(sent.customfield_9,undefined);assert.equal(sent.description.content[0].content[0].text,'Severity: Critical');
 // Invalid choices are refused before anything is created, so the same request can be corrected.
 const posts=jira.calls.filter(call=>call.options.method==='POST').length,requestId=randomUUID();
 const refused=await api('/api/issues','POST',{...base,priorityId:'99',requestId});
 assert.equal(refused.status,400);assert.match(refused.data.error,/priority/);
 assert.equal((await api('/api/issues','POST',{...base,issueTypeId:'10006',requestId})).status,400);
 assert.equal(jira.calls.filter(call=>call.options.method==='POST').length,posts);
 assert.equal((await api('/api/issues','POST',{...base,requestId})).status,201);
 assert.equal((await api('/api/issues','POST',{...base,runId:randomUUID(),requestId:randomUUID()})).status,404);
});

test('attachments upload run evidence and own files, survive failures and never repeat a file',{timeout:30000},async t=>{
 const {api,base,jira,p,testCase,run}=await fixture(t,3834);
 await connect(api);
 const requestId=randomUUID(),route=`/api/issues/${requestId}/attachments`;
 const raw=(name,body)=>fetch(base+route,{method:'POST',headers:{'Content-Type':'application/octet-stream','X-File-Name':name},body});
 assert.equal((await api(route,'POST',{evidenceId:'failed.png'})).status,404);
 const issue=await api('/api/issues','POST',{projectId:p.id,testId:testCase.id,runId:run.id,requestId,summary:'Bug',stepsToReproduce:'1. Step',issueTypeId:'10004'});assert.equal(issue.status,201);
 const uploads=()=>jira.calls.filter(call=>call.url.endsWith('/attachments')).length;
 assert.equal((await api(route,'POST',{evidenceId:'failed.png'})).status,200);
 assert.equal((await api(route,'POST',{evidenceId:'failed.png'})).status,200);assert.equal(uploads(),1);
 assert.equal((await api(route,'POST',{evidenceId:'report'})).status,200);assert.equal(uploads(),2);
 // Names outside this run are refused, and oversized evidence never reaches Jira.
 assert.equal((await api(route,'POST',{evidenceId:'../data/studio.json'})).status,400);
 assert.equal((await api(route,'POST',{evidenceId:'big-trace.zip'})).status,413);assert.equal(uploads(),2);
 // A failed upload leaves the issue in place and can be retried.
 jira.control.failUpload='open.png';
 const failed=await api(route,'POST',{evidenceId:'open.png'});assert.equal(failed.status,400);assert.match(failed.data.error,/Upload refused/);
 jira.control.failUpload=null;
 assert.equal((await api(route,'POST',{evidenceId:'open.png'})).status,200);
 assert.equal((await raw('notes.txt','some notes')).status,200);
 assert.equal((await raw('virus.exe','x')).status,400);
 assert.equal((await raw('%E0%A4%A','x')).status,400);
 assert.equal((await raw('large.zip',Buffer.alloc(10*1024*1024+1))).status,413);
 const saved=(await api('/api/state')).data.reportedIssues.find(item=>item.requestId===requestId);
 assert.deepEqual(saved.attachments,['failed.png',`run-report-${run.id}.html`,'open.png','notes.txt']);
 assert.doesNotMatch(JSON.stringify(saved),/jira-private-token/);
});

test('Run history offers Raise bug on failed cases and reports through the popup',{timeout:60000},async t=>{
 const {api,jira,base,p,testCase,run}=await fixture(t,3835);
 const browser=await chromium.launch();t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:1440,height:1100}}),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 const raise=()=>page.getByRole('button',{name:'Raise bug',exact:true});
 const openRun=async()=>{
  await page.goto(`${base}/run-history?project=${p.id}`);
  await page.locator(`[data-run="${run.id}"] > summary`).click();
  await page.locator(`[data-run="${run.id}"] .run-test > summary`).first().click();
 };
 await openRun();
 await raise().first().waitFor();
 assert.equal(await raise().count(),1,'dataset rows of a case share one button');
 assert.equal(await raise().isDisabled(),true);
 await page.getByRole('link',{name:'Connect Jira in Settings'}).waitFor();
 await connect(api);await openRun();
 await raise().click();
 await page.getByLabel('Bug title').waitFor();
 assert.match(await page.getByLabel('Bug title').inputValue(),/Check heading failed/);
 assert.match(await page.getByLabel('Steps to reproduce').inputValue(),/FAILED HERE/);
 assert.equal(await page.getByLabel(/Screenshot: Check heading/).isChecked(),true);
 assert.equal(await page.getByLabel(/Screenshot: Open page/).isChecked(),false);
 assert.equal(await page.getByLabel(/Execution trace/).isDisabled(),true);
 await page.getByLabel('Priority').selectOption({label:'Highest'});
 await page.getByLabel('Severity').selectOption({label:'Blocker'});
 await page.getByLabel('Issue type').selectOption({label:'Improvement'});
 await page.getByLabel('Add your own files').setInputFiles({name:'notes.txt',mimeType:'text/plain',buffer:Buffer.from('notes')});
 await page.getByLabel('Bug title').fill('');
 await page.getByRole('button',{name:'Report as issue'}).click();
 await page.locator('#issue-dialog-error').filter({hasText:'Enter a bug title'}).waitFor();
 assert.equal(jira.calls.filter(call=>new URL(call.url).pathname.endsWith('/issue')).length,0);
 await page.getByLabel('Bug title').fill('Heading is wrong');
 jira.control.failUpload='notes.txt';
 await page.getByRole('button',{name:'Report as issue'}).click();
 await page.getByRole('button',{name:'Retry failed files'}).waitFor();
 const sent=issuePost(jira).fields;assert.equal(sent.summary,'Heading is wrong');assert.equal(sent.issuetype.id,'10005');assert.deepEqual(sent.priority,{id:'1'});assert.deepEqual(sent.customfield_9,{id:'s1'});
 jira.control.failUpload=null;
 await page.getByRole('button',{name:'Retry failed files'}).click();
 await page.locator('#issue-dialog').waitFor({state:'hidden'});
 assert.equal(jira.calls.filter(call=>new URL(call.url).pathname.endsWith('/issue')).length,1);
 const attached=jira.calls.filter(call=>call.url.endsWith('/attachments')).map(call=>call.options.body.get('file').name);
 assert.deepEqual(attached,['failed.png','notes.txt','notes.txt'],'only the failed file is retried');
 await page.getByRole('link',{name:'QA-42',exact:true}).first().waitFor();
 // A second report warns about the first and still allows it.
 await raise().click();
 await page.locator('.issue-existing').filter({hasText:'QA-42'}).waitFor();
 await page.getByRole('button',{name:'Cancel',exact:true}).last().click();
 assert.equal((await api('/api/state')).data.reportedIssues[0].testId,testCase.id);
 assert.deepEqual(errors,[]);
});

test('the test case page offers Raise bug in its toolbar and latest execution panel',{timeout:60000},async t=>{
 const {api,base,p,testCase,run,storage}=await fixture(t,3836);
 const automation=(await api('/api/state?workspace=automation')).data.projects[0].tests.find(item=>item.qaCaseId===testCase.id||item.id===testCase.id);
 const browser=await chromium.launch();t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:1440,height:1100}}),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 await connect(api);
 await page.goto(`${base}/automation?projectId=${p.id}&testId=${automation.id}&view=editor`);
 const raise=page.getByRole('button',{name:'Raise bug',exact:true});
 await raise.first().waitFor();
 assert.equal(await raise.count(),2);
 await page.screenshot({path:path.join(storage,'raise-bug-case-page.png')});
 await raise.first().click();
 await page.getByLabel('Bug title').waitFor();
 await page.locator('.issue-attachments').scrollIntoViewIfNeeded();
 await page.screenshot({path:path.join(storage,'raise-bug-popup.png')});
 await page.setViewportSize({width:390,height:800});
 assert.ok(await page.evaluate(()=>document.querySelector('#issue-dialog').getBoundingClientRect().right<=innerWidth));
 await page.screenshot({path:path.join(storage,'raise-bug-popup-phone.png')});
 await page.getByRole('button',{name:'Cancel',exact:true}).last().click();
 const submitted=(await api('/api/issues','POST',{projectId:p.id,testId:testCase.id,runId:run.id,requestId:randomUUID(),summary:'Bug',stepsToReproduce:'1. Step'}));assert.equal(submitted.status,201);
 await page.getByRole('link',{name:'QA-42',exact:true}).first().waitFor({timeout:15000});
 assert.deepEqual(errors,[]);console.log('Raise bug screenshots: '+storage);
});
