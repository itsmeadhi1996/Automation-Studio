import path from 'node:path';
import { caseRun } from './public/run-history.js';

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

const ATTACHMENT_TYPES = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp',
  '.mp4', '.webm', '.mov',
  '.txt', '.log', '.json', '.csv',
  '.pdf', '.zip',
]);
const REPORTABLE = ['failed', 'blocked', 'interrupted'];
const MAX_NAME_LENGTH = 200;

export const REPORT_EVIDENCE_ID = 'report';

export function attachmentName(value) {
  const name = path.basename(String(value || '').replaceAll('\\', '/')).trim();
  const hasValidName = name && name.length <= MAX_NAME_LENGTH && !/[\p{Cc}"]/u.test(name);
  const isAllowed = hasValidName && ATTACHMENT_TYPES.has(path.extname(name).toLowerCase());
  return isAllowed ? name : null;
}

const stepLabel = (step, index) => step.name || step.instruction || `Step ${index + 1}`;

// Dataset rows of one case share one bug, so each row only adds its failure.
function rowLabel(test, tests) {
  return tests.length > 1 ? `[${test.name}] ` : '';
}

function failedStep(test) {
  return (test.steps || []).find((step) => REPORTABLE.includes(step.status)) || null;
}

function reproductionSteps(testCase, tests) {
  const runSteps = tests[0]?.steps;
  if (!runSteps?.length) {
    const planned = testCase.qa?.manualSteps?.length ? testCase.qa.manualSteps : testCase.steps || [];
    return planned.map((step, index) => `${index + 1}. ${stepLabel(step, index)}`).join('\n');
  }
  const failed = tests.find(failedStep);
  const failure = failed ? failedStep(failed) : null;
  const failureIndex = failure ? failed.steps.indexOf(failure) : -1;
  return runSteps
    .map((step, index) => `${index + 1}. ${stepLabel(step, index)}${index === failureIndex ? '  <-- FAILED HERE' : ''}`)
    .join('\n');
}

function resultLines(testCase, tests) {
  const reportable = tests.filter((test) => REPORTABLE.includes(test.status));
  const lines = (reportable.length ? reportable : tests).flatMap((test) => {
    const step = failedStep(test);
    const prefix = rowLabel(test, tests);
    return [
      step?.expectedResult ? `${prefix}Expected: ${step.expectedResult}` : '',
      step?.actualResult ? `${prefix}Actual: ${step.actualResult}` : '',
      step?.error || test.error ? `${prefix}Error: ${step?.error || test.error}` : '',
    ].filter(Boolean);
  });
  if (!lines.some((line) => line.includes('Expected:')) && testCase.qa?.expectedResult) {
    lines.unshift(`Expected: ${testCase.qa.expectedResult}`);
  }
  return lines.join('\n');
}

function runDetails({ project, testCase, run, tests, userName }) {
  const failedRows = tests.filter((test) => REPORTABLE.includes(test.status)).map((test) => test.name);
  return [
    `Project: ${project.name}`,
    `Test case: ${testCase.name}`,
    run ? `Run ID: ${run.id}` : '',
    run ? `Result: ${run.status}` : '',
    run?.environmentName ? `Environment: ${run.environmentName}` : '',
    run?.browser ? `Browser: ${run.browser}` : '',
    run?.startedAt ? `Date: ${run.startedAt}` : '',
    tests.length > 1 ? `Failed dataset rows: ${failedRows.join(', ') || 'None'}` : '',
    userName ? `Raised by: ${userName}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function issueTitle(testCase, tests) {
  const failed = tests.find(failedStep);
  const failure = failed ? failedStep(failed) : null;
  const id = `TC-${String(testCase.tcNumber || 0).padStart(4, '0')}`;
  const name = `${id}: ${testCase.name}`;
  return (failure ? `${name}: ${stepLabel(failure, failed.steps.indexOf(failure))} failed` : name).slice(0, 255);
}

// `run` is the viewer's copy, so anything redacted for this user stays out of the draft.
export function buildIssueDraft({ project, testCase, run, userName }) {
  const scoped = run ? caseRun(run, testCase.id) : null;
  const tests = scoped?.tests || [];
  return {
    summary: issueTitle(testCase, tests),
    stepsToReproduce: reproductionSteps(testCase, tests),
    results: resultLines(testCase, tests),
    runDetails: runDetails({ project, testCase, run: scoped, tests, userName }),
  };
}

// Only files this run recorded can be sent, so a request cannot name arbitrary artifacts.
export function collectEvidence(run, testId) {
  const scoped = run ? caseRun(run, testId) : null;
  if (!scoped) return [];
  const items = new Map();
  const add = (file, label, checked = false) => {
    if (typeof file !== 'string' || !file || items.has(file)) return;
    items.set(file, { id: file, file, name: file, label, checked });
  };
  for (const test of scoped.tests) {
    const prefix = rowLabel(test, scoped.tests);
    const failure = failedStep(test);
    (test.steps || []).forEach((step, index) => {
      const label = stepLabel(step, index);
      add(step.screenshot, `${prefix}Screenshot: ${label}`, step === failure);
      for (const shot of step.targetScreenshots || []) {
        add(typeof shot === 'string' ? shot : shot?.screenshot || shot?.file, `${prefix}Locator screenshot: ${label}`);
      }
    });
    add(test.trace, `${prefix}Execution trace`);
  }
  return [...items.values()];
}
