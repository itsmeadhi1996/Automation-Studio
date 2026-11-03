import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {createStudio} from './support.mjs';
import {McpConnections, normalizeIntegrationSettings, publicSettings, aiToolset} from '../integrations.mjs';
import {mcpCatalog, mcpAuthorization} from '../mcp-catalog.mjs';

test('MCP credentials survive edits only for the same endpoint and account',()=>{
  const server={id:'jira',name:'Jira',transport:'http',url:'https://mcp.atlassian.com/v2/mcp?tools=all',authType:'basic',username:'qa@example.com',apiKey:'private-token'};
  const saved=normalizeIntegrationSettings({mcpServers:[server]});
  const visible=publicSettings(saved);
  assert.equal(visible.mcpServers[0].hasApiKey,true);
  assert.doesNotMatch(JSON.stringify(visible),/private-token/);
  const update=changes=>normalizeIntegrationSettings({mcpServers:[{...visible.mcpServers[0],...changes}]},saved).mcpServers[0];
  assert.equal(update({apiKey:''}).apiKey,server.apiKey);
  assert.equal(update({name:'Renamed'}).apiKey,server.apiKey);
  for(const changes of [{url:'https://other.example/mcp'},{username:'other@example.com'},{authType:'bearer'},{clearApiKey:true}])assert.equal(update(changes).apiKey,'');
  assert.equal(update({authType:'none'}).apiKey,undefined);
  assert.throws(()=>update({url:'http://remote.example/mcp'}),/HTTPS/);
  assert.throws(()=>update({username:'bad:name'}),/username/);
  assert.throws(()=>update({apiKey:'bad\nheader'}),/token/);
  assert.throws(()=>mcpAuthorization(update({clearApiKey:true})),/credentials/);
});

