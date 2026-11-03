// Shared by the history API, reports, and Automation Studio.

// Parses each timestamp once; callers choose whether equal dates need an ID tie-break.
export function sortRunsNewestFirst(source, tieBreak = true) {
  return source
    .map((run) => ({ run, time: Date.parse(run.startedAt) }))
    .sort((a, b) => {
      const newestFirst = b.time - a.time;
      if (newestFirst || !tieBreak) {
        return newestFirst;
      }
      return String(a.run.id).localeCompare(String(b.run.id));
    })
    .map((entry) => entry.run);
}

function latestQaStatus(statuses, runStatus) {
  if (statuses.includes('failed')) {
    return 'failed';
  }
  if (statuses.includes('blocked')) {
    return 'blocked';
  }
  if (statuses.some((status) => status === 'running' || status === 'pending')) {
    return runStatus === 'running' ? 'running' : 'interrupted';
  }
  return statuses.every((status) => status === 'passed') ? 'passed' : statuses[0];
}

// QA's latest-result rules differ on purpose from execution-report aggregation.
// Each case is indexed only in its most recent loaded run.
export function indexQaHistory(source, projectId) {
  const runs = sortRunsNewestFirst(
    source.filter((run) => run.projectId === projectId),
    false,
  );
  const latest = new Map();
  for (const run of runs) {
    const statusesByCase = new Map();
    for (const test of run.tests) {
      const id = test.qaCaseId || test.sourceTestId || test.id;
      if (latest.has(id)) {
        continue;
      }
      if (!statusesByCase.has(id)) {
        statusesByCase.set(id, []);
      }
      statusesByCase.get(id).push(test.status);
    }
    for (const [id, statuses] of statusesByCase) {
      latest.set(id, { run, status: latestQaStatus(statuses, run.status) });
    }
  }
  return { runs, latest };
}

export function matchesCase(test, id) {
  return Boolean(id) && [test.id, test.sourceTestId, test.qaCaseId].includes(id);
}

// A test's suite membership does not make its individual execution a suite run.
// Multiple dataset rows still belong to one individually executed case.
export function isIndividualCaseRun(run, id) {
  return (
    !run.suiteId &&
    !run.suiteName &&
    run.tests.length > 0 &&
    (run.totalTestCount ?? run.tests.length) === run.tests.length &&
    run.tests.every((test) => matchesCase(test, id))
  );
}

function isStartupFailure(run) {
  return run.tests.every((test) => ['pending', 'skipped'].includes(test.status));
}

function caseStatus(run, statuses) {
  if (statuses.includes('failed')) {
    return 'failed';
  }
  if (statuses.includes('running')) {
    return 'running';
  }
  if (statuses.includes('pending')) {
    return (run.sourceStatus || run.status) === 'running' ? 'pending' : 'skipped';
  }
  if (statuses.includes('interrupted')) {
    return 'interrupted';
  }
  if (statuses.includes('blocked')) {
    return 'blocked';
  }
  return statuses.every((status) => status === 'passed') ? 'passed' : 'skipped';
}

function testDuration(test) {
  return test.duration ?? test.steps.reduce((sum, step) => sum + (step.duration || 0), 0);
}

function summarizeCaseRun(run, id, tests, startupFailure) {
  let status = caseStatus(
    run,
    tests.map((test) => test.status),
  );
  // Global startup failures apply to every case; another case's failure does not.
  const error = run.error && (tests.length === run.tests.length || startupFailure) ? run.error : undefined;
  if (error && run.status === 'failed' && status === 'skipped') {
    status = 'failed';
  }
  return {
    ...run,
    context: undefined,
    name: tests[0].name,
    tests,
    status,
    error,
    duration: tests.reduce((total, test) => total + testDuration(test), 0),
    caseId: id,
    sourceStatus: run.sourceStatus || run.status,
    totalTestCount: run.totalTestCount ?? run.tests.length,
  };
}

export function caseRun(run, id) {
  const tests = run.tests.filter((test) => matchesCase(test, id));
  if (!tests.length) {
    return null;
  }
  return summarizeCaseRun(run, id, tests, isStartupFailure(run));
}

