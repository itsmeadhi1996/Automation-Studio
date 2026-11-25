/* Automation Studio workspace. All interpolated user content is escaped before rendering.
   Classic script: automation-cases.js and local-data.js share this global scope. */

/* ---------- Constants ---------- */

const ACTION_LABELS = {
  navigate: 'Navigate',
  url: 'Assert URL',
  click: 'Click',
  hover: 'Hover',
  doubleClick: 'Double click',
  pressKey: 'Press key',
  uploadFile: 'Upload file',
  fill: 'Fill input',
  select: 'Select option',
  check: 'Check',
  uncheck: 'Uncheck',
  dateOnly: 'Set date',
  dateTime: 'Set date & time',
  visible: 'Assert visible',
  text: 'Assert text',
  value: 'Assert value',
  hidden: 'Assert hidden',
  heading: 'Assert heading',
  uiValidate: 'Validate UI',
  wait: 'Wait',
  screenshot: 'Screenshot',
  jdbcQuery: 'Database query',
  dbValidate: 'Validate database',
};
const LOCATOR_LABELS = {
  css: 'CSS selector',
  xpath: 'XPath',
  id: 'Element ID',
  name: 'Name',
  text: 'Exact text',
  label: 'Label',
  placeholder: 'Placeholder',
  testId: 'Test ID',
  custom: 'Custom',
  object: 'Repository object',
};
const VALUE_SOURCES = [
  { id: 'static', name: 'Static value' },
  { id: 'global', name: 'Global variable' },
  { id: 'environment', name: 'Environment' },
  { id: 'data', name: 'Data row' },
  { id: 'local', name: 'Local Test Data' },
];
const NO_TARGET_ACTIONS = new Set(['navigate', 'url', 'wait', 'screenshot', 'heading', 'jdbcQuery', 'dbValidate']);
const NO_VALUE_ACTIONS = new Set(['click', 'hover', 'doubleClick', 'check', 'uncheck', 'visible', 'hidden', 'screenshot']);
const WAITING_ACTIONS = new Set([
  'navigate',
  'click',
  'hover',
  'doubleClick',
  'pressKey',
  'uploadFile',
  'fill',
  'dateOnly',
  'dateTime',
  'select',
  'check',
  'uncheck',
]);
const WAIT_POLICIES = [
  { id: 'auto', name: 'Automatically wait for page activity' },
  { id: 'redirect', name: 'Wait for redirect' },
  { id: 'none', name: 'Continue without an extra wait' },
];
const BADGE_KINDS = ['passed', 'failed', 'running', 'skipped', 'interrupted'];
const VIEW_NAMES = {
  'local-data': 'Local Test Data',
  cases: 'Test cases',
  suites: 'Test suites',
  history: 'Run history',
  execution: 'TC Execution overview',
  vpn: 'OpenVPN',
  recording: 'Web recorder',
  debug: 'Debug',
  objects: 'Object repository',
  variables: 'Environments & globals',
  database: 'PostgreSQL',
  settings: 'Settings & connections',
  mcp: 'MCP servers',
  prerequisites: 'Prequenties',
  processes: 'Process automation',
};
const VIEWS_WITHOUT_TABS = ['prerequisites', 'processes', 'objects', 'database', 'variables', 'mcp'];
const MAX_PROCESS_RUNS = 1000;
const LINKABLE_VIEWS = ['cases', 'editor', 'suites', 'history', 'execution', 'ai', 'settings', 'mcp'];
const SETTINGS_VIEWS = ['settings', 'ai', 'mcp'];
const URL_TRACKED_VIEWS = ['ai', 'execution', 'cases'];
// Removed from the address when the project changes, because they describe the previous project.
const PROJECT_URL_PARAMS = [
  'testId',
  'testIds',
  'suiteId',
  'prerequisiteId',
  'offset',
  'limit',
  'from',
  'to',
  'testName',
  'status',
  'suiteName',
  'execution-from',
  'execution-to',
  'execution-search',
  'execution-status',
  'execution-suite',
  'execution-mode',
];
const STEP_PAGE_SIZES = ['10', '25', '50', '100'];
const MAX_EDITOR_STEPS = 100;
const MAX_RECORDED_STEPS = 1000;
const MAX_PROMPT_LENGTH = 12000;
const COPY_NAME_LENGTH = 105;
const POLL_MS = 1500;
const RECORDING_POLL_MS = 400;
const CASE_HISTORY_LIMIT = 50;
const REASONX_BASE_URL = 'http://127.0.0.1:8080/v1';
const RESTART_REPLAY_MESSAGE = 'Restart QA Studio using Start QA Studio.cmd to enable visible slow-motion Replay.';
const CONNECTED_TEXT = '● Connected to local workspace';
const DISCONNECTED_TEXT = '○ Local server unavailable';
const PROVIDERS = {
  google: {
    short: 'Gemini',
    title: 'Google AI Studio · Gemini',
    keyLabel: 'Google AI Studio API key',
    keyPlaceholder: 'Paste your Gemini API key',
    defaultModel: 'gemini-3.8-flash',
  },
  openai: {
    short: 'OpenAI',
    title: 'OpenAI',
    keyLabel: 'OpenAI API key',
    keyPlaceholder: 'sk-…',
    defaultModel: 'gpt-4.1-mini',
  },
  groq: {
    short: 'Groq',
    title: 'Groq',
    keyLabel: 'Groq API key',
    keyPlaceholder: 'gsk_…',
    defaultModel: 'openai/gpt-oss-20b',
  },
  nvidia: {
    short: 'NVIDIA',
    title: 'NVIDIA API Catalog',
    keyLabel: 'NVIDIA API key',
    keyPlaceholder: 'nvapi-…',
    defaultModel: 'meta/muse-glimmer-30b',
  },
  reasonx: {
    short: 'ReasonX',
    title: 'ReasonX - Local model',
    keyLabel: 'ReasonX API key',
    keyPlaceholder: 'rx_…',
    defaultModel: 'reasonx-v1',
  },
};
const PROVIDER_CHOICES = [
  { id: 'google', name: 'Google AI Studio · Gemini free tier' },
  { id: 'openai', name: 'OpenAI' },
  { id: 'groq', name: 'Groq' },
  { id: 'nvidia', name: 'NVIDIA API Catalog' },
  { id: 'reasonx', name: 'ReasonX - Local model' },
];
// Used until the server's settings load, and whenever they cannot be loaded.
const UNLOADED_SETTINGS = Object.freeze({
  provider: 'google',
  model: '',
  hasApiKey: false,
  mcpServers: [],
  mcpCatalog: [],
  aiMcpServerIds: [],
  bugTracker: {},
  userAi: {},
});

/* ---------- Workspace state ---------- */

let state;
let project;
let settings = UNLOADED_SETTINGS;
let settingsStatus = 'idle';
let settingsError = '';
let historyTools;
let selectedId;
let selectedKind = 'tests';
let view = 'editor';
let dirty = false;
let revision = 0;
let saving = null;
let modalHandler;
let activeFolderId = null;
let lastRunSignature = '';
let startingDebug = false;
let stoppingDebug = false;
let steppingDebug = false;
let editorPage = 0;
let editorSize = 10;
let editorKey;
let dragStep;
let recordMappingBusy = false;
const historyCache = new Map();
const openRequirements = new Set();
const openRepositoryCases = new Set();

/* AI Assistance */
let aiPrompt = '';
let aiTargetId = null;
// Index of the first step Auto generator replaces; earlier steps are kept. 0 replaces every step.
let aiRegenerateFrom = 0;
let aiEngine = null;
let aiStatus = null;
let aiStatusBusy = false;
let aiBillingBlocked = false;
let aiQuotaBlocked = false;
let aiMissingRouteError = '';
let aiMcpIds = new Set();
let generating = false;
let generateStarted = 0;
let generateTimer = null;
let draft = null;
let draftProjectId = null;
let reasonxStarting = false;
const mcpTools = new Map();
const pendingGenerations = new Map();
const recoveredGenerations = new Set();

/* OpenVPN and Jira */
let vpnState = null;
let vpnProfiles = [];
let vpnLoading = false;
let vpnError = '';
let bugTrackerBusy = false;
let bugTrackerMessage = '';

/* ---------- Small helpers ---------- */

const $ = (selector) => document.querySelector(selector);
const uid = () => crypto.randomUUID();
const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );
const tc = (test) => (test.tcNumber ? `TC-${String(test.tcNumber).padStart(4, '0')}` : 'NEW');
const pad2 = (number) => String(number).padStart(2, '0');
const notify = (message, isError = false) => StudioUI.notify(message, isError);
const selected = () => project?.[selectedKind].find((item) => item.id === selectedId);
const projectRuns = () => state.runs.filter((run) => run.projectId === project.id);
const isAdmin = () => globalThis.StudioAuth?.user?.role === 'admin';
const providerInfo = (provider = settings.provider) => PROVIDERS[provider] || PROVIDERS.openai;
const isMissingRoute = (error) => error.status === 404 && error.message === 'Not found';
// A stopped recording only awaits review. It holds no browser, so it never blocks execution.
const recordingLive = () => Boolean(state?.activeRecording && state.activeRecording.status !== 'stopped');
const debugUnavailable = () =>
  Boolean(startingDebug || stoppingDebug || state?.activeDebug || state?.activeRun || recordingLive());
const needsAutoGenerator = (test) =>
  Boolean(test?.qa?.manualSteps?.length && (!test.steps.length || test.automationNeedsUpdate));

function badge(status = 'not run') {
  const kind = BADGE_KINDS.includes(status) ? status : 'neutral';
  const glyph = status === 'passed' ? '✓' : status === 'running' ? '◌' : '○';
  return `<span class="badge ${kind}">${glyph} ${esc(status)}</span>`;
}

function options(items, value, emptyLabel) {
  const blank = emptyLabel === undefined ? '' : `<option value="">${esc(emptyLabel)}</option>`;
  const rows = items.map((item) => {
    const id = typeof item === 'string' ? item : item.id;
    const name = typeof item === 'string' ? item : item.name;
    return `<option value="${esc(id)}" ${id === value ? 'selected' : ''}>${esc(name)}</option>`;
  });
  return blank + rows.join('');
}

function field(name, label, value = '', type = 'text', extra = '') {
  return `<label>${esc(label)}<input name="${esc(name)}" type="${type}" value="${esc(value)}" ${extra}></label>`;
}

function jsonField(name, label, value) {
  return `<label>${esc(label)}<textarea name="${name}" spellcheck="false">${esc(JSON.stringify(value, null, 2))}</textarea></label>`;
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
}

function heading(eyebrow, title, subtitle, actions = '') {
  return `
    <div class="page-heading">
      <div>
        <p class="eyebrow">${esc(eyebrow)}</p>
        <h1>${esc(title)}</h1>
        <p class="subtitle">${esc(subtitle)}</p>
      </div>
      <div class="inline-actions">${actions}</div>
    </div>`;
}

function empty(title, message, action = '') {
  return `
    <div class="panel empty-state">
      <span class="empty-icon">▤</span>
      <h2>${esc(title)}</h2>
      <p>${esc(message)}</p>
      ${action}
    </div>`;
}

function modal(title, html, handler, submitLabel = 'Save') {
  $('#dialog').classList.remove('issue-dialog');
  $('#dialog-title').textContent = title;
  $('#dialog-body').innerHTML = html;
  $('#dialog-submit').textContent = submitLabel;
  modalHandler = handler;
  $('#dialog').showModal();
}

function caseObjects() {
  const test = selectedKind === 'tests' && selected();
  if (!test) return [];
  const owner = StudioLocators.caseId(test);
  return project.objects.filter((object) => object.testCaseId === owner);
}

function fileArtifactUrl(file) {
  return `/artifacts/${encodeURIComponent(file)}`;
}

function downloadJson(fileName, value) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------- Server access ---------- */

async function api(route, method = 'GET', body) {
  const url = route === '/api/state' ? `${route}?workspace=automation` : route;
  const isProjectSave = method === 'PUT' && /^\/api\/projects\/[\w-]+$/.test(route);
  const payload = isProjectSave ? { ...body, workspace: 'automation' } : body;
  const response = await StudioUI.request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error || 'Request failed');
    error.code = result.code;
    error.status = response.status;
    error.issues = result.issues;
    throw error;
  }
  return result;
}

function markDirty() {
  dirty = true;
  revision++;
  updateStatus();
}

function updateStatus() {
  const test = selected();
  const hasSteps = Boolean(test?.steps.length);
  const statusText = saving ? 'Saving…' : dirty ? 'Unsaved changes' : 'All changes saved';
  $('#save-status').innerHTML = `<i></i> ${statusText}`;
  $('#save-button').disabled = Boolean(saving);

  const runButton = $('#run-button');
  runButton.disabled = debugUnavailable() || !hasSteps || selectedKind !== 'tests';
  runButton.title = hasSteps ? 'Run test' : 'Configure automation steps before running';

  const sessionControls = '[data-action="debug-test"],[data-action="replay-test"],[data-action="schedule-test"]';
  document.querySelectorAll(sessionControls).forEach((button) => {
    button.disabled = debugUnavailable() || !hasSteps;
  });

  const stop = $('#stop-debug-button');
  stop.hidden = !startingDebug && !state?.activeDebug;
  stop.disabled = startingDebug || stoppingDebug;
  document.querySelectorAll('[data-action="debug-step"]').forEach((button) => {
    button.disabled = steppingDebug || stoppingDebug;
  });
}

async function save() {
  if (saving) {
    await saving;
    return dirty ? save() : undefined;
  }
  if (!dirty || !project) return undefined;
  if (project.folders.some((folder) => folder.parentId) && !state.features?.nestedFolders) {
    throw new Error('Restart QA Studio using Start QA Studio.cmd to save nested folders.');
  }

  const savedRevision = revision;
  saving = api(`/api/projects/${project.id}`, 'PUT', structuredClone(project));
  updateStatus();
  try {
    const saved = await saving;
    state.projects[state.projects.findIndex((item) => item.id === saved.id)] = saved;
    if (project?.id === saved.id) adoptSavedProject(saved, savedRevision);
  } finally {
    saving = null;
    updateStatus();
  }
  if (project) {
    renderExplorer();
    renderBreadcrumbs();
    refreshQaContext();
  }
  return undefined;
}

// Edits made during the request stay; only the server-assigned fields are adopted.
function adoptSavedProject(saved, savedRevision) {
  if (savedRevision === revision) {
    project = structuredClone(saved);
    dirty = false;
    return;
  }
  project.revision = saved.revision;
  for (const test of project.tests) {
    test.tcNumber = saved.tests.find((item) => item.id === test.id)?.tcNumber || test.tcNumber;
  }
}

async function refreshRuns() {
  historyCache.clear();
  const latest = await api('/api/status');
  state.runs = latest.runs;
  state.activeRun = latest.activeRun;
  state.activeDebug = latest.activeDebug;
  if (!recordMappingBusy) state.activeRecording = latest.activeRecording;
}

async function run(selector) {
  if (selector.replay && !state.features?.visibleReplay) throw new Error(RESTART_REPLAY_MESSAGE);
  await save();
  const result = await api('/api/runs', 'POST', { projectId: project.id, ...selector });
  state.activeRun = result.id;
  state.runs.unshift(result);
  historyCache.delete(historyKey());
  navigate('history');
  notify(selector.replay ? 'Replay started: visible browser, red highlights, and slow motion.' : 'Execution started');
}

/* ---------- Settings ---------- */

async function ensureSettings() {
  if (settingsStatus === 'loading' || settingsStatus === 'loaded') return;
  settingsStatus = 'loading';
  try {
    settings = await api('/api/settings');
    settingsStatus = 'loaded';
    settingsError = '';
    aiMcpIds = new Set(settings.aiMcpServerIds || []);
    void discoverSelectedMcp();
  } catch (error) {
    settingsStatus = 'failed';
    settingsError = error.message;
  }
  if (SETTINGS_VIEWS.includes(view) && state) render();
}

function settingsNotice() {
  if (settingsStatus !== 'failed') return '';
  return `<p class="notice error" role="alert">Could not load settings from the server: ${esc(settingsError)}. The controls below stay unavailable until the server provides them.</p>`;
}

async function saveMcpServers(mcpServers) {
  settings = await api('/api/mcp/servers', 'PUT', { mcpServers });
  mcpTools.clear();
  aiMcpIds = new Set(settings.aiMcpServerIds || []);
  render();
}

async function saveSettings(next) {
  const previousServers = JSON.stringify(settings.mcpServers);
  settings = await api('/api/settings', 'PUT', next);
  settingsStatus = 'loaded';
  settingsError = '';
  if (JSON.stringify(settings.mcpServers) !== previousServers) mcpTools.clear();
  aiMcpIds = new Set(settings.aiMcpServerIds || []);
  render();
}

async function discoverSelectedMcp() {
  if (!globalThis.StudioAuth?.allowed('useMcp')) return;
  const failed = [];
  await Promise.all(
    (settings.aiMcpServerIds || []).map(async (id) => {
      try {
        const result = await api(`/api/mcp/${id}/tools`, 'POST', {});
        mcpTools.set(id, result.tools);
      } catch {
        failed.push(settings.mcpServers.find((server) => server.id === id)?.name || id);
      }
    }),
  );
  if (['ai', 'mcp'].includes(view)) render();
  if (failed.length) {
    notify(`MCP connection unavailable: ${failed.join(', ')}. Start the server and use Connect & discover.`, true);
  }
}

/* ---------- Case history ---------- */

function historyCaseId() {
  const test = selectedKind === 'tests' && selected();
  return test ? test.qaCaseId || test.id : null;
}

function historyKey() {
  const id = historyCaseId();
  return id ? JSON.stringify([project.id, id]) : null;
}

function caseRuns() {
  const id = historyCaseId();
  if (!id || !historyTools) return [];
  const cached = historyCache.get(historyKey());
  const source = cached?.total === null || cached?.total === undefined ? projectRuns() : cached.runs;
  return source
    .map((item) => historyTools.caseRun(item, id))
    .filter(Boolean)
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
}

function historyCount() {
  return historyCache.get(historyKey())?.total ?? caseRuns().length;
}

function refreshHistoryPanel() {
  $('#run-count').textContent = historyCount();
  renderExecution();
  const status = $('#selected-case-status');
  if (status) status.innerHTML = badge(caseRuns()[0]?.status);
  const bug = $('#selected-case-bug');
  if (bug) bug.innerHTML = bugControls(caseRuns()[0]);
}

async function loadCaseHistory() {
  const key = historyKey();
  if (!key) return;
  let cached = historyCache.get(key);
  if (cached?.loading) return;
  if (!cached) {
    cached = { runs: [], total: null, loading: false };
    historyCache.set(key, cached);
  }
  cached.loading = true;
  try {
    const query = new URLSearchParams({
      projectId: project.id,
      testId: historyCaseId(),
      scope: 'case',
      offset: '0',
      limit: String(CASE_HISTORY_LIMIT),
    });
    const result = await api(`/api/runs?${query}`);
    cached.runs = result.runs;
    cached.total = result.total;
  } catch {
    // The latest-result panel keeps its last known value; connection status reports outages.
  } finally {
    cached.loading = false;
    if (historyKey() === key) refreshHistoryPanel();
  }
}

/* ---------- Shell ---------- */

function setViewInUrl(next) {
  const url = new URL(location.href);
  url.searchParams.set('view', next);
  if (project) url.searchParams.set('projectId', project.id);
  history.replaceState(null, '', url);
}

// Only these views are worth returning to on reload; other views fall back to the editor.
function navigate(next) {
  const isLeavingHistory = view === 'history' && next !== 'history';
  if (URL_TRACKED_VIEWS.includes(next) || URL_TRACKED_VIEWS.includes(view) || isLeavingHistory) setViewInUrl(next);
  if (SETTINGS_VIEWS.includes(next) && settingsStatus === 'failed') settingsStatus = 'idle';
  view = next;
  render();
  StudioUI.enter($('#content'));
}

function renderBreadcrumbs() {
  const test = selected();
  const names = {
    ...VIEW_NAMES,
    editor: { prerequisites: 'Prequenties', processes: 'Process automation' }[selectedKind] || 'Test cases',
    ai: aiTargetId ? 'Auto generator' : 'AI Assistance',
  };
  const itemTrail =
    view === 'editor' && test
      ? `<span> / </span><span>${selectedKind === 'tests' ? tc(test) : selectedKind === 'processes' ? 'Process' : 'Prerequisite'}</span>`
      : '';
  $('#breadcrumbs').innerHTML = `▧ <span>${esc(project.name)}</span><span> / </span><strong>${esc(names[view])}</strong>${itemTrail}`;
}

function renderPickers() {
  $('#project-select').innerHTML = options(state.projects, project.id);
  $('#environment-select').innerHTML = options(project.environments, project.activeEnvironmentId, 'No environment');
  $('#browser-select').value = project.browser || 'chrome';
}

function explorerItem(key, text, count) {
  const countBadge = count === '' ? '' : `<span class="count">${count}</span>`;
  return `<button class="nav-item ${view === key ? 'selected' : ''}" data-action="view" data-view="${key}">${esc(text)}${countBadge}</button>`;
}

function renderExplorer() {
  const defaultFolder = activeFolderId || selected()?.folderId || '';
  const mcpCount = settingsStatus === 'loaded' ? settings.mcpServers.length : '';
  $('#explorer').innerHTML = `
    ${explorerItem('execution', 'TC Execution overview', '')}
    <section class="tree-section">
      <div class="tree-heading">
        <button data-action="view" data-view="cases">Test cases <span class="count" aria-label="Total test cases">${project.tests.length}</span></button>
        ${StudioFolders.addMenu(defaultFolder, 'Test cases', 'new-test')}
      </div>
    </section>
    <section class="tree-section">
      <div class="tree-heading">
        <button data-action="view" data-view="suites">Suites <span class="count">${project.suites.length}</span></button>
        <button class="add" data-action="new-suite" aria-label="New suite">＋</button>
      </div>
    </section>
    ${explorerItem('history', 'Run history', '')}
    ${explorerItem('processes', 'Process automation', project.processes.length)}
    ${explorerItem('prerequisites', 'Prequenties', project.prerequisites.length)}
    ${explorerItem('objects', 'Object repository', project.objects.length)}
    ${explorerItem('database', 'PostgreSQL', project.jdbcProfiles.length)}
    ${explorerItem('variables', 'Environments & globals', project.environments.length)}
    ${explorerItem('mcp', 'MCP servers', mcpCount)}`;
}

function renderNoProject() {
  StudioExecution.unmount();
  StudioHistory.unmount();
  $('#explorer').innerHTML = '';
  $('#breadcrumbs').innerHTML = '';
  $('#execution').innerHTML = '';
  const canUseMcp = Boolean(globalThis.StudioAuth?.allowed('useMcp'));
  $('#content').innerHTML =
    view === 'mcp' && canUseMcp
      ? renderMcp()
      : empty(
          'No project access assigned',
          'Ask your administrator to assign a project in Administration > Project management.',
          canUseMcp ? '<button data-action="view" data-view="mcp">MCP servers</button>' : '',
        );
}

function qaReturnHref() {
  const base = `/?projectId=${encodeURIComponent(project.id)}`;
  if (selectedKind === 'prerequisites') return `${base}#preconditions`;
  if (selectedKind === 'tests' && selectedId) {
    return `${base}#case/${encodeURIComponent(selected()?.qaCaseId || selectedId)}`;
  }
  return `${base}#dashboard`;
}

