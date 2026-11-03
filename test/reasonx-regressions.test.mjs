// Regression tests for Part 2 fixes F5 (ReasonX transport) and F8 (enhanced requirement workflow).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { ReasonxError, reasonxChat } from '../reasonx-client.mjs';

const messages = [{ role: 'user', content: 'hi' }];
const completion = (content) => ({
  choices: [{ finish_reason: 'stop', message: { content } }],
});

async function service(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
}

for (const [label, options] of [
  ['with no fetcher', {}],
  ['when handed global fetch', { fetcher: globalThis.fetch }],
]) {
  test(`F5: reasonxChat uses the node:http client ${label}`, async (t) => {
    let headers;
    const endpoint = await service(t, (req, res) => {
      headers = req.headers;
      req.resume();
      setTimeout(() => res.end(JSON.stringify(completion('done'))), 50);
    });
    const reply = await reasonxChat({ endpoint, model: 'reasonx-v1', messages, ...options });
    assert.equal(reply.text, 'done');
    // Only fetch sends this header. Its presence would mean the 300 s headers timeout still applies.
    assert.equal(headers['sec-fetch-mode'], undefined);
  });
}

test('F5: an injected fetcher still replaces the default transport', async () => {
  let calls = 0;
  const reply = await reasonxChat({
    endpoint: 'http://local/v1',
    messages,
    fetcher: async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => completion('injected') };
    },
  });
  assert.equal(reply.text, 'injected');
  assert.equal(calls, 1);
});

test('F5: a deadline from the node:http client is reported as a ReasonX timeout', async () => {
  const fetcher = async () => {
    throw Object.assign(new Error('The operation was aborted'), {
      name: 'AbortError',
      cause: new DOMException('Timed out', 'TimeoutError'),
    });
  };
  await assert.rejects(
    reasonxChat({ endpoint: 'http://local/v1', messages, fetcher }),
    (error) => error instanceof ReasonxError && error.kind === 'timeout',
  );
});

test('F5: the default client stops when the generation is cancelled', async (t) => {
  let began;
  const started = new Promise((resolve) => {
    began = resolve;
  });
  const endpoint = await service(t, (req) => {
    req.resume();
    began();
  });
  const controller = new AbortController();
  const pending = reasonxChat({ endpoint, model: 'reasonx-v1', messages, signal: controller.signal });
  await started;
  controller.abort();
  await assert.rejects(pending, { code: 'GENERATION_CANCELLED' });
});

test('F5: the default client refuses redirects and non-local endpoints', async (t) => {
  let followed = false;
  const destination = await service(t, (req, res) => {
    followed = true;
    res.end('{}');
  });
  const endpoint = await service(t, (req, res) => {
    res.writeHead(307, { Location: destination });
    res.end();
  });
  await assert.rejects(
    reasonxChat({ endpoint, model: 'reasonx-v1', messages }),
    (error) => error.kind === 'unreachable' && /redirects are not allowed/.test(error.message),
  );
  assert.equal(followed, false);
  await assert.rejects(
    reasonxChat({ endpoint: 'https://example.test/v1/chat/completions', model: 'reasonx-v1', messages }),
    (error) => error.kind === 'unreachable' && /local URL/.test(error.message),
  );
});

const settings = { provider: 'reasonx', model: 'reasonx-v1', reasonxMode: 'fast', apiKey: 'private-reasonx-key' };
const options = { enabled: true, repairLimit: 0, guidance: '', model: '', mode: '' };
const validCase = {
  title: 'Reject an empty name',
  category: 'Validation',
  criterion: 'C1',
  preconditions: 'Form open',
  testData: [{ field: 'Name', value: '' }],
  assumptions: [],
  priority: 'high',
  steps: [{ instruction: 'Leave Name empty and submit', expectedResult: 'Name is required appears' }],
  expectedResult: 'Submission is blocked',
};
const requirement = {
  id: 'req',
  title: 'Required name',
  url: 'https://example.test',
  description: 'Name is required.',
  categories: ['Validation'],
  agentOptions: options,
};
const reply = (value) => ({
  ok: true,
  status: 200,
  json: async () => completion(typeof value === 'string' ? value : JSON.stringify(value)),
});

