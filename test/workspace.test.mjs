import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createStudio } from './support.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('workspace browser flow, persistence, execution, reports, and MCP round trip',{timeout:120000},async t=>{
  const port=3217,base=`http://127.0.0.1:${port}`,storage=path.resolve('.test-output',`workspace-${Date.now()}`);
  await mkdir(storage,{recursive:true});const studio=await createStudio({port,storage});studio.store.projects[0].tests.forEach(test=>test.inTestPlan=true);await studio.listen();
  let browser,client;
  t.after(async()=>{await client?.close();await browser?.close();await studio.close();});
  const api=async(route,method='GET',data)=>{const r=await fetch(base+route,{method,headers:{'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});const body=await r.json();if(!r.ok)throw new Error(body.error);return body;};
  const initial=await api('/api/state'),pid=initial.projects[0].id,tid=initial.projects[0].tests[0].id;
  const denied=await fetch(base+'/api/projects',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://example.com'},body:'{}'});assert.equal(denied.status,403);
  browser=await chromium.launch();const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/automation');await page.getByRole('heading',{name:'Complete the welcome form',exact:true}).waitFor();
  await page.getByRole('button',{name:'AI Assistance'}).click();
  await page.getByRole('button',{name:'Model settings'}).click();
  await page.locator('#ai-provider').selectOption('groq');
  assert.equal(await page.locator('#ai-model').inputValue(),'openai/gpt-oss-20b');
  await page.locator('#ai-api-key').fill('groq-browser-test-key');
  await page.getByRole('button',{name:'Save Groq connection'}).click();
  await page.waitForFunction(()=>document.querySelector('#ai-api-key')?.placeholder.includes('configured'));
  const groqSettings=await api('/api/settings');assert.equal(groqSettings.provider,'groq');assert.equal(groqSettings.hasApiKey,true);assert.equal(groqSettings.apiKey,undefined);
  await page.getByRole('button',{name:'Clear saved key'}).click();
  await page.waitForFunction(()=>document.querySelector('#ai-api-key')?.placeholder.startsWith('gsk_'));
  await page.locator('[data-action="view"][data-view="editor"]').first().click();
  await page.screenshot({path:path.join(storage,'desktop.png'),fullPage:true});
  for(const width of [1440,1024,768,390]){await page.setViewportSize({width,height:1000});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`No page overflow at ${width}`);await page.locator('#run-button').first().waitFor({state:'visible'});}
  await page.screenshot({path:path.join(storage,'mobile.png'),fullPage:true});await page.setViewportSize({width:1440,height:1000});
  await page.locator('[data-action="run-suite"]').click();await page.getByText('Smoke suite',{exact:false}).first().waitFor();assert.equal((await api('/api/state')).runs.length,0);
  await page.getByRole('button',{name:'Remove TC-0001 from suite',exact:true}).click();
  const suiteSaved=page.waitForResponse(response=>response.url()===base+'/api/projects/'+pid && response.request().method()==='PUT');
  await page.getByRole('button',{name:/^Save/}).click();assert.equal((await suiteSaved).ok(),true);
  let saved=(await api('/api/state')).projects[0];assert.equal(saved.tests.length,1);assert.equal(saved.tests[0].suiteId,null);assert.equal(saved.tests[0].tcNumber,1);
  await page.locator('.tabs [data-view="editor"]').click();await page.getByLabel('Suite',{exact:true}).selectOption('smoke');
  await page.locator('#run-button').first().click();await page.getByRole('heading',{name:'Run history',exact:true}).waitFor();
  let state;for(let i=0;i<200;i++){state=await api('/api/state');if(!state.activeRun)break;await new Promise(r=>setTimeout(r,100));}
  const run=state.runs[0];assert.equal(run.status,'passed',JSON.stringify(run));assert.equal(run.tests[0].steps.length,4);assert.ok(run.tests[0].steps.every(s=>s.screenshot));
  const html=await(await fetch(base+`/api/runs/${run.id}/report`)).text();assert.match(html,/data:image\/png;base64/);
  const pdf=await(await fetch(base+`/api/runs/${run.id}/report.pdf`)).arrayBuffer();assert.equal(Buffer.from(pdf).subarray(0,4).toString(),'%PDF');
  await page.getByRole('button',{name:'AI Assistance',exact:true}).click();await page.getByRole('heading',{name:'AI Assistance',exact:true}).waitFor();assert.equal(await page.locator('[data-action="generate-ai"]').isDisabled(),true);
  const config={name:'Studio test',transport:'stdio',command:process.execPath,args:[path.resolve('mcp-server.mjs')]};
  client=new Client({name:'studio-integration-test',version:'1.0.0'});await client.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('mcp-server.mjs')],env:{...process.env,STUDIO_URL:base},stderr:'pipe'}));
  const tools=await client.listTools();assert.equal(tools.tools.length,9);assert.equal(tools.tools.find(t=>t.name==='studio_ai_status').annotations.readOnlyHint,true);assert.equal(tools.tools.find(t=>t.name==='studio_ai_draft_test').annotations.readOnlyHint,true);assert.equal(tools.tools.find(t=>t.name==='studio_create_test').annotations.readOnlyHint,false);const listing=await client.callTool({name:'studio_list_projects',arguments:{}});assert.match(listing.content[0].text,/Getting started/);
  const result=await client.callTool({name:'studio_get_run',arguments:{runId:run.id}});assert.match(result.content[0].text,/passed/);
  // An isolated fixture lets the app's outgoing connector discover and call a server.
  const fixture=path.join(storage,'fixture.mjs');await writeFile(fixture,`import {McpServer} from ${JSON.stringify(path.resolve('node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js').replaceAll('\\','/').replace(/^([A-Za-z]:)/,'file:///$1'))};\nimport {StdioServerTransport} from ${JSON.stringify(path.resolve('node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js').replaceAll('\\','/').replace(/^([A-Za-z]:)/,'file:///$1'))};\nconst server=new McpServer({name:'fixture',version:'1'});server.registerTool('hello',{inputSchema:{}},async()=>({content:[{type:'text',text:'Hello Studio'}]}));await server.connect(new StdioServerTransport());`);
  const settings=await api('/api/settings','PUT',{model:'test-model',apiKey:'not-a-live-key',mcpServers:[{...config,args:[fixture]}]});assert.equal(settings.apiKey,undefined);
  const mid=settings.mcpServers[0].id;assert.equal((await api(`/api/mcp/${mid}/tools`,'POST',{})).tools[0].name,'hello');assert.equal((await api(`/api/mcp/${mid}/call`,'POST',{name:'hello',arguments:{}})).content[0].text,'Hello Studio');
  const disk=JSON.parse(await readFile(path.join(storage,'data/studio.json'),'utf8'));assert.equal(disk.projects[0].tests[0].tcNumber,1);assert.equal(disk.runs[0].status,'passed');assert.deepEqual(errors,[]);
  console.log(`Browser artifacts: ${storage}`);
});
