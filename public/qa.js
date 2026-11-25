/* QA Studio uses the same project definitions and immutable run snapshots as Automation Studio.
   Classic script: requirements.js shares this global scope, so names here are its API too. */
'use strict';

/* ---- Constants ---------------------------------------------------------- */

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const CASE_CATEGORIES = ['Positive', 'Negative', 'Functional', 'Validation', 'Boundary', 'Security', 'Performance'];
const CASE_PRIORITIES = ['critical', 'high', 'medium', 'low'];
const CASE_TYPES = ['functional', 'regression', 'smoke', 'integration', 'performance', 'security', 'usability'];
const RESULT_FILTERS = ['untested', 'passed', 'failed', 'blocked', 'running', 'pending', 'skipped', 'interrupted'];
const TERMINAL_STATUSES = ['passed', 'failed', 'blocked', 'skipped'];
const STATUS_LABELS = {
  untested: 'Untested',
  pending: 'Pending',
  running: 'In progress',
  passed: 'Passed',
  failed: 'Failed',
  blocked: 'Blocked',
  skipped: 'Skipped',
  interrupted: 'Interrupted',
  automation: 'Automated',
  manual: 'Manual',
};
const STATUS_ICONS = { passed: 'check', failed: 'close', automation: 'bolt', manual: 'user', running: 'clock' };
const OVERVIEW_ORDER = { failed: 0, blocked: 1, running: 2, interrupted: 3, untested: 4, pending: 5, skipped: 6, passed: 7 };
const STEP_OUTCOMES = [
  { status: 'passed', label: 'Pass', glyph: 'check' },
  { status: 'failed', label: 'Fail', glyph: 'close' },
  { status: 'blocked', label: 'Block', glyph: 'pause' },
  { status: 'skipped', label: 'Skip', glyph: 'arrow' },
];
const NAV_ITEMS = [
  { id: 'dashboard', label: 'Overview', glyph: 'dashboard' },
  { id: 'requirements', label: 'Requirement', glyph: 'cases' },
  { id: 'cases', label: 'Test cases', glyph: 'cases' },
  { id: 'plan', label: 'Test plan', glyph: 'plan' },
  { id: 'runs', label: 'Test runs', glyph: 'runs' },
  { id: 'suites', label: 'Test suites', glyph: 'suites' },
  { id: 'preconditions', label: 'Preconditions', glyph: 'preconditions' },
  { id: 'reports', label: 'Reports', glyph: 'reports' },
];
const VIEW_NAMES = {
  dashboard: 'Overview',
  requirements: 'Requirement',
  requirement: 'Requirement',
  'requirement-edit': 'Requirement',
  'requirement-draft': 'Draft review',
  cases: 'Test cases',
  plan: 'Test plan',
  case: 'Test case details',
  runs: 'Test runs',
  run: 'Execution',
  suites: 'Test suites',
  preconditions: 'Preconditions',
  reports: 'Reports',
};
const VIEW_ACTIVE_NAV = {
  case: 'cases',
  run: 'runs',
  requirement: 'requirements',
  'requirement-edit': 'requirements',
  'requirement-draft': 'requirements',
};
const FIELD_TAGS = ['INPUT', 'TEXTAREA', 'SELECT'];
const CASE_PAGE_SIZE = 50;
const HISTORY_PAGE_SIZE = 50;
const MAX_STEPS = 1000;
const POLL_INTERVAL_MS = 2000;
const NEW_FOLDER = '__new-folder__';
const FOLDER_FEATURE_MISSING = 'Restart QA Studio using Start QA Studio.cmd to create folders.';

/* ---- Client state ------------------------------------------------------- */

let state;
let projectId;
let historyTools;
let modalSubmit;
let runTestId;
let lastSignature = '';
let pollTimer;
let casePage = 0;
let filters = emptyFilters();
let savingManualResult = false;
let connectionHealthy = true;
let pendingPollRender = false;
let draggedStep = null;
let renderedHash = null;
let historySource;
let historyProject;
let historyIndex;

const selected = new Set();
const notes = new Map();
const collapsedFolders = new Set();

function emptyFilters() {
  return { search: '', status: '', priority: '', suite: '', category: '', folder: null };
}

/* ---- Small helpers ------------------------------------------------------ */

const $ = (selector) => document.querySelector(selector);
const e = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
const icon = (name) => StudioUI.icon(name);
const cap = (text) => (text ? text.charAt(0).toUpperCase() + text.slice(1) : '');
const tc = (test) => `TC-${String(test.tcNumber || 0).padStart(4, '0')}`;
const percent = (part, total) => (total ? Math.round((part / total) * 100) : 0);
const notify = (message, isError = false) => StudioUI.notify(message, isError);

function badge(status) {
  return `<span class="badge ${e(status)}">${icon(STATUS_ICONS[status] || 'target')}${e(STATUS_LABELS[status] || cap(status))}</span>`;
}

function button(action, label, glyph = 'plus', extra = '', kind = '') {
  return `<button type="button" class="button ${kind}" data-action="${action}" ${extra}>${icon(glyph)}${label}</button>`;
}

function options(items, selectedValue, emptyLabel) {
  const first = emptyLabel === undefined ? '' : `<option value="">${e(emptyLabel)}</option>`;
  const rest = items.map((item) => {
    const value = typeof item === 'string' ? item : item.id;
    const label = typeof item === 'string' ? cap(item) : item.name;
    return `<option value="${e(value)}" ${value === selectedValue ? 'selected' : ''}>${e(label)}</option>`;
  });
  return first + rest.join('');
}

function input(name, label, value = '', extra = '') {
  return `<label>${label}<input name="${name}" value="${e(value)}" ${extra}></label>`;
}

function area(name, label, value = '', extra = '') {
  return `<label>${label}<textarea name="${name}" maxlength="10000" ${extra}>${e(value)}</textarea></label>`;
}

function empty(title, description, action = '') {
  return `<div class="empty">${icon('cases')}<strong>${e(title)}</strong><p>${e(description)}</p>${action}</div>`;
}

function shortDate(value) {
  return value ? new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '—';
}

function progress(value) {
  return `<progress class="progress-track" max="100" value="${value}" aria-label="${value}% complete">${value}%</progress>`;
}

function heading(title, description, actions = '') {
  return `<div class="page-heading">
    <div><h1>${e(title)}</h1><p>${e(description)}</p></div>
    <div class="heading-actions">${actions}</div>
  </div>`;
}

