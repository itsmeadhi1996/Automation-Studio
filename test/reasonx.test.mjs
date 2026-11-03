import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {normalizeIntegrationSettings, publicSettings, draftTest} from '../integrations.mjs';
import {createStudio} from './support.mjs';

const settings=normalizeIntegrationSettings({provider:'reasonx',apiKey:'reasonx-test-secret'});
const project={objects:[],globalVariables:{PASSWORD:'private-value'},environments:[]};
const draft={name:'Welcome',explanation:'Review before running.',steps:[{name:'Open page',action:'navigate',value:'http://localhost:3200/demo',locatorType:'css',target:'',valueMode:'static',replacement:'',framePath:[],qaRequirementId:''}]};
const response=content=>({ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{role:'assistant',content}}]})});

test('ReasonX settings retain separate keys and local endpoint across provider switches',()=>{
  const original=normalizeIntegrationSettings({provider:'groq',apiKey:'groq-secret'});
  const local=normalizeIntegrationSettings({provider:'reasonx',apiKey:'reasonx-test-secret',reasonxBaseUrl:'http://127.0.0.1:8081/v1/'},original);
  assert.equal(local.model,'reasonx-v1');
  assert.equal(local.reasonxBaseUrl,'http://127.0.0.1:8081/v1');
  const other=normalizeIntegrationSettings({provider:'groq'},local);
  assert.equal(other.apiKey,'groq-secret');
  const restored=normalizeIntegrationSettings({provider:'reasonx'},other);
  assert.equal(restored.apiKey,'reasonx-test-secret');
  assert.equal(restored.reasonxBaseUrl,local.reasonxBaseUrl);
  assert.doesNotMatch(JSON.stringify(publicSettings(restored)),/secret|apiKeys/);
  assert.equal(publicSettings(normalizeIntegrationSettings({clearApiKey:true},restored)).hasApiKey,false);
  for(const url of ['https://example.com/v1','http://localhost@evil.test/v1','http://user:pass@localhost/v1','http://localhost/v1?key=secret','http://localhost/v1#fragment','file:///tmp/model']){
    assert.throws(()=>normalizeIntegrationSettings({provider:'reasonx',reasonxBaseUrl:url}),/localhost API URL/);
  }
});

test('ReasonX uses its local chat API without unsupported structured-output fields or prompt secrets',async()=>{
  const result=await draftTest(settings,project,'Open the demo',async(url,options)=>{
    assert.equal(url,'http://127.0.0.1:8080/v1/chat/completions');
    assert.equal(options.redirect,'error');
    assert.equal(options.headers.Authorization,'Bearer reasonx-test-secret');
    const request=JSON.parse(options.body);
    assert.deepEqual(Object.keys(request).sort(),['max_tokens','messages','model','stream']);
    assert.equal(request.model,'reasonx-v1');assert.equal(request.stream,false);
    assert.equal(request.max_tokens,1024);
    assert.match(request.messages[0].content,/No function or tool calls/);
    assert.match(request.messages[1].content,/observed-control/);
    assert.doesNotMatch(options.body,/private-value|reasonx-test-secret/);
    return response('```json\n'+JSON.stringify(draft)+'\n```');
  },{inspection:{elements:[{target:'observed-control',locatorType:'id',matched:true,matchCount:1}]}});
  assert.equal(result.name,'Welcome');assert.equal(result.steps[0].qaRequirementId,undefined);
});

test('ReasonX retries invalid drafts once and never saves malformed or forbidden actions',async()=>{
  let calls=0;
  const valid=await draftTest(settings,project,'Draft',async()=>response(++calls===1?'broken':JSON.stringify(draft)));
  assert.equal(calls,2);assert.equal(valid.name,'Welcome');
  for(const invalid of ['broken',JSON.stringify({...draft,steps:[]}),JSON.stringify({...draft,steps:[{action:'jdbcQuery',value:'DELETE FROM users'}]})]){
    calls=0;
    await assert.rejects(draftTest(settings,project,'Draft',async()=>{calls++;return response(invalid);}),/invalid test draft after an automatic retry/);
    assert.equal(calls,2);
  }
});

