// Messages use screen labels and safe schema information, never submitted values.

const METADATA_HELP = 'Correct the page details, or clear the Page metadata box to generate from the description.';
const MAX_ISSUES_READ = 8;
const MAX_ISSUES_SHOWN = 3;

const SECTION_TARGETS = new Map([
  ['requirement', 'description'],
  ['moduleName', 'module name'],
  ['categories', 'test categories'],
]);

const ENTRY_NAMES = new Map([
  ['controls', 'page control'],
  ['constraints', 'page rule'],
]);

const LIST_NAMES = new Map([
  ['fields', 'page fields'],
  ['controls', 'buttons and links'],
]);

const PROPERTY_LABELS = new Map([
  ['name', 'name'],
  ['type', 'input type'],
  ['required', 'required setting'],
  ['disabled', 'enabled or disabled setting'],
  ['min', 'smallest allowed value'],
  ['max', 'largest allowed value'],
  ['minLength', 'minimum text length'],
  ['maxLength', 'maximum text length'],
  ['step', 'amount between allowed numbers'],
  ['options', 'available choices'],
  ['pattern', 'text format rule'],
]);

const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);

function invalidTypeMessage(issue, target) {
  if (issue.expected === 'int') return `Enter a whole number for the ${target}.`;
  if (issue.expected === 'number') return `Enter a number for the ${target}.`;
  if (issue.expected === 'boolean') return `Choose whether the ${target} should be on or off.`;
  if (issue.expected === 'string') return `Enter text for the ${target}.`;
  return `The ${target} could not be read.`;
}

function valueMessage(issue, target) {
  if (issue.code === 'too_small') {
    if (issue.origin === 'string' && issue.minimum === 1) return `Enter a ${target} before trying again.`;
    return `The ${target} must be ${issue.inclusive === false ? 'greater than' : 'at least'} ${issue.minimum}.`;
  }
  if (issue.code === 'too_big') {
    if (issue.origin === 'number') return `The ${target} must be ${issue.maximum} or less.`;
    return `The ${target} is too long. Use ${issue.maximum} ${issue.origin === 'array' ? 'entries' : 'characters'} or fewer.`;
  }
  if (issue.code === 'invalid_type') return invalidTypeMessage(issue, target);
  return `${capitalize(target)} needs attention. Check it and try again.`;
}

function metadataListMessage(issue, collection) {
  const list = LIST_NAMES.get(collection) ?? 'page rules';
  if (issue.code === 'too_big') return `There are too many ${list}. Keep ${issue.maximum} or fewer. ${METADATA_HELP}`;
  return `The list of ${list} could not be read. ${METADATA_HELP}`;
}

function metadataEntryMessage(issue, collection, index, property) {
  const entry = `${ENTRY_NAMES.get(collection) ?? 'page field'} ${index + 1}`;
  const label = PROPERTY_LABELS.get(property);
  const target = label ? `${label} for ${entry}` : entry;
  if (issue.code === 'custom') {
    const limits = issue.message.includes('minLength')
      ? 'The minimum text length is higher than the maximum'
      : 'The smallest allowed value is higher than the largest';
    return `${limits} for ${entry}. Correct these limits in Page metadata, or clear that box and try again.`;
  }
  if (issue.code === 'invalid_value') return `The ${target} is not one of the available choices. ${METADATA_HELP}`;
  if (issue.code === 'unrecognized_keys') return `Some details for ${entry} are not supported. ${METADATA_HELP}`;
  return `${valueMessage(issue, target)} ${METADATA_HELP}`;
}

function issueMessage(issue) {
  const [section, collection, index, ...rest] = issue.path;
  if (section === 'categories') return 'Select at least one test category from the available options, then try again.';
  if (section !== 'pageMetadata') return valueMessage(issue, SECTION_TARGETS.get(section) ?? 'requirement details');
  if (!collection) {
    return 'The optional page details could not be read. Clear the Page metadata box and try again, or ask your team to correct its contents.';
  }
  if (typeof index !== 'number') return metadataListMessage(issue, collection);
  return metadataEntryMessage(issue, collection, index, rest.at(-1));
}

export function generationInputUserMessage(issues) {
  const messages = issues.slice(0, MAX_ISSUES_READ).map(issueMessage);
  return [...new Set(messages)].slice(0, MAX_ISSUES_SHOWN).join('\n');
}

const CODE_MESSAGES = new Map([
  ['GENERATION_CANCELLED', 'Generation cancelled. Existing drafts were preserved.'],
  [
    'AGENT_REVIEW',
    'Agent review found unresolved issues. Review the reported issues, clarify the requirement or increase the repair limit (maximum 3), then retry. Existing drafts were preserved.',
  ],
  [
    'AGENT_OUTPUT',
    'ReasonX returned malformed or incomplete agent output. Shorten the requirement or choose Fast mode, then retry. Existing drafts were preserved.',
  ],
  ['AGENT_CONTEXT', 'The agent context is too large. Shorten the requirement or guidance and retry.'],
]);

