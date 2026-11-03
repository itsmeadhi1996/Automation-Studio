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
  assert(value, 'Include the target website URL in your description, or set BASE_URL in the selected environment.');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('The target URL or BASE_URL is invalid. Use a full HTTP or HTTPS URL.');
  }
  assert(
    ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password,
    'Use an HTTP or HTTPS target URL without embedded credentials.',
  );
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
    assert(
      usable,
      `The target website returned HTTP ${status} for ${url}. Check the URL (including the path) and access permissions.`,
    );
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
    assert(
      snapshot.elements.length,
      'No uniquely locatable fields, buttons, links, or headings were found. The page may require login or may not have finished loading.',
    );

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
      throw new Error(
        'Could not inspect the target website. Check the URL, network access, and whether the page requires login.',
      );
    }
    throw error;
  } finally {
    await browser?.close().catch(() => {});
  }
}

function codedError(message, code) {
  return Object.assign(new Error(message), { code });
}

function checkStepVariable(project, step, environment, prefix) {
  if (step.valueMode === 'static') {
    return;
  }
  const usesGlobals = step.valueMode === 'global';
  const variables = usesGlobals ? project.globalVariables : environment;
  const where = usesGlobals ? 'global variables' : 'the selected environment';
  assert(
    Object.hasOwn(variables, step.value) && variables[step.value] !== '',
    `${prefix}: set ${step.value} in ${where}, then generate again.`,
  );
}

function checkUrlStep(project, step, environment, prefix) {
  let value = step.value;
  if (step.valueMode === 'global') {
    value = project.globalVariables[step.value];
  } else if (step.valueMode === 'environment') {
    value = environment[step.value];
  }
  assert(value?.trim(), `${prefix}: a URL is required.`);
  try {
    inspectionUrl(project, value);
  } catch {
    // Models often put a page name or path here, which a regeneration can correct.
    const subject = step.action === 'url' ? 'URL check' : 'navigation';
    throw codedError(
      `${prefix}: the ${subject} needs a full HTTP or HTTPS address. Include the full page URL in your description, then generate again.`,
      'GENERATED_URL_INVALID',
    );
  }
}

function checkObservedControl(inspection, resolved, prefix) {
  const expectedFrames = JSON.stringify(resolved.framePath || (resolved.frame ? [resolved.frame] : []));
  const observed = inspection.elements.find(
    (element) =>
      element.matched &&
      element.matchCount === 1 &&
      element.locatorType === resolved.locatorType &&
      element.target === resolved.target &&
      JSON.stringify(element.framePath || []) === expectedFrames,
  );
  if (!observed || observed.disabled) {
    throw codedError(
      `${prefix}: the generated locator was not observed as an available control on the initial page. Check the URL and describe the visible controls, then generate again.`,
      'GENERATED_LOCATOR_NOT_OBSERVED',
    );
  }
}

export function validateGeneratedTest(project, draft, inspection) {
  assert(draft.steps?.length > 0, 'The model returned no test steps. Describe the actions you want to test.');
  if (inspection) {
    assert(
      draft.steps[0].action === 'navigate',
      'The generated test must begin by navigating to the inspected website. Generate again.',
    );
  }

  const environment = activeVariables(project);
  const warnings = [];
  let onInitialPage = Boolean(inspection);

  for (const [index, step] of draft.steps.entries()) {
    const prefix = `Step ${index + 1}`;
    checkStepVariable(project, step, environment, prefix);
    assert(
      TARGET_FREE_ACTIONS.has(step.action) || step.target.trim(),
      `${prefix}: the model did not provide a locator. Add more detail to your description.`,
    );
    assert(
      !['css', 'custom'].includes(step.locatorType) || !/^(?:ref=|aria-ref=)|\[ref=/i.test(step.target),
      `${prefix}: use a durable DOM locator instead of a temporary MCP element reference.`,
    );
    if (step.locatorType === 'object') {
      assert(
        project.objects.some((item) => item.id === step.target),
        `${prefix}: the object repository reference does not exist.`,
      );
    }
    const resolved = resolveLocator(step, project.objects, project.locatorTemplates);

    if (step.action === 'navigate' || step.action === 'url') {
      checkUrlStep(project, step, environment, prefix);
    }
    if (index > 0 && step.action === 'navigate') {
      onInitialPage = false;
    }
    if (onInitialPage && OBSERVED_ACTIONS.has(step.action)) {
      checkObservedControl(inspection, resolved, prefix);
    }
    if (inspection && !onInitialPage && step.target) {
      warnings.push(`${prefix}: locator has not been verified on the later page. Review it in Debug before running.`);
    }
    if (PAGE_CHANGING_ACTIONS.has(step.action)) {
      onInitialPage = false;
    }
  }
  return warnings;
}
