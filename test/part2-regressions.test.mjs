import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createStudio } from './support.mjs';
import { createVault } from '../storage.mjs';

const ADMIN = { username: 'regression-admin', name: 'Regression admin', password: 'Disposable-regression-2026' };
const QA_USER = { username: 'regression-qa', name: 'Regression QA', password: 'Disposable-qa-password-2026' };

async function fixture(t, port) {
  const storage = path.resolve('.test-output', `tmp-part2-${port}-${Date.now()}`);
  const studio = await createStudio({ port, storage, authenticated: false });
  await studio.listen();
  t.after(async () => {
    await studio.close();
    await rm(storage, { recursive: true, force: true }).catch(() => {});
  });
  const base = `http://127.0.0.1:${port}`;
  const api = async (route, method = 'GET', body, cookie = '') => {
    const response = await fetch(base + route, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: response.status, data, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  await api('/api/auth/setup', 'POST', ADMIN);
  const adminCookie = (await api('/api/auth/login', 'POST', ADMIN)).cookie;
  const created = await api(
    '/api/admin/users',
    'POST',
    { ...QA_USER, permissions: { qa: true, automation: false } },
    adminCookie,
  );
  assert.equal(created.status, 201);
  const assignment = (await api('/api/admin/projects', 'GET', undefined, adminCookie)).data.projects[0];
  const members = await api(
    `/api/admin/projects/${assignment.id}/members`,
    'PUT',
    { userIds: [created.data.id], revision: assignment.revision },
    adminCookie,
  );
  assert.equal(members.status, 200);
  const qaCookie = (await api('/api/auth/login', 'POST', QA_USER)).cookie;
  return { studio, storage, api, adminCookie, qaCookie, projectId: assignment.id };
}

function seedProtectedValues(project) {
  project.globalVariables = { SECRET_GLOBAL: 'global-secret-value' };
  project.environments[0].variables.API_TOKEN = 'environment-secret-value';
  project.jdbcProfiles = [
    { id: 'db', name: 'Db', host: 'localhost', port: 5432, database: 'd', username: 'u', password: 'db-secret-value', sslmode: 'disable' },
  ];
  project.tests[0].dataRows = [{ ROW_VALUE: 'row-secret-value' }];
  project.tests[0].localTestData = [
    { name: 'LOCAL_VALUE', value: 'local-secret-value', keepGlobal: false, source: 'manual', config: {} },
  ];
  project.tests[0].steps.push({
    name: 'Sensitive',
    action: 'fill',
    locatorType: 'label',
    target: 'Password',
    value: 'step-secret-value',
    valueMode: 'static',
    sensitive: true,
  });
}

const SECRET = /(global|environment|db|row|local|step)-secret-value/;

test('F1: project payloads hide protected values from QA-only users and QA saves keep them', async (t) => {
  const f = await fixture(t, 3510);
  seedProtectedValues(f.studio.store.projects[0]);

  const state = await f.api('/api/state', 'GET', undefined, f.qaCookie);
  assert.equal(state.status, 200);
  assert.doesNotMatch(JSON.stringify(state.data), SECRET);

  const project = state.data.projects[0];
  project.tests[0].qa.description = 'Edited by QA';
  const saved = await f.api(`/api/projects/${project.id}`, 'PUT', project, f.qaCookie);
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.doesNotMatch(JSON.stringify(saved.data), SECRET);
  assert.equal(saved.data.tests[0].qa.description, 'Edited by QA');

  const stored = f.studio.store.projects[0];
  assert.equal(stored.globalVariables.SECRET_GLOBAL, 'global-secret-value');
  assert.equal(stored.environments[0].variables.API_TOKEN, 'environment-secret-value');
  assert.equal(stored.jdbcProfiles[0].password, 'db-secret-value');
  assert.equal(stored.tests[0].dataRows[0].ROW_VALUE, 'row-secret-value');
  assert.equal(stored.tests[0].localTestData[0].value, 'local-secret-value');
  assert.equal(stored.tests[0].steps.at(-1).value, 'step-secret-value');
});

test('F3: the request body asset check ignores the query string', async (t) => {
  const f = await fixture(t, 3511);
  const project = { name: 'Asset check', tests: [], captureScreenshot: 'capture-not-readable.png' };
  const created = await f.api('/api/admin/users', 'POST', {
    username: 'regression-creator',
    name: 'Creator',
    password: 'Disposable-creator-2026',
    permissions: { qa: true, createProjects: true },
  }, f.adminCookie);
  assert.equal(created.status, 201);
  const cookie = (await f.api('/api/auth/login', 'POST', {
    username: 'regression-creator',
    password: 'Disposable-creator-2026',
  })).cookie;
  assert.equal((await f.api('/api/projects', 'POST', project, cookie)).status, 403);
  assert.equal((await f.api('/api/projects?x=1', 'POST', project, cookie)).status, 403);
});

test('F7: a project save rejected by the studio check writes no backup', async (t) => {
  const f = await fixture(t, 3512);
  const countBackups = async () =>
    (await readdir(path.join(f.storage, 'data'))).filter((name) => name.startsWith('backup-')).length;
  const project = (await f.api('/api/state', 'GET', undefined, f.qaCookie)).data.projects[0];
  const before = await countBackups();
  const rejected = await f.api(`/api/projects/${project.id}`, 'PUT', { ...project, workspace: 'automation' }, f.qaCookie);
  assert.equal(rejected.status, 403);
  assert.equal(await countBackups(), before);
});

test('project create, save and stale writes through the API', async (t) => {
  const f = await fixture(t, 3513);
  const created = await f.api('/api/projects', 'POST', { name: 'Created project', tests: [] }, f.adminCookie);
  assert.equal(created.status, 201);
  assert.equal(created.data.revision, 1);

  const saved = await f.api(`/api/projects/${created.data.id}`, 'PUT', { ...created.data, name: 'Renamed' }, f.adminCookie);
  assert.equal(saved.status, 200);
  assert.equal(saved.data.name, 'Renamed');
  assert.equal(saved.data.revision, 2);

  const stale = await f.api(`/api/projects/${created.data.id}`, 'PUT', { ...created.data, name: 'Stale' }, f.adminCookie);
  assert.equal(stale.status, 409);
  assert.equal(stale.data.code, 'EDIT_CONFLICT');
});

test('F2: run snapshots hide local values and sensitive steps from QA-only users', async (t) => {
  const f = await fixture(t, 3515);
  const [project] = f.studio.store.projects;
  const secretStep = { name: 'Sensitive', action: 'fill', value: 'step-secret-value', sensitive: true, status: 'passed' };
  f.studio.store.runs.unshift({
    id: 'secret-run',
    projectId: project.id,
    projectName: project.name,
    mode: 'automation',
    status: 'passed',
    startedAt: new Date().toISOString(),
    context: { globals: { SECRET_GLOBAL: 'global-secret-value' } },
    tests: [
      {
        id: 'case',
        name: 'Case',
        status: 'passed',
        localValues: { LOCAL_VALUE: 'local-secret-value' },
        dataRow: { ROW_VALUE: 'row-secret-value' },
        steps: [secretStep],
      },
    ],
  });
  for (const route of ['/api/state', '/api/status', '/api/runs', '/api/runs/secret-run']) {
    const response = await f.api(route, 'GET', undefined, f.qaCookie);
    assert.equal(response.status, 200, route);
    assert.match(JSON.stringify(response.data), /secret-run/, route);
    assert.doesNotMatch(JSON.stringify(response.data), SECRET, route);
  }
  const admin = await f.api('/api/runs/secret-run', 'GET', undefined, f.adminCookie);
  assert.equal(admin.data.tests[0].localValues.LOCAL_VALUE, 'local-secret-value');
  assert.equal(admin.data.context, undefined);
});

test('the seed welcome test passes in Chrome through POST /api/runs', { timeout: 120000 }, async (t) => {
  const f = await fixture(t, 3516);
  const [project] = f.studio.store.projects;
  const started = await f.api('/api/runs', 'POST', { projectId: project.id, testId: 'welcome' }, f.adminCookie);
  assert.equal(started.status, 202, JSON.stringify(started.data));

  let run;
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    run = (await f.api(`/api/runs/${started.data.id}`, 'GET', undefined, f.adminCookie)).data;
    if (run.status !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const failures = run.tests.flatMap((test) => test.steps.filter((step) => step.status !== 'passed'));
  assert.equal(run.status, 'passed', JSON.stringify(failures));
  assert.equal(run.tests[0].steps.length, 4);
  assert.ok(run.tests[0].steps.every((step) => step.screenshot), 'every step has a screenshot');

  const report = await f.api(`/api/runs/${run.id}/report`, 'GET', undefined, f.adminCookie);
  assert.equal(report.status, 200);
  assert.ok(report.data.includes('Check the welcome message'), 'the report lists the step');
  assert.ok(!report.data.includes('Welcome, Alex!'), 'the report omits test values');
  const screenshot = await fetch(`http://127.0.0.1:3516/artifacts/${run.tests[0].steps[0].screenshot}`, {
    headers: { Cookie: f.adminCookie },
  });
  assert.equal(screenshot.status, 200);
  assert.equal(screenshot.headers.get('content-type'), 'image/png');
});

test('seed project contains the welcome test against /demo', async (t) => {
  const f = await fixture(t, 3514);
  const [project] = f.studio.store.projects;
  assert.equal(project.name, 'Getting started');
  assert.equal(project.tests[0].tcNumber, 1);
  assert.equal(project.environments[0].variables.BASE_URL, 'http://127.0.0.1:3514/demo');
});

test('F11: a credentials.key that cannot decrypt the workspace fails clearly and changes nothing', async () => {
  const directory = path.resolve('.test-output', `tmp-part2-wrong-key-${Date.now()}`);
  await mkdir(directory, { recursive: true });
  const keyFile = path.join(directory, 'credentials.key');
  await writeFile(keyFile, JSON.stringify({ key: randomBytes(32).toString('base64') }));
  const sealed = (await createVault(directory)).encode({ password: 'vault-secret' });
  const otherKey = JSON.stringify({ key: randomBytes(32).toString('base64') });
  await writeFile(keyFile, otherKey);
  const vault = await createVault(directory);
  assert.throws(() => vault.decode(sealed), /cannot decrypt this workspace.*Nothing was changed/);
  assert.equal(await readFile(keyFile, 'utf8'), otherKey);
  await rm(directory, { recursive: true, force: true });
});

test('execution overview requires projectId', async (t) => {
  const f = await fixture(t, 3517);
  const response = await f.api('/api/automation/execution-overview', 'GET', undefined, f.adminCookie);
  assert.equal(response.status, 400);
  assert.equal(response.data.error, 'projectId is required.');
});

test('hosted mode accepts only its public origin and never offers first-run setup', async (t) => {
  const storage = path.resolve('.test-output', `tmp-part2-public-${Date.now()}`);
  const publicUrl = 'https://studio.example.test';
  const fallbackStorage = `${storage}-default`;
  const fallback = await createStudio({ port: 3518, storage: fallbackStorage, publicUrl, authenticated: false });
  await fallback.close();
  const users = await readFile(path.join(fallbackStorage, 'data', 'users.json'), 'utf8');
  assert.match(users, /"username":\s*"admin@adhish"/);
  assert.match(users, /"passwordHash":\s*"83ef95c7e01983533804580f7167be1a:/);
  assert.match(users, /"role":\s*"admin"/);
  await rm(fallbackStorage, { recursive: true, force: true }).catch(() => {});
  Object.assign(process.env, { STUDIO_ADMIN_USERNAME: 'owner', STUDIO_ADMIN_PASSWORD: 'Hosted-owner-password-2026' });
  const studio = await createStudio({ port: 3518, storage, publicUrl, authenticated: false }).finally(() => {
    delete process.env.STUDIO_ADMIN_USERNAME;
    delete process.env.STUDIO_ADMIN_PASSWORD;
  });
  await studio.listen();
  t.after(async () => {
    await studio.close();
    await rm(storage, { recursive: true, force: true }).catch(() => {});
  });
  // fetch() drops a custom Host header, so send the hosted site's headers through node:http.
  const request = (route, headers, body) =>
    new Promise((resolve, reject) => {
      const req = httpRequest(
        { host: '127.0.0.1', port: 3518, path: route, method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...headers } },
        (res) => {
          let text = '';
          res.on('data', (chunk) => (text += chunk));
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, data: text && JSON.parse(text) }));
        },
      );
      req.on('error', reject);
      req.end(body && JSON.stringify(body));
    });
  const site = { Host: 'studio.example.test', Origin: publicUrl };
  assert.equal((await request('/api/auth/session', site)).data.setupRequired, false);
  const setup = await request('/api/auth/setup', site, { username: 'x', name: 'x', password: 'Attacker-password-2026' });
  assert.equal(setup.status, 409);
  const login = await request('/api/auth/login', site, { username: 'owner', password: 'Hosted-owner-password-2026' });
  assert.equal(login.status, 200);
  assert.match(login.headers['set-cookie'][0], /; Secure$/);
  assert.equal((await request('/api/auth/session', { Host: 'evil.example.test' })).status, 403);
  assert.equal((await request('/api/auth/session', { ...site, Origin: 'https://evil.example.test' })).status, 403);
});