const KIND_MESSAGES = new Map([
  ['auth', 'ReasonX rejected its API key. Save a valid key in Model settings and retry.'],
  ['timeout', 'ReasonX timed out. Shorten the requirement or choose Fast mode and retry.'],
  ['model', 'ReasonX could not find the selected model. Check Model settings.'],
  ['busy', 'ReasonX is busy. Wait for its current request to finish and retry.'],
  ['upstream', 'ReasonX or Ollama is unavailable. Start both local services and retry.'],
  ['unreachable', 'ReasonX or Ollama is unavailable. Start both local services and retry.'],
]);

const STATUS_MESSAGES = new Map([
  [401, 'Your sign-in has expired. Sign in again, then try again.'],
  [403, 'You do not have permission to use this project or action. Ask your administrator for access.'],
  [404, 'This requirement is no longer available. Return to the Requirement list and select it again.'],
]);

// Order matters: the first matching rule wins.
const SERVICE_RULES = [
  [
    /generation is already running/i,
    'Test cases are already being generated for this project. Wait for that to finish, then try again.',
  ],
  [/^Requirement title/, 'Enter a requirement title using 1 to 160 characters, then try again.'],
  [/^Description/, 'Keep the description to 10,000 characters or fewer, then try again.'],
  [
    /HTTP or HTTPS|HTTP\(S\)|Requirement URL/,
    'Enter the full website address, starting with https:// or http://. Use a link that does not include a username or password.',
  ],
  [
    /describe the workflow/i,
    'Add a description of what users should do and what should happen, then generate test cases again.',
  ],
  [
    /Configure an AI model|AI model and API key/i,
    'AI generation has not been set up. Choose Local rules to generate now, or ask your administrator to set up AI generation in Settings.',
  ],
  [
    /Could not inspect|application did not return a page|browser.*(?:install|launch)|executable.*exist/i,
    'QA Studio could not open the website. Check that the URL opens in your browser. To generate from the description only, choose Local rules and turn off Inspect URL before local generation.',
  ],
  [
    /1000 test cases/,
    'This project has reached its limit of 1,000 test cases. Create another project for these requirements, then try again.',
  ],
  [
    /AI response was incomplete/,
    'The AI service could not finish creating the test cases. Try a shorter description or choose Local rules, then generate again.',
  ],
  [
    /AI provider declined/,
    'The AI service could not accept this request. Review the description or choose Local rules, then try again.',
  ],
  [
    /AI provider|Test case generation failed|The model|Test case \d|Generated step/i,
    'The AI service could not create usable test cases. Try again or choose Local rules. If this continues, ask your administrator to check the AI settings.',
  ],
];

const TIMEOUT_PATTERN = /timed? ?out|timeout/i;
const TIMEOUT_MESSAGE =
  'This took longer than expected. Try again with a shorter description, or choose Local rules to generate without AI.';

const FORM_RULES = [
  [
    /fetch failed|ECONN|ENOTFOUND|network/i,
    'QA Studio could not connect to a service it needs. Check your connection and try again, or choose Local rules to generate from the description.',
  ],
  [/Choose local rules/, 'Choose a generation method from the available options, then try again.'],
  [
    /Inspect URL must/,
    'Use the Inspect URL before local generation checkbox to choose whether to inspect the website, then try again.',
  ],
  [/Draft title/, 'Enter a draft title using 1 to 120 characters, then save again.'],
  [/Add at least one step/, 'Add at least one test step before saving or approving this draft.'],
  [
    /Draft IDs must/,
    'This draft cannot be added directly to Test cases. Review and approve it from its Requirement page.',
  ],
  [
    /1,000 drafts/,
    'This requirement already has 1,000 drafts. Approve existing drafts or create another requirement before generating more.',
  ],
];

const FALLBACK_MESSAGE =
  'QA Studio could not finish this request. Try again. If the problem continues, ask your administrator for help.';

function firstMatch(rules, message) {
  return rules.find(([pattern]) => pattern.test(message))?.[1];
}

export function requirementErrorUserMessage(error, status = error.status) {
  if (error.userMessage) return error.userMessage;
  if (CODE_MESSAGES.has(error.code)) return CODE_MESSAGES.get(error.code);
  if (KIND_MESSAGES.has(error.kind)) return KIND_MESSAGES.get(error.kind);
  if (STATUS_MESSAGES.has(status)) return STATUS_MESSAGES.get(status);
  if (error.code === 'EDIT_CONFLICT') {
    return 'Someone changed this project while you were working. Copy any unsaved text, refresh the page, and try again.';
  }
  const message = String(error.message || '');
  const serviceMessage = firstMatch(SERVICE_RULES, message);
  if (serviceMessage) return serviceMessage;
  if (TIMEOUT_PATTERN.test(message) || error.name === 'TimeoutError') return TIMEOUT_MESSAGE;
  return firstMatch(FORM_RULES, message) ?? FALLBACK_MESSAGE;
}
