import { randomUUID } from 'node:crypto';
import { categories } from './test-case-generator.mjs';
import { selectPlannedTests } from './test-plan.mjs';

const MAX_MANUAL_STEPS = 1000;
const MAX_ASSUMPTIONS = 20;
const MAX_ASSUMPTION_LENGTH = 2000;
const MAX_TEST_DATA_ENTRIES = 100;
const MAX_TEST_DATA_FIELD_LENGTH = 160;
const MAX_TEST_DATA_VALUE_LENGTH = 2000;
const MAX_TEXT_LENGTH = 10000;
const MAX_SHORT_TEXT_LENGTH = 120;

const PRIORITIES = ['critical', 'high', 'medium', 'low'];
const TEST_TYPES = ['functional', 'regression', 'smoke', 'integration', 'performance', 'security', 'usability'];
const EXECUTION_MODES = ['manual', 'automation'];
const TERMINAL_STATUSES = ['passed', 'failed', 'blocked', 'skipped'];
const EXPECTATION_ACTIONS = ['text', 'value', 'url', 'heading'];

function check(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function text(value, label, max = MAX_TEXT_LENGTH) {
  check(typeof value === 'string' && value.length <= max, `${label} must be text, up to ${max} characters`);
  return value;
}

function choice(value, values, label) {
  check(values.includes(value), `Invalid ${label}`);
  return value;
}

function normalizeManualSteps(steps) {
  const ids = new Set();
  return steps.map((step, index) => {
    check(step && typeof step === 'object', `Step ${index + 1} is invalid`);
    const id = step.id || randomUUID();
    check(typeof id === 'string' && /^[\w-]{1,80}$/.test(id) && !ids.has(id), 'Manual step IDs must be unique');
    ids.add(id);
    const instruction = text(step.instruction ?? '', `Step ${index + 1} instruction`);
    check(instruction.trim(), `Step ${index + 1} needs an instruction`);
    return {
      id,
      instruction,
      expectedResult: text(step.expectedResult ?? '', `Step ${index + 1} expected result`),
    };
  });
}

export function normalizeQa(input, previous, automated = false) {
  const qa = input ?? previous ?? {};
  check(qa && typeof qa === 'object' && !Array.isArray(qa), 'Invalid test case details');

  const steps = qa.manualSteps ?? [];
  check(Array.isArray(steps) && steps.length <= MAX_MANUAL_STEPS, 'Maximum 1000 manual steps');
  const assumptions = qa.assumptions ?? previous?.assumptions ?? [];
  const testData = qa.testData ?? previous?.testData ?? [];
  check(Array.isArray(assumptions) && assumptions.length <= MAX_ASSUMPTIONS, 'Maximum 20 assumptions');
  check(Array.isArray(testData) && testData.length <= MAX_TEST_DATA_ENTRIES, 'Maximum 100 test data entries');
  const generationId = qa.generationId ?? previous?.generationId ?? '';
  check(
    typeof generationId === 'string' && (!generationId || /^TCG-[a-f0-9]{24}$/.test(generationId)),
    'Invalid generated case ID',
  );

  return {
    generationId,
    module: text(qa.module ?? previous?.module ?? '', 'Module', MAX_SHORT_TEXT_LENGTH),
    category: choice(qa.category ?? previous?.category ?? 'Functional', categories, 'case category'),
    requirementReference: text(qa.requirementReference ?? previous?.requirementReference ?? '', 'Requirement reference'),
    workflowDetails: text(qa.workflowDetails ?? previous?.workflowDetails ?? '', 'Workflow details'),
    assumptions: assumptions.map((value) => text(value, 'Assumption', MAX_ASSUMPTION_LENGTH)),
    testData: testData.map((item) => {
      check(item && typeof item === 'object', 'Invalid test data entry');
      return {
        field: text(item.field, 'Test data field', MAX_TEST_DATA_FIELD_LENGTH),
        value: text(item.value, 'Test data value', MAX_TEST_DATA_VALUE_LENGTH),
      };
    }),
    description: text(qa.description ?? '', 'Description'),
    preconditions: text(qa.preconditions ?? '', 'Preconditions'),
    expectedResult: text(qa.expectedResult ?? '', 'Expected result'),
    priority: choice(qa.priority ?? 'medium', PRIORITIES, 'priority'),
    type: choice(qa.type ?? 'functional', TEST_TYPES, 'test type'),
    owner: text(qa.owner ?? '', 'Assignee', MAX_SHORT_TEXT_LENGTH),
    executionMode: choice(qa.executionMode ?? (automated ? 'automation' : 'manual'), EXECUTION_MODES, 'execution mode'),
    manualSteps: normalizeManualSteps(steps),
    createdAt: previous?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

// Falls back to automation steps when the case has no written manual steps.
function manualInstructions(item) {
  if (item.qa?.manualSteps?.length) {
    return item.qa.manualSteps;
  }
  return item.steps.map((step) => ({
    instruction: step.name,
    expectedResult: EXPECTATION_ACTIONS.includes(step.action) && step.valueMode === 'static' ? step.value : '',
  }));
}

function manualRunTest(project, test) {
  const instructions = manualInstructions(test);
  check(instructions.length, `${test.name}: add test steps before starting a manual run`);

  const prerequisite = project.prerequisites?.find((item) => item.id === test.prerequisiteId);
  const setupSteps = prerequisite ? manualInstructions(prerequisite) : [];
  if (prerequisite) {
    check(setupSteps.length, `${prerequisite.name}: add precondition steps before starting a manual run`);
  }
  const combined = [
    ...setupSteps.map((step) => ({
      ...step,
      instruction: `${prerequisite.name} / ${step.instruction}`,
      phase: 'prerequisite',
      prerequisiteId: prerequisite.id,
    })),
    ...instructions,
  ];

  return {
    id: test.id,
    tcNumber: test.tcNumber,
    name: test.name,
    qa: structuredClone(test.qa || {}),
    status: 'pending',
    steps: combined.map((step) => ({
      name: step.instruction,
      expectedResult: step.expectedResult,
      ...(step.phase ? { phase: step.phase, prerequisiteId: step.prerequisiteId } : {}),
      action: 'manual',
      status: 'pending',
      actualResult: '',
    })),
  };
}

export function createManualRun(project, input) {
  const tests = selectPlannedTests(project, input);
  const planName = project.testPlans?.find((plan) => plan.id === input.planId)?.name;
  const defaultName = `Manual run · ${tests.length} ${tests.length === 1 ? 'case' : 'cases'}`;
  const activeEnvironment = project.environments.find((item) => item.id === project.activeEnvironmentId);
  return {
    id: randomUUID(),
    projectId: project.id,
    projectName: project.name,
    ...(input.planId ? { planId: input.planId } : {}),
    suiteId: input.suiteId || null,
    suiteName: project.suites.find((suite) => suite.id === input.suiteId)?.name || null,
    name: text(input.name || planName || defaultName, 'Run name', MAX_SHORT_TEXT_LENGTH),
    mode: 'manual',
    revision: 1,
    startedAt: new Date().toISOString(),
    status: 'running',
    environmentName: activeEnvironment?.name || 'Not specified',
    tests: tests.map((test) => manualRunTest(project, test)),
  };
}

export function summarizeStatuses(items) {
  if (items.some((item) => item.status === 'failed')) {
    return 'failed';
  }
  if (items.some((item) => item.status === 'blocked')) {
    return 'blocked';
  }
  return items.some((item) => item.status === 'passed') ? 'passed' : 'skipped';
}

function isTerminal(item) {
  return TERMINAL_STATUSES.includes(item.status);
}

function recordStepResult(run, input) {
  const test = run.tests.find((item) => item.id === input.testId);
  check(test, 'Test not found in this run');
  check(Number.isInteger(input.stepIndex) && test.steps[input.stepIndex], 'Step not found');
  const status = choice(input.status, TERMINAL_STATUSES, 'step status');
  const actualResult = text(input.actualResult ?? '', 'Actual result');
  Object.assign(test.steps[input.stepIndex], {
    status,
    actualResult,
    recordedAt: new Date().toISOString(),
  });
  test.status = test.steps.every(isTerminal) ? summarizeStatuses(test.steps) : 'running';
}

function completeRun(run) {
  check(
    run.tests.every((test) => test.steps.every(isTerminal)),
    'Record a result for every step before completing the run',
  );
  run.status = summarizeStatuses(run.tests);
}

function cancelRun(run) {
  for (const test of run.tests) {
    for (const step of test.steps) {
      if (!isTerminal(step)) {
        step.status = 'skipped';
      }
    }
    test.status = summarizeStatuses(test.steps);
  }
  run.status = 'interrupted';
}

export function updateManualRun(run, input, operation) {
  check(run.mode === 'manual', 'This is not a manual run');
  if (run.status !== 'running') {
    throw Object.assign(new Error('This run is already complete'), { status: 409 });
  }
  if (input.revision !== run.revision) {
    throw Object.assign(new Error('This run changed in another tab. Refresh before saving your result.'), {
      status: 409,
      code: 'EDIT_CONFLICT',
    });
  }

  if (operation === 'steps') {
    recordStepResult(run, input);
  } else if (operation === 'complete') {
    completeRun(run);
  } else if (operation === 'cancel') {
    cancelRun(run);
  } else {
    throw new Error('Unknown manual run operation');
  }

  if (run.status !== 'running') {
    run.finishedAt = new Date().toISOString();
    run.duration = Date.now() - Date.parse(run.startedAt);
  }
  run.revision += 1;
  return run;
}
