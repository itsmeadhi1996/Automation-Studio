import { sortRunsNewestFirst } from './public/run-history.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const END_OF_DAY_MS = 86399999;

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function integerParam(params, key, fallback, max) {
  const raw = params.get(key);
  if (raw === null) {
    return fallback;
  }
  const value = Number(raw);
  const belowMinimum = value < 0 || (key === 'limit' && value < 1);
  if (!Number.isSafeInteger(value) || belowMinimum) {
    throw badRequest(`Invalid ${key}`);
  }
  return Math.min(value, max);
}

function dateParam(params, key) {
  const raw = params.get(key);
  if (!raw) {
    return null;
  }
  const value = Date.parse(raw);
  if (!Number.isFinite(value)) {
    throw badRequest(`Invalid ${key}`);
  }
  return key === 'to' && DATE_ONLY.test(raw) ? value + END_OF_DAY_MS : value;
}

function contains(value, query) {
  return !query || String(value || '').toLocaleLowerCase().includes(query);
}

function startedWithin(run, from, to) {
  if (from === null && to === null) {
    return true;
  }
  // An invalid startedAt parses to NaN, which fails both comparisons and leaves the run out.
  const started = Date.parse(run.startedAt);
  return (from === null || started >= from) && (to === null || started <= to);
}

// Filters the complete visible history first, so a page never hides a match.
export function queryRunHistory(source, params) {
  const limit = integerParam(params, 'limit', DEFAULT_LIMIT, MAX_LIMIT);
  const requestedOffset = integerParam(params, 'offset', 0, Number.MAX_SAFE_INTEGER);
  const from = dateParam(params, 'from');
  const to = dateParam(params, 'to');
  if (from !== null && to !== null && from > to) {
    throw badRequest('Start date must be before end date');
  }

  const status = params.get('status');
  const suiteQuery = (params.get('suiteName') || '').toLocaleLowerCase();
  const testQuery = (params.get('testName') || '').toLocaleLowerCase();

  const testNames = new Set();
  const suiteNames = new Set();
  const statuses = new Set();
  const matches = [];

  for (const run of source) {
    for (const test of run.tests) {
      testNames.add(test.name);
    }
    if (run.suiteName) {
      suiteNames.add(run.suiteName);
    }
    statuses.add(run.status);

    const matchesFilters =
      (!status || run.status === status) &&
      contains(run.suiteName, suiteQuery) &&
      (!testQuery || run.tests.some((test) => contains(test.name, testQuery))) &&
      startedWithin(run, from, to);
    if (matchesFilters) {
      matches.push(run);
    }
  }

  const runs = sortRunsNewestFirst(matches);
  const lastPageOffset = Math.max(0, Math.ceil(runs.length / limit) - 1) * limit;
  const offset = Math.min(requestedOffset, lastPageOffset);
  return {
    total: runs.length,
    offset,
    limit,
    runs: runs.slice(offset, offset + limit),
    filters: {
      testNames: [...testNames].sort(),
      suiteNames: [...suiteNames].sort(),
      statuses: [...statuses].sort(),
    },
  };
}
