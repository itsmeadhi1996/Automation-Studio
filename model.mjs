import { randomUUID } from 'node:crypto';
import { agentOptions } from './agent-workflow.mjs';
import { normalizeLocalData } from './local-data-schema.mjs';
import './public/locator-templates.js';
import { normalizeQa } from './qa-model.mjs';
import { normalizeRequirements } from './requirements.mjs';
import { selectPlannedTests } from './test-plan.mjs';

const MAX_NAME_LENGTH = 120;
const MAX_LOCATOR_LENGTH = 2000;
const MAX_VALUE_LENGTH = 10000;
const MAX_RECORDED_NAME_LENGTH = 1000;
const MAX_LIST_ENTRIES = 100;
const MAX_VARIABLES = 500;
const MAX_STEPS = 1000;
const MAX_TESTS = 1000;
const MAX_TEST_PLANS = 1000;
export const MAX_PROCESS_RUNS = 1000;
const MAX_EXPANDED_PROCESS_STEPS = 10000;
const MAX_MAPPINGS = 1000;
const MAX_LOCATOR_TEMPLATES = 1000;
const MAX_OBJECTS = 500;
const MAX_LEGACY_OBJECTS = 500;
const MAX_LEGACY_OBJECT_SIZE = 20000;
const MAX_LEGACY_REASON_LENGTH = 2000;
const MAX_FRAME_PATH = 10;
const MAX_EXPECTED_ROWS = 25;
const MAX_EXPECTED_COLUMNS = 40;
const MAX_EXPECTED_CELL_LENGTH = 128;
const MAX_HOST_LENGTH = 250;
const MAX_PASSWORD_LENGTH = 2000;
const MAX_OWNER_ID_LENGTH = 80;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 120000;
const DEFAULT_TIMEOUT_MS = 10000;
const MAX_BROWSER_TABS = 20;
const MAX_PORT = 65535;
const DEFAULT_DATABASE_PORT = 5432;

const VALUE_MODES = ['static', 'global', 'environment', 'data', 'local'];
const WAIT_AFTER_MODES = ['auto', 'redirect', 'none'];
const SSL_MODES = ['prefer', 'require', 'disable'];
const BROWSERS = ['chrome', 'firefox', 'edge'];
const PLAN_STATUSES = ['open', 'closed', 'archived'];
const REPOSITORY_LOCATOR_TYPES = ['css', 'xpath'];

const repository = globalThis.StudioLocators;

export const actions = [
  'navigate',
  'url',
  'click',
  'hover',
  'doubleClick',
  'pressKey',
  'uploadFile',
  'fill',
  'select',
  'check',
  'uncheck',
  'dateOnly',
  'dateTime',
  'visible',
  'text',
  'value',
  'hidden',
  'heading',
  'uiValidate',
  'wait',
  'screenshot',
  'jdbcQuery',
  'dbValidate',
];

export const locatorTypes = ['css', 'xpath', 'id', 'name', 'text', 'label', 'placeholder', 'testId', 'custom', 'object'];

export const uuid = () => randomUUID();

export const resolveLocator = repository.resolve;

export const migrateRepository = (project) => repository.migrateRepository(project, uuid);

export function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function str(value, label, max = MAX_NAME_LENGTH, required = false) {
  assert(value === undefined || typeof value === 'string', `${label} must be text`);
  const result = value ?? '';
  assert(
    result.length <= max && (!required || result.trim()),
    `${label} must contain ${required ? '1' : '0'}–${max} characters`,
  );
  return result;
}

function list(value, label, max = MAX_LIST_ENTRIES) {
  const items = value ?? [];
  assert(Array.isArray(items) && items.length <= max, `${label}: maximum ${max} entries`);
  return items;
}

function identifier(value) {
  const id = value || uuid();
  assert(/^[a-zA-Z0-9-]{1,80}$/.test(id), 'Invalid ID');
  return id;
}

function variables(value = {}) {
  assert(
    value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length <= MAX_VARIABLES,
    'Invalid variables',
  );
  const entries = Object.entries(value).map(([key, entryValue]) => {
    assert(/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key), `Invalid variable: ${key}`);
    return [key, str(entryValue, key, MAX_VALUE_LENGTH)];
  });
  return Object.fromEntries(entries);
}