test('ReasonX reports API, truncation and connection failures without leaking keys or retrying auth',async()=>{
  for(const status of [401,403]){
    let calls=0;
    await assert.rejects(draftTest(settings,project,'Draft',async()=>{calls++;return{ok:false,status,json:async()=>({error:{message:'reasonx-test-secret'}})};}),/ReasonX rejected the API key/);
    assert.equal(calls,1);
  }
  await assert.rejects(draftTest(settings,project,'Draft',async()=>({ok:false,status:400,json:async()=>({error:{message:'Invalid reasonx-test-secret'}})})),{message:'ReasonX: Invalid [REDACTED]'});
  await assert.rejects(draftTest(settings,project,'Draft',async()=>{throw new Error('Failed reasonx-test-secret');}),error=>/local model server/.test(error.message)&&!error.message.includes('reasonx-test-secret'));
  await assert.rejects(draftTest(settings,project,'Draft',async()=>({ok:true,json:async()=>({choices:[{finish_reason:'length'}]})})),/ReasonX response length/);
  await assert.rejects(draftTest(settings,project,'Draft',async()=>({ok:true,json:async()=>{throw new Error('not JSON');}})),/non-JSON API response/);
  await assert.rejects(draftTest(settings,project,'Draft',()=>assert.fail('No request expected'),{servers:[{name:'Optional tool'}]}),/Connect the selected MCP/);
});

test('ReasonX bridges JSON tool choices to selected read-only MCP tools and includes their results',async()=>{
  const called=[],requests=[];
  const connections={list:async()=>({tools:[
    {name:'lookup',description:'Look up test documentation',annotations:{readOnlyHint:true},inputSchema:{type:'object',properties:{query:{type:'string'}},required:['query']}},
    {name:'write',annotations:{readOnlyHint:false}}, {name:'unmarked'}
  ]}),call:async(server,name,args)=>{called.push({server,name,args});return{content:[{type:'text',text:'The Submit control completes the welcome form.'}]};}};
  const result=await draftTest(settings,project,'Inspect the welcome form and draft steps',async(url,options)=>{
    const body=JSON.parse(options.body);requests.push(body);
    assert.equal(body.tools,undefined);assert.equal(body.response_format,undefined);
    assert.ok(body.messages.reduce((n,m)=>n+m.content.length,0)<=6000);
    assert.ok(body.messages.every(m=>['system','user','assistant'].includes(m.role)));
    if(requests.length===1){assert.doesNotMatch(options.body,/mcp_tool_2|unmarked/);return response(JSON.stringify({tool:'mcp_tool_1',arguments:{query:'welcome'}}));}
    assert.match(options.body,/Submit control/);
    if(requests.length===2)return response('{"done":true}');
    return response(JSON.stringify(draft));
  },{connections,servers:[{id:'docs',name:'Docs'}]});
  assert.equal(requests.length,3);assert.equal(called.length,1);assert.equal(called[0].name,'lookup');
  assert.deepEqual(called[0].args,{query:'welcome'});assert.match(result.explanation,/MCP context: Docs \/ lookup/);
});

test('ReasonX rejects unknown tools and malformed arguments without executing them',async()=>{
  for(const plan of [{tool:'not_enabled',arguments:{}},{tool:'mcp_tool_1',arguments:[]},{tool:'mcp_tool_1',arguments:'{}'}]){
    const connections={list:async()=>({tools:[{name:'lookup',annotations:{readOnlyHint:true}}]}),call:()=>assert.fail('No MCP execution expected')};
    await assert.rejects(draftTest(settings,project,'Draft',async()=>response(JSON.stringify(plan)),{connections,servers:[{name:'Docs'}]}),/not enabled|invalid MCP arguments/);
  }
});

test('ReasonX limits MCP calls, bounds large results, preserves exact locators and discloses shortened context',async()=>{
  let calls=0,requests=0;
  const control={target:'exact-'+ 'x'.repeat(400),locatorType:'id',framePath:['iframe[name="inner"]'],matched:true,matchCount:1,label:'Email'};
  const connections={list:async()=>({tools:[{name:'lookup',annotations:{readOnlyHint:true}}]}),call:async()=>{calls++;return{content:[{type:'text',text:'"\\'.repeat(5000)+'reasonx-test-secret'}]};}};
  const result=await draftTest(settings,project,'Fill Email',async(url,options)=>{
    const body=JSON.parse(options.body);requests++;
    assert.ok(body.messages.reduce((n,m)=>n+m.content.length,0)<=6000);
    assert.doesNotMatch(options.body,/reasonx-test-secret/);
    if(body.messages[0].content.includes('Gather read-only'))return response(JSON.stringify({tool:'mcp_tool_1',arguments:{page:requests}}));
    return response(JSON.stringify({...draft,steps:[draft.steps[0],{action:'fill',element:'control_1',value:'Alex'}]}));
  },{connections,servers:[{name:'Docs'}],inspection:{elements:[control,...Array.from({length:100},(_,i)=>({...control,label:'Other',target:'other-'+i+'x'.repeat(500)}))]}});
  assert.ok(calls<=3);assert.equal(result.steps[1].target,control.target);assert.deepEqual(result.steps[1].framePath,control.framePath);
  assert.equal(result.steps[1].element,undefined);assert.match(result.explanation,/shortened/);assert.match(result.explanation,/omitted/);
});

