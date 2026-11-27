import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createStudio } from './support.mjs';

const storageFor = (name) => path.resolve('.test-output', `hardening-${name}-${Date.now()}`);

const until = async (condition, timeout = 15000) => {
  const end = Date.now() + timeout;
  while (!(await condition()) && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 100));
  return condition();
};

function client(port) {
  const base = `http://127.0.0.1:${port}`;
  return async (route, method = 'GET', body, cookie = '') => {
    const response = await fetch(base + route, {
      method,
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await response.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      data = raw;
    }
    return { status: response.status, data, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
}

test('a lock left by a crashed container or an earlier process does not block the next start', { timeout: 60000 }, async (t) => {
  const storage = storageFor('lock');
  const data = path.join(storage, 'data');
  await mkdir(data, { recursive: true });
  t.after(() => rm(storage, { recursive: true, force: true }).catch(() => {}));
  const lock = path.join(data, 'studio.lock');

  // A container's server is always process 1, so an old container's lock names the new process.
  await writeFile(lock, JSON.stringify({ pid: process.pid, host: os.hostname(), boot: 'earlier-boot' }));
  let studio = await createStudio({ port: 3571, storage });
  const owner = JSON.parse(await readFile(lock, 'utf8'));
  assert.equal(owner.pid, process.pid);
  assert.notEqual(owner.boot, 'earlier-boot');
  // The same process cannot open the workspace twice.
  await assert.rejects(createStudio({ port: 3572, storage }), /already open/);
  await studio.close();

  // A lock written before boot ids existed, by this process id, is left over as well.
  await writeFile(lock, JSON.stringify({ pid: process.pid }));
  studio = await createStudio({ port: 3571, storage });
  await studio.close();
});

test('failed sign-ins are limited per account, from any address', { timeout: 60000 }, async (t) => {
  const storage = storageFor('signin');
  const studio = await createStudio({ port: 3573, storage, authenticated: false });
  await studio.listen();
  t.after(async () => {
    await studio.close();
    await rm(storage, { recursive: true, force: true }).catch(() => {});
  });
  const api = client(3573);
  const admin = { username: 'owner', name: 'Owner', password: 'Owner-password-2026' };
  assert.equal((await api('/api/auth/setup', 'POST', admin)).status, 201);

  // Twenty wrong passwords, spread so the per-address limit never applies.
  for (let i = 0; i < 20; i++) {
    process.env.RENDER = '1';
    const response = await fetch('http://127.0.0.1:3573/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `203.0.113.${i + 1}` },
      body: JSON.stringify({ ...admin, password: 'wrong-password' }),
    });
    delete process.env.RENDER;
    assert.equal(response.status, 401);
  }
  const locked = await api('/api/auth/login', 'POST', admin);
  assert.equal(locked.status, 429);
  assert.match(locked.data.error, /this account/);
  // Other accounts are unaffected.
  assert.equal((await api('/api/auth/login', 'POST', { username: 'someone', password: 'x' })).status, 401);
});

test('on a hosted site only an administrator can choose a command-line MCP server', { timeout: 60000 }, async (t) => {
  const storage = storageFor('mcp');
  process.env.RENDER = '1';
  t.after(() => delete process.env.RENDER);
  const studio = await createStudio({ port: 3574, storage, authenticated: false });
  await studio.listen();
  t.after(async () => {
    await studio.close();
    await rm(storage, { recursive: true, force: true }).catch(() => {});
  });
  const api = client(3574);
  const admin = { username: 'owner', name: 'Owner', password: 'Owner-password-2026' };
  const member = {
    username: 'member',
    name: 'Member',
    password: 'Member-password-2026',
    permissions: { qa: true, automation: true, useMcp: true, manageMcp: true },
  };
  assert.equal((await api('/api/auth/setup', 'POST', admin)).status, 201);
  const adminCookie = (await api('/api/auth/login', 'POST', admin)).cookie;
  assert.equal((await api('/api/admin/users', 'POST', member, adminCookie)).status, 201);
  const cookie = (await api('/api/auth/login', 'POST', member)).cookie;

  const tool = { id: 'tool', name: 'Shell tool', transport: 'stdio', command: 'node', args: ['tool.mjs'] };
  const denied = await api('/api/mcp/servers', 'PUT', { mcpServers: [tool] }, cookie);
  assert.equal(denied.status, 400);
  assert.match(denied.data.error, /only an administrator/);
  assert.equal((await api('/api/mcp/servers', 'PUT', { mcpServers: [tool] }, adminCookie)).status, 200);
  // The member may rename the administrator's connection, but not change its command.
  assert.equal((await api('/api/mcp/servers', 'PUT', { mcpServers: [{ ...tool, name: 'Renamed' }] }, cookie)).status, 200);
  const changed = { ...tool, args: ['other.mjs'] };
  assert.equal((await api('/api/mcp/servers', 'PUT', { mcpServers: [changed] }, cookie)).status, 400);
  // Presets stay available.
  assert.equal((await api('/api/mcp/presets/playwright', 'POST', {}, cookie)).status, 200);
});

test('a hosted recording left without its window stops by itself', { timeout: 90000 }, async (t) => {
  process.env.STUDIO_NO_SCREEN = '1';
  t.after(() => delete process.env.STUDIO_NO_SCREEN);
  const site = http.createServer((req, res) => res.end('<!doctype html><button>Save</button>'));
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => site.close(resolve)));
  const storage = storageFor('idle');
  const studio = await createStudio({ port: 3575, storage, idleRecordingMs: 1500 });
  await studio.listen();
  t.after(async () => {
    await studio.close();
    await rm(storage, { recursive: true, force: true }).catch(() => {});
  });
  const api = client(3575);
  const project = (await api('/api/state?workspace=automation')).data.projects[0];
  const started = await api('/api/recordings', 'POST', {
    projectId: project.id,
    testId: project.tests[0].id,
    url: `http://127.0.0.1:${site.address().port}`,
  });
  assert.equal(started.status, 201, JSON.stringify(started.data));
  assert.ok(started.data.remote);
  assert.ok(await until(async () => (await api('/api/status')).data.activeRecording?.status === 'stopped'));
  const recording = (await api('/api/status')).data.activeRecording;
  assert.ok(recording.warnings.some((warning) => /stopped after \d+ minutes/.test(warning)));
  // The stopped recording is kept for review, as after Stop.
  assert.ok(await until(() => studio.store.recording?.status === 'stopped'));
});

test('a failing save is logged and reported by the health check', { timeout: 60000, skip: (process.platform === 'win32' || process.getuid?.() === 0) && 'read-only folders need POSIX permissions and a non-root user' }, async (t) => {
  const storage = storageFor('save');
  const studio = await createStudio({ port: 3576, storage });
  await studio.listen();
  const data = path.join(storage, 'data');
  t.after(async () => {
    await chmod(data, 0o755).catch(() => {});
    await studio.close();
    await rm(storage, { recursive: true, force: true }).catch(() => {});
  });
  const api = client(3576);
  await chmod(data, 0o555);
  const project = (await api('/api/state?workspace=automation')).data.projects[0];
  await api(`/api/projects/${project.id}`, 'PUT', { ...project, name: 'Renamed', workspace: 'automation' });
  const health = (await api('/api/health')).data;
  assert.equal(health.status, 'degraded');
  assert.ok(health.lastSaveError.message);
  await chmod(data, 0o755);
});
