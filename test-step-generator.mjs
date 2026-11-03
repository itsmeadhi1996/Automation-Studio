import { z } from 'zod';
import { prepareGenerationInput } from './test-case-generator.mjs';

const MAX_STEPS = 50;
const MAX_TEXT = 10000;
const MAX_ASSUMPTIONS = 20;
const MAX_LINKS = 30;
const MAX_LABEL = 160;

const CONDITIONAL_CATEGORIES = ['Negative', 'Validation', 'Boundary'];
const PLANNING_CATEGORIES = ['Security', 'Performance'];
const OPEN_EXPECTED = 'The application opens and is ready for the test.';
const CREDENTIAL_FIELD = /email|user.?name|password/i;

const GENERIC_INSTRUCTION = /^(?:Exercise the behavior described|Exercise a valid example|Populate the supplied fields|Compare the supplied definitions|Confirm the intended page context)/i;
const SECRET_QUERY_KEY = /token|password|secret|credential|api.?key/i;
const REDIRECT_CLAUSE = /^(?:(?:the\s+)?(?:page|app(?:lication)?|it)\s+)?(?:(?:is|gets|should be|must be)\s+)?(?:redirect(?:ed|s)?|navigat(?:ed|es|e))\s+to\b/i;
const SIGN_IN_CLAUSE = /\b(?:sign[ -]?in|log[ -]?in|valid (?:test )?credentials|(?:must )?be authenticated|only authenticated users)\b/i;
const NEGATED_SIGN_IN = /\b(?:invalid|wrong|without|unauthenticated|not|reject)\b/i;
const CLAUSE_BREAK = /\n+|(?<=[.!;])\s+|\s*,\s*|\s+(?:and then|then)\s+|\s+and\s+(?=(?:clicks?|selects?|chooses?|verif(?:y|ies)|checks?|confirms?|submits?|saves?|enters?|fills?|navigates?|(?:the )?(?:page|app|user|it)\s+(?:is|gets|should|must)|(?:is|gets)\s+redirected)\b)/i;

// Third-person verbs, so "The user clicks Leave" reads the same as "Click Leave".
const BASE_VERBS = {
  clicks: 'click',
  selects: 'select',
  chooses: 'choose',
  taps: 'tap',
  presses: 'press',
  opens: 'open',
  launches: 'launch',
  visits: 'visit',
  logs: 'log',
  signs: 'sign',
  verifies: 'verify',
  checks: 'check',
  confirms: 'confirm',
  navigates: 'navigate',
  goes: 'go',
  enters: 'enter',
  fills: 'fill',
  submits: 'submit',
  saves: 'save',
  applies: 'apply',
  creates: 'create',
  updates: 'update',
  deletes: 'delete',
  cancels: 'cancel',
  attaches: 'attach',
  searches: 'search',
  filters: 'filter',
};

const workflowSchema = z.string().trim().max(MAX_TEXT);

export const testStepOutputSchema = z.object({
  steps: z
    .array(
      z.object({
        instruction: z.string().min(1).max(MAX_TEXT),
        expectedResult: z.string().min(1).max(MAX_TEXT),
      }),
    )
    .min(1)
    .max(MAX_STEPS),
  expectedResult: z.string().max(MAX_TEXT),
  assumptions: z.array(z.string().max(2000)).max(MAX_ASSUMPTIONS),
  warnings: z.array(z.string()),
});

const tidy = (value) =>
  String(value || '')
    .trim()
    .replace(/\s+/g, ' ');

const capitalize = (value) => (value ? value.charAt(0).toUpperCase() + value.slice(1) : '');
const unique = (values) => [...new Set(values)];

