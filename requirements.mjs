import { createHash, randomUUID } from 'node:crypto';
import { agentOptions } from './agent-workflow.mjs';
import { normalizeQa } from './qa-model.mjs';
import { categories, metadataNormalizationNotes, prepareGenerationInput } from './test-case-generator.mjs';

const MAX_REQUIREMENTS = 500;
const MAX_TITLE_LENGTH = 160;
const MAX_URL_LENGTH = 2000;
const MAX_LONG_TEXT = 10000;
const MAX_DRAFTS = 1000;
const MAX_DRAFT_TITLE_LENGTH = 120;
const MAX_LINKED_TESTS = 1000;
const MAX_GENERATION_PAGES = 6;
const MAX_GENERATION_WARNINGS = 30;
const MAX_NOTE_LENGTH = 2000;
const MAX_PAGE_TITLE_LENGTH = 180;
const MAX_PAGE_LINKS = 30;
const MAX_LINK_NAME_LENGTH = 160;
const MAX_AGENT_TRACE = 40;
const MAX_AGENT_STAGE_LENGTH = 40;
const MAX_AGENT_DETAIL_LENGTH = 500;
const MAX_COVERAGE_ITEMS = 12;
const MAX_CRITERION_ID_LENGTH = 30;
const MAX_CRITERION_TEXT_LENGTH = 500;
const MAX_CRITERION_SOURCE_LENGTH = 30;
const MAX_MAPPED_CASES = 100;
const MAX_MODEL_CASES = 100;
const MAX_MODEL_STEPS = 50;
const MAX_MODEL_WARNINGS = 20;
const MAX_MODEL_TEST_DATA = 100;
const MAX_MODEL_ASSUMPTIONS = 20;
const MAX_TEST_DATA_FIELD_LENGTH = 160;
const MAX_TEST_DATA_VALUE_LENGTH = 2000;
const MAX_REFERENCE_LENGTH = 500;

const ID_PATTERN = /^[\w-]{1,80}$/;
const GENERATION_MODES = ['rules', 'ai', 'agent', 'qwen', 'claude', 'chatgpt'];
const PRIORITIES = ['critical', 'high', 'medium', 'low'];
const COVERAGE_STATUSES = ['covered', 'partial', 'uncovered'];
const DRAFT_PLACEMENT_KEYS = ['folderId', 'suiteId', 'prerequisiteId'];
const NON_FUNCTIONAL_CATEGORIES = ['Security', 'Performance'];

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function boundedText(value, label, max, required = false) {
  const valid = typeof value === 'string' && value.length <= max && (!required || value.trim());
  check(valid, `${label} must contain ${required ? '1–' : 'up to '}${max} characters.`);
  return value.trim();
}

const isValidId = (value) => typeof value === 'string' && ID_PATTERN.test(value);
const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export function requirementUrl(value) {
  const input = boundedText(value, 'Requirement URL', MAX_URL_LENGTH, true);
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error('Enter a full HTTP or HTTPS URL.');
  }
  const allowed = ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  check(allowed, 'Use an HTTP or HTTPS URL without embedded credentials.');
  return url.href;
}

function generationCandidate(input, requirement) {
  const candidate = { requirement };
  if (input.moduleName !== undefined && input.moduleName !== '') candidate.moduleName = input.moduleName;
  if (input.pageMetadata !== undefined) candidate.pageMetadata = input.pageMetadata;
  if (input.categories !== undefined) candidate.categories = input.categories;
  return candidate;
}

export function requirementFields(input) {
  check(isPlainObject(input), 'Requirement details are required.');
  const title = boundedText(input.title, 'Requirement title', MAX_TITLE_LENGTH, true);
  const description = boundedText(input.description ?? '', 'Description', MAX_LONG_TEXT);

  const prepared = prepareGenerationInput(generationCandidate(input, description || title));
  const generated = prepared.input;
  const savedNotes = Array.isArray(input.metadataWarnings)
    ? input.metadataWarnings.filter((note) => metadataNormalizationNotes.includes(note))
    : [];

  const generationMode = input.generationMode ?? 'rules';
  const inspectBeforeGeneration = input.inspectBeforeGeneration ?? false;
  check(GENERATION_MODES.includes(generationMode), 'Choose local rules, Qwen, AI, the local AI agent, Claude or ChatGPT.');
  check(typeof inspectBeforeGeneration === 'boolean', 'Inspect URL must be true or false.');

  return {
    agentOptions: agentOptions(input.agentOptions),
    title,
    url: requirementUrl(input.url),
    description,
    moduleName: generated.moduleName || '',
    pageMetadata: generated.pageMetadata || {},
    metadataWarnings: [...new Set([...prepared.warnings, ...savedNotes])],
    ...(generated.categories ? { categories: generated.categories } : {}),
    generationMode,
    inspectBeforeGeneration,
  };
}

