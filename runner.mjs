import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect } from 'playwright/test';
import { launchBrowser } from './browsers.mjs';
import { queryDatabase } from './database.mjs';
import { collectLocalData, normalizeLocalData } from './local-data.mjs';
import { clearLocatorFocus, focusLocator, refocusLocator, screenshotPage } from './locator-focus.mjs';
import { assert, prepareRun, resolveLocator, resolveTarget, resolveValue } from './model.mjs';
import { loadingTimeout, recoverReadiness, waitAfterAction, waitForPageReady } from './page-readiness.mjs';

const VIEWPORT = { width: 1440, height: 900 };
const DEFAULT_STEP_TIMEOUT_MS = 10000;
const MAX_WAIT_MS = 60000;
const MAX_DIAGNOSTICS = 100;
const MAX_REDACTED_LENGTH = 8000;
const DEBUG_SLOW_MO_MS = 250;
const DEBUG_DEFAULT_TIMEOUT_MS = 10000;
const DEBUG_NAVIGATION_TIMEOUT_MS = 15000;
// screenshotPage clamps this through loadingTimeout, so the effective limit is 30 seconds.
const TARGET_SCREENSHOT_TIMEOUT_MS = 3000;

const CANCELLED_MESSAGE = 'Run cancelled';
const CANCELLED_BY_USER_MESSAGE = 'Run cancelled by user';
const WAIT_LIMIT_MESSAGE = 'Wait must be 0–60000 milliseconds';
const NO_STEPS_MESSAGE = 'This test case has no steps. Add at least one step, then run it again.';
const SENSITIVE_VALUE = /password|secret|token/i;

const replayTiming = Object.freeze({ slowMo: 350, highlightMs: 1000, stepPauseMs: 750 });

const TARGET_ACTIONS = new Set([
  'click',
  'hover',
  'doubleClick',
  'pressKey',
  'fill',
  'dateOnly',
  'dateTime',
  'select',
  'check',
  'uncheck',
  'visible',
  'text',
  'value',
]);
const TYPED_ACTIONS = new Set(['fill', 'dateOnly', 'dateTime']);
const NO_READINESS_ACTIONS = new Set(['navigate', 'wait', 'jdbcQuery', 'dbValidate']);
const LOCATOR_FREE_ACTIONS = new Set(['navigate', 'url', 'heading', 'wait', 'screenshot', 'jdbcQuery', 'dbValidate']);
const UNFINISHED_STATUSES = new Set(['pending', 'running']);
const FIELD_STATES = ['visible', 'hidden', 'enabled', 'disabled', 'checked', 'unchecked', 'empty', 'editable', 'readonly'];
const FIELD_STATE_RULE = new RegExp(`^(.+?)\\s*:\\s*(${FIELD_STATES.join('|')})\\s*$`, 'i');
const FIELD_CHECK_SEPARATOR = /\r?\n|(?<!\\);/;
const INVALID_CONTROLS =
  'input:invalid:visible, select:invalid:visible, textarea:invalid:visible, [role="alert"]:visible';

async function replayPause(milliseconds, signal) {
  if (signal?.aborted) {
    throw new Error(CANCELLED_MESSAGE);
  }
  await delay(milliseconds, undefined, { signal });
}

function sensitiveStepValues(test) {
  return test.steps.filter((step) => step.sensitive && step.valueMode === 'static').map((step) => step.value);
}

export function redact(message, context) {
  const values = [
    ...Object.values(context.globals || {}),
    ...Object.values(context.environment || {}),
    ...Object.values(context.data || {}),
    ...Object.values(context.local || {}),
    ...(context.secrets || []),
    context.profile?.password,
    ...(context.profiles || []).map((profile) => profile.password),
  ];
  const secrets = values
    .filter((value) => typeof value === 'string' && value.length > 0)
    .sort((a, b) => b.length - a.length);

  let text = String(message);
  for (const secret of secrets) {
    text = text.replaceAll(secret, '[redacted]');
  }
  return text.slice(0, MAX_REDACTED_LENGTH);
}

function publicRequestUrl(raw) {
  try {
    const url = new URL(raw);
    url.search = '';
    url.hash = '';
    url.username = '';
    url.password = '';
    return url;
  } catch {
    return null;
  }
}