function downloadCsv(name, headers, rows) {
  const cell = (value) => {
    let text = String(value ?? '');
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  const content = `﻿${[headers, ...rows].map((row) => row.map(cell).join(',')).join('\r\n')}`;
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---- Project, history and routing accessors ----------------------------- */

const project = () => state?.projects.find((item) => item.id === projectId) || state?.projects[0];

function route() {
  const [view = 'dashboard', id] = location.hash.slice(1).split('/');
  return { view: view || 'dashboard', id };
}

// Run updates replace state.runs, so saved results and polls invalidate this index.
function qaHistory() {
  const id = project().id;
  if (historySource !== state.runs || historyProject !== id) {
    historyIndex = historyTools.indexQaHistory(state.runs, id);
    historySource = state.runs;
    historyProject = id;
  }
  return historyIndex;
}

const runs = () => qaHistory().runs;
const latest = (test) => qaHistory().latest.get(test.id)?.status || 'untested';
const lastRunFor = (test) => qaHistory().latest.get(test.id)?.run;
const mode = (test) => test.qa?.executionMode || (test.steps.length ? 'automation' : 'manual');
const inSuite = (test, suiteId) => test.suiteId === suiteId || test.additionalSuiteIds?.includes(suiteId);

function manualSteps(test) {
  if (test.qa?.manualSteps?.length) return test.qa.manualSteps;
  return test.steps.map((step) => ({
    instruction: step.name,
    expectedResult: ['text', 'url', 'value', 'heading'].includes(step.action) && step.valueMode === 'static' ? step.value : '',
  }));
}

function autoUrl(testId, extra = {}) {
  const params = { projectId: project().id, from: 'qa', ...(testId ? { testId } : {}), ...extra };
  return `/automation?${new URLSearchParams(params)}`;
}

function folderContext() {
  if (route().view === 'case') return project().tests.find((test) => test.id === route().id)?.folderId || '';
  return filters.folder || '';
}

function requirementRequestMessage(status) {
  if (status === 401) return 'Your sign-in has expired. Sign in again, then try again.';
  if (status === 403) return 'You do not have permission for this action. Ask your administrator for access.';
  return 'QA Studio could not finish this request. Try again. If the problem continues, ask your administrator for help.';
}

/* ---- API ---------------------------------------------------------------- */

async function api(path, method = 'GET', data) {
  const isRequirement = /\/requirements(?:\/|$)/.test(path);
  const requestOptions = {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data),
  };
  let response;
  let result;
  try {
    response = await StudioUI.request(path, requestOptions);
  } catch (error) {
    if (!isRequirement) throw error;
    throw new Error('QA Studio could not be reached. Check that QA Studio is running, then try again.');
  }
  try {
    result = await response.json();
  } catch (error) {
    if (!isRequirement) throw error;
    throw new Error('QA Studio could not read the response. Try again. If this continues, restart QA Studio.');
  }
  if (!response.ok) {
    const fallback = isRequirement ? requirementRequestMessage(response.status) : result.error || 'Request failed';
    const failure = new Error(result.userMessage || fallback);
    failure.code = result.code;
    throw failure;
  }
  return result;
}

function setProject(id) {
  casePage = 0;
  projectId = id;
  localStorage.setItem('qa-project', id);
  const url = new URL(location.href);
  url.searchParams.set('projectId', id);
  history.replaceState(null, '', url);
  selected.clear();
  collapsedFolders.clear();
  filters = emptyFilters();
}

async function refresh() {
  state = historyTools.recoverPlanState(await api('/api/state'));
  if (!state.projects.some((item) => item.id === projectId)) setProject(state.projects[0]?.id);
}

async function saveProject(next) {
  const saved = await api(`/api/projects/${next.id}`, 'PUT', next);
  state.projects[state.projects.findIndex((item) => item.id === saved.id)] = saved;
  return saved;
}

// Renders now, so callers can move focus straight away. navigate() then skips this hash change.
function go(hash) {
  renderedHash = `#${hash}`;
  location.hash = hash;
  render();
}

/* ---- Shell -------------------------------------------------------------- */

function navLink(item, activeView) {
  const isActive = activeView === item.id;
  const count = item.id === 'cases' ? `<span class="nav-count">${project().tests.length}</span>` : '';
  return `<a class="nav-item ${isActive ? 'active' : ''}" href="#${item.id}" title="${item.label}" aria-label="${item.label}" ${isActive ? 'aria-current="page"' : ''}>
    ${icon(item.glyph)}<span>${item.label}</span>${count}
  </a>`;
}

function sidebarMarkup(view) {
  const activeView = VIEW_ACTIVE_NAV[view] || view;
  return `<div class="studio-brand">
      <a href="#dashboard" class="brand" aria-label="QA Studio dashboard">
        <span class="brand-mark">${icon('logo')}</span>
        <span>QA Studio<small>QUALITY, IN FOCUS</small></span>
      </a>
      ${StudioTheme.button()}
    </div>
    <div class="workspace-switch">
      <span class="initial">QA</span>
      <div><strong>My workspace</strong><small>Local workspace</small></div>
    </div>
    <p class="nav-label">WORKSPACE</p>
    <nav aria-label="Main navigation">
      ${NAV_ITEMS.map((item) => navLink(item, activeView)).join('')}
      <div class="nav-divider"></div>
      <a class="nav-item" href="${autoUrl()}" title="Automation Studio">${icon('bolt')}<span>Automation Studio</span></a>
      <a class="nav-item" href="${autoUrl(null, { view: 'settings' })}" title="Settings">${icon('settings')}<span>Settings</span></a>
    </nav>
    <div class="sidebar-bottom"><p class="sidebar-note">Local workspace · v4.0</p></div>`;
}

function projectPicker() {
  return `<div class="project-picker">
    ${icon('suites')}
    <label class="pill" for="project-select">PROJECT</label>
    <select id="project-select" aria-label="Project">${options(state.projects, project().id)}</select>
    <button type="button" class="icon-button" data-action="new-project" aria-label="New project">${icon('plus')}</button>
  </div>`;
}

function topbarMarkup() {
  return `<div class="topbar-left">
      <button type="button" id="navigation-toggle" class="button navigation-toggle" aria-controls="sidebar" aria-expanded="false">${icon('menu')}<span>Menu</span></button>
      ${projectPicker()}
    </div>
    <div class="topbar-right">
      <form id="global-search" class="topbar-search">
        ${icon('search')}
        <input aria-label="Search workspace" name="search" placeholder="Search test cases…">
        <kbd>/</kbd>
      </form>
      <button type="button" class="icon-button" data-action="help" aria-label="Quick start guide">${icon('help')}</button>
      <span class="separator"></span>
      <span class="avatar" title="Local QA workspace">QA</span>
    </div>`;
}

function shell() {
  const { view } = route();
  const name = VIEW_NAMES[view] || 'Overview';
  $('#sidebar').innerHTML = sidebarMarkup(view);
  $('#topbar').innerHTML = topbarMarkup();
  $('#breadcrumbs').innerHTML = `<ol class="breadcrumb">
    <li><a href="#dashboard">Workspace</a></li>
    <li>${icon('chevron')}<strong aria-current="page">${name}</strong></li>
  </ol>`;
  $('#footer').innerHTML = '<span class="online" id="connection" role="status">Connected to local workspace</span><span>QA Studio 4.0</span>';
  updateConnection(connectionHealthy);
  document.title = `${name} · QA Studio`;
}

function updateConnection(isConnected) {
  connectionHealthy = isConnected;
  const connection = $('#connection');
  if (connection) {
    connection.textContent = isConnected ? 'Connected to local workspace' : 'Connection lost · showing last loaded data';
    connection.classList.toggle('offline', !isConnected);
  }
  let banner = $('#connection-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'connection-banner';
    banner.className = 'connection-banner';
    banner.setAttribute('role', 'status');
    $('#breadcrumbs').after(banner);
  }
  banner.hidden = isConnected;
  if (!isConnected && !banner.childElementCount) {
    banner.innerHTML = `<span>Connection lost. Your last loaded results are still visible. Reconnecting automatically.</span>${button('retry-connection', 'Retry now', 'refresh')}`;
  }
}

// Mobile navigation is an inline disclosure with the same labelled destinations.
function closeNavigation(returnFocus = false) {
  document.body.classList.remove('navigation-open');
  $('#navigation-toggle')?.setAttribute('aria-expanded', 'false');
  if (returnFocus) $('#navigation-toggle')?.focus();
}

function toggleNavigation() {
  const isOpen = document.body.classList.toggle('navigation-open');
  $('#navigation-toggle').setAttribute('aria-expanded', String(isOpen));
  if (isOpen) $('#sidebar .nav-item[aria-current]')?.focus();
}

/* ---- Overview ----------------------------------------------------------- */

function stats() {
  const tests = project().tests;
  const total = tests.length;
  const executed = tests.filter((test) => TERMINAL_STATUSES.includes(latest(test))).length;
  const passed = tests.filter((test) => latest(test) === 'passed').length;
  const attention = tests.filter((test) => ['failed', 'blocked'].includes(latest(test))).length;
  const planned = tests.filter((test) => test.inTestPlan).length;
  const cells = [
    ['Test cases', total, `${planned} in the test plan`],
    ['Need attention', attention, 'Failed or blocked latest results'],
    ['Execution coverage', `${percent(executed, total)}<small>%</small>`, `${executed} of ${total} cases have a result`],
    [
      'Pass rate',
      executed ? `${percent(passed, executed)}<small>%</small>` : '—',
      executed ? `${passed} of ${executed} executed cases passed` : 'No completed cases yet',
    ],
  ];
  const markup = cells.map(
    ([label, value, foot]) =>
      `<div class="stat"><div class="stat-label">${label}</div><div class="stat-value">${value}</div><div class="stat-foot">${foot}</div></div>`,
  );
  return `<div class="stats" aria-label="Project execution summary">${markup.join('')}</div>`;
}

function resultRow(status, count, total) {
  const label = STATUS_LABELS[status].toLowerCase();
  return `<li>
    <button type="button" data-action="filter-result" data-status="${status}" aria-label="Show ${count} ${label} test cases">
      <span class="result-label">${badge(status)}</span>
      <progress class="result-track ${status}" max="${total || 1}" value="${count}" aria-hidden="true"></progress>
      <strong>${count}</strong>
      <span class="result-percent">${percent(count, total)}%</span>
    </button>
  </li>`;
}

function executionSummary() {
  const tests = project().tests;
  const counts = { passed: 0, failed: 0, blocked: 0, running: 0, pending: 0, skipped: 0, interrupted: 0, untested: 0 };
  for (const test of tests) counts[latest(test)] += 1;
  const shown = Object.entries(counts).filter(([status, count]) => count || ['passed', 'failed', 'untested'].includes(status));
  const footer = tests.length ? 'Select a result to review matching test cases.' : 'Create a test case to start tracking results.';
  return `<section class="panel execution-summary">
    <div class="panel-head">
      <div><h2>Execution overview</h2><p>Latest result for each test case</p></div>
      <a href="#runs" class="text-button">View runs ${icon('arrow')}</a>
    </div>
    <ul class="execution-breakdown">${shown.map(([status, count]) => resultRow(status, count, tests.length)).join('')}</ul>
    <div class="panel-bottom"><span>${footer}</span></div>
  </section>`;
}

function latestRunBody(run) {
  if (!run) {
    return empty(
      'No executions yet',
      'Add cases to your test plan, then start a manual or automated run.',
      `<a class="button" href="#plan">${icon('plan')}Open test plan</a>`,
    );
  }
  const finished = run.tests.filter((test) => TERMINAL_STATUSES.includes(test.status)).length;
  const isRunning = run.status === 'running';
  return `<div class="latest-run-body">
    <a class="case-link latest-run-name" href="#run/${e(run.id)}">${e(run.name || `${cap(run.mode || 'automation')} test run`)}</a>
    <div class="run-meta">${badge(run.mode || 'automation')}<span>${finished} of ${run.tests.length} cases complete</span></div>
    ${progress(percent(finished, run.tests.length))}
    <a class="button" href="#run/${e(run.id)}">${icon(isRunning ? 'runs' : 'reports')}${isRunning ? 'Continue execution' : 'View results'}</a>
  </div>`;
}

function latestExecution() {
  const run = runs()[0];
  const tests = project().tests;
  const automated = tests.filter((test) => test.steps.length).length;
  return `<section class="panel latest-execution">
    <div class="panel-head">
      <div><h2>Latest test run</h2><p>${run ? e(new Date(run.startedAt).toLocaleString()) : 'Manual and automated execution'}</p></div>
      ${run ? badge(run.status) : ''}
    </div>
    ${latestRunBody(run)}
    <div class="panel-bottom">
      <span>${automated} of ${tests.length} cases have automation steps</span>
      <a class="text-button" href="${autoUrl()}">Automation Studio ${icon('arrow')}</a>
    </div>
  </section>`;
}

function overviewDescription(attention, total) {
  if (attention) {
    return `${attention} test ${attention === 1 ? 'case needs' : 'cases need'} attention. Review failed and blocked results before your next run.`;
  }
  return total ? 'Review your test cases and follow the latest execution results.' : 'Create your first test case to begin tracking quality.';
}

function dashboardView() {
  const tests = project().tests;
  const attention = tests.filter((test) => ['failed', 'blocked'].includes(latest(test))).length;
  const recent = [...tests]
    .reverse()
    .sort((a, b) => OVERVIEW_ORDER[latest(a)] - OVERVIEW_ORDER[latest(b)])
    .slice(0, 4);
  const footer = tests.length
    ? `<div class="recent-footer"><span>Showing ${recent.length} of ${tests.length} cases</span><a class="text-button" href="#plan">Open test plan ${icon('arrow')}</a></div>`
    : '';
  const actions = button('new-run', 'New test run', 'runs') + button('new-case', 'Create test case', 'plus', '', 'primary');
  return `${heading('Project overview', overviewDescription(attention, tests.length), actions)}
    ${stats()}
    <section class="panel overview-cases">
      <div class="panel-head">
        <div>
          <h2>Test cases</h2>
          <p>${attention ? 'Failed and blocked cases appear first.' : 'Recently added cases, with their latest results.'}</p>
        </div>
        <a class="text-button" href="#cases">View all ${tests.length} ${icon('arrow')}</a>
      </div>
      ${caseTable(recent)}
      ${footer}
    </section>
    <div class="dashboard-grid">${executionSummary()}${latestExecution()}</div>`;
}

/* ---- Test cases: filters, table, pagination ----------------------------- */

function isNarrowed() {
  return Boolean(filters.search || filters.status || filters.priority || filters.category || filters.suite || filters.folder !== null);
}

function matchesFilters(test, folderIds) {
  const search = filters.search.toLowerCase();
  const haystack = `${tc(test)} ${test.name} ${test.qa?.description || ''} ${test.qa?.owner || ''}`.toLowerCase();
  return (
    (filters.folder === null || (folderIds ? folderIds.has(test.folderId) : !test.folderId)) &&
    (!search || haystack.includes(search)) &&
    (!filters.status || latest(test) === filters.status) &&
    (!filters.category || (test.qa?.category || 'Functional') === filters.category) &&
    (!filters.priority || (test.qa?.priority || 'medium') === filters.priority) &&
    (!filters.suite || inSuite(test, filters.suite))
  );
}

function filtered() {
  const folderIds = filters.folder ? StudioFolders.descendants(project().folders, filters.folder) : null;
  return project().tests.filter((test) => matchesFilters(test, folderIds));
}

function caseTableEmpty(allowFilterReset) {
  if (allowFilterReset && isNarrowed()) {
    return empty(
      'No matching test cases',
      'Try a different search or clear the filters to see all test cases.',
      button('clear-filters', 'Clear filters', 'refresh'),
    );
  }
  return empty(
    'Create your first test case',
    'Describe the scenario and its expected result, then add it to a test plan.',
    button('new-case', 'Create test case', 'plus', '', 'primary'),
  );
}

function caseRowAction(test) {
  if (test.inTestPlan) {
    return `<button type="button" class="icon-button row-action" data-action="run-case" data-id="${e(test.id)}" aria-label="Run ${e(test.name)}">${icon('runs')}</button>`;
  }
  return `<a class="text-button" href="#case/${e(test.id)}" aria-label="Review ${e(test.name)}">Review ${icon('arrow')}</a>`;
}

function caseRow(test, isSelectable) {
  const priority = test.qa?.priority || 'medium';
  const placement = StudioFolders.path(project().folders, test.folderId) || cap(test.qa?.type || 'functional');
  const choice = isSelectable
    ? `<td class="case-select" role="cell"><input type="checkbox" class="check" data-select="${e(test.id)}" aria-label="Select ${e(test.name)}" ${selected.has(test.id) ? 'checked' : ''}></td>`
    : '';
  return `<tr role="row">
    ${choice}
    <td class="case-identity" role="cell">
      <a class="case-link" href="#case/${e(test.id)}">
        <span class="case-title">${e(test.name)}</span>
        <span class="case-sub"><span class="id-text">${tc(test)}</span> · ${e(placement)}</span>
      </a>
    </td>
    <td data-label="Priority" role="cell"><span class="priority ${e(priority)}">${cap(priority)}</span></td>
    <td data-label="Execution" role="cell">${badge(mode(test))}<span class="case-sub">${test.inTestPlan ? 'In Test plan' : 'Not in Test plan'}</span></td>
    <td data-label="Last result" role="cell">${badge(latest(test))}</td>
    <td data-label="Assignee" role="cell"><span class="case-owner">${e(test.qa?.owner || 'Unassigned')}</span></td>
    <td class="case-actions" role="cell">${caseRowAction(test)}</td>
  </tr>`;
}

function caseTable(tests, isSelectable = false) {
  if (!tests.length) return caseTableEmpty(isSelectable);
  const matching = isSelectable ? filtered() : [];
  const allSelected = matching.length > 0 && matching.every((test) => selected.has(test.id));
  const selectHeader = isSelectable
    ? `<th scope="col"><input type="checkbox" id="select-all" aria-label="Select all matching cases" ${allSelected ? 'checked' : ''}></th>`
    : '';
  return `<div class="table-scroll">
    <table class="case-table ${isSelectable ? 'selectable' : ''}" role="table">
      <caption class="sr-only">Test cases with priority, execution mode, latest result, and assignee</caption>
      <thead role="rowgroup">
        <tr role="row">
          ${selectHeader}
          <th scope="col">Test case</th>
          <th scope="col">Priority</th>
          <th scope="col">Execution</th>
          <th scope="col">Last result</th>
          <th scope="col">Assignee</th>
          <th scope="col"><span class="sr-only">Actions</span></th>
        </tr>
      </thead>
      <tbody role="rowgroup">${tests.map((test) => caseRow(test, isSelectable)).join('')}</tbody>
    </table>
  </div>`;
}

function casePager(total) {
  const pages = Math.max(1, Math.ceil(total / CASE_PAGE_SIZE));
  if (pages < 2) return '';
  const previous = button('case-page', 'Previous', 'back', casePage > 0 ? 'data-dir="-1"' : 'disabled');
  const next = button('case-page', 'Next', 'arrow', casePage < pages - 1 ? 'data-dir="1"' : 'disabled');
  return `<nav class="pager" aria-label="Test case pages">${previous}<span>Page ${casePage + 1} of ${pages}</span>${next}</nav>`;
}

function bulkBar() {
  if (!selected.size) return '';
  const allPlanned = project().tests.filter((test) => selected.has(test.id)).every((test) => test.inTestPlan === true);
  const runExtra = allPlanned ? '' : 'disabled title="Transfer all selected cases to the Test plan first"';
  return `<div class="bulk-bar">
    <span>${selected.size} cases selected</span>
    ${button('add-to-plan', 'Transfer to Test plan', 'plus')}
    ${button('run-selected', 'Run selected', 'runs', runExtra)}
    ${button('clear-selected', 'Clear', 'close')}
  </div>`;
}

function caseResults() {
  const tests = filtered();
  casePage = Math.min(casePage, Math.max(0, Math.ceil(tests.length / CASE_PAGE_SIZE) - 1));
  const start = casePage * CASE_PAGE_SIZE;
  const shown = tests.slice(start, start + CASE_PAGE_SIZE);
  const range = tests.length ? `${start + 1}–${start + shown.length} of ${tests.length} matching cases` : '0 cases';
  return `<div class="case-result-summary">
      <span role="status" aria-live="polite">${tests.length} matching ${tests.length === 1 ? 'case' : 'cases'} · ${project().tests.length} total</span>
      ${isNarrowed() ? button('clear-filters', 'Clear filters', 'close') : ''}
    </div>
    ${bulkBar()}
    ${caseTable(shown, true)}
    ${casePager(tests.length)}
    <div class="recent-footer"><span>${range}</span><span>Select cases to add them to a test plan.</span></div>`;
}

function syncSelectAll() {
  const box = $('#select-all');
  if (!box) return;
  const matching = filtered();
  const chosen = matching.filter((test) => selected.has(test.id)).length;
  box.checked = matching.length > 0 && chosen === matching.length;
  box.indeterminate = chosen > 0 && chosen < matching.length;
}

// Filtering re-renders only the results, keeping focus on the control that changed them.
function renderCaseResults() {
  const active = document.activeElement;
  const focusedCase = active?.dataset.select;
  const focusedAll = active?.id === 'select-all';
  $('#case-results').innerHTML = caseResults();
  syncSelectAll();
  if (focusedCase) document.querySelector(`[data-select="${CSS.escape(focusedCase)}"]`)?.focus();
  else if (focusedAll) $('#select-all')?.focus();
}

function filterSelect(key, label, ariaLabel, items, emptyLabel) {
  return `<label>${label}<select data-filter="${key}" aria-label="${ariaLabel}">${options(items, filters[key], emptyLabel)}</select></label>`;
}

function casesView() {
  const folderName = filters.folder === null ? 'All test cases' : filters.folder ? StudioFolders.path(project().folders, filters.folder) : 'Unfiled';
  const isDesktop = matchMedia('(min-width: 1101px)').matches;
  const openOnDesktop = isDesktop ? 'open' : '';
  const actions = button('export-cases', 'Export CSV', 'download') + button('new-case', 'Create test case', 'plus', '', 'primary');
  return `${heading('Test cases', 'Find a scenario, review its result, or select cases for your test plan.', actions)}
    <div class="cases-workspace">
      <aside class="panel folder-browser">
        <details class="folder-disclosure" ${openOnDesktop}>
          <summary>${icon('suites')}Browse folders ${icon('down')}</summary>
          <div id="folder-browser">${qaFolderTree()}</div>
        </details>
      </aside>
      <section class="panel cases-panel">
        <div class="panel-head">
          <div><h2>${e(folderName)}</h2>${filters.folder ? '<p>Includes cases in subfolders</p>' : ''}</div>
        </div>
        <div class="filters">
          <label class="search-field">
            ${icon('search')}
            <span class="sr-only">Search test cases</span>
            <input id="case-search" type="search" placeholder="Search by title, ID, or assignee…" value="${e(filters.search)}">
          </label>
          <details class="case-filter-options" ${openOnDesktop}>
            <summary>${icon('settings')}Filters ${icon('down')}</summary>
            <div class="filter-fields">
              ${filterSelect('status', 'Result', 'Filter by result', RESULT_FILTERS, 'All results')}
              ${filterSelect('priority', 'Priority', 'Filter by priority', CASE_PRIORITIES, 'All priorities')}
              ${filterSelect('category', 'Category', 'Filter by category', CASE_CATEGORIES, 'All categories')}
              ${filterSelect('suite', 'Suite', 'Filter by suite', project().suites, 'All suites')}
            </div>
          </details>
        </div>
        <div id="case-results">${caseResults()}</div>
      </section>
    </div>`;
}

function exportCases() {
  const headers = [
    'ID', 'Title', 'Priority', 'Type', 'Assignee', 'Execution', 'Last result', 'Description', 'Preconditions', 'Steps',
    'Expected result', 'Module', 'Category', 'Test data', 'Requirement reference', 'Assumptions', 'Workflow details', 'Generation ID',
  ];
  const rows = filtered().map((test) => {
    const qa = test.qa || {};
    const steps = manualSteps(test).map((step, index) => `${index + 1}. ${step.instruction}\nExpected: ${step.expectedResult}`);
    return [
      test.tcNumber ? tc(test) : `Draft ${test.id.slice(0, 8)}`,
      test.name,
      qa.priority || 'medium',
      qa.type || 'functional',
      qa.owner,
      mode(test),
      latest(test),
      qa.description,
      qa.preconditions,
      steps.join('\n'),
      qa.expectedResult,
      qa.module,
      qa.category || 'Functional',
      JSON.stringify(qa.testData || []),
      qa.requirementReference,
      (qa.assumptions || []).join('\n'),
      qa.workflowDetails,
      qa.generationId,
    ];
  });
  downloadCsv('qa-studio-test-cases.csv', headers, rows);
  notify('Test cases exported');
}

/* ---- Folder tree -------------------------------------------------------- */

function folderCaseLinks(folderId) {
  return project()
    .tests.filter((test) => (test.folderId || '') === folderId)
    .map(
      (test) =>
        `<a class="folder-case" href="#case/${e(test.id)}" data-action="open-folder-case" data-id="${e(test.id)}" title="${e(test.name)}">${icon('cases')}<span>${e(test.name)}</span><small>${tc(test)}</small></a>`,
    )
    .join('');
}

function folderBranch(folder) {
  const current = project();
  const id = e(folder.id);
  const isCollapsed = collapsedFolders.has(folder.id);
  const isActive = filters.folder === folder.id;
  const ids = StudioFolders.descendants(current.folders, folder.id);
  const count = current.tests.filter((test) => ids.has(test.folderId)).length;
  return `<div class="qa-folder-branch" data-folder="${id}">
    <div class="qa-folder-row ${isActive ? 'active' : ''}">
      <button type="button" class="folder-toggle" data-action="toggle-folder" data-id="${id}" aria-label="${isCollapsed ? 'Expand' : 'Collapse'} ${e(folder.name)}" aria-expanded="${!isCollapsed}">${icon(isCollapsed ? 'chevron' : 'down')}</button>
      <button type="button" class="folder-select" data-action="select-folder" data-id="${id}" title="${e(StudioFolders.path(current.folders, folder.id))}" ${isActive ? 'aria-current="true"' : ''}>${icon('suites')}<span>${e(folder.name)}</span><small>${count}</small></button>
      ${StudioFolders.addMenu(folder.id, folder.name, 'new-case')}
    </div>
    <div class="qa-folder-children" ${isCollapsed ? 'hidden' : ''}>${folderChildren(folder.id)}${folderCaseLinks(folder.id)}</div>
  </div>`;
}

function folderChildren(parentId) {
  return project()
    .folders.filter((folder) => (folder.parentId || null) === parentId)
    .map(folderBranch)
    .join('');
}

function qaFolderTree() {
  const tests = project().tests;
  const unfiled = tests.filter((test) => !test.folderId).length;
  return `<div class="folder-browser-head">
      <h2>Test cases</h2>
      ${StudioFolders.addMenu(filters.folder || '', 'Test cases', 'new-case')}
    </div>
    <nav aria-label="Test case folders">
      <button type="button" class="folder-root ${filters.folder === null ? 'active' : ''}" data-action="select-folder" data-scope="all">${icon('cases')}All test cases <small>${tests.length}</small></button>
      ${folderChildren(null)}
      <button type="button" class="folder-root ${filters.folder === '' ? 'active' : ''}" data-action="select-folder" data-scope="unfiled">${icon('suites')}Unfiled <small>${unfiled}</small></button>
      ${folderCaseLinks('')}
    </nav>`;
}

/* ---- Case details ------------------------------------------------------- */

function stepList(steps, emptyExpected) {
  return steps
    .map((step, index) => {
      const expected = step.expectedResult || emptyExpected;
      return `<div class="detail-step">
        <span class="step-number">${index + 1}</span>
        <div>
          <strong>${e(step.instruction)}</strong>
          ${expected ? `<p><b>Expected result</b><br>${e(expected)}</p>` : ''}
        </div>
      </div>`;
    })
    .join('');
}

function preconditionSteps(item) {
  return `<div class="detail-steps">${stepList(manualSteps(item))}</div>`;
}

function casePrecondition(test) {
  const item = project().prerequisites.find((pre) => pre.id === test.prerequisiteId);
  const newButton = button('new-precondition', 'New precondition', 'plus', `data-case-id="${e(test.id)}"`);
  const body = item
    ? `<div class="prose"><strong>${e(item.name)}</strong>${item.qa?.description ? `<p>${e(item.qa.description)}</p>` : ''}</div>
       ${preconditionSteps(item)}
       <div class="panel-bottom">
         ${button('edit-precondition', 'Edit precondition', 'edit', `data-id="${e(item.id)}"`)}
         <a class="text-button" href="${autoUrl(null, { prerequisiteId: item.id })}">Configure automation ${icon('arrow')}</a>
       </div>`
    : '<div class="prose">Choose an existing precondition in Edit case, or create one here to link it to this case.</div>';
  return `<section class="panel">
    <div class="panel-head"><h2>Reusable precondition</h2>${newButton}</div>
    ${body}
  </section>`;
}

function lastRunDetails(test) {
  const run = lastRunFor(test);
  const rows = [
    ['Last run status', badge(latest(test))],
    ['Last run', run ? e(new Date(run.startedAt).toLocaleString()) : 'No runs yet'],
  ];
  if (run) {
    rows.push(['Run type', badge(run.mode === 'manual' ? 'manual' : 'automation')]);
    rows.push([
      'Results',
      `<a class="text-button" href="#run/${e(run.id)}" data-action="view-case-run" data-id="${e(run.id)}" data-test-id="${e(test.id)}">View latest run</a>`,
    ]);
  }
  return rows;
}

function caseMetaList(test) {
  const qa = test.qa || {};
  const current = project();
  const priority = qa.priority || 'medium';
  const rows = [
    ['Test case ID', tc(test)],
    ['Category', e(qa.category || 'Functional')],
    ['Module', e(qa.module || 'Unspecified')],
    ['Priority', `<span class="priority ${e(priority)}">${cap(priority)}</span>`],
    ['Test plan', test.inTestPlan === true ? 'Ready for execution' : 'Transfer from Test cases before execution'],
    ['Execution', badge(mode(test))],
    ...lastRunDetails(test),
    ['Assignee', e(qa.owner || 'Unassigned')],
    ['Folder', e(StudioFolders.path(current.folders, test.folderId) || 'Unfiled')],
    ['Suite', e(current.suites.find((suite) => suite.id === test.suiteId)?.name || 'No suite')],
    ['Created', shortDate(qa.createdAt)],
  ];
  return rows.map(([label, value]) => `<div class="meta-item"><span>${label}</span><strong>${value}</strong></div>`).join('');
}

function caseIssues(test) {
  const tracker = state.bugTracker;
  const issues = (state.reportedIssues || []).filter((issue) => issue.projectId === project().id && issue.testId === test.id);
  if (!tracker?.connected && !issues.length) return '';
  const reportBlock = tracker?.connected
    ? `<div class="prose">Report a bug in ${e(tracker.projectName || tracker.projectKey)}. Review the details before sending them to Jira.</div>
       <div class="panel-bottom">${button('report-issue', 'Report issue', 'plus', `data-id="${e(test.id)}"`, 'primary')}</div>`
    : '';
  const list = issues.length
    ? `<ul class="reported-issues">${issues
        .map((issue) => `<li><a href="${e(issue.url)}" target="_blank" rel="noopener noreferrer">${e(issue.key)}</a><span>${e(issue.summary)}</span></li>`)
        .join('')}</ul>`
    : '';
  return `<section class="panel">
    <div class="panel-head"><h2>${tracker?.connected ? 'Report issue' : 'Reported issues'}</h2></div>
    ${reportBlock}
    ${list}
  </section>`;
}

function caseStepsPanel(test) {
  const id = e(test.id);
  const qa = test.qa || {};
  const steps = manualSteps(test);
  const stepsMarkup = steps.length
    ? stepList(steps, 'Not specified')
    : empty('Add your first step', 'Describe an action and its expected result.', button('edit-case', 'Add steps', 'plus', `data-id="${id}"`));
  return `<section class="panel">
    <div class="panel-head"><h2>Test steps</h2><span class="tag">${steps.length} steps</span></div>
    <div class="detail-steps">${stepsMarkup}</div>
    ${qa.expectedResult ? `<div class="panel-head"><h2>Overall expected result</h2></div><div class="prose">${e(qa.expectedResult)}</div>` : ''}
  </section>`;
}

function caseView(id) {
  const test = project().tests.find((item) => item.id === id);
  if (!test) {
    return empty('Test case not found', 'Choose a case in this project.', '<a class="button" href="#cases">View test cases</a>');
  }
  const qa = test.qa || {};
  const idAttr = `data-id="${e(id)}"`;
  const runExtra = test.inTestPlan === true ? '' : 'disabled title="Transfer this case to the Test plan first"';
  const actions = button('edit-case', 'Edit case', 'edit', idAttr) + button('run-case', 'Run test case', 'runs', `${idAttr} ${runExtra}`, 'primary');
  const automationSummary = test.steps.length
    ? `${test.steps.length} configured automation steps.`
    : 'Map browser actions and locators to automate this case.';
  return `<a class="back-link" href="#cases">${icon('back')}Back to test cases</a>
    ${heading(test.name, `${tc(test)} · ${cap(qa.type || 'functional')} test case`, actions)}
    <div class="section-grid">
      <div class="stack">
        <section class="panel">
          <div class="panel-head"><h2>Test case overview</h2>${badge(latest(test))}</div>
          <div class="prose">${e(qa.description || 'Add a description to explain what this test verifies.')}</div>
          ${qa.preconditions ? `<div class="panel-head"><h2>Preconditions</h2></div><div class="prose">${e(qa.preconditions)}</div>` : ''}
        </section>
        ${casePrecondition(test)}
        ${caseGenerationDetails(qa)}
        ${caseStepsPanel(test)}
      </div>
      <div class="stack">
        <section class="panel">
          <div class="panel-head"><h2>Details</h2></div>
          <div class="meta-list">${caseMetaList(test)}</div>
        </section>
        <section class="panel">
          <div class="panel-head"><h2>Automation</h2>${icon('bolt')}</div>
          <div class="prose">${automationSummary}</div>
          <div class="panel-bottom"><a class="text-button" href="${autoUrl(id)}">Open in Automation Studio ${icon('arrow')}</a></div>
        </section>
        ${caseIssues(test)}
        <div class="case-manage-actions">
          ${button('copy-case', 'Copy test case', 'copy', idAttr)}
          ${button('delete-case', 'Delete test case', 'trash', idAttr, 'danger')}
        </div>
      </div>
    </div>`;
}

function confirmDeleteCase(id) {
  const snapshot = structuredClone(project());
  const test = snapshot.tests.find((item) => item.id === id);
  modal(
    'Delete test case?',
    `<p class="field-hint">Delete ${e(tc(test))} — ${e(test.name)}? Existing run results will remain in your history.</p>`,
    async () => {
      snapshot.tests = snapshot.tests.filter((item) => item.id !== id);
      await saveProject(snapshot);
      selected.delete(id);
      go('cases');
      notify('Test case deleted');
    },
    'Delete test case',
  );
}

// A copy is a new, unplanned case: it gets its own id and number, and no automation mapping.
async function copyCase(id) {
  const snapshot = structuredClone(project());
  const original = snapshot.tests.find((item) => item.id === id);
  const copy = structuredClone(original);
  copy.id = crypto.randomUUID();
  copy.name = `${original.name.slice(0, 105)} (copy)`;
  copy.inTestPlan = false;
  delete copy.tcNumber;
  delete copy.automation;
  if (copy.qa) delete copy.qa.createdAt;
  snapshot.tests.push(copy);
  await saveProject(snapshot);
  go(`case/${copy.id}`);
  notify('Test case copied');
}

/* ---- Dialog ------------------------------------------------------------- */

function modal(title, body, handler, submitLabel = 'Save', isWide = false) {
  const submit = $('#dialog-submit');
  $('#dialog-title').textContent = title;
  $('#dialog-body').innerHTML = body;
  if ($('#step-editors')) {
    $('#step-editors').insertAdjacentHTML(
      'beforebegin',
      `<div class="step-editor-toolbar">
        <label><input type="checkbox" id="step-select-all">Select all steps</label>
        <button type="button" class="button" id="copy-selected-steps" data-action="copy-selected-steps" disabled>Copy selected (0)</button>
        <span>Drag the handle to reorder, or use the arrow buttons.</span>
      </div>
      <p id="step-editor-status" class="field-hint" role="status" aria-live="polite"></p>`,
    );
    syncStepEditor();
  }
  $('#dialog-error').hidden = true;
  submit.textContent = submitLabel;
  submit.title = submitLabel;
  $('#dialog').classList.toggle('wide', isWide);
  modalSubmit = handler;
  $('#dialog').showModal();
}

async function handleDialogSubmit(event) {
  event.preventDefault();
  const submit = $('#dialog-submit');
  const errorBox = $('#dialog-error');
  submit.disabled = true;
  errorBox.hidden = true;
  try {
    await modalSubmit(Object.fromEntries(new FormData(event.target)), event.target);
    $('#dialog').close();
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.hidden = false;
  } finally {
    submit.disabled = false;
  }
}

/* ---- Step editor -------------------------------------------------------- */

function stepEditorRow(step = {}, index = 0) {
  const number = index + 1;
  return `<div class="editor-step" data-step-id="${e(step.id || crypto.randomUUID())}">
    <div class="step-editor-controls">
      <span class="step-number">${number}</span>
      <input type="checkbox" data-step-select aria-label="Select step ${number}">
      <button class="icon-button step-drag-handle" type="button" draggable="true" aria-label="Drag step ${number} to reorder" title="Drag to reorder">${icon('move')}</button>
    </div>
    <label>Action / instruction<textarea data-instruction required maxlength="10000" placeholder="Describe what the tester should do">${e(step.instruction || '')}</textarea></label>
    <label>Expected result<textarea data-expected maxlength="10000" placeholder="Describe the expected outcome">${e(step.expectedResult || '')}</textarea></label>
    <div class="step-editor-actions">
      <button type="button" class="icon-button" data-step-action="up" aria-label="Move step ${number} up">${icon('up')}</button>
      <button type="button" class="icon-button" data-step-action="down" aria-label="Move step ${number} down">${icon('down')}</button>
      <button type="button" class="icon-button" data-step-action="copy" aria-label="Copy step ${number}">${icon('copy')}</button>
      <button type="button" class="icon-button" data-action="remove-step" aria-label="Remove step ${number}">${icon('close')}</button>
    </div>
  </div>`;
}

function stepEditorSection(title, steps) {
  const rows = (steps.length ? steps : [{}]).map(stepEditorRow).join('');
  return `<div class="editor-section-heading"><h3>${title}</h3>${button('add-step', 'Add step', 'plus')}</div>
    <div id="step-editors">${rows}</div>`;
}

function stepEditorValues() {
  return [...document.querySelectorAll('#step-editors .editor-step')].map((row) => ({
    id: row.dataset.stepId,
    instruction: row.querySelector('[data-instruction]').value,
    expectedResult: row.querySelector('[data-expected]').value,
  }));
}

function syncStepRow(row, index, total) {
  const number = index + 1;
  row.querySelector('.step-number').textContent = number;
  row.querySelector('[data-step-select]').setAttribute('aria-label', `Select step ${number}`);
  row.querySelector('.step-drag-handle').setAttribute('aria-label', `Drag step ${number} to reorder`);
  row.querySelector('[data-action="remove-step"]').setAttribute('aria-label', `Remove step ${number}`);
  const up = row.querySelector('[data-step-action="up"]');
  const down = row.querySelector('[data-step-action="down"]');
  up.setAttribute('aria-label', `Move step ${number} up`);
  up.disabled = index === 0;
  down.setAttribute('aria-label', `Move step ${number} down`);
  down.disabled = index === total - 1;
  row.querySelector('[data-step-action="copy"]').setAttribute('aria-label', `Copy step ${number}`);
  row.classList.toggle('step-selected', row.querySelector('[data-step-select]').checked);
}

function syncStepEditor(message = '') {
  const rows = [...document.querySelectorAll('#step-editors .editor-step')];
  rows.forEach((row, index) => syncStepRow(row, index, rows.length));
  const chosen = rows.filter((row) => row.querySelector('[data-step-select]').checked).length;
  const selectAll = $('#step-select-all');
  if (selectAll) {
    selectAll.checked = rows.length > 0 && chosen === rows.length;
    selectAll.indeterminate = chosen > 0 && chosen < rows.length;
    selectAll.disabled = !rows.length;
  }
  const copy = $('#copy-selected-steps');
  if (copy) {
    copy.disabled = !chosen;
    copy.textContent = `Copy selected (${chosen})`;
  }
  if (message && $('#step-editor-status')) $('#step-editor-status').textContent = message;
}

function copyEditorSteps(rows) {
  const container = $('#step-editors');
  if (container.children.length + rows.length > MAX_STEPS) {
    notify(`A test case can contain at most ${MAX_STEPS} steps.`, true);
    return;
  }
  let anchor = rows.at(-1);
  if (!anchor) return;
  for (const row of rows) {
    const values = {
      instruction: row.querySelector('[data-instruction]').value,
      expectedResult: row.querySelector('[data-expected]').value,
    };
    anchor.insertAdjacentHTML('afterend', stepEditorRow(values));
    anchor = anchor.nextElementSibling;
  }
  document.querySelectorAll('[data-step-select]').forEach((box) => {
    box.checked = false;
  });
  syncStepEditor(`${rows.length} step${rows.length === 1 ? '' : 's'} copied.`);
  anchor.querySelector('[data-instruction]').focus();
}

function addEditorStep() {
  const container = $('#step-editors');
  if (container.children.length >= MAX_STEPS) {
    notify(`A test case can contain at most ${MAX_STEPS} steps.`, true);
    return;
  }
  container.insertAdjacentHTML('beforeend', stepEditorRow({}, container.children.length));
  syncStepEditor();
  container.lastElementChild.querySelector('textarea').focus();
}

function stepPosition(row) {
  return [...row.parentElement.children].indexOf(row) + 1;
}

function handleStepAction(control) {
  if (control.id === 'copy-selected-steps') {
    const rows = [...document.querySelectorAll('#step-editors .editor-step')];
    copyEditorSteps(rows.filter((row) => row.querySelector('[data-step-select]').checked));
    return;
  }
  const row = control.closest('.editor-step');
  const action = control.dataset.stepAction;
  if (action === 'copy') {
    copyEditorSteps([row]);
    return;
  }
  if (action === 'up' && row.previousElementSibling) row.previousElementSibling.before(row);
  if (action === 'down' && row.nextElementSibling) row.nextElementSibling.after(row);
  syncStepEditor(`Step moved to position ${stepPosition(row)}.`);
  // Focus stays on the control that moved, or on the handle if that control is now disabled.
  const focus = row.querySelector(`[data-step-action="${action}"]`);
  (focus.disabled ? row.querySelector('.step-drag-handle') : focus).focus();
}

function clearStepDrag() {
  document.querySelectorAll('.editor-step').forEach((row) => {
    row.classList.remove('step-dragging', 'step-drop-before', 'step-drop-after');
  });
  draggedStep = null;
}

function isUpperHalf(row, event) {
  const bounds = row.getBoundingClientRect();
  return event.clientY < bounds.top + bounds.height / 2;
}

function handleStepDragStart(event) {
  const handle = event.target.closest('.step-drag-handle');
  if (!handle) return;
  draggedStep = handle.closest('.editor-step');
  draggedStep.classList.add('step-dragging');
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', draggedStep.dataset.stepId);
}

function handleStepDragOver(event) {
  const row = event.target.closest('#step-editors .editor-step');
  if (!draggedStep || !row || row === draggedStep) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  document.querySelectorAll('.step-drop-before,.step-drop-after').forEach((item) => {
    item.classList.remove('step-drop-before', 'step-drop-after');
  });
  row.classList.add(isUpperHalf(row, event) ? 'step-drop-before' : 'step-drop-after');
}

function handleStepDrop(event) {
  const row = event.target.closest('#step-editors .editor-step');
  if (!draggedStep || !row) return;
  event.preventDefault();
  const moved = draggedStep;
  if (row !== moved) {
    if (isUpperHalf(row, event)) row.before(moved);
    else row.after(moved);
  }
  clearStepDrag();
  syncStepEditor(`Step moved to position ${stepPosition(moved)}.`);
  moved.querySelector('.step-drag-handle').focus();
}

/* ---- Case editor -------------------------------------------------------- */

function caseFolderField(snapshot, selectedFolder) {
  return `<div class="case-folder-field">
    <label>Folder
      <select name="folderId" aria-label="Folder">
        ${options(StudioFolders.choices(snapshot.folders), selectedFolder, 'Unfiled')}
        <option value="${NEW_FOLDER}">＋ Add folder…</option>
      </select>
    </label>
    <div class="case-folder-create" hidden>
      <input name="newFolderName" aria-label="New folder name" maxlength="120" placeholder="New folder name">
      <button type="button" class="button primary" data-folder-create>Add</button>
      <button type="button" class="button" data-folder-cancel>Cancel</button>
    </div>
  </div>`;
}

// Lets the editor create a folder without leaving the dialog. It is saved at once, so every save path can use it.
function bindCaseFolderField(snapshot) {
  const select = $('#dialog-body [name="folderId"]');
  const row = $('#dialog-body .case-folder-create');
  const nameInput = row.querySelector('input');
  const addButton = row.querySelector('[data-folder-create]');
  const errorBox = $('#dialog-error');
  let previous = select.value;

  function close(value) {
    row.hidden = true;
    nameInput.value = '';
    select.value = value;
    previous = value;
    select.focus();
  }

  async function createFolder(folderName) {
    if (!state.features?.nestedFolders) throw new Error(FOLDER_FEATURE_MISSING);
    const item = { id: crypto.randomUUID(), name: folderName, parentId: null };
    const current = structuredClone(project());
    const from = snapshot.revision;
    if (current.revision !== from) {
      throw new Error('This project changed in another window. Close this dialog, refresh, and try again.');
    }
    current.folders.push(item);
    const saved = await saveProject(current);
    snapshot.folders.push(item);
    snapshot.revision = saved.revision;
    document.dispatchEvent(new CustomEvent('studio:project-revision', { detail: { projectId: saved.id, from, to: saved.revision } }));
    select.querySelector(`option[value="${NEW_FOLDER}"]`).insertAdjacentHTML('beforebegin', `<option value="${e(item.id)}">${e(item.name)}</option>`);
    return item;
  }

  async function submitNewFolder() {
    const folderName = nameInput.value.trim();
    errorBox.hidden = true;
    try {
      if (!folderName) throw new Error('Enter a folder name.');
      const existing = snapshot.folders.find((folder) => !folder.parentId && folder.name.toLowerCase() === folderName.toLowerCase());
      if (existing) {
        close(existing.id);
        return;
      }
      addButton.disabled = true;
      const item = await createFolder(folderName);
      close(item.id);
      notify(`Folder "${item.name}" created`);
    } catch (error) {
      errorBox.textContent = error.message;
      errorBox.hidden = false;
    } finally {
      addButton.disabled = false;
    }
  }

  select.addEventListener('change', () => {
    if (select.value !== NEW_FOLDER) {
      previous = select.value;
      return;
    }
    row.hidden = false;
    nameInput.focus();
  });
  row.querySelector('[data-folder-cancel]').addEventListener('click', () => close(previous));
  addButton.addEventListener('click', submitNewFolder);
  nameInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submitNewFolder();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(previous);
    }
  });
}

