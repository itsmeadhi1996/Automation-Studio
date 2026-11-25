import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const deriveKey = promisify(scrypt);
const SESSION_LIFETIME_MS = 8 * 60 * 60 * 1000;
const MAX_OTHER_SESSIONS = 9;
const THROTTLE_LIMIT = 15;
const THROTTLE_WINDOW_MS = 60000;
const MIN_PASSWORD = 12;
const MAX_PASSWORD = 256;

const fail = (message, status = 400) => {
  throw Object.assign(new Error(message), { status });
};
const digest = (token) => createHash('sha256').update(token).digest('hex');

export const permissionCatalog = [
  {
    id: 'qa',
    name: 'QA Studio',
    group: 'Studio access',
    description: 'Manage cases, folders, suites and manual runs in assigned projects. View their dashboards and reports.',
  },
  {
    id: 'automation',
    name: 'Automation Studio',
    group: 'Studio access',
    description: 'Edit and run automation, record, debug and schedule tests.',
  },
  {
    id: 'createProjects',
    name: 'Create projects',
    group: 'Projects',
    description: 'Create or import projects in an assigned studio. Project assignments are managed separately in Project management.',
  },
  {
    id: 'useMcp',
    name: 'Use configured MCP servers',
    group: 'MCP access',
    requires: ['automation'],
    description: 'Discover and call tools on servers configured by an administrator, including approved AI context tools.',
  },
  {
    id: 'manageMcp',
    name: 'Manage MCP connections',
    group: 'MCP access',
    requires: ['automation'],
    description: 'Add, edit, remove and configure MCP connections and credentials. Includes use of configured servers.',
  },
];

export const adminOnlyPermissions = [
  {
    name: 'Users and permissions',
    description: 'Create accounts, assign permissions, reset passwords and disable users.',
  },
  {
    name: 'Project management',
    description: 'Assign users to project dashboards and review the project working log.',
  },
  { name: 'Application settings', description: 'Configure AI providers and shared model settings.' },
  { name: 'System connections', description: 'Configure VPN and the Jira bug tracker.' },
  { name: 'Workspace maintenance', description: 'Create or restore backups and clean execution history.' },
];

const normalizedPermissions = (permissions) =>
  Object.fromEntries(permissionCatalog.map(({ id }) => [id, permissions?.[id] === true]));

function storedPermissions(value) {
  const permissions = normalizedPermissions(value);
  if (!permissions.automation) {
    permissions.useMcp = false;
    permissions.manageMcp = false;
  } else if (permissions.manageMcp) {
    permissions.useMcp = true;
  }
  if (!permissions.qa && !permissions.automation) permissions.createProjects = false;
  return permissions;
}

const userRevision = (user) => user.revision || 1;

export function can(user, permission) {
  if (!user?.active) return false;
  if (user.role === 'admin') return true;
  const permissions = user.permissions || {};
  if ((permission === 'useMcp' || permission === 'manageMcp') && !permissions.automation) return false;
  if (permission === 'createProjects' && !permissions.qa && !permissions.automation) return false;
  if (permission === 'useMcp') return permissions.useMcp === true || permissions.manageMcp === true;
  return permissions[permission] === true;
}

export const publicUser = (user) =>
  user && {
    id: user.id,
    username: user.username,
    name: user.name,
    role: user.role,
    active: user.active,
    permissions: normalizedPermissions(user.permissions),
    effectivePermissions: Object.fromEntries(permissionCatalog.map(({ id }) => [id, can(user, id)])),
    createdAt: user.createdAt,
    revision: userRevision(user),
  };

export function homeFor(user) {
  if (user.role === 'admin') return '/admin';
  if (can(user, 'qa')) return '/';
  if (can(user, 'automation')) return '/automation';
  return '/account';
}

