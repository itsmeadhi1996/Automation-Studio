import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import http from 'node:http';
import {chromium} from 'playwright';
import {createStudio} from './support.mjs';
import {can, publicUser} from '../auth.mjs';

const admin={username:'admin',name:'Administrator',password:'Administrator-password'};
const member={username:'member',name:'Team member',password:'Team-member-password',permissions:{qa:true,automation:true}};
async function fixture(t,port){
 const storage=path.resolve('.test-output','permissions-'+port+'-'+Date.now()),studio=await createStudio({port,storage,authenticated:false});await studio.listen();t.after(()=>studio.close());
 const base='http://127.0.0.1:'+port;
 const api=async(route,method='GET',body,cookie='')=>{const response=await fetch(base+route,{method,headers:{'Content-Type':'application/json',Cookie:cookie},body:body===undefined?undefined:JSON.stringify(body),redirect:'manual'});const raw=await response.text();let data;try{data=JSON.parse(raw);}catch{data=raw;}return {status:response.status,data,cookie:response.headers.get('set-cookie')?.split(';')[0]};};
 const login=async account=>{const response=await api('/api/auth/login','POST',account);assert.equal(response.status,200,JSON.stringify(response.data));return response.cookie;};
 assert.equal((await api('/api/auth/setup','POST',admin)).status,201);const adminCookie=await login(admin);
 const created=await api('/api/admin/users','POST',member,adminCookie);assert.equal(created.status,201);
 const projects=(await api('/api/admin/projects','GET',undefined,adminCookie)).data.projects;assert.equal((await api('/api/admin/projects/'+projects[0].id+'/members','PUT',{userIds:[created.data.id],revision:projects[0].revision},adminCookie)).status,200);
 return {api,login,adminCookie,user:created.data,base,storage,studio};
}
async function mcpFixture(t){
 let calls=0;const server=http.createServer(async(req,res)=>{
  if(req.method!=='POST'){res.writeHead(405).end();return;}
  let raw='';for await(const chunk of req)raw+=chunk;const request=JSON.parse(raw);
  if(request.id===undefined){res.writeHead(202).end();return;}
  let result;
  if(request.method==='initialize')result={protocolVersion:request.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'Controlled fixture',version:'1'}};
  else if(request.method==='tools/list')result={tools:[{name:'read_status',inputSchema:{type:'object'},annotations:{readOnlyHint:true}}]};
  else if(request.method==='tools/call'){calls++;result={content:[{type:'text',text:'Connected'}]};}
  else{res.writeHead(400).end();return;}
  res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:request.id,result}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
 return {url:'http://127.0.0.1:'+server.address().port+'/mcp',get calls(){return calls;}};
}

test('legacy users default to no project or MCP grants and studio prerequisites apply',()=>{
 const legacy={role:'user',active:true,permissions:{qa:true,automation:true}};
 for(const permission of ['createProjects','useMcp','manageMcp'])assert.equal(can(legacy,permission),false);
 assert.equal(publicUser(legacy).permissions.manageMcp,false);
 assert.equal(can({...legacy,permissions:{qa:true,manageMcp:true}},'manageMcp'),false);
 assert.equal(can({...legacy,permissions:{automation:true,manageMcp:true}},'useMcp'),true);
 assert.equal(can({...legacy,role:'admin'},'manageMcp'),true);
});