function caseEditorSaveHint(isRequirementDraft, isApproval) {
  if (!isRequirementDraft) {
    return 'Your case opens on its details screen after saving. To configure browser actions and locators, choose Open in Automation Studio from the case details.';
  }
  return isApproval
    ? 'Confirm approval to save this case and add it to Test cases. Cancel keeps this draft pending.'
    : 'Save this draft, then approve it from the Requirement page to add it to Test cases.';
}

function caseEditorBody(snapshot, old, folderId, saveHint) {
  const qa = old?.qa || {};
  const executionChoices = [
    { id: 'manual', name: 'Manual testing' },
    { id: 'automation', name: 'Automation Studio' },
  ];
  return `${input('name', 'Test case title', old?.name || '', 'required maxlength="120" placeholder="e.g. Sign in with valid credentials"')}
    ${area('description', 'Description', qa.description || '', 'placeholder="What does this test verify?"')}
    <div class="form-grid">
      <label>Priority<select name="priority" aria-label="Priority">${options(CASE_PRIORITIES, qa.priority || 'medium')}</select></label>
      <label>Test type<select name="type" aria-label="Test type">${options(CASE_TYPES, qa.type || 'functional')}</select></label>
      ${caseFolderField(snapshot, old ? old.folderId : folderId)}
      <label>Test suite<select name="suiteId" aria-label="Test suite">${options(snapshot.suites, old?.suiteId, 'No suite')}</select></label>
      ${input('owner', 'Assignee', qa.owner || '', 'maxlength="120" placeholder="Name of tester"')}
      <label>Preferred execution<select name="executionMode" aria-label="Preferred execution">${options(executionChoices, qa.executionMode || 'manual')}</select></label>
    </div>
    ${caseGenerationEditor(qa)}
    ${area('preconditions', 'Preconditions', qa.preconditions || '', 'placeholder="Setup, access, or data needed before testing"')}
    <label>Reusable precondition<select name="prerequisiteId" aria-label="Reusable precondition">${options(snapshot.prerequisites, old?.prerequisiteId, 'None')}</select></label>
    <p class="field-hint">Manage shared setup in Preconditions, or create and link one from the case details.</p>
    ${stepEditorSection('Test steps', old ? manualSteps(old) : [{}])}
    ${area('expectedResult', 'Overall expected result', qa.expectedResult || '')}
    <p class="field-hint">${saveHint}</p>`;
}

