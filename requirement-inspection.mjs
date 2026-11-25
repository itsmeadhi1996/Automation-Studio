import { checkpoint } from './agent-workflow.mjs';
import { launchBrowser } from './browsers.mjs';
import { waitForPageReady } from './page-readiness.mjs';
import { requirementUrl } from './requirements.mjs';

const DEADLINE_MS = 60000;
const MAX_PAGES = 6;
const MAX_QUEUE = 30;
const MAX_WARNINGS = 10;
const MAX_WARNING_DETAIL = 500;
const NAVIGATION_TIMEOUT_MS = 15000;
const CONTENT_TIMEOUT_MS = 25000;
const RENDER_TIMEOUT_MS = 10000;
const FOLLOWED_PAGE_RENDER_TIMEOUT_MS = 2000;
const READINESS_TIMEOUT_MS = 5000;
const CONTROL_SELECTOR = 'input,textarea,select,button,a,[role="button"],[role="checkbox"],[role="tab"]';
const UNSAFE_LINK = /logout|log-out|signout|sign-out|delete|remove|destroy|unsubscribe|checkout|purchase|confirm|activate|reset|token|secret|download/i;
const FILE_LINK = /\.(pdf|zip|png|jpe?g|gif|exe|csv|xlsx?|docx?)$/i;

// Runs in the browser, so it cannot use anything from this module. Collects structure and
// constraints, never entered values.
function pageStructure(controlSelector) {
  const isVisible = (el) => Boolean(el.getClientRects().length) && getComputedStyle(el).visibility !== 'hidden';
  const clean = (value) =>
    String(value || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 180);
  const forms = [...document.forms];
  const controlLabel = (el) =>
    el.getAttribute('aria-label') ||
    [...(el.labels || [])].map((label) => label.textContent).join(' ') ||
    el.getAttribute('placeholder') ||
    el.textContent ||
    el.getAttribute('name') ||
    el.id;

  const controls = [...document.querySelectorAll(controlSelector)]
    .filter(isVisible)
    .slice(0, 100)
    .map((el, index) => ({
      id: `control-${index + 1}`,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || '',
      type: el.type || el.getAttribute('type') || '',
      label: clean(controlLabel(el)),
      required: Boolean(el.required || el.getAttribute('aria-required') === 'true'),
      disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'),
      min: el.getAttribute('min'),
      max: el.getAttribute('max'),
      step: el.getAttribute('step'),
      minLength: el.getAttribute('minlength'),
      maxLength: el.getAttribute('maxlength'),
      pattern: el.getAttribute('pattern')?.slice(0, 500) || '',
      options: el.tagName === 'SELECT' ? [...el.options].slice(0, 30).map((option) => clean(option.textContent)) : [],
      form: el.form ? forms.indexOf(el.form) : null,
      href: el.tagName === 'A' ? el.href : '',
    }));

  return {
    title: clean(document.title),
    headings: [...document.querySelectorAll('h1,h2,h3,[role="heading"]')]
      .filter(isVisible)
      .slice(0, 25)
      .map((el) => clean(el.textContent)),
    controls,
    forms: forms.slice(0, 20).map((form, index) => ({
      id: index,
      name: clean(form.getAttribute('aria-label') || form.id || `Form ${index + 1}`),
      method: form.method,
      action: form.action,
    })),
    truncated: document.querySelectorAll('input,textarea,select,button,a,[role="button"]').length > 100,
  };
}

// Runs in the browser. Client-rendered pages have no controls until their scripts finish.
function hasVisibleControl(controlSelector) {
  return [...document.querySelectorAll(controlSelector)].some(
    (el) => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden',
  );
}

const ignoringTimeout = (error) => {
  if (error.name !== 'TimeoutError' && error.name !== 'PageReadinessError') throw error;
};

// A server response proves the URL opens, even if a slow script then holds the page back.
// The page may recover on a second request, and is otherwise inspected as far as it loaded.
async function openPage(page, url, { attempts, contentTimeout, remaining }) {
  for (let attempt = 1; ; attempt += 1) {
    const response = await page.goto(url, { waitUntil: 'commit', timeout: remaining(NAVIGATION_TIMEOUT_MS) });
    const status = response?.status() || 200;
    if (status >= 400) throw new Error(`HTTP ${status}`);
    try {
      await page.waitForLoadState('domcontentloaded', { timeout: remaining(contentTimeout) });
      return { status, loaded: true };
    } catch (error) {
      ignoringTimeout(error);
      if (attempt >= attempts) return { status, loaded: false };
    }
  }
}

// Ordinary same-site navigation is followed. Action and token URLs stay unvisited evidence.
function followableLink(control, origin) {
  if (!control.href || control.disabled) return null;
  let link;
  try {
    link = new URL(control.href);
  } catch {
    return null;
  }
  const isSameSite = link.origin === origin && ['http:', 'https:'].includes(link.protocol);
  if (!isSameSite || link.username || link.password) return null;
  if (UNSAFE_LINK.test(`${link.href} ${control.label}`) || FILE_LINK.test(link.pathname)) return null;
  link.hash = '';
  return link.href;
}