function isValidPageIndex(value) {
  return Number.isInteger(value) && value >= 0 && value < MAX_BROWSER_TABS;
}

function isValidTimeout(value) {
  return Number.isInteger(value) && value >= MIN_TIMEOUT_MS && value <= MAX_TIMEOUT_MS;
}

function framePathOf(value) {
  return list(value, 'Frame path', MAX_FRAME_PATH).map((frame) => str(frame, 'Frame selector', MAX_LOCATOR_LENGTH, true));
}

export function mapStepToRequirement(step, requirements, requirementId) {
  const result = structuredClone(step);
  if (requirementId === null || requirementId === '') {
    if (result.qaRequirementId) {
      result.name = result.unmappedName || result.name;
    }
    delete result.qaRequirementId;
    delete result.unmappedName;
    return result;
  }
  const requirement = requirements.find((item) => item.id === requirementId);
  assert(requirement, 'Choose a requirement from the linked QA Studio test case');
  if (!result.qaRequirementId) {
    result.unmappedName = result.name;
  }
  result.qaRequirementId = requirement.id;
  result.name = result.recordedName
    ? `${result.recordedName} — ${requirement.instruction}`.slice(0, MAX_VALUE_LENGTH)
    : requirement.instruction;
  return result;
}

export function mapRecordedSteps(steps, requirements, mappings) {
  assert(Array.isArray(mappings) && mappings.length > 0 && mappings.length <= MAX_MAPPINGS, 'Provide step mappings');
  const result = structuredClone(steps);
  const seen = new Set();
  for (const mapping of mappings) {
    const validIndex =
      mapping && Number.isInteger(mapping.stepIndex) && mapping.stepIndex >= 0 && mapping.stepIndex < steps.length;
    assert(validIndex, 'Recorded step not found');
    assert(!seen.has(mapping.stepIndex), 'Duplicate recorded step mapping');
    seen.add(mapping.stepIndex);
    result[mapping.stepIndex] = mapStepToRequirement(result[mapping.stepIndex], requirements, mapping.qaRequirementId);
  }
  return result;
}

// Optional keys are emitted only when supplied, and the order here is the stored
// key order. Change detection compares serialized steps, so keep it stable.
function addOptionalStepFields(result, step) {
  if (step.timeoutMs !== undefined) {
    assert(isValidTimeout(step.timeoutMs), 'Step timeout must be 100–120000 ms');
    result.timeoutMs = step.timeoutMs;
  }
  if (step.waitAfter !== undefined) {
    assert(WAIT_AFTER_MODES.includes(step.waitAfter), 'Choose automatic waiting, redirect, or no wait');
    result.waitAfter = step.waitAfter;
  }
  if (step.waitForUrl) {
    assert(step.waitAfter === 'redirect', 'Expected destination requires Wait for redirect');
    result.waitForUrl = str(step.waitForUrl, 'Expected destination URL', MAX_LOCATOR_LENGTH, true);
  }
  if (step.elementName !== undefined) {
    result.elementName = str(step.elementName, 'Element name', MAX_NAME_LENGTH);
  }
  if (step.pageUrl !== undefined) {
    result.pageUrl = str(step.pageUrl, 'Element page URL', MAX_LOCATOR_LENGTH);
  }
  if (step.container !== undefined) {
    result.container = str(step.container, 'Container selector', MAX_LOCATOR_LENGTH);
  }
  if (step.frame) {
    result.frame = str(step.frame, 'Frame selector', MAX_LOCATOR_LENGTH);
  }
  if (step.framePath) {
    result.framePath = framePathOf(step.framePath);
  }
  if (step.pageIndex !== undefined) {
    assert(isValidPageIndex(step.pageIndex), 'Invalid browser tab');
    result.pageIndex = step.pageIndex;
  }
  if (step.recordedName !== undefined) {
    result.recordedName = str(step.recordedName, 'Recorded action name', MAX_RECORDED_NAME_LENGTH);
  }
  if (step.qaRequirementId !== undefined) {
    assert(
      typeof step.qaRequirementId === 'string' && /^[\w-]{1,80}$/.test(step.qaRequirementId),
      'Invalid QA requirement reference',
    );
    result.qaRequirementId = step.qaRequirementId;
    if (step.unmappedName !== undefined) {
      result.unmappedName = str(step.unmappedName, 'Original step name', MAX_VALUE_LENGTH);
    }
  }
  if (step.captureScreenshot !== undefined) {
    assert(
      typeof step.captureScreenshot === 'string' && /^capture-[\w-]+\.png$/.test(step.captureScreenshot),
      'Invalid capture screenshot',
    );
    result.captureScreenshot = step.captureScreenshot;
  }
  if (step.sensitive) {
    result.sensitive = true;
  }
  if (step.selectValues !== undefined) {
    result.selectValues = list(step.selectValues, 'Selected values').map((option) =>
      str(option, 'Option', MAX_VALUE_LENGTH),
    );
  }
  if (step.expectedRows !== undefined) {
    result.expectedRows = list(step.expectedRows, 'Expected rows', MAX_EXPECTED_ROWS).map((row) =>
      list(row, 'Expected columns', MAX_EXPECTED_COLUMNS).map((cell) =>
        str(cell, 'Expected cell', MAX_EXPECTED_CELL_LENGTH),
      ),
    );
  }
}

