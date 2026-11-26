import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { canShowBrowser, launchBrowser } from './browsers.mjs';
import { focusLocator, screenshotPage } from './locator-focus.mjs';
import { assert, normalizeSteps } from './model.mjs';
import { automaticallyNameRecordedStep } from './recorder-names.mjs';

const MAX_RECORDED_STEPS = 1000;
const NAVIGATION_TIMEOUT_MS = 30000;
// How long to wait for the page title, used to name the first step, before naming it without one.
const TITLE_WAIT_MS = 5000;
const EVIDENCE_FOCUS_TIMEOUT_MS = 5000;
const CAPTURED_ACTIONS = new Set([
  'click',
  'doubleClick',
  'fill',
  'select',
  'check',
  'uncheck',
  'pressKey',
  'visible',
  'text',
  'value',
  'uploadFile',
]);
const VERIFICATION_ACTIONS = new Set(['text', 'value', 'visible']);
const RECORDER_MODES = new Set(['actions', 'visible', 'text', 'value']);
// Remote recording: the browser runs on a server without a screen and is shown in Studio.
const REMOTE_VIEWPORT = { width: 1440, height: 900 };
const REMOTE_JPEG_QUALITY = 60;
const REMOTE_TIMEOUT_MS = 5000;
const REMOTE_MAX_SCROLL = 5000;
const REMOTE_MAX_TEXT = 1000;
const REMOTE_KEYS = new Set([
  'Enter', 'Tab', 'Shift+Tab', 'Backspace', 'Delete', 'Escape', 'Space',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown',
  'Control+a', 'Meta+a',
]);