test('ReasonX preserves MCP failures as context and rejects oversized workflows before calling the model',async()=>{
  let requests=0;
  const connections={list:async()=>({tools:[{name:'lookup',annotations:{readOnlyHint:true}}]}),call:async()=>{throw new Error('Offline reasonx-test-secret');}};
  const result=await draftTest(settings,project,'Draft',async(url,options)=>{
    requests++;assert.doesNotMatch(options.body,/reasonx-test-secret/);
    if(requests===1)return response('{"tool":"mcp_tool_1","arguments":{}}');
    if(requests===2)return response('{"done":true}');
    assert.match(options.body,/Offline/);return response(JSON.stringify(draft));
  },{connections,servers:[{name:'Docs'}]});
  assert.match(result.explanation,/MCP tool failed/);
  await assert.rejects(draftTest(settings,project,'x'.repeat(5900),()=>assert.fail('No request expected')),/local context budget/);
});

test('ReasonX bounds tool rounds and never repeats an identical tool request',async()=>{
  for(const repeat of [false,true]){
    let requests=0,calls=0;
    const connections={list:async()=>({tools:[{name:'lookup',annotations:{readOnlyHint:true}}]}),call:async()=>{calls++;return{content:[{type:'text',text:'Small result'}]};}};
    const result=await draftTest(settings,project,'Draft',async(url,options)=>{
      requests++;
      if(JSON.parse(options.body).messages[0].content.startsWith('Gather'))return response(JSON.stringify({tool:'mcp_tool_1',arguments:{page:repeat?1:requests}}));
      return response(JSON.stringify(draft));
    },{connections,servers:[{name:'Docs'}]});
    assert.equal(calls,repeat?1:3);assert.match(result.explanation,repeat?/Repeated MCP call skipped/:/three calls/);
  }
});

test('ReasonX retries unknown control and requirement references without saving them',async()=>{
  for(const step of [{action:'fill',element:'missing',value:'Alex'},{action:'navigate',value:'http://example.test',qaRequirementId:'invented'}]){
    let calls=0;
    await assert.rejects(draftTest(settings,project,'Draft',async()=>{calls++;return response(JSON.stringify({...draft,steps:[step]}));}),/invalid test draft after an automatic retry/);
    assert.equal(calls,2);
  }
});

test('ReasonX can be selected, saved, reloaded and cleared without exposing its encrypted key',{timeout:30000},async t=>{
  const storage=path.resolve('.test-output','reasonx-ui-'+Date.now());
  const studio=await createStudio({port:3395,storage});let browser;
  t.after(async()=>{await browser?.close();await studio.close();});await studio.listen();
  const base='http://127.0.0.1:'+studio.server.address().port;
  browser=await chromium.launch();const page=await browser.newPage();const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(base+'/automation');
  await page.getByRole('button',{name:'AI Assistance',exact:true}).click();
  await page.getByRole('button',{name:'Use ReasonX agents',exact:true}).click();
  await page.getByRole('heading',{name:'ReasonX automation agent',exact:true}).waitFor();
  assert.equal((await(await fetch(base+'/api/settings')).json()).provider,'reasonx');
  await page.screenshot({path:path.join(storage,'reasonx-ai-assist.png'),fullPage:true});
  await page.getByRole('button',{name:'Model settings'}).click();
  await page.getByLabel('LLM provider').selectOption('reasonx');
  assert.equal(await page.getByLabel('Model',{exact:true}).inputValue(),'reasonx-v1');
  await page.getByLabel('API base URL').fill('http://localhost:8080/v1');
  await page.getByLabel('ReasonX API key').fill('reasonx-test-secret');
  await page.route('**/api/settings',async route=>{
    if(route.request().method()==='PUT')return route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({error:'Choose Google AI Studio, OpenAI, or Groq'})});
    return route.continue();
  });
  await page.getByRole('button',{name:'Save ReasonX connection'}).click();
  await page.locator('[data-connection-error]').filter({hasText:'older server without ReasonX support'}).waitFor();
  assert.equal(await page.getByLabel('ReasonX API key').inputValue(),'reasonx-test-secret');
  assert.equal(await page.getByLabel('LLM provider').inputValue(),'reasonx');
  await page.unroute('**/api/settings');
  await page.getByRole('button',{name:'Save ReasonX connection'}).click();
  await page.waitForFunction(()=>document.querySelector('#ai-api-key')?.placeholder.includes('configured'));
  const publicConfig=await(await fetch(base+'/api/settings')).json();
  assert.equal(publicConfig.provider,'reasonx');assert.equal(publicConfig.hasApiKey,true);
  assert.doesNotMatch(JSON.stringify(publicConfig),/reasonx-test-secret/);
  assert.doesNotMatch(await readFile(path.join(storage,'data/studio.json'),'utf8'),/reasonx-test-secret/);
  await page.reload();
  await page.getByRole('button',{name:'AI Assistance',exact:true}).click();
  await page.getByRole('button',{name:'Model settings'}).click();
  assert.equal(await page.getByLabel('LLM provider').inputValue(),'reasonx');
  assert.equal(await page.getByLabel('API base URL').inputValue(),'http://localhost:8080/v1');
  await page.getByRole('button',{name:'Clear saved key'}).click();
  await page.waitForFunction(()=>document.querySelector('#ai-api-key')?.placeholder.startsWith('rx_'));
  assert.deepEqual(errors,[]);
});