function renderMainContent() {
  if (view === 'execution') {
    StudioHistory.unmount();
    StudioExecution.mount($('#content'), project.id);
    return;
  }
  StudioExecution.unmount();
  if (view === 'history') {
    StudioHistory.mount($('#content'), project.id);
    return;
  }
  StudioHistory.unmount();
  const renderers = {
    'local-data': renderLocalData,
    vpn: renderVpn,
    cases: renderCasesList,
    editor: renderEditor,
    suites: renderSuites,
    recording: renderRecording,
    debug: renderDebug,
    prerequisites: renderPrerequisites,
    processes: renderProcesses,
    objects: renderObjects,
    variables: renderVariables,
    database: renderDatabase,
    settings: renderSettings,
    mcp: renderMcp,
    ai: renderAi,
  };
  $('#content').innerHTML = renderers[view]();
}

function render() {
  syncGenerationState();
  if (SETTINGS_VIEWS.includes(view) && settingsStatus === 'idle') void ensureSettings();

  const hasNoProject = !project;
  const projectControls = '.workspace-pickers,.tabs,[data-action="save"],[data-action="run-suite"],[data-action="run-test"]';
  document.querySelectorAll(projectControls).forEach((node) => {
    node.hidden = hasNoProject;
  });
  if (hasNoProject) {
    renderNoProject();
    return;
  }

  if (globalThis.StudioAuth?.user && !StudioAuth.viewAllowed(view)) {
    view = 'editor';
    notify('Your administrator has not granted access to this page.', true);
  }

  $('.tabs').hidden = VIEWS_WITHOUT_TABS.includes(view);
  $('#qa-return').href = qaReturnHref();
  renderPickers();
  renderExplorer();
  renderBreadcrumbs();
  document.querySelectorAll('.tabs button').forEach((button) => {
    button.classList.toggle('active', button.dataset.view === view);
  });
  $('#run-count').textContent = historyCount();

  keepRemoteScreen(renderMainContent);
  renderExecution();
  updateStatus();

  if (view === 'cases') syncCasesSelection();
  if (view === 'ai' && settings.provider === 'reasonx' && !aiStatus && !aiStatusBusy) void loadAiStatus();
  if (historyKey() && !historyCache.has(historyKey())) void loadCaseHistory();
}

/* ---------- Debug view ---------- */

function renderTargetScreenshots(step) {
  const shots = step?.targetScreenshots || [];
  const links = shots.map((file, index) => {
    const label = `Locator screenshot${shots.length > 1 ? ` ${index + 1}` : ''}`;
    return `<a class="target-screenshot-link" href="${fileArtifactUrl(file)}" target="_blank" rel="noopener">${label}</a>`;
  });
  const warning = step?.screenshotWarning ? `<small class="error-text">${esc(step.screenshotWarning)}</small>` : '';
  return links.join(' ') + warning;
}

function renderDebugScreenshot(step) {
  if (!step?.screenshot) {
    return '<p class="form-hint">Step screenshots appear here. Inspect the open browser window after each action.</p>';
  }
  const url = fileArtifactUrl(step.screenshot);
  return `<a href="${url}" target="_blank" rel="noopener"><img class="debug-screenshot" src="${url}" alt="Screenshot after ${esc(step.name)}"></a>`;
}

function renderDebug() {
  const session = state.activeDebug;
  if (!session) return heading('STEP-BY-STEP', 'Debug test', 'No active debug session.');
  const isFinished = session.status !== 'running';
  const progress = isFinished
    ? session.status
    : `Step ${Math.min(session.stepIndex + 1, session.stepCount)} of ${session.stepCount}`;
  const current = session.currentStep;
  const title = session.nextStep ? `Next: ${session.nextStep}` : current ? current.name : 'Ready to start';
  const lastAction = current
    ? `Last action: ${esc(current.name)} · ${esc(current.status)}`
    : 'The browser is ready. Advance one action at a time.';
  const subtitle = `${session.browser} · ${session.pageUrl || 'Browser opened'} · ${progress}`;
  return `
    ${heading('STEP-BY-STEP DEBUG', session.testName, subtitle)}
    <section class="panel">
      <div class="panel-head">
        <div>
          <h2>${esc(title)}</h2>
          <p class="subtitle">${lastAction}</p>
        </div>
        ${badge(session.status)}
      </div>
      <div class="panel-body">
        ${session.error ? `<p class="error-text">${esc(session.error)}</p>` : ''}
        ${renderDebugScreenshot(current)}
        ${renderTargetScreenshots(current)}
        <div class="inline-actions">
          ${isFinished ? '' : '<button class="primary" data-action="debug-step">Step to next action →</button>'}
          <button data-action="inspect-locator">Check next locator</button>
          <button data-action="debug-close">${isFinished ? 'Close debug session' : 'Stop debugging'}</button>
          <button data-action="view" data-view="history">Run history</button>
        </div>
      </div>
    </section>`;
}

/* ---------- Recording view ---------- */

function requirementOptions(requirements) {
  return requirements.map((item, index) => ({ id: item.id, name: `${index + 1}. ${item.instruction}` }));
}

function renderCapturedScreenshot(step) {
  if (!step.captureScreenshot) return '';
  const url = fileArtifactUrl(step.captureScreenshot);
  return `
    <a class="capture-evidence" href="${url}" target="_blank" rel="noopener" aria-label="View captured screenshot for ${esc(step.name)}">
      <img src="${url}" loading="lazy" alt="Captured verification target: ${esc(step.name)}">
      <span>View captured screenshot</span>
    </a>`;
}

function recordedRequirementCell(step, index, requirements, isStopped) {
  if (!requirements.length) return '<span class="form-hint">No QA requirements</span>';
  const isDisabled = !isStopped || recordMappingBusy;
  return `
    <select data-record-mapping data-index="${index}" aria-label="QA requirement for recorded step ${index + 1}" ${isDisabled ? 'disabled' : ''}>
      ${options(requirementOptions(requirements), step.qaRequirementId || '', 'Not mapped')}
    </select>`;
}

function renderRecordedStep(step, index, requirements, isStopped) {
  const value = step.valueMode === 'environment' ? `Environment: ${step.value}` : step.value;
  return `
    <tr>
      <td>${index + 1}</td>
      <td class="recorded-step-name">${esc(step.name)}</td>
      <td>${esc(ACTION_LABELS[step.action])}</td>
      <td>${esc(step.target)}</td>
      <td>${esc(value)}</td>
      <td>${recordedRequirementCell(step, index, requirements, isStopped)}</td>
      <td>${renderCapturedScreenshot(step)}</td>
    </tr>`;
}

function recordingSaveStatus(recording) {
  if (recording.saveError) return esc(recording.saveError);
  if (recordMappingBusy) return 'Saving requirement mapping...';
  if (recording.saving) return 'Saving interaction...';
  if (recording.savedAt) {
    return `All recorded interactions saved - ${esc(new Date(recording.savedAt).toLocaleTimeString())}`;
  }
  return 'Waiting for first save...';
}

function recordingControls(recording, isStopped) {
  if (!isStopped) {
    return `
      <button data-action="record-toggle">${recording.status === 'paused' ? 'Resume' : 'Pause'}</button>
      <button class="primary" data-action="record-stop">Stop and review</button>`;
  }
  const disabled = recordMappingBusy ? 'disabled' : '';
  const owner = recording.kind === 'process' ? 'process' : 'test';
  return `
    <button class="primary" data-action="record-import" data-mode="replace" ${disabled}>Replace ${owner} steps</button>
    <button data-action="record-import" data-mode="append" ${disabled}>Append to ${owner}</button>`;
}

function renderRecording() {
  const recording = state.activeRecording;
  if (!recording) return heading('WEB RECORDER', 'Record Web', 'Open a test and choose Record Web to begin.');

  const linked = state.projects
    .find((item) => item.id === recording.projectId)
    ?.tests.find((test) => test.id === recording.testId);
  const requirements = linked?.qa?.manualSteps || [];
  const isStopped = recording.status === 'stopped';
  const modes = [
    { id: 'actions', name: 'Record actions' },
    { id: 'visible', name: 'Verify visible' },
    { id: 'text', name: 'Verify text' },
    { id: 'value', name: 'Verify field value' },
  ];
  const isProcess = recording.kind === 'process';
  let hint = requirements.length
    ? 'Step names include the element label or text and its type. Matching QA Studio requirements are added automatically. After Stop and review, you can adjust the requirement mappings. Several actions can use the same requirement.'
    : 'Step names include the element label or text and its type. Add test instructions in QA Studio to enable automatic requirement naming.';
  if (isProcess) hint = 'Every interaction becomes a step of this process. Stop and save it, then choose how many times to run it.';
  const requirementsHref = `/?projectId=${encodeURIComponent(recording.projectId)}#case/${encodeURIComponent(linked?.qaCaseId || recording.testId)}`;
  const subtitle = `${recording.browser} · ${recording.status} · ${recording.steps.length} steps`;
  const rows = recording.steps
    .map((step, index) => renderRecordedStep(step, index, requirements, isStopped))
    .join('');
  return `
    ${heading('WEB RECORDER', recording.testName, subtitle)}
    <section class="panel">
      <div class="panel-body">
        <p role="status">${recordingSaveStatus(recording)}</p>
        <p>${recording.remote ? 'The browser runs on the Studio server and is shown below. Click, scroll and type in it' : 'Interact with the visible browser'}. Each interaction is saved automatically. Frames, new tabs, open shadow DOM and multiple selections are supported. File uploads require a local-path variable.</p>
        <p>Choose a verification mode and click an element: a red outline marks the target and a message confirms the saved capture. A screenshot shows the highlighted target and its position on the page.</p>
        <label>Recording mode<select id="record-mode" ${isStopped ? 'disabled' : ''}>${options(modes, recording.mode || 'actions')}</select></label>
        <p class="recorder-map-hint">${hint} ${isProcess ? '' : `<a href="${requirementsHref}" target="_blank" rel="noopener">View QA Studio requirements</a>`}</p>
        <div class="inline-actions">
          ${recordingControls(recording, isStopped)}
          <button data-action="record-discard" ${recordMappingBusy ? 'disabled' : ''}>Discard recording</button>
        </div>
        ${recording.warnings.map((warning) => `<p class="notice">${esc(warning)}</p>`).join('')}
        ${recording.remote && !isStopped ? renderRemoteScreen(recording) : ''}
      </div>
      <div class="table-scroll">
        <table class="steps-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Step name</th>
              <th>Action</th>
              <th>Locator</th>
              <th>Value</th>
              <th>QA Studio requirement</th>
              <th>Captured screenshot</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </section>`;
}

/* ---------- Remote recording screen ---------- */

// On a server without a screen the recording browser runs hidden; this view shows it and
// sends clicks, scrolling and keys back to it. The last frame survives re-renders.
const REMOTE_FRAME_MS = 350;
const REMOTE_MOVE_MS = 200;
const REMOTE_KEYS = {
  Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', Escape: 'Escape',
  ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
};
const remoteScreen = { frameUrl: '', recordingId: '', loop: null, loading: false, inputs: Promise.resolve(), focused: false, movedAt: 0 };

function renderRemoteScreen(recording) {
  const { width, height } = recording.remote;
  const src = remoteScreen.recordingId === recording.id ? remoteScreen.frameUrl : '';
  return `
    <figure class="remote-screen">
      <img id="remote-screen" tabindex="0" width="${width}" height="${height}" ${src ? `src="${src}"` : ''}
        alt="Live view of the recording browser. Click it, then type to enter text."
        data-recording="${esc(recording.id)}" data-width="${width}" data-height="${height}">
      <figcaption>Live view of the browser on the Studio server. Click it before typing; Ctrl+V pastes text.</figcaption>
    </figure>`;
}

function sendRemoteInput(event) {
  const viewer = $('#remote-screen');
  if (!viewer) return;
  const id = viewer.dataset.recording;
  remoteScreen.inputs = remoteScreen.inputs
    .then(() => api(`/api/recordings/${encodeURIComponent(id)}/input`, 'POST', event))
    .then(() => refreshRemoteFrame())
    .catch((error) => notify(error.message, true));
}

function remotePoint(viewer, event) {
  const box = viewer.getBoundingClientRect();
  return {
    x: Math.round(((event.clientX - box.left) / box.width) * Number(viewer.dataset.width)),
    y: Math.round(((event.clientY - box.top) / box.height) * Number(viewer.dataset.height)),
  };
}

// Frames load as same-origin images (the CSP allows no blob: URLs); a frame replaces the shown
// one only after it has loaded, so the view never flickers to empty.
function refreshRemoteFrame() {
  const viewer = $('#remote-screen');
  if (!viewer || remoteScreen.loading) return Promise.resolve();
  const id = viewer.dataset.recording;
  const url = `/api/recordings/${encodeURIComponent(id)}/screen?frame=${Date.now()}`;
  remoteScreen.loading = true;
  return new Promise((resolve) => {
    const next = new Image();
    next.onload = () => {
      remoteScreen.frameUrl = url;
      remoteScreen.recordingId = id;
      const current = $('#remote-screen');
      if (current) current.src = url;
      resolve();
    };
    next.onerror = () => resolve();
    next.src = url;
  }).finally(() => {
    remoteScreen.loading = false;
  });
}

function bindRemoteScreen(viewer) {
  viewer.dataset.bound = 'true';
  viewer.addEventListener('click', (event) => {
    viewer.focus();
    sendRemoteInput({ type: 'click', ...remotePoint(viewer, event) });
  });
  viewer.addEventListener('dblclick', (event) => {
    sendRemoteInput({ type: 'click', clickCount: 2, ...remotePoint(viewer, event) });
  });
  viewer.addEventListener('mousemove', (event) => {
    if (Date.now() - remoteScreen.movedAt < REMOTE_MOVE_MS) return;
    remoteScreen.movedAt = Date.now();
    sendRemoteInput({ type: 'move', ...remotePoint(viewer, event) });
  });
  viewer.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      sendRemoteInput({ type: 'scroll', dx: event.deltaX, dy: event.deltaY });
    },
    { passive: false },
  );
  viewer.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') return;
    let key = REMOTE_KEYS[event.key];
    if (event.key === 'Tab' && event.shiftKey) key = 'Shift+Tab';
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') key = event.metaKey ? 'Meta+a' : 'Control+a';
    if (key) {
      event.preventDefault();
      sendRemoteInput({ type: 'key', key });
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      sendRemoteInput({ type: 'text', text: event.key });
    }
  });
  viewer.addEventListener('paste', (event) => {
    const text = event.clipboardData?.getData('text') || '';
    if (!text) return;
    event.preventDefault();
    sendRemoteInput({ type: 'text', text: text.slice(0, 1000) });
  });
  viewer.addEventListener('focus', () => {
    remoteScreen.focused = true;
  });
  // A re-render removes the focused viewer; only a blur that leaves it on the page means the user moved on.
  viewer.addEventListener('blur', () => {
    setTimeout(() => {
      if (viewer.isConnected) remoteScreen.focused = false;
    });
  });
}

// Status polls redraw the recording view; reusing the live viewer keeps a click that spans a
// redraw, keyboard focus and the current frame.
function keepRemoteScreen(redraw) {
  const live = $('#remote-screen')?.closest('.remote-screen');
  redraw();
  const fresh = $('#remote-screen')?.closest('.remote-screen');
  if (live && fresh && live.querySelector('img').dataset.recording === fresh.querySelector('img').dataset.recording) {
    fresh.replaceWith(live);
  }
  syncRemoteScreen();
}

// Called after every render: binds a new viewer, keeps its focus and runs one frame loop.
function syncRemoteScreen() {
  const viewer = $('#remote-screen');
  if (!viewer) {
    clearInterval(remoteScreen.loop);
    remoteScreen.loop = null;
    return;
  }
  if (!viewer.dataset.bound) bindRemoteScreen(viewer);
  if (remoteScreen.focused && document.activeElement !== viewer) viewer.focus({ preventScroll: true });
  if (!remoteScreen.loop) {
    void refreshRemoteFrame();
    remoteScreen.loop = setInterval(() => void refreshRemoteFrame(), REMOTE_FRAME_MS);
  }
}

/* ---------- Requirements panel ---------- */

function renderMissingRequirements(test) {
  if (selectedKind !== 'tests') return '';
  const isSaved = state.projects.find((item) => item.id === project.id)?.tests.some((item) => item.id === test.id);
  const message = isSaved
    ? 'Add test instructions and expected outcomes to this case in QA Studio.'
    : 'Save this test case, then add its test instructions and expected outcomes in QA Studio.';
  const href = `/?projectId=${encodeURIComponent(project.id)}#case/${encodeURIComponent(test.qaCaseId || test.id)}`;
  return `
    <section class="panel qa-context requirements-missing" aria-label="Missing QA Studio requirements">
      <div class="requirements-alert">
        <span class="requirements-mark" aria-hidden="true">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3 2 21h20L12 3Z"/><path d="M12 9v5m0 3v1"/></svg>
        </span>
        <div class="requirements-heading">
          <span class="requirements-eyebrow">QA STUDIO / REQUIREMENTS</span>
          <h2>Test case requirements missing</h2>
          <p>${message}</p>
        </div>
        <span class="requirements-state">Requirements not created</span>
        ${isSaved ? `<a class="button" href="${href}">Add requirements in QA Studio</a>` : ''}
      </div>
    </section>`;
}

function renderRequirementStep(step, index) {
  const expected = step.expectedResult
    ? `<p class="requirement-expected"><span>Expected outcome</span>${esc(step.expectedResult)}</p>`
    : '';
  return `
    <li>
      <span class="requirement-number">${pad2(index + 1)}</span>
      <div><strong>${esc(step.instruction)}</strong>${expected}</div>
    </li>`;
}

function requirementNote(label, text) {
  return text ? `<div class="requirements-note"><span>${label}</span><p>${esc(text)}</p></div>` : '';
}

function renderQaContext(test) {
  if (!test.qa?.manualSteps?.length) return renderMissingRequirements(test);

  const key = JSON.stringify([project.id, selectedKind, test.id]);
  const count = test.qa.manualSteps.length;
  const status = test.automationNeedsUpdate
    ? 'Review changes'
    : test.steps.length
      ? 'Automation configured'
      : 'Ready to automate';
  const anchor = selectedKind === 'prerequisites' ? '#preconditions' : `#case/${encodeURIComponent(test.qaCaseId || test.id)}`;
  const footerText = test.steps.length
    ? 'Keep these requirements in view as you refine your automation.'
    : 'Turn these requirements into browser actions using Record Web, Auto generator, or the editor below.';
  const autoGenerator =
    selectedKind === 'tests' && needsAutoGenerator(test)
      ? `<button class="primary" data-action="auto-generator" ${generating ? 'disabled' : ''}>Auto generator</button>`
      : '';
  return `
    <details class="panel qa-context" data-requirements="${esc(key)}" ${openRequirements.has(key) ? 'open' : ''}>
      <summary class="panel-head">
        <span class="requirements-mark" aria-hidden="true">${StudioUI.icon('book')}</span>
        <div class="requirements-heading">
          <span class="requirements-eyebrow">QA STUDIO / REQUIREMENTS</span>
          <h2>Test case requirements</h2>
          <p>Your test instructions and expected outcomes, alongside your automation.</p>
        </div>
        <div class="requirements-meta">
          <span class="requirements-count">${count} requirement${count === 1 ? '' : 's'}</span>
          <span class="requirements-state ${test.automationNeedsUpdate ? 'needs-review' : ''}">${esc(status)}</span>
        </div>
        <span class="requirements-toggle">
          <span class="requirements-show">View details</span>
          <span class="requirements-hide">Hide details</span>
          <svg class="requirements-chevron" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>
        </span>
      </summary>
      <div class="panel-body">
        <div class="requirements-intro">
          <p>${esc(test.qa.description || 'Use these instructions to configure the automation steps below.')}</p>
          <a class="button" href="/?projectId=${encodeURIComponent(project.id)}${anchor}">View in QA Studio</a>
        </div>
        ${requirementNote('PRECONDITIONS', test.qa.preconditions)}
        <ol class="requirements-steps">${test.qa.manualSteps.map(renderRequirementStep).join('')}</ol>
        ${requirementNote('OVERALL EXPECTED RESULT', test.qa.expectedResult)}
        ${test.automationNeedsUpdate ? '<p class="notice">QA requirements have changed. Update the automation steps to match.</p>' : ''}
        <div class="requirements-footer">
          <p>${footerText}</p>
          ${autoGenerator}
        </div>
      </div>
    </details>`;
}

function refreshQaContext() {
  const context = $('.qa-context');
  const test = selected();
  if (context && test) context.outerHTML = renderQaContext(test);
}

/* ---------- Editor ---------- */

function editorWindow(test) {
  const key = `${project.id}:${selectedKind}:${test.id}`;
  if (editorKey !== key) {
    editorKey = key;
    editorPage = 0;
  }
  editorPage = Math.max(0, Math.min(editorPage, Math.ceil(test.steps.length / editorSize) - 1));
  const start = editorPage * editorSize;
  return test.steps
    .slice(start, start + editorSize)
    .map((step, index) => renderStep(step, start + index, test))
    .join('');
}

function editorPager(test) {
  const pages = Math.max(1, Math.ceil(test.steps.length / editorSize));
  return `
    <nav class="pagination" aria-label="Test step pages">
      <button data-action="editor-page" data-direction="-1" ${editorPage ? '' : 'disabled'}>Previous</button>
      <span>Page ${editorPage + 1} of ${pages} · ${test.steps.length} steps</span>
      <button data-action="editor-page" data-direction="1" ${editorPage + 1 >= pages ? 'disabled' : ''}>Next</button>
      <label>Steps per page
        <select id="editor-page-size">${options(STEP_PAGE_SIZES, String(editorSize))}</select>
      </label>
    </nav>`;
}

function stepValueChoices(step, test) {
  if (step.valueMode === 'global') return Object.keys(project.globalVariables);
  if (step.valueMode === 'environment') {
    const environment = project.environments.find((item) => item.id === project.activeEnvironmentId);
    return Object.keys(environment?.variables || {});
  }
  if (step.valueMode === 'data') {
    const rows = step.dataRows || test.dataRows || [];
    return [...new Set(rows.flatMap((row) => Object.keys(row || {})))];
  }
  if (step.valueMode === 'local') return (test.localTestData || []).map((item) => item.name);
  return [];
}

function stepAttributes(index, key) {
  return `data-step="${index}" data-key="${key}" aria-label="Step ${index + 1} ${key}"`;
}

function stepRequirementSelect(step, index, test) {
  const requirements = test.qa?.manualSteps || [];
  if (!requirements.length) return '';
  return `
    <label class="qa-step-link">QA Studio requirement
      <select data-step-mapping data-index="${index}" aria-label="QA requirement for step ${index + 1}">
        ${options(requirementOptions(requirements), step.qaRequirementId || '', 'Not mapped')}
      </select>
    </label>`;
}

function stepTargetCell(step, index, hasNoTarget) {
  const replacementInput = `<input class="replacement" ${stepAttributes(index, 'replacement')} value="${esc(step.replacement || '')}" placeholder="XXX replacement">`;
  if (step.locatorType === 'object' && !hasNoTarget) {
    return `
      <select ${stepAttributes(index, 'target')}>${options(caseObjects(), step.target, 'Select object')}</select>
      ${replacementInput}`;
  }
  const canParameterize = ['css', 'xpath', 'custom'].includes(step.locatorType) && StudioLocators.hasParameter(step.target);
  return `
    <input ${stepAttributes(index, 'target')} value="${esc(step.target)}" placeholder="${hasNoTarget ? 'Not required' : '#element, label…'}" ${hasNoTarget ? 'disabled' : ''}>
    ${!hasNoTarget && canParameterize ? replacementInput : ''}`;
}