function attachDiagnostics(page, entries, context) {
  const addEntry = (kind, message) => {
    if (entries.length < MAX_DIAGNOSTICS) {
      entries.push({ kind, message: redact(message, context), at: new Date().toISOString() });
    }
  };
  page.on('pageerror', (error) => addEntry('page-error', error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') {
      addEntry('console-error', message.text());
    }
  });
  page.on('requestfailed', (request) => {
    const url = publicRequestUrl(request.url());
    if (url) {
      addEntry('network-error', `${request.method()} ${url} ${request.failure()?.errorText || ''}`);
    }
  });
}

function httpUrl(value) {
  const url = new URL(value);
  assert(['http:', 'https:'].includes(url.protocol), 'URL must use HTTP or HTTPS');
  return value;
}

function checkLocalEntry(entry, runContext, published) {
  if (entry.source === 'database') {
    const profileExists = runContext.profiles.some((profile) => profile.id === entry.config.profileId);
    assert(profileExists, `${entry.name}: database connection not found`);
  }
  if (entry.source === 'global' || entry.source === 'environment') {
    const usesGlobals = entry.source === 'global';
    const values = usesGlobals ? runContext.globals : runContext.environment;
    const found =
      (usesGlobals && published.has(entry.config.variable)) || Object.hasOwn(values, entry.config.variable);
    assert(found, `${entry.name}: source variable not found`);
  }
}

function findLocalEntry(step, entries, published) {
  const entry = entries.find(
    (item) => item.name === step.value && (step.valueMode === 'local' || (step.valueMode === 'global' && item.keepGlobal)),
  );
  return entry || (step.valueMode === 'global' ? published.get(step.value) : undefined);
}

function checkStepDefinition(step, test, entries, published, runContext) {
  const entry = findLocalEntry(step, entries, published);
  const isDynamic = entry && entry.source !== 'manual';
  if (step.valueMode === 'local') {
    assert(entry, `Local variable not found: ${step.value}`);
  }
  const value = entry ? entry.value : resolveValue(step, { ...runContext, data: test.dataRow || {}, local: {} });

  if (!isDynamic && (step.action === 'navigate' || step.action === 'url')) {
    httpUrl(value);
  }
  const needsLocator = !LOCATOR_FREE_ACTIONS.has(step.action) && (step.action !== 'uiValidate' || step.target);
  if (needsLocator) {
    const target = resolveTarget(step, runContext.objects, runContext.locatorTemplates);
    assert(target?.trim(), 'A locator is required');
  }
  if (step.action === 'jdbcQuery' || step.action === 'dbValidate') {
    assert(runContext.profile, 'Select a database profile');
  }
  if (!isDynamic && step.action === 'wait') {
    assert(/^\d+$/.test(value) && Number(value) <= MAX_WAIT_MS, WAIT_LIMIT_MESSAGE);
  }
}

export function preflight(project, selector = {}) {
  const run = prepareRun(project, selector);
  const errors = [];
  const published = new Map();

  for (const test of run.tests) {
    if (!test.steps.length) {
      errors.push(`${test.name}: configure automation steps before execution`);
    }
    let entries;
    try {
      entries = normalizeLocalData(test.localTestData);
      for (const entry of entries) {
        checkLocalEntry(entry, run.context, published);
      }
    } catch (error) {
      errors.push(`${test.name}: ${error.message}`);
      continue;
    }
    for (const [index, step] of test.steps.entries()) {
      try {
        checkStepDefinition(step, test, entries, published, run.context);
      } catch (error) {
        errors.push(`${test.name}, step ${index + 1}: ${error.message}`);
      }
    }
    for (const entry of entries) {
      if (entry.keepGlobal) {
        published.set(entry.name, entry);
      }
    }
  }

  return {
    ok: !errors.length,
    errors,
    browser: run.browser,
    testCount: run.tests.length,
    stepCount: run.tests.reduce((total, test) => total + test.steps.length, 0),
  };
}