async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
    fail(`Use a password between ${MIN_PASSWORD} and ${MAX_PASSWORD} characters.`);
  }
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${(await deriveKey(password, salt, 64)).toString('hex')}`;
}

async function verifyPassword(password, hash) {
  const [salt, expected] = hash.split(':');
  const candidate = typeof password === 'string' && password.length <= MAX_PASSWORD ? password : '';
  const actual = await deriveKey(candidate, salt, 64);
  return timingSafeEqual(actual, Buffer.from(expected, 'hex'));
}

function isValidPermissionInput(permissions) {
  if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) return false;
  const known = new Set(permissionCatalog.map((permission) => permission.id));
  return Object.entries(permissions).every(([id, value]) => known.has(id) && typeof value === 'boolean');
}

function accountFields(input, previous = {}) {
  const rawUsername = input.username ?? previous.username ?? '';
  if (typeof rawUsername !== 'string') fail('Username must be text.');
  const username = rawUsername.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._@-]{2,79}$/.test(username)) {
    fail('Username must be 3–80 characters: letters, numbers, dot, underscore, @ or hyphen.');
  }
  const rawName = input.name ?? previous.name ?? '';
  if (typeof rawName !== 'string') fail('Display name must be text.');
  const name = rawName.trim();
  if (!name || name.length > 120) fail('Enter a display name of up to 120 characters.');
  const role = input.role ?? previous.role ?? 'user';
  if (role !== 'admin' && role !== 'user') fail('Choose Admin or User.');
  const active = input.active ?? previous.active ?? true;
  if (typeof active !== 'boolean') fail('Invalid account status.');
  const permissions = input.permissions ?? previous.permissions ?? {};
  if (!isValidPermissionInput(permissions)) fail('Invalid studio permissions.');
  return { username, name, role, active, permissions: storedPermissions(permissions) };
}

function bearerOrCookieToken(req) {
  return (
    req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]+)$/)?.[1] ||
    req.headers.cookie?.match(/(?:^|;\s*)studio_session=([A-Za-z0-9_-]+)/)?.[1]
  );
}

export async function createAuth(directory) {
  const file = path.join(directory, 'users.json');
  let users;
  try {
    users = JSON.parse(await readFile(file, 'utf8')).users;
    if (!Array.isArray(users)) throw new Error('Invalid user database');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    users = [];
  }

  const sessions = new Map();
  const attempts = new Map();
  const dummyHash = await hashPassword(randomBytes(24).toString('hex'));
  let queue = Promise.resolve();

  // Changes run one at a time on a copy, so a failed validation or write leaves `users` intact.
  const change = (mutate) => {
    const work = queue.then(async () => {
      const next = structuredClone(users);
      const result = await mutate(next);
      await writeFile(`${file}.tmp`, JSON.stringify({ users: next }, null, 2), { mode: 0o600 });
      await rename(`${file}.tmp`, file);
      users = next;
      return result;
    });
    queue = work.catch(() => {});
    return work;
  };

  const revokeSessions = (userId) => {
    for (const [key, session] of sessions) {
      if (session.userId === userId) sessions.delete(key);
    }
  };

  function issueSession(user) {
    for (const [key, session] of sessions) {
      if (session.expires <= Date.now()) sessions.delete(key);
    }
    const own = [...sessions.entries()].filter(([, session]) => session.userId === user.id);
    for (const [key] of own.slice(0, Math.max(0, own.length - MAX_OTHER_SESSIONS))) sessions.delete(key);
    const token = randomBytes(32).toString('base64url');
    sessions.set(digest(token), { userId: user.id, expires: Date.now() + SESSION_LIFETIME_MS });
    return token;
  }

  function checkThrottle(address) {
    const now = Date.now();
    for (const [key, value] of attempts) {
      if (value.until <= now) attempts.delete(key);
    }
    const bucket = attempts.get(address) || { count: 0, until: now + THROTTLE_WINDOW_MS };
    attempts.set(address, bucket);
    bucket.count += 1;
    if (bucket.count > THROTTLE_LIMIT) fail('Too many sign-in attempts. Try again in a minute.', 429);
    return bucket;
  }

  return {
    setupRequired: () => users.length === 0,
    list: () => users.map(publicUser),
    find: (id) => users.find((user) => user.id === id),

    // passwordHash lets a hosted site create its administrator without the password in its source.
    setup(input, { passwordHash } = {}) {
      if (passwordHash !== undefined && !/^[0-9a-f]{32}:[0-9a-f]{128}$/.test(passwordHash)) {
        fail('The administrator password hash is not valid.');
      }
      return change(async (next) => {
        if (next.length) fail('Administrator setup is already complete.', 409);
        const fields = accountFields({
          ...input,
          role: 'admin',
          active: true,
          permissions: { qa: true, automation: true },
        });
        const user = {
          ...fields,
          id: randomUUID(),
          revision: 1,
          createdAt: new Date().toISOString(),
          passwordHash: passwordHash ?? (await hashPassword(input.password)),
        };
        next.push(user);
        return publicUser(user);
      });
    },

    async login(input, address) {
      const bucket = checkThrottle(address);
      const username = String(input.username || '').trim().toLowerCase();
      const user = users.find((candidate) => candidate.username === username);
      const valid = await verifyPassword(input.password, user?.passwordHash || dummyHash);
      const hasAccess = user?.role === 'admin' || can(user, 'qa') || can(user, 'automation');
      if (!valid || !user?.active || !hasAccess) {
        fail('Invalid credentials or account access is disabled. Contact your administrator.', 401);
      }
      // A concurrent password or permission change invalidates an in-flight login too.
      if (users.find((current) => current.id === user.id) !== user) {
        fail('Account changed. Please sign in again.', 401);
      }
      bucket.count = Math.max(0, bucket.count - 1);
      return { user: publicUser(user), token: issueSession(user) };
    },

    current(req) {
      const token = bearerOrCookieToken(req);
      if (!token) return null;
      const key = digest(token);
      const session = sessions.get(key);
      if (!session || session.expires <= Date.now()) {
        sessions.delete(key);
        return null;
      }
      const user = users.find((candidate) => candidate.id === session.userId);
      return user?.active ? publicUser(user) : null;
    },

    logout(req) {
      const token = bearerOrCookieToken(req);
      if (token) sessions.delete(digest(token));
    },

    create(input) {
      return change(async (next) => {
        const user = {
          ...accountFields(input),
          id: randomUUID(),
          revision: 1,
          createdAt: new Date().toISOString(),
          passwordHash: await hashPassword(input.password),
        };
        if (next.some((old) => old.username === user.username)) fail('This username already exists.', 409);
        next.push(user);
        return publicUser(user);
      });
    },

    async update(id, input) {
      const result = await change(async (next) => {
        const index = next.findIndex((user) => user.id === id);
        if (index < 0) fail('User not found.', 404);
        if (input.revision !== undefined) {
          if (!Number.isSafeInteger(input.revision) || input.revision < 1) fail('Invalid user revision.');
          if (input.revision !== userRevision(next[index])) {
            fail('This user changed. Reload the current user before saving.', 409);
          }
        }
        const user = {
          ...next[index],
          ...accountFields(input, next[index]),
          revision: userRevision(next[index]) + 1,
        };
        if (next.some((old) => old.id !== id && old.username === user.username)) {
          fail('This username already exists.', 409);
        }
        if (input.password !== undefined) user.passwordHash = await hashPassword(input.password);
        next[index] = user;
        if (!next.some((candidate) => candidate.active && candidate.role === 'admin')) {
          fail('Keep at least one active administrator.', 409);
        }
        return publicUser(user);
      });
      revokeSessions(id);
      return result;
    },

    async password(id, input) {
      await change(async (next) => {
        const user = next.find((candidate) => candidate.id === id);
        if (!user || !(await verifyPassword(input.currentPassword, user.passwordHash))) {
          fail('Current password is incorrect.', 400);
        }
        user.passwordHash = await hashPassword(input.password);
        user.revision = userRevision(user) + 1;
      });
      revokeSessions(id);
    },

    cookie: (token) =>
      `studio_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${token ? SESSION_LIFETIME_MS / 1000 : 0}`,
    close: () => queue,
  };
}

const AUTOMATION_PAGES = new Set([
  '/run-history',
  '/history-page.js',
  '/execution-overview.js',
  '/automation',
  '/app.js',
  '/automation-cases.js',
]);

function isAdminOnlyRoute(route, method) {
  if (route === '/api/ai/reasonx/start' || route.startsWith('/api/admin/')) return true;
  if (/^\/api\/(backups|history\/retain|vpn)(\/|$)/.test(route)) return true;
  if (route === '/api/settings' && method !== 'GET') return true;
  if (/^\/api\/bug-tracker(?:\/connect)?$/.test(route) && method !== 'GET') return true;
  return route === '/admin' || route.startsWith('/admin/');
}

function isAutomationRoute(route, method) {
  if (AUTOMATION_PAGES.has(route)) return true;
  if (/^\/api\/(automation|recordings|debug|preflight|inspect|ai|jdbc|local-data|datasets|schedules)(\/|$)/.test(route)) {
    return true;
  }
  if (route === '/api/runs' && method === 'POST') return true;
  return /^\/api\/runs\/[^/]+\/cancel$/.test(route) || /^\/api\/projects\/[^/]+\/tests$/.test(route);
}

// Shared project metadata and reports are available to either studio. Operational
// endpoints and application administration are authorized separately.
export function authorize(user, route, method, url) {
  const requirePermission = (permission) => {
    if (can(user, permission)) return;
    const name = permissionCatalog.find((item) => item.id === permission)?.name || permission;
    fail(`Permission required: ${name}.`, 403);
  };

  if (/^\/api\/projects\/[\w-]+\/requirements(?:\/|$)/.test(route) || route === '/requirements.js') {
    requirePermission('qa');
    return;
  }
  if (route === '/api/projects' && method === 'POST') {
    requirePermission('createProjects');
    return;
  }
  if (route.startsWith('/api/mcp/')) {
    requirePermission(/^\/api\/mcp\/[^/]+\/(tools|call|reconnect)$/.test(route) ? 'useMcp' : 'manageMcp');
    return;
  }
  if (isAdminOnlyRoute(route, method)) {
    if (user.role !== 'admin') fail('Administrator access required.', 403);
    return;
  }
  if (route === '/' || route === '/qa.js' || route.startsWith('/api/manual-runs')) {
    requirePermission('qa');
    return;
  }
  if (isAutomationRoute(route, method)) {
    requirePermission('automation');
    return;
  }
  if (route === '/api/state') {
    requirePermission(url.searchParams.get('workspace') === 'automation' ? 'automation' : 'qa');
    return;
  }
  if ((route.startsWith('/api/') || route.startsWith('/artifacts/')) && !can(user, 'qa') && !can(user, 'automation')) {
    fail('No studio access assigned. Contact your administrator.', 403);
  }
}

const QA_PROJECT_FIELDS = ['name', 'folders', 'suites', 'testPlans', 'requirements'];
const QA_ITEM_FIELDS = ['id', 'name', 'qa', 'folderId', 'suiteId', 'additionalSuiteIds', 'prerequisiteId', 'inTestPlan'];

// QA-only users can maintain manual cases, but cannot overwrite executable
// scripts or connection credentials through the shared project save endpoint.
export function qaProjectInput(input, previous = {}) {
  const next = { ...previous };
  for (const field of QA_PROJECT_FIELDS) {
    if (input[field] !== undefined) next[field] = input[field];
  }
  for (const collection of ['tests', 'prerequisites']) {
    next[collection] = (input[collection] || []).map((item) => {
      const old = previous[collection]?.find((candidate) => candidate.id === item.id);
      const result = { ...old };
      for (const field of QA_ITEM_FIELDS) {
        if (item[field] !== undefined) result[field] = item[field];
      }
      result.steps = old?.steps || [];
      return result;
    });
  }
  return next;
}
