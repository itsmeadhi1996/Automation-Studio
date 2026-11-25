import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {chromium} from 'playwright';
import {createStudio} from './support.mjs';
import {normalizeBugTracker, publicBugTracker, verifyBugTracker} from '../bug-tracker.mjs';

const config={siteUrl:'https://qa-example.atlassian.net',email:'tester@example.com',apiKey:'jira-private-token',projectKey:'QA',issueTypeName:'Bug'};
function fakeJira(){
 const calls=[],control={auth:true,permission:true,uncertain:false,validation:false,delay:null};
 const fetcher=async(url,options)=>{
  calls.push({url,options});
  assert.equal(options.redirect,'error');assert.ok(options.signal);
  assert.equal(options.headers.Authorization,'Basic '+Buffer.from(config.email+':'+config.apiKey).toString('base64'));
  const route=new URL(url).pathname;
  const response=(data,status=200)=>({ok:status<300,status,json:async()=>data});
  if(!control.auth)return response({},401);
  if(route.endsWith('/myself') && control.verifyGate)await control.verifyGate;
  if(route.endsWith('/myself'))return response({accountId:'account',active:true,displayName:'QA tester'});
  if(route.endsWith('/project/QA'))return response({id:'10001',key:'QA',name:'Quality project'});
  if(route.endsWith('/mypermissions'))return response({permissions:{BROWSE_PROJECTS:{havePermission:true},CREATE_ISSUES:{havePermission:control.permission}}});
  if(route.endsWith('/issuetypes'))return response({issueTypes:[{id:'10004',name:'Bug',subtask:false}],startAt:0,maxResults:100,total:1});
  if(route.endsWith('/issuetypes/10004'))return response({fields:[],startAt:0,maxResults:100,total:0});
  if(route.endsWith('/issue')){
   if(control.delay)await control.delay;
   if(control.uncertain)throw new Error('network failure');
   if(control.validation)return response({errors:{customfield_1:'Required field '+config.apiKey}},400);
   return response({id:'20001',key:'QA-42'},201);
  }
  throw new Error('Unexpected Jira route: '+route);
 };
 return {fetcher,calls,control};
}
async function fixture(t,port){
 const jira=fakeJira(),storage=path.resolve('.test-output',`jira-${port}-${Date.now()}`);
 const studio=await createStudio({port,storage,bugTrackerFetcher:jira.fetcher});await studio.listen();t.after(()=>studio.close());
 const base='http://127.0.0.1:'+port;
 const api=async(route,method='GET',body)=>{
  const res=await fetch(base+route,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {status:res.status,data:await res.json()};
 };
 return {jira,studio,storage,base,api};
}
test('Jira configuration validates destinations and never exposes credentials',async()=>{
 const saved=normalizeBugTracker({...config,connected:true});assert.equal(saved.connected,false);
 assert.equal(normalizeBugTracker({...config,apiKey:''},saved).apiKey,config.apiKey);
 assert.throws(()=>normalizeBugTracker({...config,email:'another@example.com',apiKey:''},saved),/API token/);
 for(const siteUrl of ['http://qa-example.atlassian.net','https://example.com','https://qa-example.atlassian.net.evil.test','https://user:secret@qa-example.atlassian.net','https://qa-example.atlassian.net/path'])assert.throws(()=>normalizeBugTracker({...config,siteUrl}));
 assert.doesNotMatch(JSON.stringify(publicBugTracker(saved)),/jira-private-token/);
 const jira=fakeJira();jira.control.permission=false;
 await assert.rejects(verifyBugTracker(saved,jira.fetcher),/Create Issues permissions/);
});
test('API gates reporting, encrypts tokens, persists links and deduplicates issue creation',{timeout:30000},async t=>{
 const {api,jira,studio,storage}=await fixture(t,3816);
 const p=(await api('/api/state')).data.projects[0];
 const draft={projectId:p.id,testId:p.tests[0].id,summary:'Unexpected result',description:'Steps\nExpected result\nActual result',requestId:randomUUID()};
 assert.equal((await api('/api/issues','POST',draft)).status,400);
 assert.equal((await api('/api/bug-tracker','PUT',config)).data.connected,false);
 assert.equal((await api('/api/bug-tracker/connect','POST',{})).data.connected,true);
 assert.equal((await api('/api/state')).data.bugTracker.connected,true);
 assert.doesNotMatch(JSON.stringify((await api('/api/settings')).data),/jira-private-token/);
 assert.doesNotMatch(await readFile(path.join(storage,'data','studio.json'),'utf8'),/jira-private-token/);
 let release;jira.control.delay=new Promise(resolve=>release=resolve);
 const pending=api('/api/issues','POST',draft);
 while(!jira.calls.some(call=>call.options.method==='POST'))await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal((await api('/api/issues','POST',draft)).status,409);
 release();assert.equal((await pending).data.key,'QA-42');
 assert.equal((await api('/api/issues','POST',draft)).data.key,'QA-42');
 assert.equal(jira.calls.filter(call=>call.options.method==='POST').length,1);
 const sent=JSON.parse(jira.calls.find(call=>call.options.method==='POST').options.body);
 assert.equal(sent.fields.description.type,'doc');assert.equal(sent.fields.project.id,'10001');assert.equal(sent.fields.issuetype.id,'10004');
 assert.deepEqual(sent.fields.description.content.map(line=>line.content[0]?.text),['Steps','Expected result','Actual result']);
 const issues=(await api('/api/state')).data.reportedIssues;assert.equal(issues[0].url,config.siteUrl+'/browse/QA-42');
 await api('/api/settings','PUT',{model:'another-model'});assert.equal((await api('/api/bug-tracker')).data.connected,true);
 jira.control.validation=true;
 const rejected=await api('/api/issues','POST',{...draft,requestId:randomUUID()});assert.match(rejected.data.error,/Required field/);assert.doesNotMatch(rejected.data.error,/jira-private-token/);
 jira.control.validation=false;jira.control.uncertain=true;
 const uncertain={...draft,requestId:randomUUID()};assert.equal((await api('/api/issues','POST',uncertain)).status,502);
 assert.equal((await api('/api/issues','POST',uncertain)).status,409);
 await api('/api/bug-tracker','PUT',{...config,apiKey:''});assert.equal((await api('/api/state')).data.bugTracker.connected,false);
 jira.control.auth=false;assert.equal((await api('/api/bug-tracker/connect','POST',{})).status,400);
 assert.equal((await api('/api/bug-tracker')).data.connected,false);
 await api('/api/bug-tracker','DELETE',{});assert.equal((await api('/api/bug-tracker')).data.hasApiKey,false);
 assert.equal((await api('/api/state')).data.reportedIssues.length,1);
 await studio.close();
 const reopened=await createStudio({port:3816,storage,bugTrackerFetcher:jira.fetcher});await reopened.listen();t.after(()=>reopened.close());
 assert.equal((await api('/api/state')).data.reportedIssues[0].key,'QA-42');
});
test('verification cannot reconnect a configuration removed while its check was in flight',{timeout:15000},async t=>{
 const {api,jira}=await fixture(t,3295);
 await api('/api/bug-tracker','PUT',config);
 let release;
 jira.control.verifyGate=new Promise(resolve=>release=resolve);
 const pending=api('/api/bug-tracker/connect','POST',{});
 while(!jira.calls.some(call=>call.url.endsWith('/myself')))await new Promise(resolve=>setTimeout(resolve,10));
 await api('/api/bug-tracker','DELETE',{});release();
 assert.equal((await pending).status,400);
 assert.equal((await api('/api/bug-tracker')).data.connected,false);
});
test('Settings connection enables Report issue in case details and shows created issue links',{timeout:45000},async t=>{
 const {api,jira,base,storage}=await fixture(t,3296);
 const p=(await api('/api/state')).data.projects[0];
 const browser=await chromium.launch();t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:1440,height:1100}}),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.goto(base+'/#case/'+p.tests[0].id);await page.getByRole('heading',{name:p.tests[0].name,exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'Report issue',exact:true}).count(),0);
 await page.getByRole('link',{name:'Settings',exact:true}).click();
 await page.getByRole('heading',{name:'Bug tracking configuration'}).waitFor();
 await page.getByLabel('Jira site URL').fill(config.siteUrl);await page.getByLabel('Jira account email').fill(config.email);
 await page.getByLabel('Jira project key').fill(config.projectKey);await page.getByLabel('Jira API token').fill(config.apiKey);
 jira.control.auth=false;await page.getByRole('button',{name:'Save & test connection'}).click();
 await page.locator('#bug-tracker-message').filter({hasText:'authentication failed'}).waitFor();
 assert.equal(await page.locator('#jira-connection-status').textContent(),'Not connected');
 jira.control.auth=true;await page.getByRole('button',{name:'Save & test connection'}).click();
 await page.locator('#jira-connection-status').filter({hasText:'Connected'}).waitFor();
 assert.equal(await page.getByLabel('Jira API token').inputValue(),'');
 await page.screenshot({path:path.join(storage,'jira-settings.png'),fullPage:true});
 await page.goto(base+'/#case/'+p.tests[0].id);
 await page.getByRole('button',{name:'Report issue',exact:true}).click();
 await page.getByLabel('Bug title').fill('Welcome message is incorrect');
 await page.getByLabel('Steps to reproduce').fill('Steps: submit welcome form.\nExpected: welcome message.\nActual: error.');
 await page.getByRole('button',{name:'Report as issue',exact:true}).click();
 await page.getByRole('link',{name:'QA-42',exact:true}).waitFor();
 assert.equal(jira.calls.filter(call=>call.options.method==='POST').length,1);
 await page.screenshot({path:path.join(storage,'jira-case-details.png'),fullPage:true});
 await page.setViewportSize({width:390,height:900});
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.getByRole('button',{name:'Report issue',exact:true}).click();
 assert.ok(await page.evaluate(()=>document.querySelector('#issue-dialog').getBoundingClientRect().right<=innerWidth));
 await page.getByRole('button',{name:'Cancel',exact:true}).click();
 await api('/api/bug-tracker','DELETE',{});await page.reload();
 await page.getByRole('link',{name:'QA-42',exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'Report issue',exact:true}).count(),0);
 assert.deepEqual(errors,[]);console.log('Jira screenshots: '+storage);
});