function stepValuePlaceholder(step, hasNoValue) {
  if (hasNoValue) return 'Not required';
  if (step.action === 'navigate') return 'https://example.com';
  if (step.action === 'uiValidate') return 'Email = a@b.com; Name ~ Ann; Terms : checked';
  return 'Value or expectation';
}

function stepValueCell(step, index, hasNoValue, test) {
  const disabled = hasNoValue ? 'disabled' : '';
  const expectedRows =
    step.action === 'dbValidate'
      ? `<button class="mini-link" data-action="expected-rows" data-index="${index}">${step.expectedRows ? `${step.expectedRows.length} expected rows` : 'Set expected results'}</button>`
      : '';
  if (step.valueMode === 'static') {
    return `
      <input ${stepAttributes(index, 'value')} type="${step.sensitive ? 'password' : 'text'}" value="${esc(step.value)}" placeholder="${stepValuePlaceholder(step, hasNoValue)}" ${disabled}>
      ${expectedRows}`;
  }
  const choices = stepValueChoices(step, test);
  const prompt = choices.length ? 'Select a variable' : 'No variables available';
  return `
    <select ${stepAttributes(index, 'value')} ${disabled}>${options(choices, step.value, prompt)}</select>
    ${expectedRows}`;
}

function stepRowActions(step, index, hasNoTarget, test) {
  const number = index + 1;
  const canSaveObject = !hasNoTarget && selectedKind === 'tests' && ['css', 'xpath'].includes(step.locatorType);
  const saveObject = canSaveObject
    ? `<button data-action="save-step-object" data-index="${index}" title="Save locator to repository" aria-label="Save step ${number} locator to repository">▤</button>`
    : '';
  // Step 1 opens the page, so regenerating from it is the same as Auto generator replacing every step.
  const canRegenerateFrom = index > 0 && selectedKind === 'tests' && Boolean(test.qa?.manualSteps?.length);
  return `
    ${saveObject}
    ${canRegenerateFrom ? `<button data-action="regenerate-from-step" data-index="${index}" title="Regenerate from step ${number}" aria-label="Regenerate steps from step ${number}" ${generating ? 'disabled' : ''}>↻</button>` : ''}
    <button data-action="move-step" data-index="${index}" data-direction="-1" title="Move step ${number} up" aria-label="Move step ${number} up" ${index === 0 ? 'disabled' : ''}>↑</button>
    <button data-action="move-step" data-index="${index}" data-direction="1" title="Move step ${number} down" aria-label="Move step ${number} down" ${index === test.steps.length - 1 ? 'disabled' : ''}>↓</button>
    <button data-action="step-options" data-index="${index}" title="Step settings" aria-label="Step ${number} settings">⚙</button>
    <button data-action="duplicate-step" data-index="${index}" title="Duplicate step ${number}" aria-label="Duplicate step ${number}">⧉</button>
    <button data-action="remove-step" data-index="${index}" title="Remove step ${number}" aria-label="Remove step ${number}">×</button>`;
}

function stepRepeatToggle(step, index) {
  if (selectedKind !== 'processes') return '';
  return `<label class="repeat-toggle"><input type="checkbox" data-step-repeat data-index="${index}" ${step.repeat ? 'checked' : ''} aria-label="Repeat step ${index + 1}"> Repeat</label>`;
}

function renderStep(step, index, test) {
  const hasNoTarget = NO_TARGET_ACTIONS.has(step.action);
  const hasNoValue = NO_VALUE_ACTIONS.has(step.action);
  const actionChoices = Object.entries(ACTION_LABELS).map(([id, name]) => ({ id, name }));
  const locatorChoices = Object.entries(LOCATOR_LABELS).map(([id, name]) => ({ id, name }));
  return `
    <tr data-row="${index}" class="${selectedKind === 'processes' && step.repeat ? 'repeat-step' : ''}">
      <td class="drag" draggable="true" data-drag-step="${index}" title="Drag to reorder">⠿</td>
      <td class="num">${pad2(index + 1)}</td>
      <td class="step-name">
        <input ${stepAttributes(index, 'name')} value="${esc(step.name)}" title="${esc(step.name)}" maxlength="10000" ${step.qaRequirementId ? 'readonly' : ''}>
        ${stepRequirementSelect(step, index, test)}
        ${stepRepeatToggle(step, index)}
        ${renderCapturedScreenshot(step)}
      </td>
      <td class="step-action"><select ${stepAttributes(index, 'action')}>${options(actionChoices, step.action)}</select></td>
      <td><select ${stepAttributes(index, 'locatorType')} ${hasNoTarget ? 'disabled' : ''}>${options(locatorChoices, step.locatorType)}</select></td>
      <td class="step-target">${stepTargetCell(step, index, hasNoTarget)}</td>
      <td class="step-source"><select ${stepAttributes(index, 'valueMode')} ${hasNoValue ? 'disabled' : ''}>${options(VALUE_SOURCES, step.valueMode)}</select></td>
      <td class="step-value">${stepValueCell(step, index, hasNoValue, test)}</td>
      <td class="row-actions">${stepRowActions(step, index, hasNoTarget, test)}</td>
    </tr>`;
}

function bugControls(latest) {
  const test = selected();
  if (!test) return '';
  return StudioIssueReport.controls({
    projectId: project.id,
    testIds: [test.id, test.qaCaseId, historyCaseId()],
    runId: latest?.id,
    statuses: latest ? [latest.status, ...latest.tests.map((item) => item.status)] : [],
  });
}

function renderEditorActions(isPrerequisite, latest) {
  const testActions = isPrerequisite
    ? ''
    : `
      <span id="selected-case-status">${badge(latest?.status)}</span>
      <span id="selected-case-bug" class="issue-controls">${bugControls(latest)}</span>
      <button class="quiet" data-action="preflight">Check readiness</button>
      <button class="quiet" data-action="local-test-data">Local Test Data</button>
      <button class="quiet" data-action="test-options">Test options</button>
      <button data-action="schedule-test">Schedule</button>
      <button class="quiet" data-action="record-web">Record Web</button>
      <button class="quiet" data-action="replay-test" title="Watch each step in a visible browser with red highlights and slow motion">Replay</button>
      <button class="quiet" data-action="debug-test">Debug test</button>`;
  return `
    ${testActions}
    <button class="quiet" data-action="duplicate-test" title="Duplicate">Duplicate</button>
    <button class="quiet danger" data-action="delete-test" title="Delete">Delete</button>`;
}

function renderProcessActions(item) {
  return `
    ${processRunButton(item)}
    <button class="quiet" data-action="record-web">Record Web</button>
    <button class="quiet" data-action="duplicate-test" title="Duplicate">Duplicate</button>
    <button class="quiet danger" data-action="delete-test" title="Delete">Delete</button>`;
}

function renderProcessDetails(item) {
  return `
    <section class="panel">
      <div class="panel-head">
        <h2>Process details <span class="count">PROCESS</span></h2>
        <span class="subtitle">${item.steps.length} steps</span>
      </div>
      <div class="test-meta">
        <label>Process name<input data-meta="name" aria-label="Process name" value="${esc(item.name)}" maxlength="120"></label>
        ${processRunInput(item, 'Number of runs')}
      </div>
      ${repeatSummary(item)}
    </section>`;
}

function renderTestDetails(test, isPrerequisite) {
  const associations = isPrerequisite
    ? ''
    : `
      <label>Folder<select data-meta="folderId" aria-label="Folder">${options(StudioFolders.choices(project.folders), test.folderId, 'No folder')}</select></label>
      <label>Suite<select data-meta="suiteId" aria-label="Suite">${options(project.suites, test.suiteId, 'No suite')}</select></label>
      <label>Prequenties<select data-meta="prerequisiteId" aria-label="Prerequisite">${options(project.prerequisites, test.prerequisiteId, 'None')}</select></label>`;
  return `
    <section class="panel">
      <div class="panel-head">
        <h2>${isPrerequisite ? 'Prerequisite details' : 'Test case details'} <span class="count">${isPrerequisite ? 'REUSABLE' : tc(test)}</span></h2>
        <span class="subtitle">${test.steps.length} steps</span>
      </div>
      <div class="test-meta">
        <label>${isPrerequisite ? 'Prerequisite name' : 'Test name'}<input data-meta="name" aria-label="Test name" value="${esc(test.name)}" maxlength="120"></label>
        ${associations}
      </div>
    </section>`;
}

function renderStepsPanel(test) {
  return `
    <section class="panel">
      <div class="panel-head">
        <div>
          <h2>Test steps <span class="count">${pad2(test.steps.length)}</span></h2>
          <p class="subtitle">Actions run from top to bottom. Drag a step to reorder.</p>
        </div>
      </div>
      <div class="table-scroll">
        <table class="steps-table">
          <thead>
            <tr>
              <th></th>
              <th>#</th>
              <th>Step name</th>
              <th>Action</th>
              <th>Locator type</th>
              <th>Locator / input</th>
              <th>Value source</th>
              <th>Value / expected / URL</th>
              <th class="row-actions">Actions</th>
            </tr>
          </thead>
          <tbody>${editorWindow(test)}</tbody>
        </table>
      </div>
      ${editorPager(test)}
      <div class="add-step-row">
        <button data-action="add-step">Add step</button>
        <small>${test.steps.length ? 'Small steps. Reliable workflows.' : 'Add your first action to get started.'}</small>
      </div>
    </section>`;
}

function renderEditor() {
  const test = selected();
  if (!test) {
    return (
      heading('BUILD & VALIDATE', 'Your test workspace', 'Create a test or open a QA Studio case to generate its automation.') +
      empty(
        'Every workflow starts with a test',
        'Add browser actions, organize them into suites, and run them locally.',
        '<button class="primary" data-action="new-test">Create test</button>',
      )
    );
  }
  const isPrerequisite = selectedKind === 'prerequisites';
  const isProcess = selectedKind === 'processes';
  const latest = selectedKind === 'tests' ? caseRuns()[0] : null;
  let subtitle = 'Configure automation steps, then run this test.';
  if (isPrerequisite) subtitle = 'These steps run before linked tests, in the same browser session.';
  if (isProcess) subtitle = 'Record or edit the process steps, set the run count, then run it.';
  let eyebrow = 'TEST WORKSPACE';
  if (isPrerequisite) eyebrow = 'REUSABLE SETUP';
  if (isProcess) eyebrow = 'PROCESS AUTOMATION';
  const localNames = (test.localTestData || []).map((entry) => `<option value="${esc(entry.name)}"></option>`).join('');
  return `
    ${renderQaContext(test)}
    ${heading(eyebrow, test.name, subtitle, isProcess ? renderProcessActions(test) : renderEditorActions(isPrerequisite, latest))}
    ${isProcess ? renderProcessDetails(test) : renderTestDetails(test, isPrerequisite)}
    ${renderStepsPanel(test)}
    <datalist id="local-variable-names">${localNames}</datalist>
    <details class="quick-start">
      <summary>ⓘ &nbsp; Quick start guide <span>— a few things to get you going</span></summary>
      <p>Start with Navigate and an HTTP(S) URL in the value field. Use Label or Test ID to locate elements. Choose a global or environment variable by its name. Repository objects support XXX replacements. Save before running; runs automatically save your changes.</p>
    </details>`;
}

// Redraws the editor only, keeping focus on the control the user was working in.
function refreshEditor() {
  const focused = document.activeElement;
  const { step, key } = focused?.dataset || {};
  $('#content').innerHTML = renderEditor();
  updateStatus();
  if (step !== undefined && key) $(`[data-step="${step}"][data-key="${key}"]`)?.focus();
}

function renderExecution() {
  const panel = $('#execution');
  if (view !== 'editor') {
    panel.innerHTML = '';
    return;
  }
  const latest = caseRuns()[0];
  const icon = !latest ? '▷' : latest.status === 'passed' ? '✓' : latest.status === 'running' ? '◌' : '!';
  const title = latest
    ? `${latest.tests.filter((test) => test.status === 'passed').length} of ${latest.tests.length} tests passed`
    : 'Your next great run starts here';
  const detail = latest
    ? `${new Date(latest.startedAt).toLocaleString()} · ${((latest.duration || 0) / 1000).toFixed(1)} seconds`
    : 'Run this test to see results, step details, and screenshots.';
  const cannotRun = state.activeRun || selectedKind !== 'tests' || !selected()?.steps.length;
  const action = latest
    ? '<button data-action="view" data-view="history">View results ↗</button>'
    : `<button data-action="run-test" ${cannotRun ? 'disabled' : ''}>Run test</button>`;
  panel.innerHTML = `
    <section class="execution-panel">
      <div class="execution-heading">
        ◷ ${latest?.replay ? 'Latest replay' : 'Latest execution'}
        <span class="line"></span>
        ${latest ? badge(latest.status) : '<small>READY WHEN YOU ARE</small>'}
      </div>
      <div class="execution-card">
        <span class="execution-icon">${icon}</span>
        <div>
          <h3>${title}</h3>
          <p>${esc(detail)}</p>
        </div>
        ${selectedKind === 'tests' ? `<span class="issue-controls">${bugControls(latest)}</span>` : ''}
        ${action}
      </div>
    </section>`;
}

/* ---------- Suites, prerequisites, repository, variables and database ---------- */

function suiteMembers(suiteId) {
  return project.tests.filter((test) => test.suiteId === suiteId || test.additionalSuiteIds?.includes(suiteId));
}

function renderSuite(suite) {
  const tests = suiteMembers(suite.id);
  const tags =
    tests
      .map(
        (test) => `
          <span class="suite-tag tooltip" data-tooltip="${esc(test.name)}">
            <span tabindex="0" title="${esc(test.name)}">${tc(test)}</span>
            <button data-action="unmap" data-id="${esc(test.id)}" data-suite="${esc(suite.id)}" aria-label="Remove ${tc(test)} from suite">×</button>
          </span>`,
      )
      .join('') || '<p class="subtitle">This suite is empty. Map a test in the editor, or create one here.</p>';
  const cannotRun = !tests.length || state.activeRun || state.activeDebug;
  return `
    <details class="suite" data-suite="${esc(suite.id)}" open>
      <summary>${esc(suite.name)} <span class="count">${tests.length} tests</span></summary>
      <div class="suite-content">
        <div class="suite-tags">${tags}</div>
        <div class="inline-actions">
          <button class="primary" data-action="execute-suite" data-id="${esc(suite.id)}" ${cannotRun ? 'disabled' : ''}>Run this suite</button>
          <button data-action="new-test" data-suite="${esc(suite.id)}">New test</button>
        </div>
      </div>
    </details>`;
}

function renderSuites() {
  const body = project.suites.length
    ? project.suites.map(renderSuite).join('')
    : empty(
        'A home for related tests',
        'Create a smoke, regression, or feature suite. Tests keep their folder and suite assignments independently.',
        '<button data-action="new-suite">Create suite</button>',
      );
  return (
    heading(
      'ORGANIZE & EXECUTE',
      'Test suites',
      'Group related tests and run them together.',
      '<button class="primary" data-action="new-suite">New suite</button>',
    ) + body
  );
}

function updateSuiteRunButtons() {
  document.querySelectorAll('[data-action="execute-suite"]').forEach((button) => {
    button.disabled = Boolean(state.activeRun || state.activeDebug) || !suiteMembers(button.dataset.id).length;
  });
}

// The marked Repeat block of a process: null when nothing is marked, or { first, last, isSplit }.
function repeatBlock(item) {
  const marked = item.steps.flatMap((step, index) => (step.repeat ? [index] : []));
  if (!marked.length) return null;
  const first = marked[0];
  const last = marked.at(-1);
  return { first, last, isSplit: last - first + 1 !== marked.length };
}

function stepRange(first, last) {
  return first === last ? `step ${first + 1}` : `steps ${first + 1}–${last + 1}`;
}

function repeatSummary(item) {
  const block = repeatBlock(item);
  const count = item.runCount || 1;
  const times = `${count} ${count === 1 ? 'time' : 'times'}`;
  if (!block) return `<p class="form-hint process-hint">No steps are marked Repeat, so the whole process runs ${times}, each in a fresh browser session. Tick Repeat on the steps that should run again and again.</p>`;
  if (block.isSplit) {
    return `<p class="notice error process-hint" role="alert">Steps marked Repeat must be next to each other. Mark every step from ${block.first + 1} to ${block.last + 1}, or untick the ones outside the block you want to repeat.</p>`;
  }
  const before = block.first ? `${stepRange(0, block.first - 1)} ${block.first === 1 ? 'runs' : 'run'} once first, then ` : '';
  const afterCount = item.steps.length - block.last - 1;
  const after = afterCount
    ? `, then ${stepRange(block.last + 1, item.steps.length - 1)} ${afterCount === 1 ? 'runs' : 'run'} once at the end`
    : '';
  const plan = `${before}${stepRange(block.first, block.last)} ${block.first === block.last ? 'repeats' : 'repeat'} ${times}${after}`;
  return `<p class="form-hint process-hint">${esc(plan[0].toUpperCase() + plan.slice(1))}. Everything runs in one browser session. If a step fails, the remaining steps are skipped.</p>`;
}

function processRunInput(item, label = 'Run count') {
  return `<label class="process-runs">${label}<input type="number" min="1" max="${MAX_PROCESS_RUNS}" step="1" value="${item.runCount || 1}" data-process-runs data-id="${esc(item.id)}" aria-label="Number of times to run ${esc(item.name)}"></label>`;
}

function processRunButton(item) {
  const isBusy = Boolean(state.activeRun || state.activeDebug || recordingLive());
  const count = item.runCount || 1;
  const block = repeatBlock(item);
  const label = block && !block.isSplit
    ? `Run, repeating ${stepRange(block.first, block.last)} × ${count}`
    : `Run ${count} ${count === 1 ? 'time' : 'times'}`;
  return `<button class="primary" data-action="run-process" data-id="${esc(item.id)}" ${isBusy || !item.steps.length || block?.isSplit ? 'disabled' : ''}>${label}</button>`;
}

// Run buttons follow the active run, debug session and recording without redrawing the page.
function updateProcessRunButtons() {
  for (const button of document.querySelectorAll('[data-action="run-process"]')) {
    const item = project.processes.find((candidate) => candidate.id === button.dataset.id);
    if (!item) continue;
    const isBusy = Boolean(state.activeRun || state.activeDebug || recordingLive());
    button.disabled = isBusy || !item.steps.length || Boolean(repeatBlock(item)?.isSplit);
  }
}

function renderProcesses() {
  const cards = project.processes
    .map(
      (item) => `
        <article class="resource-card process-card">
          <h3>${esc(item.name)}</h3>
          <p>${item.steps.length ? `${item.steps.length} steps` : 'No steps yet. Record the process to capture it.'}</p>
          ${item.steps.length ? repeatSummary(item) : ''}
          ${processRunInput(item)}
          <div class="inline-actions">
            ${processRunButton(item)}
            <button data-action="record-process" data-id="${esc(item.id)}" ${recordingLive() ? 'disabled' : ''}>Record</button>
            <button data-action="edit-process" data-id="${esc(item.id)}">Edit steps →</button>
          </div>
        </article>`,
    )
    .join('');
  return `
    ${heading(
      'RECORD ONCE. RUN MANY TIMES.',
      'Process automation',
      'Record a business process in the browser, then replay it as many times as you need.',
      '<button class="primary" data-action="new-process">New process</button>',
    )}
    <div class="cards-grid">${cards}</div>
    ${project.processes.length ? '' : empty('Automate a repetitive process', 'Create a process, record the flow once in the browser, and set how many times it should run. Each run uses a fresh browser session and appears in Run history.')}`;
}

function renderPrerequisites() {
  const cards = project.prerequisites
    .map((item) => {
      const users = project.tests.filter((test) => test.prerequisiteId === item.id).length;
      return `
        <article class="resource-card">
          <h3>${esc(item.name)}</h3>
          <p>${item.steps.length} steps · Used by ${users} tests</p>
          <button data-action="edit-prerequisite" data-id="${esc(item.id)}">Edit steps →</button>
        </article>`;
    })
    .join('');
  return `
    ${heading(
      'REUSABLE BUILDING BLOCKS',
      'Prequenties',
      'Create shared setup steps, such as signing in, then link them to your tests.',
      '<button class="primary" data-action="new-prerequisite">New prerequisite</button>',
    )}
    <div class="cards-grid">${cards}</div>
    ${project.prerequisites.length ? '' : empty('Set up once. Reuse everywhere.', 'Prerequisites run in the same browser session as the test that uses them.')}`;
}

function renderObjectRow(object) {
  const template = StudioLocators.definition(object, project.locatorTemplates);
  return `
    <tr data-object="${esc(object.id)}">
      <td>${esc(object.name)}</td>
      <td>${esc(template.locatorType.toUpperCase())}</td>
      <td class="code">${esc(template.selector)}</td>
      <td>
        <button data-action="edit-object" data-id="${esc(object.id)}">Edit</button>
        <button class="quiet danger" data-action="delete-object" data-id="${esc(object.id)}">Remove</button>
      </td>
    </tr>`;
}

function renderRepositoryCase(test) {
  const ownerId = StudioLocators.caseId(test);
  const objects = project.objects.filter((object) => object.testCaseId === ownerId);
  const isOpen = openRepositoryCases.has(`${project.id}:${ownerId}`);
  const table = objects.length
    ? `
      <div class="table-scroll">
        <table class="data-table">
          <thead><tr><th>Element name</th><th>Locator type</th><th>Locator template</th><th>Actions</th></tr></thead>
          <tbody>${objects.map(renderObjectRow).join('')}</tbody>
        </table>
      </div>`
    : '<p class="subtitle">No objects mapped to this test case.</p>';
  return `
    <details class="suite" data-repository-case="${esc(ownerId)}" ${isOpen ? 'open' : ''}>
      <summary>${esc(test.name)} <span class="count">${objects.length} object${objects.length === 1 ? '' : 's'}</span></summary>
      <div class="suite-content">${table}</div>
    </details>`;
}

function renderLegacyObjectNotice() {
  const records = project.repositoryLegacyObjects || [];
  if (!records.length) return '';
  const items = records.map(
    (entry) => `<li>${esc(entry.object.name)} (${esc(entry.object.id)}): ${esc(entry.reason)}</li>`,
  );
  return `
    <div class="notice" role="status">
      <strong>${records.length} legacy record(s) need ownership review.</strong>
      <ul>${items.join('')}</ul>
    </div>`;
}

function renderObjects() {
  return `
    ${heading(
      'REUSABLE LOCATORS',
      'Object repository',
      'Each test case owns its locator mappings. Configure replacements and field details on test steps.',
      `<button data-action="convert-html">Convert HTML</button>
       <button class="primary" data-action="edit-object">Add object</button>`,
    )}
    ${renderLegacyObjectNotice()}
    ${project.tests.map(renderRepositoryCase).join('')}
    ${project.tests.length ? '' : empty('Select a test case first', 'Create or open a test case before saving repository objects.')}`;
}

function renderEnvironmentCard(environment) {
  const isActive = project.activeEnvironmentId === environment.id;
  const names = Object.keys(environment.variables);
  const id = esc(environment.id);
  return `
    <article class="resource-card">
      <h3>${esc(environment.name)} ${isActive ? badge('active') : ''}</h3>
      <p>${names.length} variables</p>
      <pre>${esc(names.join('\n') || 'No variables')}</pre>
      <div class="inline-actions">
        <button data-action="edit-environment" data-id="${id}">Edit</button>
        <button data-action="activate-environment" data-id="${id}" ${isActive ? 'disabled' : ''}>Use environment</button>
        <button class="quiet danger" data-action="delete-environment" data-id="${id}">Remove</button>
      </div>
    </article>`;
}

