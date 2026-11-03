import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { generationInputUserMessage } from './requirement-errors.mjs';

export const categories = ['Positive', 'Negative', 'Functional', 'Validation', 'Boundary', 'Security', 'Performance'];

const MAX_REQUIREMENT_LENGTH = 10000;
const MAX_MODULE_LENGTH = 120;
const MAX_NAME_LENGTH = 160;
const MAX_TEXT_LENGTH = 1000000;
const MAX_NUMERIC_MAGNITUDE = 1e12;
const MAX_OPTIONS = 100;
const MAX_OPTION_LENGTH = 500;
const MAX_PATTERN_LENGTH = 500;
const MAX_METADATA_ENTRIES = 100;
const MAX_CONSTRAINT_LENGTH = 1000;
const MAX_METADATA_JSON_LENGTH = 120000;
const MAX_UNWRAP_PASSES = 4;
const MAX_CASES = 200;
const MAX_CASE_TEXT_LENGTH = 10000;
const MAX_TITLE_LENGTH = 120;
const MAX_CASE_STEPS = 50;
const MAX_CASE_PRECONDITIONS = 20;
const MAX_CASE_TEST_DATA = 100;
const MAX_CASE_ASSUMPTIONS = 20;
const MAX_ASSUMPTION_LENGTH = 2000;
const MAX_TEST_DATA_VALUE_LENGTH = 2000;
const MAX_ISSUES_REPORTED = 8;
const MAX_FUNCTIONAL_CLAUSES = 100;
const MAX_LISTED_NOTES = 20;
const MAX_WARNINGS = 30;
const MAX_LITERAL_LENGTH_VALUE = 32;
const NUMERIC_PRECISION = 14;
const ID_HASH_LENGTH = 24;

const DEFAULT_MODULE = 'General';
const BASE_PRECONDITION = 'Use an authorized test environment with suitable test data.';
const FIELD_TYPES = ['text', 'email', 'password', 'number', 'integer', 'url', 'date', 'select', 'checkbox', 'textarea', 'tel', 'file'];
const CONTROL_TYPES = ['button', 'submit', 'link', 'checkbox', 'tab', 'select'];
const PRIORITIES = ['critical', 'high', 'medium', 'low'];

const shortText = z.string().trim().min(1).max(MAX_NAME_LENGTH);

const constraintsSchema = z
  .object({
    required: z.boolean().optional(),
    minLength: z.number().int().min(0).max(MAX_TEXT_LENGTH).optional(),
    maxLength: z.number().int().min(0).max(MAX_TEXT_LENGTH).optional(),
    min: z.number().finite().min(-MAX_NUMERIC_MAGNITUDE).max(MAX_NUMERIC_MAGNITUDE).optional(),
    max: z.number().finite().min(-MAX_NUMERIC_MAGNITUDE).max(MAX_NUMERIC_MAGNITUDE).optional(),
    step: z.number().finite().positive().max(MAX_NUMERIC_MAGNITUDE).optional(),
    options: z.array(z.string().max(MAX_OPTION_LENGTH)).min(1).max(MAX_OPTIONS).optional(),
    pattern: z.string().min(1).max(MAX_PATTERN_LENGTH).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.minLength !== undefined && value.maxLength !== undefined && value.minLength > value.maxLength) {
      context.addIssue({ code: 'custom', message: 'minLength must not exceed maxLength.' });
    }
    if (value.min !== undefined && value.max !== undefined && value.min > value.max) {
      context.addIssue({ code: 'custom', message: 'min must not exceed max.' });
    }
  });

const METADATA_KEYS = ['fields', 'controls', 'constraints'];

export const metadataNormalizationNotes = [
  'Additional page annotations were ignored; only fields, controls, and constraints generate test scenarios.',
];

// Optional metadata may come from a saved form, a JSON editor or an MCP client.
// Normalize its representation before validating individual generation rules.
function metadataObject(input) {
  let value = input;
  for (let pass = 0; pass < MAX_UNWRAP_PASSES; pass += 1) {
    if (value === undefined) return undefined;
    const isBlankText = typeof value === 'string' && !value.trim();
    const isEmptyList = Array.isArray(value) && !value.length;
    if (value === null || isBlankText || isEmptyList) return {};
    if (typeof value === 'string') {
      if (value.length > MAX_METADATA_JSON_LENGTH) return value;
      try {
        value = JSON.parse(value);
      } catch {
        return value;
      }
      continue;
    }
    const isWrapper =
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.hasOwn(value, 'pageMetadata') &&
      !METADATA_KEYS.some((key) => Object.hasOwn(value, key));
    if (!isWrapper) return value;
    value = value.pageMetadata;
  }
  return value;
}

function nullableCollection(schema) {
  return z.preprocess((value) => (value === null ? undefined : value), schema.optional());
}

const pageMetadataSchema = z.preprocess(
  metadataObject,
  z
    .object({
      fields: nullableCollection(
        z
          .array(
            z
              .object({
                name: shortText,
                type: z.enum(FIELD_TYPES).optional(),
                constraints: constraintsSchema.optional(),
              })
              .strict(),
          )
          .max(MAX_METADATA_ENTRIES),
      ),
      controls: nullableCollection(
        z
          .array(
            z
              .object({
                name: shortText,
                type: z.enum(CONTROL_TYPES).optional(),
                disabled: z.boolean().optional(),
              })
              .strict(),
          )
          .max(MAX_METADATA_ENTRIES),
      ),
      constraints: nullableCollection(
        z.array(z.string().trim().min(1).max(MAX_CONSTRAINT_LENGTH)).max(MAX_METADATA_ENTRIES),
      ),
    })
    .passthrough()
    .optional(),
);