function storedVariableRedactor(project) {
  const values = [...Object.values(project.globalVariables || {}), ...(project.environments || []).flatMap((env) => Object.values(env.variables || {}))]
    .filter((value) => typeof value === 'string' && value.length > 0)
    .sort((a, b) => b.length - a.length);

  const redact = (value) => {
    if (typeof value === 'string') {
      return values.reduce((text, secret) => text.replaceAll(secret, '[stored variable]'), value);
    }
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)]));
    }
    return value;
  };
  return redact;
}

export async function inspectRequirementApp(project, inputUrl, { launcher = launchBrowser, signal, contentTimeout = CONTENT_TIMEOUT_MS } = {}) {
  checkpoint(signal);
  const startUrl = requirementUrl(inputUrl);
  const deadline = Date.now() + DEADLINE_MS;
  const remaining = (limit) => Math.min(limit, Math.max(1, deadline - Date.now()));
  let origin = new URL(startUrl).origin;
  const queue = [startUrl];
  const seen = new Set();
  const pages = [];
  const warnings = [];

  let browser;
  // Closing the browser ends any page load in progress, so a cancellation takes effect at once.
  const closeOnAbort = () => browser?.close().catch(() => {});
  signal?.addEventListener('abort', closeOnAbort, { once: true });

  try {
    browser = await launcher(project.browser || 'chrome');
    checkpoint(signal);
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    // Application APIs may load the page, but automatic form navigations are blocked.
    await page.route('**/*', (route) => {
      const request = route.request();
      const isWrite = request.isNavigationRequest() && !['GET', 'HEAD'].includes(request.method());
      return isWrite ? route.abort() : route.continue();
    });
    page.on('dialog', (dialog) => dialog.dismiss().catch(() => {}));
    page.on('popup', (popup) => popup.close().catch(() => {}));

    while (queue.length && pages.length < MAX_PAGES && Date.now() < deadline) {
      checkpoint(signal);
      const url = queue.shift();
      if (seen.has(url)) continue;
      seen.add(url);

      try {
        const { status, loaded } = await openPage(page, url, { attempts: pages.length ? 1 : 2, contentTimeout, remaining });
        if (loaded) {
          const renderTimeout = pages.length ? FOLLOWED_PAGE_RENDER_TIMEOUT_MS : RENDER_TIMEOUT_MS;
          await page.waitForFunction(hasVisibleControl, CONTROL_SELECTOR, { timeout: remaining(renderTimeout) }).catch(ignoringTimeout);
          await waitForPageReady(page, { timeout: remaining(READINESS_TIMEOUT_MS) }).catch(ignoringTimeout);
        }

        const data = await page.evaluate(pageStructure, CONTROL_SELECTOR);
        const finalUrl = requirementUrl(page.url());
        if (!pages.length) {
          origin = new URL(finalUrl).origin;
        } else if (new URL(finalUrl).origin !== origin) {
          warnings.push(`Navigation from ${url} left the application. The destination was not included in coverage.`);
          continue;
        }
        if (pages.some((item) => item.url === finalUrl)) continue;

        pages.push({ ...data, url: finalUrl, status });
        if (!data.controls.length) {
          warnings.push(`No fields or controls could be read from ${finalUrl}. The page may not have finished loading, so test cases for it rely on the description.`);
        }
        if (data.truncated) warnings.push(`Only the first 100 visible controls on ${finalUrl} were inspected.`);
        if (data.controls.some((control) => control.type === 'password')) {
          warnings.push(`Sign-in controls were found on ${finalUrl}. Authenticated pages require a separate test execution with credentials.`);
        }
        for (const control of data.controls) {
          const link = followableLink(control, origin);
          if (link && !seen.has(link) && !queue.includes(link) && queue.length < MAX_QUEUE) queue.push(link);
        }
      } catch (error) {
        checkpoint(signal);
        if (!pages.length) {
          throw new Error(`Could not inspect the requirement URL. Check the URL, network access, and browser installation. ${error.message}`);
        }
        warnings.push(`Could not inspect ${url}: ${String(error.message).slice(0, MAX_WARNING_DETAIL)}`);
      }
    }

    checkpoint(signal);
    if (queue.length) warnings.push('Exploration reached its limit of six pages or 60 seconds. Other pages remain uninspected.');
    if (!pages.length) throw new Error('The application did not return a page to inspect.');
    warnings.push('Navigation and visible page structure were inspected. Form submissions, button actions, authenticated workflows, and generated test outcomes have not been executed.');

    // Navigation URLs stay usable in the local report. Page content sent to AI is redacted.
    return {
      pages,
      warnings: [...new Set(warnings)].slice(0, MAX_WARNINGS),
      context: storedVariableRedactor(project)({ pages, warnings }),
    };
  } catch (error) {
    checkpoint(signal);
    throw error;
  } finally {
    signal?.removeEventListener('abort', closeOnAbort);
    await browser?.close().catch(() => {});
  }
}