export function normalizeSteps(value) {
  return list(value, 'Steps', MAX_STEPS).map((step, index) => {
    assert(step && actions.includes(step.action), `Step ${index + 1}: unsupported action`);
    const locatorType = step.locatorType || 'custom';
    const valueMode = step.valueMode === 'variable' ? 'environment' : step.valueMode || 'static';
    assert(locatorTypes.includes(locatorType), 'Unsupported locator type');
    assert(VALUE_MODES.includes(valueMode), 'Unsupported value source');
    const result = {
      name: str(step.name || `Step ${index + 1}`, 'Step name', MAX_VALUE_LENGTH),
      action: step.action,
      locatorType,
      target: str(step.target, 'Target', MAX_LOCATOR_LENGTH),
      replacement: str(step.replacement, 'Replacement', MAX_LOCATOR_LENGTH),
      value: str(step.value, 'Value', MAX_VALUE_LENGTH),
      valueMode,
    };
    addOptionalStepFields(result, step);
    return result;
  });
}

export function normalizeProfile(profile) {
  assert(profile && typeof profile === 'object', 'Database profile required');
  const port = Number(profile.port || DEFAULT_DATABASE_PORT);
  assert(Number.isInteger(port) && port > 0 && port <= MAX_PORT, 'Invalid database port');
  assert(SSL_MODES.includes(profile.sslmode || 'disable'), 'Invalid SSL mode');
  return {
    id: identifier(profile.id),
    name: str(profile.name || 'PostgreSQL', 'Profile name', MAX_NAME_LENGTH, true),
    host: str(profile.host || 'localhost', 'Host', MAX_HOST_LENGTH, true),
    port,
    database: str(profile.database, 'Database', MAX_NAME_LENGTH, true),
    username: str(profile.username, 'Username', MAX_NAME_LENGTH, true),
    password: str(profile.password, 'Password', MAX_PASSWORD_LENGTH),
    sslmode: profile.sslmode || 'disable',
  };
}

function normalizeCollection(input, key, extra = () => ({})) {
  const ids = new Set();
  const names = new Set();
  return list(input[key], key).map((item) => {
    const id = identifier(item.id);
    const name = str(item.name, `${key} name`, MAX_NAME_LENGTH, true).trim();
    // Folder names only need to be unique within their parent.
    const nameKey =
      key === 'folders' ? JSON.stringify([item.parentId || null, name.toLowerCase()]) : name.toLowerCase();
    assert(!ids.has(id) && !names.has(nameKey), `Duplicate ${key} ID or name`);
    ids.add(id);
    names.add(nameKey);
    return { id, name, ...extra(item) };
  });
}

function assertFolderTree(folders) {
  const foldersById = new Map(folders.map((folder) => [folder.id, folder]));
  for (const folder of folders) {
    assert(
      folder.parentId === null || (typeof folder.parentId === 'string' && foldersById.has(folder.parentId)),
      'Unknown parent folder',
    );
    const visited = new Set([folder.id]);
    let parent = folder.parentId;
    while (parent) {
      assert(!visited.has(parent), 'Folders cannot contain themselves or form a cycle');
      visited.add(parent);
      parent = foldersById.get(parent)?.parentId;
    }
  }
}

