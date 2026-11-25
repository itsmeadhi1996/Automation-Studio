import { launchBrowser } from './browsers.mjs';
import { assert, resolveLocator } from './model.mjs';
import { waitForPageReady } from './page-readiness.mjs';
import { locator } from './runner.mjs';

const VIEWPORT = { width: 1440, height: 900 };
const GOTO_TIMEOUT_MS = 15000;
const BODY_TIMEOUT_MS = 5000;
const CONTROLS_TIMEOUT_MS = 3000;
const READY_TIMEOUT_MS = 10000;
const MAX_ELEMENTS = 100;
const MAX_FRAME_DEPTH = 10;
const MAX_TITLE_LENGTH = 180;
const INSPECTED_ELEMENTS =
  'input, textarea, select, button, a, [role="button"], h1, h2, h3, [role="heading"], [role="alert"], [aria-live]';
const FIRST_CONTROLS = 'input, textarea, select, button, a, [role="button"]';
const USABLE_CONTROLS = 'input, textarea, select, button, [role="button"]';
const FRAME_LOCATOR_TYPES = ['id', 'css', 'name', 'testId'];
const FRAME_ATTRIBUTES = { id: 'id', name: 'name', testId: 'data-testid' };
const OPERATIONAL_ERROR = /Timeout|net::/;
// Plain-language meanings of browser and HTTP failures, shown in the generation error window.
const BROWSER_ERRORS = [
  [/ERR_NAME_NOT_RESOLVED/, 'The website address could not be found. The domain name may be misspelled.'],
  [/ERR_CONNECTION_REFUSED/, 'The website refused the connection. The server may be down or the port may be wrong.'],
  [/ERR_CONNECTION_(?:TIMED_OUT|RESET|CLOSED)|ERR_TIMED_OUT/, 'The connection to the website was lost or timed out.'],
  [/ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED/, 'There is no network connection.'],
  [/ERR_CERT|SSL/, 'The website’s security certificate is not trusted.'],
  [/ERR_ABORTED/, 'The page stopped loading before it finished.'],
  [/Timeout/, 'The page took too long to load (more than 15 seconds).'],
];
const HTTP_MEANINGS = {
  400: 'bad request',
  401: 'login required',
  403: 'access denied',
  404: 'page not found',
  500: 'server error',
  502: 'bad gateway',
  503: 'service unavailable',
  504: 'gateway timeout',
};
const STORED_VALUE_MARKER = '[stored variable]';
const TARGET_FREE_ACTIONS = new Set(['navigate', 'url', 'heading', 'wait', 'screenshot', 'uiValidate']);
const OBSERVED_ACTIONS = new Set([
  'fill',
  'select',
  'check',
  'uncheck',
  'click',
  'hover',
  'doubleClick',
  'pressKey',
  'dateOnly',
  'dateTime',
  'visible',
  'text',
  'value',
]);
const PAGE_CHANGING_ACTIONS = new Set(['click', 'doubleClick', 'pressKey']);