export const generationInputSchema = z
  .object({
    requirement: z.string().trim().min(1).max(MAX_REQUIREMENT_LENGTH),
    moduleName: z.string().trim().min(1).max(MAX_MODULE_LENGTH).optional(),
    pageMetadata: pageMetadataSchema,
    categories: z.array(z.enum(categories)).min(1).max(categories.length).optional(),
  })
  .strict();

const stepSchema = z
  .object({
    instruction: z.string().min(1).max(MAX_CASE_TEXT_LENGTH),
    expectedResult: z.string().min(1).max(MAX_CASE_TEXT_LENGTH),
  })
  .strict();

const testDataSchema = z
  .object({
    field: z.string().max(MAX_NAME_LENGTH),
    value: z.string().max(MAX_TEST_DATA_VALUE_LENGTH),
  })
  .strict();

export const generatedCaseSchema = z
  .object({
    id: z.string().regex(/^TCG-[a-f0-9]{24}$/),
    title: z.string().min(1).max(MAX_TITLE_LENGTH),
    module: z.string().min(1).max(MAX_MODULE_LENGTH),
    category: z.enum(categories),
    priority: z.enum(PRIORITIES),
    preconditions: z.array(z.string().max(MAX_CASE_TEXT_LENGTH)).max(MAX_CASE_PRECONDITIONS),
    steps: z.array(stepSchema).min(1).max(MAX_CASE_STEPS),
    testData: z.array(testDataSchema).max(MAX_CASE_TEST_DATA),
    expectedResult: z.string().min(1).max(MAX_CASE_TEXT_LENGTH),
    requirementReference: z.string().min(1).max(MAX_CASE_TEXT_LENGTH),
    assumptions: z.array(z.string().max(MAX_ASSUMPTION_LENGTH)).max(MAX_CASE_ASSUMPTIONS),
  })
  .strict();

export const generationOutputSchema = z
  .object({
    testCases: z.array(generatedCaseSchema).max(MAX_CASES),
    summary: z.string(),
    warnings: z.array(z.string()),
    coverage: z.object({ complete: z.literal(false), limitReached: z.boolean() }).strict(),
  })
  .strict();

function canonical(value) {
  return String(value).trim().replace(/\s+/g, ' ').replace(/[.!;]+$/, '').toLowerCase();
}

function shortHash(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, ID_HASH_LENGTH);
}

const unique = (values) => [...new Set(values)];

function sizeUnit(issue) {
  if (issue.type === 'string') return ' characters';
  if (issue.type === 'array') return ' entries';
  return '';
}

function expectedTypeText(expected) {
  if (expected === 'array') return 'an array';
  if (expected === 'object') return 'an object';
  if (expected === 'integer') return 'an integer';
  return `a ${expected}`;
}

function inputIssueDescription(issue) {
  if (issue.code === 'unrecognized_keys') {
    return 'contains unsupported properties; use the documented fields for this object';
  }
  if (issue.path.length === 1 && issue.path[0] === 'pageMetadata') {
    return 'must be a JSON object containing optional fields, controls, and constraints; leave it blank when unused';
  }
  if (issue.code === 'invalid_type') return `must be ${expectedTypeText(issue.expected)}`;
  if (issue.code === 'invalid_enum_value') return 'must use a supported category, field type, or control type';
  if (issue.code === 'too_big') return `must contain at most ${issue.maximum}${sizeUnit(issue)}`;
  if (issue.code === 'too_small') return `must contain at least ${issue.minimum}${sizeUnit(issue)}`;
  // Custom messages are written in this schema and never contain submitted values.
  if (issue.code === 'custom') return issue.message;
  return 'does not match the documented input format';
}

export function prepareGenerationInput(value) {
  const parsed = generationInputSchema.safeParse(value);
  if (!parsed.success) {
    // Report schema paths and actionable reasons, never input values or unknown keys.
    const issues = parsed.error.issues
      .slice(0, MAX_ISSUES_REPORTED)
      .map((issue) => `${issue.path.join('.') || 'request'} ${inputIssueDescription(issue)}`);
    throw Object.assign(new Error(`Invalid generation input: ${unique(issues).join('; ')}.`), {
      code: 'INVALID_GENERATION_INPUT',
      userMessage: generationInputUserMessage(parsed.error.issues),
    });
  }

  const input = parsed.data;
  const metadata = input.pageMetadata;
  const warnings = [];
  if (metadata) {
    if (Object.keys(metadata).some((key) => !METADATA_KEYS.includes(key))) {
      warnings.push(metadataNormalizationNotes[0]);
    }
    const kept = METADATA_KEYS.filter((key) => metadata[key] !== undefined);
    input.pageMetadata = Object.fromEntries(kept.map((key) => [key, metadata[key]]));
  }
  return { input, warnings };
}

export function validateGenerationInput(value) {
  return prepareGenerationInput(value).input;
}

const REQUIRED_CLAUSE = /^(?:the )?([\w -]{1,60}) (?:is|must be) required[.!]?$/i;
const LENGTH_RANGE_CLAUSE = /^(?:the )?([\w -]{1,60}) (?:must be|must have|must contain|has) (\d+) (?:to|through) (\d+) characters[.!]?$/i;
const LENGTH_LIMIT_CLAUSE = /^(?:the )?([\w -]{1,60}) (?:must be|must have|must contain|has) (at least|at most) (\d+) characters[.!]?$/i;
const NUMERIC_RANGE_CLAUSE = /^(?:the )?([\w -]{1,60}) must be between (-?\d+(?:\.\d+)?) and (-?\d+(?:\.\d+)?)[.!]?$/i;
const FORMAT_CLAUSE = /^(?:the )?([\w -]{1,60}) must be a valid (email address|URL)[.!]?$/i;