test('feature grants enforce project and MCP access without granting application administration',{timeout:45000},async t=>{
 const f=await fixture(t,3311),mock=await mcpFixture(t),{api,adminCookie}=f;
 const configured={id:'controlled',name:'Admin connection',transport:'http',url:mock.url,authType:'none'};
 assert.equal((await api('/api/mcp/servers','PUT',{mcpServers:[configured]},adminCookie)).status,200);
 let cookie=await f.login(member);
 assert.equal((await api('/api/projects','POST',{name:'Forbidden'},cookie)).status,403);
 assert.equal((await api('/api/admin/permissions','GET',undefined,cookie)).status,403);
 assert.equal((await api('/admin/permissions','GET',undefined,cookie)).status,403);
 assert.equal((await api('/api/admin/users/'+f.user.id+'/permissions','PUT',{permissions:{manageMcp:true}},cookie)).status,403);
 for(const action of ['tools','call','reconnect'])assert.equal((await api('/api/mcp/controlled/'+action,'POST',{name:'read_status',arguments:{}},cookie)).status,403);
 assert.equal((await api('/api/mcp/servers','PUT',{mcpServers:[]},cookie)).status,403);
 assert.equal((await api('/api/mcp/presets/playwright','POST',{},cookie)).status,403);
 assert.deepEqual((await api('/api/settings','GET',undefined,cookie)).data.mcpServers,[]);
 const project=(await api('/api/state','GET',undefined,cookie)).data.projects[0];
 assert.equal((await api('/api/ai/draft','POST',{projectId:project.id,prompt:'Check the welcome form',mcpServerIds:['controlled']},cookie)).status,403);
 assert.equal(mock.calls,0);
 const grants={qa:true,automation:true,createProjects:true,useMcp:true,manageMcp:false};
 assert.equal((await api('/api/admin/users/'+f.user.id+'/permissions','PUT',{permissions:grants},adminCookie)).status,200);
 assert.equal((await api('/api/state','GET',undefined,cookie)).status,401);
 cookie=await f.login(member);
 assert.equal((await api('/api/projects','POST',{name:'Granted project'},cookie)).status,201);
 assert.equal((await api('/api/mcp/controlled/tools','POST',{},cookie)).status,200);
 assert.equal((await api('/api/mcp/controlled/call','POST',{name:'read_status',arguments:{}},cookie)).status,200);assert.equal(mock.calls,1);
 assert.equal((await api('/api/mcp/controlled/reconnect','POST',{},cookie)).status,200);
 assert.equal((await api('/api/mcp/servers','PUT',{mcpServers:[]},cookie)).status,403);
 assert.equal((await api('/api/settings','PUT',{provider:'groq'},cookie)).status,403);
 assert.equal((await api('/api/admin/users/'+f.user.id+'/permissions','PUT',{permissions:{...grants,manageMcp:true}},adminCookie)).status,200);
 cookie=await f.login(member);
 assert.equal((await api('/api/mcp/servers','PUT',{mcpServers:[{...configured,name:'Managed connection'}]},cookie)).status,200);
 assert.equal((await api('/api/mcp/servers','PUT',{mcpServers:[],provider:'groq'},cookie)).status,400);
 assert.equal((await api('/api/settings','GET',undefined,adminCookie)).data.provider,'google');
 assert.equal((await api('/api/settings','PUT',{provider:'groq'},cookie)).status,403);
 assert.equal((await api('/api/admin/users/'+f.user.id+'/permissions','PUT',{permissions:{qa:true,unknown:true}},adminCookie)).status,400);
 assert.equal((await api('/api/admin/users/'+f.user.id+'/permissions','PUT',{permissions:grants,role:'admin'},adminCookie)).status,400);
 assert.equal((await api('/api/admin/users/'+f.user.id+'/permissions','PUT',{permissions:{qa:true,automation:true}},adminCookie)).status,200);
 assert.equal((await api('/api/mcp/controlled/tools','POST',{},cookie)).status,401);
 cookie=await f.login(member);assert.equal((await api('/api/projects','POST',{name:'Revoked'},cookie)).status,403);
 assert.equal((await api('/api/mcp/controlled/tools','POST',{},cookie)).status,403);
});