// Compares names regardless of case and words such as "button" or "page".
function matchKey(value) {
  return tidy(value)
    .toLowerCase()
    .replace(/\b(?:the|button|link|tab|menu|page)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanLabel(value) {
  return tidy(value)
    .replace(/^["'“”]+|["'“”.;]+$/g, '')
    .replace(/\s+(?:button|link|tab|menu|option)$/i, '')
    .trim()
    .slice(0, MAX_LABEL);
}

function safeUrl(value, base) {
  try {
    const url = new URL(value, base);
    const isWeb = ['http:', 'https:'].includes(url.protocol);
    return isWeb && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

export function inspectedNavigationLinks(page) {
  const base = safeUrl(page.url);
  if (!base) return [];
  const { origin } = new URL(base);

  const links = [];
  for (const control of page.controls || []) {
    if (!control.href || control.disabled || !control.label) continue;
    const url = safeUrl(control.href, base);
    if (!url) continue;
    const target = new URL(url);
    const hasSecret = [...target.searchParams.keys()].some((name) => SECRET_QUERY_KEY.test(name));
    if (target.origin !== origin || hasSecret) continue;
    const name = cleanLabel(control.label);
    if (name) links.push({ name, url });
  }
  return links.slice(0, MAX_LINKS);
}

function navigationLink(links, target, origin = '') {
  let matches = links.filter((item) => matchKey(item.name) === matchKey(target));
  if (origin) {
    const exact = matches.filter((item) => matchKey(item.origin) === matchKey(origin));
    matches = exact.length ? exact : matches.filter((item) => matchKey(item.origin).includes(matchKey(origin)));
  }
  const urls = unique(matches.map((item) => item.url));
  return { link: urls.length === 1 ? matches[0] : null, ambiguous: urls.length > 1 };
}

function normalizeClause(rawClause) {
  const clause = rawClause
    .replace(/^\d+[.)]\s*|^(?:next|finally|after that)[,:]?\s*/i, '')
    .replace(/^(?:the\s+)?(?:users?|employees?|customers?)\s+(?:(?:can|must|should)\s+)?/i, '')
    .replace(/^([a-z]+)\b/i, (verb) => BASE_VERBS[verb.toLowerCase()] || verb);
  return REDIRECT_CLAUSE.test(clause) ? `Verify that ${clause}` : clause;
}

function clickAction(match, links) {
  let target = match[1];
  let origin = '';
  const context = target.match(/\s+(?:from|on|in)\s+(?:the\s+)?(.+)$/i);
  if (context) {
    origin = cleanLabel(context[1]);
    target = target.slice(0, context.index);
  }
  target = cleanLabel(target);
  if (!target) return null;

  const { link, ambiguous } = navigationLink(links, target, origin);
  return {
    kind: /^(?:submit|save|apply|confirm|create)\b/i.test(target) ? 'submit' : 'navigate',
    instruction: `${origin ? `On the ${capitalize(origin)}, click` : 'Click'} ${link?.name || target}.`,
    expectedResult: link ? `The browser opens ${link.url}.` : `The ${target} action is selected.`,
    url: link?.url,
    target,
    ambiguous,
  };
}

function verifyAction(match) {
  const outcome = match[1].replace(/[.;]$/, '');
  const destination =
    outcome.match(/(?:redirect(?:ed|s)?|navigate(?:d|s)?)\s+to\s+(?:the\s+)?(.+?)(?:\s+page)?$/i) ||
    outcome.match(/(?:the\s+)?(.+?)\s+page\s+(?:opens|is displayed|appears|loads)$/i);
  const page = destination ? cleanLabel(destination[1]).replace(/\s+page$/i, '') : '';
  return {
    kind: 'verify',
    instruction: page ? `Verify that the ${capitalize(page)} page is displayed.` : `Verify that ${outcome}.`,
    expectedResult: page ? `The ${capitalize(page)} page is displayed.` : `${capitalize(outcome)}.`,
  };
}

function navigateAction(match, links) {
  const destination = cleanLabel(match[1]);
  const origin = cleanLabel(match[2]);
  const { link, ambiguous } = navigationLink(links, destination, origin);
  const instruction = link
    ? `${origin ? `On the ${capitalize(origin)}, click` : 'Click'} ${link.name}.`
    : `${origin ? `From the ${capitalize(origin)}, navigate` : 'Navigate'} to ${destination}.`;
  return {
    kind: 'navigate',
    instruction,
    expectedResult: link ? `The browser opens ${link.url}.` : `The ${destination} view is displayed.`,
    url: link?.url,
    target: destination,
    ambiguous,
  };
}

function clauseAction(clause, links) {
  if (SIGN_IN_CLAUSE.test(clause) && !NEGATED_SIGN_IN.test(clause)) {
    return {
      kind: 'auth',
      instruction: 'Sign in with valid test credentials.',
      expectedResult: 'The user is signed in and can continue with the workflow.',
    };
  }
  // The open step always comes first, so a sentence saying the same thing adds nothing.
  if (/^(?:open|launch|visit)\s+(?:the\s+)?(?:app(?:lication)?|website)\b/i.test(clause)) return null;

  const click = clause.match(/^(?:click|select|choose|tap|press)\s+(?:on\s+)?(?:the\s+)?(.+)$/i);
  if (click) return clickAction(click, links);

  const verify = clause.match(/^(?:verify|check|confirm|ensure)\s+(?:that\s+)?(.+)$/i);
  if (verify) return verifyAction(verify);

  const navigate = clause.match(/^(?:navigate|go)\s+to\s+(?:the\s+)?(.+?)(?:\s+(?:from|on)\s+(?:the\s+)?(.+))?$/i);
  if (navigate) return navigateAction(navigate, links);

  if (/^(?:enter|fill|submit|save|apply|create|update|delete|cancel|attach|search|filter)\b/i.test(clause)) {
    return {
      kind: /^(?:enter|fill)\b/i.test(clause) ? 'input' : 'submit',
      instruction: `${capitalize(clause.replace(/[.;]$/, ''))}.`,
      expectedResult: 'The stated action is completed as described in the requirement.',
    };
  }
  return null;
}

function workflowActions(source, links) {
  const clauses = source.split(CLAUSE_BREAK).map(tidy).filter(Boolean);
  return clauses.map((clause) => clauseAction(normalizeClause(clause), links)).filter(Boolean);
}

function dataInstruction(field, value) {
  if (value === '') return `Leave ${field} empty.`;
  if (value.startsWith('<') && value.endsWith('>')) return `Prepare ${value.slice(1, -1)} for ${field}.`;
  return `Enter ${JSON.stringify(value)} in ${field}.`;
}

function dataExpectedResult(field, value) {
  if (value === '') return `${field} is empty; other required fields use valid test data.`;
  return `The specified test value for ${field} is ready to be checked.`;
}

function firstSubmitControl(metadata) {
  return (metadata.controls || []).find((control) => control.type === 'submit' && !control.disabled);
}

function observedLinks(requirement) {
  return (requirement.generation?.pages || []).flatMap((page) =>
    (page.links || []).flatMap((link) => (safeUrl(link.url, page.url) ? [{ ...link, origin: page.title }] : [])),
  );
}

// Collects steps, warnings and notes, and enforces the step limit as they are added.
function stepCollector(testCase) {
  const qa = testCase.qa || {};
  const steps = [];
  const warnings = ['These are manual test instructions. No sign-in, navigation or test execution has been performed.'];
  const notes = [];

  const add = (instruction, expectedResult) => {
    const previous = steps.at(-1);
    const repeatsPrevious =
      previous &&
      tidy(previous.instruction).toLowerCase() === tidy(instruction).toLowerCase() &&
      previous.expectedResult === expectedResult;
    if (repeatsPrevious) return;
    if (steps.length < MAX_STEPS) {
      steps.push({ instruction: instruction.slice(0, MAX_TEXT), expectedResult: expectedResult.slice(0, MAX_TEXT) });
    } else {
      warnings.push('Only the first 50 steps are shown. Split this workflow into smaller test cases.');
    }
  };

  const finish = () => {
    const assumptions = unique([...(qa.assumptions || []), ...notes]);
    if (assumptions.length > MAX_ASSUMPTIONS) {
      warnings.push('Additional review notes could not fit in the case. Review the workflow before saving.');
    }
    return testStepOutputSchema.parse({
      steps,
      expectedResult: qa.expectedResult || steps.at(-1)?.expectedResult || '',
      assumptions: assumptions.slice(0, MAX_ASSUMPTIONS),
      warnings: unique(warnings),
    });
  };

  return { add, finish, warnings, notes };
}

function isCredentialCase(testCase, url, data) {
  if (/sign[ -]?in|log[ -]?in|credentials/i.test(testCase.name)) return true;
  const isLoginUrl = /\/(?:login|signin|sign-in)(?:[/?#]|$)/i.test(url);
  return isLoginUrl && data.some((item) => CREDENTIAL_FIELD.test(item.field));
}

function addLinkedOrExistingSteps({ collector, testCase, qa, existing, links }) {
  const { add, notes, warnings } = collector;
  const reference = matchKey(qa.requirementReference || testCase.name);
  const matches = links.filter((item) => {
    const name = matchKey(item.name).replace(/s$/, '');
    return name.length > 2 && reference.includes(name);
  });
  const link = unique(matches.map((item) => item.url)).length === 1 ? matches[0] : null;

  if (link) {
    add(`${link.origin ? `On the ${cleanLabel(link.origin)}, click` : 'Click'} ${link.name}.`, `The browser opens ${link.url}.`);
    add(`Verify that the browser has opened ${link.url}.`, `The browser is at ${link.url}.`);
    notes.push('The observed navigation link was matched to the case by its label. Confirm it is the intended path.');
  } else if (existing.length && !existing.some((step) => GENERIC_INSTRUCTION.test(step.instruction))) {
    for (const step of existing) add(step.instruction, step.expectedResult);
  } else {
    add(`Check the expected outcome for this test case: ${testCase.name}.`, qa.expectedResult || qa.requirementReference || 'The outcome matches the supplied requirement.');
    warnings.push('The navigation path is missing. Add the sign-in, buttons and destination page in Workflow details to get more specific steps.');
  }
}

/** Pure manual step generation. It never opens a browser or executes actions. */
export function generateRequirementTestSteps(requirement, testCase, rawWorkflow = '') {
  const workflow = workflowSchema.safeParse(rawWorkflow);
  if (!workflow.success) {
    throw Object.assign(new Error('Invalid workflow details.'), {
      userMessage: 'Keep Workflow details to 10,000 characters or fewer, then try again.',
    });
  }
  const url = safeUrl(requirement.url);
  if (!url) {
    throw Object.assign(new Error('Invalid application URL.'), {
      userMessage: 'Enter the full website address in the requirement, save it, and try again.',
    });
  }

  const qa = testCase.qa || {};
  const existing = (qa.manualSteps || []).map(({ instruction, expectedResult }) => ({
    instruction,
    expectedResult: expectedResult || qa.expectedResult || 'The stated outcome is observed.',
  }));
  const metadata =
    prepareGenerationInput({
      requirement: requirement.description || testCase.name,
      pageMetadata: requirement.pageMetadata,
    }).input.pageMetadata || {};

  const collector = stepCollector(testCase);
  const { add, finish, warnings, notes } = collector;
  const openInstruction = `Open the application at ${url}.`;

  // Review and planning scenarios keep what was authored.
  if (PLANNING_CATEGORIES.includes(qa.category) || /review (?:contradictory constraints|conflicting control)/i.test(testCase.name)) {
    for (const step of existing) add(step.instruction, step.expectedResult);
    if (!existing.length) {
      add(`Review the scenario described by ${testCase.name}.`, qa.expectedResult || 'The scenario and its prerequisites are agreed before execution.');
    }
    warnings.push('This case remains a review or planning scenario. It does not perform a security scan or load test.');
    return finish();
  }

  // Detailed authored steps stay as they are unless the user supplied a workflow.
  if (!workflow.data && existing.length > 1 && existing.every((step) => !GENERIC_INSTRUCTION.test(step.instruction))) {
    if (!/^(?:open|visit|navigate|launch)\b/i.test(existing[0].instruction)) add(openInstruction, OPEN_EXPECTED);
    for (const step of existing) add(step.instruction, step.expectedResult);
    return finish();
  }

  add(openInstruction, OPEN_EXPECTED);

  const source = workflow.data || requirement.description || qa.requirementReference || '';
  const links = observedLinks(requirement);
  let actions = workflowActions(source, links);
  if (actions.some((action) => action.ambiguous)) {
    warnings.push('More than one destination uses the same link label. Confirm the starting page and destination in Workflow details; an exact address was not chosen.');
  }

  const isConditional = CONDITIONAL_CATEGORIES.includes(qa.category);
  const data = qa.testData || [];
  if (isConditional && isCredentialCase(testCase, url, data)) {
    // Credential checks must reach the form without signing in successfully first.
    actions = [];
  } else if (isConditional) {
    const firstEntry = actions.findIndex((action) => ['input', 'submit'].includes(action.kind));
    if (firstEntry >= 0) actions = actions.slice(0, firstEntry);
  }

  // Test data is entered before the first submit action.
  const submitIndex = actions.findIndex((action) => action.kind === 'submit');
  const prefix = submitIndex >= 0 ? actions.slice(0, submitIndex) : actions;
  const suffix = submitIndex >= 0 ? actions.slice(submitIndex) : [];
  const submitControl = firstSubmitControl(metadata);

  for (const action of prefix) add(action.instruction, action.expectedResult);

  if (data.length) {
    const hasSignedIn = prefix.some((action) => action.kind === 'auth');
    for (const item of data) {
      if (hasSignedIn && !isConditional && CREDENTIAL_FIELD.test(item.field)) continue;
      const value = String(item.value);
      add(dataInstruction(item.field, value), dataExpectedResult(item.field, value));
    }
    if (isConditional) {
      const attempt = submitControl ? `Click ${submitControl.name} to attempt the workflow.` : 'Attempt the workflow action described in this test case.';
      add(attempt, qa.expectedResult || 'The supplied validation rule is enforced.');
      if (!submitControl) notes.push('No submission button was supplied. Confirm the action used to check the input before execution.');
    }
  }

  for (const action of suffix) {
    add(action.instruction, action.kind === 'submit' && qa.expectedResult ? qa.expectedResult : action.expectedResult);
  }

  const lastNavigation = actions.filter((action) => action.kind === 'navigate').at(-1);
  if (lastNavigation?.url && !actions.some((action) => action.kind === 'verify')) {
    add(`Verify that the browser has opened ${lastNavigation.url}.`, `The browser is at ${lastNavigation.url}.`);
  }

  if (!data.length && !actions.length) addLinkedOrExistingSteps({ collector, testCase, qa, existing, links });

  if (data.length && !isConditional && !suffix.length && submitControl && !actions.some((action) => action.kind === 'auth')) {
    add(`Click ${submitControl.name}.`, qa.expectedResult || 'The workflow completes with the supplied valid data.');
  }

  const outcomeIsNew =
    qa.expectedResult &&
    matchKey(qa.expectedResult) !== matchKey(requirement.description) &&
    !actions.some((action) => matchKey(action.expectedResult) === matchKey(qa.expectedResult));
  if (!data.length && actions.length && outcomeIsNew) {
    add(`Check the expected outcome for this case: ${qa.expectedResult}`, qa.expectedResult);
  }

  notes.push('The steps follow the supplied workflow and page information. Confirm page names, test accounts and expected outcomes before execution.');
  return finish();
}
