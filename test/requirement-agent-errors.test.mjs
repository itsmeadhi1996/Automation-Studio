import test from 'node:test';
import assert from 'node:assert/strict';
import { requireAgentModel, runRequirementAgent } from '../requirement-agent.mjs';
import { requirementErrorUserMessage } from '../requirement-errors.mjs';

const privateDetail = 'private-service-detail';
const apiKey = 'private-api-key';
const settings = { provider: 'reasonx', model: 'local-model', reasonxBaseUrl: 'http://localhost:8080/v1', apiKeys: { reasonx: apiKey } };
const requirement = { title: 'Sign in', description: 'Registered users can sign in.' };
const reply = (content, finish = 'stop', extra = {}) => ({ ok: true, status: 200, json: async () => ({ choices: [{ finish_reason: finish, message: { content, ...extra } }] }) });
const serviceError = status => ({ ok: false, status, json: async () => ({ error: { message: privateDetail + ' ' + apiKey } }) });
const checkError = (code, message) => error => {
  assert.equal(error.code, 'REQUIREMENT_AGENT_' + code);
  assert.match(error.userMessage, message);
  assert.equal(requirementErrorUserMessage(error), error.userMessage);
  assert.doesNotMatch(error.userMessage, /private-service-detail|private-api-key|localhost:8080|could not finish this request/);
  return true;
};

test('agent configuration failures preserve actionable guidance without exposing settings', () => {
  for (const [input, expected] of [
    [{ ...settings, provider: 'openai' }, /Choose the ReasonX provider/],
    [{ ...settings, model: ' ' }, /Set the local model name/],
    [{ ...settings, reasonxBaseUrl: 'https://private-service-detail.test/private-api-key' }, /localhost address/],
  ]) assert.throws(() => requireAgentModel(input), checkError('CONFIG', expected));
});

test('agent service failures retain diagnostics and provide safe specific recovery instructions', async t => {
  const cases = [
    ['unreachable', async () => { throw new Error(privateDetail + ' ' + apiKey); }, 'UNREACHABLE', /Start ReasonX/],
    ['unreadable response', async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError(privateDetail); } }), 'RESPONSE', /unreadable response/],
    ['authentication', async () => serviceError(401), 'AUTH', /configured credentials/],
    ['access denied', async () => serviceError(403), 'AUTH', /configured credentials/],
    ['model unavailable', async () => serviceError(404), 'MODEL', /selected model/],
    ['request too large', async () => serviceError(413), 'CONTEXT_LIMIT', /Shorten the requirement/],
    ['upstream unavailable', async () => serviceError(503), 'UPSTREAM', /Ollama is running/],
    ['service rejection', async () => serviceError(500), 'SERVICE', /model and service settings/],
  ];
  for (const [name, fetcher, code, expected] of cases) await t.test(name, async () => {
    await assert.rejects(runRequirementAgent({ settings, requirement, fetcher }), error => {
      checkError(code, expected)(error);
      assert.ok(error.cause, 'The original diagnostic remains available for troubleshooting');
      assert.doesNotMatch(error.message, /private-api-key/);
      if (name !== 'unreadable response') assert.match(error.message, /private-service-detail/);
      return true;
    });
  });
});

test('unusable model output reports the actual failure after existing corrective retries', async t => {
  const cases = [
    ['output budget', () => serviceError(422), 'BUDGET', /ran out of room/],
    ['cut off output', () => reply(privateDetail, 'length'), 'BUDGET', /ran out of room/],
    ['malformed output', () => reply(privateDetail), 'OUTPUT', /did not return usable test cases/],
    ['no usable cases', () => reply('{}'), 'NO_CASES', /did not produce any usable test cases/],
    ['empty response', () => reply(undefined), 'RESPONSE', /did not return usable test cases/],
    ['refusal', () => reply(privateDetail, 'stop', { refusal: privateDetail }), 'REJECTED', /could not accept this generation request/],
  ];
  for (const [name, response, code, expected] of cases) await t.test(name, async () => {
    let calls = 0;
    await assert.rejects(runRequirementAgent({ settings, requirement, fetcher: async () => { calls++; return response(); } }), checkError(code, expected));
    assert.ok(calls >= (['empty response', 'refusal'].includes(name) ? 1 : 2));
  });
});

test('agent context and total time limits have specific recovery messages', async t => {
  await assert.rejects(runRequirementAgent({ settings, requirement: { ...requirement, description: '\\'.repeat(2800) }, fetcher: async () => assert.fail('Oversized requests must not reach the service') }), checkError('CONTEXT_LIMIT', /too large for the local AI agent/));
  let now = 0;
  t.mock.method(Date, 'now', () => now);
  await assert.rejects(runRequirementAgent({
    settings, requirement,
    fetcher: async () => { now = 31 * 60000; return reply('{"criteria":[{"text":"Sign in succeeds"}]}'); },
  }), checkError('TIMEOUT', /ran out of time/));
});

test('a recovered output budget failure still produces a successful draft', async () => {
  let calls = 0;
  const draft = await runRequirementAgent({ settings, requirement, fetcher: async (url, options) => {
    if (++calls === 1) return serviceError(422);
    const request = JSON.parse(options.body);
    return reply(JSON.stringify(request.messages[0].content.includes('Break the requirement') ? { criteria: [{ text: 'Sign in succeeds' }] } : {
      cases: [{ criterion: 'C1', title: 'Sign in successfully', steps: [{ instruction: 'Submit valid credentials', expectedResult: 'Dashboard opens' }], expectedResult: 'Dashboard opens' }],
    }));
  } });
  assert.equal(draft.cases.length, 1);
  assert.match(draft.summary, /1\/1 criteria covered/);
});