function readCaseEditor(values, old) {
  const steps = stepEditorValues();
  if (!steps.length) throw new Error('Add at least one test step.');
  if (values.folderId === NEW_FOLDER) throw new Error('Add the new folder or choose an existing one.');
  return {
    ...(old || { id: crypto.randomUUID(), steps: [] }),
    name: values.name,
    folderId: values.folderId || null,
    suiteId: values.suiteId || null,
    prerequisiteId: values.prerequisiteId || null,
    qa: {
      ...old?.qa,
      ...caseGenerationValues(values),
      description: values.description,
      preconditions: values.preconditions,
      expectedResult: values.expectedResult,
      priority: values.priority,
      type: values.type,
      owner: values.owner,
      executionMode: values.executionMode,
      manualSteps: steps,
    },
  };
}

async function saveRequirementDraftCase(snapshot, requirementId, draftId, testCase) {
  const url = `/api/projects/${snapshot.id}/requirements/${requirementId}/drafts/${draftId}`;
  const result = await api(url, 'PUT', { ...testCase, revision: snapshot.revision });
  acceptRequirementProject(result.project);
  const cached = requirementDrafts.get(requirementKey(snapshot.id, requirementId));
  if (cached && cached.revision === snapshot.revision) cached.revision = result.project.revision;
  notify('Draft changes saved. Approve this case to add it to Test cases.');
  render();
}

