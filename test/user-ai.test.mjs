import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createStudio } from './support.mjs';
import { normalizeUserAi, publicUserAi, engineSettings, cloudJson } from '../user-ai.mjs';

const schema = { type: 'object', additionalProperties: false, properties: { answer: { type: 'string' } }, required: ['answer'] };
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const claudeMessage = (content, stop_reason = 'end_turn') => ({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content, stop_reason, usage: { input_tokens: 1, output_tokens: 1 } });
const requirementDraft = { summary: 'Sign-in coverage.', warnings: [], cases: [
  { title: 'Sign in with valid credentials', description: 'Valid sign-in', preconditions: 'An active account', priority: 'high', steps: [{ instruction: 'Open the sign-in page', expectedResult: 'The form is shown' }], expectedResult: 'The dashboard is displayed' },
  { title: 'Reject a wrong password', description: 'Invalid sign-in', preconditions: 'An active account', priority: 'medium', steps: [{ instruction: 'Enter a wrong password and sign in', expectedResult: 'An error is shown' }], expectedResult: 'The user stays signed out' }
] };

test('personal AI settings keep keys private, validate input and require a key per engine', () => {
  let ai = normalizeUserAi({ engines: { qa: 'claude' }, apiKeys: { claude: ' sk-ant-secret ' }, models: { chatgpt: 'gpt-4.1' } });
  assert.deepEqual(ai.engines, { qa: 'claude', automation: 'studio' });
  assert.equal(ai.apiKeys.claude, 'sk-ant-secret');
  assert.equal(ai.models.claude, 'claude-opus-5-5');
  const shown = publicUserAi(ai);
  assert.ok(!JSON.stringify(shown).includes('sk-ant-secret'));
  assert.deepEqual(shown.hasApiKey, { claude: true, chatgpt: false });
  // A blank key keeps the saved one; clearing removes it.
  ai = normalizeUserAi({ apiKeys: { claude: '' } }, ai); assert.equal(ai.apiKeys.claude, 'sk-ant-secret');
  ai = normalizeUserAi({ clearApiKeys: ['claude'] }, ai); assert.equal(ai.apiKeys.claude, undefined);
  assert.throws(() => normalizeUserAi({ engines: { qa: 'gemini' } }), /Studio, Claude or ChatGPT/);
  assert.throws(() => normalizeUserAi({ models: { claude: 'bad model id' } }), /model ID/);
  assert.throws(() => engineSettings({ provider: 'reasonx' }, ai, 'claude'), /Add your Claude API key/);
  const shared = { provider: 'reasonx', model: 'reasonx-v1', mcpServers: [] };
  assert.equal(engineSettings(shared, ai, 'studio'), shared);
  const chatgpt = engineSettings(shared, normalizeUserAi({ apiKeys: { chatgpt: 'sk-openai' } }), 'chatgpt');
  assert.deepEqual([chatgpt.provider, chatgpt.model, chatgpt.apiKeys], ['openai', 'gpt-4.1-mini', { openai: 'sk-openai' }]);
});

