import { groupCaseRuns, sortRunsNewestFirst } from './public/run-history.js';

const STATUSES = ['passed', 'failed', 'blocked', 'skipped', 'interrupted', 'running', 'pending'];
const MODES = ['manual', 'automation'];
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const NO_SUITE = 'No suite';
const CSV_HEADER = [
  'Test case',
  'Name',
  'Run',
  'Suite',
  'Mode',
  'Browser',
  'Started',
  'Status',
  'Duration (ms)',
  'Assignee',
  'Error',
];

const invalid = (message) => {
  throw Object.assign(new Error(message), { status: 400 });
};

function dateParam(params, key) {
  const value = params.get(key);
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) invalid(`Invalid ${key}`);
  return parsed;
}

function integerParam(params, key, fallback, minimum, maximum) {
  const value = params.has(key) ? Number(params.get(key)) : fallback;
  if (!Number.isSafeInteger(value) || value < minimum) invalid(`Invalid ${key}`);
  return Math.min(value, maximum);
}

function isRunInRange(run, from, to) {
  if (from === null && to === null) return true;
  const started = Date.parse(run.startedAt);
  if (from !== null && !(started >= from)) return false;
  return to === null || started <= to;
}

function buildRow(run, result) {
  const [test] = result.tests;
  const mode = run.mode || 'automation';
  return {
    runId: run.id,
    caseId: result.caseId,
    number: test.tcNumber ? `TC-${String(test.tcNumber).padStart(4, '0')}` : result.caseId,
    name: test.name,
    runName: run.name || run.suiteName || 'Test run',
    suite: run.suiteName || NO_SUITE,
    mode,
    browser: run.mode === 'manual' ? '—' : run.browser || '—',
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    status: result.status,
    duration: result.duration,
    owner: test.qa?.owner || 'Unassigned',
    error: result.error || '',
    tests: result.tests,
  };
}

function summarize(rows) {
  const counts = Object.fromEntries(STATUSES.map((status) => [status, 0]));
  const suites = new Map();
  const runIds = new Set();
  const caseIds = new Set();
  let completedCount = 0;
  let completedDuration = 0;
  for (const row of rows) {
    counts[row.status] += 1;
    runIds.add(row.runId);
    caseIds.add(row.caseId);
    if (row.status !== 'pending' && row.status !== 'running') {
      completedCount += 1;
      completedDuration += row.duration;
    }
    const group = suites.get(row.suite) || { name: row.suite, total: 0, passed: 0, failed: 0 };
    group.total += 1;
    group.passed += row.status === 'passed' ? 1 : 0;
    group.failed += row.status === 'failed' ? 1 : 0;
    suites.set(row.suite, group);
  }
  return {
    counts,
    runs: runIds.size,
    cases: caseIds.size,
    passRate: completedCount ? Math.round((counts.passed / completedCount) * 100) : null,
    averageDuration: completedCount ? completedDuration / completedCount : null,
    suites: [...suites.values()],
  };
}

function projectRow(row) {
  return {
    ...row,
    tests: row.tests.map((test) => ({
      name: test.name,
      status: test.status,
      error: test.error,
      trace: test.trace,
      steps: test.steps.map((step) => ({
        name: step.name || step.instruction,
        status: step.status,
        duration: step.duration,
        expectedResult: step.expectedResult,
        actualResult: step.actualResult,
        error: step.error,
        screenshot: step.screenshot,
      })),
    })),
  };
}

export function queryExecutionOverview(source, params) {
  const from = dateParam(params, 'from');
  const to = dateParam(params, 'to');
  if (from !== null && to !== null && from > to) invalid('From date must be on or before Through date');
  const status = params.get('status');
  const mode = params.get('mode');
  if (status && !STATUSES.includes(status)) invalid('Invalid status');
  if (mode && !MODES.includes(mode)) invalid('Invalid mode');
  const limit = integerParam(params, 'limit', DEFAULT_LIMIT, 1, MAX_LIMIT);
  const requestedOffset = integerParam(params, 'offset', 0, 0, Number.MAX_SAFE_INTEGER);
  const search = (params.get('search') || '').toLowerCase();
  const suite = params.get('suite');

  const matchingRuns = source.filter((run) => {
    if (mode && (run.mode || 'automation') !== mode) return false;
    if (suite && (run.suiteName || NO_SUITE) !== suite) return false;
    return isRunInRange(run, from, to);
  });

  const rows = [];
  for (const run of sortRunsNewestFirst(matchingRuns)) {
    for (const result of groupCaseRuns(run)) {
      if (status && result.status !== status) continue;
      const row = buildRow(run, result);
      const searched = [row.name, row.number, result.tests[0].qa?.owner, run.name].join(' ').toLowerCase();
      if (search && !searched.includes(search)) continue;
      rows.push(row);
    }
  }

  const offset = Math.min(requestedOffset, Math.max(0, Math.ceil(rows.length / limit) - 1) * limit);
  const selected = params.get('export') === 'csv' ? rows : rows.slice(offset, offset + limit);
  return {
    total: rows.length,
    offset,
    limit,
    summary: summarize(rows),
    suites: [...new Set(source.map((run) => run.suiteName || NO_SUITE))].sort(),
    rows: selected.map(projectRow),
  };
}

const csvCell = (value) =>
  `"${String(value ?? '')
    .replace(/^[=+@\-\t\r]/, "'$&")
    .replaceAll('"', '""')}"`;

function rowError(row) {
  if (row.error) return row.error;
  return row.tests
    .flatMap((test) => [test.error, ...test.steps.map((step) => step.error)])
    .filter(Boolean)
    .join('; ');
}

export function executionCsv(rows) {
  const lines = rows.map((row) => [
    row.number,
    row.name,
    row.runId,
    row.suite,
    row.mode,
    row.browser,
    row.startedAt,
    row.status,
    row.duration,
    row.owner,
    rowError(row),
  ]);
  return [CSV_HEADER, ...lines].map((line) => line.map(csvCell).join(',')).join('\r\n');
}