function editCase(id, folderId = folderContext(), requirementId, onSave, onDraftSubmit) {
  const snapshot = structuredClone(project());
  const requirement = (snapshot.requirements || []).find((item) => item.id === requirementId);
  const source = requirement ? requirement.draftCases || [] : snapshot.tests;
  const old = source.find((item) => item.id === id);
  const saveHint = caseEditorSaveHint(Boolean(requirement), Boolean(onDraftSubmit));

  async function save(values) {
    const testCase = readCaseEditor(values, old);
    if (requirement) {
      if (onDraftSubmit) await onDraftSubmit(testCase, snapshot);
      else await saveRequirementDraftCase(snapshot, requirement.id, id, testCase);
      return;
    }
    if (old) snapshot.tests[snapshot.tests.findIndex((item) => item.id === old.id)] = testCase;
    else snapshot.tests.push(testCase);
    await saveProject(snapshot);
    notify(old ? 'Test case updated' : 'Test case created');
    if (onSave) onSave();
    else go(`case/${testCase.id}`);
  }

  modal(
    old ? 'Edit test case' : 'Create a test case',
    caseEditorBody(snapshot, old, folderId, saveHint),
    save,
    old ? 'Save changes' : 'Create test case',
    true,
  );
  bindCaseFolderField(snapshot);
}

/* ---- Preconditions ------------------------------------------------------ */

function preconditionPanel(item) {
  const id = `data-id="${e(item.id)}"`;
  const usedBy = project().tests.filter((test) => test.prerequisiteId === item.id).length;
  const summary = `${manualSteps(item).length} instructions · ${item.steps.length} automation steps · Used by ${usedBy} cases`;
  return `<section class="panel">
    <div class="panel-head">
      <div><h2>${e(item.name)}</h2><p>${summary}</p></div>
      ${button('edit-precondition', 'Edit', 'edit', id)}
    </div>
    ${item.qa?.description ? `<div class="prose">${e(item.qa.description)}</div>` : ''}
    ${preconditionSteps(item)}
    <div class="panel-bottom">
      <a class="text-button" href="${autoUrl(null, { prerequisiteId: item.id })}">Configure in Automation Studio ${icon('arrow')}</a>
      ${button('delete-precondition', 'Delete', 'trash', id, 'danger')}
    </div>
  </section>`;
}

function preconditionsView() {
  const items = project().prerequisites;
  const newButton = button('new-precondition', 'New precondition', 'plus', '', 'primary');
  const pageHeading = heading('Preconditions', 'Create reusable setup instructions and share them across test cases.', newButton);
  if (!items.length) {
    return pageHeading + empty('No preconditions yet', 'Add shared setup such as signing in or preparing test data.');
  }
  return `${pageHeading}<div class="stack">${items.map(preconditionPanel).join('')}</div>`;
}

function editPrecondition(id, caseId) {
  const snapshot = structuredClone(project());
  const old = snapshot.prerequisites.find((item) => item.id === id);

  async function save(values) {
    const instructions = stepEditorValues();
    if (!instructions.length) throw new Error('Add at least one setup step.');
    const name = values.name.trim();
    const isDuplicate = snapshot.prerequisites.some((item) => item.id !== id && item.name.toLowerCase() === name.toLowerCase());
    if (isDuplicate) throw new Error('A precondition with that name already exists.');
    const item = {
      ...(old || { id: crypto.randomUUID(), steps: [], automation: null }),
      name,
      qa: { ...old?.qa, description: values.description, manualSteps: instructions },
    };
    if (old) snapshot.prerequisites[snapshot.prerequisites.findIndex((pre) => pre.id === id)] = item;
    else snapshot.prerequisites.push(item);
    const linkedCase = caseId && snapshot.tests.find((test) => test.id === caseId);
    if (linkedCase) linkedCase.prerequisiteId = item.id;
    await saveProject(snapshot);
    render();
    notify(old ? 'Precondition updated' : 'Precondition created');
  }

  const body = `${input('name', 'Precondition name', old?.name || '', 'required maxlength="120"')}
    ${area('description', 'Description', old?.qa?.description || '')}
    <p class="field-hint">Write the setup once and link it to multiple cases. For automated execution, configure its browser actions in Automation Studio.</p>
    ${stepEditorSection('Setup steps', old ? manualSteps(old) : [{}])}`;
  modal(old ? 'Edit precondition' : 'New precondition', body, save, old ? 'Save changes' : 'Create precondition', true);
}

function confirmDeletePrecondition(id) {
  const snapshot = structuredClone(project());
  const item = snapshot.prerequisites.find((pre) => pre.id === id);
  const count = snapshot.tests.filter((test) => test.prerequisiteId === id).length;
  modal(
    'Delete precondition?',
    `<p class="field-hint">Delete ${e(item.name)}? It will be unlinked from ${count} test cases. Existing run results will be kept.</p>`,
    async () => {
      snapshot.prerequisites = snapshot.prerequisites.filter((pre) => pre.id !== id);
      for (const test of snapshot.tests) {
        if (test.prerequisiteId === id) test.prerequisiteId = null;
      }
      await saveProject(snapshot);
      render();
      notify('Precondition deleted');
    },
    'Delete precondition',
  );
}