function normalizeLocatorTemplates(input, previous) {
  const ids = new Set();
  const templates = input.locatorTemplates ?? previous?.locatorTemplates;
  return list(templates, 'Locator templates', MAX_LOCATOR_TEMPLATES).map((template) => {
    const id = identifier(template.id);
    assert(!ids.has(id), 'Duplicate locator template ID');
    ids.add(id);
    assert(REPOSITORY_LOCATOR_TYPES.includes(template.locatorType), 'Repository locators must be CSS or XPath');
    const old = previous?.locatorTemplates?.find((item) => item.id === id);
    const unchanged =
      !old ||
      (old.locatorType === template.locatorType &&
        repository.normalizedTemplate(old.selector, old.locatorType) ===
          repository.normalizedTemplate(template.selector, template.locatorType));
    assert(unchanged, 'Shared locator definitions are immutable; save a new template for the owning test case');
    return {
      id,
      locatorType: template.locatorType,
      selector: str(template.selector, 'Locator template', MAX_LOCATOR_LENGTH, true).replaceAll('{{value}}', 'XXX'),
    };
  });
}

function objectContext(object) {
  const context = object.testCaseId
    ? { testCaseId: str(object.testCaseId, 'Owning test case ID', MAX_OWNER_ID_LENGTH, true) }
    : {};
  if (object.pageUrl !== undefined) {
    context.pageUrl = str(object.pageUrl, 'Element page URL', MAX_LOCATOR_LENGTH);
  }
  if (object.container !== undefined) {
    context.container = str(object.container, 'Container selector', MAX_LOCATOR_LENGTH);
  }
  if (object.frame !== undefined) {
    context.frame = str(object.frame, 'Frame selector', MAX_LOCATOR_LENGTH);
  }
  if (object.framePath !== undefined) {
    context.framePath = framePathOf(object.framePath);
  }
  if (object.pageIndex !== undefined) {
    assert(isValidPageIndex(object.pageIndex), 'Invalid browser tab');
    context.pageIndex = object.pageIndex;
  }
  return context;
}

function concreteObjectLocator(object, locatorType) {
  if (locatorType === 'css') {
    return { selector: str(object.selector, 'CSS selector', MAX_LOCATOR_LENGTH, true), xpath: '' };
  }
  return { xpath: str(object.xpath, 'XPath', MAX_LOCATOR_LENGTH, true).replaceAll('{{value}}', 'XXX') };
}

function normalizeObjects(input, previous, locatorTemplates) {
  const ids = new Set();
  return list(input.objects, 'objects', MAX_OBJECTS).map((object) => {
    const id = identifier(object.id);
    assert(!ids.has(id), 'Duplicate objects ID');
    ids.add(id);
    const oldOwner = previous?.objects?.find((item) => item.id === id)?.testCaseId;
    assert(!oldOwner || object.testCaseId === oldOwner, 'Cannot move an object mapping to another test case');

    const name = str(object.name || 'Repository object', 'Object name', MAX_NAME_LENGTH, true).trim();
    const locatorType = object.locatorType || 'xpath';
    assert(REPOSITORY_LOCATOR_TYPES.includes(locatorType), 'Repository locators must be CSS or XPath');
    const context = objectContext(object);
    const replacement = str(object.replacement, 'Replacement', MAX_LOCATOR_LENGTH);

    if (object.templateId) {
      const template = locatorTemplates.find((item) => item.id === object.templateId);
      assert(template, 'Repository locator template not found');
      assert(template.locatorType === locatorType, 'Repository object and template locator types must match');
      return { id, name, locatorType, templateId: object.templateId, replacement, ...context };
    }
    return {
      id,
      name,
      locatorType,
      ...concreteObjectLocator(object, locatorType),
      ...(object.replacement !== undefined ? { replacement } : {}),
      ...context,
    };
  });
}

