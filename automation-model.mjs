import { nameGeneratedSteps } from './generated-step-names.mjs';
import { assert, uuid } from './model.mjs';

// QA owns the case. Automation owns a replaceable mapping and its script.
export function automationProject(project) {
  const mappedTests = project.tests.filter((test) => test.automation !== null);
  return {
    ...project,
    processes: project.processes || [],
    tests: mappedTests.map((test) => ({
      ...test,
      qaCaseId: test.id,
      id: test.automation?.id || test.id,
      tcNumber: test.automation?.tcNumber || test.tcNumber,
      steps: nameGeneratedSteps(test.steps || [], { project, onlyGeneric: true }),
    })),
  };
}

function findPreviousTest(test, previous) {
  return previous.tests.find((item) => {
    if (test.qaCaseId) {
      return item.id === test.qaCaseId;
    }
    return (item.automation?.id || item.id) === test.id;
  });
}

// Omission from the automation workspace deletes only the automation script.
function withoutAutomationScript(old, input) {
  const hasFolder = (id) => input.folders?.some((item) => item.id === id);
  const hasSuite = (id) => input.suites?.some((item) => item.id === id);
  const hasPrerequisite = (id) => input.prerequisites?.some((item) => item.id === id);
  return {
    ...old,
    automation: null,
    steps: [],
    dataRows: [],
    localTestData: [],
    folderId: hasFolder(old.folderId) ? old.folderId : null,
    suiteId: hasSuite(old.suiteId) ? old.suiteId : null,
    additionalSuiteIds: (old.additionalSuiteIds || []).filter(hasSuite),
    prerequisiteId: hasPrerequisite(old.prerequisiteId) ? old.prerequisiteId : null,
  };
}

export function mergeAutomationProject(input, previous) {
  const seen = new Set();
  const tests = input.tests.map((test) => {
    const old = findPreviousTest(test, previous);
    if (!old) {
      assert(!test.qaCaseId, 'The linked QA case no longer exists. Reopen it from QA Studio.');
      const { automation, qaCaseId, ...added } = test;
      return added;
    }
    assert(
      old.automation !== null && (old.automation?.id || old.id) === test.id,
      'This automation case was deleted or replaced. Reopen the case from QA Studio.',
    );
    assert(!seen.has(old.id), 'Duplicate QA case mapping');
    seen.add(old.id);
    return { ...test, id: old.id, tcNumber: old.tcNumber, automation: old.automation };
  });
  for (const old of previous.tests) {
    if (!seen.has(old.id)) {
      tests.push(withoutAutomationScript(old, input));
    }
  }
  return { ...input, tests };
}

export function ensureAutomationCases(project, input, counter) {
  const ids = input.testIds || (input.testId ? [input.testId] : null);
  assert(ids || input.suiteId, 'Choose QA cases to open in Automation Studio.');
  if (ids) {
    assert(
      Array.isArray(ids) && ids.length && ids.every((id) => project.tests.some((test) => test.id === id)),
      'A selected QA case no longer exists. Refresh QA Studio.',
    );
  }
  if (input.suiteId) {
    assert(
      project.suites.some((suite) => suite.id === input.suiteId),
      'Suite not found',
    );
  }

  const chosen = project.tests.filter((test) => {
    const matchesIds = !ids || ids.includes(test.id);
    const matchesSuite =
      !input.suiteId || test.suiteId === input.suiteId || test.additionalSuiteIds?.includes(input.suiteId);
    return matchesIds && matchesSuite;
  });
  assert(chosen.length, 'No QA cases selected');

  const created = [];
  for (const test of chosen) {
    if (test.automation === null) {
      test.automation = { id: uuid(), tcNumber: counter.nextTestNumber++ };
      test.steps = [];
      test.dataRows = [];
      test.localTestData = [];
      created.push(test.automation.id);
    }
  }
  if (created.length) {
    project.revision = (project.revision || 0) + 1;
  }
  return { testIds: chosen.map((test) => test.automation?.id || test.id), created };
}
