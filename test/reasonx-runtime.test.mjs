import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { chromium } from 'playwright';
import { createReasonxRuntime } from '../reasonx-runtime.mjs';
import { createStudio } from './support.mjs';

function fixture(overrides={}) {
 const children=[],calls=[];
 const runtime=createReasonxRuntime({home:path.resolve('.test-output','reasonx install'),inspect:async()=>({isFile:()=>true}),pause:async()=>{},attempts:2,
  launch:(...args)=>{calls.push(args);const child=new EventEmitter();child.unref=()=>{};children.push(child);queueMicrotask(()=>child.emit('spawn'));return child;},...overrides});
 return {runtime,children,calls};
}

test('ReasonX start reuses an existing server and concurrent requests share one launch',async()=>{
 const running=fixture();assert.deepEqual(await running.runtime.start(async()=>({reachable:true})),{status:'running',alreadyRunning:true});assert.equal(running.calls.length,0);
 const f=fixture();let probes=0;
 const first=f.runtime.start(async()=>({reachable:++probes>1}));
 assert.equal(f.runtime.start(async()=>{throw Error('second probe must not run');}),first);
 assert.equal((await first).status,'running');assert.equal(f.calls.length,1);
 const [command,args,options]=f.calls[0];assert.ok(command);
 assert.equal(args.at(-1),path.resolve('.test-output','reasonx install','target','reasonx-console.jar'));
 assert.equal(options.cwd,path.resolve('.test-output','reasonx install'));assert.equal(options.shell,false);assert.equal(options.windowsHide,true);
});

test('slow ReasonX startup does not spawn another process, and exited startup can retry',async()=>{
 const f=fixture();assert.equal((await f.runtime.start(async()=>({reachable:false}))).status,'starting');
 assert.equal((await f.runtime.start(async()=>({reachable:false}))).status,'starting');assert.equal(f.calls.length,1);
 f.children[0].emit('exit',1);
 let checks=0;assert.equal((await f.runtime.start(async()=>({reachable:++checks>1}))).status,'running');assert.equal(f.calls.length,2);
});

test('missing installation and Java startup errors are recoverable',async()=>{
 const missing=fixture({inspect:async()=>{throw Error('ENOENT');}});
 await assert.rejects(missing.runtime.start(async()=>({reachable:false})),/REASONX_HOME/);assert.equal(missing.calls.length,0);
 let fails=true;
 const f=fixture({launch:()=>{const child=new EventEmitter();child.unref=()=>{};queueMicrotask(()=>child.emit(fails?'error':'spawn',new Error('ENOENT')));return child;}});
 await assert.rejects(f.runtime.start(async()=>({reachable:false})),/Java 21/);
 fails=false;let checks=0;assert.equal((await f.runtime.start(async()=>({reachable:++checks>1}))).status,'running');
});

test('ReasonX reports a process that exits before readiness',async()=>{
 const f=fixture({pause:async()=>f.children[0].emit('exit',1)});
 await assert.rejects(f.runtime.start(async()=>({reachable:false})),/stopped during startup/);
});

test('AI Assistance starts ReasonX, locks repeat clicks, preserves the workflow, and recovers from errors',{timeout:45000},async t=>{
 let calls=0,release,fail=false;
 const gate=new Promise(resolve=>{release=resolve;});
 const studio=await createStudio({port:3663,storage:path.resolve('.test-output',`reasonx-start-${Date.now()}`),
  reasonxRuntime:{start:async()=>{calls++;if(calls===1)await gate;if(fail)throw Error('Could not start ReasonX. Install Java 21, then try again.');return {status:'running'};}},
  aiFetcher:async()=>({ok:true,status:200,json:async()=>({data:[{id:'reasonx-v1'}]})})});
 t.after(()=>studio.close());await studio.listen();const base='http://127.0.0.1:'+studio.server.address().port;
 const api=async(route,method='GET',body,cookie)=>fetch(base+route,{method,headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)});
 const browser=await chromium.launch();t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(base+'/automation?view=ai');
 await page.getByRole('button',{name:'Turn on ReasonX',exact:true}).waitFor();
 await page.locator('#ai-prompt').fill('Open the customer portal and verify account access.');
 await page.getByRole('button',{name:'Turn on ReasonX',exact:true}).click();
 assert.equal(await page.getByRole('button',{name:'Starting ReasonX...',exact:true}).isDisabled(),true);
 assert.equal(calls,1);release();await page.getByText('ReasonX is running. Select Use ReasonX agents to use it in both studios.',{exact:true}).waitFor();
 assert.match(await page.locator('#ai-prompt').inputValue(),/customer portal/);
 assert.equal((await (await api('/api/settings')).json()).provider,'google');
 await api('/api/settings','PUT',{provider:'reasonx',apiKey:'reasonx-disposable-test-key'});await page.reload();
 await page.getByRole('heading',{name:'ReasonX automation agent',exact:true}).waitFor();
 await page.getByRole('button',{name:'Turn on ReasonX',exact:true}).click();
 await page.getByText('ReasonX is running. Keep Ollama running for generation.',{exact:true}).waitFor();
 fail=true;await page.getByRole('button',{name:'Turn on ReasonX',exact:true}).click();
 await page.getByText('Could not start ReasonX. Install Java 21, then try again.',{exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'Turn on ReasonX',exact:true}).isEnabled(),true);
 for(const width of [1440,390]){await page.setViewportSize({width,height:900});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.resolve('.test-output',`reasonx-start-${width}.png`),fullPage:true});}
 const member={username:'runtime-member',name:'Automation member',password:'Disposable-runtime-member-password',permissions:{qa:true,automation:true}};
 const created=await api('/api/admin/users','POST',member);assert.equal(created.status,201);const user=await created.json();
 const projects=await (await api('/api/admin/projects')).json(),project=projects.projects[0];
 assert.equal((await api('/api/admin/projects/'+project.id+'/members','PUT',{userIds:[user.id],revision:project.revision})).status,200);
 const login=await api('/api/auth/login','POST',member);const cookie=login.headers.get('set-cookie').split(';')[0],before=calls;
 assert.equal((await api('/api/ai/reasonx/start','POST',{},cookie)).status,403);assert.equal(calls,before);
 await page.context().addCookies([{name:cookie.split('=')[0],value:cookie.slice(cookie.indexOf('=')+1),url:base}]);await page.reload();
 await page.getByRole('heading',{name:'AI Assistance',exact:true}).waitFor();await page.waitForFunction(()=>Boolean(window.StudioAuth?.user));
 assert.equal(await page.getByRole('button',{name:'Turn on ReasonX',exact:true}).count(),0);
 assert.deepEqual(errors,[]);
});