/* ---- Suites ------------------------------------------------------------- */

function suiteCard(suite) {
  const tests = project().tests.filter((test) => inSuite(test, suite.id));
  const planned = tests.filter((test) => test.inTestPlan === true).length;
  const id = `data-id="${e(suite.id)}"`;
  return `<section class="panel suite-card">
    ${icon('suites')}
    <h2>${e(suite.name)}</h2>
    <p>${tests.length} test cases · ${planned} in Test plan</p>
    <div class="heading-actions">
      ${button('view-suite', 'View cases', 'cases', id)}
      ${button('run-suite', 'Run suite', 'runs', `${id} ${planned ? '' : 'disabled'}`, 'primary')}
    </div>
  </section>`;
}

function suitesView() {
  const suites = project().suites;
  const createButton = button('new-suite', 'Create suite', 'plus', '', 'primary');
  const actions = button('new-folder', 'New folder', 'suites') + createButton;
  return `${heading('Test suites', 'Group your cases into focused, repeatable test runs.', actions)}
    <div class="suite-grid">${suites.map(suiteCard).join('')}</div>
    ${suites.length ? '' : empty('A place for related test cases', 'Create your first smoke, regression, or release suite.', createButton)}`;
}

function newSuite() {
  const snapshot = structuredClone(project());
  modal(
    'Create a test suite',
    `${input('name', 'Suite name', '', 'required maxlength="120"')}<p class="field-hint">Assign cases to this suite from the test case editor.</p>`,
    async (values) => {
      snapshot.suites.push({ id: crypto.randomUUID(), name: values.name.trim() });
      await saveProject(snapshot);
      render();
      notify('Test suite created');
    },
    'Create',
  );
}

function newFolder(parentId = folderContext()) {
  if (!state.features?.nestedFolders) throw new Error(FOLDER_FEATURE_MISSING);
  const snapshot = structuredClone(project());
  const parentSelect = `<label>Parent folder<select name="parentId" aria-label="Parent folder">${options(StudioFolders.choices(snapshot.folders), parentId, 'Workspace root')}</select></label>`;
  modal(
    'Create a folder',
    input('name', 'Folder name', '', 'required maxlength="120"') + parentSelect,
    async (values) => {
      const item = { id: crypto.randomUUID(), name: values.name.trim(), parentId: values.parentId || null };
      snapshot.folders.push(item);
      await saveProject(snapshot);
      filters.folder = item.id;
      selected.clear();
      let parent = item.parentId;
      while (parent) {
        collapsedFolders.delete(parent);
        parent = snapshot.folders.find((folder) => folder.id === parent)?.parentId;
      }
      go('cases');
      notify('Folder created');
    },
    'Create',
  );
}

/* ---- Projects, help and issues ------------------------------------------ */