// Limited, explicit English patterns. Other prose remains a referenced manual scenario.
function extractFields(clauses) {
  const found = [];
  for (const clause of clauses) {
    const required = clause.match(REQUIRED_CLAUSE);
    if (required) {
      found.push({ name: required[1], constraints: { required: true }, source: clause });
    }
    const lengthRange = clause.match(LENGTH_RANGE_CLAUSE);
    if (lengthRange) {
      found.push({
        name: lengthRange[1],
        constraints: { minLength: Number(lengthRange[2]), maxLength: Number(lengthRange[3]) },
        source: clause,
      });
    }
    const lengthLimit = clause.match(LENGTH_LIMIT_CLAUSE);
    if (lengthLimit) {
      const key = lengthLimit[2].toLowerCase() === 'at least' ? 'minLength' : 'maxLength';
      found.push({ name: lengthLimit[1], constraints: { [key]: Number(lengthLimit[3]) }, source: clause });
    }
    const numericRange = clause.match(NUMERIC_RANGE_CLAUSE);
    if (numericRange) {
      found.push({
        name: numericRange[1],
        type: 'number',
        constraints: { min: Number(numericRange[2]), max: Number(numericRange[3]) },
        source: clause,
        assumptions: ['The unitless numeric range was interpreted as a number field. Confirm the unit and precision.'],
      });
    }
    const format = clause.match(FORMAT_CLAUSE);
    if (format) {
      found.push({ name: format[1], type: format[2].toLowerCase() === 'url' ? 'url' : 'email', source: clause });
    }
  }
  return found;
}

const SOURCE_NAMES = ['page field metadata', 'page constraints', 'requirement description'];
const FIELD_METADATA_RANK = 0;
const PAGE_CONSTRAINT_RANK = 1;
const DESCRIPTION_RANK = 2;
const CONSTRAINT_KEYS = ['required', 'minLength', 'maxLength', 'min', 'max', 'step', 'options', 'pattern'];
const RANGE_PAIRS = [
  ['min', 'max'],
  ['minLength', 'maxLength'],
];

function groupByCanonicalName(definitions) {
  const groups = new Map();
  for (const definition of definitions) {
    const key = canonical(definition.name);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(definition);
  }
  return [...groups.values()];
}

function propertyEntries(definitions, key) {
  const entries = [];
  for (const definition of definitions) {
    const value = key === 'type' ? definition.type : definition.constraints?.[key];
    if (value === undefined) continue;
    entries.push({ value: key === 'options' ? unique(value).sort() : value, rank: definition.rank });
  }
  return entries;
}

function distinctValues(entries) {
  const byJson = new Map(entries.map((entry) => [JSON.stringify(entry.value), entry.value]));
  return [...byJson.values()];
}

// Reconcile each property independently. Observed page attributes must not veto
// an explicit requirement. Ambiguous rules are disclosed, never guessed.
function reconcileField(definitions) {
  const highestRank = Math.max(...definitions.map((definition) => definition.rank));
  const name = definitions.filter((definition) => definition.rank === highestRank).at(-1).name;
  const constraints = {};
  const ranks = {};
  const decisions = [];
  const unresolved = new Set();

  const choose = (key) => {
    const entries = propertyEntries(definitions, key);
    if (!entries.length) return undefined;
    const rank = Math.max(...entries.map((entry) => entry.rank));
    const values = distinctValues(entries.filter((entry) => entry.rank === rank));
    ranks[key] = rank;

    if (key !== 'type' && values.some((value) => !constraintsSchema.safeParse({ [key]: value }).success)) {
      unresolved.add(key);
      decisions.push(`${key} is outside supported limits and needs review`);
      return undefined;
    }

    if (key === 'type') {
      // HTML text inputs and parsed numeric ranges can describe the same
      // field as a more specific supplied type (for example integer).
      const types = unique(entries.map((entry) => entry.value)).filter((type) => type !== 'text');
      if (types.length <= 1) return types[0] || 'text';
      if (types.every((type) => ['number', 'integer'].includes(type))) return 'integer';
    }

    let chosen = values[0];
    if (values.length > 1) {
      if (['min', 'minLength'].includes(key)) {
        chosen = Math.max(...values);
      } else if (['max', 'maxLength'].includes(key)) {
        chosen = Math.min(...values);
      } else {
        unresolved.add(key);
        decisions.push(`${key} has contradictory definitions in ${SOURCE_NAMES[rank]} and needs review`);
        return undefined;
      }
      decisions.push(`overlapping ${key} rules in ${SOURCE_NAMES[rank]} use the strictest supplied bound`);
    }
    const lowerRankDiffers = entries.some(
      (entry) => entry.rank < rank && JSON.stringify(entry.value) !== JSON.stringify(chosen),
    );
    if (lowerRankDiffers) decisions.push(`${key} follows ${SOURCE_NAMES[rank]} where lower-priority metadata differs`);
    return chosen;
  };

  const type = choose('type');
  for (const key of CONSTRAINT_KEYS) {
    const value = choose(key);
    if (value !== undefined) constraints[key] = value;
  }

  for (const [low, high] of RANGE_PAIRS) {
    if (constraints[low] === undefined || constraints[high] === undefined || constraints[low] <= constraints[high]) {
      continue;
    }
    if (ranks[low] !== ranks[high]) {
      const discarded = ranks[low] < ranks[high] ? low : high;
      const winningSource = SOURCE_NAMES[Math.max(ranks[low], ranks[high])];
      delete constraints[discarded];
      decisions.push(`${discarded} from lower-priority metadata was omitted because it contradicts the ${winningSource} range`);
    } else {
      delete constraints[low];
      delete constraints[high];
      unresolved.add(low);
      unresolved.add(high);
      decisions.push(`${low}/${high} have no compatible range in ${SOURCE_NAMES[ranks[low]]}; boundary outcomes need review`);
    }
  }

  const notes = decisions.length
    ? [`Constraint reconciliation for "${name}": ${decisions.join('; ')}. Confirm these decisions before execution.`]
    : [];
  const parsedAssumptions = definitions.flatMap((definition) => definition.assumptions || []);
  return {
    name,
    type,
    constraints,
    unresolved: [...unresolved],
    assumptions: unique([...parsedAssumptions, ...notes]),
    warnings: notes,
  };
}