function renderVariables() {
  const globalNames = Object.keys(project.globalVariables);
  return `
    ${heading(
      'WORKSPACE CONTEXT',
      'Environments & globals',
      'Switch environments without changing your test steps.',
      '<button class="primary" data-action="edit-environment">New environment</button>',
    )}
    <div class="cards-grid">
      <article class="resource-card">
        <h3>Global variables</h3>
        <p>Shared across every environment in this project.</p>
        <pre>${esc(globalNames.join('\n') || 'No global variables yet')}</pre>
        <button data-action="edit-globals">Edit variables</button>
      </article>
      ${project.environments.map(renderEnvironmentCard).join('')}
    </div>
    <p class="form-hint">Variable values are stored encrypted on this computer. AI drafting receives variable names, not values.</p>`;
}

function renderProfileCard(profile) {
  const isActive = profile.id === project.activeJdbcProfileId;
  const id = esc(profile.id);
  return `
    <article class="resource-card">
      <h3>${esc(profile.name)} ${isActive ? badge('active') : ''}</h3>
      <p>${esc(profile.host)}:${esc(profile.port)} / ${esc(profile.database)}</p>
      <small>User: ${esc(profile.username)} · TLS ${profile.sslmode === 'require' ? 'required' : 'off'}</small>
      <div class="inline-actions">
        <button data-action="test-profile" data-id="${id}">Test connection</button>
        <button data-action="query-profile" data-id="${id}">Query</button>
        <button data-action="edit-profile" data-id="${id}">Edit</button>
        <button data-action="activate-profile" data-id="${id}" ${isActive ? 'disabled' : ''}>Use</button>
        <button class="quiet danger" data-action="delete-profile" data-id="${id}">Remove</button>
      </div>
    </article>`;
}

function renderDatabase() {
  return `
    ${heading(
      'DATA VALIDATION',
      'PostgreSQL connections',
      'Run read-only SELECT queries and compare results in your tests.',
      '<button class="primary" data-action="edit-profile">Add connection</button>',
    )}
    <div class="cards-grid">${project.jdbcProfiles.map(renderProfileCard).join('')}</div>
    ${project.jdbcProfiles.length ? '' : empty('Connect your test database', 'Add a PostgreSQL profile to validate data alongside browser interactions.')}
    <p class="form-hint">Uses the native Node PostgreSQL driver. Credentials stay in your local store. Use a database account with read-only permissions.</p>`;
}

/* ---------- Settings view ---------- */

function reasonxModelChoices() {
  const known = StudioReasonx.modelOptions;
  const extras = [...new Set([...(aiStatus?.models || []), settings.model])].filter(
    (id) => typeof id === 'string' && id && !known.some((option) => option.id === id),
  );
  return [...known, ...extras.map((id) => ({ id, name: id }))];
}

function reasonxModeChoices(model) {
  return StudioReasonx.modeOptions.map((option) => ({
    id: option.id,
    name: `${option.name} · ${model === 'reasonx-v1' ? option.model || 'by task complexity' : model}`,
  }));
}

function providerHelp() {
  const link = (href, text) => `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  if (settings.provider === 'reasonx') {
    return `Start ReasonX from its project folder (java -jar target/reasonx-console.jar), open ${link('http://127.0.0.1:8080', 'its console ↗')}, choose Create API key and paste the copied key here. The server answers on ports 8080 and 8081; use 127.0.0.1 rather than localhost. The key is stored encrypted on this computer and is never returned to the browser. Keep the model server running while generating tests. Use Automatic (reasonx-v1) with Auto mode to let task complexity choose among qwen3:1.7b, qwen3:4b-thinking, qwen3:8b and qwen3:14b. Expert selects 14B for the most complex tasks. A specific Qwen model fixes the model; the mode still controls its workflow. Requests run one at a time. Standard, Deep and Expert can take several minutes on CPU. Select MCP servers under AI Assistance to give the agent read-only context. Set REASONX_API_KEY before starting Studio to use an environment key.`;
  }
  if (settings.provider === 'google') {
    return `Get a key in ${link('https://aistudio.google.com/app/apikey', 'Google AI Studio ↗')}. Gemini offers free quotas for select models. Quotas vary and can change. The API key stays on the local server. Google says free-tier content may be used to improve its products; do not send secrets or sensitive test data. ${link('https://ai.google.dev/gemini-api/docs/pricing', 'Free-tier terms and pricing ↗')}`;
  }
  if (settings.provider === 'groq') {
    return `Create a key in ${link('https://console.groq.com/keys', 'Groq Console')}. Use openai/gpt-oss-20b for structured test drafts. Keys stay on the local server; set GROQ_API_KEY to keep the key out of the local JSON store.`;
  }
  if (settings.provider === 'nvidia') {
    return `Create a key in ${link('https://build.nvidia.com', 'NVIDIA API Catalog ↗')}. The default model is meta/muse-glimmer-30b; any chat model from the catalog works. The hosted catalog queues requests, so a draft can take several minutes. AI Assistance only: requirement generation needs another provider. Keys stay on the local server; set NVIDIA_API_KEY to keep the key out of the local JSON store.`;
  }
  return 'Your key is used by the local server and is never returned to the browser. Set OPENAI_API_KEY before starting the server to keep it out of the local JSON store.';
}

function reasonxCheckMessage() {
  if (aiStatusBusy) return 'Checking the local server…';
  if (aiStatus.error) return `Could not check: ${esc(aiStatus.error)}`;
  if (!aiStatus.reachable) {
    return `Not reachable at ${esc(settings.reasonxBaseUrl || REASONX_BASE_URL)}. Start ReasonX and Ollama, then test again.`;
  }
  if (!aiStatus.authorized) {
    return 'The server answered but rejected the saved key. Create a key in the ReasonX console and save it here.';
  }
  return `✓ Connected. Models: ${(aiStatus.models || []).map(esc).join(', ')}`;
}

function renderProviderForm() {
  const isReasonx = settings.provider === 'reasonx';
  const provider = providerInfo();
  const modelControl = isReasonx
    ? `<select id="ai-model" name="model" aria-label="Model" required>${options(reasonxModelChoices(), settings.model)}</select>`
    : `<input id="ai-model" name="model" value="${esc(settings.model)}" required placeholder="Model ID">`;
  const reasonxFields = isReasonx
    ? `
      <label>API base URL<input id="ai-base-url" name="reasonxBaseUrl" type="url" value="${esc(settings.reasonxBaseUrl || REASONX_BASE_URL)}" required placeholder="${REASONX_BASE_URL}"></label>
      <label>Reasoning mode<select name="reasonxMode" aria-label="Reasoning mode">${options(reasonxModeChoices(settings.model), settings.reasonxMode || 'auto')}</select></label>`
    : '';
  const keyPlaceholder = settings.hasApiKey ? 'Key configured · leave blank to keep' : provider.keyPlaceholder;
  const checkButton = isReasonx
    ? `<button type="button" data-action="check-ai-status" ${aiStatusBusy ? 'disabled' : ''}>Check local server</button>`
    : '';
  const checkResult =
    isReasonx && (aiStatus || aiStatusBusy)
      ? `<p class="form-hint reasonx-check" role="status">${reasonxCheckMessage()}</p>`
      : '';
  return `
    <section class="panel">
      <div class="panel-head">
        <h2>${esc(provider.title)}</h2>
        ${badge(settings.hasApiKey ? 'configured' : 'API key needed')}
      </div>
      <form id="openai-form" class="panel-body form-stack">
        <label>LLM provider<select name="provider" id="ai-provider">${options(PROVIDER_CHOICES, settings.provider)}</select></label>
        <label>Model${modelControl}</label>
        ${reasonxFields}
        <label>${esc(provider.keyLabel)}<input id="ai-api-key" name="apiKey" type="password" autocomplete="new-password" placeholder="${esc(keyPlaceholder)}"></label>
        <p class="form-hint" id="provider-help">${providerHelp()}</p>
        <div class="inline-actions">
          <button class="primary" type="submit">Save ${esc(provider.short)} connection</button>
          <button type="button" data-action="clear-key">Clear saved key</button>
          ${checkButton}
        </div>
        ${checkResult}
      </form>
    </section>`;
}

function settingRow(title, detail, trailing = '') {
  return `
    <div class="setting-row">
      <div><strong>${title}</strong><small>${detail}</small></div>
      ${trailing}
    </div>`;
}

function renderBugTracking() {
  const config = settings.bugTracker || {};
  const tokenExtras = `autocomplete="new-password" maxlength="4000" ${config.hasApiKey ? '' : 'required'} placeholder="${config.hasApiKey ? 'Saved token — leave blank to keep' : 'Paste API token'}"`;
  const verified = config.connected
    ? `<p class="form-hint">Verified ${esc(config.projectName)} as ${esc(config.accountName)} on ${esc(new Date(config.verifiedAt).toLocaleString())}. Report issue is available in QA test case details, and Raise bug in the test editor and Run history.</p>`
    : '';
  return `
    <section class="panel bug-tracking-panel">
      <div class="panel-head">
        <div>
          <h2>Bug tracking configuration</h2>
          <p class="subtitle">Connect Jira Cloud to report issues from QA test case details, the test editor and Run history.</p>
        </div>
        <span class="badge" id="jira-connection-status">${config.connected ? 'Connected' : 'Not connected'}</span>
      </div>
      <form id="bug-tracker-form" class="panel-body form-stack">
        <div class="form-grid">
          ${field('siteUrl', 'Jira site URL', config.siteUrl || '', 'url', 'required placeholder="https://your-team.atlassian.net"')}
          ${field('email', 'Jira account email', config.email || '', 'email', 'required autocomplete="username"')}
          ${field('projectKey', 'Jira project key', config.projectKey || '', 'text', 'required maxlength="80" placeholder="QA"')}
          ${field('issueTypeName', 'Jira issue type', config.issueTypeName || 'Bug', 'text', 'required maxlength="120"')}
          ${field('apiKey', 'Jira API token', '', 'password', tokenExtras)}
        </div>
        <p class="form-hint">Use an API token without scopes for your Atlassian account. Your token is encrypted on this computer and is never returned to the browser. <a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noopener noreferrer">Manage API tokens</a></p>
        ${verified}
        <p id="bug-tracker-message" role="status">${esc(bugTrackerMessage)}</p>
        <div class="inline-actions">
          <button class="primary" type="submit" ${bugTrackerBusy ? 'disabled' : ''}>${bugTrackerBusy ? 'Checking connection…' : 'Save &amp; test connection'}</button>
          <button type="button" data-action="disconnect-jira" ${bugTrackerBusy || !config.hasApiKey ? 'disabled' : ''}>Disconnect Jira</button>
        </div>
      </form>
    </section>`;
}

function renderSettings() {
  const mcpSummary = settingsStatus === 'loaded' ? `${settings.mcpServers.length} configured connections` : 'Not loaded';
  return `
    ${heading(
      'MAKE IT YOURS',
      'Settings & connections',
      'Manage AI, bug tracking, and workspace connections.',
      `<button data-action="view" data-view="vpn">OpenVPN settings</button>
       <button data-action="export-project">Export project</button>
       <button data-action="import-project">Import project</button>
       <button data-action="backup-workspace">Create backup</button>
       <button data-action="restore-workspace">Restore projects</button>
       <button data-action="view-schedules">Schedules</button>
       <button data-action="history-retention">Clean history</button>`,
    )}
    ${settingsNotice()}
    <div class="settings-layout">
      ${renderProviderForm()}
      <section class="panel">
        <div class="panel-head"><h2>Your workspace</h2></div>
        <div class="panel-body">
          ${settingRow('Browser engine', 'Playwright · Chromium', '<span class="badge">Local</span>')}
          ${settingRow('Persistence', 'Atomic JSON snapshots on this computer')}
          ${settingRow('MCP servers', mcpSummary, '<button data-action="view" data-view="mcp">Manage →</button>')}
          ${settingRow('AI drafts', 'Review and edit every generated test before running.')}
        </div>
      </section>
    </div>
    ${renderBugTracking()}`;
}

/* ---------- MCP view ---------- */

function renderMcpCatalog() {
  if (!globalThis.StudioAuth?.allowed('manageMcp')) return '';
  const presets = (settings.mcpCatalog || []).map((preset) => {
    const isSaved = settings.mcpServers.some((server) => server.presetId === preset.id);
    const label = isSaved ? 'Configure' : preset.id === 'playwright' ? 'Add & connect Playwright' : 'Set up Atlassian';
    return `
      <article class="mcp-preset">
        <h3>${esc(preset.name)}</h3>
        <p class="form-hint">${esc(preset.description)}</p>
        <div class="inline-actions">
          <button class="primary" data-action="setup-mcp-preset" data-preset="${esc(preset.id)}">${esc(label)}</button>
          <a href="${esc(preset.docsUrl)}" target="_blank" rel="noopener noreferrer">Official documentation</a>
        </div>
      </article>`;
  });
  return `
    <section class="panel">
      <div class="panel-head">
        <div>
          <h2>Recommended MCP servers</h2>
          <p class="subtitle">Official integrations for browser automation and Jira bug tracking.</p>
        </div>
      </div>
      <div class="panel-body mcp-catalog">${presets.join('')}</div>
    </section>`;
}

function mcpConnectionStatus(server) {
  if (mcpTools.has(server.id)) return 'Connected';
  return server.authType && server.authType !== 'none' && !server.hasApiKey ? 'Credentials needed' : 'Not connected';
}

function renderMcpTools(server) {
  const tools = mcpTools.get(server.id);
  if (!tools) return '';
  const rows = tools.map(
    (tool, index) => `
      <div class="setting-row">
        <div><strong>${esc(tool.name)}</strong><small>${esc(tool.description || 'No description')}</small></div>
        <button data-action="call-mcp" data-id="${esc(server.id)}" data-index="${index}">Open</button>
      </div>`,
  );
  return `<div class="setting-row"><strong>${tools.length} tools available</strong></div>${rows.join('')}`;
}

function renderMcpServer(server) {
  const id = esc(server.id);
  const address = server.transport === 'http' ? server.url : [server.command, ...server.args].join(' ');
  return `
    <article class="resource-card">
      <h3>${esc(server.name)} <span class="count">${server.transport === 'http' ? 'HTTP' : 'STDIO'}</span></h3>
      <p class="mcp-status">${mcpConnectionStatus(server)}</p>
      <p class="code">${esc(address)}</p>
      <div class="inline-actions">
        <button class="primary" data-action="discover-mcp" data-id="${id}">Connect &amp; discover</button>
        <button data-action="reconnect-mcp" data-id="${id}">Reconnect</button>
        <button data-action="edit-mcp" data-id="${id}">Edit</button>
        <button class="quiet danger" data-action="delete-mcp" data-id="${id}">Remove</button>
      </div>
      ${renderMcpTools(server)}
    </article>`;
}

function renderExternalAgentPanel() {
  if (!settings.studioMcp) return '';
  const config = { mcpServers: { 'automation-studio': settings.studioMcp } };
  return `
    <section class="panel">
      <div class="panel-head"><h2>Connect an external agent to this Studio</h2></div>
      <div class="panel-body">
        <p class="subtitle">The included Studio MCP server exposes project discovery, test definitions, execution, and run results. Keep this app running, then configure your MCP client:</p>
        <pre class="code">${esc(JSON.stringify(config, null, 2))}</pre>
        <p class="form-hint">Change the script path if you move the app. Incoming MCP access does not expose API keys or variable values. Test definitions may contain literal test data.</p>
      </div>
    </section>`;
}

function renderMcp() {
  return `
    ${heading(
      'CONNECTED TOOLS',
      'MCP servers',
      'Discover and use tools from local or remote Model Context Protocol servers.',
      '<button class="primary" data-action="edit-mcp">Add server</button>',
    )}
    ${settingsNotice()}
    ${renderMcpCatalog()}
    <div class="cards-grid">${settings.mcpServers.map(renderMcpServer).join('')}</div>
    ${settings.mcpServers.length ? '' : empty('Bring your tools together', 'Connect a stdio server installed on your machine or a Streamable HTTP endpoint. Tools run only when you explicitly call them.')}
    ${renderExternalAgentPanel()}`;
}

function updateMcpFieldVisibility() {
  const isHttp = $('#dialog [name="transport"]').value === 'http';
  const auth = $('#dialog [name="authType"]').value;
  $('#mcp-stdio-fields').hidden = isHttp;
  $('#mcp-http-fields').hidden = !isHttp;
  $('#mcp-basic-fields').hidden = auth !== 'basic';
  $('#mcp-secret-fields').hidden = auth === 'none';
  $('#mcp-stdio-fields').querySelectorAll('input,textarea').forEach((node) => {
    node.disabled = isHttp;
  });
  // Hidden sections are disabled too, so a stale token or account is never submitted.
  $('#mcp-http-fields').querySelectorAll('input,select').forEach((node) => {
    node.disabled = !isHttp || Boolean(node.closest('[hidden]'));
  });
}

function editMcp(id, initial = {}) {
  const previous = settings.mcpServers.find((server) => server.id === id);
  const server = previous || initial;
  const transports = [
    { id: 'stdio', name: 'Local process (stdio)' },
    { id: 'http', name: 'Streamable HTTP' },
  ];
  const authTypes = [
    { id: 'none', name: 'None' },
    { id: 'basic', name: 'Basic — account email and API token' },
    { id: 'bearer', name: 'Bearer — API token' },
  ];
  const tokenPlaceholder = server.hasApiKey ? 'Saved token — leave blank to keep' : 'Enter token';
  const body = `
    ${field('name', 'Server name', server.name || '', 'text', 'required')}
    <label>Transport<select name="transport">${options(transports, server.transport || 'stdio')}</select></label>
    <div id="mcp-stdio-fields">
      ${field('command', 'Local executable', server.command || 'node')}
      ${jsonField('args', 'Arguments (JSON array)', server.args || [])}
    </div>
    <div id="mcp-http-fields">
      ${field('url', 'HTTP endpoint', server.url || '', 'url', 'placeholder="https://server.example/mcp"')}
      <label>HTTP authentication<select name="authType">${options(authTypes, server.authType || 'none')}</select></label>
      <div id="mcp-basic-fields">
        ${field('username', 'MCP account email / username', server.username || '', 'text', 'autocomplete="username"')}
      </div>
      <div id="mcp-secret-fields">
        ${field('apiKey', 'MCP API token', '', 'password', `autocomplete="new-password" maxlength="4000" placeholder="${tokenPlaceholder}"`)}
        <label class="mcp-clear-token"><input type="checkbox" name="clearApiKey"> Remove saved token</label>
      </div>
    </div>
    <p class="form-hint">Credentials are encrypted locally and are never shown after saving. For Atlassian, use a scoped personal API token with Basic authentication, or a service account API key with Bearer authentication. An organization admin must enable API token authentication for Atlassian MCP. OAuth sign-in is not included.</p>
    <p class="form-hint">Local processes start when you connect. HTTP endpoints must support Streamable HTTP.</p>`;
  modal(previous ? 'Edit MCP server' : 'Add MCP server', body, async (values) => {
    const item = {
      id: id || uid(),
      name: values.name,
      transport: values.transport,
      ...(server.presetId ? { presetId: server.presetId } : {}),
    };
    if (values.transport === 'stdio') {
      Object.assign(item, { command: values.command, args: parseJson(values.args, 'Arguments') });
    } else {
      Object.assign(item, {
        url: values.url,
        authType: values.authType,
        username: values.username,
        apiKey: values.apiKey,
        clearApiKey: Boolean(values.clearApiKey),
      });
    }
    mcpTools.delete(item.id);
    await saveMcpServers([...settings.mcpServers.filter((other) => other.id !== item.id), item]);
    notify('MCP connection saved. Choose Connect & discover to verify it.');
  });
  $('#dialog [name="transport"]').addEventListener('change', updateMcpFieldVisibility);
  $('#dialog [name="authType"]').addEventListener('change', updateMcpFieldVisibility);
  updateMcpFieldVisibility();
}

async function setupMcpPreset(preset) {
  const existing = settings.mcpServers.find((server) => server.presetId === preset);
  if (existing) {
    editMcp(existing.id);
    return;
  }
  const result = await api(`/api/mcp/presets/${encodeURIComponent(preset)}`, 'POST', {});
  const id = result.addedServerId;
  delete result.addedServerId;
  settings = result;
  render();
  if (preset === 'atlassian') {
    editMcp(id);
    return;
  }
  try {
    const discovered = await api(`/api/mcp/${id}/tools`, 'POST', {});
    mcpTools.set(id, discovered.tools);
    render();
    notify(`Playwright connected: ${discovered.tools.length} tools available.`);
  } catch (error) {
    notify(`Playwright was added, but could not connect: ${error.message}`, true);
  }
}

/* ---------- OpenVPN view ---------- */

async function loadVpn() {
  if (vpnLoading) return;
  vpnLoading = true;
  vpnError = '';
  if (view === 'vpn') render();
  try {
    vpnState = await api('/api/vpn');
    vpnProfiles = vpnState.installed ? (await api('/api/vpn/profiles', 'POST', {})).profiles : [];
  } catch (error) {
    vpnProfiles = [];
    vpnError = error.message;
  } finally {
    vpnLoading = false;
    if (view === 'vpn') render();
  }
}

async function vpnRequest(route, method, body, successMessage) {
  vpnLoading = true;
  render();
  try {
    vpnState = await api(route, method, body);
    vpnError = '';
    notify(successMessage);
  } catch (error) {
    vpnError = error.message;
  } finally {
    vpnLoading = false;
    if (view === 'vpn') render();
  }
}

function vpnStatusText() {
  if (vpnLoading) return 'Discovering profiles…';
  const last = vpnState?.lastAction;
  if (!last) return 'VPN status is shown in OpenVPN Connect.';
  const kind = last.action === 'connect' ? 'Connection' : 'Disconnection';
  return `${kind} requested at ${new Date(last.requestedAt).toLocaleTimeString()}. Check OpenVPN Connect for the actual VPN status.`;
}

function renderVpn() {
  const isAvailable = vpnState?.installed && !vpnLoading;
  const chosen = vpnProfiles.find((profile) => profile.id === vpnState?.profileId);
  const disabled = isAvailable ? '' : 'disabled';
  return `
    ${heading('NETWORK ACCESS', 'OpenVPN', 'Use an existing OpenVPN Connect profile to reach your private test applications.')}
    <section class="panel">
      <div class="panel-head">
        <h2>OpenVPN Connect</h2>
        <button data-action="vpn-refresh" ${vpnLoading ? 'disabled' : ''}>Refresh profiles</button>
      </div>
      <div class="panel-body form-stack">
        <p role="status">${esc(vpnStatusText())}</p>
        ${vpnError ? `<p class="error-text" role="alert">${esc(vpnError)}</p>` : ''}
        ${vpnState && !vpnState.installed ? '<p class="notice">Install OpenVPN Connect for Windows and import your VPN profile in the desktop client, then refresh profiles.</p>' : ''}
        <label>Existing VPN profile<select id="vpn-profile" ${disabled}>${options(vpnProfiles, vpnState?.profileId, 'Select a profile')}</select></label>
        ${vpnState?.profileId && !chosen && !vpnLoading ? '<p class="notice">The saved profile is unavailable. Refresh profiles or choose another profile.</p>' : ''}
        ${isAvailable && !vpnProfiles.length && !vpnError ? '<p>No profiles found. Import your profile in OpenVPN Connect, then refresh this list.</p>' : ''}
        <div class="inline-actions">
          <button data-action="vpn-save" ${disabled}>Save profile selection</button>
          <button class="primary" data-action="vpn-connect" ${isAvailable && chosen ? '' : 'disabled'}>Connect saved profile</button>
          <button data-action="vpn-disconnect" ${disabled}>Disconnect VPN</button>
        </div>
        <p>Configure your credentials in OpenVPN Connect. When you click Connect, its desktop window handles passwords, certificates and MFA prompts. Studio does not store your VPN password.</p>
        <p class="form-hint">Save your profile selection before connecting. Once OpenVPN Connect confirms the connection, return here to record or run tests. Disconnect affects the active OpenVPN Connect tunnel, including a connection started outside Studio. Changing VPN connections is blocked during active recording, debugging or test execution.</p>
      </div>
    </section>`;
}

/* ---------- AI Assistance ---------- */

const currentGeneration = () => state?.aiGenerations?.find((job) => job.projectId === project?.id);
const reasonxModeName = (id) => StudioReasonx.modeOptions.find((option) => option.id === id)?.name;
const reasonxModeHint = (mode) => StudioReasonx.modeHint(mode, settings.model);
const aiEngineChoice = () => aiEngine ?? settings.userAi?.engines?.automation ?? 'studio';

function formatElapsed(seconds) {
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s` : `${seconds}s`;
}

