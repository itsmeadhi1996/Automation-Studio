import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createStudio } from './support.mjs';

const admin = { username:'admin', name:'Administrator', password:'Administration-test-password' };
const member = { username:'member', name:'Team member', password:'Member-test-password', permissions:{qa:true,automation:true} };

async function fixture(t, port) {
  const storage = path.resolve('.test-output', 'admin-integrity-'+port+'-'+Date.now());
  let studio = await createStudio({port,storage,authenticated:false});
  await studio.listen();
  t.after(async () => { await studio.close(); await rm(storage,{recursive:true,force:true}).catch(()=>{}); });
  const base = 'http://127.0.0.1:'+port;
  let adminCookie;
  async function api(route, method='GET', body, cookie=adminCookie) {
    const response = await fetch(base+route, {method,headers:{'Content-Type':'application/json',Cookie:cookie||''},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
  }
  await api('/api/auth/setup','POST',admin);
  adminCookie = (await api('/api/auth/login','POST',admin)).cookie;
  const user = (await api('/api/admin/users','POST',member)).data;
  const accounts = async () => (await api('/api/admin/users')).data.users;
  const projects = async () => (await api('/api/admin/projects')).data.projects;
  const saveMembers = (project,userIds) => api('/api/admin/projects/'+project.id+'/members','PUT',{userIds,revision:project.revision});
  return {base,storage,api,user,accounts,projects,saveMembers,get adminCookie(){return adminCookie;},get studio(){return studio;},async restart(edit) {
    await studio.close();
    if(edit)await edit();
    studio=await createStudio({port,storage,authenticated:false});
    await studio.listen();
    adminCookie=(await api('/api/auth/login','POST',admin,'')).cookie;
  }};
}

async function adminPage(t, f) {
  const browser=await chromium.launch();t.after(()=>browser.close());
  const context=await browser.newContext();
  await context.addCookies([{name:'studio_session',value:f.adminCookie.split('=')[1],url:f.base}]);
  const page=await context.newPage();page.setDefaultTimeout(5000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  t.after(()=>assert.deepEqual(errors,[]));
  return page;
}

test('account revisions prevent stale permission and profile saves, including concurrent writes', async t => {
  const f=await fixture(t,3340);
  assert.equal(f.user.revision,1);
  const route='/api/admin/users/'+f.user.id;
  const grants={...member.permissions,createProjects:true,manageMcp:true};
  const saved=await f.api(route+'/permissions','PUT',{permissions:grants,revision:f.user.revision});
  assert.equal(saved.status,200);assert.equal(saved.data.revision,2);
  for(const body of [{name:'Stale profile',permissions:member.permissions},{permissions:member.permissions}]) {
    const response=await f.api(route,'PUT',{...body,revision:f.user.revision});
    assert.equal(response.status,409);assert.match(response.data.error,/changed/i);
  }
  assert.equal((await f.api(route+'/permissions','PUT',{permissions:member.permissions,revision:f.user.revision})).status,409);
  assert.equal((await f.api(route,'PUT',{name:'Invalid revision',revision:'2'})).status,400);
  const concurrent=await Promise.all(['First edit','Second edit'].map(name=>f.api(route,'PUT',{name,revision:saved.data.revision})));
  assert.deepEqual(concurrent.map(result=>result.status).sort(),[200,409]);
  const current=(await f.accounts()).find(user=>user.id===f.user.id);
  assert.equal(current.permissions.createProjects,true);assert.equal(current.permissions.manageMcp,true);
  await f.restart();
  assert.equal((await f.accounts()).find(user=>user.id===f.user.id).revision,current.revision);
});

test('permission dependencies are stored consistently and legacy accounts acquire revisions', async t => {
  const f=await fixture(t,3341),route='/api/admin/users/'+f.user.id+'/permissions';
  let result=await f.api(route,'PUT',{permissions:{qa:true,automation:true,createProjects:true,manageMcp:true}});
  assert.equal(result.status,200);assert.equal(result.data.permissions.useMcp,true);
  result=await f.api(route,'PUT',{permissions:{...result.data.permissions,automation:false}});
  assert.equal(result.data.permissions.manageMcp,false);assert.equal(result.data.permissions.useMcp,false);
  assert.equal(result.data.permissions.createProjects,true);
  result=await f.api(route,'PUT',{permissions:{...result.data.permissions,qa:false}});
  assert.equal(result.data.permissions.createProjects,false);
  result=await f.api(route,'PUT',{permissions:{...result.data.permissions,automation:true}});
  assert.equal(result.data.effectivePermissions.manageMcp,false);assert.equal(result.data.effectivePermissions.createProjects,false);
  await f.restart(async()=>{
    const file=path.join(f.storage,'data','users.json'),saved=JSON.parse(await readFile(file,'utf8'));
    for(const user of saved.users)delete user.revision;
    await writeFile(file,JSON.stringify(saved));
  });
  const legacy=(await f.accounts()).find(user=>user.id===f.user.id);
  assert.equal(legacy.revision,1);
  assert.equal((await f.api(route,'PUT',{permissions:{qa:true},revision:legacy.revision})).data.revision,2);
});

test('project revisions are independent, stale assignments conflict and access data stays encrypted', async t => {
  const f=await fixture(t,3342);
  await f.api('/api/projects','POST',{name:'Second project'});
  const [first,second]=await f.projects();
  assert.equal((await f.saveMembers(first,[f.user.id])).status,200);
  assert.equal((await f.saveMembers(second,[f.user.id])).status,200,'Another project must not invalidate this assignment form');
  assert.equal((await f.saveMembers(first,[])).status,409);
  const next=(await f.projects())[0];
  const concurrent=await Promise.all([f.saveMembers(next,[]),f.saveMembers(next,[f.user.id])]);
  assert.deepEqual(concurrent.map(result=>result.status).sort(),[200,409]);
  const before=await f.projects();
  const stored=JSON.parse(await readFile(path.join(f.storage,'data','studio.json'),'utf8'));
  assert.equal(typeof stored.projectMembers.$sealed,'string');
  assert.equal(typeof stored.workLog.$sealed,'string');
  await f.restart();
  assert.deepEqual((await f.projects()).map(p=>[p.id,p.memberIds,p.revision]),before.map(p=>[p.id,p.memberIds,p.revision]));
  assert.ok((await f.api('/api/admin/work-log')).data.entries.some(entry=>entry.action==='Project access updated'));
});

test('legacy project assignments migrate without losing revisions or grants', async t => {
  const f=await fixture(t,3343),[first]=await f.projects();
  await f.restart(async()=>{
    const file=path.join(f.storage,'data','studio.json'),saved=JSON.parse(await readFile(file,'utf8'));
    delete saved.projectAccessRevisions;saved.projectAccessRevision=7;saved.projectMembers={[first.id]:[f.user.id]};
    await writeFile(file,JSON.stringify(saved));
  });
  const [migrated]=await f.projects();
  assert.equal(migrated.revision,7);assert.deepEqual(migrated.memberIds,[f.user.id]);
  assert.equal((await f.saveMembers(migrated,[])).status,200);
  await f.restart();
  assert.equal((await f.projects())[0].revision,8);
});

test('working log clamps invalid and outdated page offsets', async t => {
  const f=await fixture(t,3344),[project]=await f.projects();
  f.studio.store.workLog=Array.from({length:56},(_,i)=>({id:String(i),projectId:project.id,userId:f.user.id,userName:member.name,projectName:project.name,action:'Project updated',outcome:'Succeeded',at:new Date().toISOString()}));
  for(const offset of ['500','Infinity','1.5','-50','invalid']) {
    const {data}=await f.api('/api/admin/work-log?offset='+offset);
    assert.equal(data.offset,offset==='500'?50:0);
    assert.equal(data.entries.length,offset==='500'?6:50);
  }
  const empty=(await f.api('/api/admin/work-log?action=Missing&offset=50')).data;
  assert.equal(empty.offset,0);assert.deepEqual(empty.entries,[]);
});

test('permission form locks pending saves, detects conflicts and refreshes current grants', {timeout:30000}, async t => {
  const f=await fixture(t,3345),page=await adminPage(t,f);
  await page.goto(f.base+'/admin/permissions?user='+f.user.id);
  const create=page.getByRole('checkbox',{name:/^Create projects/});
  await create.check();
  let release,arrived;
  const gate=new Promise(resolve=>release=resolve),pending=new Promise(resolve=>arrived=resolve);
  await page.route('**/api/admin/users/*/permissions',async route=>{arrived();await gate;await route.continue();});
  await page.getByRole('button',{name:'Save permissions'}).click();await pending;
  try {
    assert.equal(await create.isDisabled(),true);
    assert.equal(await page.locator('#permission-user').isDisabled(),true);
    assert.equal(await page.getByRole('button',{name:'Refresh users'}).isDisabled(),true);
  } finally {release();}
  await page.getByRole('status').filter({hasText:'Permissions saved'}).waitFor();
  await page.unroute('**/api/admin/users/*/permissions');
  await f.api('/api/admin/users/'+f.user.id+'/permissions','PUT',{permissions:member.permissions});
  await page.getByRole('button',{name:'Save permissions'}).click();
  await page.getByRole('alert').filter({hasText:/changed/i}).waitFor();
  assert.equal((await f.accounts()).find(user=>user.id===f.user.id).permissions.createProjects,false);
  await page.getByRole('button',{name:'Refresh users'}).click();
  await page.waitForFunction(()=>!document.querySelector('#save-permissions').disabled&&!document.querySelector('[name="createProjects"]').checked);
});

test('user editing cannot silently overwrite newer grants from the Permissions page', {timeout:30000}, async t => {
  const f=await fixture(t,3346),page=await adminPage(t,f);
  await page.goto(f.base+'/admin');
  await page.getByRole('button',{name:'Edit member',exact:true}).click();
  await f.api('/api/admin/users/'+f.user.id+'/permissions','PUT',{permissions:{...member.permissions,createProjects:true}});
  await page.getByLabel('Display name').fill('Changed display name');
  await page.getByRole('button',{name:'Save changes',exact:true}).click();
  await page.getByRole('alert').filter({hasText:/changed/i}).waitFor();
  assert.equal((await f.accounts()).find(user=>user.id===f.user.id).permissions.createProjects,true);
  await page.getByRole('button',{name:'Edit member',exact:true}).click();
  await page.getByLabel('Display name').fill('Changed display name');
  await page.getByRole('button',{name:'Save changes',exact:true}).click();
  await page.getByRole('status').filter({hasText:'User updated'}).waitFor();
  assert.equal((await f.accounts()).find(user=>user.id===f.user.id).permissions.createProjects,true);
});

test('project form stays locked during saves and a log failure does not hide saved access', {timeout:30000}, async t => {
  const f=await fixture(t,3347),page=await adminPage(t,f);
  await f.api('/api/projects','POST',{name:'Second project'});
  const second=(await f.projects())[1];
  await page.goto(f.base+'/admin/projects?projectId='+second.id);
  const assignment=page.getByRole('checkbox',{name:'Project access for member'});
  await assignment.check();
  assert.equal(await page.locator('#managed-project').inputValue(),second.id);
  let release,arrived;
  const gate=new Promise(resolve=>release=resolve),pending=new Promise(resolve=>arrived=resolve);
  await page.route('**/api/admin/projects/*/members',async route=>{arrived();await gate;await route.continue();});
  await page.route('**/api/admin/work-log?**',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Log temporarily unavailable'})}));
  await page.getByRole('button',{name:'Save project access'}).click();await pending;
  try {
    assert.equal(await assignment.isDisabled(),true);
    assert.equal(await page.getByRole('button',{name:'Refresh',exact:true}).isDisabled(),true);
    assert.equal(await page.locator('#managed-project').isDisabled(),true);
  } finally {release();}
  await page.getByRole('status').filter({hasText:'Project access saved'}).waitFor();
  await page.getByRole('alert').filter({hasText:'Log temporarily unavailable'}).waitFor();
  assert.deepEqual((await f.projects()).find(p=>p.id===second.id).memberIds,[f.user.id]);
  assert.equal(await assignment.isChecked(),true);
  assert.equal(await assignment.isDisabled(),false);
  assert.match(await page.locator('#effective-access').innerText(),/Team member/);
});

test('project restores retain current assignments, revisions and the working log', async t => {
  const f=await fixture(t,3348),[project]=await f.projects();
  const backup=(await f.api('/api/backups','POST',{})).data.name;
  assert.equal((await f.saveMembers(project,[f.user.id])).status,200);
  const current=(await f.projects())[0],log=(await f.api('/api/admin/work-log')).data.entries;
  assert.equal((await f.api('/api/backups/restore','POST',{name:backup})).status,200);
  const restored=(await f.projects())[0];
  assert.deepEqual(restored.memberIds,current.memberIds);assert.equal(restored.revision,current.revision);
  assert.deepEqual((await f.api('/api/admin/work-log')).data.entries,log);
  const newBackup=(await f.api('/api/backups','POST',{})).data.name;
  const stored=JSON.parse(await readFile(path.join(f.storage,'data',newBackup),'utf8'));
  assert.equal(typeof stored.projectMembers.$sealed,'string');assert.equal(typeof stored.workLog.$sealed,'string');
});

test('project conflicts recover through Refresh and log pagination reflects the displayed page', {timeout:30000}, async t => {
  const f=await fixture(t,3349),page=await adminPage(t,f),[project]=await f.projects();
  f.studio.store.workLog=Array.from({length:56},(_,i)=>({id:String(i),projectId:project.id,userId:f.user.id,userName:member.name,projectName:project.name,action:'Project updated',outcome:'Succeeded',at:new Date().toISOString()}));
  await page.goto(f.base+'/admin/projects');
  await page.getByText('1-50 of 56',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Next',exact:true}).click();
  await page.getByText('51-56 of 56',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Next',exact:true}).isDisabled(),true);
  // A changed/retained log can shrink underneath an already-open page.
  f.studio.store.workLog=f.studio.store.workLog.slice(0,1);
  await page.getByRole('button',{name:'Refresh',exact:true}).click();
  await page.getByText('1-1 of 1',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Previous',exact:true}).isDisabled(),true);
  assert.equal((await f.saveMembers(project,[f.user.id])).status,200);
  await page.getByRole('button',{name:'Save project access'}).click();
  await page.getByRole('alert').filter({hasText:'Project assignments changed'}).waitFor();
  assert.deepEqual((await f.projects())[0].memberIds,[f.user.id]);
  await page.getByRole('button',{name:'Refresh',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('#managed-project').disabled&&document.querySelector('input[name="member"]:not([data-admin="true"])').checked);
  await page.getByRole('checkbox',{name:'Project access for member'}).uncheck();
  await page.getByRole('button',{name:'Save project access'}).click();
  await page.getByRole('status').filter({hasText:'Project access saved'}).waitFor();
  assert.deepEqual((await f.projects())[0].memberIds,[]);
});