function newProject() {
  const body = `${input('name', 'Project name', '', 'required maxlength="120" placeholder="e.g. Customer portal"')}
    ${input('baseUrl', 'Application URL (optional)', '', 'type="url" placeholder="https://your-app.example"')}
    <p class="field-hint">Your project keeps its cases, suites, environments, and automation together.</p>`;
  modal(
    'Create a project',
    body,
    async (values) => {
      const baseUrl = values.baseUrl.trim();
      if (baseUrl && !/^https?:\/\//i.test(baseUrl)) throw new Error('Use an HTTP or HTTPS application URL.');
      const added = await api('/api/projects', 'POST', {
        name: values.name,
        tests: [],
        folders: [],
        suites: [],
        environments: baseUrl ? [{ id: 'test', name: 'Test environment', variables: { BASE_URL: baseUrl } }] : [],
        activeEnvironmentId: baseUrl ? 'test' : null,
      });
      state.projects.push(added);
      setProject(added.id);
      go('dashboard');
      notify('Project created');
    },
    'Create project',
  );
}

function showHelp() {
  const guide = [
    ['Write your test case', 'Add instructions, expected results, preconditions, and priority. Organize cases into folders and suites.'],
    [
      'Choose how to execute',
      'Select cases on Test cases and transfer them to the Test plan first. Choose Manual to record pass, fail, blocked, or skipped outcomes. Choose Automation Studio to configure and execute browser actions.',
    ],
    ['Follow the results', 'Progress updates in Overview and Test runs. Download HTML or PDF reports from Reports.'],
  ];
  const steps = guide
    .map(([title, text], index) => `<div class="detail-step"><span class="step-number">${index + 1}</span><div><strong>${title}</strong><p>${text}</p></div></div>`)
    .join('');
  modal(
    'From test case to confidence',
    `<div class="detail-steps">${steps}</div>
     <p class="field-hint">Start with the included welcome form example. For advanced browser recording, AI, test data, and integrations, open Automation Studio.</p>`,
    () => {},
    'Got it',
  );
}


function reportIssue(id) {
  const test = project().tests.find((item) => item.id === id);
  const tracker = state.bugTracker;
  if (!test || !tracker?.connected) {
    notify('Connect Jira successfully in Settings first.', true);
    return;
  }
  void StudioIssueReport.open({ projectId: project().id, testId: id });
}

window.addEventListener('studio:issue-reported', () => {
  refresh()
    .then(render)
    .catch(() => {});
});

/* ---- Test plan page wiring ---------------------------------------------- */

function planConfig() {
  return {
    project,
    runs,
    modal,
    notify,
    save: saveProject,
    select: `<a class="button primary" href="#cases">${icon('plus')}Add Test Run</a>`,
    saved() {
      selected.clear();
      go('plan');
      notify('Test plan saved.');
    },
    async run(plan) {
      if (project()._recoveredTestPlans) await saveProject(project());
      startRun({ testIds: plan.testIds, planId: plan.id });
    },
    results(run) {
      location.hash = `run/${run.id}`;
    },
  };
}

function planView() {
  return StudioTestPlan.render(planConfig());
}

/* ---- Test runs and reports ---------------------------------------------- */

function runName(run) {
  return run.name || `${run.mode === 'manual' ? 'Manual' : 'Automated'} test run`;
}

function reportLinks(run) {
  const id = e(run.id);
  return `<a class="button" href="/api/runs/${id}/report" target="_blank" rel="noopener">HTML</a>
    <a class="button" href="/api/runs/${id}/report.pdf" target="_blank" rel="noopener">PDF</a>
    <a class="button" href="/api/runs/${id}/report/interactive" target="_blank" rel="noopener">Interactive</a>
    <a class="button" href="/api/runs/${id}/report.json" download>JSON</a>`;
}

function runRow(run, isReports) {
  const done = run.tests.filter((test) => TERMINAL_STATUSES.includes(test.status)).length;
  const started = new Date(run.startedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const details = isReports
    ? reportLinks(run)
    : `<a class="text-button" href="#run/${e(run.id)}">${run.status === 'running' ? 'Continue' : 'View results'} ${icon('arrow')}</a>`;
  return `<tr>
    <td>
      <a class="case-link" href="#run/${e(run.id)}">${e(runName(run))}<span class="case-sub">${run.tests.length} test cases · ${e(run.id.slice(0, 8))}</span></a>
    </td>
    <td>${badge(run.mode || 'automation')}</td>
    <td>${badge(run.status)}</td>
    <td><span class="small-text">${done} / ${run.tests.length} cases</span>${progress(percent(done, run.tests.length))}</td>
    <td>${shortDate(run.startedAt)}<span class="case-sub">${started}</span></td>
    <td class="run-details">${details}</td>
  </tr>`;
}

function runTable(list, isReports) {
  if (!list.length) {
    return empty(
      isReports ? 'Reports start with a test run' : 'Ready for your first run?',
      'Execute a case manually or with automation. Results will appear here.',
      button('new-run', 'Start a test run', 'runs', '', 'primary'),
    );
  }
  return `<div class="table-scroll">
    <table class="run-table">
      <thead>
        <tr><th>TEST RUN</th><th>MODE</th><th>RESULT</th><th>PROGRESS</th><th>STARTED</th><th>${isReports ? 'DOWNLOAD' : 'DETAILS'}</th></tr>
      </thead>
      <tbody>${list.map((run) => runRow(run, isReports)).join('')}</tbody>
    </table>
  </div>`;
}

function runsView(isReports = false) {
  const pageHeading = isReports
    ? heading('Reports & insights', 'An execution history you can review and share.', button('export-runs', 'Export summary', 'download'))
    : heading('Test runs', 'Manual and automated execution, together in one place.', button('new-run', 'New test run', 'plus', '', 'primary'));
  return `${pageHeading}
    ${isReports ? stats() : ''}
    <section class="panel">
      <div class="panel-head">
        <h2>${isReports ? 'Execution reports' : 'Execution history'}</h2>
        <span class="tag">${runs().length} runs loaded</span>
      </div>
      ${runTable(runs(), isReports)}
      <div class="recent-footer">
        <span>Results are saved as snapshots of your test cases.</span>
        ${button('load-history', 'Load older runs', 'clock')}
      </div>
    </section>`;
}

function exportRuns() {
  const headers = ['Run ID', 'Name', 'Mode', 'Status', 'Cases', 'Passed', 'Failed', 'Started', 'Duration (ms)'];
  const count = (run, status) => run.tests.filter((test) => test.status === status).length;
  const rows = runs().map((run) => [
    run.id,
    run.name || 'Automated test run',
    run.mode || 'automation',
    run.status,
    run.tests.length,
    count(run, 'passed'),
    count(run, 'failed'),
    run.startedAt,
    run.duration,
  ]);
  downloadCsv('qa-studio-run-summary.csv', headers, rows);
}

async function loadHistory() {
  const query = new URLSearchParams({ projectId: project().id, offset: runs().length, limit: HISTORY_PAGE_SIZE });
  const result = await api(`/api/runs?${query}`);
  const loaded = new Set(state.runs.map((run) => run.id));
  state.runs = [...state.runs, ...result.runs.filter((run) => !loaded.has(run.id))];
  render();
  notify(`${runs().length} of ${result.total} runs loaded`);
}

/* ---- Run screen --------------------------------------------------------- */

const noteKey = (runId, testId, index) => `${runId}:${testId}:${index}`;

function targetScreenshots(step) {
  const files = step.targetScreenshots || [];
  const details = files.map((file, index) => {
    const suffix = files.length > 1 ? ` ${index + 1}` : '';
    return `<details class="run-result-detail">
      <summary>${icon('target')}Locator screenshot${suffix}</summary>
      <img class="result-image" src="/artifacts/${encodeURIComponent(file)}" alt="Exact locator location for ${e(step.name)}" loading="lazy">
    </details>`;
  });
  const warning = step.screenshotWarning ? `<p class="error">${e(step.screenshotWarning)}</p>` : '';
  return details.join('') + warning;
}

function stepResultControls(run, test, step, index) {
  const note = notes.get(noteKey(run.id, test.id, index)) ?? step.actualResult ?? '';
  const buttons = STEP_OUTCOMES.map(
    (outcome) =>
      `<button type="button" class="button ${step.status === outcome.status ? 'selected' : ''}" data-action="step-result" data-index="${index}" data-status="${outcome.status}">${icon(outcome.glyph)}${outcome.label}</button>`,
  );
  return `<label>Actual result / notes
      <textarea data-note="${index}" aria-label="Actual result for step ${index + 1}" maxlength="10000"
        placeholder="What happened? Add observations or a defect reference…">${e(note)}</textarea>
    </label>
    <div class="result-buttons">${buttons.join('')}</div>`;
}

function runStep(run, test, step, index, canRecord) {
  const actual = step.actualResult ? `<p><b>Actual result:</b> ${e(step.actualResult)}</p>` : '';
  const screenshot = step.screenshot
    ? `<details class="run-result-detail">
        <summary>${icon('reports')}Screenshot</summary>
        <img class="result-image" src="/artifacts/${encodeURIComponent(step.screenshot)}" alt="Screenshot for step ${index + 1}" loading="lazy">
      </details>`
    : '';
  return `<div class="manual-step">
    <div class="manual-step-header">
      <span class="step-number">${index + 1}</span>
      <div><h3>${e(step.name)}</h3></div>
      ${badge(step.status)}
    </div>
    ${step.expectedResult ? `<p><b>Expected result:</b> ${e(step.expectedResult)}</p>` : ''}
    ${canRecord ? stepResultControls(run, test, step, index) : actual}
    ${step.error ? `<p class="error">${e(step.error)}</p>` : ''}
    ${targetScreenshots(step)}
    ${screenshot}
  </div>`;
}

function runActions(run) {
  const id = `data-id="${e(run.id)}"`;
  if (run.status !== 'running') {
    return `<a class="button" href="/api/runs/${e(run.id)}/report" target="_blank" rel="noopener">${icon('reports')}HTML report</a>
      <a class="button" href="/api/runs/${e(run.id)}/report.pdf" target="_blank" rel="noopener">${icon('download')}PDF report</a>
      <a class="button" href="/api/runs/${e(run.id)}/report/interactive" target="_blank" rel="noopener">${icon('reports')}Interactive report</a>
      <a class="button" href="/api/runs/${e(run.id)}/report.json" download>${icon('download')}Playwright JSON</a>`;
  }
  if (run.mode !== 'manual') return button('cancel-auto', 'Cancel run', 'close', id);
  const canComplete = run.tests.every((test) => test.steps.every((step) => TERMINAL_STATUSES.includes(step.status)));
  return (
    button('cancel-manual', 'End run', 'close', id) +
    button('complete-manual', 'Complete run', 'check', `${id} ${canComplete ? '' : 'disabled'}`, 'primary')
  );
}

function runCaseButton(test, activeId) {
  return `<button type="button" class="run-case ${test.id === activeId ? 'active' : ''}" data-action="select-run-case" data-id="${e(test.id)}">
    <i class="dot ${e(test.status)}"></i>
    <span><strong>${e(test.name)}</strong><small>${tc(test)} · ${STATUS_LABELS[test.status] || test.status}</small></span>
  </button>`;
}

function runView(id) {
  const run = state.runs.find((item) => item.id === id);
  if (!run) {
    return empty(
      'Run not found',
      'This run may have been removed. Load older runs to browse your history.',
      '<a class="button" href="#runs">View test runs</a>',
    );
  }
  if (!run.tests.some((test) => test.id === runTestId)) runTestId = run.tests[0]?.id;
  const test = run.tests.find((item) => item.id === runTestId);
  const allSteps = run.tests.flatMap((item) => item.steps);
  const done = allSteps.filter((step) => TERMINAL_STATUSES.includes(step.status)).length;
  const isManual = run.mode === 'manual';
  const canRecord = isManual && run.status === 'running';
  const subtitle = `${run.projectName} · ${allSteps.length} steps · Started ${new Date(run.startedAt).toLocaleString()}`;
  return `<a class="back-link" href="#runs">${icon('back')}Back to test runs</a>
    ${heading(runName(run), subtitle, badge(run.status) + runActions(run))}
    <div class="execution-layout">
      <aside class="panel">
        <div class="panel-head"><h2>Cases in this run</h2><span class="tag">${run.tests.length}</span></div>
        <div class="run-case-list">${run.tests.map((item) => runCaseButton(item, test?.id)).join('')}</div>
      </aside>
      <section class="panel">
        <div class="panel-head">
          <div>
            <h2>${e(test?.name || 'Run results')}</h2>
            <p>${isManual ? 'Record each outcome as you work through the steps.' : 'Results update as the browser executes each step.'}</p>
          </div>
          ${badge(test?.status || 'pending')}
        </div>
        <div class="run-progress">
          <div class="split-legend"><span>Overall progress</span><span>${done} of ${allSteps.length} steps</span></div>
          ${progress(percent(done, allSteps.length))}
        </div>
        ${test?.qa?.preconditions ? `<div class="prose"><b>Preconditions</b><br>${e(test.qa.preconditions)}</div>` : ''}
        ${(test?.steps || []).map((step, index) => runStep(run, test, step, index, canRecord)).join('')}
        ${run.error ? `<div class="prose error">${e(run.error)}</div>` : ''}
      </section>
    </div>`;
}

function replaceRun(updated) {
  state.runs = state.runs.map((run) => (run.id === updated.id ? updated : run));
}

function refreshManualControls() {
  const current = route();
  const run = state?.runs.find((item) => item.id === current.id);
  if (current.view !== 'run' || run?.mode !== 'manual') return;
  document.querySelectorAll('[data-action="step-result"],[data-action="cancel-manual"]').forEach((control) => {
    control.disabled = savingManualResult;
  });
  const complete = $('[data-action="complete-manual"]');
  if (complete) {
    const hasOpenSteps = run.tests.some((test) => test.steps.some((step) => !TERMINAL_STATUSES.includes(step.status)));
    complete.disabled = savingManualResult || hasOpenSteps;
  }
}

// While a note has focus the full render waits, so the saved outcome is shown in place.
function showStepOutcome(index, status) {
  const stepNode = $(`[data-note="${index}"]`)?.closest('.manual-step');
  if (!stepNode) return;
  stepNode.querySelectorAll('[data-action="step-result"]').forEach((control) => {
    control.classList.toggle('selected', control.dataset.status === status);
  });
  stepNode.querySelector('.manual-step-header .badge').outerHTML = badge(status);
}

async function updateResult(index, status) {
  if (savingManualResult) return;
  const run = state.runs.find((item) => item.id === route().id);
  const test = run.tests.find((item) => item.id === runTestId);
  const key = noteKey(run.id, test.id, index);
  const actualResult = notes.get(key) ?? test.steps[index].actualResult ?? '';
  savingManualResult = true;
  refreshManualControls();
  try {
    const updated = await api(`/api/manual-runs/${run.id}/steps`, 'PUT', {
      revision: run.revision,
      testId: test.id,
      stepIndex: index,
      status,
      actualResult,
    });
    replaceRun(updated);
    showStepOutcome(index, status);
    // Text edited while this save was in flight stays a draft until it is saved too.
    if (notes.get(key) === actualResult) notes.delete(key);
    notify(`Step ${index + 1}: ${STATUS_LABELS[status]}`);
  } catch (error) {
    if (error.code === 'EDIT_CONFLICT') await refresh();
    throw error;
  } finally {
    savingManualResult = false;
    if (document.activeElement?.matches('[data-note]')) pendingPollRender = true;
    else render();
    refreshManualControls();
  }
}

// Notes typed after choosing an outcome would otherwise vanish when the run closes.
async function saveUnsavedNotes(run) {
  let current = run;
  for (const test of run.tests) {
    for (const [index, step] of test.steps.entries()) {
      const note = notes.get(noteKey(run.id, test.id, index));
      if (note === undefined || note === (step.actualResult ?? '')) continue;
      current = await api(`/api/manual-runs/${run.id}/steps`, 'PUT', {
        revision: current.revision,
        testId: test.id,
        stepIndex: index,
        status: TERMINAL_STATUSES.includes(step.status) ? step.status : 'skipped',
        actualResult: note,
      });
    }
  }
  return current;
}

async function closeManualRun(id, operation) {
  const current = await saveUnsavedNotes(state.runs.find((run) => run.id === id));
  const updated = await api(`/api/manual-runs/${id}/${operation}`, 'POST', { revision: current.revision });
  replaceRun(updated);
  for (const key of notes.keys()) {
    if (key.startsWith(`${id}:`)) notes.delete(key);
  }
  render();
  notify(operation === 'complete' ? 'Run completed. Your results are saved.' : 'Run ended. Remaining steps were skipped.');
}

function confirmEndRun(id) {
  modal(
    'End this run?',
    '<p class="field-hint">Your recorded results will be kept. Unfinished steps will be marked skipped and the run will be marked interrupted.</p>',
    () => closeManualRun(id, 'cancel'),
    'End run',
  );
}

/* ---- Starting a run ----------------------------------------------------- */

function defaultRunName(tests, { testId, suiteId, planId }) {
  const current = project();
  const planName = current.testPlans?.find((plan) => plan.id === planId)?.name;
  if (planName) return planName;
  if (testId) return tests[0].name;
  if (suiteId) return `${current.suites.find((suite) => suite.id === suiteId).name} run`;
  return `Test run · ${new Date().toLocaleDateString()}`;
}

function modeOption(value, glyph, title, description, isChecked) {
  return `<label class="mode-option">
    <input type="radio" name="mode" value="${value}" ${isChecked ? 'checked' : ''}>
    <span><strong>${icon(glyph)} ${title}</strong><small>${description}</small></span>
  </label>`;
}

function startRunBody(tests, name) {
  const initialMode = tests.length === 1 ? mode(tests[0]) : 'manual';
  const choices = tests
    .map(
      (test) =>
        `<label class="case-choice"><input type="checkbox" name="testIds" value="${e(test.id)}" checked><span>${tc(test)} · ${e(test.name)}</span>${badge(test.steps.length ? 'automation' : 'manual')}</label>`,
    )
    .join('');
  return `${input('name', 'Execution name', name, 'required maxlength="120"')}
    <p class="field-label" id="run-mode-label">How would you like to execute?</p>
    <div class="mode-options" role="radiogroup" aria-labelledby="run-mode-label">
      ${modeOption('manual', 'user', 'Manual testing', 'Work through each step and record expected and actual outcomes.', initialMode === 'manual')}
      ${modeOption('automation', 'bolt', 'Automation Studio', 'Open the browser automation workspace and execute configured steps.', initialMode === 'automation')}
    </div>
    <div class="choice-list">${choices}</div>
    <p class="field-hint">Automated execution opens Automation Studio. Cases without automation steps open for configuration first.</p>`;
}

function startRun({ testId, suiteId, testIds, planId } = {}) {
  const current = project();
  const isExplicit = (test) => test.id === testId || testIds?.includes(test.id);
  if ((testId || testIds) && current.tests.some((test) => isExplicit(test) && test.inTestPlan !== true)) {
    notify('Transfer every selected case to the Test plan before execution.', true);
    return;
  }
  const tests = current.tests.filter(
    (test) =>
      test.inTestPlan === true &&
      (!testId || test.id === testId) &&
      (!suiteId || inSuite(test, suiteId)) &&
      (!testIds || testIds.includes(test.id)),
  );
  if (!tests.length) {
    notify('No planned cases in this selection. Transfer cases from Test cases to the Test plan first.', true);
    return;
  }

  async function start(values, form) {
    const ids = new FormData(form).getAll('testIds');
    if (!ids.length) throw new Error('Select at least one test case.');
    if (values.mode === 'automation') {
      $('#dialog').close();
      location.href = autoUrl(ids.length === 1 ? ids[0] : null, {
        intent: 'execute',
        ...(ids.length > 1 ? { testIds: ids.join(',') } : {}),
        runName: values.name,
        ...(planId ? { planId } : {}),
      });
      return;
    }
    const run = await api('/api/manual-runs', 'POST', {
      projectId: current.id,
      testIds: ids,
      ...(suiteId ? { suiteId } : {}),
      ...(planId ? { planId } : {}),
      name: values.name,
    });
    state.runs = [run, ...state.runs];
    runTestId = run.tests[0].id;
    go(`run/${run.id}`);
    notify('Manual run started. Record a result for each step.');
  }

  modal('Start a test run', startRunBody(tests, defaultRunName(tests, { testId, suiteId, planId })), start, 'Start execution');
}

/* ---- Rendering and navigation ------------------------------------------- */

function renderNoProjects() {
  const canCreate = globalThis.StudioAuth?.allowed('createProjects');
  $('#sidebar').innerHTML = '<div class="studio-brand"><strong>QA Studio</strong></div><div class="sidebar-bottom"></div>';
  $('#topbar').innerHTML = '';
  $('#breadcrumbs').innerHTML = '';
  $('#footer').innerHTML = '<span id="connection">Connected to local workspace</span>';
  $('#main').innerHTML = heading(
    'No project access assigned',
    'Ask your administrator to assign a project in Administration > Project management.',
    canCreate ? button('new-project', 'New project', 'plus') : '',
  );
  globalThis.StudioAuth?.apply();
}

function mainView() {
  const { view, id } = route();
  switch (view) {
    case 'requirements':
      return requirementsView();
    case 'requirement':
      return requirementView(id);
    case 'requirement-edit':
      return requirementForm(id);
    case 'requirement-draft':
      return requirementDraftView(id);
    case 'plan':
      return planView();
    case 'cases':
      return casesView();
    case 'case':
      return caseView(id);
    case 'runs':
      return runsView();
    case 'reports':
      return runsView(true);
    case 'suites':
      return suitesView();
    case 'preconditions':
      return preconditionsView();
    case 'run':
      return runView(id);
    default:
      return dashboardView();
  }
}

function render() {
  if (!state) return;
  document.body.classList.remove('navigation-open');
  if (!state.projects.length) {
    renderNoProjects();
    return;
  }
  shell();
  $('#main').innerHTML = mainView();
  syncSelectAll();
  refreshManualControls();
}

async function loadCaseHistory(caseId) {
  try {
    const query = new URLSearchParams({ projectId: project().id, testId: caseId, limit: '1' });
    const history = await api(`/api/runs?${query}`);
    const incoming = new Map(history.runs.map((run) => [run.id, run]));
    const loaded = new Set(state.runs.map((run) => run.id));
    state.runs = [
      ...state.runs.map((run) => incoming.get(run.id) || run),
      ...history.runs.filter((run) => !loaded.has(run.id)),
    ];
  } catch (error) {
    notify(error.message, true);
  }
}

async function loadRun(id) {
  try {
    const run = await api(`/api/runs/${encodeURIComponent(id)}`);
    state.runs = [...state.runs, run];
    if (run.projectId !== project().id) setProject(run.projectId);
  } catch (error) {
    notify(error.message, true);
  }
}

async function navigate() {
  // An earlier hash change may still be queued, so keep the marker until the hash moves on.
  if (!state || renderedHash === location.hash) return;
  renderedHash = null;
  if (!state.projects.length) {
    render();
    return;
  }
  const finish = StudioUI.begin('Opening your view');
  try {
    const { view, id } = route();
    if (view === 'case' && id) await loadCaseHistory(id);
    if (view === 'run' && !state.runs.some((run) => run.id === id)) await loadRun(id);
    render();
    StudioUI.enter($('#main'));
  } finally {
    finish();
  }
}

/* ---- Polling ------------------------------------------------------------ */

function isUserEditing() {
  return requirementEditing() || $('#dialog').open || FIELD_TAGS.includes(document.activeElement?.tagName);
}

// A slower poll may arrive after a save response, so it must never roll a revision back.
function mergePolledState(data) {
  const incoming = historyTools.recoverPlanState(data);
  const currentProjects = new Map(state.projects.map((item) => [item.id, item]));
  const currentRuns = new Map(state.runs.map((run) => [run.id, run]));
  incoming.projects = incoming.projects.map((item) => {
    const current = currentProjects.get(item.id);
    return current?.revision > item.revision ? current : item;
  });
  incoming.runs = incoming.runs.map((run) => {
    const current = currentRuns.get(run.id);
    return run.mode === 'manual' && current?.revision > run.revision ? current : run;
  });
  const projectIds = new Set(incoming.projects.map((item) => item.id));
  const runIds = new Set(incoming.runs.map((run) => run.id));
  const olderRuns = state.runs.filter((run) => projectIds.has(run.projectId) && !runIds.has(run.id));
  return { ...incoming, runs: [...incoming.runs, ...olderRuns] };
}

function handleAccessChange() {
  $('#dialog').close();
  $('#dialog-body').innerHTML = '';
  notes.clear();
  setProject(state.projects[0]?.id || '');
  history.replaceState(null, '', `${location.pathname}#dashboard`);
  render();
}

function applyPolledState(data) {
  const next = mergePolledState(data);
  const signature = JSON.stringify(next);
  const hasProject = next.projects.some((item) => item.id === projectId);
  const accessChanged = (projectId && !hasProject) || (!projectId && next.projects.length > 0);
  state = next;
  updateRequirementAgentProgress();
  if (accessChanged) handleAccessChange();
  if (signature === lastSignature) return;
  pendingPollRender = true;
  flushPendingRender(signature);
}

function flushPendingRender(signature) {
  if (!pendingPollRender || isUserEditing()) return;
  lastSignature = signature ?? JSON.stringify(state);
  pendingPollRender = false;
  render();
}

async function poll() {
  clearTimeout(pollTimer);
  try {
    if (document.hidden) return;
    let data;
    try {
      data = await StudioUI.pollState();
      updateConnection(true);
    } catch {
      updateConnection(false);
      return;
    }
    if (data) applyPolledState(data);
    else flushPendingRender();
  } finally {
    pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
  }
}

/* ---- Event handlers ----------------------------------------------------- */

function resetCaseFilters(status = '') {
  filters = { ...emptyFilters(), status };
  casePage = 0;
  selected.clear();
}

function selectFolder(control) {
  casePage = 0;
  if (control.dataset.scope === 'all') filters.folder = null;
  else if (control.dataset.scope === 'unfiled') filters.folder = '';
  else filters.folder = control.dataset.id;
  selected.clear();
  render();
}

function toggleFolder(id) {
  if (collapsedFolders.has(id)) collapsedFolders.delete(id);
  else collapsedFolders.add(id);
  $('#folder-browser').innerHTML = qaFolderTree();
  $(`#folder-browser [data-action="toggle-folder"][data-id="${CSS.escape(id)}"]`).focus();
}

function viewCaseRun(control) {
  const run = state.runs.find((item) => item.id === control.dataset.id);
  runTestId = run?.tests.find((test) => (test.qaCaseId || test.sourceTestId || test.id) === control.dataset.testId)?.id;
}

function viewSuite(id) {
  filters.suite = id;
  casePage = 0;
  go('cases');
}

const ACTION_HANDLERS = {
  'clear-filters'() {
    resetCaseFilters();
    render();
    $('#case-search')?.focus();
  },
  'filter-result'(control) {
    resetCaseFilters(control.dataset.status);
    go('cases');
  },
  async 'retry-connection'(control) {
    control.disabled = true;
    await poll();
  },
  'retry-load'(_control, _id, event) {
    event.preventDefault();
    location.reload();
  },
  'close-dialog'() {
    $('#dialog').close();
  },
  'new-requirement'() {
    go('requirement-edit');
  },
  'open-requirement'(_control, id) {
    go(`requirement/${id}`);
  },
  'report-issue'(_control, id) {
    reportIssue(id);
  },
  'new-precondition'(control) {
    editPrecondition(null, control.dataset.caseId);
  },
  'edit-precondition'(_control, id) {
    editPrecondition(id);
  },
  'view-case-run': viewCaseRun,
  'delete-precondition'(_control, id) {
    confirmDeletePrecondition(id);
  },
  'select-folder': selectFolder,
  'toggle-folder'(_control, id) {
    toggleFolder(id);
  },
  'open-folder-case'(_control, id) {
    filters.folder = project().tests.find((test) => test.id === id)?.folderId || '';
  },
  'new-case'(control) {
    editCase(undefined, control.dataset.folder);
  },
  'edit-case'(_control, id) {
    editCase(id);
  },
  'copy-case'(_control, id) {
    return copyCase(id);
  },
  'delete-case'(_control, id) {
    confirmDeleteCase(id);
  },
  'new-project'() {
    newProject();
  },
  'new-suite'() {
    newSuite();
  },
  'new-folder'(control) {
    newFolder(control.dataset.folder);
  },
  'add-to-plan'() {
    StudioTestPlan.create(planConfig(), [...selected]);
  },
  'new-run'() {
    startRun();
  },
  'run-case'(_control, id) {
    startRun({ testId: id });
  },
  'run-suite'(_control, id) {
    startRun({ suiteId: id });
  },
  'run-selected'() {
    startRun({ testIds: [...selected] });
  },
  'view-suite'(_control, id) {
    viewSuite(id);
  },
  'case-page'(control) {
    casePage = Math.max(0, casePage + Number(control.dataset.dir || 0));
    renderCaseResults();
  },
  'clear-selected'() {
    selected.clear();
    renderCaseResults();
  },
  'add-step'() {
    addEditorStep();
  },
  'remove-step'(control) {
    control.closest('.editor-step').remove();
    syncStepEditor('Step removed.');
  },
  'export-cases'() {
    exportCases();
  },
  'export-runs'() {
    exportRuns();
  },
  'select-run-case'(_control, id) {
    runTestId = id;
    render();
  },
  'step-result'(control) {
    control.disabled = true;
    return updateResult(Number(control.dataset.index), control.dataset.status);
  },
  'complete-manual'(control, id) {
    control.disabled = true;
    return closeManualRun(id, 'complete');
  },
  'cancel-manual'(_control, id) {
    confirmEndRun(id);
  },
  async 'cancel-auto'(_control, id) {
    await api(`/api/runs/${id}/cancel`, 'POST', {});
    notify('Stopping browser execution…');
  },
  'load-history'(control) {
    control.disabled = true;
    return loadHistory();
  },
  help() {
    showHelp();
  },
};

async function handleActionClick(event) {
  const control = event.target.closest('[data-action]');
  if (!control || control.disabled) return;
  const handler = ACTION_HANDLERS[control.dataset.action];
  if (!handler) return;
  try {
    await handler(control, control.dataset.id, event);
  } catch (error) {
    notify(error.message, true);
  } finally {
    if (document.contains(control)) control.disabled = false;
    refreshManualControls();
  }
}

function handleInput(event) {
  const element = event.target;
  if (element.id === 'case-search') {
    filters.search = element.value;
    casePage = 0;
    renderCaseResults();
  }
  if (element.dataset.note !== undefined) {
    notes.set(noteKey(route().id, runTestId, Number(element.dataset.note)), element.value);
  }
}

function handleChange(event) {
  const element = event.target;
  if (element.id === 'project-select') {
    setProject(element.value);
    go('dashboard');
  } else if (element.dataset.filter) {
    filters[element.dataset.filter] = element.value;
    casePage = 0;
    renderCaseResults();
  } else if (element.dataset.select) {
    if (element.checked) selected.add(element.dataset.select);
    else selected.delete(element.dataset.select);
    renderCaseResults();
  } else if (element.id === 'select-all') {
    for (const test of filtered()) {
      if (element.checked) selected.add(test.id);
      else selected.delete(test.id);
    }
    renderCaseResults();
  } else if (element.id === 'step-select-all') {
    document.querySelectorAll('[data-step-select]').forEach((box) => {
      box.checked = element.checked;
    });
    syncStepEditor();
  } else if (element.matches('[data-step-select]')) {
    syncStepEditor();
  }
}

function handleKeydown(event) {
  if (event.key === 'Escape' && document.body.classList.contains('navigation-open')) {
    closeNavigation(true);
    return;
  }
  const isTyping = FIELD_TAGS.includes(document.activeElement?.tagName);
  if (event.key !== '/' || isTyping || $('#dialog').open) return;
  event.preventDefault();
  if (route().view !== 'cases') go('cases');
  $('#case-search')?.focus();
}

function handleGlobalSearch(event) {
  if (event.target.id !== 'global-search') return;
  event.preventDefault();
  filters.search = new FormData(event.target).get('search');
  casePage = 0;
  go('cases');
}

function handleShellClick(event) {
  const stepControl = event.target.closest('[data-step-action],#copy-selected-steps');
  if (stepControl) {
    handleStepAction(stepControl);
    return;
  }
  if (event.target.closest('#navigation-toggle')) toggleNavigation();
  else if (event.target.closest('#sidebar a')) closeNavigation();
}

function warnAboutUnsavedWork(event) {
  const dialogHasInput = $('#dialog').open && $('#dialog-body').querySelector('[name="name"]');
  const draftIsDirty = [...requirementDrafts.values()].some((draft) => draft.dirty);
  if (dialogHasInput || notes.size || draftIsDirty) {
    event.preventDefault();
    event.returnValue = '';
  }
}

function bindEvents() {
  document.addEventListener('click', handleActionClick);
  document.addEventListener('click', handleShellClick);
  document.addEventListener('input', handleInput);
  document.addEventListener('change', handleChange);
  document.addEventListener('submit', handleGlobalSearch);
  document.addEventListener('keydown', handleKeydown);
  document.addEventListener('dragstart', handleStepDragStart);
  document.addEventListener('dragover', handleStepDragOver);
  document.addEventListener('drop', handleStepDrop);
  document.addEventListener('dragend', clearStepDrag);
  $('#dialog').addEventListener('close', clearStepDrag);
  $('#dialog-form').addEventListener('submit', handleDialogSubmit);
  window.addEventListener('hashchange', navigate);
  window.addEventListener('beforeunload', warnAboutUnsavedWork);
}

/* ---- Startup ------------------------------------------------------------ */

function showLoadError(error) {
  const retry = `<a class="button primary" href="${e(location.href)}" data-action="retry-load">Try again</a>`;
  $('#main').innerHTML = `${heading('Could not open QA Studio', 'The workspace could not be loaded.')}
    <section class="panel" role="alert">${empty('Connection unavailable', error.message, retry)}</section>`;
}

async function init() {
  bindEvents();
  try {
    if (!globalThis.StudioFolders) throw new Error('Restart QA Studio using Start QA Studio.cmd to load folder support.');
    historyTools = await import('/run-history.js');
    state = historyTools.recoverPlanState(await api('/api/state'));
    const requested = new URL(location.href).searchParams.get('projectId') || localStorage.getItem('qa-project');
    projectId = state.projects.find((item) => item.id === requested)?.id || state.projects[0]?.id;
    await navigate();
    lastSignature = JSON.stringify(state);
    pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
  } catch (error) {
    showLoadError(error);
  }
}

init();