export function locator(page, step, objects, templates = []) {
  const resolved = resolveLocator(step, objects, templates);
  const { target } = resolved;

  let scope = page;
  for (const frame of resolved.framePath || (resolved.frame ? [resolved.frame] : [])) {
    scope = scope.frameLocator(frame);
  }
  if (resolved.container) {
    scope = scope.locator(resolved.container);
  }

  switch (resolved.locatorType) {
    case 'xpath':
      return scope.locator(target.startsWith('xpath=') ? target : `xpath=${target}`);
    case 'id':
      return scope.locator(`[id=${JSON.stringify(target)}]`);
    case 'name':
      return scope.locator(`[name=${JSON.stringify(target)}]`);
    case 'text':
      return scope.getByText(target, { exact: true });
    case 'label':
      return scope.getByLabel(target, { exact: true });
    case 'placeholder':
      return scope.getByPlaceholder(target, { exact: true });
    case 'testId':
      return scope.getByTestId(target);
    default:
      return scope.locator(target);
  }
}

function stepEvidence(page, step, artifacts, fileName) {
  let focusedHandle;
  let targetImageCount = 0;

  return {
    async onLocator(handle) {
      await focusedHandle?.dispose().catch(() => {});
      focusedHandle = handle;
      targetImageCount += 1;
      const targetFile = fileName.replace(/\.png$/, `-target-${targetImageCount}.png`);
      try {
        await screenshotPage(page, {
          path: path.join(artifacts, targetFile),
          fullPage: false,
          timeout: TARGET_SCREENSHOT_TIMEOUT_MS,
        });
        step.targetScreenshots ||= [];
        step.targetScreenshots.push(targetFile);
      } catch {
        step.screenshotWarning = 'Could not save the locator screenshot.';
      }
    },

    async finish() {
      try {
        // Reuse the original handle. After a navigation, resolving the selector again
        // could highlight an unrelated element that happens to match.
        if (focusedHandle) {
          await refocusLocator(focusedHandle).catch(() => false);
        }
        await screenshotPage(page, {
          path: path.join(artifacts, fileName),
          fullPage: step.action === 'screenshot',
          timeout: step.timeoutMs,
          waitForReady: step.status !== 'failed',
        });
        step.screenshot = fileName;
        if (step.status === 'failed') {
          step.screenshotWarning = 'Diagnostic screenshot after failure; the page may still be loading.';
        }
      } catch {
        step.screenshotWarning = 'Could not save the page screenshot.';
        if (step.action === 'screenshot' && step.status === 'passed') {
          step.status = 'failed';
          step.error = 'The requested screenshot could not be captured after waiting for the page to load.';
        }
      } finally {
        await focusedHandle?.dispose().catch(() => {});
      }
    },
  };
}

export function parseFieldChecks(text) {
  const sources = String(text)
    .split(FIELD_CHECK_SEPARATOR)
    .map((part) => part.replace(/\\;/g, ';').trim())
    .filter(Boolean);

  return sources.map((source) => {
    const stateMatch = source.match(FIELD_STATE_RULE);
    if (stateMatch) {
      return { source, key: stateMatch[1].trim(), op: ':', expected: stateMatch[2].toLowerCase() };
    }
    const operatorIndex = source.search(/[=~]/);
    assert(
      operatorIndex > 0,
      `Use Field = expected; Field ~ contains; Field : ${FIELD_STATES.join('|')}; Heading = title; URL = https://…`,
    );
    return {
      source,
      key: source.slice(0, operatorIndex).trim(),
      op: source[operatorIndex],
      expected: source.slice(operatorIndex + 1).trim(),
    };
  });
}

function checkFieldState(field, state, check) {
  switch (state) {
    case 'visible':
      return check(field).toBeVisible();
    case 'enabled':
      return check(field).toBeEnabled();
    case 'disabled':
      return check(field).toBeDisabled();
    case 'checked':
      return check(field).toBeChecked();
    case 'unchecked':
      return check(field).not.toBeChecked();
    case 'empty':
      return check(field).toBeEmpty();
    case 'editable':
      return check(field).toBeEditable();
    default:
      return check(field).not.toBeEditable();
  }
}

async function validateField(scope, { key, op, expected }, check, focus) {
  const quotedKey = JSON.stringify(key);
  const field = scope
    .getByLabel(key, { exact: true })
    .or(scope.getByPlaceholder(key, { exact: true }))
    .or(scope.locator(`[name=${quotedKey}], [id=${quotedKey}]`))
    .first();

  if (op === ':' && expected === 'hidden') {
    return check(field).toBeHidden();
  }
  await check(field).toBeVisible();
  await focus(field);
  if (op === ':') {
    return checkFieldState(field, expected, check);
  }

  const isInput = await field.evaluate((node) => node.matches('input,textarea,select'));
  if (op === '=') {
    return isInput ? check(field).toHaveValue(expected) : check(field).toHaveText(expected);
  }
  const literal = new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return isInput ? check(field).toHaveValue(literal) : check(field).toContainText(expected);
}