// Runs in the browser. Locator values must never be shortened for display.
function describeElement(element) {
  const maxLocatorLength = 2000;
  const maxLabelLength = 180;
  const tag = element.tagName.toLowerCase();
  const isField = ['input', 'textarea', 'select'].includes(tag);
  const labelText = element.labels ? Array.from(element.labels).map((item) => item.textContent).join(' ') : '';
  const label = element.getAttribute('aria-label') || labelText;
  const text = isField ? '' : (element.textContent || '').trim();

  const candidates = [];
  const addCandidate = (locatorType, target) => {
    if (target && target.length <= maxLocatorLength) {
      candidates.push({ locatorType, target });
    }
  };
  addCandidate('testId', element.getAttribute('data-testid'));
  addCandidate('id', element.id);
  addCandidate('label', label);
  addCandidate('placeholder', element.getAttribute('placeholder'));
  addCandidate('name', element.getAttribute('name'));
  addCandidate('text', text);

  // Playwright descendant selectors also cross open shadow roots.
  const path = [];
  let node = element;
  while (node) {
    const parent = node.parentElement || node.getRootNode();
    const sameTagSiblings = Array.from(parent.children || []).filter((item) => item.tagName === node.tagName);
    path.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${sameTagSiblings.indexOf(node) + 1})`);
    if (node === element.ownerDocument.documentElement) {
      break;
    }
    node = node.parentElement || node.getRootNode().host;
  }
  addCandidate('css', path.join(' '));

  return {
    tag,
    type: element.getAttribute('type') || '',
    label: label.slice(0, maxLabelLength),
    text: text.slice(0, maxLabelLength),
    required: Boolean(element.required),
    disabled: Boolean(element.disabled),
    candidates,
  };
}

async function verifiedCandidate(page, handle, framePath, candidates) {
  for (const candidate of candidates) {
    const step = { ...candidate, framePath };
    try {
      const found = locator(page, step, []);
      if ((await found.count()) === 1 && (await found.evaluate((node, original) => node === original, handle))) {
        return step;
      }
    } catch {
      // The DOM can change between checks, so move on to the next candidate.
    }
  }
  return null;
}

function frameSelectors(candidates) {
  return candidates
    .filter((candidate) => FRAME_LOCATOR_TYPES.includes(candidate.locatorType))
    .map((candidate) => {
      if (candidate.locatorType === 'css') {
        return { locatorType: 'css', target: candidate.target };
      }
      const attribute = FRAME_ATTRIBUTES[candidate.locatorType];
      return { locatorType: 'css', target: `[${attribute}=${JSON.stringify(candidate.target)}]` };
    });
}

async function collectElements(page, handles, framePath, elements) {
  for (const handle of handles) {
    if (elements.length >= MAX_ELEMENTS) {
      return;
    }
    if (!(await handle.isVisible())) {
      continue;
    }
    const { candidates, ...details } = await handle.evaluate(describeElement);
    const verified = await verifiedCandidate(page, handle, framePath, candidates);
    if (verified) {
      const disabled = !(await handle.isEnabled());
      elements.push({ ...details, ...verified, disabled, matched: true, matchCount: 1 });
    }
  }
}

async function inspectFrame(page, frame, framePath, elements) {
  if (elements.length >= MAX_ELEMENTS) {
    return;
  }
  const handles = await frame.locator(INSPECTED_ELEMENTS).elementHandles();
  try {
    await collectElements(page, handles, framePath, elements);
  } finally {
    await Promise.allSettled(handles.map((handle) => handle.dispose()));
  }

  if (framePath.length >= MAX_FRAME_DEPTH) {
    return;
  }
  for (const child of frame.childFrames()) {
    const frameElement = await child.frameElement();
    try {
      const { candidates } = await frameElement.evaluate(describeElement);
      const verified = await verifiedCandidate(page, frameElement, framePath, frameSelectors(candidates));
      if (verified) {
        await inspectFrame(page, child, [...framePath, verified.target], elements);
      }
    } finally {
      await frameElement.dispose();
    }
  }
}

function hideStoredValues(project, input) {
  const storedValues = [
    ...Object.values(project.globalVariables),
    ...project.environments.flatMap((environment) => Object.values(environment.variables)),
  ]
    .filter((value) => typeof value === 'string' && value.length > 0)
    .sort((a, b) => b.length - a.length);

  const hide = (value) => {
    if (typeof value === 'string') {
      return storedValues.reduce((text, stored) => text.replaceAll(stored, STORED_VALUE_MARKER), value);
    }
    if (Array.isArray(value)) {
      return value.map(hide);
    }
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, hide(item)]));
    }
    return value;
  };
  return hide(input);
}

function sameLocator(a, b) {
  return (
    a.locatorType === b.locatorType &&
    a.target === b.target &&
    JSON.stringify(a.framePath) === JSON.stringify(b.framePath)
  );
}

function activeVariables(project) {
  return project.environments.find((item) => item.id === project.activeEnvironmentId)?.variables || {};
}

export function inspectionUrl(project, explicitUrl) {
  const value = explicitUrl || activeVariables(project).BASE_URL || project.globalVariables.BASE_URL;
  if (!value) {
    throw issueError('Include the target website URL in your description, or set BASE_URL in the selected environment.', {
      problem: 'Studio does not know which website to inspect.',
      expected: 'A full URL in your description, or a BASE_URL variable in the selected environment.',
      found: 'The description has no URL and BASE_URL is not set.',
      fix: 'Add the page URL (for example https://example.com/login) to your description, then generate again.',
    });
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw issueError('The target URL or BASE_URL is invalid. Use a full HTTP or HTTPS URL.', {
      problem: 'The website address is not a valid URL.',
      expected: 'A full address that starts with http:// or https://.',
      found: `“${String(value).slice(0, 200)}”`,
      fix: 'Correct the URL in your description or in BASE_URL, then generate again.',
    });
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw issueError('Use an HTTP or HTTPS target URL without embedded credentials.', {
      problem: url.username || url.password ? 'The website address contains a user name or password.' : 'The address is not a web page address.',
      expected: 'An http:// or https:// address without a user name or password in it.',
      found: url.username || url.password ? 'The address includes sign-in details.' : `The address starts with ${url.protocol}//.`,
      fix: 'Use a plain web address. Store credentials in variables instead.',
    });
  }
  return url.href;
}

