import { createRequire } from 'node:module';
import { browserLabels } from './browsers.mjs';

const { version: PLAYWRIGHT_VERSION } = createRequire(import.meta.url)('playwright/package.json');
const SOURCE_FILE = 'qa-studio';
const RESULTS = {
  passed: { status: 'passed', outcome: 'expected' },
  failed: { status: 'failed', outcome: 'unexpected' },
  skipped: { status: 'skipped', outcome: 'skipped' },
};
// Playwright leaves interrupted results out of a test's outcome, so they count as skipped.
const NOT_COMPLETED = { status: 'interrupted', outcome: 'skipped' };

export function runBrowserLabel(run) {
  if (run.mode === 'manual') {
    return 'Manual execution';
  }
  return browserLabels[run.browser] || 'Chromium';
}

export const caseResult = (status) => RESULTS[status] || NOT_COMPLETED;

export const tcLabel = (test) => (test.tcNumber ? `TC-${String(test.tcNumber).padStart(4, '0')}` : '');

const annotation = (type, description) => (description ? [{ type, description: String(description) }] : []);

function stepAttachments(step, index) {
  const name = step.name || `Step ${index + 1}`;
  return [
    ...(step.screenshot ? [{ file: step.screenshot, label: `${name} — screenshot` }] : []),
    ...(step.targetScreenshots || []).map((file, position) => ({ file, label: `${name} — locator ${position + 1}` })),
  ].map(({ file, label }) => ({ name: label, contentType: 'image/png', path: `/artifacts/${file}` }));
}

function jsonStep(step, index) {
  return {
    title: step.name || `Step ${index + 1}`,
    duration: Number(step.duration || 0),
    ...(step.error ? { error: { message: String(step.error) } } : {}),
    annotations: [
      ...annotation('status', step.status),
      ...annotation('action', step.action),
      ...annotation('expected', step.expectedResult),
      ...annotation('actual', step.actualResult),
    ],
  };
}

function jsonSpec(test, index, startTime, projectName) {
  const { status, outcome } = caseResult(test.status);
  const steps = test.steps || [];
  const message = test.error ? String(test.error) : '';
  const errors = message ? [{ message }] : [];
  return {
    title: test.name || `Test ${index + 1}`,
    ok: outcome !== 'unexpected',
    tags: [...(test.qa?.priority ? [test.qa.priority] : []), ...(status === 'interrupted' ? [test.status || 'unknown'] : [])],
    id: String(test.id),
    file: SOURCE_FILE,
    line: 0,
    column: 0,
    tests: [
      {
        timeout: 0,
        annotations: [...annotation('tc-number', tcLabel(test)), ...annotation('qa-status', test.status)],
        expectedStatus: 'passed',
        projectId: projectName,
        projectName,
        status: outcome,
        results: [
          {
            workerIndex: 0,
            parallelIndex: 0,
            status,
            duration: Number(test.duration || 0),
            errors,
            ...(message ? { error: { message } } : {}),
            stdout: [],
            stderr: [],
            retry: 0,
            startTime: new Date(startTime).toISOString(),
            steps: steps.map(jsonStep),
            attachments: steps.flatMap(stepAttachments),
            annotations: [],
          },
        ],
      },
    ],
  };
}

// Follows Playwright's JSON reporter format so standard tools can read it. Fields are copied by
// name because a run also holds stored variables, database profiles and dataset values.
export function playwrightJsonReport(run) {
  const tests = run.tests || [];
  const projectName = runBrowserLabel(run);
  const started = Date.parse(run.startedAt) || 0;
  let elapsed = 0;
  const specs = tests.map((test, index) => {
    const spec = jsonSpec(test, index, started + elapsed, projectName);
    elapsed += Number(test.duration || 0);
    return spec;
  });
  const count = (outcome) => tests.filter((test) => caseResult(test.status).outcome === outcome).length;
  return {
    config: {
      version: PLAYWRIGHT_VERSION,
      metadata: {
        project: run.projectName || '',
        runId: run.id,
        runName: run.name || '',
        status: run.status || 'unknown',
        mode: run.mode || 'automation',
        environment: run.environmentName || '',
        suite: run.suiteName || '',
      },
      projects: [{ id: projectName, name: projectName }],
    },
    // A case report's run name is the case's own name, which the row below already shows.
    suites: [{ title: run.suiteName || (run.caseId ? 'Test case' : run.name) || run.projectName || 'Test cases', file: SOURCE_FILE, line: 0, column: 0, specs, suites: [] }],
    errors: run.error ? [{ message: String(run.error) }] : [],
    stats: {
      startTime: new Date(started).toISOString(),
      duration: Number(run.duration || 0),
      expected: count('expected'),
      unexpected: count('unexpected'),
      flaky: 0,
      skipped: count('skipped'),
    },
  };
}
