import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdir, open, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import {
  DOCUMENT_SIZE_MESSAGE,
  DOCUMENT_TYPE_MESSAGE,
  MAX_DOCUMENT_BYTES,
  MAX_PROJECT_DOCUMENTS,
  canPreviewInline,
  checkDocumentContent,
  documentContext,
  documentName,
  documentType,
  documentWarnings,
  extractDocumentText,
} from './project-documents.mjs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { launchBrowser } from './browsers.mjs';
import {
  createJiraIssue,
  issueDraft,
  jiraIssueOptions,
  normalizeBugTracker,
  publicBugTracker,
  uploadJiraAttachment,
  verifyBugTracker,
} from './bug-tracker.mjs';
import {
  attachmentName,
  buildIssueDraft,
  collectEvidence,
  MAX_ATTACHMENT_BYTES,
  REPORT_EVIDENCE_ID,
} from './issue-report.mjs';
import { queryDatabase } from './database.mjs';
import { OpenVpnConnect } from './vpn.mjs';
import { parseCsv } from './datasets.mjs';
import { executionCsv, queryExecutionOverview } from './execution-overview.mjs';
import { queryRunHistory } from './history-query.mjs';
import { agentOptions, checkpoint } from './agent-workflow.mjs';
import { inspectionUrl, inspectPage, validateGeneratedTest } from './inspection.mjs';
import {
  draftTest,
  McpConnections,
  normalizeIntegrationSettings,
  providerKey,
  publicSettings,
  reasonxBaseUrl,
} from './integrations.mjs';
import { fileLimit, normalizeLocalData, readDataTable, resolveLocalValue } from './local-data.mjs';
import { mcpCatalog } from './mcp-catalog.mjs';
import { reasonxModelList, reasonxModels } from './reasonx-client.mjs';
import { createReasonxRuntime } from './reasonx-runtime.mjs';
import { automationWorkflow } from './reasonx-workflows.mjs';
import { aiEngines, engineSettings, normalizeUserAi, publicUserAi, verifyEngine } from './user-ai.mjs';
import { monocartReportHtml } from './monocart-report.mjs';
import { playwrightJsonReport } from './playwright-json.mjs';
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
import { caseRun, isIndividualCaseRun, matchesCase, recoverTestPlans, sortRunsNewestFirst } from './public/run-history.js';
import { createManualRun, updateManualRun } from './qa-model.mjs';
import { startRecording } from './recorder.mjs';
import { requireAgentModel, runRequirementAgent } from './requirement-agent.mjs';
import { requirementErrorUserMessage } from './requirement-errors.mjs';
import {
  generateCloudRequirementDraft,
  generateRequirementDraft,
  requireGenerationModel,
} from './requirement-generation.mjs';
import { inspectRequirementApp } from './requirement-inspection.mjs';
import {
  identifyRequirementCase,
  normalizeRequirementDrafts,
  requirementFields,
  requirementFingerprint,
} from './requirements.mjs';
import { generateQwenRequirementDraft } from './qwen-requirements.mjs';
import { generatedCasesToQa, generateTestCases, metadataFromInspection } from './test-case-generator.mjs';
import { generateRequirementTestSteps, inspectedNavigationLinks } from './test-step-generator.mjs';
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
const MAX_REQUIREMENT_BATCH = 1000;
const MAX_REQUIREMENT_DRAFTS = 1000;
const MAX_PROJECT_TESTS = 1000;
const MAX_GENERATION_WARNINGS = 30;
const DOCUMENT_ROUTE = /^\/api\/projects\/([\w-]+)\/documents(?:\/([a-f0-9-]{36})(?:\/(content))?)?$/;
const DOCUMENT_CONTEXT_LIMITS = { cloud: 40000, qwen: 12000, agent: 700 };
const REQUIREMENT_ROUTE =
  /^\/api\/projects\/([\w-]+)\/requirements(?:\/([\w-]+))?(?:\/(generate|approve|drafts|cases)(?:\/([\w-]+)(?:\/(generate-steps))?)?)?$/;
const MAX_AI_PROMPT = 12000;
const MAX_AI_MCP_SERVERS = 10;
const GENERATION_ATTEMPTS = 2;
const CORRECTABLE_GENERATION_ERRORS = ['GENERATED_LOCATOR_NOT_OBSERVED', 'GENERATED_LOCATOR_MISSING', 'GENERATED_URL_INVALID'];
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
// The interactive report needs scripts. Without allow-same-origin they run with no access to the
// signed-in session or Studio data, and the policy gives them no network either.
const INTERACTIVE_REPORT_CSP =
  "sandbox allow-scripts allow-downloads; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; worker-src blob:";
const REPORT_HISTORY_RUNS = 30;

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
  'requirement-documents.js',
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
  'issue-report.js',
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
  [/^\/api\/projects\/[^/]+\/documents/, (route, method) => `Project document ${method === 'DELETE' ? 'deleted' : 'uploaded'}`],
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
  [/^\/api\/issues\/[^/]+\/attachments$/, () => 'Issue attachment added'],
];

function workLogAction(route, method) {
  const match = WORK_LOG_ACTIONS.find(([pattern]) => pattern.test(route));
  return match?.[1](route, method);
}

