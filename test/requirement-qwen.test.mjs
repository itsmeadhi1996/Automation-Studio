import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { chromium } from 'playwright';
import { generateQwenRequirementDraft, qwenRequirementModel } from '../qwen-requirements.mjs';
import { requirementDraftSchema } from '../requirement-generation.mjs';
import { requirementFields } from '../requirements.mjs';
import { createStudio } from './support.mjs';

const requirement = {
  title: 'Customer sign-in',
  url: 'https://example.test/login',
  description: 'Active customers sign in with email and password. Reject invalid credentials and require an email address.',
  moduleName: 'Customer accounts',
  pageMetadata: { fields: [{ name: 'Email', type: 'email', constraints: { required: true } }], controls: [{ name: 'Sign in', type: 'submit' }] },
  generationMode: 'qwen',
  inspectBeforeGeneration: false
};
const draft = {
  summary: 'Valid sign-in and email validation.',
  warnings: ['Use a dedicated test account.'],
  cases: [
    { title: 'Sign in with valid credentials', description: 'Active account sign-in', preconditions: 'An active test account', priority: 'high', steps: [{ instruction: 'Open the sign-in page', expectedResult: 'The Email and Password fields are visible' }, { instruction: 'Enter valid test credentials and select Sign in', expectedResult: 'The customer dashboard appears' }], expectedResult: 'The customer dashboard appears' },
    { title: 'Reject a missing email', description: 'Required email validation', preconditions: 'The sign-in form is open', priority: 'medium', steps: [{ instruction: 'Leave Email empty and select Sign in', expectedResult: 'The required email validation message appears' }], expectedResult: 'Sign-in is prevented until an email is provided' }
  ]
};
const inspection = {
  pages: [{ url: requirement.url, title: 'Sign in', status: 200, controls: [{ label: 'Email', type: 'email', required: true }] }],
  warnings: ['Form submission has not been verified.'],
  context: { pages: [{ url: requirement.url, title: 'Sign in', controls: [{ label: 'Email', type: 'email', required: true }] }] }
};
const ollamaResponse = (value = draft, extra = {}) => ({
  ok: true,
  status: 200,
  json: async () => ({ done: true, done_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(value) }, ...extra })
});

for (const generationMode of ['ai', 'agent']) test(`saved ${generationMode} requirements retain their method and generate with ReasonX agents in the browser`, { timeout: 45000 }, async t => {
  let calls = 0;
  const f = await fixture(t, { aiFetcher: async (url, options) => {
    calls++;
    assert.equal(url, 'http://127.0.0.1:8080/v1/chat/completions');
    const sent=JSON.parse(options.body);
    assert.equal(sent.model, 'reasonx-v1');
    const system=sent.messages[0].content;
    const result=system.startsWith('Review')?{issues:[]}:system.startsWith('Analyze')||system.includes('Break the requirement')?{criteria:[{text:'Valid sign-in',source:'explicit'},{text:'Email is required',source:'explicit'}],questions:[],assumptions:[]}:{cases:draft.cases.map((c,i)=>({...c,category:'Functional',criterion:'C'+(i+1)}))};
    return {ok:true,status:200,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify(result)}}]})};
  } });
  f.studio.store.settings = { ...f.studio.store.settings, provider: 'reasonx', model: 'reasonx-v1', reasonxBaseUrl: 'http://127.0.0.1:8080/v1' };
  const settingsBefore = structuredClone(f.studio.store.settings);
  const created = await f.api(f.root, 'POST', { ...requirement, generationMode, revision: f.project.revision });
  assert.equal(created.status, 201);
  const id = created.data.requirement.id;
  const browser = await chromium.launch({ channel: 'chrome' });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${f.studio.server.address().port}/#requirement/${id}`);
  const method = page.getByRole('combobox', { name: 'Generation method', exact: true });
  await method.waitFor();
  assert.equal(await method.inputValue(), generationMode);
  assert.match(await page.locator('#requirement-draft-status').innerText(), /Saved requirement/);
  assert.equal(await method.locator('option[value=agent]').count(), 1);
  await page.screenshot({path:path.resolve('.test-output','reasonx-requirements.png'),fullPage:true});
  assert.equal((await f.api(f.root + '/' + id)).data.generationMode, generationMode, 'Opening the form must not silently write saved data');
  const generated=page.waitForResponse(r=>r.url().endsWith('/generate'));
  await page.getByRole('button', { name: 'Generate Test Cases', exact: true }).click();
  const result=await generated; assert.equal(result.status(),201,await result.text());
  await page.waitForFunction(() => document.querySelector('#requirement-feedback')?.textContent.includes('2 drafts generated.'));
  const saved = (await f.api(f.root + '/' + id)).data;
  assert.equal(calls, generationMode==='agent'?3:2);
  assert.equal(saved.generationMode, generationMode);
  assert.equal(saved.draftCases.length, 2);
  assert.equal(saved.testIds.length, 0);
  assert.deepEqual(f.studio.store.settings, settingsBefore);
  await page.reload();
  await method.waitFor();
  assert.equal(await method.inputValue(), generationMode);
  assert.equal(await page.getByText(/Save or generate to apply/).count(), 0);
  assert.deepEqual(errors, []);
});