function mergeFields(input, clauses) {
  const withRank = (definitions, rank) => definitions.map((definition) => ({ ...definition, rank }));
  const definitions = [
    ...withRank(input.pageMetadata?.fields || [], FIELD_METADATA_RANK),
    ...withRank(extractFields(input.pageMetadata?.constraints || []), PAGE_CONSTRAINT_RANK),
    ...withRank(extractFields(clauses), DESCRIPTION_RANK),
  ];
  return groupByCanonicalName(definitions)
    .map(reconcileField)
    .sort((a, b) => canonical(a.name).localeCompare(canonical(b.name)));
}

function mergeControls(definitions) {
  return groupByCanonicalName(definitions).map((group) => {
    const control = { name: group[0].name };
    const unresolved = [];
    for (const key of ['type', 'disabled']) {
      const values = unique(group.map((definition) => definition[key]).filter((value) => value !== undefined));
      if (values.length > 1) unresolved.push(key);
      else if (values.length) control[key] = values[0];
    }
    const assumptions = unresolved.length
      ? [`Control "${control.name}" has conflicting ${unresolved.join('/')} definitions in page metadata. Confirm its page context and state before execution.`]
      : [];
    return { ...control, unresolved, assumptions };
  });
}

function lengthValue(size) {
  return size <= MAX_LITERAL_LENGTH_VALUE ? 'A'.repeat(size) : `<string of exactly ${size} characters>`;
}

function roundNumeric(value) {
  return Number(value.toPrecision(NUMERIC_PRECISION));
}

function sampleValue(field) {
  const { constraints, type } = field;
  if (field.unresolved?.length) return '<valid test value after the flagged constraint review>';
  if (type === 'password') return '<valid test password; do not use a real credential>';
  if (constraints.options) return constraints.options[0];
  if (constraints.pattern) return '<test value matching the supplied pattern>';
  if (type === 'email') return 'tester@example.test';
  if (type === 'url') return 'https://example.test';
  if (type === 'checkbox') return 'checked';
  if (type === 'number' || type === 'integer' || constraints.min !== undefined || constraints.max !== undefined) {
    return String(constraints.min ?? Math.min(1, constraints.max ?? 1));
  }
  if (constraints.minLength !== undefined || constraints.maxLength !== undefined) {
    return lengthValue(Math.min(Math.max(constraints.minLength ?? 1, 1), constraints.maxLength ?? MAX_TEXT_LENGTH));
  }
  return '<valid test value selected for this field>';
}

function splitClauses(requirement) {
  const seen = new Set();
  const clauses = [];
  for (const part of requirement.split(/\n+|(?<=[.!;])\s+/)) {
    const clause = part.trim().replace(/[.;]$/, '');
    const key = canonical(clause);
    if (!clause || seen.has(key)) continue;
    seen.add(key);
    clauses.push(clause);
  }
  return clauses;
}

function createCaseCollector({ requirement, moduleName, selected }) {
  const cases = [];
  const seen = new Set();
  const notices = new Set();
  let limitReached = false;

  const add = (rule, category, title, instruction, expected, details = {}) => {
    const { data = [], assumptions = [], reference = requirement, preconditions = [], priority = 'medium' } = details;
    if (!selected.has(category)) return;
    const semantic = JSON.stringify([
      canonical(moduleName),
      category,
      canonical(title),
      canonical(instruction),
      canonical(expected),
      data,
    ]);
    if (seen.has(semantic)) return;
    seen.add(semantic);
    if (cases.length >= MAX_CASES) {
      limitReached = true;
      return;
    }

    const notes = unique(assumptions);
    if (notes.length > MAX_CASE_ASSUMPTIONS) {
      notices.add('Some scenarios have more than 20 assumptions. Additional field-specific reconciliation notes are available in warnings and individual field cases.');
    }
    const keptNotes = notes.length <= MAX_CASE_ASSUMPTIONS
      ? notes
      : [
          ...notes.slice(0, MAX_CASE_ASSUMPTIONS - 1),
          'Additional assumptions are recorded in generation warnings and individual field cases; review them before execution.',
        ];
    const stepInstruction = instruction.length <= MAX_CASE_TEXT_LENGTH
      ? instruction
      : 'Exercise the behavior described in requirementReference and verify its stated outcome.';

    cases.push({
      id: `TCG-${shortHash(JSON.stringify([canonical(moduleName), canonical(requirement), rule, semantic]))}`,
      title: title.slice(0, MAX_TITLE_LENGTH),
      module: moduleName,
      category,
      priority,
      preconditions: [BASE_PRECONDITION, ...preconditions],
      steps: [{ instruction: stepInstruction, expectedResult: expected }],
      testData: data,
      expectedResult: expected,
      requirementReference: reference,
      assumptions: keptNotes,
    });
  };

  return {
    cases,
    notices,
    add,
    isLimitReached: () => limitReached,
  };
}