function elapsedSeconds() {
  return Math.max(0, Math.round((Date.now() - generateStarted) / 1000));
}

function startGenerationTimer() {
  if (generateTimer) return;
  generateTimer = setInterval(() => {
    const node = document.getElementById('ai-elapsed');
    if (node) node.textContent = formatElapsed(elapsedSeconds());
  }, 1000);
}

function syncGenerationState() {
  const job = currentGeneration();
  const pending = pendingGenerations.get(project?.id);
  generating = Boolean(pending || job?.status === 'running');
  if (generating) {
    generateStarted = job?.status === 'running' ? Date.parse(job.startedAt) : pending;
    if (job?.status === 'running' && job.kind === 'automation' && job.testId) aiTargetId = job.testId;
    startGenerationTimer();
  } else {
    clearInterval(generateTimer);
    generateTimer = null;
  }
  recoverCompletedGeneration(job);
}

function recoverCompletedGeneration(job) {
  if (job?.kind !== 'automation' || job.status !== 'completed') return;
  if (recoveredGenerations.has(job.id) && draftProjectId === job.projectId) return;
  const saved = state.projects.find((item) => item.id === job.projectId)?.tests.find((test) => test.id === job.testId);
  if (!saved) return;
  draft = {
    ...structuredClone(saved),
    explanation: `${job.explanation || ''} Test saved but not run. ${(job.warnings || []).join(' ')}`,
  };
  draftProjectId = job.projectId;
  recoveredGenerations.add(job.id);
}

async function reconnectGeneration(projectId) {
  const latest = await api('/api/state');
  state.agentDrafts = latest.agentDrafts || [];
  state.aiGenerations = latest.aiGenerations || [];
  const fresh = latest.projects.find((item) => item.id === projectId);
  if (fresh) {
    const index = state.projects.findIndex((item) => item.id === projectId);
    if (index >= 0) state.projects[index] = fresh;
    if (project?.id === projectId && !dirty && !saving) project = structuredClone(fresh);
  }
  return state.aiGenerations.find((job) => job.projectId === projectId);
}

function selectedSafeMcpIds() {
  return [...aiMcpIds].filter((id) => mcpTools.get(id)?.some((tool) => tool.annotations?.readOnlyHint === true));
}

async function recoverFromGenerationFailure(error, projectId) {
  if (error.code === 'OPENAI_BILLING_REQUIRED') aiBillingBlocked = true;
  if (error.code === 'GEMINI_QUOTA_EXCEEDED') aiQuotaBlocked = true;
  if (isMissingRoute(error)) {
    aiMissingRouteError = error.message;
    return true;
  }
  if (error.code !== 'GENERATION_IN_PROGRESS' && !(error instanceof TypeError)) return false;
  const job = await reconnectGeneration(projectId).catch(() => null);
  if (job?.status !== 'running' && job?.status !== 'completed') return false;
  notify(
    job.status === 'running'
      ? 'Reconnected to the generation already running.'
      : 'Generated steps recovered. Open the test editor to review them.',
  );
  return true;
}

async function generateAutomation() {
  const projectId = project.id;
  if (pendingGenerations.has(projectId) || currentGeneration()?.status === 'running') {
    render();
    return;
  }
  const request = {
    projectId,
    prompt: aiPrompt,
    engine: aiEngineChoice(),
    mcpServerIds: selectedSafeMcpIds(),
    ...(aiTargetId ? { testId: aiTargetId } : {}),
    ...(aiTargetId && regenerateFromStep() ? { regenerateFrom: regenerateFromStep() } : {}),
  };
  // Claim the click before saving: a second click must not start a second request.
  pendingGenerations.set(projectId, Date.now());
  aiBillingBlocked = false;
  aiQuotaBlocked = false;
  aiMissingRouteError = '';
  render();
  try {
    await save();
    const result = await api('/api/ai/create', 'POST', { ...request, agentOptions: project.agentOptions });
    aiRegenerateFrom = 0;
    if (result.preview) {
      state.agentDrafts = [...(state.agentDrafts || []).filter((item) => item.projectId !== projectId), result.preview];
      await reconnectGeneration(projectId);
      notify('Agent draft ready. Review the steps before applying.');
      return;
    }
    draft = {
      ...result.test,
      explanation: `${result.explanation} Test saved but not run. ${(result.warnings || []).join(' ')}`,
    };
    draftProjectId = projectId;
    if (result.generationId) recoveredGenerations.add(result.generationId);
    // The state poll merges the saved project, so edits made while the model ran are never overwritten.
    await reconnectGeneration(projectId);
    notify('Automation saved. Review it, then use Run test.');
  } catch (error) {
    if (await recoverFromGenerationFailure(error, projectId)) return;
    // Show the failure in the alert window, then refresh so the saved job error appears inline.
    await reconnectGeneration(projectId).catch(() => null);
    showGenerationIssues(error.message, error.issues);
  } finally {
    pendingGenerations.delete(projectId);
    render();
  }
}

async function loadAiStatus() {
  if (aiStatusBusy) return;
  aiStatusBusy = true;
  try {
    aiStatus = await api('/api/ai/status');
  } catch (error) {
    aiStatus = { error: error.message };
  } finally {
    aiStatusBusy = false;
    if (['ai', 'settings'].includes(view)) render();
  }
}

function reasonxStartButton() {
  if (!isAdmin()) return '';
  const attributes = reasonxStarting ? 'disabled aria-busy="true"' : '';
  return `<button type="button" data-action="start-reasonx" ${attributes}>${reasonxStarting ? 'Starting ReasonX...' : 'Turn on ReasonX'}</button>`;
}

function reasonxStatusBadge() {
  if (aiStatusBusy) return '<span class="badge running">◌ checking…</span>';
  if (!aiStatus) return '<span class="badge neutral">○ not checked</span>';
  if (aiStatus.error) return '<span class="badge failed">○ check failed</span>';
  if (!aiStatus.reachable) return '<span class="badge failed">○ not reachable</span>';
  if (!aiStatus.authorized) return '<span class="badge failed">○ key rejected</span>';
  return '<span class="badge passed">✓ ready</span>';
}

function reasonxStatusDetail() {
  const baseUrl = esc(settings.reasonxBaseUrl || REASONX_BASE_URL);
  if (!aiStatus || aiStatusBusy) return `Checks the local ReasonX server at ${baseUrl}.`;
  if (aiStatus.error) return `Studio could not query the model status: ${esc(aiStatus.error)}`;
  if (!aiStatus.reachable) {
    return 'Start ReasonX (java -jar target/reasonx-console.jar) and make sure Ollama is running, then check again.';
  }
  if (!aiStatus.authorized) return 'Save a valid ReasonX key in Model settings. Keys are created in the ReasonX console.';
  const isListed = aiStatus.models?.includes(settings.model) || settings.model === 'reasonx-v1';
  const models = (aiStatus.models || []).map(esc).join(', ');
  return `Models: ${models}${isListed ? '' : ` · the configured model “${esc(settings.model)}” is not listed`}`;
}

function renderReasonxStatus() {
  const mode = settings.reasonxMode || 'auto';
  const chips = StudioReasonx.modeOptions
    .map(
      (option) => `
        <button type="button" class="mode-chip ${option.id === mode ? 'active' : ''}" data-action="set-reasonx-mode" data-mode="${option.id}" aria-pressed="${option.id === mode}" title="${esc(reasonxModeHint(option.id))}" ${isAdmin() ? '' : 'disabled'}>${option.name}</button>`,
    )
    .join('');
  return `
    <section class="panel ai-status">
      <div class="panel-head">
        <div>
          <h2>ReasonX automation agent</h2>
          <p class="subtitle">ReasonX · ${esc(settings.model)}</p>
        </div>
        <div class="inline-actions">
          ${reasonxStatusBadge()}
          ${reasonxStartButton()}
          <button data-action="check-ai-status" ${aiStatusBusy ? 'disabled' : ''}>Check connection</button>
        </div>
      </div>
      <div class="panel-body">
        <p class="form-hint">${reasonxStatusDetail()}</p>
        <p class="form-hint">The agent gathers selected context and drafts test steps from the workflow and observed controls. Studio validates locators and requests corrections before saving editable steps for review.</p>
        <div class="mode-row">
          <span>Reasoning mode</span>
          <div class="mode-chips" role="group" aria-label="Reasoning mode">${chips}</div>
        </div>
        <p class="form-hint">${esc(reasonxModeHint(mode))} Standard, Deep and Expert can take several minutes on CPU.${isAdmin() ? '' : ' Ask an administrator to change the mode.'}</p>
      </div>
    </section>`;
}

function renderReasonxOffer() {
  const selectAction = isAdmin()
    ? '<button data-action="use-reasonx-agents">Use ReasonX agents</button>'
    : '<p class="form-hint">Ask an administrator to select ReasonX in Model settings.</p>';
  return `
    <section class="panel">
      <div class="panel-body">
        <h2>ReasonX agents</h2>
        ${reasonxStartButton()}
        <p class="form-hint">Turn on ReasonX starts the installed local server. Keep Ollama running for generation.</p>
        <p class="form-hint">Generate test steps with the local ReasonX automation agent. This changes the shared AI provider used by both studios.</p>
        ${selectAction}
      </div>
    </section>`;
}

function generationStageText(job) {
  if (job?.status !== 'running') return 'Saving the workspace';
  const mode = job.engine ? '' : job.reasonxMode || settings.reasonxMode || 'auto';
  const model = job.model || settings.model;
  const modeName = reasonxModeName(mode);
  const stages = {
    inspection: 'Inspecting the starting page',
    drafting: `Generating with ${model}${modeName ? ` (${modeName})` : ''}`,
    correcting: 'Correcting generated locators',
    validation: 'Validating generated steps',
    saving: 'Saving generated steps',
  };
  return stages[job.stage] || StudioReasonx.agentStageLabel(job.stage, job.detail) || job.stage || 'Generating tests';
}

function renderAiProgress() {
  if (!generating) return '';
  const job = currentGeneration();
  const isRequirements = job?.kind === 'requirements';
  const title = isRequirements ? 'Generating test cases in QA Studio' : 'Creating your automation';
  const detail = isRequirements
    ? 'Wait for the QA generation to finish before generating automation.'
    : 'Results appear here when generation finishes. Agent drafts need review before applying. You can refresh without starting again.';
  return `
    <div class="ai-progress" role="status" aria-live="polite">
      <span class="busy-spinner" aria-hidden="true"></span>
      <div>
        <strong>${esc(title)} · <span id="ai-elapsed">${formatElapsed(elapsedSeconds())}</span></strong>
        <small>${esc(generationStageText(job))}. ${esc(detail)}</small>
      </div>
      ${job?.status === 'running' ? '<button data-action="cancel-agent-generation">Cancel generation</button>' : ''}
    </div>`;
}

function issueItem(issue) {
  const rows = [
    ['Expected', issue.expected],
    ['Found', issue.found],
    ['What to do', issue.fix],
  ].filter(([, value]) => value);
  const title = issue.step ? `Step ${issue.step}: ${issue.problem}` : issue.problem;
  return `
    <li class="issue-item">
      <strong>${esc(title)}</strong>
      ${rows.length ? `<dl>${rows.map(([name, value]) => `<dt>${name}</dt><dd>${esc(value)}</dd>`).join('')}</dl>` : ''}
    </li>`;
}

// A small alert window listing each generation problem in plain language.
function showGenerationIssues(message, issues) {
  // Errors without details (provider failures, older servers) split into the problem and the advice that follows it.
  const [problem, ...advice] = String(message).split(/(?<=\.)\s+/);
  const list = issues?.length ? issues : [{ problem, fix: advice.join(' ') }];
  const count = list.length === 1 ? '1 problem' : `${list.length} problems`;
  modal(
    'Generation stopped',
    `
      <p class="issue-summary">Studio found ${count}. No new automation steps were saved.</p>
      <ol class="issue-list">${list.map(issueItem).join('')}</ol>`,
    () => {},
    'Close',
  );
  $('#dialog').classList.add('issue-dialog');
}

function renderGenerationError() {
  if (aiMissingRouteError) {
    return `<p class="notice error" role="alert">Generation is not available on this server: ${esc(aiMissingRouteError)}</p>`;
  }
  const job = currentGeneration();
  const hasFailed = ['failed', 'interrupted', 'cancelled'].includes(job?.status);
  if (pendingGenerations.has(project?.id) || !hasFailed) return '';
  return `
    <p class="notice error" role="alert">${esc(job.error)} No new automation steps were saved by this attempt.
      <button type="button" class="mini-link" data-action="generation-details">View details</button>
    </p>`;
}

function aiEngineInfo(studioName) {
  const engine = aiEngineChoice();
  const isCloud = engine === 'claude' || engine === 'chatgpt';
  const cloudName = engine === 'claude' ? 'Claude' : 'ChatGPT';
  return {
    engine,
    isCloud,
    name: isCloud ? cloudName : studioName,
    model: isCloud ? settings.userAi?.models?.[engine] || '' : settings.model,
    isReady: isCloud ? Boolean(settings.userAi?.hasApiKey?.[engine]) : settings.hasApiKey,
  };
}

function renderAiEngine(engine, studioName) {
  const keys = settings.userAi?.hasApiKey || {};
  const choices = [
    { id: 'studio', name: `Studio model settings · ${studioName}` },
    { id: 'claude', name: `Claude — my API key${keys.claude ? '' : ' (not connected)'}` },
    { id: 'chatgpt', name: `ChatGPT — my API key${keys.chatgpt ? '' : ' (not connected)'}` },
  ];
  const hint = engine.isCloud
    ? `Uses your own ${esc(engine.name)} key and model from <a href="/account#ai">My account</a>. Selected read-only MCP tools are offered to ${esc(engine.name)} for context. ReasonX agent review is not used.`
    : 'Uses the shared Model settings managed by your administrator. Set a personal default in <a href="/account#ai">My account</a>.';
  return `
    <label class="ai-engine">Generation engine
      <select id="ai-engine" aria-label="Generation engine" ${generating ? 'disabled' : ''}>${options(choices, engine.engine)}</select>
    </label>
    <p class="form-hint">${hint}</p>`;
}

function renderAgentOptions() {
  const agent = project.agentOptions || {};
  const isReasonx = settings.provider === 'reasonx';
  const inherit = { id: '', name: 'Use Model settings' };
  return `
    <details>
      <summary>ReasonX agent workflow</summary>
      <label><input type="checkbox" data-agent-option="enabled" ${agent.enabled ? 'checked' : ''} ${isReasonx ? '' : 'disabled'}>Use ReasonX agents</label>
      <p class="form-hint">${isReasonx ? 'Analyze, generate, review and repair a draft before applying it.' : 'Choose ReasonX in Model settings to enable this workflow.'} When disabled, the existing generator saves steps directly.</p>
      <label>Agent model<select aria-label="Agent model" data-agent-option="model">${options([inherit, ...StudioReasonx.modelOptions], agent.model || '')}</select></label>
      <label>Agent reasoning mode<select aria-label="Agent reasoning mode" data-agent-option="mode">${options([inherit, ...StudioReasonx.modeOptions], agent.mode || '')}</select></label>
      <label>Repair limit<input type="number" data-agent-option="repairLimit" min="0" max="3" value="${esc(agent.repairLimit ?? 1)}"></label>
      <label>Agent workflow guidance (optional)<textarea aria-label="Agent workflow guidance (optional)" data-agent-option="guidance" maxlength="1000" rows="2">${esc(agent.guidance || '')}</textarea></label>
      <p class="form-hint">Preferences only. Validation and permissions always apply. Saved with this project.</p>
      <button data-action="save-agent-options">Save agent options</button>
    </details>`;
}

function renderAgentPreview() {
  const preview = (state.agentDrafts || []).find((item) => item.projectId === project.id);
  if (!preview) return '';
  const steps = preview.draft.steps.map(
    (step) => `<li><strong>${esc(step.name || step.action)}</strong> - ${esc(step.action)} ${esc(step.target || '')} ${esc(step.value || '')}</li>`,
  );
  const coverage = (preview.draft.coverage || []).map((item) => `<li>${esc(item.status)}: ${esc(item.text)}</li>`);
  return `
    <section class="panel">
      <div class="panel-head"><h2>Review agent draft</h2></div>
      <div class="panel-body">
        <p>These steps have not been applied or executed. Applying replaces the selected case automation, or creates a new case.</p>
        <p>${esc(preview.draft.explanation)}</p>
        <ol>${steps.join('')}</ol>
        <ul>${coverage.join('')}</ul>
        <p>${(preview.warnings || []).map(esc).join(' ')}</p>
        <button class="primary" data-action="apply-agent-draft" ${generating ? 'disabled' : ''}>Apply reviewed draft</button>
      </div>
    </section>`;
}

function aiNotices(engine) {
  const isGoogle = settings.provider === 'google';
  const notices = [];
  if (engine.isCloud && !engine.isReady) {
    notices.push(`<div class="notice">Add your ${engine.name} API key in <a href="/account#ai">My account › AI test generation</a> to generate with ${engine.name}.</div>`);
  }
  if (!engine.isCloud && !settings.hasApiKey && settingsStatus === 'loaded') {
    const geminiLink = isGoogle
      ? '<a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener noreferrer">Create a Gemini API key ↗</a>'
      : '';
    notices.push(`<div class="notice">Add a ${engine.name} API key in Settings to generate tests. ${geminiLink}</div>`);
  }
  if (aiBillingBlocked && settings.provider === 'openai') {
    notices.push('<div class="notice error">Your OpenAI API key works, but the account has no API credits. <a href="https://platform.openai.com/settings/organization/billing/overview" target="_blank" rel="noopener noreferrer">Open OpenAI API billing ↗</a></div>');
  }
  if (aiQuotaBlocked && isGoogle) {
    notices.push('<div class="notice error">Gemini has reached the current free-tier quota or rate limit. Check your Google AI Studio usage and retry after the quota resets. <a href="https://aistudio.google.com/" target="_blank" rel="noopener noreferrer">Open Google AI Studio ↗</a></div>');
  }
  return notices.join('');
}

// The kept-step count, or 0 when the selected step no longer exists in the target case.
function regenerateFromStep() {
  const steps = project.tests.find((test) => test.id === aiTargetId)?.steps || [];
  return aiRegenerateFrom > 0 && aiRegenerateFrom < steps.length ? aiRegenerateFrom : 0;
}

function renderRegenerateFrom() {
  const steps = project.tests.find((test) => test.id === aiTargetId)?.steps || [];
  if (steps.length < 2) return '';
  const choices = steps
    .slice(1)
    .map((step, offset) => ({ id: String(offset + 1), name: `Step ${offset + 2}: ${step.name || ACTION_LABELS[step.action] || step.action}` }));
  return `
    <label for="ai-regenerate-from">Regenerate from</label>
    <select id="ai-regenerate-from">
      ${options([{ id: '0', name: 'All steps' }, ...choices], String(regenerateFromStep()))}
    </select>`;
}

function renderAiComposer(engine, studioName) {
  const keptCount = aiTargetId ? regenerateFromStep() : 0;
  let scopeHint = 'Creates a new test case.';
  if (project.agentOptions?.enabled && !engine.isCloud) scopeHint = 'Creates a draft for review before applying changes.';
  else if (keptCount) scopeHint = `Keeps steps 1–${keptCount} and replaces step ${keptCount + 1} onward. Requirements and case number are preserved.`;
  else if (aiTargetId) scopeHint = 'Replaces the automation steps in this case. Requirements and case number are preserved.';
  let generateLabel = aiTargetId ? 'Generate steps' : 'Generate test';
  if (keptCount) generateLabel = `Regenerate from step ${keptCount + 1}`;
  if (generating) generateLabel = 'Inspecting and creating…';
  return `
    <section class="panel">
      <div class="panel-head">
        <h2>What would you like to test?</h2>
        <span class="badge neutral">${settingsStatus === 'failed' ? 'Settings not loaded' : `${esc(engine.model)} · ${esc(engine.name)}`}</span>
      </div>
      <div class="panel-body">
        ${renderAiEngine(engine, studioName)}
        ${engine.isCloud ? '' : renderAgentOptions()}
        ${aiTargetId ? renderRegenerateFrom() : ''}
        <label for="ai-prompt">Workflow description</label>
        <textarea id="ai-prompt" class="ai-prompt" placeholder="Open https://my-app.com/login. Enter a username and password, click Sign in, and verify that the Dashboard heading is visible." maxlength="${MAX_PROMPT_LENGTH}">${esc(aiPrompt)}</textarea>
        <div class="prompt-examples">
          <button data-action="prompt-example" data-example="demo">Welcome form</button>
          <button data-action="prompt-example" data-example="login">Sign-in flow</button>
          <button data-action="prompt-example" data-example="search">Search results</button>
        </div>
        <div class="inline-actions">
          <button class="primary" data-action="generate-ai" ${generating || !engine.isReady ? 'disabled' : ''}>${generateLabel}</button>
          <small>${scopeHint} Run manually after review. <kbd>Ctrl Enter</kbd></small>
          <span class="prompt-count" id="ai-prompt-count">${aiPrompt.length}/${MAX_PROMPT_LENGTH}</span>
        </div>
        ${renderAiProgress()}
        ${renderGenerationError()}
        ${renderAgentPreview()}
        <p class="form-hint">Your prompt, repository locators, and variable names are sent to ${esc(engine.name)}. Stored variable values and database credentials are excluded. Selected read-only MCP results are also sent to ${esc(engine.name)}.</p>
      </div>
    </section>`;
}

function renderContextToolRow(server) {
  const tools = mcpTools.get(server.id);
  const safeCount = tools?.filter((tool) => tool.annotations?.readOnlyHint === true).length || 0;
  let detail = 'Open MCP servers and choose “Connect & discover” first.';
  if (safeCount) detail = `${safeCount} read-only tools available`;
  else if (tools) detail = 'No tools marked read-only. Open the server page to discover tools.';
  return `
    <label class="setting-row setting-choice ${safeCount ? '' : 'is-disabled'}">
      <input type="checkbox" data-action="toggle-ai-mcp" data-id="${esc(server.id)}" ${aiMcpIds.has(server.id) ? 'checked' : ''} ${safeCount ? '' : 'disabled'}>
      <span class="setting-choice-text"><strong>${esc(server.name)}</strong><small>${esc(detail)}</small></span>
      <span class="badge neutral">${esc(server.transport.toUpperCase())}</span>
    </label>`;
}