function agentReply(system) {
  if (system.startsWith('Analyze')) {
    return { criteria: [{ text: 'Name required', source: 'explicit' }], assumptions: [], questions: [] };
  }
  if (system.startsWith('Review')) return { issues: [] };
  return { cases: [validCase] };
}

const load = () => import('../reasonx-workflows.mjs');

test('F8: a long requirement is clipped to the request limit and the warning names what was shortened', async () => {
  const { requirementWorkflow } = await load();
  const description = `${'Name "must" be\nrequired. '.repeat(800)}Final rule.`.slice(0, 10000);
  const sizes = [];
  const result = await requirementWorkflow({
    settings,
    requirement: { ...requirement, description },
    fetcher: async (_, init) => {
      const body = JSON.parse(init.body);
      sizes.push(body.messages.reduce((total, message) => total + message.content.length, 0));
      return reply(agentReply(body.messages[0].content));
    },
  });
  assert.ok(sizes.length >= 3);
  assert.ok(sizes.every((size) => size <= 6000), `Request sizes: ${sizes.join(', ')}`);
  assert.equal(result.cases.length, 1);
  assert.ok(result.warnings.some((warning) => /requirement description for analysis \(first \d+ of 10000 characters\)/.test(warning)));
  assert.ok(result.warnings.some((warning) => /requirement description for case generation \(first 1\d{3} of 10000 characters\)/.test(warning)));
});

test('F8: a short requirement has no shortening warning', async () => {
  const { requirementWorkflow } = await load();
  const result = await requirementWorkflow({
    settings,
    requirement,
    fetcher: async (_, init) => reply(agentReply(JSON.parse(init.body).messages[0].content)),
  });
  assert.ok(!result.warnings.some((warning) => /Shortened/.test(warning)));
});

test('F8: a malformed MCP plan becomes a warning and generation continues', async () => {
  const { requirementWorkflow } = await load();
  const connections = {
    list: async () => ({ tools: [{ name: 'lookup', description: 'Rules', annotations: { readOnlyHint: true } }] }),
    call: () => assert.fail('No MCP execution expected'),
  };
  const result = await requirementWorkflow({
    settings,
    requirement,
    connections,
    servers: [{ name: 'Docs' }],
    fetcher: async (_, init) => {
      const system = JSON.parse(init.body).messages[0].content;
      return system.startsWith('Gather') ? reply('this is not JSON') : reply(agentReply(system));
    },
  });
  assert.equal(result.cases.length, 1);
  assert.ok(result.warnings.some((warning) => /could not select an MCP tool/.test(warning)));
});

test('F8: toolset errors become a redacted warning and generation continues', async () => {
  const { requirementWorkflow } = await load();
  const connections = {
    list: async () => {
      throw new Error('Offline private-reasonx-key');
    },
  };
  const result = await requirementWorkflow({
    settings,
    requirement,
    connections,
    servers: [{ name: 'Docs' }],
    fetcher: async (_, init) => reply(agentReply(JSON.parse(init.body).messages[0].content)),
  });
  assert.equal(result.cases.length, 1);
  const warning = result.warnings.find((item) => /MCP context was skipped/.test(item));
  assert.ok(warning);
  assert.doesNotMatch(warning, /private-reasonx-key/);
});

const stalledFetcher = (_, init) =>
  new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
  });

test('F8: the total time budget stops a stalled workflow with its own error', async () => {
  const { requirementWorkflow } = await load();
  await assert.rejects(
    requirementWorkflow({ settings, requirement, fetcher: stalledFetcher, timeBudgetMs: 30 }),
    (error) => error.code === 'AGENT_TIMEOUT' && /ran out of time/.test(error.message),
  );
});

test('F8: cancelling within the budget is still reported as a cancellation', async () => {
  const { requirementWorkflow } = await load();
  const controller = new AbortController();
  const pending = requirementWorkflow({
    settings,
    requirement,
    fetcher: stalledFetcher,
    signal: controller.signal,
    timeBudgetMs: 60000,
  });
  controller.abort();
  await assert.rejects(pending, { code: 'GENERATION_CANCELLED' });
});