function normalizeLegacyObjects(input, previous) {
  const entries = input.repositoryLegacyObjects ?? previous?.repositoryLegacyObjects;
  return list(entries, 'Unassigned legacy objects', MAX_LEGACY_OBJECTS).map((entry) => {
    assert(entry?.object && typeof entry.object === 'object', 'Invalid legacy repository record');
    // Quarantined records are opaque recovery data, never executable mappings.
    assert(JSON.stringify(entry.object).length <= MAX_LEGACY_OBJECT_SIZE, 'Legacy repository record is too large');
    return {
      object: structuredClone(entry.object),
      reason: str(entry.reason, 'Migration report', MAX_LEGACY_REASON_LENGTH, true),
    };
  });
}

function automationMapping(test, old) {
  const mapping = test.automation === undefined ? old?.automation : test.automation;
  if (mapping !== null && mapping !== undefined) {
    assert(typeof mapping === 'object' && typeof mapping.id === 'string', 'Invalid automation mapping');
    identifier(mapping.id);
    assert(Number.isInteger(mapping.tcNumber) && mapping.tcNumber > 0, 'Invalid automation test number');
  }
  return mapping;
}

function requirementFingerprint(qa) {
  return JSON.stringify([
    qa?.description || '',
    qa?.preconditions || '',
    qa?.expectedResult || '',
    qa?.manualSteps || [],
  ]);
}

function needsAutomationUpdate(test, old, qa, steps) {
  const requirementsChanged = old && requirementFingerprint(qa) !== requirementFingerprint(old.qa);
  const stepsChanged = old && JSON.stringify(steps) !== JSON.stringify(old.steps);
  const staleBefore = old?.automationNeedsUpdate ?? test.automationNeedsUpdate === true;
  return Boolean(steps.length && (requirementsChanged || (staleBefore && !stepsChanged)));
}

function normalizePlans(input, previous, tests) {
  const ids = new Set();
  const testExists = (id) => tests.some((test) => test.id === id);
  const plans = input.testPlans ?? previous?.testPlans;
  return list(plans, 'Test plans', MAX_TEST_PLANS).map((plan) => {
    assert(plan && typeof plan === 'object', 'Invalid test plan');
    const id = identifier(plan.id);
    assert(!ids.has(id), 'Duplicate test plan ID');
    ids.add(id);
    const old = previous?.testPlans?.find((item) => item.id === id);
    const testIds = [...new Set(list(plan.testIds, 'Plan test cases'))];
    assert(testIds.length || old, 'Select at least one test case for the plan');
    assert(
      testIds.every((value) => typeof value === 'string'),
      'Invalid plan case ID',
    );
    // Deleting a case also removes its reference from previously saved plans.
    assert(
      testIds.every((value) => testExists(value) || old?.testIds.includes(value)),
      'Choose existing test cases for the plan',
    );
    const status = plan.status || 'open';
    assert(PLAN_STATUSES.includes(status), 'Invalid test plan status');
    return {
      id,
      name: str(plan.name, 'Test plan name', MAX_NAME_LENGTH, true).trim(),
      testIds: testIds.filter(testExists),
      createdAt: old?.createdAt || new Date().toISOString(),
      createdBy: old?.createdBy || str(plan.createdBy, 'Created by', MAX_NAME_LENGTH),
      assignedTo: str(plan.assignedTo, 'Assignee', MAX_NAME_LENGTH),
      release: str(plan.release, 'Release', MAX_NAME_LENGTH),
      status,
      type: 'Specific',
    };
  });
}

