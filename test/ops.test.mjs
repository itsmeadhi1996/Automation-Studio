import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createMetrics, storageHealth } from '../ops.mjs';
import { createStudio } from './support.mjs';

test('metrics report status classes and latency percentiles', () => {
  const metrics = createMetrics(3);
  for (const [status, ms] of [[200, 1], [200, 2], [404, 3], [500, 10]]) metrics.record('GET', status, ms);
  const snap = metrics.snapshot();
  assert.equal(snap.requests, 4);
  assert.deepEqual(snap.statuses, { '2xx': 2, '4xx': 1, '5xx': 1 });
  assert.equal(snap.latencyMs.samples, 3);
  assert.equal(snap.latencyMs.max, 10);
});

test('storage health counts backups and flags missing directories', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'qa-health-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'backup-1-aaaaaa.json'), '{}');
  const ok = await storageHealth(dir, dir);
  assert.equal(ok.backups, 1);
  assert.equal(ok.dataWritable, true);
  const missing = await storageHealth(path.join(dir, 'nope'), dir);
  assert.equal(missing.dataWritable, false);
  assert.equal(missing.backups, 0);
});

test('health endpoint is public, reports status and sets a request id', async t => {
  const port = 3390 + Math.floor(Math.random() * 50);
  const storage = path.resolve('.test-output', 'ops-health-' + port + '-' + Date.now());
  const studio = await createStudio({ port, storage, authenticated: false });
  await studio.listen();
  t.after(async () => { await studio.close(); await rm(storage, { recursive: true, force: true }).catch(() => {}); });
  const response = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('x-request-id'), /^[0-9a-f-]{8}$/);
  const body = await response.json();
  assert.equal(body.status, 'ok');
  assert.equal(typeof body.eventLoopDelayMs, 'number');
  assert.ok(body.metrics.requests >= 0);
});