test('Claude returns structured JSON after a read-only MCP tool round', async () => {
  const requests = [], calls = [];
  const fetcher = async (url, init) => {
    const body = JSON.parse(init.body); requests.push({ url: String(url), body, key: new Headers(init.headers).get('authorization') });
    if (requests.length === 1) return reply(claudeMessage([{ type: 'tool_use', id: 'tu_1', name: 'mcp_tool_1', input: { issue: 'QA-1' } }], 'tool_use'));
    return reply(claudeMessage([{ type: 'text', text: '{"answer":"done"}' }]));
  };
  const connections = { call: async (server, name, args) => { calls.push([server.name, name, args]); return { content: [{ type: 'text', text: 'Ticket QA-1: sign-in' }] }; } };
  const handlers = new Map([['mcp_tool_1', { server: { name: 'Jira' }, tool: { name: 'get_issue' } }]]);
  const tools = [{ type: 'function', name: 'mcp_tool_1', description: 'Read-only tool', parameters: { type: 'object', properties: { issue: { type: 'string' } } } }];
  const { result } = await cloudJson({ settings: { provider: 'anthropic', model: 'claude-opus-5-5', apiKey: 'sk-ant-test' }, system: 'Be precise.', prompt: 'Draft', schema, tools, handlers, connections, fetcher });
  assert.deepEqual(result, { answer: 'done' });
  assert.deepEqual(calls, [['Jira', 'get_issue', { issue: 'QA-1' }]]);
  assert.equal(requests[0].key, 'Bearer sk-ant-test');
  assert.match(requests[0].url, /api\.anthropic\.com\/v1\/messages/);
  assert.deepEqual(requests[0].body.output_config.format, { type: 'json_schema', schema });
  assert.equal(requests[0].body.tools[0].input_schema.type, 'object');
  const toolTurn = requests[1].body.messages.at(-1);
  assert.equal(toolTurn.content[0].type, 'tool_result');
  assert.match(toolTurn.content[0].content, /Untrusted read-only MCP data/);
});