// Fails with a plain-language issue for the generation error window.
function checkIssue(condition, message, issue) {
  if (!condition) throw Object.assign(new Error(message), { issues: [issue] });
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
    processes: (project.processes || []).map(redactCaseValues),
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
  // Hosted deployments only; locally Studio stays on loopback and accepts local requests alone.
  // Render sets RENDER on every service and only routes traffic to 0.0.0.0.
  host = process.env.HOST || (process.env.RENDER ? '0.0.0.0' : '127.0.0.1'),
  // Render provides RENDER_EXTERNAL_URL; STUDIO_PUBLIC_URL wins, for example for a custom domain.
  publicUrl = process.env.STUDIO_PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '',
  storage = process.env.STUDIO_STORAGE_DIR || appRoot,
  recordingLauncher = startRecording,
  aiFetcher = fetch,
  bugTrackerFetcher = fetch,
  onShutdown = null,
  vpn = new OpenVpnConnect(),
  requirementInspector = inspectRequirementApp,
  reasonxRuntime = createReasonxRuntime({
    home: process.env.REASONX_HOME || path.resolve(appRoot, '../../For Ai/aiResoningAgent'),
  }),
} = {}) {
  const dataDir = path.join(storage, 'data');
  const artifactsDir = path.join(storage, 'artifacts');
  await mkdir(dataDir, { recursive: true });
  await mkdir(artifactsDir, { recursive: true });
  const storeFile = path.join(dataDir, 'studio.json');

  const metrics = createMetrics();
  const vault = await createVault(dataDir);
  const auth = await createAuth(dataDir);
  const publicSite = publicUrl ? new URL(publicUrl) : null;
  if (publicSite && !['http:', 'https:'].includes(publicSite.protocol)) {
    throw new Error('STUDIO_PUBLIC_URL must start with http:// or https://');
  }
  // A public site must not hand administrator setup to whoever opens it first.
  if (publicSite && auth.setupRequired()) {
    const { STUDIO_ADMIN_USERNAME: username, STUDIO_ADMIN_PASSWORD: password } = process.env;
    if (!username || !password) {
      throw new Error('Set STUDIO_ADMIN_USERNAME and STUDIO_ADMIN_PASSWORD to create the first administrator.');
    }
    await auth.setup({ username, password, name: process.env.STUDIO_ADMIN_NAME || 'Administrator' });
  }
  const sessionCookie = (token) => auth.cookie(token) + (publicSite?.protocol === 'https:' ? '; Secure' : '');
  const runtime ={ pid: process.pid, sourceVersion: await sourceVersion(appRoot) };
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
  store.agentDrafts ||= [];
  store.userAi ||= {};
  store.issueReports ||= [];
  store.projectDocuments ||= {};

  const loadedSettings = store.settings || {};
  store.settings = normalizeIntegrationSettings(loadedSettings, loadedSettings);
  // A previous in-session migration briefly tagged a saved OpenAI model and key as
  // Google. The model ID tells them apart, so move the key into its own slot.
  if (store.settings.provider === 'google' && /^gpt[-_]/i.test(store.settings.model)) {
    store.settings.apiKeys ||= {};
    store.settings.apiKeys.openai ||= store.settings.apiKeys.google || store.settings.apiKey || '';
    delete store.settings.apiKeys.google;
    store.settings.apiKey = '';
    store.settings.model = 'gemini-3.8-flash';
  }

  // Keep the latest generation per project so a refreshed tab can recover its progress
  // or saved result. A server restart cannot resume an inference call.
  store.aiGenerations = (store.aiGenerations || [])
    .filter((job) => store.projects.some((project) => project.id === job.projectId))
    .map((job) =>
      job.status === 'running'
        ? {
            ...job,
            status: 'interrupted',
            finishedAt: new Date().toISOString(),
            error: 'Studio restarted before generation finished. Generate again to retry.',
          }
        : job,
    );

  const connections = new McpConnections();
  const authoringServer = {
    name: 'Studio authoring',
    transport: 'stdio',
    command: process.execPath,
    args: [path.join(appRoot, 'mcp-server.mjs'), `http://127.0.0.1:${port}`],
    env: {},
  };
  const authoring = new Set();
  const generationControllers = new Map();

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
      res.setHeader('Set-Cookie', sessionCookie(result.token));
      await json(res, { user: result.user, home: homeFor(result.user) });
      return true;
    }
    if (req.method === 'POST' && route === '/api/auth/logout') {
      auth.logout(req);
      res.setHeader('Set-Cookie', sessionCookie(''));
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

  // On Windows, SIGTERM ends the process without running close(), so the restart
  // helper asks here first. The pid check stops a request reaching the wrong server.
  async function shutdownRoute(req, res, route) {
    if (route !== '/api/admin/shutdown' || req.method !== 'POST') return false;
    if (!onShutdown) {
      await json(res, { error: 'Not found' }, 404);
      return true;
    }
    const input = await readBody(req);
    if (input.pid !== process.pid) {
      await json(res, { error: 'This request is for a different Studio process.' }, 409);
      return true;
    }
    const isBusy = activeRun || debugSessions.size || startingBrowser || recording || authoring.size;
    if (isBusy) {
      await json(res, { error: 'Finish active work before stopping Studio.' }, 409);
      return true;
    }
    res.once('finish', () => setImmediate(onShutdown));
    await json(res, { stopping: true }, 202);
    return true;
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
        aiGenerations: generationState(user),
        agentDrafts: can(user, 'automation')
          ? store.agentDrafts
              .filter((draft) => hasProject(user, draft.projectId))
              .map(({ inspection, ...draft }) => draft)
          : [],
        bugTracker: publicBugTracker(store.bugTracker),
        reportedIssues: store.issueReports.filter((issue) => isVisible(issue) && issue.status === 'created'),
        projects: isAutomation ? projects.map(automationProject) : projects.map((project) => projectForViewer(project)),
        runs: stateRuns().map((run) => runForViewer(run)),
        ...activityState(),
      });
      return true;
    }
    if (req.method === 'GET' && route === '/api/status') {
      await json(res, {
        activeGenerations: generationState(user).filter((job) => job.status === 'running'),
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
      const isBusy = activeRun || startingBrowser || recording || debugSessions.size || authoring.size;
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
    if (vpn.busy) {
      await json(res, { error: 'Wait for the OpenVPN request to finish before running tests.' }, 409);
      return;
    }
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
    run.mode = input.processId ? 'process' : 'automation';
    if (input.processId) {
      const flow = project.processes.find((item) => item.id === input.processId);
      run.name = `${flow.name} × ${run.tests.length}`;
    }
    run.environmentName = project.environments?.find((item) => item.id === project.activeEnvironmentId)?.name;
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

  // Earlier finished runs of the same project, or of the same case for a case report, oldest first.
  function reportHistory(run, testId) {
    const started = Date.parse(run.startedAt);
    const earlier = store.runs.filter(
      (candidate) =>
        candidate.projectId === run.projectId &&
        candidate.id !== run.id &&
        candidate.status !== 'running' &&
        !candidate.replay &&
        Date.parse(candidate.startedAt) < started,
    );
    return sortRunsNewestFirst(earlier)
      .map((candidate) => (testId ? caseRun(candidate, testId) : candidate))
      .filter(Boolean)
      .slice(0, REPORT_HISTORY_RUNS)
      .reverse();
  }

  async function sendRunReport(res, run, testId, reportPath) {
    const reportRun = testId ? caseRun(run, testId) : run;
    if (!reportRun) {
      await json(res, { error: 'This test case is not part of the run' }, 404);
      return;
    }
    if (reportPath === '/report.json') {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="run-${run.id}.json"`,
      });
      res.end(JSON.stringify(playwrightJsonReport(reportRun), null, 2));
      return;
    }
    if (reportPath === '/report/interactive') {
      const interactive = await monocartReportHtml(reportRun, artifactsDir, { history: reportHistory(run, testId) });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': INTERACTIVE_REPORT_CSP });
      res.end(interactive);
      return;
    }
    const wantsPdf = reportPath === '/report.pdf';
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
    const runRoute = route.match(/^\/api\/runs\/([\w-]+)(\/report(?:\.pdf|\.json|\/interactive)?)?$/);
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
      await sendRunReport(res, runForViewer(run), url.searchParams.get('testId'), reportPath);
      return true;
    }
    return false;
  }

  async function debugRoutes(req, res, route) {
    if (req.method !== 'POST') return false;
    if (route === '/api/debug') {
      const input = await readBody(req);
      const isBusy = vpn.busy || recordingLive() || startingBrowser || activeRun || debugSessions.size;
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

  // ---- Settings, MCP and AI ---------------------------------------------------

  const settingsResponse = (viewer) => ({
    ...publicSettings(store.settings),
    userAi: publicUserAi(store.userAi[viewer?.id]),
    ...(can(viewer, 'useMcp') ? {} : { mcpServers: [], aiMcpServerIds: [] }),
    bugTracker: publicBugTracker(store.bugTracker),
    mcpCatalog: can(viewer, 'manageMcp') ? mcpCatalog() : [],
    studioMcp: {
      command: process.execPath,
      args: [path.join(appRoot, 'mcp-server.mjs'), `http://127.0.0.1:${port}`],
    },
  });

  const findMcp = (serverId) => {
    const server = store.settings.mcpServers.find((candidate) => candidate.id === serverId);
    if (!server) throw httpError('MCP server not found', 404);
    return server;
  };

  async function saveSettings(input) {
    const settings = normalizeIntegrationSettings(input, store.settings);
    await connections.close();
    store.settings = settings;
    await persist();
  }

  async function settingsRoutes(req, res, route, url, user) {
    if (route === '/api/settings' && req.method === 'GET') {
      await json(res, settingsResponse(user));
      return true;
    }
    if (route === '/api/settings' && req.method === 'PUT') {
      await saveSettings(await readBody(req));
      await json(res, settingsResponse(user));
      return true;
    }
    if (route === '/api/account/ai' && req.method === 'GET') {
      await json(res, publicUserAi(store.userAi[user.id]));
      return true;
    }
    if (route === '/api/account/ai' && req.method === 'PUT') {
      store.userAi[user.id] = normalizeUserAi(await readBody(req), store.userAi[user.id]);
      await persist();
      await json(res, publicUserAi(store.userAi[user.id]));
      return true;
    }
    if (route === '/api/account/ai/test' && req.method === 'POST') {
      const input = await readBody(req);
      check(input.engine === 'claude' || input.engine === 'chatgpt', 'Choose Claude or ChatGPT to test');
      const settings = engineSettings(store.settings, store.userAi[user.id], input.engine);
      await json(res, await verifyEngine(settings, aiFetcher));
      return true;
    }
    return false;
  }

  async function mcpRoutes(req, res, route, url, user) {
    const presetRoute = route.match(/^\/api\/mcp\/presets\/(playwright|atlassian)$/);
    if (presetRoute && req.method === 'POST') {
      await readBody(req);
      const preset = mcpCatalog().find((item) => item.id === presetRoute[1]);
      let added = store.settings.mcpServers.find((server) => server.presetId === preset.id);
      if (!added) {
        added = { ...preset.config, id: randomUUID(), presetId: preset.id };
        const mcpServers = [...store.settings.mcpServers, added];
        store.settings = normalizeIntegrationSettings({ mcpServers }, store.settings);
        await persist();
      }
      await json(res, { ...settingsResponse(user), addedServerId: added.id });
      return true;
    }
    if (route === '/api/mcp/servers' && req.method === 'PUT') {
      const input = await readBody(req);
      const hasOnlyServers = Object.keys(input).every((key) => key === 'mcpServers');
      check(Array.isArray(input.mcpServers) && hasOnlyServers, 'Send only MCP server connections');
      await saveSettings({ mcpServers: input.mcpServers });
      await json(res, settingsResponse(user));
      return true;
    }
    const serverRoute = route.match(/^\/api\/mcp\/([\w-]+)\/(tools|call|reconnect)$/);
    if (!serverRoute || req.method !== 'POST') return false;
    const input = await readBody(req);
    const server = findMcp(serverRoute[1]);
    if (serverRoute[2] === 'reconnect') await json(res, await connections.reconnect(server));
    else if (serverRoute[2] === 'tools') await json(res, await connections.list(server));
    else await json(res, await connections.call(server, input.name, input.arguments));
    return true;
  }

  function generationState(user) {
    return store.aiGenerations.filter(
      (job) => hasProject(user, job.projectId) && can(user, job.kind === 'requirements' ? 'qa' : 'automation'),
    );
  }

  function startGeneration(details) {
    const job = {
      id: randomUUID(),
      ...details,
      status: 'running',
      stage: 'inspection',
      startedAt: new Date().toISOString(),
    };
    const others = store.aiGenerations.filter(
      (item) => item.projectId !== job.projectId && store.projects.some((project) => project.id === item.projectId),
    );
    store.aiGenerations = [...others, job];
    authoring.add(job.projectId);
    generationControllers.set(job.id, new AbortController());
    return job;
  }

  async function failGeneration(job, error) {
    Object.assign(job, {
      status: error.code === 'GENERATION_CANCELLED' ? 'cancelled' : 'failed',
      finishedAt: new Date().toISOString(),
      error: error.message || 'Generation failed. Try again.',
      issues: error.issues,
    });
    await persist();
  }

  async function authoringTool(name, args) {
    requireProject(args.projectId);
    const token = randomBytes(32).toString('base64url');
    const client = new McpConnections();
    serviceGrants.set(token, { userId: currentUser().id, projectId: args.projectId });
    let result;
    try {
      result = await client.call({ ...authoringServer, env: { STUDIO_SESSION_TOKEN: token } }, name, args);
    } finally {
      serviceGrants.delete(token);
      await client.close();
    }
    const text = result.content?.find((item) => item.type === 'text')?.text;
    check(!result.isError, text || 'Studio MCP tool failed');
    return JSON.parse(text);
  }

  const generationContext = (project) =>
    JSON.stringify([
      project.revision,
      project.activeEnvironmentId,
      project.environments,
      project.globalVariables,
      project.objects,
      project.locatorTemplates,
    ]);

  function correctionFeedback(error, project, explicitUrl) {
    if (error.code === 'GENERATED_URL_INVALID') {
      return (
        `${error.message} Begin with navigate to ${inspectionUrl(project, explicitUrl)}. Use a url step only with a ` +
        'full HTTP or HTTPS address; check messages and headings with text, visible or heading steps. Preserve the ' +
        'full workflow and exact variable names.'
      );
    }
    if (error.code === 'GENERATED_LOCATOR_MISSING') {
      return (
        `${error.message} Give that step a target. Use an observed control ID when the control is supplied. For a ` +
        'message that appears only after an action, set locatorType to text and target to the exact message from ' +
        'the workflow. Preserve the full workflow and exact variable names.'
      );
    }
    return (
      `${error.message} Correct ALL initial-page locators using the supplied observed controls. Copy locatorType, ` +
      'target and framePath exactly (or use observed control IDs when available). A visible caption does not imply ' +
      'a working label locator. Use the observed button text for the requested action. Preserve the full workflow ' +
      'and exact variable names; later-page checks remain unverified.'
    );
  }

  // Replaces a case's steps. Successful generation acknowledges the current requirements
  // even if the script is identical, so the update flag clears either way.
  async function saveGeneratedSteps(projectId, targetTest, steps) {
    const previous = findProject(projectId);
    const counter = { nextTestNumber: store.nextTestNumber };
    const tests = previous.tests.map((item) => (item.id === targetTest.qaCaseId ? { ...item, steps } : item));
    const next = normalizeProject({ ...previous, tests }, previous, counter);
    next.tests.find((item) => item.id === targetTest.qaCaseId).automationNeedsUpdate = false;
    store.projects[store.projects.indexOf(previous)] = next;
    await persist();
    return automationProject(next).tests.find((item) => item.id === targetTest.id);
  }

  async function generateAutomation(res, input, project, targetTest, engine, settings, servers) {
    const options = { ...agentOptions(input.agentOptions, project.agentOptions), ...(engine === 'studio' ? {} : { enabled: false }) };
    if (options.enabled) check(settings.provider === 'reasonx', 'Choose ReasonX in Model settings before enabling agents.');
    const job = startGeneration({
      projectId: project.id,
      kind: 'automation',
      testId: targetTest?.id || null,
      model: settings.model,
      ...(engine === 'studio' ? { reasonxMode: settings.reasonxMode } : { engine }),
    });
    const { signal } = generationControllers.get(job.id);
    const { prompt } = input;
    // Regenerating from a midway step keeps the earlier steps unchanged. The model sees them with
    // sensitive values masked and returns only the steps that follow.
    const keptSteps = input.regenerateFrom ? targetTest.steps.slice(0, input.regenerateFrom) : [];
    const withKeptSteps = (value) => {
      if (!keptSteps.length) return value;
      checkIssue(value.steps.length, `The model returned no steps after step ${keptSteps.length}. Generate again.`, {
        step: keptSteps.length + 1,
        problem: `The AI returned no new steps after step ${keptSteps.length}.`,
        expected: `New steps from step ${keptSteps.length + 1} onward to finish the workflow.`,
        found: 'No new steps.',
        fix: 'Describe what should happen after the kept steps, then generate again.',
      });
      return { ...value, steps: [...structuredClone(keptSteps), ...value.steps] };
    };
    const draftOptions = keptSteps.length ? { keptSteps: maskSensitiveSteps(keptSteps) } : {};
    try {
      await persist();
      const explicitUrl = prompt.match(/https?:\/\/[^\s<>"']+/i)?.[0]?.replace(/[.,;:!?)\]}'"*`]+$/, '');
      const inspection = await authoringTool('studio_inspect_page', {
        projectId: project.id,
        ...(explicitUrl ? { url: explicitUrl } : {}),
      });
      checkpoint(signal);

      let draft;
      let warnings;
      let validationFeedback;
      if (options.enabled) {
        const agentSettings = {
          ...settings,
          model: options.model || settings.model,
          reasonxMode: options.mode || settings.reasonxMode,
        };
        draft = await automationWorkflow({
          settings,
          options,
          project,
          targetTest,
          prompt,
          inspection,
          fetcher: aiFetcher,
          signal,
          onStage: ({ stage, detail }) => {
            job.stage = stage;
            job.detail = detail;
          },
          generate: async (feedback) =>
            withKeptSteps(
              await draftTest(agentSettings, project, prompt, aiFetcher, {
                connections,
                servers,
                inspection,
                targetTest,
                validationFeedback: feedback,
                signal,
                agentOptions: options,
                ...draftOptions,
              }),
            ),
          validate: (value) => {
            warnings = validateGeneratedTest(project, value, inspection);
          },
        });
      } else {
        for (let attempt = 0; attempt < GENERATION_ATTEMPTS; attempt += 1) {
          job.stage = attempt ? 'correcting' : 'drafting';
          draft = withKeptSteps(
            await draftTest(settings, project, prompt, aiFetcher, {
              connections,
              servers,
              inspection,
              targetTest,
              validationFeedback,
              signal,
              ...draftOptions,
            }),
          );
          job.stage = 'validation';
          // Check again after each model call, including automatic corrections.
          check(
            generationContext(findProject(project.id)) === generationContext(project),
            'Project variables or objects changed during generation. Generate again using the updated project.',
          );
          try {
            warnings = validateGeneratedTest(project, draft, inspection);
            break;
          } catch (error) {
            const isLastAttempt = attempt === GENERATION_ATTEMPTS - 1;
            if (isLastAttempt || !CORRECTABLE_GENERATION_ERRORS.includes(error.code)) throw error;
            // Feedback contains no draft values or credentials. Keep the same inspection
            // and validate the correction before any case is saved.
            validationFeedback = correctionFeedback(error, project, explicitUrl);
          }
        }
      }

      if (targetTest) {
        for (const step of draft.steps) {
          const isKnown = !step.qaRequirementId || targetTest.qa.manualSteps.some((item) => item.id === step.qaRequirementId);
          checkIssue(isKnown, 'Generated step references an unknown QA requirement. Generate again.', {
            step: draft.steps.indexOf(step) + 1,
            problem: 'The step is linked to a QA requirement that this test case does not have.',
            expected: `One of this case's ${targetTest.qa.manualSteps.length} QA requirements, or no link.`,
            found: `An unknown requirement ID “${String(step.qaRequirementId).slice(0, 80)}”.`,
            fix: 'Generate again.',
          });
        }
      }
      const environment = project.environments.find((item) => item.id === project.activeEnvironmentId);
      const firstUrl = resolveValue(draft.steps[0], {
        globals: project.globalVariables,
        environment: environment?.variables || {},
      });
      checkIssue(
        new URL(firstUrl).href === inspectionUrl(project, explicitUrl),
        'The generated test navigates to a different URL than the inspected page. Specify the starting URL and generate again.',
        {
          step: 1,
          problem: 'The test opens a different page from the one Studio inspected.',
          expected: `Step 1 opens ${inspectionUrl(project, explicitUrl)}.`,
          found: draft.steps[0].valueMode === 'static' ? `Step 1 opens ${firstUrl}.` : `Step 1 opens the address in ${draft.steps[0].value}.`,
          fix: 'Put the starting URL at the beginning of your description, then generate again.',
        },
      );
      checkpoint(signal);
      check(
        generationContext(findProject(project.id)) === generationContext(project),
        'Project changed during generation. Generate again.',
      );

      if (options.enabled) {
        const preview = {
          id: job.id,
          projectId: project.id,
          testId: targetTest?.id || null,
          qaCaseId: targetTest?.qaCaseId || null,
          revision: project.revision,
          draft,
          warnings,
          inspection,
          createdAt: new Date().toISOString(),
        };
        store.agentDrafts = [...store.agentDrafts.filter((item) => item.projectId !== project.id), preview];
        Object.assign(job, { status: 'review', stage: 'review', finishedAt: new Date().toISOString() });
        await persist();
        await json(res, { preview: { ...preview, inspection: undefined }, status: 'review' }, 201);
        return;
      }

      job.stage = 'saving';
      const test = targetTest
        ? await saveGeneratedSteps(project.id, targetTest, draft.steps)
        : await authoringTool('studio_create_test', { projectId: project.id, name: draft.name, steps: draft.steps });
      Object.assign(job, {
        status: 'completed',
        finishedAt: new Date().toISOString(),
        testId: test.id,
        explanation: draft.explanation,
        warnings,
        projectRevision: findProject(project.id).revision,
      });
      await persist();
      await json(
        res,
        {
          test,
          generationId: job.id,
          projectRevision: job.projectRevision,
          explanation: draft.explanation,
          warnings,
          inspection: { title: inspection.title, elementCount: inspection.elements.length, scope: inspection.scope },
          status: 'not_run',
        },
        201,
      );
    } catch (error) {
      if (job.status === 'running') await failGeneration(job, error);
      throw error;
    } finally {
      authoring.delete(project.id);
      generationControllers.delete(job.id);
    }
  }

  async function applyAgentDraft(res, input) {
    const preview = store.agentDrafts.find((draft) => draft.id === input.id);
    check(preview, 'Draft no longer exists. Generate again.');
    const previous = findProject(preview.projectId);
    check(!authoring.has(previous.id), 'Generation is running. Wait before applying this draft.');
    check(previous.revision === preview.revision, 'Project changed since this draft. Generate again before applying.');
    const project = automationProject(previous);
    validateGeneratedTest(project, preview.draft, preview.inspection);
    authoring.add(previous.id);
    try {
      let test;
      if (preview.testId) {
        const target = project.tests.find((item) => item.id === preview.testId);
        check(target, 'Test case no longer exists.');
        for (const step of preview.draft.steps) {
          const isKnown = !step.qaRequirementId || target.qa.manualSteps.some((item) => item.id === step.qaRequirementId);
          check(isKnown, 'Unknown requirement mapping.');
        }
        test = await saveGeneratedSteps(previous.id, target, preview.draft.steps);
      } else {
        test = await authoringTool('studio_create_test', {
          projectId: previous.id,
          name: preview.draft.name,
          steps: preview.draft.steps,
        });
      }
      store.agentDrafts = store.agentDrafts.filter((draft) => draft.id !== preview.id);
      const job = store.aiGenerations.find((item) => item.projectId === previous.id);
      if (job) {
        Object.assign(job, {
          status: 'completed',
          stage: 'completion',
          finishedAt: new Date().toISOString(),
          testId: test.id,
          explanation: preview.draft.explanation,
          warnings: preview.warnings,
          error: undefined,
          issues: undefined,
        });
      }
      await persist();
      await json(res, { test, status: 'not_run', explanation: preview.draft.explanation }, 201);
    } finally {
      authoring.delete(previous.id);
    }
  }

  async function draftOrCreate(req, res, route, user) {
    const input = await readBody(req);
    const validPrompt =
      typeof input.prompt === 'string' && input.prompt.trim() && input.prompt.length <= MAX_AI_PROMPT;
    check(validPrompt, 'Describe your test in 1–12000 characters');
    const serverIds = input.mcpServerIds || [];
    check(Array.isArray(serverIds) && serverIds.length <= MAX_AI_MCP_SERVERS, 'Select up to 10 MCP servers');
    if (serverIds.length && !can(user, 'useMcp')) {
      await json(res, { error: 'Permission required: Use configured MCP servers.' }, 403);
      return;
    }
    const servers = serverIds.map((id) => {
      const server = store.settings.mcpServers.find((candidate) => candidate.id === id);
      check(server, `Unknown MCP server: ${id}`);
      return server;
    });
    const project = structuredClone(findAutomationProject(input.projectId));
    if (input.testId !== undefined) {
      check(typeof input.testId === 'string' && input.testId.trim(), 'Select a valid test case for Auto generator.');
    }
    const targetTest = input.testId ? project.tests.find((test) => test.id === input.testId) : null;
    check(!input.testId || targetTest, 'Test case not found');
    if (targetTest) check(targetTest.qa?.manualSteps?.length, 'Add QA requirements before using Auto generator.');
    const { regenerateFrom = 0 } = input;
    check(
      Number.isInteger(regenerateFrom) &&
        regenerateFrom >= 0 &&
        (!regenerateFrom || (targetTest && regenerateFrom < targetTest.steps.length)),
      'Select a step of this test case to regenerate from.',
    );
    // Claude and ChatGPT use the signed-in user's own key; "studio" uses shared Model settings.
    const engine = input.engine ?? store.userAi[user.id]?.engines?.automation ?? 'studio';
    check(aiEngines.includes(engine), 'Choose Studio, Claude or ChatGPT for test generation');
    const settings = engineSettings(store.settings, store.userAi[user.id], engine);
    if (route === '/api/ai/draft') {
      await json(res, await draftTest(settings, project, input.prompt, aiFetcher, { connections, servers }));
      return;
    }
    if (authoring.has(project.id)) {
      await json(
        res,
        {
          error: 'Generation is already running for this project. Reconnect to its progress instead of starting another request.',
          code: 'GENERATION_IN_PROGRESS',
        },
        409,
      );
      return;
    }
    await generateAutomation(res, input, project, targetTest, engine, structuredClone(settings), servers);
  }

  async function aiRoutes(req, res, route, url, user) {
    if (route === '/api/ai/reasonx/start' && req.method === 'POST') {
      const baseUrl = reasonxBaseUrl(store.settings.reasonxBaseUrl);
      const apiKey = providerKey({
        ...store.settings,
        provider: 'reasonx',
        apiKey: store.settings.apiKeys?.reasonx || '',
      });
      const probe = () => reasonxModelList({ fetcher: aiFetcher, baseUrl, apiKey });
      await json(res, await reasonxRuntime.start(probe));
      return true;
    }
    if (route === '/api/ai/status' && req.method === 'GET') {
      const { settings } = store;
      const isLocal = settings.provider === 'reasonx';
      const local = isLocal
        ? {
            reasonxMode: settings.reasonxMode || 'auto',
            knownModels: reasonxModels,
            ...(await reasonxModelList({
              fetcher: aiFetcher,
              baseUrl: reasonxBaseUrl(settings.reasonxBaseUrl),
              apiKey: providerKey(settings),
            })),
          }
        : {};
      await json(res, {
        provider: settings.provider,
        model: settings.model,
        ...local,
        hasApiKey: Boolean(providerKey(settings)),
        mcpServers: can(user, 'useMcp') ? settings.aiMcpServerIds || [] : [],
      });
      return true;
    }
    if (route === '/api/ai/apply' && req.method === 'POST') {
      await applyAgentDraft(res, await readBody(req));
      return true;
    }
    if ((route === '/api/ai/draft' || route === '/api/ai/create') && req.method === 'POST') {
      await draftOrCreate(req, res, route, user);
      return true;
    }
    const cancelRoute = route.match(/^\/api\/generations\/([\w-]+)\/cancel$/);
    if (cancelRoute && req.method === 'POST') {
      await readBody(req);
      const job = store.aiGenerations.find((item) => item.id === cancelRoute[1]);
      const canSee = job && hasProject(user, job.projectId) && can(user, job.kind === 'requirements' ? 'qa' : 'automation');
      check(canSee, 'Generation not found or access denied.');
      check(job.status === 'running' && generationControllers.has(job.id), 'Generation is no longer running.');
      generationControllers.get(job.id).abort();
      job.stage = 'cancelling';
      await json(res, { status: 'cancelling' }, 202);
      return true;
    }
    return false;
  }

  // ---- Requirements ------------------------------------------------------------

  const isValidIdSelection = (ids) =>
    Array.isArray(ids) &&
    ids.length > 0 &&
    ids.length <= MAX_REQUIREMENT_BATCH &&
    ids.every((id) => typeof id === 'string') &&
    new Set(ids).size === ids.length;

  function isSupportedRequirementRequest(method, requirementId, operation, itemId, stepOperation) {
    if (!requirementId) return !operation && method === 'POST';
    if (!operation) return method === 'PUT' || method === 'DELETE';
    if (operation === 'generate' || operation === 'approve') return !itemId && method === 'POST';
    if (operation === 'drafts') {
      if (stepOperation) return false;
      return itemId ? method === 'PUT' || method === 'DELETE' : method === 'DELETE';
    }
    return Boolean(itemId && stepOperation === 'generate-steps' && method === 'POST');
  }

  function mergeDraftEdit(draft, edit) {
    return {
      ...draft,
      ...edit,
      id: draft.id,
      qa: { ...draft.qa, ...edit.qa, generationId: draft.qa.generationId },
    };
  }

  async function runRequirementGeneration(requirement, snapshot, mode, user, job, current, cloudSettings) {
    const settings = structuredClone(store.settings);
    const { signal } = generationControllers.get(job.id);
    const useAgent = mode === 'agent' || (mode === 'ai' && settings.provider === 'reasonx');
    const useAi = mode === 'ai' || useAgent;
    const usableServers = () =>
      can(user, 'useMcp') ? settings.mcpServers.filter((server) => settings.aiMcpServerIds?.includes(server.id)) : [];

    const shouldInspect = (useAi && !useAgent) || requirement.inspectBeforeGeneration || cloudSettings;
    const inspection = shouldInspect
      ? await requirementInspector(snapshot, requirement.url, { signal })
      : { pages: [], warnings: [], context: { pages: [] } };
    current();
    job.stage = 'drafting';

    if (cloudSettings) {
      const options = { fetcher: aiFetcher, connections, servers: usableServers(), signal };
      return { inspection, draft: await generateCloudRequirementDraft(cloudSettings, requirement, inspection, options) };
    }
    if (mode === 'qwen') {
      return { inspection, draft: await generateQwenRequirementDraft(requirement, inspection, aiFetcher, { signal }) };
    }
    if (useAgent) {
      const draft = await runRequirementAgent({
        settings,
        requirement,
        inspection,
        fetcher: aiFetcher,
        connections,
        servers: usableServers(),
        signal,
        onStage: ({ stage, detail }) => {
          job.stage = stage;
          job.detail = detail;
        },
      });
      return { inspection, draft };
    }
    if (useAi) {
      return { inspection, draft: await generateRequirementDraft(settings, requirement, inspection, aiFetcher, { signal }) };
    }
    const metadata = metadataFromInspection(inspection, requirement.pageMetadata || {});
    const output = generateTestCases({
      requirement: requirement.description,
      moduleName: requirement.moduleName || requirement.title.slice(0, 120),
      pageMetadata: metadata.pageMetadata,
      ...(requirement.categories ? { categories: requirement.categories } : {}),
    });
    return {
      inspection,
      draft: {
        cases: generatedCasesToQa(output),
        summary: output.summary,
        warnings: [...(requirement.metadataWarnings || []), ...output.warnings, ...metadata.warnings],
      },
    };
  }

  async function generateRequirementCases(res, context) {
    const { previous, old, requirements, projectId, requirementId, user, current, commit } = context;
    check(old.description.trim(), 'Describe the workflow and expected outcomes before generating test cases.');
    const mode = old.generationMode;
    const cloudEngine = mode === 'claude' || mode === 'chatgpt' ? mode : null;
    const cloudSettings = cloudEngine ? engineSettings(store.settings, store.userAi[user.id], cloudEngine) : null;
    const useAgent = mode === 'agent' || (mode === 'ai' && store.settings.provider === 'reasonx');
    if (useAgent) requireAgentModel(store.settings);
    else if (mode === 'ai') requireGenerationModel(store.settings);
    if (authoring.has(projectId)) {
      await json(
        res,
        {
          error: 'Generation is already running for this project. Please wait.',
          userMessage: 'Test cases are already being generated for this project. Wait for that to finish, then try again.',
        },
        409,
      );
      return;
    }
    const job = startGeneration({
      projectId,
      kind: 'requirements',
      requirementId,
      model: cloudSettings?.model || store.settings.model,
      ...(cloudEngine ? { engine: cloudEngine } : { reasonxMode: store.settings.reasonxMode }),
    });
    try {
      await persist();
      const snapshot = structuredClone(previous);
      const requirement = { ...structuredClone(old), ...requirementFields(old) };
      const usesAi = cloudSettings || useAgent || mode === 'ai' || mode === 'qwen';
      const documents = usesAi
        ? documentContext(await readDocumentTexts(projectId), DOCUMENT_CONTEXT_LIMITS[useAgent ? 'agent' : mode === 'qwen' ? 'qwen' : 'cloud'])
        : { documents: [], clipped: [] };
      // A separate copy, because `requirement` is what gets saved and document text stays out of the project.
      const { inspection, draft } = await runRequirementGeneration(
        { ...requirement, projectDocuments: documents.documents },
        snapshot,
        mode,
        user,
        job,
        current,
        cloudSettings,
      );
      current();

      const linked = new Set(requirement.testIds || []);
      const pending = requirement.draftCases || [];
      const existing = [...snapshot.tests.filter((test) => linked.has(test.id)), ...pending];
      const existingNames = new Set(
        existing.filter((test) => !test.qa?.generationId).map((test) => test.name.trim().toLowerCase()),
      );
      const generatedIds = new Set(existing.map((test) => test.qa?.generationId).filter(Boolean));
      const added = draft.cases
        .map(identifyRequirementCase)
        .filter((test) => !generatedIds.has(test.qa.generationId) && !existingNames.has(test.name.trim().toLowerCase()));
      check(
        pending.length + added.length <= MAX_REQUIREMENT_DRAFTS,
        'A requirement can hold up to 1,000 drafts. Approve or remove drafts before generating more.',
      );
      checkpoint(generationControllers.get(job.id).signal);

      requirement.draftCases = [...pending, ...added];
      requirement.generation = {
        at: new Date().toISOString(),
        fingerprint: requirementFingerprint(requirement),
        summary: draft.summary,
        ...(draft.trace ? { agent: draft.trace } : {}),
        ...(draft.coverage ? { coverage: draft.coverage } : {}),
        warnings: [...new Set([...documentWarnings(documents), ...inspection.warnings, ...draft.warnings])].slice(0, MAX_GENERATION_WARNINGS),
        pages: inspection.pages.map((page) => ({
          url: page.url,
          title: page.title,
          status: page.status,
          controlCount: page.controls.length,
          links: inspectedNavigationLinks(page),
        })),
      };
      const saved = await commit({
        ...snapshot,
        requirements: requirements.map((item) => (item.id === requirementId ? requirement : item)),
      });
      Object.assign(job, { status: 'completed', finishedAt: new Date().toISOString() });
      await persist();
      await json(
        res,
        {
          project: projectForViewer(saved),
          requirement: saved.requirements.find((item) => item.id === requirementId),
          addedCount: added.length,
          pendingCount: requirement.draftCases.length,
          existingCount: draft.cases.length - added.length,
        },
        201,
      );
    } catch (error) {
      if (job.status === 'running') await failGeneration(job, error);
      throw error;
    } finally {
      authoring.delete(projectId);
      generationControllers.delete(job.id);
    }
  }

  async function approveRequirementDrafts(res, input, context) {
    const { previous, old, requirements, requirementId, commit } = context;
    const selected = input.draftIds;
    const pending = old.draftCases || [];
    const approvedIds = new Set(old.testIds || []);
    const requireApproval = (condition, message) => {
      if (!condition) throw Object.assign(new Error(message), { userMessage: message });
    };
    requireApproval(isValidIdSelection(selected), 'Choose at least one draft to approve, then try again.');
    requireApproval(
      selected.every((id) => pending.some((item) => item.id === id) || approvedIds.has(id)),
      'Some selected drafts are no longer available. Refresh the Requirement page and try again.',
    );
    const edits = input.editedDrafts === undefined ? [] : input.editedDrafts;
    const isValidEdit = (item) =>
      item &&
      typeof item === 'object' &&
      !Array.isArray(item) &&
      selected.includes(item.id) &&
      pending.some((draft) => draft.id === item.id) &&
      (item.qa === undefined || (item.qa && typeof item.qa === 'object' && !Array.isArray(item.qa)));
    requireApproval(
      Array.isArray(edits) &&
        edits.length <= selected.length &&
        edits.every(isValidEdit) &&
        new Set(edits.map((item) => item.id)).size === edits.length,
      'The reviewed changes could not be matched to the selected drafts. Refresh the Requirement page and review the cases again.',
    );
    const merged = edits.map((item) => mergeDraftEdit(pending.find((draft) => draft.id === item.id), item));
    const reviewed = new Map(normalizeRequirementDrafts(merged, pending).map((item) => [item.id, item]));
    const added = pending.filter((item) => selected.includes(item.id)).map((item) => reviewed.get(item.id) || item);
    requireApproval(
      previous.tests.length + added.length <= MAX_PROJECT_TESTS,
      'This project has reached its limit of 1,000 test cases. Create another project before approving more drafts.',
    );
    if (!added.length) {
      await json(res, { project: projectForViewer(previous), requirement: old, approvedCount: 0 });
      return;
    }
    const hasId = (items, id) => items.some((item) => item.id === id);
    const accepted = added.map((item) => ({
      ...item,
      inTestPlan: false,
      folderId: hasId(previous.folders, item.folderId) ? item.folderId : null,
      suiteId: hasId(previous.suites, item.suiteId) ? item.suiteId : null,
      prerequisiteId: hasId(previous.prerequisites, item.prerequisiteId) ? item.prerequisiteId : null,
    }));
    const updated = {
      ...old,
      draftCases: pending.filter((item) => !selected.includes(item.id)),
      testIds: [...approvedIds, ...added.map((item) => item.id)],
    };
    const saved = await commit({
      ...previous,
      tests: [...previous.tests, ...accepted],
      requirements: requirements.map((item) => (item.id === requirementId ? updated : item)),
    });
    await json(res, {
      project: projectForViewer(saved),
      requirement: saved.requirements.find((item) => item.id === requirementId),
      approvedCount: added.length,
    });
  }

  async function changeRequirementDrafts(req, res, input, context, draftId) {
    const { previous, old, requirements, requirementId, commit } = context;
    const pending = old.draftCases || [];
    const scope = requestScope.getStore();
    const saveDrafts = (draftCases) =>
      commit({
        ...previous,
        requirements: requirements.map((item) => (item.id === requirementId ? { ...old, draftCases } : item)),
      });
    const respond = (saved, extra = {}) =>
      json(res, {
        project: projectForViewer(saved),
        requirement: saved.requirements.find((item) => item.id === requirementId),
        ...extra,
      });

    if (!draftId) {
      const selected = input.draftIds;
      if (!isValidIdSelection(selected)) {
        const message = 'Choose at least one draft to delete, then try again.';
        await json(res, { error: 'Choose at least one draft to delete.', userMessage: message }, 400);
        return;
      }
      if (!selected.every((id) => pending.some((item) => item.id === id))) {
        const userMessage = 'Some selected drafts are no longer available. Refresh the Requirement page and try again.';
        await json(res, { error: 'Draft not found.', userMessage }, 404);
        return;
      }
      scope.action = 'Requirement drafts deleted';
      const saved = await saveDrafts(pending.filter((item) => !selected.includes(item.id)));
      await respond(saved, { deletedCount: selected.length });
      return;
    }

    const draft = pending.find((item) => item.id === draftId);
    if (!draft) {
      const userMessage = 'This draft is no longer available. Refresh the Requirement page and choose a draft again.';
      await json(res, { error: 'Draft not found.', userMessage }, 404);
      return;
    }
    if (req.method === 'DELETE') {
      scope.action = 'Requirement draft deleted';
      await respond(await saveDrafts(pending.filter((item) => item.id !== draftId)));
      return;
    }
    const [edited] = normalizeRequirementDrafts([mergeDraftEdit(draft, input)], [draft]);
    await respond(await saveDrafts(pending.map((item) => (item.id === draftId ? edited : item))));
  }

  // ---- Project documents ------------------------------------------------------

  const documentsDir = path.join(dataDir, 'project-documents');
  const documentPath = (id, part) => path.join(documentsDir, `${id}.${part}.json`);

  async function readDocumentPart(id, part, key) {
    return vault.decode(JSON.parse(await readFile(documentPath(id, part), 'utf8')))[key];
  }

  async function readDocumentTexts(projectId) {
    const saved = (store.projectDocuments[projectId] || []).filter((item) => item.readable);
    return Promise.all(
      saved.map(async (item) => ({
        name: item.name,
        // A document deleted while generation starts is simply left out.
        text: await readDocumentPart(item.id, 'text', 'documentText').catch(() => ''),
      })),
    );
  }

  async function readDocumentUpload(req) {
    let name = null;
    try {
      name = documentName(decodeURIComponent(req.headers['x-file-name'] || ''));
    } catch {
      // A malformed name is rejected below, like any other invalid file name.
    }
    check(name, DOCUMENT_TYPE_MESSAGE);
    let received = 0;
    const chunks = [];
    for await (const chunk of req) {
      received += chunk.length;
      if (received > MAX_DOCUMENT_BYTES) throw httpError(DOCUMENT_SIZE_MESSAGE, 413);
      chunks.push(chunk);
    }
    const data = Buffer.concat(chunks);
    const problem = checkDocumentContent(name, data);
    check(!problem, problem);
    return { name, data };
  }

  function documentUploadProblem(projectId, name) {
    const saved = store.projectDocuments[projectId] || [];
    if (saved.length >= MAX_PROJECT_DOCUMENTS) {
      return `A project can hold up to ${MAX_PROJECT_DOCUMENTS} documents. Delete one before adding another.`;
    }
    const isDuplicate = saved.some((item) => item.name.toLowerCase() === name?.toLowerCase());
    return isDuplicate ? `${name} is already uploaded. Delete it before uploading a new copy.` : null;
  }

  async function uploadDocument(req, res, projectId, user) {
    const full = documentUploadProblem(projectId);
    check(!full, full);
    const { name, data } = await readDocumentUpload(req);
    const early = documentUploadProblem(projectId, name);
    check(!early, early);
    const text = await extractDocumentText(name, data);
    const id = randomUUID();
    await mkdir(documentsDir, { recursive: true });
    await writeFile(documentPath(id, 'text'), JSON.stringify(vault.encode({ documentText: text })), { flag: 'wx' });
    const file = { name, content: data.toString('base64') };
    await writeFile(documentPath(id, 'file'), JSON.stringify(vault.encode({ documentFile: file })), { flag: 'wx' });

    // Checked again because another upload can finish while this one is being read and saved.
    const late = documentUploadProblem(projectId, name);
    if (late) {
      await Promise.all(['text', 'file'].map((part) => rm(documentPath(id, part), { force: true })));
      check(false, late);
    }
    const document = {
      id,
      name,
      size: data.length,
      readable: Boolean(text),
      uploadedAt: new Date().toISOString(),
      uploadedBy: user.name || user.username,
    };
    store.projectDocuments[projectId] = [...(store.projectDocuments[projectId] || []), document];
    await persist();
    await json(res, { document, documents: store.projectDocuments[projectId] }, 201);
  }

  async function documentRoutes(req, res, route, url, user) {
    const match = route.match(DOCUMENT_ROUTE);
    if (!match) return false;
    const [, projectId, documentId, part] = match;
    findProject(projectId);
    if (!can(auth.find(user.id), 'qa')) throw httpError('QA Studio access is required.', 403);
    const documents = store.projectDocuments[projectId] || [];
    const document = documents.find((item) => item.id === documentId);
    if (documentId && !document) throw httpError('This document is no longer available. Reopen Related Document to see the current list.', 404);

    if (!documentId && req.method === 'GET') {
      await json(res, { documents });
    } else if (!documentId && req.method === 'POST') {
      await uploadDocument(req, res, projectId, user);
    } else if (documentId && !part && req.method === 'GET') {
      await json(res, { document, text: await readDocumentPart(document.id, 'text', 'documentText'), inline: canPreviewInline(document.name) });
    } else if (part && req.method === 'GET') {
      const file = await readDocumentPart(document.id, 'file', 'documentFile');
      const inline = canPreviewInline(document.name) && url.searchParams.get('download') !== '1';
      res.writeHead(200, {
        'Content-Type': documentType(document.name),
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(document.name)}`,
      });
      res.end(Buffer.from(file.content, 'base64'));
    } else if (documentId && !part && req.method === 'DELETE') {
      store.projectDocuments[projectId] = documents.filter((item) => item.id !== documentId);
      await persist();
      await Promise.all(['text', 'file'].map((name) => rm(documentPath(documentId, name), { force: true })));
      await json(res, { documents: store.projectDocuments[projectId] });
    } else {
      await json(res, { error: 'Unsupported document operation.' }, 405);
    }
    return true;
  }

  async function requirementRoutes(req, res, route, url, user) {
    const match = route.match(REQUIREMENT_ROUTE);
    if (!match) return false;
    const [, projectId, requirementId, operation, itemId, stepOperation] = match;
    const previous = findProject(projectId);
    const requirements = previous.requirements || [];
    const old = requirements.find((item) => item.id === requirementId);
    if (requirementId && !old) {
      const userMessage = 'This requirement is no longer available. Return to the Requirement list and select another requirement.';
      await json(res, { error: 'Requirement not found.', userMessage }, 404);
      return true;
    }
    if (req.method === 'GET' && !operation) {
      await json(res, old || { requirements });
      return true;
    }
    if (!isSupportedRequirementRequest(req.method, requirementId, operation, itemId, stepOperation)) {
      await json(res, { error: 'Unsupported requirement operation.' }, 405);
      return true;
    }

    const input = await readBody(req);
    const current = () => {
      if (!can(auth.find(user.id), 'qa')) throw httpError('QA Studio access is required.', 403);
      const project = findProject(projectId);
      if (project.revision !== input.revision) {
        throw httpError('This project changed. Reload the requirement and try again. Your existing cases have been kept.', 409, {
          code: 'EDIT_CONFLICT',
        });
      }
      return project;
    };
    current();

    if (operation === 'cases') {
      const testCase =
        (old.draftCases || []).find((item) => item.id === itemId) ||
        ((old.testIds || []).includes(itemId) && previous.tests.find((item) => item.id === itemId));
      if (!testCase) {
        const userMessage = 'This case is no longer available in the requirement. Refresh the page and select it again.';
        await json(res, { error: 'Requirement case not found.', userMessage }, 404);
        return true;
      }
      const workflow = input.workflow ?? testCase.qa?.workflowDetails ?? '';
      const output = generateRequirementTestSteps({ ...old, ...requirementFields(old) }, testCase, workflow);
      current();
      requestScope.getStore().action = 'Test steps generated for review';
      await json(res, { ...output, revision: previous.revision });
      return true;
    }

    const commit = async (raw) => {
      await backup();
      current();
      const counter = { nextTestNumber: store.nextTestNumber };
      const next = normalizeProject(raw, previous, counter);
      store.projects[store.projects.indexOf(previous)] = next;
      store.nextTestNumber = counter.nextTestNumber;
      await persist();
      return next;
    };
    const context = { previous, old, requirements, projectId, requirementId, user, current, commit };

    if (operation === 'drafts') {
      await changeRequirementDrafts(req, res, input, context, itemId);
      return true;
    }
    if (operation === 'approve') {
      await approveRequirementDrafts(res, input, context);
      return true;
    }
    if (operation === 'generate') {
      await generateRequirementCases(res, context);
      return true;
    }

    let requirement = null;
    let nextRequirements = requirements.filter((item) => item.id !== requirementId);
    if (req.method !== 'DELETE') {
      const base = old || { id: randomUUID(), testIds: [] };
      requirement = { ...base, ...requirementFields({ ...old, ...input }) };
      nextRequirements = old
        ? requirements.map((item) => (item.id === requirementId ? requirement : item))
        : [...requirements, requirement];
    }
    const saved = await commit({ ...previous, requirements: nextRequirements });
    await json(
      res,
      {
        project: projectForViewer(saved),
        requirement: requirement ? saved.requirements.find((item) => item.id === requirement.id) : null,
      },
      old ? 200 : 201,
    );
    return true;
  }

  // ---- Jira and VPN --------------------------------------------------------------

  function markBugTrackerDisconnected(revision) {
    if (store.bugTracker?.revision !== revision) return;
    store.bugTracker.connected = false;
    store.bugTracker.verifiedAt = null;
  }

  async function reportIssue(res, input) {
    const project = findProject(input.projectId);
    check(project.tests.some((test) => test.id === input.testId), 'Test case not found.');
    const issueRunId = input.runId ? issueRun(project, findCase(project, input.testId), input.runId).id : null;
    const validRequestId = typeof input.requestId === 'string' && /^[a-f0-9-]{36}$/i.test(input.requestId);
    check(validRequestId, 'Issue request ID is required.');
    const previous = store.issueReports.find((issue) => issue.requestId === input.requestId);
    if (previous) {
      const isSameCase = previous.projectId === input.projectId && previous.testId === input.testId;
      check(isSameCase, 'Issue request belongs to a different test case.');
      if (previous.status === 'created') {
        await json(res, previous);
        return;
      }
      if (previous.status !== 'rejected') {
        const error = 'This issue request is pending or was not confirmed. Check Jira before submitting a new report.';
        await json(res, { error }, 409);
        return;
      }
    }
    const draft = issueDraft(input);
    const config = structuredClone(store.bugTracker);
    check(config?.connected, 'Connect Jira successfully in Settings before reporting an issue.');
    const entry = previous || { requestId: input.requestId, projectId: project.id, testId: input.testId };
    Object.assign(entry, { status: 'pending', summary: draft.summary, runId: issueRunId });
    if (!previous) store.issueReports.push(entry);
    await persist();
    try {
      const issue = await createJiraIssue(config, draft, bugTrackerFetcher);
      Object.assign(entry, issue, { status: 'created' });
      await persist();
      await json(res, entry, 201);
    } catch (error) {
      // An uncertain outcome stays blocked, so a retry cannot create a duplicate issue.
      if (entry.status !== 'created') entry.status = error.uncertain ? 'unknown' : 'rejected';
      if (error.authFailed) markBugTrackerDisconnected(config.revision);
      await persist();
      throw error;
    }
  }

  const findCase = (project, id) =>
    project.tests.find((test) => test.id === id || test.automation?.id === id);

  function issueRun(project, testCase, runId) {
    if (runId) {
      const run = findRun(runId);
      check(run.projectId === project.id && caseRun(run, testCase.id), 'This test case is not part of the run.');
      return run;
    }
    return store.runs
      .filter((run) => run.projectId === project.id && caseRun(run, testCase.id))
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0];
  }

  async function evidenceWithSizes(run, testId) {
    const items = await Promise.all(
      collectEvidence(runForViewer(run), testId).map(async (item) => {
        const size = (await stat(path.join(artifactsDir, item.file)).catch(() => null))?.size;
        return size === undefined ? null : { ...item, size };
      }),
    );
    const report = await reportHtml(caseRun(runForViewer(run), testId), artifactsDir);
    items.push({
      id: REPORT_EVIDENCE_ID,
      name: `run-report-${run.id}.html`,
      label: 'HTML run report',
      size: Buffer.byteLength(report),
      checked: false,
    });
    return items.filter(Boolean).map(({ file, ...item }) => ({ ...item, tooLarge: item.size > MAX_ATTACHMENT_BYTES }));
  }

  async function sendIssueDraft(res, url) {
    const project = findProject(url.searchParams.get('projectId'));
    const testCase = findCase(project, url.searchParams.get('testId'));
    check(testCase, 'Test case not found.');
    const run = issueRun(project, testCase, url.searchParams.get('runId'));
    await json(res, {
      testId: testCase.id,
      runId: run?.id || null,
      draft: buildIssueDraft({
        project,
        testCase,
        run: run && runForViewer(run),
        userName: currentUser()?.name || currentUser()?.username || currentUser()?.email,
      }),
      evidence: run ? await evidenceWithSizes(run, testCase.id) : [],
      maxAttachmentBytes: MAX_ATTACHMENT_BYTES,
      existing: store.issueReports.filter(
        (issue) => issue.status === 'created' && issue.projectId === project.id && issue.testId === testCase.id,
      ),
    });
  }

  async function readAttachmentFile(req) {
    let name = null;
    try {
      name = attachmentName(decodeURIComponent(req.headers['x-file-name'] || ''));
    } catch {
      // A malformed name is rejected below, like any other invalid file name.
    }
    check(name, 'This file type cannot be attached. Use images, video, logs, PDF or zip.');
    let received = 0;
    const chunks = [];
    for await (const chunk of req) {
      received += chunk.length;
      if (received > MAX_ATTACHMENT_BYTES) throw httpError('Attachments can be up to 10 MB each.', 413);
      chunks.push(chunk);
    }
    return { name, data: Buffer.concat(chunks) };
  }

  async function readEvidenceFile(entry, evidenceId) {
    const run = findRun(entry.runId);
    if (evidenceId === REPORT_EVIDENCE_ID) {
      const html = await reportHtml(caseRun(runForViewer(run), entry.testId), artifactsDir);
      return { name: `run-report-${run.id}.html`, data: Buffer.from(html) };
    }
    const item = collectEvidence(runForViewer(run), entry.testId).find((candidate) => candidate.id === evidenceId);
    check(item, 'This file is not part of the run.');
    const data = await readFile(path.join(artifactsDir, item.file));
    return { name: item.name, data };
  }

  async function attachToIssue(req, res, requestId) {
    const entry = store.issueReports.find((issue) => issue.requestId === requestId);
    if (!isVisible(entry) || entry.status !== 'created') throw httpError('Issue not found', 404);
    const config = structuredClone(store.bugTracker);
    check(config?.connected && entry.url?.startsWith(`${config.siteUrl}/`), 'Connect this Jira site in Settings before adding attachments.');
    const isRawFile = (req.headers['content-type'] || '').startsWith('application/octet-stream');
    const file = isRawFile ? await readAttachmentFile(req) : await readEvidenceFile(entry, (await readBody(req)).evidenceId);
    if (file.data.length > MAX_ATTACHMENT_BYTES) throw httpError('Attachments can be up to 10 MB each.', 413);
    entry.attachments ||= [];
    // A retry after a partial failure must not attach the same file twice.
    if (!entry.attachments.includes(file.name)) {
      await uploadJiraAttachment(config, entry.key, file, bugTrackerFetcher);
      entry.attachments.push(file.name);
      await persist();
    }
    await json(res, { name: file.name, attachments: entry.attachments });
  }

  async function bugTrackerRoutes(req, res, route, url) {
    if (route === '/api/issues/draft' && req.method === 'GET') {
      await sendIssueDraft(res, url);
      return true;
    }
    if (route === '/api/issues/options' && req.method === 'GET') {
      await json(res, await jiraIssueOptions(store.bugTracker, url.searchParams.get('issueTypeId'), bugTrackerFetcher));
      return true;
    }
    const attachmentRoute = route.match(/^\/api\/issues\/([a-f0-9-]{36})\/attachments$/i);
    if (attachmentRoute && req.method === 'POST') {
      await attachToIssue(req, res, attachmentRoute[1]);
      return true;
    }
    if (route === '/api/bug-tracker' && req.method === 'GET') {
      await json(res, publicBugTracker(store.bugTracker));
      return true;
    }
    if (route === '/api/bug-tracker' && req.method === 'PUT') {
      store.bugTracker = normalizeBugTracker(await readBody(req), store.bugTracker);
      await persist();
      await json(res, publicBugTracker(store.bugTracker));
      return true;
    }
    if (route === '/api/bug-tracker' && req.method === 'DELETE') {
      await readBody(req);
      delete store.bugTracker;
      await persist();
      await json(res, publicBugTracker());
      return true;
    }
    if (route === '/api/bug-tracker/connect' && req.method === 'POST') {
      await readBody(req);
      const config = structuredClone(store.bugTracker);
      check(config, 'Save a Jira configuration first.');
      try {
        const verified = await verifyBugTracker(config, bugTrackerFetcher);
        check(
          store.bugTracker?.revision === config.revision,
          'Configuration changed during verification. Test the connection again.',
        );
        store.bugTracker = verified;
        await persist();
        await json(res, publicBugTracker(verified));
      } catch (error) {
        if (store.bugTracker?.revision === config.revision) {
          markBugTrackerDisconnected(config.revision);
          await persist();
        }
        throw error;
      }
      return true;
    }
    if (route === '/api/issues' && req.method === 'POST') {
      await reportIssue(res, await readBody(req));
      return true;
    }
    return false;
  }

  const vpnStatus = async () => ({ ...(await vpn.status()), profileId: store.vpn?.profileId || null });

  async function vpnRoutes(req, res, route) {
    if (route === '/api/vpn' && req.method === 'GET') {
      await json(res, await vpnStatus());
      return true;
    }
    if (route === '/api/vpn/profiles' && req.method === 'POST') {
      await readBody(req);
      await json(res, { profiles: await vpn.profiles() });
      return true;
    }
    if (route === '/api/vpn' && req.method === 'PUT') {
      const input = await readBody(req);
      check(input.profileId === null || typeof input.profileId === 'string', 'Select an OpenVPN profile');
      if (input.profileId !== null) {
        const profiles = await vpn.profiles();
        const isKnown = profiles.some((profile) => profile.id === input.profileId);
        check(isKnown, 'The selected OpenVPN profile was not found. Refresh profiles.');
      }
      store.vpn = { profileId: input.profileId };
      await persist();
      await json(res, await vpnStatus());
      return true;
    }
    if ((route === '/api/vpn/connect' || route === '/api/vpn/disconnect') && req.method === 'POST') {
      await readBody(req);
      const isBusy = activeRun || debugSessions.size || startingBrowser || recordingLive();
      check(!isBusy, 'Finish the active run, debug session, or recording before changing the VPN.');
      await vpn.action(route.endsWith('/disconnect') ? 'disconnect' : 'connect', store.vpn?.profileId);
      await json(res, await vpnStatus());
      return true;
    }
    return false;
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
      const isBusy = vpn.busy || recording || startingBrowser || activeRun || debugSessions.size;
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
    const isBusy =
      closing || schedulerWork || activeRun || recordingLive() || debugSessions.size || startingBrowser || vpn.busy;
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
    check(url.searchParams.get('projectId'), 'projectId is required.');
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
    shutdownRoute,
    adminProjectRoutes,
    adminUserRoutes,
    manualRunRoutes,
    backupRoutes,
    workspaceRoutes,
    dataRoutes,
    runRoutes,
    documentRoutes,
    requirementRoutes,
    bugTrackerRoutes,
    vpnRoutes,
    settingsRoutes,
    mcpRoutes,
    aiRoutes,
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
    if (publicSite) {
      hosts.push(publicSite.host);
      origins.push(publicSite.origin);
    }
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
        res.setHeader('Set-Cookie', sessionCookie(''));
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
        if (error.issues) body.issues = error.issues;
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
        server.listen(port, host, () => {
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
      for (const controller of generationControllers.values()) controller.abort();
      clearInterval(scheduleTimer);
      await schedulerWork;
      await recording?.stop();
      runController?.abort();
      await execution;
      await Promise.allSettled([...debugSessions.values()].map((session) => session.close()));
      debugSessions.clear();
      await connections.close();
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
  const FORCED_EXIT_MS = 8000;
  let studio;
  let isStopping = false;
  const shutdown = async () => {
    if (isStopping) return;
    isStopping = true;
    setTimeout(() => process.exit(1), FORCED_EXIT_MS).unref();
    await studio.close();
    process.exit(0);
  };
  studio = await createStudio({ onShutdown: shutdown });
  await studio.listen();
  console.log(`QA Studio: ${process.env.STUDIO_PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://127.0.0.1:${studio.server.address().port}`}`);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