function renderContextTools() {
  const reasonxNote =
    settings.provider === 'reasonx'
      ? '<p class="form-hint">ReasonX can gather context from selected read-only MCP tools before drafting steps. Up to three tool calls are used; keep workflows short for the local model.</p>'
      : '';
  const rows = settings.mcpServers.length
    ? settings.mcpServers.map(renderContextToolRow).join('')
    : '<p class="form-hint">Add an MCP server to connect read-only app and documentation tools.</p>';
  return `
    <section class="panel">
      <div class="panel-head">
        <div>
          <h2>Context tools</h2>
          <p class="subtitle">Select servers for AI. Up to 25 tools marked read-only by their server are used, in server order.</p>
        </div>
        <button data-action="view" data-view="mcp">Manage servers →</button>
      </div>
      <div class="panel-body">${reasonxNote}${rows}</div>
    </section>`;
}

function renderDraftResult() {
  if (!draft || draftProjectId !== project.id) return '';
  const notes = String(draft.explanation || '')
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `<li>${esc(line)}</li>`)
    .join('');
  const steps = draft.steps.map(
    (step, index) => `
      <div class="draft-step">
        <span class="count">${index + 1}</span>
        <div>
          <strong>${esc(step.name)}</strong>
          <small>${esc(ACTION_LABELS[step.action])} ${step.target ? `· ${esc(step.target)}` : ''} ${step.value ? `→ ${esc(step.value)}` : ''}</small>
        </div>
      </div>`,
  );
  return `
    <section class="panel">
      <div class="panel-head">
        <div>
          <h2>${esc(draft.name)}</h2>
          <p class="subtitle">${draft.steps.length} saved steps · not run</p>
        </div>
        <button class="primary" data-action="open-ai-test">Open test editor</button>
      </div>
      <div class="panel-body">
        <ul class="draft-notes">${notes}</ul>
        ${steps.join('')}
      </div>
    </section>`;
}

function renderAi() {
  const studioName = providerInfo().short;
  const engine = aiEngineInfo(studioName);
  const target = project.tests.find((test) => test.id === aiTargetId);
  const subtitle = aiTargetId
    ? `Generate automation for ${target?.name || 'the selected case'}.`
    : 'Describe your workflow. Inspect the website and save an editable test case.';
  return `
    ${heading(
      'FROM REQUIREMENTS TO AUTOMATION',
      aiTargetId ? 'Auto generator' : 'AI Assistance',
      subtitle,
      '<button data-action="view" data-view="settings">Model settings</button>',
    )}
    ${settingsNotice()}
    <div class="ai-hero">
      <span class="ai-symbol">✧</span>
      <div>
        <h2>Describe the workflow. Give AI the right tools.</h2>
        <p>The built-in MCP server inspects the initial page and checks generated steps. Agent mode presents a draft for review before applying it. Locators are checked for a unique match. Later-page locators need review. You choose when to run it. Optional MCP tools can provide more context.</p>
      </div>
    </div>
    ${aiNotices(engine)}
    ${settings.provider === 'reasonx' ? renderReasonxStatus() : renderReasonxOffer()}
    ${renderAiComposer(engine, studioName)}
    ${renderContextTools()}
    ${renderDraftResult()}`;
}

/* ---------- Dialogs ---------- */

function editNamed(kind, title, extra = {}) {
  const isFolder = kind === 'folders';
  const isTest = kind === 'tests';
  if (isFolder && !state.features?.nestedFolders) {
    throw new Error('Restart QA Studio using Start QA Studio.cmd to create folders.');
  }
  let picker = '';
  if (isFolder) {
    picker = `<label>Parent folder<select name="parentId" aria-label="Parent folder">${options(StudioFolders.choices(project.folders), extra.parentId, 'Workspace root')}</select></label>`;
  } else if (isTest) {
    picker = `<label>Folder<select name="folderId" aria-label="Folder">${options(StudioFolders.choices(project.folders), extra.folderId, 'No folder')}</select></label>`;
  }
  modal(
    title,
    field('name', 'Name', '', 'text', 'required maxlength="120"') + picker,
    (values) => {
      const name = values.name.trim();
      if (!name) throw new Error('Name is required');
      const parentId = isFolder ? values.parentId || null : null;
      const isDuplicate = project[kind].some(
        (item) => item.name.toLowerCase() === name.toLowerCase() && (!isFolder || (item.parentId || null) === parentId),
      );
      if (isDuplicate) throw new Error('That name already exists in this folder');

      const item = { id: uid(), name, ...extra };
      if (isFolder) item.parentId = parentId;
      if (isTest) item.folderId = values.folderId || null;
      project[kind].push(item);
      markDirty();

      if (isTest || kind === 'prerequisites' || kind === 'processes') {
        selectedId = item.id;
        selectedKind = kind;
        view = 'editor';
      }
      if (isFolder) activeFolderId = item.id;
      if (isTest) activeFolderId = item.folderId;
      render();
    },
    'Create',
  );
}

function openTestOptions(test) {
  const body = `
    ${field('timeout', 'Default project timeout (ms)', project.timeoutMs || 10000, 'number', 'min="100" max="120000" required')}
    ${jsonField('dataRows', 'Dataset (JSON array of objects with text values)', test.dataRows || [])}
    <label>Optional CSV dataset (overrides JSON)<textarea name="csv" placeholder="NAME,EMAIL"></textarea></label>
    <label>Additional suites<select name="suites" multiple>${options(project.suites)}</select></label>
    <p>Use the Data row value source and a column name in your steps. Each row executes in a fresh browser context.</p>
    <label><input type="checkbox" name="trace"> Save and run with trace (may include page content and sensitive network data)</label>`;
  modal('Test options', body, async (values) => {
    project.timeoutMs = Number(values.timeout);
    test.dataRows = values.csv?.trim()
      ? (await api('/api/datasets/csv', 'POST', { csv: values.csv })).rows
      : parseJson(values.dataRows, 'Dataset');
    test.additionalSuiteIds = [...$('[name="suites"]').selectedOptions].map((option) => option.value);
    markDirty();
    await save();
    if (values.trace) await run({ testId: test.id, trace: true });
    else render();
  });
  document.querySelectorAll('[name="suites"] option').forEach((option) => {
    option.selected = Boolean(test.additionalSuiteIds?.includes(option.value));
  });
}

function openStepOptions(step) {
  const canWait = WAITING_ACTIONS.has(step.action);
  const waitFields = canWait
    ? `
      <label>After action<select name="waitAfter">${options(WAIT_POLICIES, step.waitAfter || 'auto')}</select></label>
      ${field('waitForUrl', 'Expected destination URL (optional)', step.waitForUrl || '', 'text', 'placeholder="**/dashboard" maxlength="2000"')}
      <p class="form-hint">For delayed redirects, choose Wait for redirect. An optional URL or pattern such as **/dashboard waits for that destination. The timeout above limits this wait.</p>`
    : '';
  const body = `
    ${field('elementName', 'Element label', step.elementName || '', 'text', 'maxlength="120"')}
    ${field('timeout', 'Timeout override (ms)', step.timeoutMs || project.timeoutMs || 10000, 'number', 'min="100" max="120000" required')}
    ${waitFields}
    ${field('tab', 'Browser tab index (first tab is 0)', step.pageIndex || 0, 'number', 'min="0" max="19" required')}
    ${field('pageUrl', 'Page URL (context)', step.pageUrl || '')}
    ${field('container', 'Container selector (optional CSS)', step.container || '')}
    ${jsonField('frames', 'Frame selector path', step.framePath || (step.frame ? [step.frame] : []))}
    ${jsonField('selectValues', 'Multiple selection values (empty uses normal Value)', step.selectValues || [])}
    <label><input type="checkbox" name="sensitive" ${step.sensitive ? 'checked' : ''}>Sensitive input (protect stored value and mask element in screenshots)</label>`;
  modal('Step settings', body, (values) => {
    const framePath = parseJson(values.frames, 'Frame path');
    const selectValues = parseJson(values.selectValues, 'Selection');
    step.elementName = values.elementName;
    if (canWait) {
      step.waitAfter = values.waitAfter;
      if (values.waitAfter === 'redirect' && values.waitForUrl.trim()) step.waitForUrl = values.waitForUrl.trim();
      else delete step.waitForUrl;
    }
    step.timeoutMs = Number(values.timeout);
    step.pageIndex = Number(values.tab);
    step.pageUrl = values.pageUrl;
    step.container = values.container;
    step.framePath = framePath;
    delete step.frame;
    if (selectValues.length) step.selectValues = selectValues;
    else delete step.selectValues;
    step.sensitive = Boolean(values.sensitive);
    markDirty();
    render();
  });
}

function openExpectedRows(step) {
  const body = `
    ${jsonField('rows', 'Rows (JSON arrays of strings)', step.expectedRows || [])}
    <p class="form-hint">Example: [["1", "Alex"]]. Use "NULL" for database nulls. Run a query in PostgreSQL connections to inspect actual results.</p>`;
  modal('Expected database results', body, (values) => {
    const rows = parseJson(values.rows, 'Expected rows');
    const isValid = Array.isArray(rows) && rows.every((row) => Array.isArray(row) && row.every((cell) => typeof cell === 'string'));
    if (!isValid) throw new Error('Use arrays of string cells');
    step.expectedRows = rows;
    markDirty();
    render();
  });
}

function updateObjectPreview() {
  const values = Object.fromEntries(new FormData($('#dialog-form')));
  try {
    const planned = StudioLocators.prepareObjectLocator(project, values);
    $('#dialog-body [name="name"]').value = StudioLocators.genericName(planned.type, planned.templateSelector);
    $('#object-preview').textContent = `Template: ${planned.templateSelector}`;
  } catch (error) {
    $('#object-preview').textContent = error.message;
  }
}

function editObject(id, initial = {}) {
  const previous = project.objects.find((object) => object.id === id);
  const object = previous || initial;
  const template = StudioLocators.definition(object, project.locatorTemplates);
  const activeTest = selectedKind === 'tests' && selected();
  const ownerId = previous?.testCaseId || (activeTest ? StudioLocators.caseId(activeTest) : '');
  const owners = project.tests.map((test) => ({ id: StudioLocators.caseId(test), name: test.name }));
  const locatorTypes = [
    { id: 'xpath', name: 'XPath' },
    { id: 'css', name: 'CSS' },
  ];
  const body = `
    <label>Test case
      <select aria-label="Test case" name="testCaseId" required ${previous ? 'disabled' : ''}>${options(owners, ownerId, 'Select a test case')}</select>
    </label>
    ${field('name', 'Element name', object.name || '', 'text', 'readonly')}
    <label>Locator type<select name="locatorType">${options(locatorTypes, template.locatorType || 'xpath')}</select></label>
    <label>Locator template<textarea aria-label="Locator template" name="selector" required>${esc(template.selector)}</textarea></label>
    <p class="form-hint">Replacement values, field labels, and execution context belong to steps in the Test Case Editor. Editing this mapping affects only its owning test case.</p>
    <p class="form-hint" id="object-preview" role="status"></p>`;
  modal(previous ? 'Edit repository object' : 'New repository object', body, (values) => {
    const next = structuredClone(project);
    StudioLocators.saveObject(
      next,
      {
        id,
        testCaseId: previous?.testCaseId || values.testCaseId,
        locatorType: values.locatorType,
        selector: values.selector,
      },
      uid,
    );
    project = next;
    markDirty();
    render();
  });
  $('#dialog-body').querySelectorAll('input,select,textarea').forEach((node) => {
    node.addEventListener('input', updateObjectPreview);
  });
  updateObjectPreview();
}

// Prefers an id, then a name, otherwise the tag. Quotes pick whichever the value does not contain.
function xpathFromElement(element) {
  const literal = (value) => {
    if (!value.includes("'")) return `'${value}'`;
    return value.includes('"') ? null : `"${value}"`;
  };
  const tag = element.tagName.toLowerCase();
  const id = element.id && literal(element.id);
  if (id) return `//*[@id=${id}]`;
  const nameAttribute = element.getAttribute('name');
  const name = nameAttribute && literal(nameAttribute);
  return name ? `//${tag}[@name=${name}]` : `//${tag}`;
}

function openConvertHtml() {
  const body = `
    <label>Copied element HTML<textarea name="html" required placeholder="&lt;button id=&quot;submit&quot;&gt;Continue&lt;/button&gt;"></textarea></label>
    <p class="form-hint">The converter suggests a locator; verify its uniqueness in your application.</p>`;
  modal(
    'Convert element HTML',
    body,
    (values) => {
      const element = new DOMParser().parseFromString(values.html, 'text/html').body.firstElementChild;
      if (!element) throw new Error('Paste an HTML element');
      const name = element.id || element.getAttribute('name') || element.tagName.toLowerCase();
      // The next dialog opens after this one has closed.
      setTimeout(() => editObject(null, { name, xpath: xpathFromElement(element) }), 0);
    },
    'Create locator',
  );
}

function validateVariables(variables) {
  const isValid =
    variables &&
    typeof variables === 'object' &&
    !Array.isArray(variables) &&
    Object.entries(variables).every(
      ([name, value]) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name) && typeof value === 'string',
    );
  if (!isValid) throw new Error('Use an object with valid variable names and string values');
}

function editEnvironment(id) {
  const previous = project.environments.find((environment) => environment.id === id);
  const body = `
    ${field('name', 'Environment name', previous?.name || '', 'text', 'required maxlength="120"')}
    ${jsonField('variables', 'Variables (JSON object)', previous?.variables || {})}
    <p class="form-hint">Example: { "BASE_URL": "https://example.com" }. Values must be strings.</p>`;
  modal(previous ? 'Edit environment' : 'New environment', body, (values) => {
    const variables = parseJson(values.variables, 'Variables');
    validateVariables(variables);
    const name = values.name.trim();
    const isDuplicate = project.environments.some(
      (environment) => environment.id !== id && environment.name.toLowerCase() === name.toLowerCase(),
    );
    if (isDuplicate) throw new Error('Environment name already exists');
    const item = { id: id || uid(), name, variables };
    if (previous) Object.assign(previous, item);
    else project.environments.push(item);
    project.activeEnvironmentId ||= item.id;
    markDirty();
    render();
  });
}

function editProfile(id) {
  const previous = project.jdbcProfiles.find((profile) => profile.id === id);
  const profile = previous || {};
  const tlsModes = [
    { id: 'disable', name: 'Disabled' },
    { id: 'require', name: 'Required (verify certificate)' },
  ];
  const body = `
    <div class="form-grid">
      ${field('name', 'Connection name', profile.name || '', 'text', 'required')}
      ${field('host', 'Host', profile.host || 'localhost', 'text', 'required')}
      ${field('port', 'Port', profile.port || 5432, 'number', 'required min="1" max="65535"')}
      ${field('database', 'Database', profile.database || '', 'text', 'required')}
      ${field('username', 'Username', profile.username || '', 'text', 'required')}
      ${field('password', 'Password', profile.password || '', 'password')}
      <label>TLS<select name="sslmode">${options(tlsModes, profile.sslmode || 'disable')}</select></label>
    </div>`;
  modal(previous ? 'Edit PostgreSQL connection' : 'New PostgreSQL connection', body, (values) => {
    const item = { ...values, id: id || uid(), port: Number(values.port) };
    if (previous) Object.assign(previous, item);
    else project.jdbcProfiles.push(item);
    project.activeJdbcProfileId ||= item.id;
    markDirty();
    render();
  });
}

function openProfileQuery(profile) {
  const body = `
    <label>SELECT statement<textarea name="query" required placeholder="SELECT id, name FROM users"></textarea></label>
    <pre class="output" id="query-result">Results appear here.</pre>`;
  modal(
    `Query ${profile.name}`,
    body,
    async (values) => {
      const result = await api('/api/jdbc/query', 'POST', {
        projectId: project.id,
        profileId: profile.id,
        profile,
        query: values.query,
      });
      $('#query-result').textContent = JSON.stringify(result, null, 2);
      return false;
    },
    'Run query',
  );
}

function openMcpTool(serverId, tool) {
  const description = tool.description || 'This tool may modify data in the connected service. Review its inputs before calling.';
  const body = `
    <p class="form-hint">${esc(description)}</p>
    <details>
      <summary>Input schema</summary>
      <pre class="code">${esc(JSON.stringify(tool.inputSchema, null, 2))}</pre>
    </details>
    ${jsonField('arguments', 'Tool arguments', {})}
    <pre class="output" id="tool-result">Tool has not been called.</pre>`;
  modal(
    tool.name,
    body,
    async (values) => {
      const args = parseJson(values.arguments, 'Arguments');
      const result = await api(`/api/mcp/${serverId}/call`, 'POST', { name: tool.name, arguments: args });
      $('#tool-result').textContent = JSON.stringify(result, null, 2);
      return false;
    },
    'Call tool',
  );
}

function openRecordWeb(test) {
  const environment = project.environments.find((item) => item.id === project.activeEnvironmentId);
  const defaultUrl = environment?.variables.BASE_URL || project.globalVariables.BASE_URL || `${location.origin}/demo`;
  const projectId = project.id;
  const body = `
    ${field('url', 'Starting URL', defaultUrl, 'url', 'required')}
    <p class="form-hint">A new browser opens. Password inputs become the RECORDED_PASSWORD environment variable. Other typed values are recorded.</p>
    <p class="notice error" id="record-start-error" role="alert" hidden></p>`;
  modal(
    'Record Web',
    body,
    async (values) => {
      try {
        state.activeRecording = await api('/api/recordings', 'POST', { projectId, testId: test.id, url: values.url });
      } catch (error) {
        if (!isMissingRoute(error)) throw error;
        const message = $('#record-start-error');
        message.textContent = `Recording is not available on this server: ${error.message}`;
        message.hidden = false;
        return false;
      }
      navigate('recording');
      return true;
    },
    'Start recording',
  );
}

/* ---------- Case and project operations ---------- */

function copyName(sourceName) {
  const base = sourceName.slice(0, COPY_NAME_LENGTH);
  const names = new Set(project.tests.map((test) => test.name.toLocaleLowerCase()));
  let suffix = ' (copy)';
  for (let number = 2; names.has((base + suffix).toLocaleLowerCase()); number++) suffix = ` (copy ${number})`;
  return base + suffix;
}

function copyTestCase(source) {
  const clone = structuredClone(source);
  clone.id = uid();
  clone.inTestPlan = false;
  delete clone.tcNumber;
  delete clone.qaCaseId;
  delete clone.automation;
  clone.name = copyName(source.name);
  project.tests.push(clone);
  // The copy owns its own repository mappings, so later edits do not reach the original.
  for (const step of clone.steps) {
    if (step.locatorType !== 'object') continue;
    const object = project.objects.find((item) => item.id === step.target);
    if (!object) continue;
    const template = StudioLocators.definition(object, project.locatorTemplates);
    step.target = StudioLocators.saveObject(
      project,
      { testCaseId: clone.id, locatorType: template.locatorType, selector: template.selector },
      uid,
    ).id;
  }
  selectedId = clone.id;
  selectedKind = 'tests';
  markDirty();
  render();
  notify('Test case copied. Save the workspace to keep the copy.');
}

async function deleteTestCase(source) {
  await save();
  const previous = structuredClone(project);
  project.tests = project.tests.filter((test) => test.id !== source.id);
  if (selectedId === source.id) selectedId = project.tests[0]?.id || null;
  selectedKind = 'tests';
  markDirty();
  try {
    await save();
  } catch (error) {
    project = previous;
    dirty = false;
    selectedId = source.id;
    render();
    throw error;
  }
  if (draft?.id === source.id) {
    draft = null;
    aiTargetId = null;
    aiRegenerateFrom = 0;
  }
  render();
  notify('Automation case deleted. The QA Studio case and run history are preserved.');
}

function deleteProcess(item) {
  project.processes = project.processes.filter((other) => other.id !== item.id);
  selectedId = null;
  selectedKind = 'tests';
  markDirty();
  navigate('processes');
}

function deletePrerequisite(item) {
  project.prerequisites = project.prerequisites.filter((other) => other.id !== item.id);
  for (const test of project.tests) {
    if (test.prerequisiteId === item.id) test.prerequisiteId = null;
  }
  selectedId = project.prerequisites[0]?.id;
  markDirty();
  render();
}

function projectForExport() {
  const exported = structuredClone(project);
  const blankValues = (variables) => Object.fromEntries(Object.keys(variables).map((name) => [name, '']));
  exported.globalVariables = blankValues(exported.globalVariables);
  for (const environment of exported.environments) environment.variables = blankValues(environment.variables);
  for (const profile of exported.jdbcProfiles) profile.password = '';
  for (const test of [...exported.tests, ...exported.prerequisites]) {
    test.dataRows = [];
    test.localTestData = (test.localTestData || []).map((entry) => ({
      name: entry.name,
      value: '',
      source: 'manual',
      config: {},
      keepGlobal: entry.keepGlobal,
    }));
    for (const step of test.steps) {
      if (step.sensitive && step.valueMode === 'static') step.value = '';
    }
  }
  return exported;
}

function openProject(next) {
  project = structuredClone(next);
  selectedKind = 'tests';
  dirty = false;
}

function importRecordingSteps(recording, mode) {
  if (project.id !== recording.projectId) throw new Error('Switch to the recording project before importing.');
  const isProcess = recording.kind === 'process';
  const target = (isProcess ? project.processes : project.tests).find((item) => item.id === recording.testId);
  if (!target) throw new Error(isProcess ? 'The recorded process was deleted.' : 'The recorded test was deleted.');
  const isAppend = mode === 'append';
  const steps = isAppend ? [...target.steps, ...recording.steps] : recording.steps;
  if (steps.length > MAX_RECORDED_STEPS) {
    throw new Error('Tests support at most 1000 steps. Replace steps or shorten the test before appending.');
  }
  const previousCount = target.steps.length;
  target.steps = structuredClone(steps);
  // Process steps keep their recorded locators; the object repository belongs to test cases.
  for (const step of isProcess ? [] : target.steps.slice(isAppend ? previousCount : 0)) {
    if (!['css', 'xpath'].includes(step.locatorType) || !step.target) continue;
    StudioLocators.saveStepObject(project, StudioLocators.caseId(target), step, uid);
  }
  selectedId = target.id;
  selectedKind = isProcess ? 'processes' : 'tests';
  markDirty();
}

/* ---------- Actions ---------- */

async function startDebug(test) {
  if (!test || selectedKind !== 'tests') throw new Error('Select a test case to debug first.');
  if (debugUnavailable()) return;
  startingDebug = true;
  updateStatus();
  try {
    await save();
    const session = await api('/api/debug', 'POST', { projectId: project.id, testId: test.id });
    state.activeDebug = session;
    state.runs.unshift({
      id: session.id,
      projectId: session.projectId,
      projectName: project.name,
      browser: session.browser,
      startedAt: new Date().toISOString(),
      status: 'running',
      tests: [
        {
          ...structuredClone(test),
          status: 'pending',
          steps: test.steps.map((step) => ({ ...step, status: 'pending' })),
        },
      ],
    });
    navigate('debug');
    notify('Debug browser opened. Advance one action at a time.');
  } finally {
    startingDebug = false;
    updateStatus();
  }
}

async function closeDebug() {
  if (startingDebug || stoppingDebug) return;
  const session = state.activeDebug;
  if (!session) return;
  stoppingDebug = true;
  updateStatus();
  try {
    await api(`/api/debug/${session.id}/close`, 'POST', {});
    state.activeDebug = null;
    await refreshRuns();
    navigate('history');
    notify('Debug browser closed.');
  } finally {
    stoppingDebug = false;
    updateStatus();
  }
}

