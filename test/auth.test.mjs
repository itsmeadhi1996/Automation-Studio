import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createStudio } from './support.mjs';

const admin={name:'Workspace admin',username:'admin',password:'A-long-admin-password'};
async function fixture(t,port) {
 const storage=path.resolve('.test-output','auth-'+port+'-'+Date.now());
 let studio=await createStudio({port,storage,authenticated:false});await studio.listen();
 t.after(()=>studio.close());
 const base='http://127.0.0.1:'+port;
 async function api(route,method='GET',body,cookie='',extra={}) {
  const response=await fetch(base+route,{method,headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{}),...extra},body:body===undefined?undefined:JSON.stringify(body),redirect:'manual'});
  const text=await response.text();let data;try{data=JSON.parse(text);}catch{data=text;}
  return {status:response.status,data,cookie:response.headers.get('set-cookie')?.split(';')[0],headers:response.headers};
 }
 const setup=()=>api('/api/auth/setup','POST',admin);
 const login=async account=>{const result=await api('/api/auth/login','POST',account);assert.equal(result.status,200,JSON.stringify(result.data));return result.cookie;};
 return {storage,base,api,setup,login,get studio(){return studio;},restart:async()=>{await studio.close();studio=await createStudio({port,storage,authenticated:false});await studio.listen();}};
}
test('authentication, permissions, revocation and persistent accounts',{timeout:60000},async t=>{
 const f=await fixture(t,3291),{api}=f;
 assert.equal((await api('/api/state')).status,401);
 assert.equal((await api('/artifacts/secret.png')).status,401);
 assert.equal((await api('/automation')).headers.get('location'),'/login');
 assert.equal((await api('/api/auth/session')).data.setupRequired,true);
 const concurrent=await Promise.all([f.setup(),f.setup()]);assert.deepEqual(concurrent.map(r=>r.status).sort(),[201,409]);
 const cookie=await f.login(admin);
 const login=await api('/api/auth/login','POST',admin);assert.match(login.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);
 assert.equal((await api('/api/admin/users','GET',undefined,cookie)).data.users.length,1);
 const create=async(username,permissions)=>{const result=await api('/api/admin/users','POST',{name:username,username,password:'Long-user-password',permissions},cookie);assert.equal(result.status,201);assert.equal(result.data.passwordHash,undefined);return result.data;};
 const qa=await create('qa-user',{qa:true,automation:false}),auto=await create('auto-user',{automation:true,qa:false});
 const both=await create('both-user',{qa:true,automation:true}),none=await create('no-access',{qa:false,automation:false});
 assert.equal((await api('/api/auth/login','POST',{username:none.username,password:'Long-user-password'})).status,401);
 const qaCookie=await f.login({username:qa.username,password:'Long-user-password'});
 const autoCookie=await f.login({username:auto.username,password:'Long-user-password'});
 const bothCookie=await f.login({username:both.username,password:'Long-user-password'});
 for(const route of ['/api/state','/'])assert.equal((await api(route,'GET',undefined,qaCookie)).status,200);
 for(const route of ['/automation','/api/state?workspace=automation','/api/admin/users'])assert.equal((await api(route,'GET',undefined,qaCookie)).status,403);
 for(const route of ['/api/runs','/api/automation/handoff','/api/debug','/api/recordings','/api/inspect','/api/preflight','/api/jdbc/query'])assert.equal((await api(route,'POST',{},qaCookie)).status,403,route);
 assert.equal((await api('/api/settings','PUT',{},bothCookie)).status,403);
 assert.equal((await api('/api/backups','POST',{},bothCookie)).status,403);
 assert.equal((await api('/api/vpn','GET',undefined,bothCookie)).status,403);
 assert.equal((await api('/','GET',undefined,autoCookie)).status,403);
 assert.equal((await api('/api/state','GET',undefined,autoCookie)).status,403);
 assert.equal((await api('/api/manual-runs','POST',{},autoCookie)).status,403);
 assert.equal((await api('/api/state?workspace=automation','GET',undefined,autoCookie)).status,200);
 assert.equal((await api('/api/state?workspace=automation','GET',undefined,bothCookie)).status,200);
 assert.equal((await api('/api/admin/users','POST',{},cookie,{Origin:'https://attacker.example'})).status,403);
 const assignments=(await api('/api/admin/projects','GET',undefined,cookie)).data.projects[0];assert.equal((await api('/api/admin/projects/'+assignments.id+'/members','PUT',{userIds:[qa.id,auto.id,both.id],revision:assignments.revision},cookie)).status,200);
 let project=(await api('/api/state','GET',undefined,qaCookie)).data.projects[0];
 const original=structuredClone(project);
 project.tests[0].steps=[{action:'navigate',value:'https://attacker.example'}];
 project.globalVariables={INJECTED:'value'};project.tests[0].qa.description='QA edit';
 const save=await api('/api/projects/'+project.id,'PUT',project,qaCookie);assert.equal(save.status,200,JSON.stringify(save.data));
 assert.deepEqual(save.data.tests[0].steps,original.tests[0].steps);
 assert.deepEqual(save.data.globalVariables,original.globalVariables);
 assert.equal(save.data.tests[0].qa.description,'QA edit');
 assert.equal((await api('/api/projects/'+project.id,'PUT',{...save.data,workspace:'automation'},qaCookie)).status,403);
 const root=(await api('/api/admin/users','GET',undefined,cookie)).data.users.find(u=>u.role==='admin');
 assert.equal((await api('/api/admin/users/'+root.id,'PUT',{active:false},cookie)).status,409);
 assert.equal((await api('/api/admin/users/'+root.id,'PUT',{role:'user'},cookie)).status,409);
 assert.equal((await api('/api/admin/users/'+qa.id,'PUT',{permissions:{qa:false,automation:true}},cookie)).status,200);
 assert.equal((await api('/api/state','GET',undefined,qaCookie)).status,401);
 const changed=await f.login({username:qa.username,password:'Long-user-password'});
 assert.equal((await api('/api/state','GET',undefined,changed)).status,403);
 assert.equal((await api('/api/admin/users/'+qa.id,'PUT',{active:false},cookie)).status,200);
 assert.equal((await api('/api/state?workspace=automation','GET',undefined,changed)).status,401);
 assert.equal((await api('/api/auth/login','POST',{username:qa.username,password:'Long-user-password'})).status,401);
 assert.equal((await api('/api/auth/password','PUT',{currentPassword:'wrong',password:'Replacement-password'},autoCookie)).status,400);
 assert.equal((await api('/api/auth/password','PUT',{currentPassword:'Long-user-password',password:'Replacement-password'},autoCookie)).status,200);
 assert.equal((await api('/api/state?workspace=automation','GET',undefined,autoCookie)).status,401);
 const replaced=await f.login({username:auto.username,password:'Replacement-password'});
 await api('/api/auth/logout','POST',{},replaced);
 assert.equal((await api('/api/state?workspace=automation','GET',undefined,replaced)).status,401);
 const saved=await readFile(path.join(f.storage,'data/users.json'),'utf8');assert.ok(!saved.includes(admin.password));assert.ok(!saved.includes('Long-user-password'));
 await f.restart();
 assert.equal((await api('/api/admin/users','GET',undefined,cookie)).status,401);
 assert.equal((await api('/api/auth/session')).data.setupRequired,false);
 const fresh=await f.login(admin);assert.equal((await api('/api/admin/users','GET',undefined,fresh)).data.users.length,5);
});
test('login throttles repeated failed attempts',async t=>{
 const f=await fixture(t,3292);await f.setup();
 for(let i=0;i<15;i++)assert.equal((await f.api('/api/auth/login','POST',{username:'missing',password:'wrong'})).status,401);
 assert.equal((await f.api('/api/auth/login','POST',admin)).status,429);
});
test('browser setup, admin user management, studio access and logout',{timeout:90000},async t=>{
 const f=await fixture(t,3293),browser=await chromium.launch();t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:1365,height:950}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(f.base);await page.getByRole('heading',{name:'Create your administrator'}).waitFor();
 await page.getByLabel('Display name').fill(admin.name);await page.getByLabel('Username').fill(admin.username);await page.getByLabel('Password',{exact:true}).fill(admin.password);await page.getByLabel('Confirm password').fill(admin.password);
 await page.getByRole('button',{name:'Create administrator'}).click();await page.waitForURL('**/admin');
 await page.getByLabel('Display name').fill('QA colleague');await page.getByLabel('Username').fill('colleague');await page.getByLabel('Password',{exact:true}).fill('A-colleague-password');
 await page.getByLabel('QA Studio — cases and manual testing').check();await page.getByRole('button',{name:'Create user',exact:true}).click();
 await page.getByRole('button',{name:'Edit colleague',exact:true}).waitFor();
 await page.screenshot({path:path.join(f.storage,'admin.png'),fullPage:true});
 await page.getByRole('button',{name:'Sign out',exact:true}).click();await page.waitForURL('**/login');
 await page.getByLabel('Username').fill('colleague');await page.getByLabel('Password',{exact:true}).fill('A-colleague-password');await page.getByRole('button',{name:'Sign in',exact:true}).click();
 await page.getByRole('heading',{name:'No project access assigned'}).waitFor();
 assert.equal(await page.getByRole('link',{name:'Automation Studio',exact:true}).count(),0);
 await page.getByRole('link',{name:'My account',exact:true}).click();await page.getByRole('heading',{name:'QA colleague'}).waitFor();
 await page.getByLabel('Current password').fill('A-colleague-password');await page.getByLabel('New password',{exact:true}).fill('A-new-colleague-password');await page.getByLabel('Confirm new password').fill('A-new-colleague-password');await page.getByRole('button',{name:'Change password',exact:true}).click();await page.waitForURL('**/login');
 assert.deepEqual(errors,[]);
});
test('CLI credentials authenticate and revoked schedule owners cannot execute',{timeout:30000},async t=>{
 const f=await fixture(t,3294);f.studio.store.projects[0].tests.forEach(test=>test.inTestPlan=true);await f.setup();const adminCookie=await f.login(admin);
 const created=await f.api('/api/admin/users','POST',{name:'Scheduled runner',username:'runner-user',password:'Scheduled-runner-password',permissions:{automation:true}},adminCookie);
 assert.equal(created.status,201);
 const p=(await f.api('/api/admin/projects','GET',undefined,adminCookie)).data.projects[0];assert.equal((await f.api('/api/admin/projects/'+p.id+'/members','PUT',{userIds:[created.data.id],revision:p.revision},adminCookie)).status,200);
 const keys=['STUDIO_USERNAME','STUDIO_PASSWORD','STUDIO_SESSION_TOKEN'],previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
 try {
  process.env.STUDIO_USERNAME='runner-user';process.env.STUDIO_PASSWORD='Scheduled-runner-password';delete process.env.STUDIO_SESSION_TOKEN;
  const {studioHeaders}=await import('../auth-client.mjs'),headers=await studioHeaders(f.base);
  const state=await f.api('/api/state?workspace=automation','GET',undefined,'',headers);assert.equal(state.status,200);
  const project=state.data.projects[0];
  assert.equal((await f.api('/api/preflight','POST',{projectId:project.id,testId:project.tests[0].id},'',headers)).status,200);
  const scheduled=await f.api('/api/schedules','POST',{projectId:project.id,testId:project.tests[0].id,intervalMinutes:60},'',headers);
  assert.equal(scheduled.status,201);assert.equal(scheduled.data.ownerId,created.data.id);
  assert.equal((await f.api('/api/admin/users/'+created.data.id,'PUT',{password:'Reset-runner-password',active:false},adminCookie)).status,200);
  assert.equal((await f.api('/api/state?workspace=automation','GET',undefined,'',headers)).status,401);
  f.studio.store.schedules[0].nextRunAt=new Date(0).toISOString();await f.studio.tickSchedules();
  assert.equal(f.studio.store.schedules[0].enabled,false);assert.equal(f.studio.store.runs.length,0);
  assert.equal((await f.api('/api/admin/users/'+created.data.id,'PUT',{active:true},adminCookie)).status,200);
  assert.equal((await f.api('/api/auth/login','POST',{username:'runner-user',password:'Scheduled-runner-password'})).status,401);
  await f.login({username:'runner-user',password:'Reset-runner-password'});
 } finally {for(const key of keys)if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}
});