function addReviewCases(add, fields, controls) {
  for (const field of fields) {
    if (!field.unresolved.length) continue;
    add(
      `constraint-review-${canonical(field.name)}`,
      'Validation',
      `${field.name}: review contradictory constraints`,
      `Compare the supplied definitions for ${field.name} and clarify ${field.unresolved.join(', ')} before executing its acceptance scenarios.`,
      'A single agreed rule is documented before acceptance or boundary outcomes are asserted.',
      { assumptions: field.assumptions, priority: 'high' },
    );
  }
  for (const control of controls) {
    if (!control.unresolved.length) continue;
    add(
      `control-review-${canonical(control.name)}`,
      'Validation',
      `${control.name}: review conflicting control definitions`,
      `Confirm the intended page context, type and enabled state for ${control.name} before exercising its action.`,
      'The intended control definition and starting state are documented before its behavior is asserted.',
      { assumptions: control.assumptions, priority: 'high' },
    );
  }
}

function addClauseCases(add, clauses) {
  for (const clause of clauses.slice(0, MAX_FUNCTIONAL_CLAUSES)) {
    add(
      `requirement-${canonical(clause)}`,
      'Functional',
      `Verify: ${clause}`,
      `Exercise the behavior described by this supplied requirement: ${clause}`,
      clause,
      {
        reference: clause,
        assumptions: ['The requirement is used as the acceptance criterion; a tester must resolve any ambiguous actions or outcomes before execution.'],
      },
    );
  }
}

const EXAMPLE_DATA_ASSUMPTION = 'Example data is illustrative. Confirm it satisfies every applicable business rule before execution.';

function addPositiveCase(add, { moduleName, requirement, clauses, fields, controls }) {
  if (fields.length) {
    const target = controls.find((control) => control.type === 'submit' && !control.disabled && !control.unresolved.length);
    const action = target
      ? ` and activate ${target.name}`
      : '. Use the workflow action specified in the requirement';
    add(
      'valid-workflow',
      'Positive',
      `${moduleName}: complete the workflow with valid data`,
      `Populate the supplied fields with valid test data${action}. Verify the stated requirement.`,
      requirement,
      {
        data: fields.map((field) => ({ field: field.name, value: sampleValue(field) })),
        assumptions: [
          EXAMPLE_DATA_ASSUMPTION,
          ...(target ? [] : ['No submit control was supplied. Confirm the workflow action before execution.']),
          ...fields.flatMap((field) => field.assumptions),
        ],
      },
    );
    return;
  }
  if (!clauses.length) return;
  add(
    'positive-requirement',
    'Positive',
    `${moduleName}: satisfy the stated acceptance criteria`,
    `Exercise a valid example of the supplied requirement: ${requirement}`,
    requirement,
    { assumptions: ['No field metadata was supplied. A tester must select valid inputs and concrete actions; no additional features are assumed.'] },
  );
}

const INVALID_TYPE_SAMPLES = new Map([
  ['email', 'not-an-email'],
  ['url', 'not-a-url'],
  ['number', 'not-a-number'],
  ['integer', '1.5'],
]);

function allowedOptionOutsider(options) {
  let outsider = '__not_an_allowed_option__';
  while (options.includes(outsider)) outsider += '_';
  return outsider;
}

