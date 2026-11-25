import test from 'node:test';
import assert from 'node:assert/strict';
import { reasonxChat, reasonxTimeout, reasonxModels, normalizeReasonxMode, ReasonxError } from '../reasonx-client.mjs';
import { normalizeIntegrationSettings, publicSettings } from '../integrations.mjs';
import { runRequirementAgent } from '../requirement-agent.mjs';

const endpoint = 'http://localhost:8080/v1/chat/completions';
const ok = (content, extra = {}) => ({ ok: true, status: 200, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content } }], ...extra }) });
const failure = (status, code, message = 'x') => ({ ok: false, status, json: async () => ({ error: { message, code } }) });
const chat = (fetcher, options = {}) => reasonxChat({ fetcher, endpoint, model: 'reasonx-v1', messages: [{ role: 'user', content: 'hi' }], sleep: async () => {}, ...options });

test('ReasonX requests send the reasoning mode only when chosen and keep max_tokens within 1-1024', async () => {
  const sent = [];
  const fetcher = async (url, init) => { sent.push(JSON.parse(init.body)); return ok('hello', { reasoning: { mode: 'DEEP', backend_model: 'qwen3:8b' } }); };
  const reply = await chat(fetcher, { mode: 'deep', maxTokens: 4096 });
  await chat(fetcher, { mode: 'auto', maxTokens: 0 });
  assert.equal(sent[0].reasoning_mode, 'DEEP');
  assert.equal(sent[0].max_tokens, 1024);
  assert.equal(sent[0].stream, false);
  assert.equal(sent[1].reasoning_mode, undefined);
  assert.equal(sent[1].max_tokens, 512);
  assert.equal(reply.reasoning.backend_model, 'qwen3:8b');
  assert.equal(normalizeReasonxMode('bogus'), 'auto');
  assert.ok(reasonxTimeout('deep') > reasonxTimeout('standard') && reasonxTimeout('standard') > reasonxTimeout('fast'));
  assert.equal(reasonxTimeout('expert'), reasonxTimeout('deep'));
  assert.ok(reasonxTimeout('fast', 'qwen3:14b') > 240000);
});

test('all four complexity tiers reach ReasonX and Auto leaves classification to the server', async () => {
  for (const [mode, backend] of [['fast','qwen3:1.7b'],['standard','qwen3:4b-thinking'],['deep','qwen3:8b'],['expert','qwen3:14b']]) {
    const settings = normalizeIntegrationSettings({provider:'reasonx',reasonxMode:mode.toUpperCase()});
    assert.equal(publicSettings(settings).reasonxMode, mode);
    const reply = await chat(async (url, init) => {
      const body = JSON.parse(init.body);
      assert.equal(body.model, 'reasonx-v1');
      assert.equal(body.reasoning_mode, mode.toUpperCase());
      return ok('Done', {reasoning:{mode:mode.toUpperCase(),backend_model:backend}});
    }, {mode:settings.reasonxMode});
    assert.equal(reply.reasoning.backend_model, backend);
  }
  for (const model of reasonxModels) {
    await chat(async (url, init) => {
      const body = JSON.parse(init.body);
      assert.equal(body.model, model);
      assert.equal(body.reasoning_mode, undefined);
      return ok('Done');
    }, {model,mode:'auto'});
  }
  await chat(async (url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'qwen3:14b');
    assert.equal(body.reasoning_mode, 'FAST');
    return ok('Done');
  }, {model:'qwen3:14b',mode:'fast'});
});

test('ReasonX busy responses are retried and other errors are classified', async () => {
  let calls = 0;
  assert.equal((await chat(async () => ++calls < 3 ? failure(429, 'busy') : ok('done'))).text, 'done');
  calls = 0;
  await assert.rejects(chat(async () => { calls++; return failure(429, 'busy'); }), error => error instanceof ReasonxError && error.kind === 'busy');
  assert.equal(calls, 4);
  for (const [status, code, kind] of [[401, 'x', 'auth'], [422, 'generation_budget_exhausted', 'budget'], [404, 'model_not_found', 'model'], [413, 'x', 'too-large'], [503, 'x', 'upstream'], [400, 'x', 'http']])
    await assert.rejects(chat(async () => failure(status, code)), error => error.kind === kind);
});

test('ReasonX mode is validated, saved and shown with the other model settings', () => {
  const saved = normalizeIntegrationSettings({ provider: 'reasonx', reasonxMode: 'DEEP' });
  assert.equal(saved.reasonxMode, 'deep');
  assert.equal(publicSettings(saved).reasonxMode, 'deep');
  assert.equal(normalizeIntegrationSettings({ model: 'qwen3:8b' }, saved).reasonxMode, 'deep');
  assert.equal(normalizeIntegrationSettings({ provider: 'reasonx' }).reasonxMode, 'auto');
  assert.throws(() => normalizeIntegrationSettings({ provider: 'reasonx', reasonxMode: 'turbo' }), /Auto, Fast, Standard, Deep, or Expert/);
});