test('Qwen uses local Ollama structured output with the complete requirement and no API key', async () => {
  let request;
  const result = await generateQwenRequirementDraft(requirement, inspection, async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return ollamaResponse();
  });
  assert.equal(qwenRequirementModel, 'qwen3:14b');
  assert.equal(request.url, 'http://127.0.0.1:11434/api/chat');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.redirect, 'error');
  assert.equal(new Headers(request.options.headers).get('authorization'), null);
  assert.equal(new Headers(request.options.headers).get('content-type'), 'application/json');
  assert.equal(request.body.model, qwenRequirementModel);
  assert.equal(request.body.stream, false);
  assert.equal(request.body.think, true);
  assert.deepEqual(request.body.format, requirementDraftSchema);
  assert.ok(request.options.signal instanceof AbortSignal);
  const input = JSON.parse(request.body.messages.find(message => message.role === 'user').content);
  for (const key of ['title', 'url', 'description', 'moduleName', 'pageMetadata']) assert.deepEqual(input.requirement[key], requirement[key]);
  assert.deepEqual(input.inspection, inspection.context);
  assert.match(result.summary, /qwen3:14b/);
  assert.deepEqual(result.warnings, draft.warnings);
  assert.equal(result.cases.length, 2);
  assert.equal(result.cases[0].name, draft.cases[0].title);
  assert.equal(result.cases[0].qa.executionMode, 'manual');
  assert.deepEqual(result.cases[0].qa.manualSteps.map(({ instruction, expectedResult }) => ({ instruction, expectedResult })), draft.cases[0].steps);
});

test('Qwen accepts generation without browser inspection', async () => {
  const result = await generateQwenRequirementDraft(requirement, undefined, async () => ollamaResponse());
  assert.equal(result.cases.length, draft.cases.length);
});