export function normalizeProject(input, previous, store) {
  assert(input && typeof input === 'object', 'Project required');
  const project = {
    id: previous?.id || identifier(input.id),
    name: str(input.name, 'Project name', MAX_NAME_LENGTH, true).trim(),
  };
  project.agentOptions = agentOptions(input.agentOptions, previous?.agentOptions);
  project.revision = (previous?.revision || 0) + 1;

  project.timeoutMs = input.timeoutMs ?? previous?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  assert(isValidTimeout(project.timeoutMs), 'Project timeout must be 100–120000 ms');
  project.browser = input.browser ?? previous?.browser ?? 'chrome';
  assert(BROWSERS.includes(project.browser), 'Choose Chrome, Firefox, or Edge');

  project.folders = normalizeCollection(input, 'folders', (folder) => ({ parentId: folder.parentId || null }));
  assertFolderTree(project.folders);
  project.suites = normalizeCollection(input, 'suites');
  project.prerequisites = normalizeCollection(input, 'prerequisites', (prerequisite) => ({
    steps: normalizeSteps(prerequisite.steps),
    qa: normalizeQa(
      prerequisite.qa,
      previous?.prerequisites?.find((item) => item.id === prerequisite.id)?.qa,
      Boolean(prerequisite.steps?.length),
    ),
  }));

  // Process automation flows belong to Automation Studio only. A save without them keeps the stored ones.
  project.processes = normalizeCollection(
    { processes: input.processes ?? previous?.processes ?? [] },
    'processes',
    (flow) => {
      // Only process steps carry the Repeat choice.
      const steps = normalizeSteps(flow.steps).map((step, index) =>
        flow.steps[index]?.repeat === true ? { ...step, repeat: true } : step,
      );
      return { steps, runCount: processRunCount(flow.runCount ?? 1) };
    },
  );

  project.locatorTemplates = normalizeLocatorTemplates(input, previous);
  project.objects = normalizeObjects(input, previous, project.locatorTemplates);
  project.repositoryLegacyObjects = normalizeLegacyObjects(input, previous);

  project.environments = normalizeCollection(input, 'environments', (environment) => ({
    variables: variables(environment.variables),
  }));
  project.globalVariables = variables(input.globalVariables);
  project.jdbcProfiles = normalizeCollection(input, 'jdbcProfiles', normalizeProfile);

  const reference = (value, key) => {
    if (!value) {
      return null;
    }
    assert(
      project[key].some((item) => item.id === value),
      `Unknown ${key} reference`,
    );
    return value;
  };
  project.activeEnvironmentId = reference(input.activeEnvironmentId, 'environments');
  project.activeJdbcProfileId = reference(input.activeJdbcProfileId, 'jdbcProfiles');

  // The counter is committed only after everything validates, so a rejected save uses no numbers.
  let nextTestNumber = store.nextTestNumber || 1;
  const testIds = new Set();
  project.tests = list(input.tests, 'Tests', MAX_TESTS).map((test) => {
    const id = identifier(test.id);
    assert(!testIds.has(id), 'Duplicate test ID');
    testIds.add(id);
    const old = previous?.tests.find((item) => item.id === id);
    const inTestPlan = test.inTestPlan === undefined ? (old?.inTestPlan ?? false) : test.inTestPlan;
    assert(typeof inTestPlan === 'boolean', 'Test plan membership must be true or false');
    const mapping = automationMapping(test, old);
    const qa = normalizeQa(test.qa, old?.qa, Boolean(test.steps?.length));
    const steps = normalizeSteps(mapping === null ? [] : test.steps);
    const automationFields =
      mapping === undefined
        ? {}
        : { automation: mapping === null ? null : { id: mapping.id, tcNumber: mapping.tcNumber } };
    const tcNumber = old?.tcNumber || nextTestNumber++;
    return {
      inTestPlan,
      automationNeedsUpdate: needsAutomationUpdate(test, old, qa, steps),
      ...automationFields,
      id,
      qa,
      tcNumber,
      name: str(test.name, 'Test name', MAX_NAME_LENGTH, true),
      folderId: reference(test.folderId, 'folders'),
      suiteId: reference(test.suiteId, 'suites'),
      additionalSuiteIds: [
        ...new Set(list(test.additionalSuiteIds, 'Additional suites').map((suiteId) => reference(suiteId, 'suites'))),
      ].filter(Boolean),
      localTestData: normalizeLocalData(test.localTestData),
      dataRows: list(test.dataRows, 'Data rows').map((row) => variables(row)),
      prerequisiteId: reference(test.prerequisiteId, 'prerequisites'),
      steps,
    };
  });

  project.requirements = normalizeRequirements(
    input.requirements ?? previous?.requirements,
    previous?.requirements,
    project.tests,
  );
  project.testPlans = normalizePlans(input, previous, project.tests);

  for (const test of project.tests) {
    if (project.testPlans.some((plan) => plan.testIds.includes(test.id))) {
      test.inTestPlan = true;
    }
  }
  // Keep mapped names aligned when QA Studio instructions are edited.
  for (const owner of [...project.tests, ...project.prerequisites]) {
    owner.steps = owner.steps.map((step) => {
      if (!step.qaRequirementId) {
        return step;
      }
      const requirement = owner.qa.manualSteps.find((item) => item.id === step.qaRequirementId);
      return mapStepToRequirement(step, owner.qa.manualSteps, requirement?.id || null);
    });
  }

  migrateRepository(project);
  for (const owner of [...project.tests, ...project.prerequisites, ...project.processes]) {
    for (const step of owner.steps) {
      if (step.locatorType === 'object') {
        reference(step.target, 'objects');
      }
    }
  }
  store.nextTestNumber = nextTestNumber;
  return project;
}