test('retired ReasonX selections migrate to automatic routing without changing keys or supported overrides', () => {
  const legacy = {provider:'reasonx',model:'qwen3.5:35b',reasonxMode:'deep',apiKey:'rx_saved',reasonxBaseUrl:'http://127.0.0.1:8081/v1'};
  const migrated = normalizeIntegrationSettings(legacy, legacy);
  assert.equal(migrated.model, 'reasonx-v1');
  assert.equal(migrated.reasonxMode, 'auto');
  assert.equal(migrated.apiKeys.reasonx, 'rx_saved');
  assert.equal(migrated.reasonxBaseUrl, legacy.reasonxBaseUrl);
  for (const model of reasonxModels) {
    const saved = normalizeIntegrationSettings({...legacy,model,reasonxMode:'expert'}, legacy);
    assert.equal(saved.model, model);
    assert.equal(saved.reasonxMode, 'expert');
  }
  assert.equal(normalizeIntegrationSettings({provider:'openai',model:legacy.model}).model, legacy.model);
});

const settings = { provider: 'reasonx', model: 'reasonx-v1', reasonxMode: 'standard', reasonxBaseUrl: 'http://localhost:8080/v1', apiKeys: { reasonx: 'rx_secret_key' } };
const requirement = { title: 'Login', moduleName: 'Auth', description: 'Users sign in with email and password.' };
const caseFor = title => ({ criterion: 'C1', title, priority: 'high', steps: [{ instruction: 'Open the login page', expectedResult: 'Form is shown' }], expectedResult: 'Signed in' });

test('requirement agent gathers read-only MCP context, treats it as untrusted data and reports the backend model', async () => {
  const called = [], bodies = [];
  const connections = {
    list: async () => ({ tools: [{ name: 'lookup', description: 'Find product rules', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }, { name: 'delete', annotations: { readOnlyHint: false } }] }),
    call: async (server, name, args) => { called.push({ name, args }); return { content: [{ type: 'text', text: 'Accounts lock after 5 failed sign-ins. rx_secret_key' }] }; }
  };
  const fetcher = async (url, init) => {
    const body = JSON.parse(init.body); bodies.push(body);
    assert.equal(body.reasoning_mode, 'STANDARD');
    assert.ok(body.max_tokens <= 1024);
    const system = body.messages[0].content, reasoning = { mode: 'STANDARD', backend_model: 'qwen3:4b-thinking' };
    if (system.includes('Gather read-only MCP context')) {
      assert.doesNotMatch(body.messages[1].content, /delete/);
      return ok(called.length ? '{"done":true}' : '{"tool":"mcp_tool_1","arguments":{"query":"lockout"}}', { reasoning });
    }
    if (system.includes('Break the requirement')) {
      assert.match(body.messages[1].content, /untrustedMcpContext/);
      assert.match(body.messages[1].content, /lock after 5/);
      assert.doesNotMatch(body.messages[1].content, /rx_secret_key/);
      return ok(JSON.stringify({ criteria: [{ text: 'Valid sign in' }] }), { reasoning });
    }
    return ok(JSON.stringify({ cases: [caseFor('Sign in with valid credentials')] }), { reasoning });
  };
  const draft = await runRequirementAgent({ settings, requirement, fetcher, connections, servers: [{ id: 'docs', name: 'Docs' }] });
  assert.deepEqual(called, [{ name: 'lookup', args: { query: 'lockout' } }]);
  assert.ok(draft.trace.some(step => step.stage === 'context' && /Docs \/ lookup/.test(step.detail)));
  assert.match(draft.summary, /qwen3:4b-thinking \(standard\).*MCP: Docs \/ lookup/);
  assert.equal(draft.cases.length, 1);
});

test('requirement agent continues without MCP context when a tool is invalid, and survives a spent token budget', async () => {
  const connections = { list: async () => ({ tools: [{ name: 'lookup', annotations: { readOnlyHint: true } }] }), call: () => assert.fail('No MCP execution expected') };
  let design = 0;
  const fetcher = async (url, init) => {
    const system = JSON.parse(init.body).messages[0].content;
    if (system.includes('Gather read-only MCP context')) return ok('{"tool":"made_up","arguments":{}}');
    if (system.includes('Break the requirement')) return ok(JSON.stringify({ criteria: [{ text: 'Valid sign in' }] }));
    return ++design === 1 ? failure(422, 'generation_budget_exhausted', 'No final answer') : ok(JSON.stringify({ cases: [caseFor('Sign in with valid credentials')] }));
  };
  const draft = await runRequirementAgent({ settings, requirement, fetcher, connections, servers: [{ id: 'docs', name: 'Docs' }] });
  assert.equal(draft.cases.length, 1);
  assert.ok(draft.warnings.some(text => /MCP context was skipped/.test(text)));
  assert.ok(draft.warnings.some(text => /whole token budget/.test(text)));
  assert.doesNotMatch(draft.summary, /MCP:/);
});