async function runFieldCheck(rule, page, scope, check, focus) {
  const key = rule.key.toLowerCase();
  if (key === 'url' && rule.op === '=') {
    await check(page).toHaveURL(httpUrl(rule.expected));
  } else if (key === 'heading' && rule.op === '=') {
    await focus(scope.getByRole('heading', { name: rule.expected, exact: true }));
  } else {
    await validateField(scope, rule, check, focus);
  }
}

async function runUiValidation({ page, step, value, check, focus, target }) {
  const scope = step.target ? target() : page.locator('body');
  await focus(scope);

  if (!String(value ?? '').trim()) {
    await check(scope).toContainText(/\S/);
    await check(scope.locator(INVALID_CONTROLS)).toHaveCount(0);
    return;
  }

  const failures = [];
  for (const rule of parseFieldChecks(value)) {
    try {
      await runFieldCheck(rule, page, scope, check, focus);
    } catch (error) {
      failures.push(`${rule.source} -> ${String(error.message).split('\n')[0]}`);
    }
  }
  assert(!failures.length, `${failures.length} field check(s) failed: ${failures.join(' | ')}`);
}

async function runDatabaseStep(step, value, profile) {
  assert(profile, 'Select a database profile first');
  const result = await queryDatabase(profile, value);
  step.jdbcResult = result;
  if (step.action !== 'dbValidate') {
    return;
  }
  assert(!result.truncated && !result.valueTruncated, 'Cannot validate truncated results');
  assert(Array.isArray(step.expectedRows), 'Configure expected rows first');
  const actualRows = result.rows.map((row) => row.map((cell) => cell ?? 'NULL'));
  assert(JSON.stringify(actualRows) === JSON.stringify(step.expectedRows), 'Database results do not match expected rows');
}

async function runAction(tools) {
  const { page, step, value, check, focus, perform, target, context } = tools;
  switch (step.action) {
    case 'navigate':
      await perform(() => page.goto(httpUrl(value), { waitUntil: 'commit' }));
      break;
    case 'url':
      await check(page).toHaveURL(httpUrl(value));
      break;
    case 'click':
      await perform(() => target().click());
      break;
    case 'hover':
      await perform(() => target().hover());
      break;
    case 'doubleClick':
      await perform(() => target().dblclick());
      break;
    case 'pressKey':
      await perform(() => target().press(value));
      break;
    case 'uploadFile':
      await perform(() => target().setInputFiles(value));
      break;
    case 'fill':
    case 'dateOnly':
    case 'dateTime':
      await perform(() => target().fill(value));
      break;
    case 'select':
      await perform(() => target().selectOption(step.selectValues || value));
      break;
    case 'check':
      await perform(() => target().check());
      break;
    case 'uncheck':
      await perform(() => target().uncheck());
      break;
    case 'visible':
      await target().waitFor({ state: 'visible' });
      break;
    case 'text':
      await check(target()).toContainText(value);
      break;
    case 'value':
      await check(target()).toHaveValue(value);
      break;
    case 'hidden':
      await check(target()).toBeHidden();
      break;
    case 'heading':
      await focus(page.getByRole('heading', { name: value, exact: true }));
      break;
    case 'wait':
      assert(/^\d+$/.test(value) && Number(value) <= MAX_WAIT_MS, WAIT_LIMIT_MESSAGE);
      await page.waitForTimeout(Number(value));
      break;
    case 'screenshot':
      // The step's evidence capture takes the full-page image.
      break;
    case 'jdbcQuery':
    case 'dbValidate':
      await runDatabaseStep(step, value, context.profile);
      break;
    case 'uiValidate':
      await runUiValidation(tools);
      break;
    default:
      throw new Error(`Unsupported action: ${step.action}`);
  }
}