test('ReasonX UI selects a real MCP server, inspects the page and saves validated steps without running them',{timeout:60000},async t=>{
  let requests=0,browser;
  const studio=await createStudio({port:3396,storage:path.resolve('.test-output','reasonx-mcp-'+Date.now()),aiFetcher:async(url,options)=>{
    const body=JSON.parse(options.body);requests++;
    assert.ok(body.messages.reduce((sum,m)=>sum+m.content.length,0)<=6000);
    assert.doesNotMatch(options.body,/submit_form/);
    if(requests===1)return response('{"tool":"mcp_tool_1","arguments":{}}');
    assert.match(options.body,/Welcome form instructions/);
    if(requests===2)return response('{"done":true}');
    const data=JSON.parse(body.messages[1].content).referenceData;
    const control=data.controls.find(el=>el.target==='name');assert.ok(control);
    return response(JSON.stringify({name:'MCP welcome draft',explanation:'Read the welcome instructions.',steps:[{action:'navigate',value:'http://127.0.0.1:3396/demo'},{action:'fill',element:control.id,value:'Alex'}]}));
  }});
  t.after(async()=>{await browser?.close();await studio.close();});await studio.listen();
  const base='http://127.0.0.1:3396';
  const config=await fetch(base+'/api/settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:'reasonx',apiKey:'test-secret',mcpServers:[{id:'docs',name:'Welcome docs',transport:'stdio',command:process.execPath,args:[path.resolve('test/fixtures/reasonx-context-server.mjs')]}],aiMcpServerIds:['docs']})});
  assert.equal(config.status,200);
  browser=await chromium.launch();const page=await browser.newPage();const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/automation?view=ai');
  const checkbox=page.locator('[data-action="toggle-ai-mcp"][data-id="docs"]');
  await page.waitForFunction(()=>document.querySelector('[data-action="toggle-ai-mcp"][data-id="docs"]')?.disabled===false);
  await checkbox.uncheck();await page.waitForFunction(()=>document.querySelector('[data-action="toggle-ai-mcp"]')?.checked===false);
  await checkbox.check();
  await page.waitForFunction(()=>document.querySelector('[data-action="toggle-ai-mcp"]')?.checked===true);
  await page.locator('#ai-prompt').fill('Open '+base+'/demo. Consult welcome_help and fill Your name with Alex.');
  const generated=page.waitForResponse(r=>r.url().endsWith('/api/ai/create'));
  await page.getByRole('button',{name:'Generate test',exact:true}).click();
  const result=await generated;assert.equal(result.status(),201,await result.text());
  const saved=await result.json();
  assert.equal(saved.status,'not_run');assert.equal(saved.test.steps[1].target,'name');
  assert.equal(saved.test.steps[0].name,'Open the “Studio demo” page');
  assert.equal(saved.test.steps[1].name,'Enter text in the “Your name” field');
  assert.match(saved.explanation,/MCP context: Welcome docs \/ welcome_help/);
  assert.equal(studio.store.runs.length,0);assert.equal(requests,3);
  await page.getByRole('button',{name:'Open test editor'}).waitFor();
  await page.getByRole('button',{name:'Open test editor'}).click();
  assert.equal(await page.locator('[data-step="1"][data-key="name"]').inputValue(),'Enter text in the “Your name” field');
  assert.deepEqual(errors,[]);
});