async function stepDebug() {
  // The server runs one step at a time, so a second click while a step runs only fails.
  if (steppingDebug || stoppingDebug) return;
  const session = state.activeDebug;
  if (!session) throw new Error('No active debug session.');
  steppingDebug = true;
  updateStatus();
  try {
    await api(`/api/debug/${session.id}/step`, 'POST', {});
    await refreshRuns();
  } finally {
    steppingDebug = false;
    updateStatus();
  }
  if (state.activeDebug?.status === 'failed') {
    notify('Step failed. Inspect the browser, screenshot, and error.', true);
  } else if (state.activeDebug?.status === 'passed') {
    notify('All test steps passed. Close the debug session when finished.');
  }
  render();
}

function moveStep(test, index, direction) {
  const target = index + direction;
  if (target < 0 || target >= test.steps.length) return;
  const [step] = test.steps.splice(index, 1);
  test.steps.splice(target, 0, step);
  editorPage = Math.floor(target / editorSize);
  markDirty();
  render();
}

function unmapFromSuite(testId, suiteId) {
  const member = project.tests.find((test) => test.id === testId);
  if (member.suiteId === suiteId) member.suiteId = null;
  member.additionalSuiteIds = (member.additionalSuiteIds || []).filter((id) => id !== suiteId);
  markDirty();
  const openSuites = [...document.querySelectorAll('.suite[open]')].map((node) => node.dataset.suite);
  $('#content').innerHTML = renderSuites();
  document.querySelectorAll('.suite').forEach((node) => {
    node.open = openSuites.includes(node.dataset.suite);
  });
  document.querySelector(`[data-suite="${CSS.escape(suiteId)}"] summary`)?.focus();
}

async function refreshMcpServer(button, id, route, busyText, idleText, successMessage) {
  mcpTools.delete(id);
  button.disabled = true;
  button.textContent = busyText;
  try {
    const result = await api(`/api/mcp/${id}/${route}`, 'POST', {});
    mcpTools.set(id, result.tools);
    render();
    notify(successMessage(result.tools.length));
  } catch (error) {
    render();
    throw error;
  } finally {
    if (document.contains(button)) {
      button.disabled = false;
      button.textContent = idleText;
    }
  }
}

function requireAdmin(message) {
  if (!isAdmin()) throw new Error(message);
}

async function startReasonx() {
  requireAdmin('Only an administrator can start ReasonX.');
  if (reasonxStarting) return;
  reasonxStarting = true;
  render();
  try {
    const result = await api('/api/ai/reasonx/start', 'POST', {});
    const isSelected = settings.provider === 'reasonx';
    if (isSelected) {
      aiStatus = null;
      await loadAiStatus();
    }
    let message = 'ReasonX is running. Save a valid ReasonX API key in Model settings.';
    if (result.status === 'starting') message = result.message;
    else if (!isSelected) message = 'ReasonX is running. Select Use ReasonX agents to use it in both studios.';
    else if (aiStatus?.authorized) message = 'ReasonX is running. Keep Ollama running for generation.';
    notify(message);
  } finally {
    reasonxStarting = false;
    if (view === 'ai') render();
  }
}

async function checkAiStatus() {
  aiStatus = null;
  render();
  await loadAiStatus();
  if (aiStatus?.reachable && aiStatus.authorized) {
    notify(`ReasonX is ready: ${(aiStatus.models || []).join(', ')}`);
  } else if (aiStatus?.reachable === false) {
    notify(`ReasonX is not reachable at ${settings.reasonxBaseUrl || REASONX_BASE_URL}`, true);
  } else if (aiStatus && !aiStatus.error && !aiStatus.authorized) {
    notify('ReasonX rejected the saved API key', true);
  }
}

function promptExamples() {
  return {
    demo: `Open ${location.origin}/demo, fill the Your name field with Alex, click Get started, and verify that the message contains Welcome, Alex!`,
    login:
      'Open the sign-in page at https://example.com/login. Fill the Username and Password fields using environment variables USERNAME and PASSWORD. Click Sign in, then check that the Dashboard heading is visible.',
    search:
      'Open https://example.com. Fill the Search field with automation, press Enter, and check that the Search results heading is visible.',
  };
}

const ACTIONS = {
  'close-dialog': () => $('#dialog').close(),
  'generation-details': () => {
    const job = currentGeneration();
    showGenerationIssues(job?.error || 'Generation failed. Try again.', job?.issues);
  },
  view: async ({ button }) => {
    const next = button.dataset.view;
    if (next === 'history') {
      await save();
      navigate('history');
      void loadCaseHistory();
      return;
    }
    navigate(next);
    if (next === 'vpn') await loadVpn();
  },
  save: async () => {
    $('#toast').hidden = true;
    await save();
    notify('Workspace saved');
    render();
  },
  'new-project': () => {
    modal(
      'Create a project',
      field('name', 'Project name', '', 'text', 'required maxlength="120"'),
      async (values) => {
        await save();
        const created = await api('/api/projects', 'POST', { name: values.name, tests: [] });
        state.projects.push(created);
        openProject(created);
        selectedId = null;
        if (view !== 'history') view = 'editor';
        render();
      },
      'Create project',
    );
  },
  'run-suite': () => navigate('suites'),
  'execute-suite': ({ id }) => run({ suiteId: id }),
  'run-test': ({ test }) => {
    if (!test || selectedKind !== 'tests') throw new Error('Select a test first');
    return run({ testId: test.id });
  },
  'replay-test': ({ test }) => {
    if (!test || selectedKind !== 'tests') throw new Error('Select a test first');
    if (state.activeRun || state.activeDebug || recordingLive()) {
      throw new Error('Finish the active run, debug session, or recording before replaying.');
    }
    return run({ testId: test.id, replay: true });
  },
  'debug-test': ({ test }) => startDebug(test),
  'debug-step': stepDebug,
  'debug-close': closeDebug,
  'inspect-locator': async () => {
    const session = state.activeDebug;
    const result = await api(`/api/debug/${session.id}/locator`, 'POST', { index: session.stepIndex });
    notify(
      result.unique
        ? 'One matching element highlighted in the browser'
        : `${result.count} matches. Edit the locator to identify exactly one element.`,
      !result.unique,
    );
  },
  preflight: async ({ test }) => {
    await save();
    const result = await api('/api/preflight', 'POST', {
      projectId: project.id,
      testId: test.id,
      checkBrowser: true,
      checkTarget: true,
    });
    const targetNote =
      result.targetSkipped || 'Browser is available and the initial target responded. This does not confirm VPN connectivity.';
    const summary = result.errors.join('\n') || `${result.testCount} test executions, ${result.stepCount} steps. ${targetNote}`;
    modal(
      'Readiness check',
      `<p>${result.ok ? 'Ready to run' : 'Needs attention'}</p><pre class="code">${esc(summary)}</pre>`,
      () => {},
      'Close',
    );
  },
  'test-options': ({ test }) => openTestOptions(test),
  'step-options': ({ test, index }) => openStepOptions(test.steps[index]),
  'expected-rows': ({ test, index }) => openExpectedRows(test.steps[index]),
  'schedule-test': async ({ test }) => {
    await save();
    const body = `
      ${field('intervalMinutes', 'Run every (minutes)', 60, 'number', 'required min="1" max="525600"')}
      <p>Runs automatically while Studio is running. Busy sessions postpone execution. After a restart, an overdue schedule runs once.</p>`;
    modal(
      'Schedule test',
      body,
      async (values) => {
        await api('/api/schedules', 'POST', {
          projectId: project.id,
          testId: test.id,
          intervalMinutes: Number(values.intervalMinutes),
        });
        notify('Schedule enabled');
      },
      'Enable schedule',
    );
  },
  'view-schedules': async () => {
    const { schedules } = await api('/api/schedules');
    const rows = schedules.map(
      (schedule) => `
        <p>
          <strong>${esc(schedule.name)}</strong> · every ${schedule.intervalMinutes} minutes · next ${esc(new Date(schedule.nextRunAt).toLocaleString())} ${schedule.lastError ? esc(schedule.lastError) : ''}
          <button type="button" data-action="delete-schedule" data-id="${esc(schedule.id)}">Remove schedule</button>
        </p>`,
    );
    modal('Scheduled tests', rows.join('') || '<p>No scheduled tests. Choose Schedule in the test editor.</p>', () => {}, 'Close');
  },
  'delete-schedule': async ({ id, button }) => {
    await api(`/api/schedules/${id}`, 'DELETE');
    button.closest('p').remove();
    notify('Schedule removed');
  },
  'history-retention': () => {
    const body = `
      ${field('keep', 'Completed runs to keep across all projects', 100, 'number', 'required min="1" max="10000"')}
      <p>Older completed runs and their screenshots/traces will be deleted. Finish active execution before cleaning history.</p>`;
    modal(
      'Clean run history',
      body,
      async (values) => {
        const result = await api('/api/history/retain', 'POST', { keep: Number(values.keep) });
        await refreshRuns();
        notify(`${result.removed} old runs removed`);
        render();
      },
      'Delete older runs',
    );
  },
  'editor-page': ({ button }) => {
    editorPage += Number(button.dataset.direction);
    refreshEditor();
  },
  'export-project': () => {
    downloadJson('studio-project.json', projectForExport());
    notify('Project exported. Variable values, datasets and marked secrets were omitted.');
  },
  'import-project': () => {
    modal(
      'Import project',
      '<label>Project JSON<textarea name="project" required></textarea></label>',
      async (values) => {
        await save();
        const input = parseJson(values.project, 'Project');
        delete input.id;
        const added = await api('/api/projects', 'POST', input);
        state.projects.push(added);
        openProject(added);
        selectedId = added.tests[0]?.id;
        view = 'editor';
        render();
      },
      'Import',
    );
  },
  'backup-workspace': async () => {
    await save();
    const result = await api('/api/backups', 'POST', {});
    notify(`Backup created: ${result.name}`);
  },
  'restore-workspace': async () => {
    const { backups } = await api('/api/backups');
    const body = `
      <p>This replaces all current project definitions with a backup. Run history is retained. A backup of current saved projects is created first. Unsaved edits will be lost.</p>
      <label>Backup<select name="name" required>${options(backups, '', 'Select backup')}</select></label>`;
    modal(
      'Restore projects',
      body,
      async (values) => {
        await api('/api/backups/restore', 'POST', values);
        location.reload();
      },
      'Restore projects',
    );
  },
  'vpn-refresh': loadVpn,
  'vpn-save': () => {
    const profileId = $('#vpn-profile').value || null;
    return vpnRequest('/api/vpn', 'PUT', { profileId }, 'VPN profile selection saved');
  },
  'vpn-connect': () => vpnRequest('/api/vpn/connect', 'POST', {}, 'Request sent. Check OpenVPN Connect to finish.'),
  'vpn-disconnect': () => vpnRequest('/api/vpn/disconnect', 'POST', {}, 'Request sent. Check OpenVPN Connect to finish.'),
  'select-test': ({ id }) => {
    activeFolderId = project.tests.find((test) => test.id === id)?.folderId || null;
    selectedId = id;
    selectedKind = 'tests';
    navigate('editor');
    void loadCaseHistory();
  },
  'directory-copy': ({ id }) => {
    const source = project.tests.find((test) => test.id === id);
    if (!source) throw new Error('Test case not found');
    copyTestCase(source);
  },
  'directory-move': ({ id }) => {
    const source = project.tests.find((test) => test.id === id);
    if (!source) throw new Error('Test case not found');
    const body = `<label>Destination folder<select name="folderId" aria-label="Destination folder">${options(StudioFolders.choices(project.folders), source.folderId, 'No folder')}</select></label>`;
    modal(`Move ${source.name}`, body, (values) => {
      source.folderId = values.folderId || null;
      markDirty();
      renderExplorer();
      if (view === 'cases') $('#content').innerHTML = renderCasesList();
      notify('Test case moved');
    });
  },
  'directory-delete': async ({ id }) => {
    const source = project.tests.find((test) => test.id === id);
    if (!source) return;
    if (!confirm(`Delete “${source.name}”? Historical results will remain.`)) return;
    await deleteTestCase(source);
  },
  'edit-prerequisite': ({ id }) => {
    selectedId = id;
    selectedKind = 'prerequisites';
    navigate('editor');
  },
  'new-test': ({ button }) => {
    const { folder, suite } = button.dataset;
    editNamed('tests', 'New test case', {
      folderId: folder === undefined ? activeFolderId || selected()?.folderId || null : folder || null,
      suiteId: suite || null,
      prerequisiteId: null,
      steps: [],
    });
  },
  'new-folder': ({ button }) => editNamed('folders', 'New folder', { parentId: button.dataset.folder || null }),
  'new-suite': () => editNamed('suites', 'New suite'),
  'new-prerequisite': () => editNamed('prerequisites', 'New prerequisite', { steps: [] }),
  'new-process': () => editNamed('processes', 'New process', { steps: [], runCount: 1 }),
  'edit-process': ({ id }) => {
    selectedId = id;
    selectedKind = 'processes';
    navigate('editor');
  },
  'record-process': async ({ id }) => {
    if (state.activeRecording) {
      navigate('recording');
      return;
    }
    await save();
    openRecordWeb(project.processes.find((item) => item.id === id));
  },
  'run-process': ({ id }) => {
    const item = project.processes.find((candidate) => candidate.id === id);
    if (!item?.steps.length) throw new Error('Record or add steps to this process before running it.');
    return run({ processId: item.id, runCount: item.runCount || 1 });
  },
  'record-web': async ({ test }) => {
    if (state.activeRecording) {
      navigate('recording');
      return;
    }
    await save();
    openRecordWeb(test);
  },
  'record-toggle': async () => {
    const recording = state.activeRecording;
    if (!recording) return;
    const action = recording.status === 'paused' ? 'resume' : 'pause';
    state.activeRecording = await api(`/api/recordings/${recording.id}/${action}`, 'POST', {});
    render();
  },
  'record-stop': async () => {
    const recording = state.activeRecording;
    if (!recording) return;
    state.activeRecording = await api(`/api/recordings/${recording.id}/stop`, 'POST', {});
    render();
  },
  'record-discard': async () => {
    const recording = state.activeRecording;
    if (!recording) return;
    await api(`/api/recordings/${recording.id}/discard`, 'POST', {});
    state.activeRecording = null;
    navigate('editor');
  },
  'record-import': async ({ button }) => {
    const recording = state.activeRecording;
    if (recordMappingBusy || recording?.status !== 'stopped') return;
    importRecordingSteps(recording, button.dataset.mode);
    await save();
    await api(`/api/recordings/${recording.id}/discard`, 'POST', {});
    state.activeRecording = null;
    navigate('editor');
    notify(selectedKind === 'processes' ? 'Recording saved. Set the number of runs, then run the process.' : 'Recording saved. Edit steps or choose Replay.');
  },
  'delete-test': async ({ test }) => {
    if (!test) return;
    if (!confirm(`Delete “${test.name}”? Historical results will remain.`)) return;
    if (selectedKind === 'tests') await deleteTestCase(test);
    else if (selectedKind === 'processes') deleteProcess(test);
    else deletePrerequisite(test);
  },
  'duplicate-test': ({ test }) => {
    if (selectedKind === 'tests') {
      copyTestCase(test);
      return;
    }
    const clone = structuredClone(test);
    clone.id = uid();
    clone.name = `${clone.name} (copy)`.slice(0, 120);
    project[selectedKind].push(clone);
    selectedId = clone.id;
    markDirty();
    render();
  },
  'add-step': ({ test }) => {
    if (test.steps.length >= MAX_EDITOR_STEPS) throw new Error('Maximum 100 steps');
    test.steps.push({
      name: `Step ${test.steps.length + 1}`,
      action: test.steps.length ? 'click' : 'navigate',
      locatorType: 'css',
      target: '',
      replacement: '',
      value: '',
      valueMode: 'static',
    });
    editorPage = Math.floor((test.steps.length - 1) / editorSize);
    markDirty();
    render();
  },
  'remove-step': ({ test, index }) => {
    test.steps.splice(index, 1);
    markDirty();
    render();
  },
  'duplicate-step': ({ test, index }) => {
    if (test.steps.length >= MAX_EDITOR_STEPS) throw new Error('Maximum 100 steps');
    test.steps.splice(index + 1, 0, structuredClone(test.steps[index]));
    editorPage = Math.floor((index + 1) / editorSize);
    markDirty();
    render();
  },
  'move-step': ({ test, index, button }) => moveStep(test, index, Number(button.dataset.direction)),
  unmap: ({ id, button }) => unmapFromSuite(id, button.dataset.suite),
  'save-step-object': ({ test, index }) => {
    if (selectedKind !== 'tests' || !test) throw new Error('Select a test case before saving a repository object');
    StudioLocators.saveStepObject(project, StudioLocators.caseId(test), test.steps[index], uid);
    markDirty();
    render();
  },
  'edit-object': ({ id }) => editObject(id),
  'delete-object': ({ id }) => {
    const isUsed = [...project.tests, ...project.prerequisites, ...project.processes].some((owner) =>
      owner.steps.some((step) => step.locatorType === 'object' && step.target === id),
    );
    if (isUsed) throw new Error('This object is used by a step. Update the step before removing it.');
    if (!confirm('Remove this repository object?')) return;
    project.objects = project.objects.filter((object) => object.id !== id);
    markDirty();
    render();
  },
  'convert-html': openConvertHtml,
  'edit-globals': () => {
    modal('Global variables', jsonField('variables', 'Variables (JSON object)', project.globalVariables), (values) => {
      const variables = parseJson(values.variables, 'Variables');
      validateVariables(variables);
      project.globalVariables = variables;
      markDirty();
      render();
    });
  },
  'edit-environment': ({ id }) => editEnvironment(id),
  'activate-environment': ({ id }) => {
    project.activeEnvironmentId = id;
    markDirty();
    render();
  },
  'delete-environment': ({ id }) => {
    if (!confirm('Remove this environment?')) return;
    project.environments = project.environments.filter((environment) => environment.id !== id);
    if (project.activeEnvironmentId === id) project.activeEnvironmentId = null;
    markDirty();
    render();
  },
  'edit-profile': ({ id }) => editProfile(id),
  'activate-profile': ({ id }) => {
    project.activeJdbcProfileId = id;
    markDirty();
    render();
  },
  'delete-profile': ({ id }) => {
    if (!confirm('Remove this database profile?')) return;
    project.jdbcProfiles = project.jdbcProfiles.filter((profile) => profile.id !== id);
    if (project.activeJdbcProfileId === id) project.activeJdbcProfileId = null;
    markDirty();
    render();
  },
  'test-profile': async ({ id, button }) => {
    button.disabled = true;
    notify('Checking PostgreSQL connection…');
    try {
      const result = await api('/api/jdbc/test', 'POST', project.jdbcProfiles.find((profile) => profile.id === id));
      notify(result.server);
    } finally {
      button.disabled = false;
    }
  },
  'query-profile': ({ id }) => openProfileQuery(project.jdbcProfiles.find((profile) => profile.id === id)),
  'clear-key': async () => {
    await saveSettings({ ...settings, clearApiKey: true });
    notify(`Saved ${providerInfo().short} key cleared. A matching environment key, if set, remains available.`);
  },
  'disconnect-jira': async ({ button }) => {
    if (bugTrackerBusy) return;
    bugTrackerBusy = true;
    button.disabled = true;
    try {
      settings.bugTracker = await api('/api/bug-tracker', 'DELETE', {});
      bugTrackerMessage = 'Jira disconnected. Saved credentials removed.';
      notify(bugTrackerMessage);
    } catch (error) {
      bugTrackerMessage = error.message;
      notify(error.message, true);
    } finally {
      bugTrackerBusy = false;
      if (view === 'settings') render();
    }
  },
  'setup-mcp-preset': async ({ button }) => {
    button.disabled = true;
    try {
      await setupMcpPreset(button.dataset.preset);
    } finally {
      button.disabled = false;
    }
  },
  'edit-mcp': ({ id }) => editMcp(id),
  'delete-mcp': async ({ id }) => {
    if (!confirm('Remove this MCP server connection?')) return;
    await saveMcpServers(settings.mcpServers.filter((server) => server.id !== id));
    mcpTools.delete(id);
  },
  'reconnect-mcp': ({ id, button }) =>
    refreshMcpServer(button, id, 'reconnect', 'Reconnecting...', 'Reconnect', () => 'MCP reconnected'),
  'discover-mcp': ({ id, button }) =>
    refreshMcpServer(button, id, 'tools', 'Connecting…', 'Connect & discover', (count) => `Discovered ${count} tools`),
  'call-mcp': ({ id, index }) => openMcpTool(id, mcpTools.get(id)[index]),
  'toggle-ai-mcp': async ({ id }) => {
    const chosen = new Set(aiMcpIds);
    if (chosen.has(id)) chosen.delete(id);
    else chosen.add(id);
    if (isAdmin()) {
      await saveSettings({ aiMcpServerIds: [...chosen] });
      return;
    }
    aiMcpIds = chosen;
    render();
  },
  'ai-assistance': () => {
    aiTargetId = null;
    aiRegenerateFrom = 0;
    aiPrompt = '';
    navigate('ai');
  },
  'auto-generator': ({ test }) => {
    if (selectedKind !== 'tests' || !needsAutoGenerator(test)) throw new Error('Select a QA test case with requirements');
    aiTargetId = test.id;
    aiRegenerateFrom = 0;
    draft = null;
    aiPrompt = StudioAutoPrompt.build(project, test);
    navigate('ai');
  },
  'regenerate-from-step': ({ test, index }) => {
    if (selectedKind !== 'tests' || !test.qa?.manualSteps?.length) throw new Error('Select a QA test case with requirements');
    aiTargetId = test.id;
    aiRegenerateFrom = index;
    draft = null;
    aiPrompt = StudioAutoPrompt.build(project, test);
    navigate('ai');
  },
  'prompt-example': ({ button }) => {
    aiPrompt = promptExamples()[button.dataset.example];
    $('#ai-prompt').value = aiPrompt;
    $('#ai-prompt-count').textContent = `${aiPrompt.length}/${MAX_PROMPT_LENGTH}`;
  },
  'generate-ai': generateAutomation,
  'save-agent-options': async () => {
    await save();
    notify('Agent options saved for this project.');
  },
  'cancel-agent-generation': async () => {
    const job = currentGeneration();
    if (job) await api(`/api/generations/${job.id}/cancel`, 'POST', {});
    notify('Cancellation requested.');
  },
  'apply-agent-draft': async ({ button }) => {
    const preview = (state.agentDrafts || []).find((item) => item.projectId === project.id);
    if (!preview) return;
    button.disabled = true;
    try {
      const result = await api('/api/ai/apply', 'POST', { id: preview.id });
      draft = { ...result.test, explanation: result.explanation };
      draftProjectId = project.id;
      await reconnectGeneration(project.id);
      notify('Draft applied. Test has not been run.');
      render();
    } finally {
      button.disabled = false;
    }
  },
  'start-reasonx': startReasonx,
  'use-reasonx-agents': async () => {
    requireAdmin('Only an administrator can change the AI provider.');
    await saveSettings({ provider: 'reasonx', model: 'reasonx-v1' });
    aiStatus = null;
    await loadAiStatus();
    notify(
      settings.hasApiKey ? 'ReasonX agents selected for both studios.' : 'ReasonX agents selected. Save a ReasonX API key in Model settings.',
      !settings.hasApiKey,
    );
  },
  'check-ai-status': checkAiStatus,
  'set-reasonx-mode': async ({ button }) => {
    requireAdmin('Only an administrator can change the reasoning mode.');
    const { mode } = button.dataset;
    if (mode === (settings.reasonxMode || 'auto')) return;
    await saveSettings({ reasonxMode: mode });
    notify(`Reasoning mode set to ${reasonxModeName(mode)}. ${reasonxModeHint(mode)}`);
  },
  'open-ai-test': () => {
    if (dirty) throw new Error('Save or discard your current edits before opening the generated test.');
    if (draftProjectId !== project.id) throw new Error('Switch to the generated test project');
    selectedId = draft.id;
    selectedKind = 'tests';
    navigate('editor');
  },
};