async function openForInspection(page, url) {
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT_MS });
  await page.locator('body').waitFor({ timeout: BODY_TIMEOUT_MS });
  // A bounded wait lets client-rendered forms appear without waiting on analytics.
  await page
    .locator(FIRST_CONTROLS)
    .first()
    .waitFor({ state: 'attached', timeout: CONTROLS_TIMEOUT_MS })
    .catch(() => {});

  // Single-page apps often answer deep links with 404 yet render the real page.
  if (response && response.status() >= 400) {
    const status = response.status();
    const usable = status === 404 && (await page.locator(USABLE_CONTROLS).count()) > 0;
    if (!usable) {
      throw issueError(
        `The target website returned HTTP ${status} for ${url}. Check the URL (including the path) and access permissions.`,
        {
          problem: 'Studio could not open the website page.',
          expected: `The page ${url} loads normally.`,
          found: `The website answered with error ${status} (${HTTP_MEANINGS[status] || 'the page could not be served'}).`,
          fix: 'Check the URL, including the path, and that the page is available without special access.',
        },
      );
    }
  }
  await waitForPageReady(page, { timeout: READY_TIMEOUT_MS });
}

export async function inspectPage(project, explicitUrl) {
  const url = inspectionUrl(project, explicitUrl);
  let browser;
  try {
    browser = await launchBrowser(project.browser || 'chrome');
    const page = await browser.newPage({ viewport: VIEWPORT });
    await openForInspection(page, url);

    const snapshot = { title: (await page.title()).slice(0, MAX_TITLE_LENGTH), elements: [] };
    await inspectFrame(page, page.mainFrame(), [], snapshot.elements);
    if (!snapshot.elements.length) {
      throw issueError(
        'No uniquely locatable fields, buttons, links, or headings were found. The page may require login or may not have finished loading.',
        {
          problem: 'Studio opened the website but found nothing it could use in a test.',
          expected: `Visible fields, buttons, links or headings on ${url}.`,
          found: `The page${snapshot.title ? ` “${snapshot.title}”` : ''} has no visible controls that Studio can locate.`,
          fix: 'Check that the page does not need a login and has finished loading, or start from a different URL.',
        },
      );
    }

    const safeSnapshot = hideStoredValues(project, snapshot);
    // A selector altered by hiding a stored value would no longer find its element.
    safeSnapshot.elements = safeSnapshot.elements.filter((element, index) =>
      sameLocator(element, snapshot.elements[index]),
    );
    assert(
      safeSnapshot.elements.length,
      'No usable locators remain after protecting stored variable values. Review the page and variable configuration.',
    );
    return {
      ...safeSnapshot,
      scope:
        'Initial page only. No forms submitted and no actions executed. Later pages and login-only content have not been inspected.',
    };
  } catch (error) {
    if (OPERATIONAL_ERROR.test(error.message)) {
      const reason = BROWSER_ERRORS.find(([pattern]) => pattern.test(error.message))?.[1];
      throw issueError(
        'Could not inspect the target website. Check the URL, network access, and whether the page requires login.',
        {
          problem: 'Studio could not reach the website to inspect it.',
          expected: `The page ${url} opens in the browser.`,
          found: reason || 'The browser could not load the page.',
          fix: 'Check the URL, your network or VPN connection, and whether the page requires login.',
        },
      );
    }
    throw error;
  } finally {
    await browser?.close().catch(() => {});
  }
}

// Each failure carries a plain-language issue: what went wrong, what Studio expected and what it found.
function issueError(message, issue, code) {
  return Object.assign(new Error(message), { ...(code ? { code } : {}), issues: [issue] });
}

