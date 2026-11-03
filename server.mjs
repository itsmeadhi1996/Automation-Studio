import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adminOnlyPermissions, authorize, createAuth, homeFor, permissionCatalog } from './auth.mjs';
import { contentTag, createStaticResponder, sendText } from './http-response.mjs';
import { createMetrics, eventLoopDelay, storageHealth } from './ops.mjs';
import { sourceVersion } from './runtime-version.mjs';
import { createVault } from './storage.mjs';

const appRoot = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_PORT = 3300;
const BODY_LIMIT_BYTES = 2 * 1024 * 1024;
const SAVE_BATCH_MS = 200;
const SHUTDOWN_GRACE_MS = 5000;
const WORK_LOG_LIMIT = 10000;
const WORK_LOG_PAGE = 50;

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
  store.projectMembers ||= {};
  store.projectAccessRevisions ||= {};
  store.workLog ||= [];
  store.workLogStartedAt ||= new Date().toISOString();

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

  async function staticRoutes(req, res, route) {
    if (req.method !== 'GET' || !STATIC_ROUTES.has(route)) return false;
    const name = STATIC_ROUTES.get(route);
    res.setHeader('Content-Security-Policy', PAGE_CSP);
    await serveStatic(req, res, name, CONTENT_TYPES[path.extname(name)]);
    return true;
  }

  const routeHandlers = [adminUserRoutes, staticRoutes];

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
    const user = auth.current(req);
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
      const target = route.match(/^\/api\/(projects|runs|manual-runs)\/([\w-]+)/);
      if (target?.[1] === 'projects') requireProject(target[2]);
      else if (target) findRun(target[2]);
      if (url.searchParams.has('projectId') && route.startsWith('/api/')) {
        requireProject(url.searchParams.get('projectId'));
      }
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
        if (error.userMessage) body.userMessage = error.userMessage;
        if (error.code) body.code = error.code;
        await json(res, body, status);
      }
    }),
  );

  await persist();

  return {
    server,
    store,
    listen: () => new Promise((resolve) => server.listen(port, '127.0.0.1', resolve)),
    async close() {
      closing = true;
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