function addFieldCases(add, notices, field) {
  const { constraints, name, type } = field;
  const key = canonical(name);
  const baseAssumptions = [EXAMPLE_DATA_ASSUMPTION, ...field.assumptions];
  const details = (value, extraAssumptions = []) => ({
    data: [{ field: name, value }],
    assumptions: [...baseAssumptions, ...extraAssumptions],
    preconditions: ['All other fields satisfy their supplied constraints.'],
  });

  if (constraints.required) {
    add(
      `required-${key}`,
      'Validation',
      `${name}: required value is missing`,
      `Leave ${name} empty and attempt the stated workflow.`,
      `${name} is identified as required and the workflow cannot complete until it is supplied.`,
      details(''),
    );
  }

  const invalidSample = INVALID_TYPE_SAMPLES.get(type);
  if (invalidSample) {
    add(
      `invalid-type-${key}`,
      'Negative',
      `${name}: reject invalid ${type}`,
      `Supply ${invalidSample} for ${name} and attempt the stated workflow.`,
      `${name} does not accept a value of the wrong format or type.`,
      details(invalidSample),
    );
  }

  if (constraints.options) {
    add(
      `options-${key}`,
      'Validation',
      `${name}: restrict values to supplied options`,
      `Check the available ${name} choices, then attempt to supply a value outside the allowed set.`,
      `${name} accepts only values in the supplied options list (${constraints.options.length} options).`,
      details(allowedOptionOutsider(constraints.options), [
        'For a fixed-choice control, verify an unavailable option cannot be selected; do not alter production requests.',
      ]),
    );
  }

  if (constraints.pattern) {
    add(
      `pattern-${key}`,
      'Validation',
      `${name}: enforce the supplied pattern`,
      `Check ${name} using one matching and one nonmatching value for the supplied pattern: ${constraints.pattern}.`,
      'The matching value satisfies this constraint; the nonmatching value is rejected.',
      details('<matching value and nonmatching value>', [
        'Pattern syntax is taken from supplied metadata. A tester must select concrete examples; the generator does not execute patterns.',
      ]),
    );
  }

  for (const [limit, delta] of [['minLength', -1], ['maxLength', 1]]) {
    const bound = constraints[limit];
    if (bound === undefined) continue;
    const outside = bound + delta;
    add(
      `length-at-${limit}-${key}`,
      'Boundary',
      `${name}: exactly ${bound} characters`,
      `Enter exactly ${bound} characters in ${name} and evaluate its length constraint.`,
      `${name} satisfies the supplied ${limit} constraint.`,
      details(lengthValue(bound)),
    );
    if (outside >= 0) {
      add(
        `length-outside-${limit}-${key}`,
        'Boundary',
        `${name}: ${outside} characters outside the limit`,
        `Enter exactly ${outside} characters in ${name} and attempt the workflow.`,
        `${name} fails the supplied ${limit} constraint of ${bound}.`,
        details(lengthValue(outside)),
      );
    }
  }

  for (const [limit, delta] of [['min', -1], ['max', 1]]) {
    const bound = constraints[limit];
    if (bound === undefined) continue;
    const increment = constraints.step ?? 1;
    const stepAssumptions = constraints.step === undefined
      ? ['A boundary increment of 1 is assumed. Confirm numeric precision.']
      : [];
    add(
      `range-at-${limit}-${key}`,
      'Boundary',
      `${name}: value at ${limit} ${bound}`,
      `Supply ${bound} for ${name} and evaluate its range constraint.`,
      `${name} satisfies the supplied ${limit} range constraint; other constraints still apply.`,
      details(String(bound), stepAssumptions),
    );
    const outside = roundNumeric(bound + delta * increment);
    if (outside === bound) {
      notices.add('A numeric increment was too small for a reliable boundary value. Confirm precision and supply a larger step.');
      continue;
    }
    add(
      `range-outside-${limit}-${key}`,
      'Boundary',
      `${name}: value outside ${limit} ${bound}`,
      `Supply ${outside} for ${name} and evaluate its range constraint.`,
      `${name} fails the supplied ${limit} range constraint of ${bound}.`,
      details(String(outside), stepAssumptions),
    );
  }

  if (type === 'password') {
    add(
      `password-display-${key}`,
      'Security',
      `${name}: sensitive input display scenario`,
      `In an authorized test environment, enter a dummy password in ${name} and review how it is displayed.`,
      `${name} masks the dummy password unless an explicitly supported reveal action is selected.`,
      {
        ...details('<dummy password, never a real credential>', [
          'Password masking is an explicit security template assumption. Confirm the intended display policy.',
        ]),
        priority: 'high',
      },
    );
  }
}

function addControlCases(add, controls, requirement) {
  for (const control of controls) {
    if (control.unresolved.length) continue;
    const key = canonical(control.name);
    if (control.disabled) {
      add(
        `disabled-${key}`,
        'Functional',
        `${control.name}: disabled control`,
        `Attempt to activate ${control.name} while it is marked disabled in the supplied metadata.`,
        `${control.name} does not trigger its action while disabled.`,
        { assumptions: ['The supplied disabled state applies at the start of this scenario.'] },
      );
    } else {
      add(
        `control-${key}`,
        'Functional',
        `${control.name}: stated workflow action`,
        `Activate ${control.name} in the supplied workflow and compare its result to the requirement.`,
        requirement,
        { assumptions: ['The control purpose is not inferred from its label. Confirm its intended outcome against the requirement before execution.'] },
      );
    }
  }
}

const AUTH_REQUIRED = /\bonly authenticated users\b|\bmust be authenticated\b|\brequires? authentication\b/i;
const AUTH_NEGATION = /\b(?:not|never|optional|doesn't|don't|isn't|aren't)\b/i;
const PUBLIC_DENIED = /\bunauthenticated users (?:(?:must not|cannot) (?:access|view|use|enter)|must be denied|are denied)\b/i;
const TIMING = /\b(?:within|under|at most|no more than)\s+(\d+(?:\.\d+)?)\s*(milliseconds|ms|seconds|s)\b/i;
const CONCURRENCY = /\b(\d+) concurrent users\b/i;

function addSecurityClauseCase(add, clause) {
  const authRequired = AUTH_REQUIRED.test(clause) && !AUTH_NEGATION.test(clause);
  if (!authRequired && !PUBLIC_DENIED.test(clause)) return;
  add(
    `authentication-${canonical(clause)}`,
    'Security',
    'Protected workflow: unauthenticated access scenario',
    `Using an authorized test environment, attempt the protected workflow without an authenticated session. Requirement: ${clause}`,
    'Access is denied or authentication is requested before protected content is returned.',
    {
      reference: clause,
      priority: 'high',
      assumptions: ['This is a manual access-control scenario. The generator does not request URLs or perform a security scan.'],
    },
  );
}

