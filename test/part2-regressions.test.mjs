import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readdir, rm } from 'node:fs/promises';
import { createStudio } from './support.mjs';

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

test('seed project contains the welcome test against /demo', async (t) => {
  const f = await fixture(t, 3514);
  const [project] = f.studio.store.projects;
  assert.equal(project.name, 'Getting started');
  assert.equal(project.tests[0].tcNumber, 1);
  assert.equal(project.environments[0].variables.BASE_URL, 'http://127.0.0.1:3514/demo');
});
