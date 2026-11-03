import { setTimeout as sleep } from 'node:timers/promises';

const DEFAULT_STEP_TIMEOUT_MS = 10000;
const MIN_LOADING_ALLOWANCE_MS = 30000;
const MAX_LOADING_ALLOWANCE_MS = 120000;
const DEFAULT_READINESS_TIMEOUT_MS = 30000;
const READINESS_POLL_MS = 50;
const DOM_QUIET_MS = 150;
const RENDERING_SETTLE_CAP_MS = 2000;
const ACTION_POLL_MS = 50;
const ACTION_QUIET_CAP_MS = 500;
const RENDERING_REASON = 'page rendering';
const TRANSIENT_FRAME_ERROR = /Execution context was destroyed|Cannot find context|Frame was detached|frame has been detached/i;
const TRACKED_RESOURCE_TYPES = ['fetch', 'xhr'];

export function loadingTimeout(timeout) {
  const requested = timeout || DEFAULT_STEP_TIMEOUT_MS;
  return Math.min(MAX_LOADING_ALLOWANCE_MS, Math.max(MIN_LOADING_ALLOWANCE_MS, requested));
}

// Serialized into each frame by Playwright, so it cannot use anything from this module.
function probeFrameReadiness({ fullPage, quietMs, renderingReason }) {
  const studioOverlays = 'qa-studio-locator-focus, qa-studio-recorder-feedback';
  const isOverlay = (node) => node?.nodeType === 1 && node.closest(studioOverlays) !== null;
  const changesPage = (record) => {
    if (isOverlay(record.target)) {
      return false;
    }
    if (record.type !== 'childList') {
      return true;
    }
    return ![...record.addedNodes, ...record.removedNodes].every(isOverlay);
  };

  if (window.__qaPageReadiness?.document !== document) {
    const fresh = { document, changed: performance.now(), roots: new WeakSet() };
    fresh.observer = new MutationObserver((records) => {
      if (records.some(changesPage)) {
        fresh.changed = performance.now();
      }
    });
    window.__qaPageReadiness = fresh;
  }
  const state = window.__qaPageReadiness;

  const elements = [];
  const collectElements = (root) => {
    if (!state.roots.has(root)) {
      state.observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
      state.roots.add(root);
    }
    for (const element of root.querySelectorAll('*')) {
      if (isOverlay(element)) {
        continue;
      }
      elements.push(element);
      if (element.shadowRoot) {
        collectElements(element.shadowRoot);
      }
    }
  };
  collectElements(document);

  const isShown = (element) => {
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const isOutsideViewport = (element) => {
    const box = element.getBoundingClientRect();
    return box.bottom <= 0 || box.top >= innerHeight || box.right <= 0 || box.left >= innerWidth;
  };

  if (document.readyState !== 'complete') {
    return 'document loading';
  }
  if (document.fonts?.status === 'loading') {
    return 'fonts loading';
  }
  if (elements.some((element) => element.getAttribute('aria-busy') === 'true' && isShown(element))) {
    return 'visible loading indicator (aria-busy)';
  }

  // A pending image can have zero size until its bytes arrive, so this does not use isShown.
  for (const image of elements) {
    if (image.tagName !== 'IMG' || !image.getClientRects().length) {
      continue;
    }
    if (getComputedStyle(image).visibility === 'hidden') {
      continue;
    }
    if (!fullPage && isOutsideViewport(image)) {
      continue;
    }
    if ((image.currentSrc || image.src) && !image.complete) {
      return 'images loading';
    }
    if (image.complete && image.naturalWidth && image.currentSrc !== image.__qaDecodedSource) {
      const source = image.currentSrc;
      if (image.__qaDecodingSource !== source) {
        image.__qaDecodingSource = source;
        image
          .decode()
          .catch(() => {})
          .then(() => {
            image.__qaDecodedSource = source;
          });
      }
      return 'images decoding';
    }
  }

  return performance.now() - state.changed < quietMs ? renderingReason : '';
}

function pickBlockingReason(reasons) {
  const blocking = reasons.find((reason) => reason && reason !== RENDERING_REASON);
  return blocking || reasons.find(Boolean) || '';
}

function sameFrames(before, after) {
  return before.length === after.length && before.every((frame) => after.includes(frame));
}

// Bounded on purpose: background connections never have to become network-idle.
export async function waitForPageReady(page, { timeout = DEFAULT_READINESS_TIMEOUT_MS, fullPage = false } = {}) {
  const startedAt = Date.now();
  const deadline = startedAt + timeout;
  const renderingAllowance = Math.min(RENDERING_SETTLE_CAP_MS, timeout / 2);
  const probeOptions = { fullPage, quietMs: DOM_QUIET_MS, renderingReason: RENDERING_REASON };
  let reason = 'document loading';

  while (Date.now() < deadline) {
    if (page.isClosed()) {
      throw new Error('Page closed while waiting for it to finish loading');
    }
    try {
      const frames = page.frames();
      const reasons = await Promise.all(frames.map((frame) => frame.evaluate(probeFrameReadiness, probeOptions)));
      reason = pickBlockingReason(reasons);
      // Live clocks and rotating banners must not block a loaded page forever.
      const liveContentOnly = reason === RENDERING_REASON && Date.now() - startedAt >= renderingAllowance;
      if ((!reason || liveContentOnly) && sameFrames(frames, page.frames())) {
        return;
      }
    } catch (error) {
      if (!TRANSIENT_FRAME_ERROR.test(error.message)) {
        throw error;
      }
      reason = 'page navigation';
    }
    await sleep(READINESS_POLL_MS);
  }

  const error = new Error(`Page did not finish loading within ${timeout} ms: ${reason || 'frames loading'}.`);
  error.name = 'PageReadinessError';
  throw error;
}

// Only read-only preparation goes through here. A click, submission or upload is never replayed.
export async function recoverReadiness(operation, timeout, { retry = true } = {}) {
  try {
    return await operation(timeout);
  } catch (error) {
    if (!retry || error.name !== 'TimeoutError') {
      throw error;
    }
    return operation(loadingTimeout(timeout));
  }
}

function trackPageActivity(page) {
  const tracker = {
    pending: new Set(),
    lastActivity: Date.now(),
    navigationCount: 0,
    version: 0,
    documentNavigation: null,
    touch() {
      tracker.lastActivity = Date.now();
      tracker.version += 1;
    },
  };

  const settleRequest = (request) => {
    if (tracker.pending.delete(request)) {
      tracker.touch();
    }
  };
  const listeners = {
    request(request) {
      const isNavigation = request.isNavigationRequest();
      if (isNavigation && request.frame() === page.mainFrame()) {
        tracker.documentNavigation = request;
      }
      if (isNavigation || TRACKED_RESOURCE_TYPES.includes(request.resourceType())) {
        tracker.pending.add(request);
        tracker.touch();
      }
    },
    requestfinished: settleRequest,
    requestfailed(request) {
      if (tracker.documentNavigation === request) {
        tracker.documentNavigation = null;
      }
      settleRequest(request);
    },
    response(response) {
      // An event stream never finishes, so it is not a finite action result.
      const contentType = response.headers()['content-type'] || '';
      if (contentType.includes('text/event-stream')) {
        settleRequest(response.request());
      }
    },
    framenavigated(frame) {
      if (frame === page.mainFrame()) {
        tracker.navigationCount += 1;
        // Fetches abandoned by a real navigation may never report completion, while a
        // same-document SPA route change does not abandon its requests.
        if (tracker.documentNavigation) {
          tracker.pending.clear();
          tracker.documentNavigation = null;
        }
      }
      tracker.touch();
    },
  };

  for (const [event, listener] of Object.entries(listeners)) {
    page.on(event, listener);
  }
  tracker.stop = () => {
    for (const [event, listener] of Object.entries(listeners)) {
      page.off(event, listener);
    }
  };
  return tracker;
}

async function waitForRedirect(page, tracker, remaining, url) {
  while (!tracker.navigationCount) {
    await sleep(Math.min(ACTION_POLL_MS, remaining()));
  }
  if (url) {
    await page.waitForURL(url, { timeout: remaining(), waitUntil: 'commit' });
  }
}

// New requests extend the quiet window, but never the overall deadline.
async function waitForActivityToSettle(page, tracker, remaining, quietWindow) {
  for (;;) {
    const left = remaining();
    const isQuiet = !tracker.pending.size && Date.now() - tracker.lastActivity >= quietWindow;
    if (isQuiet) {
      const versionBefore = tracker.version;
      await waitForPageReady(page, { timeout: left });
      if (versionBefore === tracker.version && !tracker.pending.size) {
        return;
      }
    }
    await sleep(Math.min(ACTION_POLL_MS, remaining()));
  }
}

// Listeners attach before the action runs so a fast navigation cannot be missed.
export async function waitAfterAction(
  page,
  action,
  { timeout = DEFAULT_READINESS_TIMEOUT_MS, mode = 'auto', url = '' } = {},
) {
  if (mode === 'none') {
    return action();
  }
  const tracker = trackPageActivity(page);
  try {
    const result = await action();
    const deadline = Date.now() + timeout;
    tracker.touch();

    const remaining = () => {
      if (page.isClosed()) {
        throw new Error('Page closed while waiting for the action to finish');
      }
      const left = deadline - Date.now();
      if (left <= 0) {
        const redirectMissing = mode === 'redirect' && !tracker.navigationCount;
        const error = new Error(
          redirectMissing
            ? `The action completed, but the expected page redirect did not occur within ${timeout} ms.`
            : `The page did not settle after the action within ${timeout} ms.`,
        );
        error.name = 'TimeoutError';
        throw error;
      }
      return left;
    };

    if (mode === 'redirect') {
      await waitForRedirect(page, tracker, remaining, url);
    }
    await waitForActivityToSettle(page, tracker, remaining, Math.min(ACTION_QUIET_CAP_MS, timeout / 4));
    return result;
  } finally {
    tracker.stop();
  }
}