function addPerformanceClauseCase(add, notices, clause, moduleName) {
  const timing = clause.match(TIMING);
  if (!timing) return;
  const unitToMs = /^(seconds|s)$/i.test(timing[2]) ? 1000 : 1;
  const budgetMs = Number(timing[1]) * unitToMs;
  if (!Number.isFinite(budgetMs)) {
    notices.add('A timing constraint exceeded numeric limits and was not converted to a scenario.');
    return;
  }
  const concurrency = clause.match(CONCURRENCY);
  const workload = concurrency ? ` at the supplied workload of ${concurrency[1]} concurrent users` : '';
  const data = [{ field: 'responseTimeBudgetMs', value: String(budgetMs) }];
  if (concurrency) data.push({ field: 'concurrentUsers', value: concurrency[1] });
  add(
    `timing-${canonical(clause)}`,
    'Performance',
    `${moduleName}: response-time scenario (${budgetMs} ms)`,
    `Plan a controlled timing check for this requirement: ${clause}. Record the defined start and finish events${workload}.`,
    clause,
    {
      reference: clause,
      data,
      assumptions: [
        'Scenario only: no requests or load tests are executed. Confirm the measurement environment and timing events.',
        ...(concurrency ? [] : ['No workload was specified. Confirm concurrency and sample size before execution.']),
      ],
    },
  );
}

function buildWarnings({ metadataWarnings, notices, unmatched, allFieldCount, clauseCount, limitReached, reconciliationNotes }) {
  const warnings = [
    'Coverage is limited to supplied requirements, metadata, and documented rule templates. Complete coverage is not claimed.',
    'Generated cases are unexecuted scenarios. Review assumptions and test data before execution.',
    ...metadataWarnings,
    ...notices,
  ];
  if (unmatched.length) warnings.push(`No applicable explicit rule was found for: ${unmatched.join(', ')}.`);
  if (allFieldCount > MAX_METADATA_ENTRIES) {
    warnings.push('Only the first 100 distinct fields received scenarios. Split the requirement for additional fields.');
  }
  if (clauseCount > MAX_FUNCTIONAL_CLAUSES) warnings.push('Only the first 100 clauses received generic Functional scenarios.');
  if (limitReached) warnings.push('The 200-case output limit was reached. Split the requirement for additional scenarios.');
  if (reconciliationNotes.length) {
    warnings.push(
      `${reconciliationNotes.length} field/control definitions needed reconciliation. Explicit requirement rules take precedence; unresolved constraints require review.`,
      ...reconciliationNotes.slice(0, MAX_LISTED_NOTES),
    );
    if (reconciliationNotes.length > MAX_LISTED_NOTES) {
      warnings.push('Only the first 20 reconciliation notes are listed. Further decisions are recorded on their generated cases; split the requirement if output is limited.');
    }
  }
  return warnings.slice(0, MAX_WARNINGS);
}

/** Pure local service: no network, browser, AI, storage, scans, or execution. */
export function generateTestCases(raw) {
  const { input, warnings: metadataWarnings } = prepareGenerationInput(raw);
  const { requirement } = input;
  const moduleName = input.moduleName || DEFAULT_MODULE;
  const selected = new Set(input.categories || categories);

  const clauses = splitClauses(requirement);
  const allClauses = [...clauses, ...(input.pageMetadata?.constraints || [])];
  const allFields = mergeFields(input, clauses);
  const fields = allFields.slice(0, MAX_METADATA_ENTRIES);
  const controls = mergeControls(input.pageMetadata?.controls || []);
  const reconciliationNotes = unique([
    ...allFields.flatMap((field) => field.warnings),
    ...controls.flatMap((control) => control.assumptions),
  ]);

  const collector = createCaseCollector({ requirement, moduleName, selected });
  const { add, cases, notices } = collector;
  addReviewCases(add, fields, controls);
  addClauseCases(add, allClauses);
  addPositiveCase(add, { moduleName, requirement, clauses, fields, controls });
  for (const field of fields) addFieldCases(add, notices, field);
  addControlCases(add, controls, requirement);
  for (const clause of allClauses) {
    addSecurityClauseCase(add, clause);
    addPerformanceClauseCase(add, notices, clause, moduleName);
  }

  const limitReached = collector.isLimitReached();
  const unmatched = [...selected].filter((category) => !cases.some((item) => item.category === category));
  const reconciliationSummary = reconciliationNotes.length
    ? ` ${reconciliationNotes.length} field/control definitions needed reconciliation; review generation notes and case assumptions.`
    : '';
  const fieldLimitReached = allFields.length > MAX_METADATA_ENTRIES;
  const clauseLimitReached = allClauses.length > MAX_FUNCTIONAL_CLAUSES;

  return generationOutputSchema.parse({
    testCases: cases,
    summary: `Generated ${cases.length} local rule-based scenarios from ${fields.length} supplied or explicitly parsed fields and ${controls.length} controls.${reconciliationSummary}`,
    warnings: buildWarnings({
      metadataWarnings,
      notices,
      unmatched,
      allFieldCount: allFields.length,
      clauseCount: allClauses.length,
      limitReached,
      reconciliationNotes,
    }),
    coverage: {
      complete: false,
      limitReached: limitReached || fieldLimitReached || clauseLimitReached,
    },
  });
}

export function generatedCasesToQa(output) {
  return output.testCases.map((testCase) => ({
    id: randomUUID(),
    name: testCase.title,
    steps: [],
    qa: {
      generationId: testCase.id,
      module: testCase.module,
      category: testCase.category,
      description: testCase.requirementReference,
      requirementReference: testCase.requirementReference,
      assumptions: testCase.assumptions,
      testData: testCase.testData,
      priority: testCase.priority,
      type: ['Security', 'Performance'].includes(testCase.category) ? testCase.category.toLowerCase() : 'functional',
      executionMode: 'manual',
      preconditions: testCase.preconditions.join('\n'),
      expectedResult: testCase.expectedResult,
      manualSteps: testCase.steps.map((step) => ({ id: randomUUID(), ...step })),
    },
  }));
}