// Indexes each identity once instead of scanning every dataset row for each case.
export function groupCaseRuns(run) {
  const groups = new Map();
  const caseIds = new Set();
  for (const test of run.tests) {
    caseIds.add(test.qaCaseId || test.sourceTestId || test.id);
    const aliases = new Set([test.id, test.sourceTestId, test.qaCaseId].filter(Boolean));
    for (const alias of aliases) {
      if (!groups.has(alias)) {
        groups.set(alias, []);
      }
      groups.get(alias).push(test);
    }
  }
  const startupFailure = isStartupFailure(run);
  return [...caseIds].map((id) => summarizeCaseRun(run, id, groups.get(id), startupFailure));
}

function canonicalCaseId(test) {
  return test.qaCaseId || test.id;
}

function indexProjectCases(tests) {
  const aliases = new Map();
  const casesByCanonicalId = new Map();
  tests.forEach((test, index) => {
    const entry = { test, index };
    for (const id of [test.id, test.qaCaseId, test.automation?.id]) {
      if (id && !aliases.has(id)) {
        aliases.set(id, entry);
      }
    }
    const canonicalId = canonicalCaseId(test);
    if (!casesByCanonicalId.has(canonicalId)) {
      casesByCanonicalId.set(canonicalId, []);
    }
    casesByCanonicalId.get(canonicalId).push(entry);
  });
  return { aliases, casesByCanonicalId };
}

// Preserves the first project case when historical aliases are ambiguous.
function findCaseForSnapshot(snapshot, aliases) {
  let match;
  for (const id of [snapshot.qaCaseId, snapshot.sourceTestId, snapshot.id]) {
    const entry = id && aliases.get(id);
    if (entry && (!match || entry.index < match.index)) {
      match = entry;
    }
  }
  return match?.test;
}

function defaultPlanName(run) {
  if (run.name || run.suiteName) {
    return run.name || run.suiteName;
  }
  return run.mode === 'manual' ? 'Manual test run' : 'Automated test run';
}

function soleOwner(testIds, casesByCanonicalId) {
  const entries = testIds.flatMap((id) => casesByCanonicalId.get(id)).sort((a, b) => a.index - b.index);
  const owners = [...new Set(entries.map((entry) => entry.test.qa?.owner).filter(Boolean))];
  return owners.length === 1 ? owners[0] : '';
}

// Upgrades the pre-plan workspace without hiding its named runs or transferred cases.
// An explicit array (including []) means the user already manages saved plans.
export function recoverTestPlans(project, runs = []) {
  if (Array.isArray(project.testPlans)) {
    return project;
  }
  const tests = project.tests || [];
  const plans = new Map();
  const covered = new Set();
  const { aliases, casesByCanonicalId } = indexProjectCases(tests);

  const projectRuns = runs.filter((run) => run.projectId === project.id && !run.planId);
  for (const run of sortRunsNewestFirst(projectRuns, false)) {
    const matchedCases = (run.tests || []).map((snapshot) => findCaseForSnapshot(snapshot, aliases)).filter(Boolean);
    const testIds = [...new Set(matchedCases.map(canonicalCaseId))];
    if (!testIds.length) {
      continue;
    }
    const name = defaultPlanName(run);
    const key = JSON.stringify([name, [...testIds].sort()]);
    for (const id of testIds) {
      covered.add(id);
    }
    const existing = plans.get(key);
    if (existing) {
      if (Date.parse(run.startedAt) < Date.parse(existing.createdAt)) {
        existing.createdAt = run.startedAt;
      }
      continue;
    }
    plans.set(key, {
      id: `legacy-${run.id}`,
      name,
      testIds,
      createdAt: run.startedAt,
      createdBy: '',
      assignedTo: soleOwner(testIds, casesByCanonicalId),
      release: '',
      status: 'open',
      type: 'Specific',
    });
  }

  const remaining = tests.filter((test) => test.inTestPlan === true && !covered.has(canonicalCaseId(test)));
  if (remaining.length) {
    const earliestCreated = remaining
      .map((test) => test.qa?.createdAt)
      .filter(Boolean)
      .sort()[0];
    plans.set('unexecuted', {
      id: `legacy-cases-${project.id}`,
      name: 'Transferred test cases',
      testIds: remaining.map(canonicalCaseId),
      createdAt: earliestCreated || new Date().toISOString(),
      createdBy: '',
      assignedTo: '',
      release: '',
      status: 'open',
      type: 'Specific',
    });
  }
  return { ...project, testPlans: [...plans.values()], _recoveredTestPlans: true };
}

export function recoverPlanState(state) {
  state.projects = state.projects.map((project) => recoverTestPlans(project, state.runs));
  return state;
}
