import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { generateTestCases, generationOutputSchema } from '../test-case-generator.mjs';

test('real stdio server advertises schemas, returns structured cases, rejects invalid calls and needs no backend or credentials',{timeout:20000},async t=>{
  const transport=new StdioClientTransport({command:process.execPath,args:[path.resolve('test-case-mcp.mjs')],env:{STUDIO_URL:'http://127.0.0.1:1',STUDIO_USERNAME:'ignored-user',STUDIO_PASSWORD:'do-not-log-this-password',OPENAI_API_KEY:'do-not-log-this-key'},stderr:'pipe'});
  let stderr='';transport.stderr?.on('data',data=>stderr+=data.toString());
  const client=new Client({name:'test-case-test-client',version:'1.0.0'});t.after(()=>client.close());await client.connect(transport);
  const {tools}=await client.listTools();assert.deepEqual(tools.map(t=>t.name),['generate_test_cases']);
  const tool=tools[0];assert.ok(tool.inputSchema.required.includes('requirement'));assert.ok(tool.outputSchema.properties.testCases);assert.equal(tool.annotations.openWorldHint,false);assert.equal(tool.annotations.readOnlyHint,true);
  const input={requirement:'Email is required.',moduleName:'Registration',pageMetadata:{fields:[{name:'Email',type:'email',constraints:{required:true}}]},categories:['Validation','Negative']};
  const result=await client.callTool({name:'generate_test_cases',arguments:input});assert.ok(!result.isError);assert.deepEqual(result.structuredContent,generateTestCases(input));assert.ok(generationOutputSchema.safeParse(result.structuredContent).success);assert.deepEqual(JSON.parse(result.content[0].text),result.structuredContent);
  assert.deepEqual((await client.callTool({name:'generate_test_cases',arguments:input})).structuredContent,result.structuredContent);
  for(const args of [{},{requirement:' '},{requirement:'Register',categories:['Unknown']},{requirement:'Register',pageMetadata:{fields:'bad'}}])assert.equal((await client.callTool({name:'generate_test_cases',arguments:args})).isError,true);
  const conflict=await client.callTool({name:'generate_test_cases',arguments:{requirement:'Email is required.',pageMetadata:{fields:[{name:'Email',constraints:{required:false}}]}}});assert.ok(!conflict.isError);assert.match(conflict.structuredContent.warnings.join(' '),/required follows requirement description/);assert.ok(conflict.structuredContent.testCases.some(c=>c.title==='Email: required value is missing'));
  for(const pageMetadata of [null,'{}',{fields:null},{title:'Example page',fields:[{name:'Email',type:'email'}]}]){
    const normalized=await client.callTool({name:'generate_test_cases',arguments:{requirement:input.requirement,pageMetadata}});assert.ok(!normalized.isError,JSON.stringify(normalized.content));assert.ok(generationOutputSchema.safeParse(normalized.structuredContent).success);
  }
  assert.ok(!(await client.callTool({name:'generate_test_cases',arguments:input})).isError);await client.close();assert.equal(stderr,'');
});

const STUDIO_TOOLS = ['generate_test_cases', 'studio_ai_draft_test', 'studio_ai_status', 'studio_create_test', 'studio_get_run', 'studio_get_test', 'studio_inspect_page', 'studio_list_projects', 'studio_run'];

async function connectStudioServer(t, env) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve('mcp-server.mjs')], env, stderr: 'pipe' });
  const client = new Client({ name: 'studio-bridge-test-client', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  return client;
}

test('the Studio bridge lists exactly nine tools with no server running, even with credentials set', { timeout: 20000 }, async t => {
  const client = await connectStudioServer(t, { STUDIO_URL: 'http://127.0.0.1:1', STUDIO_USERNAME: 'ignored-user', STUDIO_PASSWORD: 'not-a-real-password' });
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), STUDIO_TOOLS);
  const annotations = name => tools.find(tool => tool.name === name).annotations;
  assert.equal(annotations('studio_ai_status').readOnlyHint, true);
  assert.equal(annotations('studio_ai_draft_test').readOnlyHint, true);
  assert.equal(annotations('studio_create_test').readOnlyHint, false);
  assert.equal(annotations('studio_create_test').destructiveHint, false);
  assert.equal(annotations('studio_run').destructiveHint, true);
  const description = name => tools.find(tool => tool.name === name).description;
  assert.match(description('studio_create_test'), /Does not run the test/);
  assert.match(description('studio_run'), /Use only when the user requests execution/);
  const generated = await client.callTool({ name: 'generate_test_cases', arguments: { requirement: 'Email is required.' } });
  assert.ok(!generated.isError);
  assert.ok(generated.structuredContent.testCases.length > 0);
  const offline = await client.callTool({ name: 'studio_ai_status', arguments: {} });
  assert.equal(offline.isError, true);
});