const INSPECTED_NUMERIC_ATTRIBUTES = ['min', 'max', 'minLength', 'maxLength', 'step'];
const INSPECTED_INPUT_TYPES = ['text', 'email', 'password', 'number', 'url', 'date', 'checkbox', 'tel', 'file'];
const INPUT_BUTTON_TYPES = ['button', 'submit', 'reset'];

function inspectedAttributeInRange(attribute, value) {
  if (!Number.isFinite(value)) return false;
  if (attribute === 'minLength' || attribute === 'maxLength') {
    return Number.isInteger(value) && value >= 0 && value <= MAX_TEXT_LENGTH;
  }
  const lowest = attribute === 'step' ? Number.MIN_VALUE : -MAX_NUMERIC_MAGNITUDE;
  return value >= lowest && value <= MAX_NUMERIC_MAGNITUDE;
}

// Returns the usable constraints and whether any observed attribute had to be dropped.
function inspectedConstraints(element) {
  const constraints = {};
  let dropped = false;
  if (element.required) constraints.required = true;

  for (const attribute of INSPECTED_NUMERIC_ATTRIBUTES) {
    const raw = element[attribute];
    if (raw === undefined || raw === null || raw === '') continue;
    if (attribute === 'step' && raw === 'any') continue;
    const value = Number(raw);
    if (inspectedAttributeInRange(attribute, value)) constraints[attribute] = value;
    else dropped = true;
  }

  if (Array.isArray(element.options) && element.options.length) {
    const options = element.options
      .filter((option) => typeof option === 'string' && option.length <= MAX_OPTION_LENGTH)
      .slice(0, MAX_OPTIONS);
    if (options.length) constraints.options = options;
    if (options.length !== element.options.length) dropped = true;
  }

  if (typeof element.pattern === 'string' && element.pattern.length) {
    if (element.pattern.length <= MAX_PATTERN_LENGTH) constraints.pattern = element.pattern;
    else dropped = true;
  }
  return { constraints, dropped };
}

function inspectedFieldType(element) {
  if (element.tag === 'textarea') return 'textarea';
  if (element.tag === 'select') return 'select';
  return INSPECTED_INPUT_TYPES.includes(element.type) ? element.type : undefined;
}

function inspectedControlType(element) {
  if (element.tag === 'a') return 'link';
  if (element.type === 'submit') return 'submit';
  if (element.role === 'tab') return 'tab';
  return 'button';
}

// Adapt the browser inspector's output into the same supplied metadata contract.
export function metadataFromInspection(inspection, supplied = {}) {
  const prepared = prepareGenerationInput({
    requirement: 'Validate supplied page metadata',
    pageMetadata: supplied,
  });
  const metadata = prepared.input.pageMetadata || {};
  const fields = [...(metadata.fields || [])];
  const controls = [...(metadata.controls || [])];
  const constraints = [...(metadata.constraints || [])];
  let omitted = false;
  let disabledFields = false;
  let invalidAttributes = false;

  const addField = (element) => {
    if (element.disabled) {
      disabledFields = true;
      return;
    }
    if (fields.length >= MAX_METADATA_ENTRIES) {
      omitted = true;
      return;
    }
    const { constraints: limits, dropped } = inspectedConstraints(element);
    if (dropped) invalidAttributes = true;

    const type = inspectedFieldType(element);
    const field = { name: element.label.trim().slice(0, MAX_NAME_LENGTH), ...(type ? { type } : {}) };

    // Keep contradictory observed bounds in separate valid records so the
    // shared reconciler can flag them without a schema error aborting the run.
    const deferred = {};
    for (const [low, high] of RANGE_PAIRS) {
      if (limits[low] !== undefined && limits[high] !== undefined && limits[low] > limits[high]) {
        deferred[high] = limits[high];
        delete limits[high];
      }
    }
    const hasDeferred = Object.keys(deferred).length > 0;
    if (hasDeferred && fields.length >= MAX_METADATA_ENTRIES - 1) {
      omitted = true;
      return;
    }
    fields.push({ ...field, constraints: limits });
    if (hasDeferred) fields.push({ ...field, constraints: deferred });
  };

  const addControl = (element) => {
    if (controls.length >= MAX_METADATA_ENTRIES) {
      omitted = true;
      return;
    }
    controls.push({
      name: element.label.trim().slice(0, MAX_NAME_LENGTH),
      type: inspectedControlType(element),
      disabled: Boolean(element.disabled),
    });
  };

  for (const page of inspection.context?.pages || inspection.pages || []) {
    for (const element of page.controls || []) {
      if (typeof element.label !== 'string' || !element.label.trim()) continue;
      const isInputButton = element.tag === 'input' && INPUT_BUTTON_TYPES.includes(element.type);
      if (['input', 'textarea', 'select'].includes(element.tag) && !isInputButton) {
        addField(element);
      } else if (isInputButton || ['button', 'a'].includes(element.tag) || ['button', 'tab'].includes(element.role)) {
        addControl(element);
      }
    }
  }

  const warnings = [...prepared.warnings];
  if (omitted) warnings.push('Only the first 100 fields and 100 controls were supplied to the generator.');
  if (disabledFields) {
    warnings.push('Disabled form fields were omitted from editable input scenarios. Review their state transitions separately.');
  }
  if (invalidAttributes) {
    warnings.push('Unsupported inspected field attributes were omitted; supported constraints and the requirement still generated scenarios. Review the page attributes before execution.');
  }
  return { pageMetadata: { fields, controls, constraints }, warnings };
}
