/* Shared icons and interaction feedback for both studios. */
(() => {
  const ICON_PATHS = {
    logo: 'M5 6h9a4 4 0 0 1 4 4v7M5 6v9a4 4 0 0 0 4 4h9M9 12l3 3 7-8',
    dashboard: 'M3 3h7v7H3zM14 3h7v4h-7zM14 11h7v10h-7zM3 14h7v7H3z',
    cases: 'M8 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2h-3M8 2h8v4H8zM7 11l1 1 2-2M13 11h4M7 16l1 1 2-2M13 16h4',
    plan: 'M8 3H5v18h14V3h-3M8 2h8v4H8zM7 12l3 3 7-7',
    runs: 'M8 5v14l11-7z',
    suites: 'M3 7h7l2 2h9v11H3zM3 7V4h7l2 2h8',
    reports: 'M5 3h10l4 4v14H5zM14 3v5h5M8 17v-3M12 17v-6M16 17v-4',
    bolt: 'M13 2 4 14h7l-1 8 10-13h-8z',
    settings: 'M9 4 10 2h4l1 2 3 2 2 1v4l-1 2-2 4-2 1h-4l-2-1-3-3-1-3V7l2-1zM15 10a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
    plus: 'M12 5v14M5 12h14',
    chevron: 'm9 5 7 7-7 7',
    down: 'm6 9 6 6 6-6',
    up: 'm6 15 6-6 6 6',
    arrow: 'M4 12h16m-5-5 5 5-5 5',
    back: 'M20 12H4m5-5-5 5 5 5',
    search: 'M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14m5-2 6 6',
    check: 'm5 12 4 4L19 6',
    clock: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M12 7v5l3 2',
    target: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M17 12a5 5 0 1 1-10 0 5 5 0 0 1 10 0M12 10v4m-2-2h4',
    book: 'M3 4h7l2 2 2-2h7v15h-7l-2 2-2-2H3zM12 6v15',
    user: 'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0M4 21v-2a8 8 0 0 1 16 0v2',
    download: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5',
    upload: 'M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5',
    refresh: 'M20 8a8 8 0 1 0 0 8M20 3v5h-5',
    edit: 'm14 5 5 5M4 20l5-1L21 7l-5-5L4 14z',
    close: 'm6 6 12 12M6 18 18 6',
    trash: 'M3 6h18M8 6V3h8v3M5 6l1 15h12l1-15M10 10v7m4-7v7',
    help: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M9 9a3 3 0 0 1 6 0c0 2-3 2-3 4m0 3v.1',
    copy: 'M8 8h13v13H8zM16 8V3H3v13h5',
    pause: 'M8 5v14M16 5v14',
    menu: 'M4 6h16M4 12h16M4 18h16',
    recording: 'M4 7h11v12H4zM15 11l6-3v10l-6-3M7 4h6',
    debug: 'M8 8h8v9a4 4 0 0 1-8 0V8Zm2-3 2 3 2-3M4 10h4m8 0h4M3 15h5m8 0h5M5 21l3-3m8 0 3 3M12 9v10',
    save: 'M4 3h13l4 4v14H3V3h1Zm3 0v7h10V3M7 21v-7h10v7M14 5v3',
    database: 'M20 6c0 2-4 3-8 3S4 8 4 6s4-3 8-3 8 1 8 3ZM4 6v12c0 2 4 3 8 3s8-1 8-3V6M4 12c0 2 4 3 8 3s8-1 8-3',
    objects: 'm12 2 9 5v10l-9 5-9-5V7l9-5Zm0 10v10M3 7l9 5 9-5M7 4l10 6',
    mcp: 'M8 3v5m8-5v5M5 8h14v4a7 7 0 0 1-14 0V8Zm7 11v4',
    vpn: 'M12 2 3 6v6c0 5 9 10 9 10s9-5 9-10V6l-9-4ZM8 12l3 3 5-6',
    variables: 'M8 3H5v18h3M16 3h3v18h-3M9 9l6 6m0-6-6 6',
    stop: 'M5 5h14v14H5z',
    move: 'M12 2v20M2 12h20M8 6l4-4 4 4M8 18l4 4 4-4M6 8l-4 4 4 4m12-8 4 4-4 4',
    replay: 'M4 8a9 9 0 1 1-1 8M3 2v7h7M10 8v8l6-4Z',
  };
  Object.assign(ICON_PATHS, {
    preconditions: ICON_PATHS.book,
    prerequisites: ICON_PATHS.book,
    editor: ICON_PATHS.cases,
    history: ICON_PATHS.clock,
    ai: ICON_PATHS.bolt,
  });

  const ICON_TONES = {
    runs: 'green',
    check: 'green',
    save: 'green',
    plus: 'green',
    logo: 'green',
    replay: 'green',
    vpn: 'green',
    trash: 'rose',
    close: 'rose',
    stop: 'rose',
    recording: 'rose',
    debug: 'amber',
    target: 'amber',
    clock: 'amber',
    history: 'amber',
    suites: 'amber',
    bolt: 'violet',
    ai: 'violet',
    mcp: 'violet',
    objects: 'violet',
    book: 'violet',
    preconditions: 'violet',
    settings: 'slate',
  };

  const ACTION_ICONS = {
    'run-test': 'runs',
    'run-suite': 'suites',
    'execute-suite': 'runs',
    'replay-test': 'replay',
    'debug-test': 'debug',
    'debug-step': 'runs',
    'debug-close': 'stop',
    'record-web': 'recording',
    'record-stop': 'stop',
    'record-toggle': 'recording',
    'record-import': 'download',
    'record-discard': 'trash',
    save: 'save',
    preflight: 'check',
    'schedule-test': 'clock',
    'test-options': 'settings',
    'step-options': 'settings',
    'local-test-data': 'database',
    'expected-rows': 'database',
    'inspect-locator': 'target',
    'auto-generator': 'bolt',
    'ai-assistance': 'bolt',
    'generate-ai': 'bolt',
    'open-ai-test': 'editor',
    'select-test': 'cases',
    'new-project': 'plus',
    'new-test': 'plus',
    'new-suite': 'plus',
    'new-prerequisite': 'plus',
    'add-step': 'plus',
    unmap: 'close',
    'view-schedules': 'clock',
    'history-retention': 'trash',
    'convert-html': 'upload',
    'backup-workspace': 'save',
    'restore-workspace': 'refresh',
    'call-mcp': 'mcp',
    'setup-mcp-preset': 'mcp',
    'toggle-ai-mcp': 'mcp',
    'clear-key': 'trash',
    'query-profile': 'database',
    'test-profile': 'check',
    'activate-profile': 'check',
    'activate-environment': 'check',
    'prompt-example': 'bolt',
    'close-dialog': 'close',
    'directory-move': 'move',
    'editor-page': 'arrow',
    'cases-page': 'arrow',
    'cases-folder': 'suites',
    'cases-run': 'runs',
    'cases-run-selected': 'runs',
    'cases-clear-filters': 'refresh',
    'cases-clear-selection': 'close',
  };

  // Checked in order for actions without an explicit icon above.
  const ACTION_ICON_PATTERNS = [
    [/delete|remove|discard/, 'trash'],
    [/stop|cancel|disconnect/, 'stop'],
    [/copy|duplicate/, 'copy'],
    [/edit|mapping/, 'edit'],
    [/new-|add-/, 'plus'],
    [/export|download/, 'download'],
    [/import|upload/, 'upload'],
    [/refresh|retry|load-|reconnect|discover/, 'refresh'],
    [/save|connect/, 'save'],
  ];

  const ACTION_TITLES = {
    'run-test': 'Run the selected test case',
    'run-suite': 'Choose a suite to run',
    'debug-test': 'Run one action at a time and inspect the result',
    'debug-close': 'Stop debugging and close the debug browser',
    'record-web': 'Record browser interactions as test steps',
    'replay-test': 'Watch this test run in a visible browser',
    preflight: 'Check this test before running it',
    'auto-generator': 'Create automation from the current QA requirements',
    'ai-assistance': 'Describe a workflow to create a test',
    'local-test-data': 'Manage reusable test data for this case',
    'test-options': 'Configure datasets, tracing and suite membership',
    save: 'Save workspace changes (Ctrl+S)',
    'directory-move': 'Move this test to a folder',
    'move-step': 'Move this step',
    'remove-step': 'Remove this step',
    'duplicate-step': 'Duplicate this step',
    'step-options': 'Configure this step',
  };

  const ENHANCED_CONTROLS = 'button,a.button,a.nav-item,.tabs [data-view],.folder-add > summary';
  const UNDECORATED_CONTROLS = '[data-theme-toggle],.folder-toggle,.folder-select,.folder-root,.mode-chip';

  // Templates may start labels with these. Only known prefixes go; user-entered names are untouched.
  const DECORATIVE_GLYPHS = '+＋×✕⧉⚒⚙▶▷▸▤▧▦◷◌⌄⌘⇢↗↓↑→←↳✧⌕◇◈▱⊞';
  const GLYPH_ONLY = new RegExp(`^[\\s\\u00a0${DECORATIVE_GLYPHS}−–—]+$`, 'u');
  const GLYPH_PREFIX = new RegExp(`^[\\s\\u00a0]*[${DECORATIVE_GLYPHS}]+\\s*`, 'u');

  const TOAST_HIDE_MS = 6000;
  const BUSY_DELAY_MS = 180;
  const TOOLTIP_HIDE_MS = 150;
  const POLL_TIMEOUT_MS = 15000;

  function icon(name = 'cases') {
    const tone = ICON_TONES[name] || 'blue';
    const path = ICON_PATHS[name] || ICON_PATHS.cases;
    return (
      `<svg class="studio-icon tone-${tone}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">` +
      `<path class="icon-symbol" d="${path}"/></svg>`
    );
  }

  function actionIcon(node) {
    const action = node.dataset.action || '';
    if (node.dataset.view && (!action || action === 'view')) {
      return ICON_PATHS[node.dataset.view] ? node.dataset.view : 'cases';
    }
    if (action === 'move-step') return node.dataset.direction === '-1' ? 'up' : 'down';
    if (ACTION_ICONS[action]) return ACTION_ICONS[action];
    const match = ACTION_ICON_PATTERNS.find(([pattern]) => pattern.test(action));
    if (match) return match[1];
    return node.type === 'submit' ? 'check' : 'arrow';
  }

  // A control that already has its own SVG still needs a name and a keyboard-visible tooltip.
  function nameIconOnlyControl(node) {
    if (node.textContent.trim()) return;
    const label =
      node.getAttribute('aria-label') ||
      node.title ||
      ACTION_TITLES[node.dataset.action] ||
      String(node.dataset.action || '').replaceAll('-', ' ');
    if (label && !node.hasAttribute('aria-label')) node.setAttribute('aria-label', label);
    if (label && !node.title) node.title = label;
    node.dataset.tooltip = node.title || label;
  }

  function stripGlyphs(node) {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.TEXT_NODE) {
        child.textContent = child.textContent.replace(GLYPH_PREFIX, '');
      } else if (child.matches?.('span:not([class])') && GLYPH_ONLY.test(child.textContent)) {
        child.remove();
      }
    }
    const isPlaceholderOptions = node.dataset.action === 'step-options' && node.textContent.trim() === '?';
    if ((GLYPH_ONLY.test(node.textContent) || isPlaceholderOptions) && !node.querySelector('input,select')) {
      node.textContent = '';
    }
  }

  function decorateControl(node) {
    const glyph = node.matches('.folder-add > summary') ? 'plus' : actionIcon(node);
    stripGlyphs(node);
    const description = ACTION_TITLES[node.dataset.action];
    const label = node.getAttribute('aria-label') || node.title || node.textContent.trim() || description || glyph;
    const isTextless = !node.textContent.trim();
    if (isTextless) node.setAttribute('aria-label', label);
    if (!node.title) node.title = description || label;
    if (isTextless) node.dataset.tooltip = node.title;
    node.insertAdjacentHTML('afterbegin', icon(glyph));
    node.classList.add('has-studio-icon');
    if (glyph === 'trash' || glyph === 'stop') node.classList.add('action-caution');
  }

  function enhance(root) {
    const controls = [...(root.querySelectorAll?.(ENHANCED_CONTROLS) || [])];
    if (root.matches?.(ENHANCED_CONTROLS)) controls.unshift(root);
    for (const node of controls) {
      if (node.querySelector('svg')) nameIconOnlyControl(node);
      else if (!node.matches(UNDECORATED_CONTROLS)) decorateControl(node);
    }
  }

  // Navigation is immediate; motion is reserved for interaction feedback.
  function enter() {}

  let toastTimer;

  function notify(message, isError = false) {
    const box = document.getElementById('toast');
    if (!box) return;
    clearTimeout(toastTimer);
    box.className = isError ? 'error error-toast' : 'success-toast';
    box.setAttribute('role', isError ? 'alert' : 'status');
    box.setAttribute('aria-live', isError ? 'assertive' : 'polite');

    const copy = document.createElement('span');
    copy.textContent = message;
    box.replaceChildren(copy);
    box.insertAdjacentHTML('afterbegin', icon(isError ? 'help' : 'check'));

    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'icon-button';
    dismiss.setAttribute('aria-label', 'Dismiss notification');
    dismiss.title = 'Dismiss notification';
    dismiss.innerHTML = icon('close');
    dismiss.addEventListener('click', () => {
      box.hidden = true;
    });
    box.append(dismiss);
    box.hidden = false;

    // Errors stay until dismissed. Hovering or focusing pauses success feedback.
    const scheduleHide = () => {
      clearTimeout(toastTimer);
      if (!isError) {
        toastTimer = setTimeout(() => {
          box.hidden = true;
        }, TOAST_HIDE_MS);
      }
    };
    const pauseHide = () => clearTimeout(toastTimer);
    box.onmouseenter = pauseHide;
    box.onfocusin = pauseHide;
    box.onmouseleave = scheduleHide;
    box.onfocusout = (event) => {
      if (!box.contains(event.relatedTarget)) scheduleHide();
    };
    scheduleHide();
  }

  function mountTooltips() {
    const tooltip = document.createElement('div');
    tooltip.id = 'studio-tooltip';
    tooltip.className = 'studio-tooltip';
    tooltip.setAttribute('role', 'tooltip');
    tooltip.hidden = true;
    document.body.append(tooltip);

    let owner;
    let hideTimer;

    function hide() {
      clearTimeout(hideTimer);
      if (owner) {
        const remaining = (owner.getAttribute('aria-describedby') || '')
          .split(' ')
          .filter((id) => id && id !== tooltip.id);
        if (remaining.length) owner.setAttribute('aria-describedby', remaining.join(' '));
        else owner.removeAttribute('aria-describedby');
      }
      tooltip.hidden = true;
      owner = null;
    }

    function show(node) {
      if (!node?.dataset.tooltip) return;
      hide();
      owner = node;
      (node.closest('dialog[open]') || document.body).append(tooltip);
      tooltip.textContent = node.dataset.tooltip;
      tooltip.hidden = false;
      const describedBy = [node.getAttribute('aria-describedby'), tooltip.id].filter(Boolean).join(' ');
      node.setAttribute('aria-describedby', describedBy);

      const rect = node.getBoundingClientRect();
      const size = tooltip.getBoundingClientRect();
      const centered = rect.left + rect.width / 2 - size.width / 2;
      const fitsBelow = rect.bottom + size.height + 12 < innerHeight;
      tooltip.style.left = `${Math.max(8, Math.min(innerWidth - size.width - 8, centered))}px`;
      tooltip.style.top = `${fitsBelow ? rect.bottom + 8 : Math.max(8, rect.top - size.height - 8)}px`;
    }

    document.addEventListener('pointerover', (event) => {
      const node = event.target.closest('[data-tooltip]');
      if (node && node !== owner) show(node);
    });
    document.addEventListener('pointerout', (event) => {
      const left = owner?.contains(event.target) && !owner.contains(event.relatedTarget);
      if (left && event.relatedTarget !== tooltip) hideTimer = setTimeout(hide, TOOLTIP_HIDE_MS);
    });
    tooltip.addEventListener('pointerenter', () => clearTimeout(hideTimer));
    tooltip.addEventListener('pointerleave', hide);
    document.addEventListener('focusin', (event) => show(event.target.closest('[data-tooltip]')));
    document.addEventListener('focusout', hide);
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') hide();
    });
    document.addEventListener('click', hide);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
  }

  const busyTasks = new Map();
  let busyTimer;

  function showBusy() {
    const node = document.getElementById('studio-busy');
    if (!node) return;
    const parent = document.querySelector('dialog[open]') || document.body;
    if (node.parentNode !== parent) parent.append(node);
    node.querySelector('.busy-label').textContent = [...busyTasks.values()].at(-1) || '';
    node.hidden = !busyTasks.size;
  }

  function begin(label = 'Working on your request') {
    const id = Symbol('busy task');
    busyTasks.set(id, label);
    clearTimeout(busyTimer);
    busyTimer = setTimeout(showBusy, BUSY_DELAY_MS);
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      busyTasks.delete(id);
      if (busyTasks.size) {
        showBusy();
        return;
      }
      clearTimeout(busyTimer);
      const node = document.getElementById('studio-busy');
      if (node) node.hidden = true;
    };
  }

  function busyLabel(url, method) {
    if (/requirements\/[^/]+\/generate/.test(url)) return 'Generating test cases';
    if (/ai\/(create|draft)/.test(url)) return 'Creating your automation';
    if (/debug.*close/.test(url)) return 'Closing the debug browser';
    if (/debug/.test(url)) return 'Preparing debug session';
    if (/record/.test(url)) return 'Updating your recording';
    if (/runs/.test(url)) return 'Preparing your test run';
    return method === 'DELETE' ? 'Removing item' : 'Saving your changes';
  }

  async function request(url, options = {}) {
    const isTracked = options.method && options.method !== 'GET';
    const end = isTracked ? begin(busyLabel(url, options.method)) : () => {};
    try {
      return await fetch(url, options);
    } finally {
      end();
    }
  }

  // Validators stay in this page's memory, so private workspace data is never cached on disk.
  const stateTags = new Map();

  async function pollState(url = '/api/state') {
    const headers = {};
    if (stateTags.has(url)) headers['If-None-Match'] = stateTags.get(url);
    const response = await request(url, {
      headers,
      cache: 'no-store',
      signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
    });
    if (response.status === 304) return null;
    const data = await response.json();
    if (!response.ok) {
      stateTags.delete(url);
      throw new Error(data.error || 'Could not refresh workspace');
    }
    const tag = response.headers.get('etag');
    if (tag) stateTags.set(url, tag);
    else stateTags.delete(url);
    return data;
  }

  const LOADER_HTML = `<section class="studio-loading" role="status" aria-live="polite" aria-busy="true">
    <span class="busy-spinner" aria-hidden="true"></span>
    <h2>Loading your workspace</h2>
    <p>Fetching projects, test cases, and execution results.</p>
    <div class="loading-skeleton" aria-hidden="true"><span></span><span></span><span></span></div>
  </section>`;

  const BUSY_HTML = `<div id="studio-busy" class="studio-busy" role="status" aria-live="polite" hidden>
    <span class="busy-spinner" aria-hidden="true"></span>
    <span class="busy-label"></span>
    <span class="busy-dots" aria-hidden="true"><i></i><i></i><i></i></span>
  </div>`;

  function mount() {
    const isAutomation = ['/automation', '/run-history'].includes(location.pathname);
    document.body.classList.add(isAutomation ? 'automation-studio' : 'qa-studio');

    const loading = document.querySelector('.loading') || document.querySelector('#content:empty');
    if (loading) loading.outerHTML = loading.id ? `<div id="content">${LOADER_HTML}</div>` : LOADER_HTML;

    document.body.insertAdjacentHTML('beforeend', BUSY_HTML);
    enhance(document.body);
    mountTooltips();

    new MutationObserver((records) => {
      for (const record of records) {
        const button = record.target.closest?.('button');
        if (button) enhance(button);
        for (const node of record.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE && !node.closest('svg')) enhance(node);
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  }

  window.StudioUI = { icon, enhance, enter, begin, request, pollState, notify };
  mount();
})();