test('Claude and ChatGPT errors become actionable messages without leaking keys', async () => {
  const claude = { provider: 'anthropic', model: 'claude-opus-5-5', apiKey: 'sk-ant-leak' };
  await assert.rejects(cloudJson({ settings: claude, system: 's', prompt: 'p', schema, fetcher: async () => reply({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key sk-ant-leak' } }, 401) }), error => error.code === 'CLAUDE_API_KEY_INVALID' && !error.message.includes('sk-ant-leak'));
  await assert.rejects(cloudJson({ settings: claude, system: 's', prompt: 'p', schema, fetcher: async () => reply(claudeMessage([], 'refusal')) }), { code: 'CLAUDE_REFUSED' });
  await assert.rejects(cloudJson({ settings: claude, system: 's', prompt: 'p', schema, fetcher: async () => reply(claudeMessage([{ type: 'text', text: '{"ans' }], 'max_tokens')) }), { code: 'USER_AI_INCOMPLETE' });
  const chatgpt = { provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'sk-openai-leak' };
  await assert.rejects(cloudJson({ settings: chatgpt, system: 's', prompt: 'p', schema, fetcher: async () => reply({ error: { code: 'insufficient_quota', message: 'quota' } }, 429) }), { code: 'OPENAI_BILLING_REQUIRED' });
  const { result } = await cloudJson({ settings: chatgpt, system: 's', prompt: 'p', schema, fetcher: async (url, init) => { assert.equal(JSON.parse(init.body).text.format.type, 'json_schema'); return reply({ status: 'completed', output: [{ content: [{ type: 'output_text', text: '{"answer":"ok"}' }] }] }); } });
  assert.deepEqual(result, { answer: 'ok' });
});

test('each user generates QA requirement cases with their own Claude key; keys stay encrypted and private', async t => {
  const seen = [];
  const storage = path.resolve('.test-output', `user-ai-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const studio = await createStudio({ port: 3871, storage, requirementInspector: async () => ({ pages: [], warnings: [], context: { pages: [] } }), aiFetcher: async (url, init) => {
    seen.push({ url: String(url), key: new Headers(init.headers).get('authorization'), body: JSON.parse(init.body) });
    return reply(claudeMessage([{ type: 'text', text: JSON.stringify(requirementDraft) }]));
  } });
  await studio.listen(); t.after(() => studio.close());
  const base = 'http://127.0.0.1:' + studio.server.address().port;
  const api = async (route, method = 'GET', body, cookie) => { const r = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, data: await r.json(), cookie: r.headers.get('set-cookie')?.split(';')[0] }; };
  const project = studio.store.projects[0];
  const member = (await api('/api/admin/users', 'POST', { name: 'QA member', username: 'user-ai-qa', password: 'User-ai-test-password', permissions: { qa: true }, active: true })).data;
  studio.store.projectMembers[project.id] = [member.id];
  const cookie = (await api('/api/auth/login', 'POST', { username: 'user-ai-qa', password: 'User-ai-test-password' })).cookie;

  let r = await api('/api/account/ai', 'GET', undefined, cookie);
  assert.equal(r.status, 200); assert.deepEqual(r.data.hasApiKey, { claude: false, chatgpt: false });
  r = await api('/api/account/ai', 'PUT', { engines: { qa: 'claude' }, apiKeys: { claude: 'sk-ant-member-key' } }, cookie);
  assert.equal(r.status, 200); assert.equal(r.data.hasApiKey.claude, true); assert.ok(!JSON.stringify(r.data).includes('sk-ant-member-key'));
  // The administrator's own settings are separate from the member's.
  assert.equal((await api('/api/account/ai')).data.hasApiKey.claude, false);
  assert.ok(!(await readFile(path.join(storage, 'data', 'studio.json'), 'utf8')).includes('sk-ant-member-key'), 'personal keys are sealed at rest');
  assert.ok(!JSON.stringify((await api('/api/settings', 'GET', undefined, cookie)).data).includes('sk-ant-member-key'));

  const root = `/api/projects/${project.id}/requirements`;
  r = await api(root, 'POST', { title: 'Customer sign-in', url: 'https://example.test/login', description: 'Active customers can sign in and wrong passwords are rejected.', generationMode: 'claude', revision: project.revision }, cookie);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  r = await api(`${root}/${r.data.requirement.id}/generate`, 'POST', { revision: r.data.project.revision }, cookie);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.addedCount, 2);
  assert.match(r.data.requirement.generation.summary, /Generated with Claude \(claude-opus-5-5\)/);
  assert.equal(seen.length, 1); assert.equal(seen[0].key, 'Bearer sk-ant-member-key'); assert.equal(seen[0].body.model, 'claude-opus-5-5');
  assert.match(seen[0].body.messages[0].content, /Customer sign-in/);

  // Without a ChatGPT key the request fails clearly and nothing is generated.
  const second = (await api(root, 'POST', { title: 'Password reset', url: 'https://example.test/login', description: 'Users can reset a forgotten password.', generationMode: 'chatgpt', revision: r.data.project.revision }, cookie)).data;
  r = await api(`${root}/${second.requirement.id}/generate`, 'POST', { revision: second.project.revision }, cookie);
  assert.equal(r.status, 400); assert.match(r.data.error || r.data.userMessage, /ChatGPT API key/);
  assert.equal(seen.length, 1);
});

test('Automation drafts use Claude with the user key and keep Studio step normalization', async () => {
  const { draftTest } = await import('../integrations.mjs');
  const { sampleProject, normalizeProject } = await import('../model.mjs');
  const project = normalizeProject(sampleProject(3200), null, { nextTestNumber: 1 });
  const step = { framePath: [], qaRequirementId: '', name: 'Open the welcome form', action: 'navigate', target: '', locatorType: 'css', replacement: '', value: 'http://127.0.0.1:3200/demo', valueMode: 'static' };
  let request;
  const draft = await draftTest({ provider: 'anthropic', model: 'claude-opus-5-5', apiKeys: { anthropic: 'sk-ant-auto' }, mcpServers: [] }, project, 'Open the demo page', async (url, init) => {
    request = { url: String(url), body: JSON.parse(init.body) };
    return reply(claudeMessage([{ type: 'text', text: JSON.stringify({ name: 'Open demo', explanation: 'Opens the page.', steps: [step] }) }]));
  });
  assert.match(request.url, /anthropic/);
  assert.equal(request.body.output_config.format.type, 'json_schema');
  assert.match(request.body.system, /Draft one browser test/);
  assert.equal(draft.name, 'Open demo');
  assert.equal(draft.steps[0].action, 'navigate');
  await assert.rejects(draftTest({ provider: 'anthropic', model: 'claude-opus-5-5', mcpServers: [] }, project, 'x', async () => assert.fail('no call')), /Claude API key/);
});
