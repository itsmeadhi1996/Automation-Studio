import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, open, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { launchBrowser } from './browsers.mjs';
import { queryDatabase } from './database.mjs';
import { parseCsv } from './datasets.mjs';
import { executionCsv, queryExecutionOverview } from './execution-overview.mjs';
import { queryRunHistory } from './history-query.mjs';
import { inspectPage, validateGeneratedTest } from './inspection.mjs';
import { fileLimit, normalizeLocalData, readDataTable, resolveLocalValue } from './local-data.mjs';
import { reportHtml } from './reports.mjs';
import { executeRun, locator, preflight, startDebugSession } from './runner.mjs';
import {
  adminOnlyPermissions,
  authorize,
  can,
  createAuth,
  homeFor,
  permissionCatalog,
  qaProjectInput,
} from './auth.mjs';
import { automationProject, ensureAutomationCases, mergeAutomationProject } from './automation-model.mjs';
import { contentTag, createStaticResponder, sendText } from './http-response.mjs';
import {
  mapRecordedSteps,
  migrateRepository,
  normalizeProject,
  prepareRun,
  resolveLocator,
  resolveValue,
  sampleProject,
} from './model.mjs';
import { createMetrics, eventLoopDelay, storageHealth } from './ops.mjs';
import { caseRun, isIndividualCaseRun, matchesCase, recoverTestPlans } from './public/run-history.js';
import { createManualRun, updateManualRun } from './qa-model.mjs';
import { startRecording } from './recorder.mjs';
import { requirementErrorUserMessage } from './requirement-errors.mjs';
import { selectPlannedTests } from './test-plan.mjs';
import { sourceVersion } from './runtime-version.mjs';
import { createVault } from './storage.mjs';

const appRoot = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_PORT = 3300;
const BODY_LIMIT_BYTES = 2 * 1024 * 1024;
const SAVE_BATCH_MS = 200;
const SHUTDOWN_GRACE_MS = 5000;
const WORK_LOG_LIMIT = 10000;
const WORK_LOG_PAGE = 50;
const BACKUPS_KEPT = 20;
const STATE_RUN_LIMIT = 100;
const BACKUP_NAME = /^backup-[\w-]+\.json$/;
const SUPPORTED_BROWSERS = ['chrome', 'firefox', 'edge'];
const ASSET_KEYS = ['screenshot', 'captureScreenshot', 'trace', 'fileId'];
const REPOSITORY_FIELDS = ['objects', 'locatorTemplates', 'tests', 'prerequisites', 'repositoryLegacyObjects'];
const MAX_SCHEDULES = 100;
const MAX_INTERVAL_MINUTES = 525600;
const SCHEDULE_TICK_MS = 1000;
const SCHEDULE_REQUEST_TIMEOUT_MS = 30000;
const MAX_GLOBALS = 500;
const MAX_RUN_NAME = 120;
const RETAIN_MAX = 10000;
const TARGET_CHECK_TIMEOUT_MS = 10000;
const ARTIFACT_NAME = /^[\w-]+\.(png|zip)$/;
const REPORT_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'";

const PAGE_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
  "object-src 'none'; frame-ancestors 'none'; base-uri 'self'";

const PUBLIC_ROUTES = new Set(['/login', '/login.js', '/auth.css', '/theme.js', '/theme.css', '/demo', '/demo.js']);
const SIGNED_OUT_REDIRECTS = new Set([
  '/',
  '/automation',
  '/run-history',
  '/admin',
  '/admin/permissions',
  '/admin/projects',
  '/account',
]);

const SAME_NAME_ASSETS = [
  'qa.js',
  'app.js',
  'automation-cases.js',
  'history-page.js',
  'execution-overview.js',
  'requirements.js',
  'login.js',
  'auth.css',
  'theme.js',
  'theme.css',
  'demo.js',
  'account.js',
  'admin.js',
  'projects.js',
  'permissions.js',
  'auth-ui.js',
  'ui.js',
  'ui.css',
  'studio-design.css',
  'style.css',
  'qa.css',
  'history.css',
  'requirements.css',
  'execution-overview.css',
  'test-plan-page.js',
  'test-plan-page.css',
  'run-history.js',
  'folders.js',
  'local-data.js',
  'locator-templates.js',
  'reasonx-models.js',
  'auto-generator-prompt.js',
];

const STATIC_ROUTES = new Map([
  ['/', 'qa.html'],
  ['/automation', 'index.html'],
  ['/run-history', 'index.html'],
  ['/admin', 'admin.html'],
  ['/admin/projects', 'projects.html'],
  ['/admin/permissions', 'permissions.html'],
  ['/login', 'login.html'],
  ['/demo', 'demo.html'],
  ['/account', 'account.html'],
  ...SAME_NAME_ASSETS.map((name) => [`/${name}`, name]),
]);

const CONTENT_TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

const httpError = (message, status, extra = {}) => Object.assign(new Error(message), { status, ...extra });

const check = (condition, message) => {
  if (!condition) throw httpError(message, 400);
};

