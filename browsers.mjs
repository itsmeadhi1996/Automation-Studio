import { chromium, firefox } from 'playwright';

const MISSING_BROWSER_ERROR = /executable|browser.*not found|not installed/i;
const CHANNELS = { chrome: 'chrome', edge: 'msedge' };
const INSTALL_NAMES = { chrome: 'chrome', edge: 'msedge', firefox: 'firefox' };
// Installed Chrome and Edge upgrade http:// to https://. Headless browsers cannot fall back to
// http:// as a desktop browser does, so HTTP-only sites fail with net::ERR_BLOCKED_BY_CLIENT.
const CHROMIUM_ARGS = ['--disable-features=HttpsUpgrades,HttpsFirstBalancedModeAutoEnable'];

export const browserLabels = Object.freeze({
  chrome: 'Google Chrome',
  firefox: 'Firefox',
  edge: 'Microsoft Edge',
});

export function browserType(name = 'chrome') {
  if (name === 'firefox') {
    return firefox;
  }
  if (name === 'chrome' || name === 'edge' || !name) {
    return chromium;
  }
  throw new Error(`Unsupported browser: ${name}`);
}

// A Linux server without X (for example Render's Node runtime) cannot open a browser window.
// STUDIO_NO_SCREEN=1 does the same anywhere, for example when Studio runs as a Windows service.
export const canShowBrowser = () =>
  process.env.STUDIO_NO_SCREEN !== '1' && (process.platform !== 'linux' || Boolean(process.env.DISPLAY));

export async function launchBrowser(name = 'chrome', { headless = true, slowMo = 0 } = {}) {
  // Replay and Debug follow along through step screenshots, so they still work without a window.
  if (!canShowBrowser()) headless = true;
  const type = browserType(name);
  const browserName = name || 'chrome';
  const channel = CHANNELS[browserName];
  const args = type === chromium ? CHROMIUM_ARGS : [];
  try {
    return await type.launch({ ...(channel ? { channel } : {}), args, headless, slowMo });
  } catch (error) {
    // Linux servers such as Render cannot install Chrome or Edge without root, so use
    // Playwright's Chromium, which shares their engine.
    if (channel && process.platform === 'linux' && MISSING_BROWSER_ERROR.test(error.message)) {
      return chromium.launch({ args, headless, slowMo }).catch((fallbackError) => {
        throw new Error(
          `${browserLabels[browserName]} is not installed, and Chromium could not start either: ` +
            fallbackError.message.split('\n')[0],
        );
      });
    }
    if (MISSING_BROWSER_ERROR.test(error.message)) {
      throw new Error(
        `${browserLabels[browserName]} is not installed or could not be found. ` +
          `Install it with "npx playwright install ${INSTALL_NAMES[browserName]}" and retry.`,
      );
    }
    throw error;
  }
}