async function mockMcp(t){
  const requests=[],control={repeatCursor:false,reject:false};
  const server=http.createServer(async(req,res)=>{
    if(req.method!=='POST'){res.writeHead(405).end();return;}
    let raw='';for await(const chunk of req)raw+=chunk;
    const request=JSON.parse(raw);requests.push({authorization:req.headers.authorization,...request});
    if(control.reject){res.writeHead(401).end('Rejected private-token');return;}
    if(request.id===undefined){res.writeHead(202).end();return;}
    let result;
    if(request.method==='initialize')result={protocolVersion:request.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};
    else if(request.method==='tools/list')result=request.params?.cursor && !control.repeatCursor
      ?{tools:[{name:'create_issue',description:'Create Jira issue',inputSchema:{type:'object'},annotations:{readOnlyHint:false}}]}
      :{tools:[{name:'search_issues',description:'Search Jira',inputSchema:{type:'object'},annotations:{readOnlyHint:true}}],nextCursor:'page-2'};
    else if(request.method==='tools/call')result={content:[{type:'text',text:'Issue QA-1 private-token '+req.headers.authorization}],isError:request.params.arguments.fail===true};
    else {res.writeHead(400).end();return;}
    res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:request.id,result}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  return {url:`http://127.0.0.1:${server.address().port}/mcp`,requests,control};
}

test('HTTP MCP authenticates, paginates, redacts results, reconnects, and limits AI to read-only tools',async t=>{
  const fixture=await mockMcp(t),connections=new McpConnections();t.after(()=>connections.close());
  for(const authType of ['basic','bearer']){
    const config={transport:'http',url:fixture.url,authType,username:'qa@example.com',apiKey:'private-token'};
    const discovered=await connections.list(config);
    assert.deepEqual(discovered.tools.map(tool=>tool.name),['search_issues','create_issue']);
    const result=await connections.call(config,'search_issues',{});
    assert.match(result.content[0].text,/QA-1/);
    assert.doesNotMatch(JSON.stringify(result),/private-token/);
    assert.ok(!JSON.stringify(result).includes(Buffer.from('qa@example.com:private-token').toString('base64')));
    assert.equal((await connections.call(config,'search_issues',{fail:true})).isError,true);
    const ai=await aiToolset(connections,[config]);assert.equal(ai.tools.length,1);
    const before=fixture.requests.filter(r=>r.method==='initialize').length;
    await connections.reconnect(config);
    assert.equal(fixture.requests.filter(r=>r.method==='initialize').length,before+1);
    assert.equal(fixture.requests.at(-1).authorization,mcpAuthorization(config));
  }
  fixture.control.repeatCursor=true;
  await assert.rejects(connections.list({transport:'http',url:fixture.url}),/pagination/);
});

test('failed authentication is redacted and a corrected connection can retry',async t=>{
  const fixture=await mockMcp(t),connections=new McpConnections();t.after(()=>connections.close());
  const config={transport:'http',url:fixture.url,authType:'bearer',apiKey:'private-token'};
  fixture.control.reject=true;
  await assert.rejects(connections.list(config),error=>!error.message.includes('private-token'));
  fixture.control.reject=false;
  assert.equal((await connections.list(config)).tools.length,2);
});

test('catalog UI connects real Playwright and saves Jira MCP credentials encrypted',{timeout:60000},async t=>{
  const storage=path.resolve('.test-output',`mcp-catalog-${Date.now()}`);
  const studio=await createStudio({port:3817,storage});await studio.listen();t.after(()=>studio.close());
  const base=`http://127.0.0.1:${studio.server.address().port}`;
  const api=async(route,method='GET',body)=>{
    const res=await fetch(base+route,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const result=await res.json();assert.equal(res.ok,true,JSON.stringify(result));return result;
  };
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
  const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(base+'/automation?view=mcp');
  await page.getByRole('button',{name:'Add & connect Playwright'}).click();
  await page.locator('.resource-card .mcp-status').filter({hasText:/^Connected$/}).waitFor();
  let settings=await api('/api/settings');
  const playwright=settings.mcpServers.find(s=>s.presetId==='playwright');assert.ok(playwright);
  await api('/api/mcp/presets/playwright','POST',{});
  assert.equal((await api('/api/settings')).mcpServers.length,1);
  // Keep Playwright's browser registry within the disposable sandbox workspace.
  const bootstrap='process.env.PWTEST_SERVER_REGISTRY='+JSON.stringify(path.join(storage,'browser-registry'));
  playwright.args=['--import','data:text/javascript,'+encodeURIComponent(bootstrap),...playwright.args,'--no-sandbox','--executable-path',chromium.executablePath(),'--output-dir',path.join(storage,'mcp-output')];
  await api('/api/settings','PUT',{mcpServers:[playwright]});
  const navigation=await api(`/api/mcp/${playwright.id}/call`,'POST',{name:'browser_navigate',arguments:{url:base+'/demo'}});
  assert.notEqual(navigation.isError,true,JSON.stringify(navigation));
  const snapshot=await api(`/api/mcp/${playwright.id}/call`,'POST',{name:'browser_snapshot',arguments:{}});
  assert.match(JSON.stringify(snapshot),/Your name/);
  await page.getByRole('button',{name:'Set up Atlassian'}).click();
  await page.getByLabel('MCP account email / username').fill('qa@example.com');
  await page.getByLabel('MCP API token',{exact:true}).fill('private-token');
  await page.locator('#dialog button[type="submit"]').click();
  await page.locator('#dialog').waitFor({state:'hidden'});
  settings=await api('/api/settings');
  const jira=settings.mcpServers.find(s=>s.presetId==='atlassian');assert.equal(jira.hasApiKey,true);
  assert.equal(jira.url,mcpCatalog().find(p=>p.id==='atlassian').config.url);
  assert.doesNotMatch(JSON.stringify(settings),/private-token/);
  assert.doesNotMatch(await readFile(path.join(storage,'data/studio.json'),'utf8'),/private-token/);
  const card=page.locator('.resource-card').filter({hasText:'Atlassian MCP'});
  await card.getByRole('button',{name:'Edit',exact:true}).click();
  assert.equal(await page.getByLabel('MCP API token',{exact:true}).inputValue(),'');
  assert.deepEqual(errors,[]);
});