const WORK_LOG_ACTIONS = [
  [/^\/api\/admin\/projects\//, () => 'Project access updated'],
  [/^\/api\/projects$/, () => 'Project created'],
  [/^\/api\/projects\/.*\/tests$/, () => 'Test case created'],
  [/^\/api\/projects\//, () => 'Project updated'],
  [/^\/api\/manual-runs$/, () => 'Manual run created'],
  [/^\/api\/manual-runs\/.*\/steps$/, () => 'Manual results updated'],
  [/^\/api\/manual-runs\/.*\/complete$/, () => 'Manual run completed'],
  [/^\/api\/manual-runs\/.*\/cancel$/, () => 'Manual run cancelled'],
  [/^\/api\/runs$/, () => 'Automation run started'],
  [/^\/api\/runs\/.*\/cancel$/, () => 'Run cancellation requested'],
  [/^\/api\/runs\//, () => 'Run deleted'],
  [/^\/api\/automation\/handoff$/, () => 'Cases opened for automation'],
  [/^\/api\/recordings/, (route) => `Recording ${route.split('/')[4] || 'started'}`],
  [/^\/api\/debug/, (route) => `Debug ${route.split('/')[4] || 'started'}`],
  [/^\/api\/schedules/, (route, method) => `Schedule ${method === 'DELETE' ? 'removed' : 'created'}`],
  [/^\/api\/ai\/create$/, () => 'Automation generated'],
  [/^\/api\/issues$/, () => 'Issue reported'],
];

function workLogAction(route, method) {
  const match = WORK_LOG_ACTIONS.find(([pattern]) => pattern.test(route));
  return match?.[1](route, method);
}

function maskSensitiveSteps(steps = []) {
  return steps.map((step) => (step.sensitive ? { ...step, value: '' } : step));
}

function redactCaseValues(item) {
  const result = { ...item, steps: maskSensitiveSteps(item.steps) };
  if (result.dataRows) result.dataRows = [];
  if (result.dataRow) delete result.dataRow;
  if (result.localValues) delete result.localValues;
  if (result.localTestData) {
    result.localTestData = result.localTestData.map(({ name, source, keepGlobal }) => ({
      name,
      source,
      keepGlobal,
      value: '',
      config: {},
    }));
  }
  return result;
}

// A viewer without Automation Studio sees project structure but no protected values.
// Their saves go through qaProjectInput, which keeps these fields from the stored project.
function redactProject(project) {
  return {
    ...project,
    environments: project.environments.map((environment) => ({ ...environment, variables: {} })),
    globalVariables: {},
    jdbcProfiles: project.jdbcProfiles.map((profile) => ({ ...profile, password: '' })),
    tests: project.tests.map(redactCaseValues),
    prerequisites: project.prerequisites.map(redactCaseValues),
  };
}

function redactRun(run) {
  return { ...run, tests: run.tests.map(redactCaseValues) };
}

async function acquireWorkspaceLock(directory) {
  const lockFile = path.join(directory, 'studio.lock');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockFile, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid }));
      return async () => {
        await handle.close();
        await unlink(lockFile).catch(() => {});
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    let owner;
    try {
      owner = JSON.parse(await readFile(lockFile, 'utf8'));
    } catch {
      throw new Error('Workspace lock is unreadable. Stop other Studio instances before removing data/studio.lock.');
    }
    let alive = true;
    try {
      process.kill(owner.pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') alive = false;
    }
    if (alive) throw new Error('This workspace is already open in another Studio server.');
    await unlink(lockFile);
  }
  throw new Error('Could not lock the workspace');
}

export async function createStudio(options = {}) {
  const directory = path.join(options.storage || process.env.STUDIO_STORAGE_DIR || appRoot, 'data');
  await mkdir(directory, { recursive: true });
  const releaseLock = await acquireWorkspaceLock(directory);
  let studio;
  try {
    studio = await createUnlockedStudio(options);
  } catch (error) {
    await releaseLock();
    throw error;
  }
  const closeServer = studio.close;
  let closing;
  studio.close = () =>
    (closing ||= (async () => {
      try {
        await closeServer();
      } finally {
        await releaseLock();
      }
    })());
  return studio;
}

async function createUnlockedStudio({
  port = Number(process.env.PORT || DEFAULT_PORT),
  storage = process.env.STUDIO_STORAGE_DIR || appRoot,
  recordingLauncher = startRecording,
} = {}) {
  const dataDir = path.join(storage, 'data');
  const artifactsDir = path.join(storage, 'artifacts');
  await mkdir(dataDir, { recursive: true });
  await mkdir(artifactsDir, { recursive: true });
  const storeFile = path.join(dataDir, 'studio.json');

  const metrics = createMetrics();
  const vault = await createVault(dataDir);
  const auth = await createAuth(dataDir);
  const runtime = { pid: process.pid, sourceVersion: await sourceVersion(appRoot) };
  const requestScope = new AsyncLocalStorage();
  const serveStatic = createStaticResponder(path.join(appRoot, 'public'));

  let store;
  try {
    store = vault.decode(JSON.parse(await readFile(storeFile, 'utf8')));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    store = { projects: [], runs: [], nextTestNumber: 1 };
  }
  store.projects = store.projects.map((project) => {
    const recovered = recoverTestPlans(project, store.runs);
    delete recovered._recoveredTestPlans;
    return recovered;
  });
  store.nextTestNumber = Math.max(
    store.nextTestNumber || 1,
    ...store.projects.flatMap((project) => project.tests.map((test) => (test.tcNumber || 0) + 1)),
  );

  let repositoryMigrated = false;
  const repositorySnapshot = (project) => JSON.stringify(REPOSITORY_FIELDS.map((field) => project[field]));
  for (const project of store.projects) {
    const before = repositorySnapshot(project);
    migrateRepository(project);
    if (before !== repositorySnapshot(project)) {
      repositoryMigrated = true;
      project.revision = (project.revision || 0) + 1;
    }
    project.revision ||= 1;
    if (!SUPPORTED_BROWSERS.includes(project.browser)) project.browser = 'chrome';
    for (const test of project.tests) {
      if (!test.tcNumber) {
        test.tcNumber = store.nextTestNumber;
        store.nextTestNumber += 1;
      }
    }
  }

  // A browser session cannot resume after a restart; manual runs simply carry on.
  for (const run of store.runs) {
    if (run.status !== 'running' || run.mode === 'manual') continue;
    run.status = 'interrupted';
    for (const test of run.tests) {
      if (test.status === 'running' || test.status === 'pending') test.status = 'skipped';
      for (const step of test.steps) {
        if (step.status === 'running' || step.status === 'pending') step.status = 'skipped';
      }
    }
  }

  if (!store.projects.length) store.projects.push(normalizeProject(sampleProject(port), null, store));

  store.projectMembers ||= {};
  // Preserve the old workspace-wide revision when migrating existing assignments.
  store.projectAccessRevisions ||= Object.fromEntries(
    store.projects.map((project) => [project.id, store.projectAccessRevision || 0]),
  );
  delete store.projectAccessRevision;
  store.workLog ||= [];
  store.workLogStartedAt ||= new Date().toISOString();
  store.schedules ||= [];

  let activeRun = null;
  let execution = null;
  let runController = null;
  let recording = null;
  let startingBrowser = false;
  let schedulerWork = null;
  let scheduleTimer = null;
  const debugSessions = new Map();
  const serviceGrants = new Map();

  // A stopped recording only awaits review (it survives restarts); runs and debug may proceed.
  const recordingLive = () => Boolean(recording && recording.status !== 'stopped');

  const accessRevision = (projectId) =>
    Object.hasOwn(store.projectAccessRevisions, projectId) ? store.projectAccessRevisions[projectId] : 0;

  // ---- Persistence ---------------------------------------------------------

  let writeQueue = Promise.resolve();
  let latestSave = null;
  let saveTimer = null;
  let closing = false;

  // Saves are coalesced: the workspace is encrypted and serialized when its turn
  // in the queue comes, so a burst of saves becomes one write of the latest state.
  // Callers whose write was superseded resolve with the newer write.
  const persist = () => {
    const entry = {};
    latestSave = entry;
    const work = writeQueue.then(async () => {
      if (latestSave !== entry) return true;
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      await writeFile(`${storeFile}.tmp`, JSON.stringify(vault.encode(store)));
      await rename(`${storeFile}.tmp`, storeFile);
      return false;
    });
    entry.done = work.then((superseded) => (superseded ? latestSave.done : undefined));
    writeQueue = work.catch(() => {});
    return entry.done;
  };

  const persistSoon = () => {
    if (closing) {
      persist().catch(() => {});
      return;
    }
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      persist().catch(() => {});
    }, SAVE_BATCH_MS);
    saveTimer.unref?.();
  };

  // Flushes first, so the copy includes changes still waiting in the save timer.
  async function backup() {
    if (saveTimer) await persist();
    await writeQueue;
    const name = `backup-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.json`;
    await copyFile(storeFile, path.join(dataDir, name));
    const backups = (await readdir(dataDir)).filter((file) => BACKUP_NAME.test(file)).sort();
    for (const old of backups.slice(0, -BACKUPS_KEPT)) await unlink(path.join(dataDir, old));
    return name;
  }

  // ---- Access ---------------------------------------------------------------

  const hasProject = (user, projectId) =>
    Boolean(user?.active && (user.role === 'admin' || store.projectMembers[projectId]?.includes(user.id)));

  const requireProject = (projectId) => {
    const scope = requestScope.getStore();
    const outsideGrant = scope?.serviceProject && scope.serviceProject !== projectId;
    if (scope?.user && (!hasProject(scope.user, projectId) || outsideGrant)) {
      throw httpError('Project access has not been assigned. Contact your administrator.', 403);
    }
    if (scope) scope.projectId = projectId;
  };

  const findRun = (runId) => {
    const run = store.runs.find((candidate) => candidate.id === runId);
    if (!run) throw httpError('Run not found', 404);
    requireProject(run.projectId);
    return run;
  };

  const findProject = (projectId) => {
    requireProject(projectId);
    const project = store.projects.find((candidate) => candidate.id === projectId);
    if (!project) throw httpError('Project not found', 404);
    return project;
  };

  const findAutomationProject = (projectId) => automationProject(findProject(projectId));
  const currentUser = () => requestScope.getStore()?.user;
  const isVisible = (item) => Boolean(item && hasProject(currentUser(), item.projectId));
  const projectForViewer = (project, viewer = currentUser()) =>
    can(viewer, 'automation') ? project : redactProject(project);

  const runForViewer = (run, viewer = currentUser()) => {
    const { context, ...result } = run;
    return can(viewer, 'automation') ? result : redactRun(result);
  };

  function containsAsset(value, name) {
    if (!value || typeof value !== 'object') return false;
    return Object.entries(value).some(([key, item]) => {
      if (ASSET_KEYS.includes(key) && item === name) return true;
      if (key === 'targetScreenshots' && Array.isArray(item) && item.includes(name)) return true;
      return containsAsset(item, name);
    });
  }

  function canReadAsset(name) {
    const user = currentUser();
    if (user?.role === 'admin') return true;
    return (
      store.projects.some((project) => hasProject(user, project.id) && containsAsset(project, name)) ||
      store.runs.some((run) => isVisible(run) && containsAsset(run, name)) ||
      (isVisible(recording) && containsAsset(recording.summary(), name))
    );
  }

  async function readUpload(fileId) {
    check(/^[a-f0-9-]{36}$/.test(fileId), 'Invalid uploaded file');
    let entry;
    try {
      const file = path.join(dataDir, 'local-test-files', `${fileId}.json`);
      entry = vault.decode(JSON.parse(await readFile(file, 'utf8'))).localDataFile;
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error('Uploaded test data file is unavailable. Upload it again in Local Test Data.');
      throw error;
    }
    const user = currentUser();
    if (user && user.role !== 'admin' && entry.ownerId !== user.id && !canReadAsset(fileId)) {
      throw httpError('Test data file access denied', 403);
    }
    return entry;
  }

  async function checkFileReferences(value) {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (key === 'fileId' && item) await readUpload(item);
      else await checkFileReferences(item);
    }
  }

  const dataOptions = (projectId) => ({
    readUpload,
    onGlobals: async (values) => {
      const project = findProject(projectId);
      const names = new Set([...Object.keys(project.globalVariables), ...Object.keys(values)]);
      check(names.size <= MAX_GLOBALS, `Maximum ${MAX_GLOBALS} global variables`);
      Object.assign(project.globalVariables, values);
      project.revision = (project.revision || 0) + 1;
      await persist();
    },
  });

  function referencedArtifacts() {
    const stepAssets = (step) => [step.screenshot, step.captureScreenshot, ...(step.targetScreenshots || [])];
    return new Set([
      ...store.runs.flatMap((run) => run.tests.flatMap((test) => [test.trace, ...test.steps.flatMap(stepAssets)])),
      ...store.projects.flatMap((project) =>
        [...project.tests, ...project.prerequisites].flatMap((test) => test.steps.map((step) => step.captureScreenshot)),
      ),
      ...(recording?.steps || []).map((step) => step.captureScreenshot),
    ]);
  }

  function checkAssetReferences(value) {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      const deniedName =
        ['screenshot', 'captureScreenshot', 'trace'].includes(key) && typeof item === 'string' && item && !canReadAsset(item);
      const deniedList = key === 'targetScreenshots' && Array.isArray(item) && item.some((name) => !canReadAsset(name));
      if (deniedName || deniedList) throw httpError('Artifact access denied', 403);
      checkAssetReferences(item);
    }
  }

  // ---- Responses and work log ------------------------------------------------

  const logWork = (user, projectId, action, details = '', outcome = 'Succeeded') => {
    store.workLog.unshift({
      id: randomUUID(),
      at: new Date().toISOString(),
      userId: user.id,
      userName: user.name || user.username,
      projectId,
      projectName: store.projects.find((project) => project.id === projectId)?.name || 'Removed project',
      action,
      details,
      outcome,
    });
    store.workLog = store.workLog.slice(0, WORK_LOG_LIMIT);
    persistSoon();
  };

  const json = async (res, data, status = 200) => {
    const scope = requestScope.getStore();
    if (scope?.projectId && scope.user && !scope.logged && scope.action && status < 400) {
      scope.logged = true;
      const isRunResult = /^(Manual run|Automation run|Debug)/.test(scope.action);
      const details = scope.details || (isRunResult && data?.id ? `Run ${data.id}` : '');
      const outcome = (isRunResult && data?.status) || (status === 202 ? 'Started' : 'Succeeded');
      logWork(scope.user, scope.projectId, scope.action, details, outcome);
    }
    const content = JSON.stringify(data);
    const isConditional = scope.req.method === 'GET' && scope.req.url.split('?')[0] === '/api/state' && status === 200;
    await sendText(scope.req, res, content, { status, tag: isConditional ? contentTag(content) : undefined });
  };

  async function readBody(req) {
    if (!(req.headers['content-type'] || '').startsWith('application/json')) {
      throw httpError('Use Content-Type: application/json', 400);
    }
    let received = 0;
    const chunks = [];
    for await (const chunk of req) {
      received += chunk.length;
      if (received > BODY_LIMIT_BYTES) throw httpError('Request too large', 413);
      chunks.push(chunk);
    }
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      throw httpError('Request body must be a JSON object', 400);
    }
    if (input.projectId) requireProject(input.projectId);
    const pathname = req.url.split('?')[0];
    if (requestScope.getStore()?.user && /^\/api\/(projects|local-data)(\/|$)/.test(pathname)) {
      checkAssetReferences(input);
      await checkFileReferences(input);
    }
    return input;
  }

  // ---- Routes ----------------------------------------------------------------

  async function healthReport() {
    const disk = await storageHealth(dataDir, artifactsDir);
    const delay = await eventLoopDelay();
    return {
      status: disk.dataWritable && disk.artifactsWritable ? 'ok' : 'degraded',
      ...disk,
      eventLoopDelayMs: Number(delay.toFixed(2)),
      metrics: metrics.snapshot(),
    };
  }

  async function publicRoutes(req, res, route) {
    if (req.method === 'GET' && route === '/api/health') {
      await json(res, await healthReport());
      return true;
    }
    if (req.method === 'GET' && route === '/api/auth/session') {
      await json(res, { setupRequired: auth.setupRequired(), user: auth.current(req), runtime });
      return true;
    }
    if (req.method === 'POST' && route === '/api/auth/setup') {
      await auth.setup(await readBody(req));
      await json(res, { created: true }, 201);
      return true;
    }
    if (req.method === 'POST' && route === '/api/auth/login') {
      const result = await auth.login(await readBody(req), req.socket.remoteAddress);
      res.setHeader('Set-Cookie', auth.cookie(result.token));
      await json(res, { user: result.user, home: homeFor(result.user) });
      return true;
    }
    if (req.method === 'POST' && route === '/api/auth/logout') {
      auth.logout(req);
      res.setHeader('Set-Cookie', auth.cookie(''));
      await json(res, { loggedOut: true });
      return true;
    }
    return false;
  }

  async function adminUserRoutes(req, res, route) {
    if (req.method === 'GET' && route === '/api/admin/permissions') {
      await json(res, { permissions: permissionCatalog, adminOnly: adminOnlyPermissions });
      return true;
    }
    const permissionsRoute = route.match(/^\/api\/admin\/users\/([\w-]+)\/permissions$/);
    if (permissionsRoute && req.method === 'PUT') {
      const input = await readBody(req);
      const onlyAllowedKeys = Object.keys(input).every((key) => key === 'permissions' || key === 'revision');
      if (!input.permissions || !onlyAllowedKeys) throw httpError('Send only the user permissions and revision', 400);
      const update = { permissions: input.permissions, revision: input.revision };
      await json(res, await auth.update(permissionsRoute[1], update));
      return true;
    }
    if (route === '/api/admin/users' && req.method === 'GET') {
      await json(res, { users: auth.list() });
      return true;
    }
    if (route === '/api/admin/users' && req.method === 'POST') {
      await json(res, await auth.create(await readBody(req)), 201);
      return true;
    }
    const userRoute = route.match(/^\/api\/admin\/users\/([\w-]+)$/);
    if (userRoute && req.method === 'PUT') {
      await json(res, await auth.update(userRoute[1], await readBody(req)));
      return true;
    }
    return false;
  }

  async function adminProjectRoutes(req, res, route, url) {
    if (route === '/api/admin/projects' && req.method === 'GET') {
      const projects = store.projects.map((project) => ({
        id: project.id,
        name: project.name,
        memberIds: store.projectMembers[project.id] || [],
        revision: accessRevision(project.id),
        tests: project.tests.length,
        suites: project.suites.length,
        runs: store.runs.filter((run) => run.projectId === project.id).length,
      }));
      await json(res, { projects, users: auth.list(), logStartedAt: store.workLogStartedAt });
      return true;
    }

    const membersRoute = route.match(/^\/api\/admin\/projects\/([\w-]+)\/members$/);
    if (membersRoute && req.method === 'PUT') {
      const input = await readBody(req);
      const project = findProject(membersRoute[1]);
      const validUsers =
        Array.isArray(input.userIds) &&
        input.userIds.every((id) => typeof id === 'string' && auth.find(id)?.role === 'user');
      check(validUsers, 'Choose valid regular users');
      check(Number.isSafeInteger(input.revision) && input.revision >= 0, 'Send a valid project assignment revision');
      if (input.revision !== accessRevision(project.id)) {
        await json(res, { error: 'Project assignments changed. Refresh before saving.' }, 409);
        return true;
      }
      const previous = store.projectMembers[project.id] || [];
      const next = [...new Set(input.userIds)];
      const names = (ids) => ids.map((id) => auth.find(id)?.username || id).join(', ');
      const granted = names(next.filter((id) => !previous.includes(id))) || 'none';
      const removed = names(previous.filter((id) => !next.includes(id))) || 'none';
      requestScope.getStore().details = `Granted: ${granted}. Removed: ${removed}.`;
      const revision = accessRevision(project.id) + 1;
      store.projectMembers[project.id] = next;
      store.projectAccessRevisions[project.id] = revision;
      await persist();
      await json(res, { memberIds: next, revision });
      return true;
    }

    if (route === '/api/admin/work-log' && req.method === 'GET') {
      const projectId = url.searchParams.get('projectId');
      const userId = url.searchParams.get('userId');
      const action = url.searchParams.get('action')?.toLowerCase();
      const entries = store.workLog.filter(
        (entry) =>
          (!projectId || entry.projectId === projectId) &&
          (!userId || entry.userId === userId) &&
          (!action || entry.action.toLowerCase().includes(action)),
      );
      const requested = Number(url.searchParams.get('offset'));
      const validOffset = Number.isSafeInteger(requested) && requested >= 0 ? requested : 0;
      const lastPageOffset = Math.max(0, Math.ceil(entries.length / WORK_LOG_PAGE) - 1) * WORK_LOG_PAGE;
      const offset = Math.min(validOffset, lastPageOffset);
      await json(res, {
        entries: entries.slice(offset, offset + WORK_LOG_PAGE),
        total: entries.length,
        offset,
        limit: WORK_LOG_PAGE,
        startedAt: store.workLogStartedAt,
      });
      return true;
    }
    return false;
  }

  async function manualRunRoutes(req, res, route) {
    if (route === '/api/manual-runs' && req.method === 'POST') {
      const input = await readBody(req);
      const run = createManualRun(findProject(input.projectId), input);
      store.runs.unshift(run);
      await persist();
      await json(res, runForViewer(run), 201);
      return true;
    }
    const manualRoute = route.match(/^\/api\/manual-runs\/([\w-]+)\/(steps|complete|cancel)$/);
    if (manualRoute && req.method === (manualRoute[2] === 'steps' ? 'PUT' : 'POST')) {
      const input = await readBody(req);
      const run = findRun(manualRoute[1]);
      updateManualRun(run, input, manualRoute[2]);
      await persist();
      await json(res, runForViewer(run));
      return true;
    }
    return false;
  }

  function stateRuns() {
    const savedPlanIds = new Set(store.projects.flatMap((project) => (project.testPlans || []).map((plan) => plan.id)));
    const seenPlans = new Set();
    return store.runs.filter(isVisible).filter((run, index) => {
      const isLatestForPlan = savedPlanIds.has(run.planId) && !seenPlans.has(run.planId);
      if (run.planId) seenPlans.add(run.planId);
      return index < STATE_RUN_LIMIT || isLatestForPlan;
    });
  }

  const activityState = () => ({
    nextTestNumber: store.nextTestNumber,
    activeRun: isVisible(store.runs.find((run) => run.id === activeRun)) ? activeRun : null,
    activeRecording: isVisible(recording) ? recording.summary() : null,
    activeDebug: [...debugSessions.values()].map((session) => session.summary()).find(isVisible) || null,
  });

  async function workspaceRoutes(req, res, route, url, user) {
    if (req.method === 'GET' && route === '/api/state') {
      const isAutomation = url.searchParams.get('workspace') === 'automation';
      const projects = store.projects.filter((project) => hasProject(user, project.id));
      await json(res, {
        features: { nestedFolders: true, visibleReplay: true, caseHistory: true, generationRecovery: true },
        projects: isAutomation ? projects.map(automationProject) : projects.map((project) => projectForViewer(project)),
        runs: stateRuns().map((run) => runForViewer(run)),
        ...activityState(),
      });
      return true;
    }
    if (req.method === 'GET' && route === '/api/status') {
      await json(res, {
        runs: store.runs.filter(isVisible).slice(0, STATE_RUN_LIMIT).map((run) => runForViewer(run)),
        ...activityState(),
      });
      return true;
    }
    if (req.method === 'POST' && route === '/api/automation/handoff') {
      const input = await readBody(req);
      const previous = findProject(input.projectId);
      const next = structuredClone(previous);
      const counter = { nextTestNumber: store.nextTestNumber };
      const result = ensureAutomationCases(next, input, counter);
      if (result.created.length) {
        store.projects[store.projects.indexOf(previous)] = next;
        store.nextTestNumber = counter.nextTestNumber;
        await persist();
      }
      await json(res, { ...result, project: automationProject(next) });
      return true;
    }
    return false;
  }

  async function backupRoutes(req, res, route) {
    if (route === '/api/backups' && req.method === 'GET') {
      const names = (await readdir(dataDir)).filter((name) => BACKUP_NAME.test(name));
      await json(res, { backups: names.sort().reverse() });
      return true;
    }
    if (route === '/api/backups' && req.method === 'POST') {
      await readBody(req);
      await json(res, { name: await backup() }, 201);
      return true;
    }
    if (route === '/api/backups/restore' && req.method === 'POST') {
      const input = await readBody(req);
      const isBusy = activeRun || startingBrowser || recording || debugSessions.size;
      check(!isBusy, 'Finish active sessions before restoring');
      check(BACKUP_NAME.test(input.name), 'Invalid backup');
      const restored = vault.decode(JSON.parse(await readFile(path.join(dataDir, input.name), 'utf8')));
      check(Array.isArray(restored.projects) && restored.projects.length, 'Backup has no projects');
      const counter = { nextTestNumber: store.nextTestNumber };
      const projects = restored.projects.map((project) => {
        const current = store.projects.find((old) => old.id === project.id);
        const revision = Math.max(project.revision || 0, current?.revision || 0);
        return normalizeProject(project, { ...project, revision }, counter);
      });
      await backup();
      store.projects = projects;
      store.nextTestNumber = counter.nextTestNumber;
      await persist();
      await json(res, { restored: true });
      return true;
    }
    return false;
  }

  async function createProject(res, user, input) {
    const allowed = can(user, 'automation') ? input : qaProjectInput(input);
    const withCreator = Array.isArray(allowed.testPlans)
      ? { ...allowed, testPlans: allowed.testPlans.map((plan) => ({ ...plan, createdBy: user.name })) }
      : allowed;
    const project = normalizeProject({ ...withCreator, id: undefined }, null, store);
    store.projects.push(project);
    store.projectMembers[project.id] = user.role === 'admin' ? [] : [user.id];
    store.projectAccessRevisions[project.id] = 0;
    requestScope.getStore().projectId = project.id;
    await persist();
    await json(res, projectForViewer(project), 201);
  }

  async function updateProject(res, user, projectId, input) {
    const previous = findProject(projectId);
    const isAutomationSave = input.workspace === 'automation';
    if (!can(user, isAutomationSave ? 'automation' : 'qa')) {
      await json(res, { error: 'You do not have access to this studio.' }, 403);
      return;
    }
    if (input.revision !== previous.revision) {
      await json(
        res,
        {
          error: 'This project changed in another tab or through AI. Export your edits, then reload the latest project before saving.',
          code: 'EDIT_CONFLICT',
        },
        409,
      );
      return;
    }
    await backup();
    if (input.revision !== findProject(projectId).revision) {
      await json(res, { error: 'Project changed during save. Reload before saving.', code: 'EDIT_CONFLICT' }, 409);
      return;
    }
    const allowed = can(user, 'automation') ? input : qaProjectInput(input, previous);
    const merged = isAutomationSave ? mergeAutomationProject(allowed, previous) : allowed;
    if (Array.isArray(merged.testPlans)) {
      merged.testPlans = merged.testPlans.map((plan) => ({
        ...plan,
        createdBy: previous.testPlans?.find((old) => old.id === plan.id)?.createdBy || user.name,
      }));
    }
    const project = normalizeProject(merged, previous, store);
    store.projects[store.projects.indexOf(previous)] = project;
    await persist();
    await json(res, isAutomationSave ? automationProject(project) : projectForViewer(project));
  }

  async function projectRoutes(req, res, route, url, user) {
    if (req.method === 'POST' && route === '/api/projects') {
      await createProject(res, user, await readBody(req));
      return true;
    }
    const testsRoute = route.match(/^\/api\/projects\/([\w-]+)\/tests$/);
    if (testsRoute && req.method === 'POST') {
      const input = await readBody(req);
      const previous = findProject(testsRoute[1]);
      const counter = { nextTestNumber: store.nextTestNumber };
      const tests = [...previous.tests, { name: input.name, steps: input.steps }];
      const next = normalizeProject({ ...previous, tests }, previous, counter);
      const test = next.tests.at(-1);
      validateGeneratedTest(next, test);
      store.projects[store.projects.indexOf(previous)] = next;
      store.nextTestNumber = counter.nextTestNumber;
      await persist();
      await json(res, test, 201);
      return true;
    }
    const projectRoute = route.match(/^\/api\/projects\/([\w-]+)$/);
    if (projectRoute && req.method === 'PUT') {
      await updateProject(res, user, projectRoute[1], await readBody(req));
      return true;
    }
    return false;
  }

  async function dataRoutes(req, res, route, url, user) {
    if (req.method !== 'POST') return false;
    if (route === '/api/datasets/csv') {
      const input = await readBody(req);
      await json(res, { rows: parseCsv(input.csv) });
      return true;
    }
    if (route === '/api/local-data/validate') {
      const input = await readBody(req);
      await json(res, { definitions: normalizeLocalData(input.definitions) });
      return true;
    }
    if (route === '/api/local-data/file') {
      const input = await readBody(req);
      check(typeof input.name === 'string' && input.name.length <= 250, 'File name required');
      const isValidContent =
        typeof input.content === 'string' &&
        input.content.length <= Math.ceil(fileLimit / 3) * 4 &&
        /^[A-Za-z0-9+/]*={0,2}$/.test(input.content);
      check(isValidContent, 'Upload a file of 1 MB or smaller');
      const table = await readDataTable(input.name, Buffer.from(input.content, 'base64'));
      const fileId = randomUUID();
      const name = path.basename(input.name);
      const uploads = path.join(dataDir, 'local-test-files');
      await mkdir(uploads, { recursive: true });
      const sealed = vault.encode({ localDataFile: { name, content: input.content, ownerId: user.id } });
      await writeFile(path.join(uploads, `${fileId}.json`), JSON.stringify(sealed), { flag: 'wx' });
      await json(res, { fileId, name, ...table }, 201);
      return true;
    }
    if (route === '/api/local-data/preview') {
      const input = await readBody(req);
      const project = findProject(input.projectId);
      const [entry] = normalizeLocalData([input.definition]);
      const environment = project.environments.find((item) => item.id === project.activeEnvironmentId);
      const context = {
        globals: project.globalVariables,
        environment: environment?.variables || {},
        profiles: project.jdbcProfiles,
      };
      await json(res, await resolveLocalValue(entry, context, { readUpload }));
      return true;
    }
    if (route === '/api/jdbc/test') {
      const input = await readBody(req);
      const result = await queryDatabase(input.profile || input, 'SELECT version()');
      await json(res, { ok: true, server: result.rows[0]?.[0] });
      return true;
    }
    if (route === '/api/jdbc/query') {
      const input = await readBody(req);
      findProject(input.projectId);
      check(input.profile?.id === input.profileId, 'Profile ID mismatch');
      await json(res, await queryDatabase(input.profile, input.query));
      return true;
    }
    return false;
  }

  async function checkFirstTarget(project, input, result) {
    const run = prepareRun(project, input);
    const [firstTest] = run.tests;
    const step = firstTest.steps.find((item) => item.action === 'navigate');
    const entries = firstTest.localTestData || [];
    const entry = entries.find(
      (item) => item.name === step?.value && (step.valueMode === 'local' || (step.valueMode === 'global' && item.keepGlobal)),
    );
    if (entry && entry.source !== 'manual') {
      result.targetSkipped = 'The initial URL is collected at run time. Preview its source in Local Test Data.';
      return;
    }
    if (!step) return;
    try {
      const local = Object.fromEntries(entries.map((item) => [item.name, item.value]));
      const context = { ...run.context, local, data: firstTest.dataRow || {} };
      const target = entry ? entry.value : resolveValue(step, context);
      const response = await fetch(target, { signal: AbortSignal.timeout(TARGET_CHECK_TIMEOUT_MS) });
      await response.body?.cancel();
      result.targetStatus = response.status;
      if (response.status >= 400) {
        result.ok = false;
        result.errors.push(`Target returned HTTP ${response.status}. Check login, URL and VPN access.`);
      }
    } catch {
      result.ok = false;
      result.errors.push('Target is not reachable. Check the URL, network, and VPN connection.');
    }
  }

  async function startRun(req, res, user) {
    const input = await readBody(req);
    if (recordingLive() || startingBrowser) {
      await json(res, { error: 'Stop the active recording first.' }, 409);
      return;
    }
    if (debugSessions.size) {
      await json(res, { error: 'Finish or close the active Debug session first.' }, 409);
      return;
    }
    if (activeRun) {
      await json(res, { error: 'Another run is already active' }, 409);
      return;
    }
    const project = findAutomationProject(input.projectId);
    const readiness = preflight(project, input);
    check(readiness.ok, readiness.errors.join('\n'));
    const run = prepareRun(project, input);
    run.mode = 'automation';
    if (input.name) {
      check(typeof input.name === 'string' && input.name.length <= MAX_RUN_NAME, 'Run name must be at most 120 characters');
      run.name = input.name;
    }
    run.trace = input.trace === true;
    run.replay = input.replay === true;
    runController = new AbortController();
    activeRun = run.id;
    store.runs.unshift(run);
    try {
      await persist();
    } catch (error) {
      activeRun = null;
      store.runs.shift();
      throw error;
    }
    await json(res, { ...run, context: undefined }, 202);
    const options = { signal: runController.signal, ...dataOptions(run.projectId) };
    execution = executeRun(run, artifactsDir, options)
      .finally(() => {
        activeRun = null;
        runController = null;
        logWork(user, run.projectId, 'Automation run finished', `Run ${run.id}`, run.status);
      })
      .catch((error) => console.error('Run persistence failed:', error.message));
  }

  async function removeRunArtifacts(run) {
    const used = referencedArtifacts();
    const names = run.tests.flatMap((test) => [
      test.trace,
      ...test.steps.flatMap((step) => [step.screenshot, step.captureScreenshot, ...(step.targetScreenshots || [])]),
    ]);
    for (const name of names.filter(Boolean)) {
      if (!used.has(name) && ARTIFACT_NAME.test(name)) await unlink(path.join(artifactsDir, name)).catch(() => {});
    }
  }

  async function sendRunReport(res, run, testId, wantsPdf) {
    const reportRun = testId ? caseRun(run, testId) : run;
    if (!reportRun) {
      await json(res, { error: 'This test case is not part of the run' }, 404);
      return;
    }
    const html = await reportHtml(reportRun, artifactsDir);
    if (!wantsPdf) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': REPORT_CSP });
      res.end(html);
      return;
    }
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.setContent(html);
      await page.locator('details').evaluateAll((nodes) => nodes.forEach((node) => (node.open = true)));
      const margin = { top: '12mm', bottom: '12mm', left: '12mm', right: '12mm' };
      const pdf = await page.pdf({ format: 'A4', printBackground: true, margin });
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="run-${run.id}.pdf"`,
      });
      res.end(pdf);
    } finally {
      await browser.close();
    }
  }

  async function runRoutes(req, res, route, url, user) {
    if (req.method === 'GET' && route === '/api/runs') {
      const { searchParams } = url;
      const scopeName = searchParams.get('scope');
      const isIndividual = scopeName === 'individual-case';
      const isScoped = isIndividual || scopeName === 'case';
      const testId = searchParams.get('testId');
      const projectId = searchParams.get('projectId');
      if (isScoped) check(testId, 'Select a test case for its run history');
      const runs = store.runs
        .filter(
          (run) =>
            isVisible(run) &&
            (!projectId || run.projectId === projectId) &&
            (!testId || run.tests.some((test) => matchesCase(test, testId))) &&
            (!isIndividual || isIndividualCaseRun(run, testId)),
        )
        .map((run) => {
          const visibleRun = runForViewer(run);
          return isScoped ? caseRun(visibleRun, testId) : visibleRun;
        });
      await json(res, queryRunHistory(runs, searchParams));
      return true;
    }
    if (req.method === 'POST' && route === '/api/runs') {
      await startRun(req, res, user);
      return true;
    }
    if (req.method === 'POST' && route === '/api/history/retain') {
      const isBusy = activeRun || debugSessions.size || startingBrowser || recordingLive();
      check(!isBusy, 'Finish execution and recording before cleaning history');
      const input = await readBody(req);
      check(Number.isInteger(input.keep) && input.keep >= 1 && input.keep <= RETAIN_MAX, 'Keep between 1 and 10000 completed runs');
      const completed = store.runs.filter((run) => run.status !== 'running');
      const removed = new Set(completed.slice(input.keep).map((run) => run.id));
      store.runs = store.runs.filter((run) => !removed.has(run.id));
      await persist();
      const used = referencedArtifacts();
      for (const name of await readdir(artifactsDir)) {
        if (ARTIFACT_NAME.test(name) && !used.has(name)) await unlink(path.join(artifactsDir, name));
      }
      await json(res, { removed: removed.size });
      return true;
    }
    const cancelRoute = route.match(/^\/api\/runs\/([\w-]+)\/cancel$/);
    if (cancelRoute && req.method === 'POST') {
      await readBody(req);
      check(activeRun === cancelRoute[1] && runController, 'This run is no longer active');
      runController.abort();
      await json(res, { status: 'cancelling' }, 202);
      return true;
    }
    if (req.method === 'POST' && route === '/api/preflight') {
      const input = await readBody(req);
      const project = findAutomationProject(input.projectId);
      const result = preflight(project, input);
      if (result.ok && input.checkBrowser) {
        let browser;
        try {
          browser = await launchBrowser(project.browser);
          result.browserAvailable = true;
        } catch (error) {
          result.errors.push(error.message);
          result.ok = false;
        } finally {
          await browser?.close();
        }
      }
      if (result.ok && input.checkTarget) await checkFirstTarget(project, input, result);
      await json(res, result);
      return true;
    }
    if (req.method === 'POST' && route === '/api/inspect') {
      const input = await readBody(req);
      await json(res, await inspectPage(structuredClone(findProject(input.projectId)), input.url));
      return true;
    }
    const runRoute = route.match(/^\/api\/runs\/([\w-]+)(\/report(?:\.pdf)?)?$/);
    if (!runRoute) return false;
    const run = findRun(runRoute[1]);
    const reportPath = runRoute[2];
    if (req.method === 'GET' && !reportPath) {
      await json(res, runForViewer(run));
      return true;
    }
    if (req.method === 'DELETE' && !reportPath) {
      if (run.status === 'running' || activeRun === run.id || debugSessions.has(run.id)) {
        await json(res, { error: 'Cannot delete an active run' }, 409);
        return true;
      }
      store.runs = store.runs.filter((candidate) => candidate.id !== run.id);
      await persist();
      await removeRunArtifacts(run);
      await json(res, { deleted: run.id });
      return true;
    }
    if (req.method === 'GET' && reportPath) {
      await sendRunReport(res, runForViewer(run), url.searchParams.get('testId'), reportPath === '/report.pdf');
      return true;
    }
    return false;
  }

  async function debugRoutes(req, res, route) {
    if (req.method !== 'POST') return false;
    if (route === '/api/debug') {
      const input = await readBody(req);
      const isBusy = recordingLive() || startingBrowser || activeRun || debugSessions.size;
      check(!isBusy, 'Finish the active recording, run or debug session first.');
      const project = findAutomationProject(input.projectId);
      const test = project.tests.find((item) => item.id === input.testId);
      check(test, 'Test case not found');
      check((test.dataRows?.length || 0) <= 1, 'Use Run test for datasets with multiple rows.');
      const ready = preflight(project, { testId: test.id });
      check(ready.ok, ready.errors.join('\n'));
      let session;
      startingBrowser = true;
      try {
        session = await startDebugSession(project, test.id, artifactsDir, dataOptions(project.id));
      } finally {
        startingBrowser = false;
      }
      debugSessions.set(session.run.id, session);
      store.runs.unshift(session.run);
      session.browser.on('disconnected', () => {
        session
          .close()
          .then(() => {
            debugSessions.delete(session.run.id);
            return persist();
          })
          .catch(() => {});
      });
      try {
        await persist();
      } catch (error) {
        debugSessions.delete(session.run.id);
        await session.close();
        store.runs.shift();
        throw error;
      }
      await json(res, session.summary(), 201);
      return true;
    }
    const locatorRoute = route.match(/^\/api\/debug\/([\w-]+)\/locator$/);
    if (locatorRoute) {
      const input = await readBody(req);
      const session = debugSessions.get(locatorRoute[1]);
      check(session && !session.busy, 'Open an idle debug session first');
      const step = session.run.tests[0].steps[Number(input.index)];
      check(step?.target, 'Select a step with a locator');
      const { objects, locatorTemplates } = session.run.context;
      const resolved = resolveLocator(step, objects, locatorTemplates);
      const page = resolved.pageIndex === undefined ? session.page : session.pages[resolved.pageIndex];
      check(page, 'Browser tab is not open yet');
      const found = locator(page, step, objects, locatorTemplates);
      const count = await found.count();
      if (count === 1) await found.highlight();
      await json(res, {
        count,
        unique: count === 1,
        target: resolved.target,
        ...(count > 1 ? { warning: `Ambiguous locator: ${count} elements match. Refine the locator or its container.` } : {}),
      });
      return true;
    }
    const sessionRoute = route.match(/^\/api\/debug\/([\w-]+)\/(step|close)$/);
    if (!sessionRoute) return false;
    const session = debugSessions.get(sessionRoute[1]);
    check(session, 'Debug session not found or already closed.');
    if (sessionRoute[2] === 'step') {
      const current = await session.step();
      await persist();
      await json(res, current);
      return true;
    }
    await session.close();
    debugSessions.delete(sessionRoute[1]);
    await persist();
    await json(res, session.summary());
    return true;
  }

  async function writeRecordingFile(snapshot) {
    const file = path.join(dataDir, 'recording.json');
    await writeFile(`${file}.tmp`, JSON.stringify(vault.encode(snapshot)));
    await rename(`${file}.tmp`, file);
  }

  function restoreRecordingDraft(saved) {
    return {
      ...structuredClone(saved),
      status: 'stopped',
      saving: false,
      summary() {
        const { summary, save, stop, ...data } = this;
        return data;
      },
      async save() {
        store.recording = structuredClone(this.summary());
        await writeRecordingFile(store.recording);
        await persist();
      },
      async stop() {
        await this.save();
        return this.summary();
      },
    };
  }

  async function recordingRoutes(req, res, route) {
    if (req.method !== 'POST') return false;
    if (route === '/api/recordings') {
      const input = await readBody(req);
      const isBusy = recording || startingBrowser || activeRun || debugSessions.size;
      check(!isBusy, 'Finish the active recording, run, or debug session first.');
      startingBrowser = true;
      try {
        const project = findAutomationProject(input.projectId);
        recording = await recordingLauncher(project, input.testId, input.url, { artifacts: artifactsDir });
        recording.onChange = writeRecordingFile;
        await recording.save();
        await json(res, recording.summary(), 201);
      } finally {
        startingBrowser = false;
      }
      return true;
    }
    const mappingsRoute = route.match(/^\/api\/recordings\/([\w-]+)\/mappings$/);
    if (mappingsRoute) {
      check(recording?.id === mappingsRoute[1], 'Recording not found');
      check(recording.status === 'stopped', 'Stop and review the recording before mapping steps');
      const input = await readBody(req);
      const project = findAutomationProject(recording.projectId);
      const test = project.tests.find((item) => item.id === recording.testId);
      check(test, 'Linked QA Studio test case was not found');
      const previous = recording.steps;
      recording.steps = mapRecordedSteps(previous, test.qa?.manualSteps || [], input.mappings);
      try {
        await recording.save();
      } catch (error) {
        recording.steps = previous;
        throw error;
      }
      await json(res, recording.summary());
      return true;
    }
    const modeRoute = route.match(/^\/api\/recordings\/([\w-]+)\/mode$/);
    if (modeRoute) {
      const input = await readBody(req);
      check(recording?.id === modeRoute[1] && recording.status !== 'stopped', 'No active recording');
      check(['actions', 'visible', 'text', 'value'].includes(input.mode), 'Invalid recording mode');
      recording.mode = input.mode;
      const frames = recording.context.pages().flatMap((page) => page.frames());
      await Promise.allSettled(
        frames.map((frame) =>
          frame.evaluate((mode) => {
            window.__studioRecorderMode = mode;
          }, input.mode),
        ),
      );
      await recording.save();
      await json(res, recording.summary());
      return true;
    }
    const actionRoute = route.match(/^\/api\/recordings\/([\w-]+)\/(pause|resume|stop|discard)$/);
    if (!actionRoute) return false;
    check(recording?.id === actionRoute[1], 'Recording not found');
    const action = actionRoute[2];
    if (action === 'pause' || action === 'resume') {
      check(recording.status !== 'stopped', 'Recording is already stopped');
      recording.status = action === 'pause' ? 'paused' : 'recording';
      await recording.save();
    } else {
      await recording.stop();
    }
    const result = recording.summary();
    if (action === 'stop') {
      store.recording = structuredClone(result);
      await persist();
    }
    if (action === 'discard') {
      store.recording = null;
      await persist();
      await unlink(path.join(dataDir, 'recording.json')).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
      recording = null;
    }
    await json(res, result);
    return true;
  }

  async function tickSchedules() {
    const isBusy = closing || schedulerWork || activeRun || recordingLive() || debugSessions.size || startingBrowser;
    if (isBusy) return;
    const schedule = store.schedules.find((item) => item.enabled && Date.parse(item.nextRunAt) <= Date.now());
    if (!schedule) return;
    const owner = auth.find(schedule.ownerId);
    if (!can(owner, 'automation') || !hasProject(owner, schedule.projectId)) {
      schedule.enabled = false;
      schedule.lastError =
        'Schedule owner no longer has Automation Studio or project access. Recreate this schedule with an authorized account.';
      await persist();
      return;
    }
    schedule.nextRunAt = new Date(Date.now() + schedule.intervalMinutes * 60000).toISOString();
    const serviceToken = randomBytes(32).toString('base64url');
    serviceGrants.set(serviceToken, { userId: schedule.ownerId, projectId: schedule.projectId });
    schedulerWork = (async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/runs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${serviceToken}` },
          body: JSON.stringify({ projectId: schedule.projectId, testId: schedule.testId }),
          signal: AbortSignal.timeout(SCHEDULE_REQUEST_TIMEOUT_MS),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error);
        schedule.lastRunId = result.id;
        schedule.lastError = null;
      } catch (error) {
        schedule.lastError = error.message;
      }
      await persist();
    })();
    try {
      await schedulerWork;
    } finally {
      schedulerWork = null;
      serviceGrants.delete(serviceToken);
    }
  }

  async function scheduleRoutes(req, res, route, url, user) {
    if (route === '/api/schedules' && req.method === 'GET') {
      await json(res, { schedules: store.schedules.filter(isVisible) });
      return true;
    }
    if (route === '/api/schedules' && req.method === 'POST') {
      const input = await readBody(req);
      const project = findAutomationProject(input.projectId);
      const test = project.tests.find((item) => item.id === input.testId);
      check(test, 'Choose a test to schedule');
      selectPlannedTests(project, { testId: input.testId }, { requirePlan: false });
      const validInterval =
        Number.isInteger(input.intervalMinutes) &&
        input.intervalMinutes >= 1 &&
        input.intervalMinutes <= MAX_INTERVAL_MINUTES;
      check(validInterval, 'Interval must be 1–525600 minutes');
      check(store.schedules.length < MAX_SCHEDULES, 'Maximum 100 schedules');
      const schedule = {
        id: randomUUID(),
        ownerId: user.id,
        projectId: input.projectId,
        testId: input.testId,
        name: test.name,
        intervalMinutes: input.intervalMinutes,
        enabled: true,
        nextRunAt: new Date(Date.now() + input.intervalMinutes * 60000).toISOString(),
      };
      store.schedules.push(schedule);
      await persist();
      await json(res, schedule, 201);
      return true;
    }
    const scheduleRoute = route.match(/^\/api\/schedules\/([\w-]+)$/);
    if (scheduleRoute && req.method === 'DELETE') {
      if (!store.schedules.some((schedule) => schedule.id === scheduleRoute[1])) {
        throw httpError('Schedule not found', 404);
      }
      store.schedules = store.schedules.filter((schedule) => schedule.id !== scheduleRoute[1]);
      await persist();
      await json(res, { deleted: true });
      return true;
    }
    return false;
  }

  async function overviewRoutes(req, res, route, url) {
    if (req.method !== 'GET' || route !== '/api/automation/execution-overview') return false;
    const project = findProject(url.searchParams.get('projectId'));
    const runs = store.runs.filter((run) => isVisible(run) && run.projectId === project.id);
    const result = queryExecutionOverview(runs, url.searchParams);
    if (url.searchParams.get('export') === 'csv') {
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="tc-execution-report.csv"',
      });
      res.end(`﻿${executionCsv(result.rows)}`);
      return true;
    }
    await json(res, result);
    return true;
  }

  async function artifactRoutes(req, res, route) {
    if (req.method !== 'GET' || !/^\/artifacts\/[\w-]+\.(png|zip)$/.test(route)) return false;
    const name = path.basename(route);
    if (!canReadAsset(name)) {
      await json(res, { error: 'Artifact access denied' }, 403);
      return true;
    }
    let content;
    try {
      content = await readFile(path.join(artifactsDir, name));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await json(res, { error: 'Not found' }, 404);
      return true;
    }
    res.writeHead(200, { 'Content-Type': route.endsWith('.zip') ? 'application/zip' : 'image/png' });
    res.end(content);
    return true;
  }

  async function staticRoutes(req, res, route) {
    if (req.method !== 'GET' || !STATIC_ROUTES.has(route)) return false;
    const name = STATIC_ROUTES.get(route);
    res.setHeader('Content-Security-Policy', PAGE_CSP);
    try {
      await serveStatic(req, res, name, CONTENT_TYPES[path.extname(name)]);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await json(res, { error: 'Not found' }, 404);
    }
    return true;
  }

  const routeHandlers = [
    adminProjectRoutes,
    adminUserRoutes,
    manualRunRoutes,
    backupRoutes,
    workspaceRoutes,
    dataRoutes,
    runRoutes,
    recordingRoutes,
    debugRoutes,
    scheduleRoutes,
    overviewRoutes,
    projectRoutes,
    staticRoutes,
    artifactRoutes,
  ];

  async function handleRequest(req, res) {
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    const origins = hosts.map((host) => `http://${host}`);
    const { host, origin } = req.headers;
    const isLocal =
      hosts.includes(host) && (!origin || origins.includes(origin)) && req.headers['sec-fetch-site'] !== 'cross-site';
    if (!isLocal) {
      await json(res, { error: 'Local requests only' }, 403);
      return;
    }

    const url = new URL(req.url, `http://${host}`);
    const route = url.pathname;
    if (req.method === 'GET' && (route === '/favicon.ico' || route === '/favicon.svg')) {
      await serveStatic(req, res, 'favicon.svg', 'image/svg+xml');
      return;
    }
    if (await publicRoutes(req, res, route)) return;

    const scope = requestScope.getStore();
    let user = auth.current(req);
    const grant = serviceGrants.get(req.headers.authorization?.replace(/^Bearer /, ''));
    const grantCoversRoute =
      route === '/api/inspect' ||
      /^\/api\/projects\/[^/]+\/tests$/.test(route) ||
      (route === '/api/runs' && req.method === 'POST');
    if (grant && grantCoversRoute) {
      user = auth.find(grant.userId);
      scope.serviceProject = grant.projectId;
    }
    scope.user = user;

    if (!PUBLIC_ROUTES.has(route)) {
      if (!user) {
        if (SIGNED_OUT_REDIRECTS.has(route)) {
          res.writeHead(302, { Location: '/login' });
          res.end();
          return;
        }
        await json(res, { error: 'Please sign in to continue.' }, 401);
        return;
      }
      if (route === '/api/auth/password' && req.method === 'PUT') {
        await auth.password(user.id, await readBody(req));
        res.setHeader('Set-Cookie', auth.cookie(''));
        await json(res, { changed: true });
        return;
      }
      authorize(user, route, req.method, url);
    }

    if (user) {
      const target = route.match(/^\/api\/(projects|runs|manual-runs|recordings|debug|schedules)\/([\w-]+)/);
      if (target) {
        const [, kind, id] = target;
        if (kind === 'projects') requireProject(id);
        else if (kind === 'runs' || kind === 'manual-runs' || kind === 'debug') findRun(id);
        else if (kind === 'recordings' && recording?.id === id) requireProject(recording.projectId);
        else if (kind === 'schedules') {
          const schedule = store.schedules.find((candidate) => candidate.id === id);
          if (schedule) requireProject(schedule.projectId);
        }
      }
      if (url.searchParams.has('projectId') && route.startsWith('/api/')) {
        requireProject(url.searchParams.get('projectId'));
      }
      if (req.method !== 'GET') scope.action = workLogAction(route, req.method);
    }

    for (const handler of routeHandlers) {
      if (await handler(req, res, route, url, user)) return;
    }
    await json(res, { error: 'Not found' }, 404);
  }

  const server = http.createServer((req, res) =>
    requestScope.run({ req }, async () => {
      const startedAt = process.hrtime.bigint();
      res.setHeader('X-Request-Id', randomUUID().slice(0, 8));
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.once('finish', () => {
        const elapsed = Number(process.hrtime.bigint() - startedAt) / 1e6;
        metrics.record(req.method, res.statusCode, elapsed);
      });
      try {
        await handleRequest(req, res);
      } catch (error) {
        if (res.headersSent) {
          res.end();
          return;
        }
        const status = error.status || (error.code === 'ENOENT' ? 404 : 400);
        const body = { error: error.message };
        const isRequirementRoute = /^\/api\/projects\/[\w-]+\/requirements(?:\/|\?|$)/.test(req.url);
        const userMessage = error.userMessage || (isRequirementRoute ? requirementErrorUserMessage(error, status) : undefined);
        if (userMessage) body.userMessage = userMessage;
        if (error.code) body.code = error.code;
        await json(res, body, status);
      }
    }),
  );

  try {
    store.recording = vault.decode(JSON.parse(await readFile(path.join(dataDir, 'recording.json'), 'utf8')));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  // Drafts recover after a restart, but their browser sessions do not resume.
  if (store.recording) recording = restoreRecordingDraft(store.recording);

  if (repositoryMigrated) await backup();
  await persist();

  return {
    server,
    store,
    tickSchedules,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          server.off('error', reject);
          scheduleTimer = setInterval(() => {
            tickSchedules().catch((error) => console.error('Schedule update failed:', error.message));
          }, SCHEDULE_TICK_MS);
          scheduleTimer.unref();
          resolve();
        });
      }),
    async close() {
      closing = true;
      clearInterval(scheduleTimer);
      await schedulerWork;
      await recording?.stop();
      runController?.abort();
      await execution;
      await Promise.allSettled([...debugSessions.values()].map((session) => session.close()));
      debugSessions.clear();
      await auth.close();
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
        await persist();
      }
      await writeQueue;
      await new Promise((resolve) => {
        const forceClose = setTimeout(() => server.closeAllConnections(), SHUTDOWN_GRACE_MS);
        server.close(() => {
          clearTimeout(forceClose);
          resolve();
        });
        server.closeIdleConnections();
      });
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const studio = await createStudio();
  await studio.listen();
  console.log(`QA Studio: http://127.0.0.1:${studio.server.address().port}`);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
      await studio.close();
      process.exit(0);
    });
  }
}