test('Qwen reports actionable local service and missing model failures', async () => {
  await assert.rejects(generateQwenRequirementDraft(requirement, undefined, async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' }) }); }), /Start Ollama/i);
  await assert.rejects(generateQwenRequirementDraft(requirement, undefined, async () => ({ ok: false, status: 404, json: async () => ({ error: 'model not found' }) })), /ollama pull qwen3:14b/);
  await assert.rejects(generateQwenRequirementDraft(requirement, undefined, async () => ({ ok: false, status: 500, json: async () => ({ error: 'model runner failed' }) })), /Ollama|Qwen/i);
});

test('Qwen distinguishes slow generation and interrupted responses from an offline service', async t => {
  const cases = [
    [new DOMException('Deadline elapsed', 'TimeoutError'), /request timed out/],
    [new DOMException('Aborted', 'AbortError'), /request timed out/],
    ...['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'ETIMEDOUT'].map(code => [new TypeError('fetch failed', { cause: Object.assign(new Error('private diagnostic'), { code }) }), /request timed out/]),
    ...['ECONNRESET', 'UND_ERR_SOCKET'].map(code => [new TypeError('fetch failed', { cause: Object.assign(new Error('private diagnostic'), { code }) }), /interrupted during generation/])
  ];
  for (const [cause, expected] of cases) {
    for (const phase of ['request', 'body']) await t.test(`${cause.cause?.code || cause.name} during ${phase}`, async () => {
      const fetcher = async () => {
        if (phase === 'request') throw cause;
        return { ok: true, status: 200, json: async () => { throw cause; } };
      };
      await assert.rejects(generateQwenRequirementDraft(requirement, undefined, fetcher), error => {
        assert.match(error.userMessage, expected);
        assert.doesNotMatch(error.userMessage, /could not connect|Start Ollama|private diagnostic/);
        assert.equal(error.cause, cause);
        return true;
      });
    });
  }
});

test('Qwen rejects unreadable, incomplete and invalid responses before creating drafts', async () => {
  await assert.rejects(generateQwenRequirementDraft(requirement, undefined, async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unreadable body'); } })), /unreadable|read|valid/i);
  for (const extra of [{ done: false }, { done_reason: 'length' }]) {
    await assert.rejects(generateQwenRequirementDraft(requirement, undefined, async () => ollamaResponse(draft, extra)), /incomplete|finish|limit/i);
  }
  for (const content of ['not json', '{"cases":', '']) {
    await assert.rejects(generateQwenRequirementDraft(requirement, undefined, async () => ollamaResponse(draft, { message: { content } })), /valid|empty|cases|JSON/i);
  }
  for (const invalid of [
    { ...draft, cases: [] },
    { ...draft, cases: [draft.cases[0], draft.cases[0]] },
    { ...draft, cases: [{ ...draft.cases[0], steps: [] }] },
    { ...draft, cases: [{ ...draft.cases[0], steps: [{ instruction: 'Select Sign in', expectedResult: '' }] }] }
  ]) {
    await assert.rejects(generateQwenRequirementDraft(requirement, undefined, async () => ollamaResponse(invalid)), /case|steps|expected result|valid/i);
  }
});

test('requirements accept Qwen while legacy requirements retain local rules', () => {
  assert.equal(requirementFields(requirement).generationMode, 'qwen');
  const { generationMode, ...legacy } = requirement;
  assert.equal(requirementFields(legacy).generationMode, 'rules');
});

let nextPort = 3680;
async function fixture(t, overrides = {}) {
  const storage = path.resolve('.test-output', 'requirement-qwen-' + randomUUID());
  const studio = await createStudio({ port: nextPort++, storage, aiFetcher: async () => ollamaResponse(), requirementInspector: async () => assert.fail('Browser inspection requires an explicit opt-in'), ...overrides });
  t.after(async () => { await studio.close(); await rm(storage, { recursive: true, force: true }); });
  await studio.listen();
  studio.store.settings = { ...studio.store.settings, provider: 'openai', model: 'other-feature-model', apiKey: '', apiKeys: {} };
  const settings = structuredClone(studio.store.settings);
  const base = 'http://127.0.0.1:' + studio.server.address().port;
  const api = async (route, method = 'GET', body) => {
    const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  const project = studio.store.projects[0], root = `/api/projects/${project.id}/requirements`;
  return { studio, settings, project, root, api };
}

test('Qwen generates reviewable drafts without settings changes, and approval creates the test cases', async t => {
  let calls = 0;
  const f = await fixture(t, { aiFetcher: async (url, options) => {
    calls++;
    assert.equal(url, 'http://127.0.0.1:11434/api/chat');
    assert.equal(JSON.parse(options.body).model, qwenRequirementModel);
    return ollamaResponse();
  } });
  const initialCount = f.project.tests.length, initialCounter = f.studio.store.nextTestNumber;
  const created = await f.api(f.root, 'POST', { ...requirement, revision: f.project.revision });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const route = f.root + '/' + created.data.requirement.id;
  const generated = await f.api(route + '/generate', 'POST', { revision: created.data.project.revision });
  assert.equal(generated.status, 201, JSON.stringify(generated.data));
  assert.equal(calls, 1);
  assert.equal(generated.data.addedCount, 2);
  assert.equal(generated.data.project.tests.length, initialCount);
  assert.equal(f.studio.store.nextTestNumber, initialCounter);
  assert.deepEqual(generated.data.requirement.testIds, []);
  assert.deepEqual(generated.data.requirement.generation.pages, []);
  assert.match(generated.data.requirement.generation.summary, /qwen3:14b/);
  assert.equal(generated.data.requirement.needsGeneration, false);
  const [first, second] = generated.data.requirement.draftCases;
  assert.equal(first.tcNumber, undefined);
  const approved = await f.api(route + '/approve', 'POST', { revision: generated.data.project.revision, draftIds: [first.id] });
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  assert.equal(approved.data.approvedCount, 1);
  assert.equal(approved.data.project.tests.length, initialCount + 1);
  assert.deepEqual(approved.data.requirement.testIds, [first.id]);
  assert.deepEqual(approved.data.requirement.draftCases.map(item => item.id), [second.id]);
  const saved = approved.data.project.tests.find(item => item.id === first.id);
  assert.deepEqual(saved.qa.manualSteps, first.qa.manualSteps);
  assert.equal(saved.tcNumber, initialCounter);
  assert.equal(saved.inTestPlan, false);
  assert.deepEqual(f.studio.store.settings, f.settings);
});

test('Qwen only inspects the requirement URL when explicitly requested', async t => {
  let inspections = 0, input;
  const f = await fixture(t, {
    requirementInspector: async (project, url) => { inspections++; assert.equal(url, requirement.url); return structuredClone(inspection); },
    aiFetcher: async (url, options) => { input = JSON.parse(JSON.parse(options.body).messages.find(message => message.role === 'user').content); return ollamaResponse(); }
  });
  const created = await f.api(f.root, 'POST', { ...requirement, inspectBeforeGeneration: true, revision: f.project.revision });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const generated = await f.api(f.root + '/' + created.data.requirement.id + '/generate', 'POST', { revision: created.data.project.revision });
  assert.equal(generated.status, 201, JSON.stringify(generated.data));
  assert.equal(inspections, 1);
  assert.deepEqual(input.inspection, inspection.context);
  assert.equal(generated.data.requirement.generation.pages[0].url, requirement.url);
  assert.ok(generated.data.requirement.generation.warnings.includes(inspection.warnings[0]));
});

test('Qwen failure preserves existing drafts and releases the generation lock for retry', async t => {
  let valid = true;
  const f = await fixture(t, { aiFetcher: async () => ollamaResponse(valid ? draft : { ...draft, cases: [] }) });
  const created = await f.api(f.root, 'POST', { ...requirement, revision: f.project.revision });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const route = f.root + '/' + created.data.requirement.id;
  const generated = await f.api(route + '/generate', 'POST', { revision: created.data.project.revision });
  assert.equal(generated.status, 201, JSON.stringify(generated.data));
  const before = structuredClone(generated.data.requirement), revision = generated.data.project.revision;
  valid = false;
  const failed = await f.api(route + '/generate', 'POST', { revision });
  assert.equal(failed.status, 400, JSON.stringify(failed.data));
  assert.ok(failed.data.userMessage);
  assert.deepEqual((await f.api(route)).data, before);
  assert.equal(f.studio.store.projects[0].revision, revision);
  valid = true;
  const retry = await f.api(route + '/generate', 'POST', { revision });
  assert.equal(retry.status, 201, JSON.stringify(retry.data));
  assert.equal(retry.data.addedCount, 0);
  assert.equal(retry.data.requirement.draftCases.length, before.draftCases.length);
  assert.deepEqual(f.studio.store.settings, f.settings);
});

test('a Qwen transport timeout reports the real problem and releases the project for retry', async t => {
  let timedOut = true;
  const f = await fixture(t, { aiFetcher: async () => {
    if (timedOut) throw new TypeError('fetch failed', { cause: Object.assign(new Error('Headers timeout'), { code: 'UND_ERR_HEADERS_TIMEOUT' }) });
    return ollamaResponse();
  } });
  const created = await f.api(f.root, 'POST', { ...requirement, revision: f.project.revision });
  const route = f.root + '/' + created.data.requirement.id;
  const revision = created.data.project.revision;
  const failed = await f.api(route + '/generate', 'POST', { revision });
  assert.equal(failed.status, 400);
  assert.match(failed.data.userMessage, /request timed out/);
  assert.doesNotMatch(failed.data.userMessage, /could not connect|Start Ollama/);
  assert.equal(f.studio.store.projects[0].revision, revision);
  assert.deepEqual((await f.api(route)).data.draftCases, []);
  timedOut = false;
  const retried = await f.api(route + '/generate', 'POST', { revision });
  assert.equal(retried.status, 201, JSON.stringify(retried.data));
  assert.equal(retried.data.addedCount, 2);
});