test('AI Assistance shows the local model status, switches the reasoning mode and submits with Ctrl+Enter', { timeout: 40000 }, async t => {
  const { chromium } = await import('playwright');
  const { createStudio } = await import('./support.mjs');
  const path = await import('node:path');
  const aiFetcher = async url => String(url).endsWith('/models')
    ? { ok: true, status: 200, json: async () => ({ data: [{ id: 'reasonx-v1' }, { id: 'qwen3:8b' }] }) }
    : { ok: true, status: 200, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: '{}' } }] }) };
  const studio = await createStudio({ port: 3398, storage: path.resolve('.test-output', 'reasonx-status-' + Date.now()), aiFetcher });
  let browser;
  t.after(async () => { await browser?.close(); await studio.close(); });
  await studio.listen();
  const base = 'http://127.0.0.1:' + studio.server.address().port;
  browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + '/automation');
  await page.getByRole('button', { name: 'AI Assistance', exact: true }).click();
  await page.getByRole('button', { name: 'Model settings' }).click();
  await page.getByLabel('LLM provider').selectOption('reasonx');
  assert.deepEqual(await page.locator('#ai-model option').evaluateAll(options => options.map(option => option.value)), ['reasonx-v1','qwen3:14b','qwen3:8b','qwen3:4b-thinking','qwen3:1.7b']);
  await page.getByLabel('Model', {exact:true}).selectOption('qwen3:14b');
  await page.getByLabel('Reasoning mode', {exact:true}).selectOption('expert');
  assert.match(await page.locator('[name=reasonxMode] option:checked').textContent(), /Expert.*qwen3:14b/);
  await page.getByLabel('ReasonX API key').fill('rx_test_key_1234567890');
  await page.getByRole('button', { name: 'Save ReasonX connection' }).click();
  await page.waitForFunction(() => document.querySelector('#ai-api-key')?.placeholder.includes('configured'));
  const explicit = await (await fetch(base + '/api/settings')).json();
  assert.equal(explicit.model, 'qwen3:14b');
  assert.equal(explicit.reasonxMode, 'expert');
  await page.reload();
  await page.getByRole('button', { name: 'AI Assistance', exact: true }).click();
  await page.getByRole('button', { name: 'Model settings' }).click();
  assert.equal(await page.getByLabel('Model', {exact:true}).inputValue(), 'qwen3:14b');
  assert.equal(await page.getByLabel('Reasoning mode', {exact:true}).inputValue(), 'expert');
  await page.getByLabel('Model', {exact:true}).selectOption('reasonx-v1');
  await page.getByLabel('Reasoning mode', {exact:true}).selectOption('auto');
  await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/api/settings') && response.request().method()==='PUT'),
    page.getByRole('button', { name: 'Save ReasonX connection' }).click()
  ]);
  await page.getByRole('button', { name: 'Check local server', exact: true }).click();
  await page.getByText('✓ Connected. Models: reasonx-v1, qwen3:8b').waitFor();
  await page.getByRole('button', { name: 'AI Assistance', exact: true }).click();
  await page.getByText('✓ ready').waitFor();
  await page.getByRole('button', { name: 'Deep', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.mode-chip.active')?.textContent.trim() === 'Deep');
  assert.equal((await (await fetch(base + '/api/settings')).json()).reasonxMode, 'deep');
  await page.getByRole('button', { name: 'Expert', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.mode-chip.active')?.textContent.trim() === 'Expert');
  assert.equal((await (await fetch(base + '/api/settings')).json()).reasonxMode, 'expert');
  assert.match(await page.locator('.ai-status .panel-body').textContent(), /qwen3:14b/);
  const status = await (await fetch(base + '/api/ai/status')).json();
  assert.deepEqual([status.reachable, status.authorized, status.models], [true, true, ['reasonx-v1', 'qwen3:8b']]);
  assert.doesNotMatch(JSON.stringify(status), /rx_test_key/);
  let requested = false;
  await page.route('**/api/ai/create', route => { requested = true; route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Stopped by the test' }) }); });
  await page.locator('#ai-prompt').fill('Open the demo page');
  await page.locator('#ai-prompt').press('Control+Enter');
  await page.locator('dialog.issue-dialog').filter({ hasText: 'Stopped by the test' }).waitFor();
  assert.equal(requested, true);
  assert.equal(await page.locator('.ai-progress').count(), 0);
  assert.deepEqual(errors, []);
});