export async function executeStep(page, step, context) {
  const value = resolveValue(step, context);
  const timeout = step.timeoutMs || context.timeoutMs || DEFAULT_STEP_TIMEOUT_MS;
  const loadingAllowance = loadingTimeout(timeout);
  // An explicit step timeout stays a hard limit. Ordinary steps get the loading allowance.
  const stepLimit = step.timeoutMs || loadingAllowance;
  const retryPreparation = !step.timeoutMs;

  page.setDefaultTimeout(stepLimit);
  page.setDefaultNavigationTimeout(loadingAllowance);
  const check = expect.configure({ timeout: stepLimit });
  const target = () => locator(page, step, context.objects, context.locatorTemplates);

  const focus = async (focusTarget) => {
    const handle = await recoverReadiness((wait) => focusLocator(page, focusTarget, { timeout: wait }), timeout, {
      retry: retryPreparation,
    });
    if (context.onLocator) {
      await context.onLocator(handle);
    } else {
      await handle.dispose();
    }
    // Hold the outline before a click, fill or navigation can remove it.
    if (context.replay) {
      await replayPause(context.replay.highlightMs, context.signal);
    }
  };
  const perform = (action) =>
    waitAfterAction(page, action, {
      timeout: stepLimit,
      mode: step.waitAfter || 'auto',
      url: step.waitForUrl || '',
    });

  await clearLocatorFocus(page);
  if (!NO_READINESS_ACTIONS.has(step.action)) {
    await waitForPageReady(page, { timeout: loadingAllowance });
  }
  if (TARGET_ACTIONS.has(step.action)) {
    await recoverReadiness((wait) => target().waitFor({ state: 'visible', timeout: wait }), timeout, {
      retry: retryPreparation,
    });
    const typesSensitiveValue = TYPED_ACTIONS.has(step.action) && SENSITIVE_VALUE.test(step.value);
    if (step.sensitive || typesSensitiveValue) {
      await target().evaluate((node) => node.setAttribute('data-studio-sensitive', 'true'));
    }
    await focus(target());
  }
  // File inputs are often hidden, and those can still receive files.
  if (step.action === 'uploadFile' && (await target().isVisible())) {
    await focus(target());
  }

  await runAction({ page, step, value, check, focus, perform, target, context });
}

export async function initializeLocalData(run, test, options = {}) {
  const { local, globals } = await collectLocalData(test.localTestData || [], run.context, options);
  if (options.signal?.aborted) {
    throw new Error(CANCELLED_MESSAGE);
  }
  test.localValues = local;
  Object.assign(run.context.globals, globals);
  if (Object.keys(globals).length) {
    await options.onGlobals?.(globals);
  }
  return local;
}

async function pageForStep(step, pages, currentPage, runTimeout) {
  if (step.pageIndex === undefined) {
    return currentPage;
  }
  const timeout = step.timeoutMs || loadingTimeout(runTimeout);
  await expect.poll(() => pages.length, { timeout }).toBeGreaterThan(step.pageIndex);
  return pages[step.pageIndex];
}

async function runSteps(run, test, firstPage, pages, executionContext, artifacts) {
  const { signal } = executionContext;
  let page = firstPage;

  for (const [index, step] of test.steps.entries()) {
    const stepStartedAt = Date.now();
    const fileName = `${run.id}-${test.id}-${index}.png`;
    let evidence;
    step.status = 'running';

    try {
      if (signal?.aborted) {
        throw new Error(CANCELLED_MESSAGE);
      }
      page = await pageForStep(step, pages, page, run.timeoutMs);
      if (run.replay) {
        await page.bringToFront();
      }
      evidence = stepEvidence(page, step, artifacts, fileName);
      await executeStep(page, step, { ...executionContext, onLocator: evidence.onLocator });
      step.status = 'passed';
    } catch (error) {
      step.status = 'failed';
      step.error = redact(error.message, executionContext);
      test.error = step.error;
    }

    step.duration = Date.now() - stepStartedAt;
    evidence ||= stepEvidence(page, step, artifacts, fileName);
    await evidence.finish();

    if (run.replay) {
      await replayPause(replayTiming.stepPauseMs, signal);
    }
    if (step.status === 'failed') {
      test.error = step.error;
      break;
    }
  }
}

async function stopTracing(run, test, browserContext, artifacts) {
  const traceFile = `${run.id}-${test.id}.zip`;
  try {
    await browserContext.tracing.stop({ path: path.join(artifacts, traceFile) });
    test.trace = traceFile;
  } catch {
    // A missing trace must not change the outcome of the test.
  }
}