document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-action]');
  if (!button || button.disabled) return;
  const { action } = button.dataset;
  const handler = ACTIONS[action] ?? CASES_ACTIONS[action] ?? LOCAL_DATA_ACTIONS[action];
  if (!handler) return;
  const context = {
    button,
    id: button.dataset.id,
    index: Number(button.dataset.index),
    test: selected(),
  };
  try {
    await handler(context);
  } catch (error) {
    notify(error.message, true);
  }
});

/* ---------- Form and field events ---------- */

function updateStepMapping(select) {
  const test = selected();
  const step = test.steps[Number(select.dataset.index)];
  const requirement = test.qa?.manualSteps.find((item) => item.id === select.value);
  if (requirement) {
    if (!step.qaRequirementId) step.unmappedName = step.name;
    step.qaRequirementId = requirement.id;
    step.name = step.recordedName
      ? `${step.recordedName} — ${requirement.instruction}`.slice(0, 10000)
      : requirement.instruction;
  } else {
    step.name = step.unmappedName || step.name;
    delete step.qaRequirementId;
    delete step.unmappedName;
  }
  markDirty();
  render();
}

async function updateRecordingMapping(select) {
  if (recordMappingBusy) return;
  const qaRequirementId = select.value || null;
  recordMappingBusy = true;
  render();
  try {
    state.activeRecording = await api(`/api/recordings/${state.activeRecording.id}/mappings`, 'POST', {
      mappings: [{ stepIndex: Number(select.dataset.index), qaRequirementId }],
    });
    notify(qaRequirementId ? 'Step mapped to QA Studio requirement.' : 'Requirement mapping removed.');
  } finally {
    recordMappingBusy = false;
    render();
  }
}

// History and overview pages read their filters from the address before this runs.
function resetProjectUrl() {
  const url = new URL(location.href);
  url.searchParams.set('projectId', project.id);
  for (const name of PROJECT_URL_PARAMS) url.searchParams.delete(name);
  history.replaceState(null, '', url);
}

async function switchProject(projectId) {
  await save();
  activeFolderId = null;
  aiTargetId = null;
  aiRegenerateFrom = 0;
  aiPrompt = '';
  openProject(state.projects.find((item) => item.id === projectId));
  selectedId = project.tests[0]?.id;
  if (!['cases', 'history', 'execution'].includes(view)) view = 'editor';
  render();
  resetProjectUrl();
}

function updateStepSelect(select) {
  const step = selected().steps[Number(select.dataset.step)];
  const { key } = select.dataset;
  step[key] = select.value;
  if (key === 'locatorType' && select.value === 'object') step.target = caseObjects()[0]?.id || '';
  markDirty();
  if (['action', 'locatorType', 'valueMode', 'target'].includes(key)) refreshEditor();
}

document.addEventListener('input', (event) => {
  const element = event.target;
  if (element.id === 'ai-prompt') {
    aiPrompt = element.value;
    const count = document.getElementById('ai-prompt-count');
    if (count) count.textContent = `${element.value.length}/${MAX_PROMPT_LENGTH}`;
  } else if (element.dataset.meta && element.tagName === 'INPUT') {
    selected()[element.dataset.meta] = element.value;
    markDirty();
  } else if (element.dataset.step !== undefined && element.tagName === 'INPUT') {
    selected().steps[Number(element.dataset.step)][element.dataset.key] = element.value;
    markDirty();
  } else if (element.dataset.agentOption) {
    updateAgentOption(element);
  }
});

function updateAgentOption(element) {
  const key = element.dataset.agentOption;
  let value = element.value;
  if (key === 'enabled') value = element.checked;
  else if (key === 'repairLimit') value = Number(element.value);
  project.agentOptions = {
    enabled: false,
    repairLimit: 1,
    guidance: '',
    model: '',
    mode: '',
    ...project.agentOptions,
    [key]: value,
  };
  markDirty();
}

async function handleFieldChange(element) {
  if (element.matches('[data-record-mapping]')) {
    await updateRecordingMapping(element);
  } else if (element.matches('[data-step-mapping]')) {
    updateStepMapping(element);
  } else if (element.id === 'record-mode') {
    state.activeRecording = await api(`/api/recordings/${state.activeRecording.id}/mode`, 'POST', { mode: element.value });
    render();
  } else if (element.matches('[data-step-repeat]')) {
    const step = selected().steps[Number(element.dataset.index)];
    if (element.checked) step.repeat = true;
    else delete step.repeat;
    markDirty();
    render();
  } else if (element.matches('[data-process-runs]')) {
    const item = project.processes.find((candidate) => candidate.id === element.dataset.id);
    const count = Number(element.value);
    if (!Number.isInteger(count) || count < 1 || count > MAX_PROCESS_RUNS) {
      element.value = item.runCount || 1;
      throw new Error(`Enter a whole number of runs from 1 to ${MAX_PROCESS_RUNS}.`);
    }
    item.runCount = count;
    markDirty();
    render();
  } else if (element.id === 'ai-regenerate-from') {
    aiRegenerateFrom = Number(element.value);
    render();
  } else if (element.id === 'editor-page-size') {
    editorSize = Number(element.value);
    editorPage = 0;
    refreshEditor();
  } else if (element.id === 'project-select') {
    await switchProject(element.value);
  } else if (element.id === 'environment-select') {
    project.activeEnvironmentId = element.value || null;
    markDirty();
    render();
  } else if (element.id === 'browser-select') {
    project.browser = element.value;
    markDirty();
    notify(`${element.options[element.selectedIndex].text} selected. Save the workspace to keep this choice.`);
  } else if (element.dataset.meta) {
    selected()[element.dataset.meta] = element.value || null;
    markDirty();
    renderExplorer();
  } else if (element.dataset.step !== undefined && element.tagName === 'SELECT') {
    updateStepSelect(element);
  } else if (element.id === 'ai-engine') {
    aiEngine = element.value;
    render();
  } else if (element.id === 'ai-model' && $('#ai-provider')?.value === 'reasonx') {
    const select = $('[name=reasonxMode]');
    select.innerHTML = options(reasonxModeChoices(element.value), select.value);
  } else if (element.id === 'ai-provider') {
    previewProvider(element.value);
  }
}

// Shows the chosen provider's form and defaults without saving them.
function previewProvider(provider) {
  const saved = settings;
  try {
    settings = { ...settings, provider, model: providerInfo(provider).defaultModel, hasApiKey: false };
    $('#content').innerHTML = renderSettings();
  } finally {
    settings = saved;
  }
}

document.addEventListener('change', async (event) => {
  try {
    await handleFieldChange(event.target);
  } catch (error) {
    notify(error.message, true);
    if (project) renderPickers();
  }
});

$('#dialog-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const submit = $('#dialog-submit');
  submit.disabled = true;
  try {
    const shouldKeepOpen = (await modalHandler(Object.fromEntries(new FormData(event.target)))) === false;
    if (!shouldKeepOpen) $('#dialog').close();
  } catch (error) {
    notify(error.message, true);
  } finally {
    submit.disabled = false;
  }
});

function connectionErrorMessage(error, provider) {
  if (provider === 'reasonx' && error.message === 'Choose Google AI Studio, OpenAI, or Groq') {
    return 'Studio is running an older server without ReasonX support. Open Restart QA Studio.cmd in this workspace, sign in as a Studio administrator when prompted, then reload this page and save again.';
  }
  return error.message;
}

async function submitProviderForm(form) {
  const values = Object.fromEntries(new FormData(form));
  form.querySelector('[data-connection-error]')?.remove();
  try {
    await saveSettings({ ...settings, ...values });
    notify(`${providerInfo().short} settings saved`);
  } catch (error) {
    const message = connectionErrorMessage(error, values.provider);
    const notice = document.createElement('p');
    notice.dataset.connectionError = '';
    notice.className = 'notice error';
    notice.setAttribute('role', 'alert');
    notice.textContent = message;
    form.append(notice);
    notify(message, true);
  }
}

async function submitBugTrackerForm(form) {
  if (bugTrackerBusy) return;
  const values = Object.fromEntries(new FormData(form));
  bugTrackerBusy = true;
  bugTrackerMessage = 'Saving and checking Jira access…';
  form.querySelectorAll('button').forEach((button) => {
    button.disabled = true;
  });
  $('#bug-tracker-message').textContent = bugTrackerMessage;
  try {
    settings.bugTracker = await api('/api/bug-tracker', 'PUT', values);
    form.querySelector('[name="apiKey"]').value = '';
    settings.bugTracker = await api('/api/bug-tracker/connect', 'POST', {});
    bugTrackerMessage = 'Connection established successfully.';
    notify(bugTrackerMessage);
  } catch (error) {
    bugTrackerMessage = error.message;
    settings.bugTracker = await api('/api/bug-tracker').catch(() => settings.bugTracker);
    notify(error.message, true);
  } finally {
    bugTrackerBusy = false;
    if (view === 'settings') render();
  }
}

document.addEventListener('submit', (event) => {
  if (event.target.id === 'openai-form') {
    event.preventDefault();
    void submitProviderForm(event.target);
  } else if (event.target.id === 'bug-tracker-form') {
    event.preventDefault();
    void submitBugTrackerForm(event.target);
  }
});

document.addEventListener('keydown', (event) => {
  const hasModifier = event.ctrlKey || event.metaKey;
  if (hasModifier && event.key === 'Enter' && event.target.id === 'ai-prompt') {
    event.preventDefault();
    const button = $('[data-action="generate-ai"]');
    if (button && !button.disabled) button.click();
    return;
  }
  if (hasModifier && event.key.toLowerCase() === 's') {
    event.preventDefault();
    save()
      .then(() => notify('Workspace saved'))
      .catch((error) => notify(error.message, true));
    return;
  }
  const isTyping =
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) || document.activeElement.isContentEditable;
  if (event.key === '/' && project && !hasModifier && !event.altKey && !isTyping && !$('dialog[open]')) {
    event.preventDefault();
    navigate('cases');
    $('#auto-cases-search')?.focus();
  }
});

document.addEventListener('dragstart', (event) => {
  const handle = event.target.closest?.('[data-drag-step]');
  if (!handle) return;
  dragStep = Number(handle.dataset.dragStep);
  event.dataTransfer.setData('text/plain', String(dragStep));
});

document.addEventListener('dragover', (event) => {
  if (event.target.closest?.('[data-row]')) event.preventDefault();
});

document.addEventListener('drop', (event) => {
  const row = event.target.closest?.('[data-row]');
  if (row && dragStep !== undefined) {
    event.preventDefault();
    const { steps } = selected();
    const [step] = steps.splice(dragStep, 1);
    steps.splice(Number(row.dataset.row), 0, step);
    markDirty();
    render();
  }
  dragStep = undefined;
});

// `toggle` does not bubble, so open panels are remembered in the capture phase.
document.addEventListener(
  'toggle',
  (event) => {
    const node = event.target;
    const repositoryKey = node.dataset?.repositoryCase;
    if (repositoryKey) {
      const key = `${project.id}:${repositoryKey}`;
      if (node.open) openRepositoryCases.add(key);
      else openRepositoryCases.delete(key);
    }
    if (node.matches?.('.qa-context') && node.isConnected) {
      if (node.open) openRequirements.add(node.dataset.requirements);
      else openRequirements.delete(node.dataset.requirements);
    }
  },
  true,
);

window.addEventListener('beforeunload', (event) => {
  if (!dirty) return;
  event.preventDefault();
  event.returnValue = '';
});

/* ---------- Polling ---------- */

function withoutRequirements(value) {
  if (!value) return '';
  const snapshot = structuredClone(value);
  delete snapshot.revision;
  for (const kind of ['tests', 'prerequisites']) {
    for (const item of snapshot[kind]) {
      delete item.qa;
      delete item.automationNeedsUpdate;
    }
  }
  return JSON.stringify(snapshot);
}

// QA owns requirements, so that read-only context refreshes even during automation edits.
function syncQaRequirements(fresh, previous) {
  if (!fresh || saving) return;
  const canRebase = previous?.revision === project.revision && withoutRequirements(previous) === withoutRequirements(fresh);
  let hasChanged = false;
  for (const kind of ['tests', 'prerequisites']) {
    for (const local of project[kind]) {
      const remote = fresh[kind].find((item) => item.id === local.id);
      if (!remote) continue;
      const isSame =
        JSON.stringify(local.qa) === JSON.stringify(remote.qa) &&
        local.automationNeedsUpdate === remote.automationNeedsUpdate;
      if (isSame) continue;
      local.qa = structuredClone(remote.qa);
      local.automationNeedsUpdate = remote.automationNeedsUpdate;
      hasChanged = true;
    }
  }
  // Rebase only when the server changed requirements alone. Other edits still conflict.
  if (canRebase) project.revision = fresh.revision;
  if (hasChanged && view === 'editor' && selected()) {
    refreshQaContext();
    for (const select of document.querySelectorAll('[data-step-mapping]')) {
      const step = selected().steps[Number(select.dataset.index)];
      select.innerHTML = options(
        requirementOptions(selected().qa?.manualSteps || []),
        step?.qaRequirementId || '',
        'Not mapped',
      );
    }
  }
}

// Losing the open project closes its dialog. A newly granted project leaves an open dialog alone.
function adoptProjectAccessChange(latest) {
  const hadProject = Boolean(project);
  historyCache.clear();
  dirty = false;
  state = latest;
  project = structuredClone(latest.projects[0]);
  selectedKind = 'tests';
  selectedId = project?.tests[0]?.id;
  view = 'editor';
  if (hadProject && $('#dialog').open) {
    $('#dialog').close();
    $('#dialog-body').innerHTML = '';
  }
  render();
}

function refreshActivityViews() {
  updateStatus();
  renderExecution();
  $('#run-count').textContent = historyCount();
  if (view === 'recording' && !recordMappingBusy && !document.activeElement?.matches('[data-record-mapping]')) {
    keepRemoteScreen(() => {
      $('#content').innerHTML = renderRecording();
    });
  }
  if (view === 'debug') $('#content').innerHTML = renderDebug();
  if (view === 'editor') refreshHistoryPanel();
  if (view === 'history') StudioHistory.refresh();
  if (view === 'execution') StudioExecution.refresh();
  if (view === 'cases') refreshCasesList();
  if (view === 'suites') updateSuiteRunButtons();
  updateProcessRunButtons();
}

async function applyLatestState(data) {
  const latest = historyTools.recoverPlanState(data);
  const aiGenerations = latest.aiGenerations || [];
  const hasGenerationChange = JSON.stringify(state.aiGenerations || []) !== JSON.stringify(aiGenerations);
  state.agentDrafts = latest.agentDrafts || [];
  state.aiGenerations = aiGenerations;

  const fresh = latest.projects.find((item) => item.id === project?.id);
  const previous = state.projects.find((item) => item.id === project?.id);
  if (project && dirty) syncQaRequirements(fresh, previous);
  state.projects = latest.projects;

  if (!fresh && (project || latest.projects.length)) adoptProjectAccessChange(latest);
  if (!project) {
    state = latest;
    return;
  }

  if (!document.activeElement?.closest('.workspace-pickers')) renderPickers();
  if (fresh && !dirty && !saving && fresh.revision !== project.revision) {
    project = structuredClone(fresh);
    if (selectedKind === 'tests' && !selected()) selectedId = null;
    render();
  }

  state.runs = latest.runs;
  state.activeRun = latest.activeRun;
  state.activeDebug = latest.activeDebug;
  if (!recordMappingBusy) state.activeRecording = latest.activeRecording;
  StudioIssueReport.setState(latest);

  const signature = JSON.stringify([
    latest.activeRun,
    latest.activeDebug,
    latest.activeRecording,
    projectRuns(),
    StudioIssueReport.signature(),
  ]);
  if (signature !== lastRunSignature) {
    lastRunSignature = signature;
    refreshActivityViews();
  }
  await loadCaseHistory();
  if (hasGenerationChange) render();
}

async function poll() {
  try {
    if (!document.hidden) {
      const data = await StudioUI.pollState('/api/state?workspace=automation');
      $('#connection-status').textContent = CONNECTED_TEXT;
      if (data) await applyLatestState(data);
    }
  } catch {
    $('#connection-status').textContent = DISCONNECTED_TEXT;
  } finally {
    setTimeout(poll, state?.activeRecording ? RECORDING_POLL_MS : POLL_MS);
  }
}

/* ---------- Startup ---------- */

async function openHandoff(params) {
  const selection = params.has('testIds')
    ? { testIds: params.get('testIds').split(',') }
    : params.has('testId')
      ? { testId: params.get('testId') }
      : { suiteId: params.get('suiteId') };
  let opened;
  try {
    opened = await api('/api/automation/handoff', 'POST', { projectId: project.id, ...selection });
  } catch (error) {
    if (isMissingRoute(error)) {
      error.message =
        'The running server has not loaded the automation handoff update. Close and reopen Studio using Start QA Studio.cmd, then retry. Your QA case and requirements are still saved.';
      error.code = 'SERVER_RESTART_REQUIRED';
    }
    throw error;
  }
  project = structuredClone(opened.project);
  state.projects[state.projects.findIndex((item) => item.id === project.id)] = structuredClone(project);
  params.delete('testId');
  params.delete('suiteId');
  params.delete('from');
  params.set('testIds', opened.testIds.join(','));
  history.replaceState(null, '', `/automation?${params}`);
}

function initialSelection(params) {
  if (params.has('testId')) return project.tests.find((test) => test.id === params.get('testId'))?.id;
  if (params.has('testIds')) {
    const ids = params.get('testIds').split(',');
    return project.tests.find((test) => ids.includes(test.id))?.id;
  }
  return project.tests[0]?.id;
}

function applyInitialView(params) {
  selectedId = initialSelection(params);
  const requested = params.get('view');
  view = LINKABLE_VIEWS.includes(requested) ? requested : 'editor';
  const prerequisite = project.prerequisites.find((item) => item.id === params.get('prerequisiteId'));
  if (prerequisite) {
    selectedKind = 'prerequisites';
    selectedId = prerequisite.id;
    view = 'editor';
  }
  if (state.activeRecording) {
    project = structuredClone(state.projects.find((item) => item.id === state.activeRecording.projectId) || state.projects[0]);
    selectedId = state.activeRecording.testId;
    view = 'recording';
  }
}

async function runHandoffIntent(params) {
  const ids = params.get('testIds')?.split(',').filter(Boolean);
  const suiteId = params.get('suiteId');
  const testId = params.get('testId');
  const chosen = project.tests.filter((test) => {
    if (ids && !ids.includes(test.id)) return false;
    if (testId && test.id !== testId) return false;
    return !suiteId || test.suiteId === suiteId || Boolean(test.additionalSuiteIds?.includes(suiteId));
  });
  const cleanUrl = new URL(location.href);
  cleanUrl.searchParams.delete('intent');
  history.replaceState(null, '', cleanUrl);

  const isComplete = chosen.length && (!ids || ids.every((id) => chosen.some((test) => test.id === id)));
  if (isComplete && chosen.every((test) => test.steps.length)) {
    const selector = ids ? { testIds: ids } : suiteId ? { suiteId } : { testId: selectedId };
    const planId = params.get('planId');
    try {
      await run({ ...selector, name: params.get('runName') || undefined, ...(planId ? { planId } : {}) });
    } catch (error) {
      notify(error.message, true);
    }
    return;
  }
  selectedId = chosen.find((test) => !test.steps.length)?.id || null;
  view = 'editor';
  render();
  notify(
    chosen.length
      ? 'Case opened from QA Studio. Configure automation steps, then use Run test.'
      : 'This automation case no longer exists. Open the case from QA Studio to create a new automation case.',
    !chosen.length,
  );
}

function renderInitFailure(error) {
  const needsRestart = error.code === 'SERVER_RESTART_REQUIRED';
  const qaHome = project ? `/?projectId=${encodeURIComponent(project.id)}` : '/';
  $('#content').innerHTML = empty(
    needsRestart ? 'Restart QA Studio to continue' : 'Could not load the workspace',
    error.message,
    needsRestart
      ? `<a class="button" href="${esc(location.href)}">Retry after restart</a> <a href="${esc(qaHome)}">Return to QA Studio</a>`
      : '',
  );
  notify(error.message, true);
}

async function loadRunHistoryTools() {
  try {
    return await import('/run-history.js');
  } catch {
    throw new Error('Restart QA Studio using Start QA Studio.cmd to load test case history.');
  }
}

async function init() {
  try {
    await globalThis.StudioAuth?.ready;
    if (!globalThis.StudioFolders) {
      throw new Error('Restart QA Studio using Start QA Studio.cmd to load folder support.');
    }
    [state, historyTools] = await Promise.all([api('/api/state'), loadRunHistoryTools()]);
    historyTools.recoverPlanState(state);
    StudioIssueReport.setState(state);
    window.addEventListener('studio:issue-reported', () => {
      api('/api/state')
        .then(applyLatestState)
        .catch(() => {});
    });
    await ensureSettings();

    const params = new URLSearchParams(location.search);
    if (params.get('view') === 'plan') {
      params.set('view', 'cases');
      history.replaceState(null, '', `${location.pathname}?${params}`);
    }
    if (location.pathname === '/run-history') params.set('view', 'history');

    project = structuredClone(state.projects.find((item) => item.id === params.get('projectId')) || state.projects[0]);
    if (!project) {
      view = params.get('view') === 'mcp' ? 'mcp' : 'editor';
      render();
      void poll();
      return;
    }
    const isHandoff = params.get('from') === 'qa' && ['testId', 'testIds', 'suiteId'].some((name) => params.has(name));
    if (isHandoff) await openHandoff(params);
    applyInitialView(params);
    render();
    void poll();
    if (params.get('intent') === 'execute') await runHandoffIntent(params);
  } catch (error) {
    renderInitFailure(error);
  }
}

// The workspace shares the page layout; hiding it returns its width to the content.
function setupWorkspaceMenu() {
  const menu = $('#workspace-menu');
  const toggle = $('#workspace-toggle');
  const preferenceKey = 'studio.workspaceExpanded';

  function setOpen(isOpen, shouldPersist = true) {
    const shouldReturnFocus = !isOpen && menu.contains(document.activeElement);
    menu.hidden = !isOpen;
    toggle.setAttribute('aria-expanded', String(isOpen));
    toggle.setAttribute('aria-label', isOpen ? 'Hide workspace' : 'Expand workspace');
    toggle.title = isOpen ? 'Hide workspace' : 'Expand workspace';
    document.body.classList.toggle('workspace-expanded', isOpen);
    if (shouldReturnFocus) toggle.focus();
    if (!shouldPersist) return;
    try {
      localStorage.setItem(preferenceKey, String(isOpen));
    } catch {
      // Blocked storage only means the preference is not remembered.
    }
  }

  let isExpanded = window.matchMedia('(min-width: 901px)').matches;
  try {
    const saved = localStorage.getItem(preferenceKey);
    if (saved !== null) isExpanded = saved === 'true';
  } catch {
    // Blocked storage falls back to the width-based default.
  }
  setOpen(isExpanded, false);

  toggle.addEventListener('click', () => setOpen(menu.hidden));
  $('#workspace-close').addEventListener('click', () => setOpen(false));
  menu.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('dialog[open]')) {
      event.preventDefault();
      setOpen(false);
    }
  });
}

setupWorkspaceMenu();
void init();