const LOCATOR_WORDS = {
  css: 'CSS selector',
  xpath: 'XPath',
  id: 'element ID',
  name: 'field name',
  text: 'text',
  label: 'label',
  placeholder: 'placeholder',
  testId: 'test ID',
  custom: 'custom locator',
  object: 'saved object',
};

function describeLocator({ locatorType, target }) {
  return `the ${LOCATOR_WORDS[locatorType] || 'locator'} “${String(target).slice(0, 120)}”`;
}

function describeControl(element) {
  const name = element.label || element.text || element.target;
  const kind = element.tag === 'input' ? `${element.type || 'text'} field` : element.tag;
  return `${kind} “${String(name).slice(0, 60)}”`;
}

function checkStepVariable(project, step, environment, prefix, number) {
  if (step.valueMode === 'static') {
    return;
  }
  const usesGlobals = step.valueMode === 'global';
  const variables = usesGlobals ? project.globalVariables : environment;
  const where = usesGlobals ? 'global variables' : 'the selected environment';
  if (Object.hasOwn(variables, step.value) && variables[step.value] !== '') return;
  throw issueError(`${prefix}: set ${step.value} in ${where}, then generate again.`, {
    step: number,
    problem: `The step uses the variable ${step.value}, but it has no value.`,
    expected: `${step.value} has a value in ${where}.`,
    found: Object.hasOwn(variables, step.value) ? `${step.value} exists but is empty.` : `${step.value} does not exist in ${where}.`,
    fix: `Add a value for ${step.value} in ${where}, then generate again.`,
  });
}

function checkUrlStep(project, step, environment, prefix, number) {
  let value = step.value;
  if (step.valueMode === 'global') {
    value = project.globalVariables[step.value];
  } else if (step.valueMode === 'environment') {
    value = environment[step.value];
  }
  const subject = step.action === 'url' ? 'URL check' : 'navigation';
  if (!value?.trim()) {
    throw issueError(`${prefix}: a URL is required.`, {
      step: number,
      problem: `The ${subject} step has no web address.`,
      expected: 'A full web address, such as https://example.com/login.',
      found: 'The address is empty.',
      fix: 'Include the full page URL in your description, then generate again.',
    });
  }
  try {
    inspectionUrl(project, value);
  } catch {
    // Models often put a page name or path here, which a regeneration can correct.
    throw issueError(
      `${prefix}: the ${subject} needs a full HTTP or HTTPS address. Include the full page URL in your description, then generate again.`,
      {
        step: number,
        problem: `The ${subject} step does not have a complete web address.`,
        expected: 'A full address that starts with http:// or https://, such as https://example.com/login.',
        found:
          step.valueMode === 'static'
            ? `“${String(value).slice(0, 200)}”`
            : `The variable ${step.value} does not hold a full web address.`,
        fix: 'Include the full page URL in your description, then generate again.',
      },
      'GENERATED_URL_INVALID',
    );
  }
}

function checkObservedControl(inspection, resolved, prefix, number) {
  const expectedFrames = JSON.stringify(resolved.framePath || (resolved.frame ? [resolved.frame] : []));
  const sameTarget = (element) => element.locatorType === resolved.locatorType && element.target === resolved.target;
  const observed = inspection.elements.find(
    (element) =>
      element.matched &&
      element.matchCount === 1 &&
      sameTarget(element) &&
      JSON.stringify(element.framePath || []) === expectedFrames,
  );
  if (observed && !observed.disabled) return;

  const available = inspection.elements.filter((element) => !element.disabled).slice(0, 6).map(describeControl);
  let found = `Nothing on the page matches ${describeLocator(resolved)}.`;
  if (observed?.disabled) found = `${describeControl(observed)} is on the page but is disabled.`;
  else if (inspection.elements.some((element) => sameTarget(element) && element.matchCount > 1)) {
    const { matchCount } = inspection.elements.find((element) => sameTarget(element) && element.matchCount > 1);
    found = `${matchCount} elements match ${describeLocator(resolved)}, so Studio cannot tell which one to use.`;
  } else if (inspection.elements.some(sameTarget)) {
    found = `${describeLocator(resolved)} is on the page, but inside a different frame.`;
  }
  if (!observed && available.length) found += ` Controls Studio did find: ${available.join(', ')}.`;
  throw issueError(
    `${prefix}: the generated locator was not observed as an available control on the initial page. Check the URL and describe the visible controls, then generate again.`,
    {
      step: number,
      problem: 'The AI picked a page element that Studio could not find on the inspected page.',
      expected: `Exactly one visible, enabled element matching ${describeLocator(resolved)}${inspection.title ? ` on “${inspection.title}”` : ''}.`,
      found,
      fix: 'Check the URL, and describe the controls using the names shown on the page, then generate again.',
    },
    'GENERATED_LOCATOR_NOT_OBSERVED',
  );
}