test('the Studio bridge sends each tool to its route and reports Studio errors', { timeout: 20000 }, async t => {
  const seen = [];
  const project = { id: 'p1', name: 'Getting started', suites: [], tests: [{ id: 't1', tcNumber: 'TC-1', name: 'Sign in', suiteId: 's1', inTestPlan: true, steps: [{ name: 'Open' }] }] };
  const studio = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      seen.push({ route: `${req.method} ${req.url}`, authorization: req.headers.authorization, body: body ? JSON.parse(body) : undefined });
      const reply = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
      if (req.url === '/api/state?workspace=automation') return reply(200, { projects: [project] });
      if (req.url === '/api/runs/r%2F1') return reply(200, { id: 'r/1', status: 'passed' });
      if (req.url === '/api/runs/redirect') { res.writeHead(302, { Location: 'http://127.0.0.1:1/' }); return res.end(); }
      if (req.url === '/api/runs/missing') return reply(404, { error: 'Run not found' });
      if (req.url === '/api/runs/html') { res.writeHead(200); return res.end('<html>'); }
      return reply(200, { ok: true, route: req.url });
    });
  });
  await new Promise(resolve => studio.listen(0, '127.0.0.1', resolve));
  t.after(() => studio.close());
  const client = await connectStudioServer(t, { STUDIO_URL: `http://127.0.0.1:${studio.address().port}`, STUDIO_SESSION_TOKEN: 'fake-service-token' });
  const call = (name, args = {}) => client.callTool({ name, arguments: args });

  const listed = await call('studio_list_projects');
  assert.ok(!listed.isError);
  assert.match(listed.content[0].text, /Getting started/);
  assert.deepEqual(JSON.parse(listed.content[0].text)[0].tests[0], { id: 't1', tcNumber: 'TC-1', name: 'Sign in', suiteId: 's1', inTestPlan: true, stepCount: 1 });
  assert.equal(seen[0].authorization, 'Bearer fake-service-token');

  assert.equal(JSON.parse((await call('studio_get_test', { projectId: 'p1', testId: 't1' })).content[0].text).name, 'Sign in');
  const missing = await call('studio_get_test', { projectId: 'p1', testId: 'nope' });
  assert.equal(missing.isError, true);
  assert.equal(missing.content[0].text, 'Test not found');

  const draftInput = { projectId: 'p1', prompt: 'Sign in' };
  const step = { name: 'Open', action: 'navigate', locatorType: 'css', target: '', replacement: '', value: '/', valueMode: 'literal' };
  for (const [name, args, route, body] of [
    ['studio_inspect_page', { projectId: 'p1' }, 'POST /api/inspect', { projectId: 'p1' }],
    ['studio_ai_status', {}, 'GET /api/ai/status', undefined],
    ['studio_ai_draft_test', draftInput, 'POST /api/ai/draft', { ...draftInput, mcpServerIds: [] }],
    ['studio_create_test', { projectId: 'p/1', name: 'New', steps: [step] }, 'POST /api/projects/p%2F1/tests', { name: 'New', steps: [step] }],
    ['studio_run', { projectId: 'p1', testId: 't1' }, 'POST /api/runs', { projectId: 'p1', testId: 't1' }],
  ]) {
    const result = await call(name, args);
    assert.ok(!result.isError, name);
    assert.equal(seen.at(-1).route, route, name);
    assert.deepEqual(seen.at(-1).body, body, name);
  }

  assert.match((await call('studio_get_run', { runId: 'r/1' })).content[0].text, /passed/);
  for (const [runId, message] of [['missing', /^Run not found$/], ['redirect', /redirects are not allowed/], ['html', /unreadable response/]]) {
    const failed = await call('studio_get_run', { runId });
    assert.equal(failed.isError, true, runId);
    assert.match(failed.content[0].text, message);
  }
});