export function requirementFingerprint(item) {
  const fields = [
    item.title,
    item.url,
    item.description,
    item.moduleName || '',
    item.pageMetadata || {},
    item.categories || null,
    item.generationMode || 'rules',
    item.inspectBeforeGeneration || false,
  ];
  // Default options stay out of the hash so requirements saved before agent options keep their fingerprint.
  const options = agentOptions(item.agentOptions);
  if (options.enabled || options.guidance || options.model || options.mode || options.repairLimit !== 1) {
    fields.push(options);
  }
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}

function draftPlacement(item) {
  const placement = {};
  for (const key of DRAFT_PLACEMENT_KEYS) {
    const value = item[key] ?? null;
    check(value === null || isValidId(value), 'Choose a valid folder, suite or precondition for this draft.');
    placement[key] = value;
  }
  return placement;
}

export function normalizeRequirementDrafts(input = [], previous = [], reservedIds = new Set()) {
  check(
    Array.isArray(input) && input.length <= MAX_DRAFTS,
    'A requirement can hold up to 1,000 drafts. Approve or remove drafts before generating more.',
  );
  const seen = new Set();
  return input.map((item) => {
    check(isPlainObject(item), 'A draft could not be read. Reload the requirement and try again.');
    const id = item.id || randomUUID();
    check(
      isValidId(id) && !seen.has(id) && !reservedIds.has(id),
      'Draft IDs must be unique and separate from approved test cases.',
    );
    seen.add(id);

    const earlier = previous.find((draft) => draft.id === id);
    const name = boundedText(item.name, 'Draft title', MAX_DRAFT_TITLE_LENGTH, true);
    const qa = normalizeQa(item.qa, earlier?.qa, false);
    check(qa.manualSteps.length > 0, 'Add at least one step before saving or approving this draft.');

    return { id, name, steps: [], ...draftPlacement(item), qa };
  });
}

export function identifyRequirementCase(item) {
  if (item.qa?.generationId) return item;
  const digest = createHash('sha256')
    .update(`requirement-ai:${item.name.trim().toLowerCase()}`)
    .digest('hex');
  return { ...item, qa: { ...item.qa, generationId: `TCG-${digest.slice(0, 24)}` } };
}

function normalizeGenerationPage(page) {
  const links = Array.isArray(page.links) ? page.links : [];
  return {
    url: requirementUrl(page.url),
    title: boundedText(page.title || '', 'Page title', MAX_PAGE_TITLE_LENGTH),
    status: Number(page.status) || 0,
    controlCount: Math.max(0, Number(page.controlCount) || 0),
    links: links.slice(0, MAX_PAGE_LINKS).map((link) => ({
      name: boundedText(link.name, 'Navigation label', MAX_LINK_NAME_LENGTH, true),
      url: requirementUrl(link.url),
    })),
  };
}

function normalizeCoverageItem(item) {
  return {
    id: boundedText(item.id, 'Criterion', MAX_CRITERION_ID_LENGTH, true),
    text: boundedText(item.text, 'Criterion text', MAX_CRITERION_TEXT_LENGTH, true),
    source: boundedText(item.source || 'explicit', 'Criterion source', MAX_CRITERION_SOURCE_LENGTH),
    status: COVERAGE_STATUSES.includes(item.status) ? item.status : 'uncovered',
    caseTitles: (item.caseTitles || [])
      .slice(0, MAX_MAPPED_CASES)
      .map((title) => boundedText(title, 'Mapped case', MAX_DRAFT_TITLE_LENGTH)),
  };
}

function normalizeGeneration(generation) {
  check(
    Array.isArray(generation.pages) &&
      generation.pages.length <= MAX_GENERATION_PAGES &&
      Array.isArray(generation.warnings) &&
      generation.warnings.length <= MAX_GENERATION_WARNINGS,
    'Invalid requirement inspection summary.',
  );
  const result = {
    at: boundedText(generation.at, 'Generation date', 80),
    fingerprint: boundedText(generation.fingerprint, 'Generation version', 64),
    summary: boundedText(generation.summary, 'Coverage summary', MAX_LONG_TEXT),
    warnings: generation.warnings.map((warning) => boundedText(warning, 'Coverage note', MAX_NOTE_LENGTH)),
    pages: generation.pages.map(normalizeGenerationPage),
  };
  if (Array.isArray(generation.agent)) {
    result.agent = generation.agent.slice(0, MAX_AGENT_TRACE).map((entry) => ({
      stage: boundedText(entry.stage, 'Agent stage', MAX_AGENT_STAGE_LENGTH),
      detail: boundedText(entry.detail, 'Agent detail', MAX_AGENT_DETAIL_LENGTH),
    }));
  }
  if (generation.coverage) {
    check(
      Array.isArray(generation.coverage) && generation.coverage.length <= MAX_COVERAGE_ITEMS,
      'Invalid coverage mapping',
    );
    result.coverage = generation.coverage.map(normalizeCoverageItem);
  }
  return result;
}