function checkStep(project, step, environment, number) {
  const prefix = `Step ${number}`;
  checkStepVariable(project, step, environment, prefix, number);
  if (!TARGET_FREE_ACTIONS.has(step.action) && !step.target.trim()) {
    throw issueError(
      `${prefix}: the model did not provide a locator. Add more detail to your description.`,
      {
        step: number,
        problem: `The “${step.action}” step does not say which element to use.`,
        expected: 'A field, button, link or text on the page for this step.',
        found: 'No element was given.',
        fix: 'Name the field or button for this action in your description, then generate again.',
      },
      'GENERATED_LOCATOR_MISSING',
    );
  }
  if (['css', 'custom'].includes(step.locatorType) && /^(?:ref=|aria-ref=)|\[ref=/i.test(step.target)) {
    throw issueError(`${prefix}: use a durable DOM locator instead of a temporary MCP element reference.`, {
      step: number,
      problem: 'The step uses a temporary element reference that only works during inspection.',
      expected: 'A lasting locator such as a label, text, ID or CSS selector.',
      found: `“${step.target.slice(0, 120)}”`,
      fix: 'Generate again. If it repeats, describe the element by its visible label.',
    });
  }
  if (step.locatorType === 'object' && !project.objects.some((item) => item.id === step.target)) {
    throw issueError(`${prefix}: the object repository reference does not exist.`, {
      step: number,
      problem: 'The step points to a saved object that is not in the object repository.',
      expected: 'An object that exists in this project’s object repository.',
      found: `No saved object has the ID “${step.target.slice(0, 120)}”.`,
      fix: 'Save the element to the object repository, or generate again.',
    });
  }
}

export function validateGeneratedTest(project, draft, inspection) {
  if (!draft.steps?.length) {
    throw issueError('The model returned no test steps. Describe the actions you want to test.', {
      problem: 'The AI did not return any test steps.',
      expected: 'At least one step, starting by opening the website.',
      found: 'No steps.',
      fix: 'Describe the actions you want to test, then generate again.',
    });
  }

  const environment = activeVariables(project);
  const warnings = [];
  const failures = [];
  let onInitialPage = Boolean(inspection);
  if (inspection && draft.steps[0].action !== 'navigate') {
    failures.push(
      issueError('The generated test must begin by navigating to the inspected website. Generate again.', {
        step: 1,
        problem: 'The test does not start by opening the website.',
        expected: 'Step 1 opens the inspected website (Navigate).',
        found: `Step 1 is “${draft.steps[0].action}”.`,
        fix: 'Generate again. Start your description with the page URL.',
      }),
    );
  }

  // Every step is checked so the user sees all problems at once, not only the first.
  for (const [index, step] of draft.steps.entries()) {
    const number = index + 1;
    if (index > 0 && step.action === 'navigate') {
      onInitialPage = false;
    }
    try {
      checkStep(project, step, environment, number);
      const resolved = resolveLocator(step, project.objects, project.locatorTemplates);
      if (step.action === 'navigate' || step.action === 'url') {
        checkUrlStep(project, step, environment, `Step ${number}`, number);
      }
      if (onInitialPage && OBSERVED_ACTIONS.has(step.action)) {
        checkObservedControl(inspection, resolved, `Step ${number}`, number);
      }
    } catch (error) {
      failures.push(error.issues ? error : Object.assign(error, { issues: [{ step: number, problem: error.message }] }));
    }
    if (inspection && !onInitialPage && step.target) {
      warnings.push(`Step ${number}: locator has not been verified on the later page. Review it in Debug before running.`);
    }
    if (PAGE_CHANGING_ACTIONS.has(step.action)) {
      onInitialPage = false;
    }
  }
  if (failures.length) {
    // The first failure keeps its message and code, so automatic correction works as before.
    throw Object.assign(failures[0], { issues: failures.flatMap((error) => error.issues) });
  }
  return warnings;
}