function runStepSnapshot(step, project) {
  const objectContextFields =
    step.locatorType === 'object'
      ? repository.contextFor(step, project.objects.find((object) => object.id === step.target) || {})
      : {};
  return { ...objectContextFields, ...step, status: 'pending' };
}

function runTestSnapshot(test, dataRow, rowIndex, project) {
  const prerequisite = project.prerequisites.find((item) => item.id === test.prerequisiteId);
  if (prerequisite) {
    assert(prerequisite.steps.length, 'Linked prerequisite has no steps');
  }
  const prerequisiteSteps = (prerequisite?.steps || []).map((step) => ({
    ...structuredClone(step),
    name: `${prerequisite.name} / ${step.name}`,
    phase: 'prerequisite',
    prerequisiteId: prerequisite.id,
  }));
  const rowNumber = rowIndex + 1;
  const rowFields = dataRow
    ? {
        id: `${test.id}-row-${rowNumber}`,
        sourceTestId: test.id,
        name: `${test.name} [row ${rowNumber}]`,
        dataRow: structuredClone(dataRow),
      }
    : {};
  return {
    ...structuredClone(test),
    ...rowFields,
    status: 'pending',
    steps: [...prerequisiteSteps, ...structuredClone(test.steps)].map((step) => runStepSnapshot(step, project)),
  };
}

export function processRunCount(value) {
  assert(
    Number.isInteger(value) && value >= 1 && value <= MAX_PROCESS_RUNS,
    `Run count must be a whole number from 1 to ${MAX_PROCESS_RUNS}`,
  );
  return value;
}

// The steps marked Repeat, which must sit next to each other. Null when no step is marked.
export function repeatedBlock(steps) {
  const marked = steps.flatMap((step, index) => (step.repeat ? [index] : []));
  if (!marked.length) return null;
  const first = marked[0];
  const last = marked.at(-1);
  assert(
    last - first + 1 === marked.length,
    `Steps marked Repeat must be next to each other. Steps ${first + 1}–${last + 1} include unmarked steps; mark them too or move them outside the block.`,
  );
  return { first, last };
}

// With Repeat steps, the steps before them run once, the marked steps run count times and the
// steps after them run once, all in one browser session. Without them, the whole process runs
// count times, each in a fresh session and listed separately in history and reports.
function processSnapshots(project, processId, runCount) {
  const flow = project.processes.find((item) => item.id === processId);
  assert(flow, 'Process not found');
  const count = processRunCount(runCount ?? flow.runCount);
  const block = repeatedBlock(flow.steps);
  if (block) {
    const body = flow.steps.slice(block.first, block.last + 1);
    assert(
      flow.steps.length - body.length + body.length * count <= MAX_EXPANDED_PROCESS_STEPS,
      `This process would run more than ${MAX_EXPANDED_PROCESS_STEPS} steps. Lower the number of runs or repeat fewer steps.`,
    );
    const repeated = Array.from({ length: count }, (_, index) =>
      body.map((step) => ({ ...structuredClone(step), name: `[run ${index + 1} of ${count}] ${step.name}`, iteration: index + 1 })),
    ).flat();
    const range = block.first === block.last ? `step ${block.first + 1}` : `steps ${block.first + 1}–${block.last + 1}`;
    return [
      {
        id: `${flow.id}-repeat`,
        sourceTestId: flow.id,
        processId: flow.id,
        name: `${flow.name} [${range} × ${count}]`,
        status: 'pending',
        steps: [
          ...structuredClone(flow.steps.slice(0, block.first)),
          ...repeated,
          ...structuredClone(flow.steps.slice(block.last + 1)),
        ].map((step) => runStepSnapshot(step, project)),
      },
    ];
  }
  return Array.from({ length: count }, (_, index) => ({
    id: `${flow.id}-run-${index + 1}`,
    sourceTestId: flow.id,
    processId: flow.id,
    iteration: index + 1,
    name: `${flow.name} [run ${index + 1} of ${count}]`,
    status: 'pending',
    steps: structuredClone(flow.steps).map((step) => runStepSnapshot(step, project)),
  }));
}