// Runs in every document and frame, including documents reached after navigation.
// The browser receives this function's source, so it must not use anything from this module.
export function installRecorder() {
  const AUTO_HIDE_MS = 3000;
  const TOOLBOX_POLL_MS = 800;
  const VERIFY_MODES = ['text', 'value', 'visible'];
  const CLICKABLE =
    'button,a,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=radio],[role=switch]';
  const FILLABLE =
    'textarea,input:not([type=checkbox]):not([type=radio]):not([type=file]):not([type=range]):not([type=color])';
  const RECORDED_KEYS = ['Enter', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
  const SAVE_FAILED = 'Capture could not be saved. Check the recorder in Studio.';
  const CAPTURE_MESSAGES = {
    text: 'Text captured successfully',
    value: 'Field value captured successfully',
    visible: 'Visible element captured',
  };

  const ROLE_KINDS = {
    button: 'button',
    link: 'link',
    heading: 'heading',
    img: 'image',
    checkbox: 'checkbox',
    radio: 'radio button',
    switch: 'switch',
    tab: 'tab',
    menuitem: 'menu item',
    menuitemcheckbox: 'menu checkbox',
    menuitemradio: 'menu radio button',
    combobox: 'dropdown',
    listbox: 'list box',
    option: 'option',
    textbox: 'text field',
    searchbox: 'search field',
    spinbutton: 'number field',
    slider: 'slider',
    progressbar: 'progress bar',
    dialog: 'dialog',
    alert: 'alert',
    status: 'status message',
    table: 'table',
    grid: 'grid',
    row: 'table row',
    cell: 'table cell',
    gridcell: 'table cell',
    columnheader: 'column header',
    rowheader: 'row header',
    list: 'list',
    listitem: 'list item',
    navigation: 'navigation area',
  };
  const INPUT_KINDS = {
    password: 'password field',
    checkbox: 'checkbox',
    radio: 'radio button',
    file: 'file upload field',
    email: 'email field',
    tel: 'phone field',
    number: 'number field',
    search: 'search field',
    url: 'URL field',
    date: 'date field',
    'datetime-local': 'date and time field',
    time: 'time field',
    month: 'month field',
    week: 'week field',
    range: 'slider',
    color: 'color picker',
    button: 'button',
    submit: 'button',
    reset: 'button',
    image: 'image button',
  };
  const TAG_KINDS = {
    button: 'button',
    a: 'link',
    textarea: 'text area',
    img: 'image',
    svg: 'icon',
    h1: 'heading',
    h2: 'heading',
    h3: 'heading',
    h4: 'heading',
    h5: 'heading',
    h6: 'heading',
    p: 'paragraph',
    span: 'text element',
    label: 'label',
    table: 'table',
    tr: 'table row',
    td: 'table cell',
    th: 'table header',
    ul: 'list',
    ol: 'list',
    li: 'list item',
    form: 'form',
    section: 'section',
    article: 'article',
    nav: 'navigation area',
    dialog: 'dialog',
    video: 'video',
    audio: 'audio player',
    progress: 'progress bar',
    output: 'output',
    summary: 'summary',
    details: 'expandable section',
  };

  // Playwright CSS locators pierce open shadow roots, including the recorder's own toolbox.
  // A selector unique only in the light DOM would fail strict mode, so nested roots are counted too.
  const openRootsWithin = (root) => {
    const roots = [root];
    for (const current of roots) {
      for (const node of current.querySelectorAll('*')) {
        if (node.shadowRoot) roots.push(node.shadowRoot);
      }
    }
    return roots;
  };

  const selector = (el) => {
    const root = el.getRootNode();
    const prefix = root instanceof ShadowRoot ? `${selector(root.host)} ` : '';
    const searchRoots = openRootsWithin(root);
    const isUnique = (css) => searchRoots.reduce((total, item) => total + item.querySelectorAll(css).length, 0) === 1;
    for (const attr of ['data-testid', 'id', 'name', 'aria-label', 'placeholder']) {
      const value = el.getAttribute(attr);
      if (!value) continue;
      const css = `[${attr}=${JSON.stringify(value)}]`;
      if (isUnique(css)) return prefix + css;
    }
    const parts = [];
    for (let node = el; node?.nodeType === 1; node = node.parentElement) {
      const siblings = [...(node.parentElement?.children || [])].filter((item) => item.tagName === node.tagName);
      const position = siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(node) + 1})` : '';
      parts.unshift(node.localName + position);
      if (isUnique(parts.join(' > '))) break;
    }
    return prefix + parts.join(' > ');
  };
  window.__studioSelector = selector;

  window.__studioRecorderMode = 'actions';
  void window
    .__studioMode()
    .then((mode) => {
      window.__studioRecorderMode = mode;
    })
    .catch(() => {});

  /* ---------- Feedback: target highlight and status toast ---------- */

  let feedbackHost;
  let highlight;
  let toast;
  let feedbackTimer;
  let selectedElement;
  let feedbackVersion = 0;
  let capturingEvidence = false;

  const clearHighlight = () => {
    selectedElement = null;
    if (highlight) highlight.hidden = true;
  };

  const positionHighlight = () => {
    if (!selectedElement?.isConnected) {
      clearHighlight();
      return;
    }
    const rect = selectedElement.getBoundingClientRect();
    Object.assign(highlight.style, {
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
  };

  const ensureFeedback = () => {
    if (feedbackHost?.isConnected) return;
    feedbackHost = document.createElement('qa-studio-recorder-feedback');
    feedbackHost.style.cssText =
      'all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important';
    const root = feedbackHost.attachShadow({ mode: 'open' });

    highlight = document.createElement('div');
    highlight.setAttribute('data-capture-highlight', '');
    highlight.style.cssText =
      'position:fixed;box-sizing:border-box;border:3px solid #e5484d;border-radius:4px;background:rgba(229,72,77,.08);pointer-events:none';

    toast = document.createElement('div');
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    toast.style.cssText =
      'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);max-width:calc(100vw - 48px);box-sizing:border-box;background:#8f2029;color:#fff;border:1px solid #ff858c;border-radius:8px;padding:12px 18px;font:600 14px/1.5 system-ui,sans-serif;box-shadow:0 5px 24px #0006;pointer-events:none';

    highlight.hidden = true;
    toast.hidden = true;
    root.append(highlight, toast);
    document.documentElement.append(feedbackHost);
  };

  const highlightElement = (el) => {
    ensureFeedback();
    selectedElement = el;
    highlight.hidden = false;
    positionHighlight();
  };

  const showFeedback = (message) => {
    ensureFeedback();
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(feedbackTimer);
    feedbackTimer = setTimeout(() => {
      toast.hidden = true;
      clearHighlight();
    }, AUTO_HIDE_MS);
  };

  window.__studioPrepareEvidence = (el) => {
    capturingEvidence = true;
    clearTimeout(feedbackTimer);
    highlightElement(el);
    toast.hidden = true;
  };
  window.__studioFinishEvidence = () => {
    capturingEvidence = false;
  };

  /* ---------- In-browser toolbox (top frame only) ---------- */

  let toolboxHost;
  const fromToolbox = (event) => Boolean(toolboxHost) && event.composedPath().includes(toolboxHost);

  window.__studioToolboxHide = (hidden) => {
    if (toolboxHost) toolboxHost.style.display = hidden ? 'none' : '';
  };

  const create = (tag, props = {}, ...children) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children);
    return node;
  };

  const installToolbox = () => {
    if (window !== window.top || toolboxHost?.isConnected || !window.__studioToolbox) return;
    toolboxHost = document.createElement('qa-studio-recorder-toolbox');
    toolboxHost.style.cssText =
      'all:initial!important;position:fixed!important;top:16px!important;right:16px!important;z-index:2147483647!important';
    const root = toolboxHost.attachShadow({ mode: 'open' });

    // A <style> element would be blocked on pages with a strict CSP, including Studio's own /demo.
    // Without its fixed width the toolbox grows with long step names and covers the page under test.
    const styles = new CSSStyleSheet();
    styles.replaceSync(
      ':host{font:13px/1.4 system-ui,sans-serif}.box{width:268px;background:#141a24;color:#eef2f8;border:1px solid #3a4658;border-radius:10px;box-shadow:0 8px 28px #0007;overflow:hidden}' +
      '.bar{display:flex;align-items:center;gap:8px;padding:8px 10px;background:#1d2635;cursor:move;user-select:none}.dot{width:9px;height:9px;border-radius:50%;background:#3ecf8e}.dot.paused{background:#f5a524}.dot.stopped{background:#e5484d}' +
      '.title{flex:1;font-weight:700}.body{padding:10px;display:grid;gap:10px}.box.min .body{display:none}.row{display:grid;grid-template-columns:repeat(2,1fr);gap:6px}' +
      'button{font:inherit;color:inherit;background:#252f40;border:1px solid #3a4658;border-radius:6px;padding:6px 8px;cursor:pointer}button:hover:not(:disabled){background:#2f3b50}button:disabled{opacity:.45;cursor:default}' +
      'button.on{background:#2563eb;border-color:#5b8def}button.stop{background:#8f2029;border-color:#ff858c}.label{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#9aa8bd;margin-bottom:4px}' +
      'ol{margin:0;padding-left:20px;max-height:120px;overflow:auto;font-size:12px;color:#c9d3e3}li{margin:2px 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.msg{font-size:12px;color:#ffb4b8}',
    );
    root.adoptedStyleSheets = [styles];

    const send = async (command) => {
      try {
        apply(await window.__studioToolbox(command));
      } catch {
        // The browser is closing, so there is nothing left to update.
      }
    };

    const dot = create('span', { className: 'dot' });
    const title = create('span', { className: 'title' }, 'QA Studio Recorder');
    const fold = create('button', { title: 'Collapse or expand', textContent: '–' });
    fold.style.padding = '0 8px';
    const bar = create('div', { className: 'bar' }, dot, title, fold);

    const modes = [
      ['actions', 'Record actions'],
      ['visible', 'Verify visible'],
      ['text', 'Verify text'],
      ['value', 'Verify value'],
    ];
    const modeButtons = Object.fromEntries(
      modes.map(([id, text]) => [id, create('button', { textContent: text, onclick: () => send(`mode:${id}`) })]),
    );
    const pause = create('button', { onclick: () => send(pause.dataset.cmd) });
    const stop = create('button', { className: 'stop', textContent: 'Stop', onclick: () => send('stop') });
    const undo = create('button', { textContent: 'Undo last step', onclick: () => send('undo') });
    const steps = create('ol');
    const count = create('div', { className: 'label' });
    const message = create('div', { className: 'msg' });

    const fetchSection = create(
      'div',
      {},
      create('div', { className: 'label' }, 'Fetch element'),
      create('div', { className: 'row' }, ...Object.values(modeButtons)),
    );
    const controls = create('div', { className: 'row' }, pause, stop);
    const body = create('div', { className: 'body' }, fetchSection, controls, undo, count, steps, message);
    const box = create('div', { className: 'box' }, bar, body);
    root.append(box);
    document.documentElement.append(toolboxHost);

    fold.onclick = () => {
      box.classList.toggle('min');
      fold.textContent = box.classList.contains('min') ? '+' : '–';
    };

    let drag;
    bar.addEventListener('pointerdown', (event) => {
      if (event.target === fold) return;
      const rect = toolboxHost.getBoundingClientRect();
      drag = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      bar.setPointerCapture(event.pointerId);
    });
    bar.addEventListener('pointermove', (event) => {
      if (!drag) return;
      const left = Math.max(0, Math.min(innerWidth - 80, event.clientX - drag.x));
      const top = Math.max(0, Math.min(innerHeight - 40, event.clientY - drag.y));
      toolboxHost.style.setProperty('left', `${left}px`, 'important');
      toolboxHost.style.setProperty('top', `${top}px`, 'important');
      toolboxHost.style.setProperty('right', 'auto', 'important');
    });
    bar.addEventListener('pointerup', () => {
      drag = null;
    });

    const apply = (state) => {
      if (!state) return;
      const isStopped = state.status === 'stopped';
      const isPaused = state.status === 'paused';
      dot.className = `dot ${state.status}`;
      title.textContent = `QA Studio Recorder - ${state.status}`;
      for (const [id, button] of Object.entries(modeButtons)) {
        button.classList.toggle('on', state.mode === id);
        button.disabled = isStopped;
      }
      pause.textContent = isPaused ? 'Resume' : 'Pause';
      pause.dataset.cmd = isPaused ? 'resume' : 'pause';
      pause.disabled = isStopped;
      stop.disabled = isStopped;
      undo.disabled = isStopped || state.count < 2;
      count.textContent = `Recorded session - ${state.count} step${state.count === 1 ? '' : 's'}`;
      steps.replaceChildren(...state.recent.map((name) => create('li', { textContent: name, title: name })));
      steps.start = Math.max(1, state.count - state.recent.length + 1);
      message.textContent = state.saveError || '';
    };

    void send('state');
    setInterval(() => send('state'), TOOLBOX_POLL_MS);
  };

  if (document.documentElement) installToolbox();
  else document.addEventListener('DOMContentLoaded', installToolbox, { once: true });

  document.addEventListener(
    'pointerover',
    (event) => {
      if (fromToolbox(event)) {
        clearHighlight();
        return;
      }
      if (capturingEvidence) return;
      if (!VERIFY_MODES.includes(window.__studioRecorderMode)) {
        clearHighlight();
        return;
      }
      const el = element(event);
      if (el) highlightElement(el);
    },
    true,
  );
  document.addEventListener('scroll', positionHighlight, true);
  window.addEventListener('resize', positionHighlight);

  /* ---------- Describing and emitting captured elements ---------- */

  const collapse = (value) =>
    String(value || '')
      .replace(/\s+/g, ' ')
      .trim();

  const elementKind = (el) => {
    if (el.matches('input[type=password]')) return 'password field';
    const role = el.getAttribute('role')?.toLowerCase();
    if (ROLE_KINDS[role]) return ROLE_KINDS[role];
    if (el.localName === 'input') return INPUT_KINDS[el.type] || 'text field';
    if (el.localName === 'select') return el.multiple ? 'list box' : 'dropdown';
    if (el.isContentEditable) return 'text editor';
    return TAG_KINDS[el.localName] || 'element';
  };

  const elementLabel = (el) => {
    const root = el.getRootNode();
    const labelledBy = collapse(el.getAttribute('aria-labelledby'))
      .split(' ')
      .filter(Boolean)
      .map((id) => collapse(root.getElementById?.(id)?.textContent))
      .filter(Boolean)
      .join(' ');
    const labels = [...(el.labels || [])]
      .map((label) => {
        const copy = label.cloneNode(true);
        copy.querySelectorAll('input,textarea,select').forEach((control) => control.remove());
        return collapse(copy.textContent);
      })
      .filter(Boolean)
      .join(' ');
    // Form values must not leak into names through a container's text content.
    const holdsFormValue = el.matches('input,textarea,select') || el.querySelector('input,textarea,select');
    const contentText = holdsFormValue ? '' : collapse(el.innerText || el.textContent);
    const buttonValue = el.matches('input[type=button],input[type=submit],input[type=reset]') ? collapse(el.value) : '';
    const imageText = [...el.querySelectorAll('img[alt],svg title')]
      .map((image) => collapse(image.getAttribute('alt') || image.textContent))
      .filter(Boolean)
      .join(' ');
    return (
      labelledBy ||
      collapse(el.getAttribute('aria-label')) ||
      labels ||
      contentText ||
      buttonValue ||
      collapse(el.getAttribute('alt')) ||
      imageText ||
      collapse(el.getAttribute('title')) ||
      collapse(el.getAttribute('placeholder'))
    );
  };

  const describe = (el) => {
    if (!el) return {};
    return {
      label: elementLabel(el),
      kind: elementKind(el),
      identifier: el.getAttribute('name') || el.id || el.getAttribute('data-testid'),
      selectedLabels: el.matches('select') ? [...el.selectedOptions].map((option) => collapse(option.label)) : [],
    };
  };

  const emit = (action, el, value = '') => {
    // The password is replaced here, so it never leaves the page.
    const secret = ['fill', 'value'].includes(action) && Boolean(el?.matches('input[type=password]'));
    const isMultiple = Array.isArray(value);
    const recordedValue = secret ? 'RECORDED_PASSWORD' : isMultiple ? '' : value;
    return window
      .__studioRecord({
        action,
        target: el ? selector(el) : '',
        value: recordedValue,
        secret,
        ...(isMultiple ? { selectValues: value } : {}),
        description: describe(el),
        locatorType: 'css',
        valueMode: secret ? 'environment' : 'static',
      })
      .catch(() => ({ captured: false, message: SAVE_FAILED }));
  };

  function element(event) {
    return event.composedPath().find((node) => node?.nodeType === 1);
  }

  const captureVerification = (el, mode) => {
    const version = ++feedbackVersion;
    highlightElement(el);
    if (mode === 'value' && !('value' in el)) {
      showFeedback('Select an input, textarea, or select field to capture its value.');
      return;
    }
    showFeedback('Capturing element...');
    const value = mode === 'text' ? el.innerText || el.textContent || '' : mode === 'value' ? String(el.value ?? '') : '';
    void emit(mode, el, value).then((result) => {
      if (version !== feedbackVersion) return;
      if (result?.captured && result.screenshotError) {
        showFeedback('Assertion captured, but its screenshot could not be saved. See Studio warnings.');
      } else if (result?.captured) {
        showFeedback(CAPTURE_MESSAGES[mode]);
      } else {
        showFeedback(result?.message || 'Capture was not saved. Check the recorder in Studio.');
      }
    });
  };

  /* ---------- Event listeners, in the capture phase ---------- */

  // Input, change and keydown are deliberately not gated by mode: typing still records in Verify modes.
  document.addEventListener(
    'input',
    (event) => {
      if (fromToolbox(event)) return;
      const el = element(event);
      if (el?.matches(FILLABLE)) emit('fill', el, el.value);
    },
    true,
  );

  document.addEventListener(
    'change',
    (event) => {
      if (fromToolbox(event)) return;
      const el = element(event);
      if (el?.matches('select')) {
        emit('select', el, el.multiple ? [...el.selectedOptions].map((option) => option.value) : el.value);
      }
      if (el?.matches('input[type=checkbox],input[type=radio]')) emit(el.checked ? 'check' : 'uncheck', el);
      if (el?.matches('input[type=file]')) emit('uploadFile', el, '');
    },
    true,
  );

  document.addEventListener(
    'click',
    (event) => {
      if (fromToolbox(event)) return;
      const el = element(event);
      if (el && window.__studioRecorderMode !== 'actions') {
        event.preventDefault();
        event.stopImmediatePropagation();
        captureVerification(el, window.__studioRecorderMode);
        return;
      }
      if (!el || el.closest('select,option,input[type=checkbox],input[type=radio],input[type=file]')) return;
      if (el.closest('label')?.control?.matches('input[type=checkbox],input[type=radio]')) return;
      emit('click', el.closest(CLICKABLE) || el);
    },
    true,
  );

  document.addEventListener(
    'keydown',
    (event) => {
      if (fromToolbox(event) || !RECORDED_KEYS.includes(event.key)) return;
      const keys = [
        event.ctrlKey && 'Control',
        event.altKey && 'Alt',
        event.shiftKey && 'Shift',
        event.metaKey && 'Meta',
        event.key,
      ];
      emit('pressKey', element(event), keys.filter(Boolean).join('+'));
    },
    true,
  );

  document.addEventListener(
    'dblclick',
    (event) => {
      if (fromToolbox(event)) return;
      if (window.__studioRecorderMode !== 'actions') {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      const el = element(event);
      if (el) emit('doubleClick', el.closest(CLICKABLE) || el);
    },
    true,
  );
}

async function framePathOf(frame) {
  const framePath = [];
  for (let current = frame; current.parentFrame(); current = current.parentFrame()) {
    const handle = await current.frameElement();
    framePath.unshift(await handle.evaluate((el) => window.__studioSelector(el)));
    await handle.dispose();
  }
  return framePath;
}

async function saveEvidenceScreenshot(source, step, sessionId, artifacts) {
  const page = source.page;
  try {
    const target = source.frame.locator(step.target);
    const focused = await focusLocator(page, target, { timeout: EVIDENCE_FOCUS_TIMEOUT_MS, highlight: false });
    await focused.dispose();

    // Parent frames may still highlight the iframe itself after hover.
    // Only the asserted element stays marked in the saved image.
    const otherFrames = page.frames().filter((frame) => frame !== source.frame);
    await Promise.all(otherFrames.map((frame) => frame.evaluate(() => window.__studioPrepareEvidence?.(null))));
    await target.evaluate((el) => window.__studioPrepareEvidence(el));

    await mkdir(artifacts, { recursive: true });
    await page
      .mainFrame()
      .evaluate(() => window.__studioToolboxHide?.(true))
      .catch(() => {});
    const name = `capture-${sessionId}-${randomUUID()}.png`;
    // Sensitive content is masked in every frame, including popup pages.
    await screenshotPage(page, { path: path.join(artifacts, name), fullPage: false });
    return name;
  } finally {
    const restoring = page.frames().map((frame) =>
      frame.evaluate(() => {
        window.__studioFinishEvidence?.();
        window.__studioToolboxHide?.(false);
      }),
    );
    await Promise.allSettled(restoring);
  }
}

export async function startRecording(
  project,
  testId,
  url,
  { headless = false, artifacts = path.resolve('artifacts') } = {},
) {
  const parsed = new URL(url);
  assert(['http:', 'https:'].includes(parsed.protocol), 'Recording URL must use HTTP or HTTPS');
  assert(!parsed.username && !parsed.password, 'Use a URL without embedded credentials');
  // A recording fills either a test case or a process automation flow.
  const flow = project.processes?.find((item) => item.id === testId);
  const test = project.tests.find((item) => item.id === testId) || flow;
  assert(test, 'Test case not found');
  // A server without a screen runs the browser hidden and streams it to the Record Web page,
  // which sends the user's clicks and keys back through input().
  const remote = !headless && !canShowBrowser();

  const browser = await launchBrowser(project.browser, { headless: headless || remote });
  try {
    const context = await browser.newContext({ viewport: REMOTE_VIEWPORT });
    const page = await context.newPage();
    const pages = [page];
    const secretNames = new Map();
    const fileNames = new Map();
    let captureQueue = Promise.resolve();

    const session = {
      id: randomUUID(),
      projectId: project.id,
      testId,
      testName: test.name,
      ...(flow ? { kind: 'process' } : {}),
      browser: project.browser,
      status: 'recording',
      mode: 'actions',
      steps: normalizeSteps([{ action: 'navigate', name: 'Open the starting page', value: parsed.href }]),
      warnings: [],
      page,
      context,
      remote,
      onChange: null,
      saveQueue: Promise.resolve(),
      pendingSaves: 0,
      savedAt: null,
      saveError: null,

      save() {
        if (!this.onChange) return Promise.resolve();
        const snapshot = structuredClone(this.summary());
        snapshot.savedAt = new Date().toISOString();
        snapshot.saving = false;
        snapshot.saveError = null;
        this.pendingSaves += 1;
        const work = this.saveQueue
          .then(async () => {
            await this.onChange(snapshot);
            this.savedAt = snapshot.savedAt;
            this.saveError = null;
          })
          .catch((error) => {
            this.saveError = `Could not save recording: ${error.message}`;
            if (this.status === 'recording') this.status = 'paused';
            throw error;
          })
          .finally(() => {
            this.pendingSaves -= 1;
          });
        this.saveQueue = work.catch(() => {});
        return work;
      },

      warn(message) {
        if (!this.warnings.includes(message)) this.warnings.push(message);
      },

      summary() {
        return {
          id: this.id,
          projectId: this.projectId,
          testId,
          testName: this.testName,
          kind: this.kind || 'test',
          browser: this.browser,
          status: this.status,
          mode: this.mode,
          steps: this.steps,
          warnings: this.warnings,
          savedAt: this.savedAt,
          saving: this.pendingSaves > 0,
          saveError: this.saveError,
          ...(this.remote
            ? { remote: { width: REMOTE_VIEWPORT.width, height: REMOTE_VIEWPORT.height, stream: this.canStream } }
            : {}),
        };
      },

      // The tab the user is on: the newest open one, as a desktop browser would show.
      activePage() {
        return pages.filter((item) => !item.isClosed()).at(-1) || page;
      },

      screen() {
        return this.activePage().screenshot({ type: 'jpeg', quality: REMOTE_JPEG_QUALITY, timeout: REMOTE_TIMEOUT_MS });
      },

      async input(event) {
        assert(this.remote, 'This recording uses a visible browser window.');
        assert(this.status !== 'stopped', 'Recording is already stopped');
        const target = this.activePage();
        const inView = (value, size) => Number.isFinite(value) && value >= 0 && value <= size;
        const isPoint = inView(event?.x, REMOTE_VIEWPORT.width) && inView(event?.y, REMOTE_VIEWPORT.height);
        if (event?.type === 'click') {
          assert(isPoint, 'Click outside the page');
          const clickCount = event.clickCount === 2 ? 2 : 1;
          await target.mouse.click(event.x, event.y, { clickCount, timeout: REMOTE_TIMEOUT_MS });
        } else if (event?.type === 'move') {
          assert(isPoint, 'Pointer outside the page');
          await target.mouse.move(event.x, event.y);
        } else if (event?.type === 'scroll') {
          const delta = (value) => Math.max(-REMOTE_MAX_SCROLL, Math.min(REMOTE_MAX_SCROLL, Number(value) || 0));
          await target.mouse.wheel(delta(event.dx), delta(event.dy));
        } else if (event?.type === 'text') {
          assert(typeof event.text === 'string' && event.text.length <= REMOTE_MAX_TEXT, 'Invalid text');
          await target.keyboard.type(event.text);
        } else if (event?.type === 'key') {
          assert(REMOTE_KEYS.has(event.key), 'Unsupported key');
          await target.keyboard.press(event.key);
        } else {
          assert(false, 'Unsupported input');
        }
      },

      // Streams frames of the active tab to viewers. Chromium pushes a frame only when the page
      // changes; other browsers fall back to the viewer asking for screen().
      canStream: remote && project.browser !== 'firefox',
      viewers: new Set(),
      lastFrame: null,
      cast: null,

      async watch(viewer) {
        assert(this.canStream && this.status !== 'stopped', 'Live view is not available');
        this.viewers.add(viewer);
        if (this.lastFrame) viewer.frame(this.lastFrame);
        await this.castActivePage();
        return () => {
          this.viewers.delete(viewer);
          if (!this.viewers.size) void this.endCast();
        };
      },

      async castActivePage() {
        const target = this.activePage();
        if (!this.viewers.size || this.cast?.page === target) return;
        await this.endCast();
        const cdp = await context.newCDPSession(target);
        const cast = { page: target, cdp };
        this.cast = cast;
        cdp.on('Page.screencastFrame', ({ data, sessionId }) => {
          void cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
          if (this.cast !== cast) return;
          this.lastFrame = Buffer.from(data, 'base64');
          for (const viewer of this.viewers) viewer.frame(this.lastFrame);
        });
        await cdp.send('Page.startScreencast', {
          format: 'jpeg',
          quality: REMOTE_JPEG_QUALITY,
          maxWidth: REMOTE_VIEWPORT.width,
          maxHeight: REMOTE_VIEWPORT.height,
        });
      },

      async endCast() {
        const cast = this.cast;
        this.cast = null;
        if (cast) await cast.cdp.detach().catch(() => {});
      },

      async stop() {
        this.status = 'stopped';
        for (const viewer of this.viewers) viewer.end();
        this.viewers.clear();
        await this.endCast();
        await captureQueue;
        await browser.close().catch(() => {});
        await this.save();
        return this.summary();
      },
    };

    const setMode = async (mode) => {
      session.mode = mode;
      const frames = context.pages().flatMap((item) => item.frames());
      await Promise.allSettled(
        frames.map((frame) =>
          frame.evaluate((value) => {
            window.__studioRecorderMode = value;
          }, mode),
        ),
      );
    };

    const toolboxState = () => ({
      status: session.status,
      mode: session.mode,
      count: session.steps.length,
      recent: session.steps.slice(-5).map((step) => step.name),
      saveError: session.saveError,
    });

    const undoLastStep = async () => {
      const work = captureQueue.then(() => {
        // Step 0 opens the starting page, so it is never removed.
        if (session.steps.length > 1) session.steps.pop();
      });
      captureQueue = work.catch(() => {});
      await work;
    };

    const handleToolboxCommand = async (command) => {
      const text = String(command || '');
      const isStopped = session.status === 'stopped';
      if (text === 'stop' && !isStopped) {
        void session.stop().catch(() => {});
        return { ...toolboxState(), status: 'stopped' };
      }
      if (text === 'pause' && session.status === 'recording') session.status = 'paused';
      else if (text === 'resume' && session.status === 'paused') session.status = 'recording';
      else if (text.startsWith('mode:') && !isStopped && RECORDER_MODES.has(text.slice(5))) await setMode(text.slice(5));
      else if (text === 'undo' && !isStopped) await undoLastStep();
      else return toolboxState();
      await session.save().catch(() => {});
      return toolboxState();
    };

    const applySecretValue = (input, identity) => {
      if (!secretNames.has(identity)) {
        secretNames.set(identity, secretNames.size ? `RECORDED_PASSWORD_${secretNames.size + 1}` : 'RECORDED_PASSWORD');
      }
      input.value = secretNames.get(identity);
      input.valueMode = 'environment';
      input.sensitive = true;
      session.warn(`Set ${input.value} in the selected environment before replay. Passwords are never captured.`);
    };

    const applyFileValue = (input, identity) => {
      if (!fileNames.has(identity)) fileNames.set(identity, `RECORDED_FILE_${fileNames.size + 1}`);
      input.value = fileNames.get(identity);
      input.valueMode = 'environment';
      session.warn(`Set ${input.value} to the full local file path before replay.`);
    };

    const addStep = (step) => {
      const sameTarget = (other) =>
        other?.target === step.target &&
        other.pageIndex === step.pageIndex &&
        JSON.stringify(other.framePath) === JSON.stringify(step.framePath);

      // The browser fires two clicks before a double-click, so they are replaced by it.
      if (step.action === 'doubleClick') {
        for (let i = 0; i < 2; i += 1) {
          const previous = session.steps.at(-1);
          if (previous?.action === 'click' && sameTarget(previous)) session.steps.pop();
        }
      }

      const last = session.steps.at(-1);
      if (step.action === 'fill' && last?.action === 'fill' && sameTarget(last)) {
        session.steps[session.steps.length - 1] = step;
      } else if (session.steps.length < MAX_RECORDED_STEPS) {
        session.steps.push(step);
      } else {
        session.status = 'paused';
        session.warn('The 1000-step limit was reached. Stop and review this recording.');
      }
    };

    const capture = async (source, received) => {
      if (!CAPTURED_ACTIONS.has(received.action)) return undefined;
      let captured = false;
      let screenshotError;
      try {
        const { description } = received;
        const input = {
          ...received,
          pageIndex: pages.indexOf(source.page),
          elementName: String(
            description?.label || description?.identifier || description?.kind || 'Recorded element',
          ).slice(0, 120),
          pageUrl: source.frame.url().split(/[?#]/)[0].slice(0, 2000),
        };
        const framePath = await framePathOf(source.frame);
        if (framePath.length) input.framePath = framePath;
        const identity = JSON.stringify([input.pageIndex, framePath, input.target]);
        if (input.secret) applySecretValue(input, identity);
        if (input.action === 'uploadFile') applyFileValue(input, identity);

        const named = automaticallyNameRecordedStep(input, test.qa?.manualSteps, description);
        const [step] = normalizeSteps([named]);
        if (VERIFICATION_ACTIONS.has(step.action) && session.steps.length < MAX_RECORDED_STEPS) {
          try {
            step.captureScreenshot = await saveEvidenceScreenshot(source, step, session.id, artifacts);
          } catch (error) {
            screenshotError = true;
            session.warn(`Assertion screenshot unavailable for ${step.name}: ${error.message}`);
          }
        }
        addStep(step);
        captured = session.status === 'recording';
      } catch (error) {
        session.warn(error.message);
      }
      await session.save();
      return {
        captured,
        screenshotError,
        message: captured ? undefined : 'Capture could not be saved. Check recorder warnings in Studio.',
      };
    };

    await context.exposeBinding('__studioMode', () => session.mode);
    await context.exposeBinding('__studioToolbox', (source, command) => handleToolboxCommand(command));
    await context.exposeBinding('__studioRecord', (source, input) => {
      if (session.status !== 'recording') {
        return { captured: false, message: 'Recording is paused or stopped. Resume recording in Studio to capture.' };
      }
      const work = captureQueue.then(() => capture(source, input));
      captureQueue = work.catch(() => {});
      return work;
    });
    await context.addInitScript(installRecorder);

    context.on('page', (popup) => {
      if (popup !== page) pages.push(popup);
      // The live view follows the newest tab, as a desktop browser shows it.
      void session.castActivePage().catch(() => {});
      popup.on('close', () => void session.castActivePage().catch(() => {}));
    });
    page.on('close', () => {
      session.status = 'stopped';
      void browser.close().catch(() => {});
      void session.save().catch(() => {});
    });
    browser.on('disconnected', () => {
      session.status = 'stopped';
      void session.save().catch(() => {});
    });

    // Wait only for the server to answer: the capture script is injected into every page, so
    // recording works while a slow site is still loading its scripts. Playback does the same.
    await page.goto(parsed.href, { waitUntil: 'commit', timeout: NAVIGATION_TIMEOUT_MS });
    await page.waitForLoadState('domcontentloaded', { timeout: TITLE_WAIT_MS }).catch(() => {});
    const title = await page.title().catch(() => '');
    session.steps[0] = automaticallyNameRecordedStep(session.steps[0], test.qa?.manualSteps, { pageTitle: title });
    return session;
  } catch (error) {
    await browser.close().catch(() => {});
    throw error;
  }
}