test('admin permissions page controls project and MCP UI and preserves grants when editing users',{timeout:60000},async t=>{
 const f=await fixture(t,3312),browser=await chromium.launch();t.after(()=>browser.close());
 const adminContext=await browser.newContext(),userContext=await browser.newContext(),adminPage=await adminContext.newPage(),userPage=await userContext.newPage(),errors=[];
 for(const page of [adminPage,userPage])page.on('pageerror',error=>errors.push(error.message));
 const setCookie=async(context,cookie)=>context.addCookies([{name:'studio_session',value:cookie.slice(cookie.indexOf('=')+1),url:f.base}]);
 await setCookie(adminContext,f.adminCookie);await setCookie(userContext,await f.login(member));
 await userPage.goto(f.base+'/automation');await userPage.getByRole('heading',{name:'Complete the welcome form',exact:true}).waitFor();
 assert.equal(await userPage.locator('[data-action="new-project"]').isVisible(),false);
 assert.equal(await userPage.locator('[data-view="mcp"]').first().isVisible(),false);
 await userPage.goto(f.base+'/');await userPage.getByRole('heading',{name:'Project overview'}).waitFor();assert.equal(await userPage.locator('[data-action="new-project"]').isVisible(),false);
 await adminPage.goto(f.base+'/admin/permissions?user='+f.user.id);await adminPage.getByRole('button',{name:'Save permissions'}).waitFor({state:'visible'});
 await adminPage.waitForFunction(()=>!document.querySelector('#save-permissions').disabled);
 assert.equal(await adminPage.getByRole('checkbox',{name:/^Create projects/}).isChecked(),false);
 assert.equal(await adminPage.getByRole('checkbox',{name:/^Manage MCP connections/}).isChecked(),false);
 await adminPage.getByRole('checkbox',{name:/^Create projects/}).check();
 await adminPage.getByRole('checkbox',{name:/^Manage MCP connections/}).check();
 assert.equal(await adminPage.getByRole('checkbox',{name:/^Use configured MCP servers/}).isChecked(),true);
 await adminPage.getByRole('button',{name:'Save permissions'}).click();await adminPage.getByRole('status').filter({hasText:'Permissions saved'}).waitFor();
 await setCookie(userContext,await f.login(member));await userPage.goto(f.base+'/automation?view=mcp');await userPage.getByRole('heading',{name:'MCP servers',exact:true}).waitFor();
 assert.equal(await userPage.locator('[data-action="new-project"]').isVisible(),true);
 assert.equal(await userPage.getByRole('button',{name:'Add server',exact:true}).isVisible(),true);
 await userPage.getByRole('button',{name:'Add server',exact:true}).click();await userPage.getByLabel('Server name').fill('Team MCP');await userPage.locator('#dialog [name="transport"]').selectOption('http');await userPage.getByLabel('HTTP endpoint').fill('https://mcp.example.test/mcp');await userPage.locator('#dialog-submit').click();await userPage.locator('#dialog').waitFor({state:'hidden'});await userPage.getByRole('heading',{name:/Team MCP/}).waitFor();
 await userPage.locator('[data-action="new-project"]').click();await userPage.getByLabel('Project name',{exact:true}).fill('Team project');await userPage.locator('#dialog-submit').click();await userPage.locator('#dialog').waitFor({state:'hidden'});
 assert.ok((await f.api('/api/state','GET',undefined,f.adminCookie)).data.projects.some(project=>project.name==='Team project'));
 await adminPage.goto(f.base+'/admin');await adminPage.getByRole('button',{name:'Edit member',exact:true}).click();await adminPage.getByLabel('Display name').fill('Renamed member');await adminPage.getByRole('button',{name:'Save changes',exact:true}).click();await adminPage.getByRole('status').filter({hasText:'User updated'}).waitFor();
 const saved=(await f.api('/api/admin/users','GET',undefined,f.adminCookie)).data.users.find(user=>user.id===f.user.id);assert.equal(saved.permissions.createProjects,true);assert.equal(saved.permissions.manageMcp,true);
 await adminPage.goto(f.base+'/admin/permissions?user='+f.user.id);await adminPage.waitForFunction(()=>!document.querySelector('#save-permissions').disabled);
 for(const width of [1365,768,390]){await adminPage.setViewportSize({width,height:950});assert.ok(await adminPage.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Permissions fit viewport '+width);}
 await adminPage.setViewportSize({width:1365,height:950});await adminPage.screenshot({path:path.join(f.storage,'permissions.png'),fullPage:true});
 await adminPage.getByRole('checkbox',{name:/^Manage MCP connections/}).uncheck();await adminPage.getByRole('button',{name:'Save permissions'}).click();await adminPage.getByRole('status').filter({hasText:'Permissions saved'}).waitFor();
 await setCookie(userContext,await f.login(member));await userPage.goto(f.base+'/automation?view=mcp');await userPage.getByRole('heading',{name:'MCP servers',exact:true}).waitFor();
 assert.equal(await userPage.getByRole('button',{name:'Add server',exact:true}).count(),0);
 assert.equal(await userPage.getByRole('button',{name:'Connect & discover',exact:true}).isVisible(),true);
 assert.equal(await userPage.locator('[data-action="edit-mcp"][data-id]').isVisible(),false);
 await adminPage.getByRole('checkbox',{name:/^Use configured MCP servers/}).uncheck();await adminPage.getByRole('checkbox',{name:/^Create projects/}).uncheck();await adminPage.getByRole('button',{name:'Save permissions'}).click();await adminPage.getByRole('status').filter({hasText:'Permissions saved'}).waitFor();
 await setCookie(userContext,await f.login(member));await userPage.goto(f.base+'/automation?view=mcp');await userPage.locator('.tabs').waitFor();await userPage.waitForFunction(()=>globalThis.StudioAuth?.user);
 assert.equal(await userPage.getByRole('heading',{name:'MCP servers',exact:true}).count(),0);
 assert.equal(await userPage.locator('[data-action="new-project"]').isVisible(),false);
 assert.deepEqual(errors,[]);
});