async function runTest(run, test, browser, artifacts, options) {
  const { signal } = options;
  const startedAt = Date.now();
  test.status = 'running';

  if (!test.steps.length) {
    test.status = 'failed';
    test.error = NO_STEPS_MESSAGE;
    test.duration = Date.now() - startedAt;
    return;
  }

  let browserContext;
  try {
    await initializeLocalData(run, test, options);
    browserContext = await browser.newContext({ viewport: VIEWPORT });
    if (run.trace) {
      await browserContext.tracing.start({ screenshots: true, snapshots: true, sources: false });
    }

    // Registered before newPage so that pages[0] is the first page.
    const pages = [];
    browserContext.on('page', (opened) => pages.push(opened));
    const firstPage = await browserContext.newPage();

    const executionContext = {
      ...run.context,
      signal,
      replay: run.replay ? replayTiming : null,
      local: test.localValues || {},
      data: test.dataRow || {},
      timeoutMs: run.timeoutMs,
      secrets: sensitiveStepValues(test),
    };
    test.diagnostics = [];
    browserContext.on('page', (opened) => attachDiagnostics(opened, test.diagnostics, executionContext));
    attachDiagnostics(firstPage, test.diagnostics, executionContext);

    await runSteps(run, test, firstPage, pages, executionContext, artifacts);
    test.status = test.steps.some((step) => step.status === 'failed') ? 'failed' : 'passed';
  } catch (error) {
    test.status = 'failed';
    test.error = redact(error.message, { ...run.context, local: test.localValues || {} });
  } finally {
    for (const step of test.steps) {
      if (UNFINISHED_STATUSES.has(step.status)) {
        step.status = 'skipped';
      }
    }
    test.duration = Date.now() - startedAt;
    if (run.trace && browserContext) {
      await stopTracing(run, test, browserContext, artifacts);
    }
    await browserContext?.close().catch(() => {});
  }
}

function skipUnfinishedWork(run) {
  for (const test of run.tests) {
    if (UNFINISHED_STATUSES.has(test.status)) {
      test.status = 'skipped';
    }
    for (const step of test.steps) {
      if (UNFINISHED_STATUSES.has(step.status)) {
        step.status = 'skipped';
      }
    }
  }
}

function markRunCancelled(run) {
  run.status = 'interrupted';
  run.error = CANCELLED_BY_USER_MESSAGE;
  for (const test of run.tests) {
    if (test.status !== 'failed' && test.status !== 'running') {
      continue;
    }
    test.status = 'interrupted';
    for (const step of test.steps) {
      if (step.status === 'failed' || step.status === 'running') {
        step.status = 'interrupted';
        step.error = CANCELLED_BY_USER_MESSAGE;
      }
    }
  }
}

export async function executeRun(
  run,
  artifacts,
  { signal, readUpload, onGlobals, query, browserLauncher = launchBrowser } = {},
) {
  const startedAt = Date.now();
  let browser;
  const closeBrowserOnAbort = () => {
    void browser?.close().catch(() => {});
  };
  signal?.addEventListener('abort', closeBrowserOnAbort, { once: true });

  try {
    browser = await browserLauncher(run.browser || 'chrome', {
      headless: !run.replay,
      slowMo: run.replay ? replayTiming.slowMo : 0,
    });
    if (signal?.aborted) {
      throw new Error(CANCELLED_MESSAGE);
    }
    // One failed test never stops the ones after it.
    for (const test of run.tests) {
      if (signal?.aborted) {
        break;
      }
      await runTest(run, test, browser, artifacts, { signal, readUpload, onGlobals, query });
    }
    run.status = run.tests.every((test) => test.status === 'passed') ? 'passed' : 'failed';
  } catch (error) {
    run.status = 'failed';
    run.error = error.message;
  } finally {
    skipUnfinishedWork(run);
    if (signal?.aborted) {
      markRunCancelled(run);
    }
    signal?.removeEventListener('abort', closeBrowserOnAbort);
    await browser?.close().catch(() => {});
    run.duration = Date.now() - startedAt;
  }
}

function urlWithoutSecrets(raw) {
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return raw;
  }
}

export class DebugSession {
  constructor(run, browser, context, page, artifacts) {
    this.run = run;
    this.browser = browser;
    this.context = context;
    this.page = page;
    this.artifacts = artifacts;
    this.index = 0;
    this.lastStepIndex = -1;
    this.busy = false;
    this.closed = false;
    this.pages = [page];
    context.on('page', (opened) => this.pages.push(opened));
  }