export function normalizeRequirements(input, previous = [], tests = []) {
  const requirements = input ?? [];
  check(Array.isArray(requirements) && requirements.length <= MAX_REQUIREMENTS, 'Maximum 500 requirements per project.');
  const seen = new Set();
  const testIds = new Set(tests.map((testCase) => testCase.id));
  const reservedDraftIds = new Set(testIds);

  return requirements.map((item) => {
    const fields = requirementFields(item);
    const id = item.id || randomUUID();
    check(isValidId(id) && !seen.has(id), 'Requirement IDs must be unique.');
    seen.add(id);

    const earlier = previous.find((requirement) => requirement.id === id);
    const linkedIds = item.testIds ?? earlier?.testIds ?? [];
    check(
      Array.isArray(linkedIds) &&
        linkedIds.length <= MAX_LINKED_TESTS &&
        linkedIds.every((linkedId) => typeof linkedId === 'string'),
      'Invalid requirement test case links.',
    );

    const draftCases = normalizeRequirementDrafts(
      item.draftCases ?? earlier?.draftCases ?? [],
      earlier?.draftCases,
      reservedDraftIds,
    );
    for (const draft of draftCases) reservedDraftIds.add(draft.id);

    const now = new Date().toISOString();
    const result = {
      id,
      ...fields,
      draftCases,
      testIds: [...new Set(linkedIds)].filter((linkedId) => testIds.has(linkedId)),
      createdAt: earlier?.createdAt || now,
      updatedAt: now,
    };
    const generation = item.generation ?? earlier?.generation;
    if (generation) result.generation = normalizeGeneration(generation);
    result.needsGeneration = !result.generation || result.generation.fingerprint !== requirementFingerprint(fields);
    return result;
  });
}

function validateOptionalLists(item) {
  if (item.category) check(categories.includes(item.category), 'Invalid case category');
  if (item.testData) {
    check(
      Array.isArray(item.testData) &&
        item.testData.length <= MAX_MODEL_TEST_DATA &&
        item.testData.every(
          (row) =>
            row &&
            typeof row.field === 'string' &&
            row.field.length <= MAX_TEST_DATA_FIELD_LENGTH &&
            typeof row.value === 'string' &&
            row.value.length <= MAX_TEST_DATA_VALUE_LENGTH,
        ),
      'Invalid test data',
    );
  }
  if (item.assumptions) {
    check(
      Array.isArray(item.assumptions) &&
        item.assumptions.length <= MAX_MODEL_ASSUMPTIONS &&
        item.assumptions.every((note) => typeof note === 'string' && note.length <= MAX_NOTE_LENGTH),
      'Invalid assumptions',
    );
  }
}

function draftManualStep(step) {
  check(step && typeof step === 'object', 'Generated step is invalid.');
  return {
    id: randomUUID(),
    instruction: boundedText(step.instruction, 'Step instruction', MAX_LONG_TEXT, true),
    expectedResult: boundedText(step.expectedResult, 'Step expected result', MAX_LONG_TEXT, true),
  };
}

function draftCase(item, index, usedNames) {
  const number = index + 1;
  check(isPlainObject(item), `Test case ${number} is invalid.`);
  const name = boundedText(item.title, `Test case ${number} title`, MAX_DRAFT_TITLE_LENGTH, true);
  const nameKey = name.toLowerCase();
  check(!usedNames.has(nameKey), 'The model returned duplicate case titles. Generate again.');
  usedNames.add(nameKey);
  check(
    Array.isArray(item.steps) && item.steps.length > 0 && item.steps.length <= MAX_MODEL_STEPS,
    `Test case ${number} must have 1–50 steps.`,
  );
  validateOptionalLists(item);

  return {
    id: randomUUID(),
    name,
    steps: [],
    qa: {
      category: item.category || 'Functional',
      testData: item.testData || [],
      assumptions: item.assumptions || [],
      requirementReference: boundedText(item.requirementReference || '', 'Requirement reference', MAX_REFERENCE_LENGTH),
      description: boundedText(item.description || '', 'Case description', MAX_LONG_TEXT),
      preconditions: boundedText(item.preconditions || '', 'Preconditions', MAX_LONG_TEXT),
      expectedResult: boundedText(item.expectedResult, 'Expected result', MAX_LONG_TEXT, true),
      priority: PRIORITIES.includes(item.priority) ? item.priority : 'medium',
      type: NON_FUNCTIONAL_CATEGORIES.includes(item.category) ? item.category.toLowerCase() : 'functional',
      executionMode: 'manual',
      manualSteps: item.steps.map(draftManualStep),
    },
  };
}

export function validateRequirementDraft(draft) {
  check(
    draft && Array.isArray(draft.cases) && draft.cases.length > 0 && draft.cases.length <= MAX_MODEL_CASES,
    'The model must return between 1 and 100 test cases. Try a more focused requirement.',
  );
  const usedNames = new Set();
  const warnings = Array.isArray(draft.warnings) ? draft.warnings : [];
  return {
    cases: draft.cases.map((item, index) => draftCase(item, index, usedNames)),
    summary: boundedText(draft.summary || '', 'Coverage summary', MAX_LONG_TEXT),
    warnings: warnings
      .slice(0, MAX_MODEL_WARNINGS)
      .map((warning) => boundedText(warning, 'Coverage note', MAX_NOTE_LENGTH)),
  };
}
