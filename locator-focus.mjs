import { setTimeout as sleep } from 'node:timers/promises';
import { loadingTimeout, waitForPageReady } from './page-readiness.mjs';

const DEFAULT_FOCUS_TIMEOUT_MS = 5000;
const FOCUS_RETRY_MS = 50;
const REFOCUS_SCROLL_TIMEOUT_MS = 1500;
const DETACHED_TARGET_ERROR =
  /not attached to the DOM|[Ee]lement.*detached|Target detached or hidden|Execution context was destroyed|Cannot find context|[Ff]rame.*detached/;
const MASKED_FIELDS = 'input[type=password], [data-studio-sensitive], [data-private]';

function centerInViewport(node) {
  node.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
}

// Focus here is visual only: it never clicks or moves keyboard focus.
export async function clearLocatorFocus(page) {
  const clearing = page.frames().map((frame) => frame.evaluate(() => window.__qaLocatorFocus?.remove()));
  await Promise.allSettled(clearing);
}

export async function focusLocator(page, target, { timeout = DEFAULT_FOCUS_TIMEOUT_MS, highlight = true } = {}) {
  const deadline = Date.now() + timeout;
  let lastError;

  const remaining = () => {
    const left = deadline - Date.now();
    if (left <= 0) {
      const detail = lastError ? `: ${lastError.message}` : '.';
      const error = new Error(`Could not bring the target into view within ${timeout} ms${detail}`);
      error.name = 'TimeoutError';
      throw error;
    }
    return left;
  };

  await page.bringToFront();

  // Scrolling can trigger a framework render or a virtualized list update, so the
  // locator is resolved again after a detachment. The real action is never retried here.
  for (;;) {
    let handle;
    try {
      await target.waitFor({ state: 'visible', timeout: remaining() });
      await target.scrollIntoViewIfNeeded({ timeout: remaining() });
      await target.evaluate(centerInViewport, undefined, { timeout: remaining() });
      await target.scrollIntoViewIfNeeded({ timeout: remaining() });
      handle = await target.elementHandle({ timeout: remaining() });

      const attached = handle && (await handle.isVisible()) && (await handle.evaluate((node) => node.isConnected));
      if (!attached) {
        throw new Error('Target detached or hidden while bringing it into view');
      }
      if (highlight && !(await highlightLocator(handle))) {
        throw new Error('Target detached or hidden while highlighting');
      }
      return handle;
    } catch (error) {
      await handle?.dispose().catch(() => {});
      if (page.isClosed() || !DETACHED_TARGET_ERROR.test(error.message)) {
        throw error;
      }
      lastError = error;
      await sleep(Math.min(FOCUS_RETRY_MS, remaining()));
    }
  }
}

export async function highlightLocator(handle) {
  return handle.evaluate((node) => {
    window.__qaLocatorFocus?.remove();
    const initialBox = node.getBoundingClientRect();
    if (!node.isConnected || !initialBox.width || !initialBox.height) {
      return false;
    }

    const host = document.createElement('qa-studio-locator-focus');
    host.style.cssText =
      'all:initial!important;position:fixed!important;inset:0!important;z-index:2147483646!important;pointer-events:none!important';
    const ring = document.createElement('div');
    ring.setAttribute('data-locator-focus', '');
    ring.style.cssText =
      'position:fixed;box-sizing:border-box;border:3px solid #e5484d;border-radius:3px;pointer-events:none';
    host.attachShadow({ mode: 'open' }).append(ring);
    document.documentElement.append(host);

    let animationFrame;
    const followTarget = () => {
      const box = node.getBoundingClientRect();
      ring.hidden = !node.isConnected || !box.width || !box.height;
      ring.style.left = `${box.left}px`;
      ring.style.top = `${box.top}px`;
      ring.style.width = `${box.width}px`;
      ring.style.height = `${box.height}px`;
      animationFrame = requestAnimationFrame(followTarget);
    };
    window.__qaLocatorFocus = {
      remove() {
        cancelAnimationFrame(animationFrame);
        host.remove();
        delete window.__qaLocatorFocus;
      },
    };
    followTarget();
    return true;
  });
}

export async function refocusLocator(handle) {
  if (!handle || !(await handle.isVisible())) {
    return false;
  }
  await handle.scrollIntoViewIfNeeded({ timeout: REFOCUS_SCROLL_TIMEOUT_MS });
  await handle.evaluate(centerInViewport);
  return highlightLocator(handle);
}

async function restoreLazyLoading(images) {
  const restoring = images.map(async (image) => {
    try {
      await image.evaluate((node) => {
        node.loading = 'lazy';
      });
    } finally {
      await image.dispose();
    }
  });
  await Promise.allSettled(restoring);
}

export async function screenshotPage(page, { waitForReady = true, ...options } = {}) {
  const timeout = loadingTimeout(options.timeout);
  const lazyImages = [];
  try {
    // A full-page capture does not scroll, so offscreen lazy images must be requested explicitly.
    if (waitForReady && options.fullPage) {
      for (const frame of page.frames()) {
        for (const image of await frame.locator('img[loading="lazy"]').elementHandles()) {
          lazyImages.push(image);
          await image.evaluate((node) => {
            node.loading = 'eager';
          });
        }
      }
    }
    if (waitForReady) {
      await waitForPageReady(page, { timeout, fullPage: Boolean(options.fullPage) });
    }
    return await page.screenshot({
      ...options,
      timeout,
      animations: 'disabled',
      mask: page.frames().map((frame) => frame.locator(MASKED_FIELDS)),
    });
  } finally {
    await restoreLazyLoading(lazyImages);
  }
}
