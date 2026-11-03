import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fetchOllama } from '../ollama-http.mjs';

async function service(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}/api/chat`;
}

test('Ollama transport waits for delayed headers and a delayed JSON body under its overall deadline', async t => {
  let received;
  const endpoint = await service(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received = { method: req.method, body: JSON.parse(Buffer.concat(chunks)), key: req.headers.authorization };
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"done":');
      setTimeout(() => res.end('true}'), 80);
    }, 80);
  });
  const response = await fetchOllama(endpoint, {
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'qwen3.5:35b' }), signal: AbortSignal.timeout(2000)
  });
  assert.equal(response.status, 200);
  assert.equal(response.ok, true);
  assert.deepEqual(await response.json(), { done: true });
  assert.deepEqual(received, { method: 'POST', body: { model: 'qwen3.5:35b' }, key: undefined });
});

for (const phase of ['before headers', 'during body']) test(`Ollama transport cancels a stalled request ${phase}`, async t => {
  let began;
  const started = new Promise(resolve => began = resolve);
  let disconnected;
  const closed = new Promise(resolve => disconnected = resolve);
  const endpoint = await service(t, (req, res) => {
    res.on('close', disconnected);
    if (phase === 'during body') { res.writeHead(200); res.write('{"done":'); }
    began();
  });
  const controller = new AbortController();
  const pending = fetchOllama(endpoint, { signal: controller.signal, body: '{}' });
  const rejected = assert.rejects(pending, error => error.name === 'AbortError' && error.cause?.name === 'TimeoutError');
  await started;
  controller.abort(new DOMException('Generation deadline elapsed', 'TimeoutError'));
  await rejected;
  await closed;
});

test('Ollama transport preserves HTTP failures and malformed JSON for the caller', async t => {
  const endpoint = await service(t, (req, res) => { res.writeHead(503); res.end('{invalid json'); });
  const response = await fetchOllama(endpoint, { body: '{}' });
  assert.equal(response.status, 503);
  assert.equal(response.ok, false);
  await assert.rejects(response.json(), SyntaxError);
});

test('Ollama transport reports a disconnected model response', async t => {
  const endpoint = await service(t, (req, res) => {
    res.writeHead(200); res.write('{"done":');
    setImmediate(() => res.destroy());
  });
  await assert.rejects(fetchOllama(endpoint, { body: '{}' }), error => error.code === 'ECONNRESET');
});

test('Ollama transport refuses redirects without contacting their destination', async t => {
  let followed = false;
  const destination = await service(t, (req, res) => { followed = true; res.end('{}'); });
  const endpoint = await service(t, (req, res) => { res.writeHead(307, { Location: destination }); res.end(); });
  await assert.rejects(fetchOllama(endpoint, { body: '{}' }), error => error.code === 'OLLAMA_REDIRECT');
  assert.equal(followed, false);
  await assert.rejects(fetchOllama('https://example.test/api/chat'), /local HTTP URL/);
});

test('Ollama transport bounds the buffered model response', async t => {
  const endpoint = await service(t, (req, res) => res.end(Buffer.alloc(8 * 1024 * 1024 + 1, 'x')));
  await assert.rejects(fetchOllama(endpoint, { body: '{}' }), error => error.code === 'OLLAMA_RESPONSE_TOO_LARGE');
});