export function prepareRun(project, { testId, testIds, suiteId, planId, processId, runCount } = {}) {
  const snapshots = processId
    ? processSnapshots(project, processId, runCount)
    : selectPlannedTests(project, { testId, testIds, suiteId, planId }, { requirePlan: false }).flatMap((test) => {
        const rows = test.dataRows?.length ? test.dataRows : [null];
        return rows.map((dataRow, rowIndex) => runTestSnapshot(test, dataRow, rowIndex, project));
      });
  const activeEnvironment = project.environments.find((item) => item.id === project.activeEnvironmentId);
  const activeProfile = project.jdbcProfiles.find((item) => item.id === project.activeJdbcProfileId);
  return {
    id: uuid(),
    projectId: project.id,
    projectName: project.name,
    ...(planId ? { planId, name: project.testPlans.find((plan) => plan.id === planId).name } : {}),
    suiteId: suiteId || null,
    suiteName: project.suites.find((suite) => suite.id === suiteId)?.name || null,
    timeoutMs: project.timeoutMs || DEFAULT_TIMEOUT_MS,
    browser: project.browser || 'chrome',
    startedAt: new Date().toISOString(),
    status: 'running',
    tests: snapshots,
    context: {
      profiles: structuredClone(project.jdbcProfiles),
      objects: structuredClone(project.objects),
      locatorTemplates: structuredClone(project.locatorTemplates || []),
      globals: structuredClone(project.globalVariables),
      environment: structuredClone(activeEnvironment?.variables || {}),
      profile: structuredClone(activeProfile || null),
    },
  };
}

function valuesForMode(valueMode, context) {
  switch (valueMode) {
    case 'local':
      return context.local;
    case 'data':
      return context.data;
    case 'global':
      return context.globals;
    default:
      return context.environment;
  }
}

export function resolveValue(step, context) {
  if (step.valueMode === 'static' || !step.valueMode) {
    return step.value;
  }
  const values = valuesForMode(step.valueMode, context) || {};
  assert(Object.hasOwn(values, step.value), `Variable not found: ${step.value}`);
  return values[step.value];
}

export function resolveTarget(step, objects, templates = []) {
  return resolveLocator(step, objects, templates).target;
}

export function sampleProject(port) {
  return {
    name: 'Getting started',
    browser: 'chrome',
    folders: [{ id: 'examples', name: 'Example tests' }],
    suites: [{ id: 'smoke', name: 'Smoke suite' }],
    environments: [
      {
        id: 'local',
        name: 'Local',
        variables: { BASE_URL: `http://127.0.0.1:${port}/demo` },
      },
    ],
    activeEnvironmentId: 'local',
    tests: [
      {
        id: 'welcome',
        name: 'Complete the welcome form',
        folderId: 'examples',
        suiteId: 'smoke',
        steps: [
          {
            name: 'Open the demo application',
            action: 'navigate',
            value: 'BASE_URL',
            valueMode: 'environment',
          },
          {
            name: 'Enter your name',
            action: 'fill',
            locatorType: 'label',
            target: 'Your name',
            value: 'Alex',
          },
          {
            name: 'Submit the form',
            action: 'click',
            locatorType: 'text',
            target: 'Get started',
          },
          {
            name: 'Check the welcome message',
            action: 'text',
            locatorType: 'id',
            target: 'message',
            value: 'Welcome, Alex!',
          },
        ],
      },
    ],
  };
}