  summary() {
    const test = this.run.tests[0];
    const step = this.lastStepIndex < 0 ? null : test.steps[this.lastStepIndex];
    const isRunning = this.run.status === 'running';
    return {
      id: this.run.id,
      runId: this.run.id,
      projectId: this.run.projectId,
      testId: test.id,
      testName: test.name,
      status: this.run.status,
      stepIndex: this.index,
      stepCount: test.steps.length,
      currentStep: step
        ? {
            name: step.name,
            action: step.action,
            status: step.status,
            error: step.error || null,
            screenshot: step.screenshot || null,
            targetScreenshots: step.targetScreenshots || [],
            screenshotWarning: step.screenshotWarning || null,
          }
        : null,
      nextStep: isRunning ? test.steps[this.index]?.name || null : null,
      pageUrl: urlWithoutSecrets(this.page.url()),
      error: test.error || this.run.error || null,
      browser: this.run.browser,
    };
  }

  async step() {
    assert(!this.closed, 'Debug session is closed');
    assert(!this.busy, 'A debug step is already running.');
    this.busy = true;
    try {
      return await this.advance();
    } finally {
      this.busy = false;
    }
  }

  async advance() {
    const { run } = this;
    const test = run.tests[0];
    const step = test.steps[this.index];
    assert(run.status === 'running' && step, 'There are no more steps to debug. Close this session.');

    this.lastStepIndex = this.index;
    const stepStartedAt = Date.now();
    const fileName = `${run.id}-${test.id}-${this.index}.png`;
    const values = { local: test.localValues || {}, data: test.dataRow || {} };
    let evidence;
    step.status = 'running';

    try {
      this.page = await pageForStep(step, this.pages, this.page, run.timeoutMs);
      evidence = stepEvidence(this.page, step, this.artifacts, fileName);
      await executeStep(this.page, step, {
        onLocator: evidence.onLocator,
        ...run.context,
        ...values,
        timeoutMs: run.timeoutMs,
      });
      if (this.closed) {
        return this.summary();
      }
      step.status = 'passed';
    } catch (error) {
      if (this.closed) {
        return this.summary();
      }
      step.status = 'failed';
      step.error = redact(error.message, { ...run.context, ...values, secrets: sensitiveStepValues(test) });
      test.error = step.error;
      test.status = 'failed';
      run.status = 'failed';
    }

    step.duration = Date.now() - stepStartedAt;
    evidence ||= stepEvidence(this.page, step, this.artifacts, fileName);
    await evidence.finish();

    if (step.status === 'failed') {
      test.error = step.error;
      test.status = 'failed';
      run.status = 'failed';
    } else if (step.status === 'passed') {
      this.index += 1;
      if (this.index === test.steps.length) {
        test.status = 'passed';
        test.duration = Date.now() - Date.parse(run.startedAt);
        run.status = 'passed';
        run.duration = test.duration;
      }
    }
    return this.summary();
  }

  async close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const { run } = this;
    const test = run.tests[0];
    const elapsed = Date.now() - Date.parse(run.startedAt);

    if (run.status === 'running') {
      run.status = 'interrupted';
      test.status = 'interrupted';
      for (const step of test.steps) {
        if (UNFINISHED_STATUSES.has(step.status)) {
          step.status = 'skipped';
        }
      }
      test.duration = elapsed;
      run.duration = elapsed;
    } else {
      test.duration ??= elapsed;
      run.duration ??= elapsed;
    }

    await this.context.close().catch(() => {});
    await this.browser.close().catch(() => {});
  }
}

export async function startDebugSession(project, testId, artifacts, options = {}) {
  const run = prepareRun(project, { testId });
  let browser;
  let context;
  try {
    await initializeLocalData(run, run.tests[0], options);
    browser = await launchBrowser(run.browser, { headless: false, slowMo: DEBUG_SLOW_MO_MS });
    context = await browser.newContext({ viewport: VIEWPORT });
    const page = await context.newPage();
    page.setDefaultTimeout(DEBUG_DEFAULT_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(DEBUG_NAVIGATION_TIMEOUT_MS);
    return new DebugSession(run, browser, context, page, artifacts);
  } catch (error) {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    throw error;
  }
}
