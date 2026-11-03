import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import { runRequirementAgent, requireAgentModel, parseModelJson, checkCase, similar } from '../requirement-agent.mjs';
import { createStudio } from './support.mjs';

const settings = { provider: 'reasonx', model: 'local-model', reasonxBaseUrl: 'http://localhost:8080/v1', apiKeys: {} };
const requirement = { title: 'Login', moduleName: 'Auth', description: 'Users sign in with email and password. Wrong passwords show an error.' };
const reply = content => ({ ok: true, status: 200, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content } }] }) });
const caseFor = (criterion, title) => ({ criterion, title, priority: 'high', steps: [{ instruction: 'Open the login page', expectedResult: 'Form is shown' }, { instruction: 'Submit', expectedResult: 'Result shown' }], expectedResult: 'As expected' });

test('requires the local ReasonX provider and a model name', () => {
  assert.throws(() => requireAgentModel({ provider: 'openai', model: 'x' }), /local model/);
  assert.throws(() => requireAgentModel({ provider: 'reasonx', model: ' ' }), /model name/);
});

test('helpers parse fenced JSON, reject incomplete cases and detect near-duplicates', () => {
  assert.deepEqual(parseModelJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseModelJson('Sure! {"a":2} done'), { a: 2 });
  assert.match(checkCase({ title: 'T', steps: [] }).reason, /no steps/);
  assert.match(checkCase({ title: 'T', steps: [{ instruction: 'x' }] }).reason, /expected result/);
  assert.ok(similar('Login with valid credentials', 'Login with valid credentials works'));
  assert.ok(!similar('Login with valid credentials', 'Reset forgotten password'));
});

test('agent analyses, drafts, repairs, dedupes and fills coverage gaps using only the local endpoint', async () => {
  const urls = [], stages = [];
  const fetcher = async (url, init) => {
    urls.push(url);
    const sent = JSON.parse(init.body), system = sent.messages[0].content;
    assert.equal(sent.model, 'local-model');
    if (system.includes('Break the requirement')) { stages.push('analyze'); return reply(JSON.stringify({ criteria: [{ text: 'Valid sign in' }, { text: 'Wrong password error' }, { text: 'Locked account message' }], prerequisites: 'A registered user' })); }
    const wanted = JSON.parse(sent.messages[1].content).criteria.map(c => c.id).join(',');
    stages.push('design:' + wanted + (system.includes('Fix these problems') ? ':repair' : ''));
    if (wanted === 'C1,C2' && !system.includes('Fix these problems')) return reply(JSON.stringify({ cases: [{ criterion: 'C1', title: 'broken, no steps', steps: [] }] }));
    if (wanted === 'C1,C2') return reply(JSON.stringify({ cases: [caseFor('C1', 'Sign in with valid credentials'), caseFor('C1', 'Sign in with valid credentials works'), caseFor('C2', 'Wrong password shows error')] }));
    if (wanted === 'C3' && !system.includes('every case must set')) return reply('not json at all');
    return reply(JSON.stringify({ cases: [caseFor('C3', 'Locked account shows message')] }));
  };
  const draft = await runRequirementAgent({ settings, requirement, inspection: { context: { pages: [{ title: 'Login', controls: [{ label: 'Email', type: 'email' }] }] } }, fetcher });
  assert.ok(urls.every(url => url === 'http://localhost:8080/v1/chat/completions'));
  assert.deepEqual(draft.cases.map(c => c.name), ['Sign in with valid credentials', 'Wrong password shows error', 'Locked account shows message']);
  assert.ok(stages.includes('design:C1,C2:repair'));
  assert.match(draft.summary, /3\/3 criteria covered/);
  assert.match(draft.summary, /1 duplicate/);
  assert.deepEqual(draft.warnings, []);
  assert.ok(draft.trace.some(step => step.stage === 'coverage' && /gap filled/.test(step.detail)));
});

test('agent reports uncovered criteria and fails clearly when the model is unusable', async () => {
  const flaky = async (url, init) => {
    const system = JSON.parse(init.body).messages[0].content;
    return reply(system.includes('Break the requirement') ? JSON.stringify({ criteria: [{ text: 'One' }, { text: 'Two' }] }) : JSON.stringify({ cases: [caseFor('C1', 'Only the first criterion')] }));
  };
  const partial = await runRequirementAgent({ settings, requirement, fetcher: flaky });
  assert.equal(partial.cases.length, 1);
  assert.ok(partial.warnings.some(w => /Criterion C2 has no test case/.test(w)));
  await assert.rejects(runRequirementAgent({ settings, requirement, fetcher: async () => reply('{}') }), /did not produce any usable test cases/);
  await assert.rejects(runRequirementAgent({ settings, requirement, fetcher: async () => { throw new Error('ECONNREFUSED'); } }), /did not respond .* running at http:\/\/localhost:8080\/v1/);
  await assert.rejects(runRequirementAgent({ settings: { ...settings, reasonxBaseUrl: 'https://example.com/v1' }, requirement, fetcher: async () => assert.fail('must not call remote hosts') }), /localhost/);
});

test('requirement endpoint generates drafts in agent mode and stores the agent steps', async t => {
  const port = 3440 + Math.floor(Math.random() * 50), storage = path.resolve('.test-output', 'requirement-agent-' + port + '-' + Date.now());
  const fetcher = async (url, init) => {
    const system = JSON.parse(init.body).messages[0].content;
    return reply(system.includes('Break the requirement') ? JSON.stringify({ criteria: [{ text: 'Sign in works' }] }) : JSON.stringify({ cases: [caseFor('C1', 'Sign in works for a valid user')] }));
  };
  const studio = await createStudio({ port, storage, aiFetcher: fetcher, requirementInspector: async () => ({ pages: [], warnings: [], context: { pages: [] } }) });
  await studio.listen();
  t.after(async () => { await studio.close(); await rm(storage, { recursive: true, force: true }).catch(() => {}); });
  studio.store.settings = { ...studio.store.settings, provider: 'reasonx', model: 'local-model' };
  const base = `http://127.0.0.1:${port}`;
  const api = async (route, method = 'GET', body) => {
    const r = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, data: await r.json() };
  };
  const project = studio.store.projects[0], root = `/api/projects/${project.id}/requirements`;
  const created = await api(root, 'POST', { revision: project.revision, title: 'Login', url: 'https://example.test/login', description: 'Users sign in with a valid email.', generationMode: 'agent' });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const generated = await api(root + '/' + created.data.requirement.id + '/generate', 'POST', { revision: created.data.project.revision });
  assert.equal(generated.status, 201, JSON.stringify(generated.data));
  assert.equal(generated.data.requirement.draftCases[0].name, 'Sign in works for a valid user');
  assert.match(generated.data.requirement.generation.summary, /AI agent/);
  assert.ok(generated.data.requirement.generation.agent.length >= 2);
});
