import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium, firefox } from 'playwright';

// Playwright says "Executable doesn't exist" for its own browsers and
// "Chromium distribution 'chrome' is not found" for an installed Chrome or Edge.
const MISSING_BROWSER_ERROR = /executable|distribution .* is not found|browser.*not found|not installed/i;
const MISSING_LIBRARIES_ERROR = /missing dependencies|error while loading shared libraries/i;
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000;
const CHANNELS = { chrome: 'chrome', edge: 'msedge' };
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
  process.env.STUDIO_NO_SCREEN !== '1' && (process.platform !== 'linux' || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY));

const installs = new Map();

// Downloads Playwright's Chromium or Firefox, once at a time, on a computer that does not have it.
export function installPlaywrightBrowser(name) {
  if (!installs.has(name)) {
    const cli = path.join(path.dirname(createRequire(import.meta.url).resolve('playwright/package.json')), 'cli.js');
    console.log(`Downloading Playwright ${name}. This happens once on each computer.`);
    const install = promisify(execFile)(process.execPath, [cli, 'install', name], {
      timeout: INSTALL_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    })
      .then(() => console.log(`Playwright ${name} is installed.`))
      .catch((error) => {
        const detail = `${error.stderr || ''}`.trim().split('\n').pop() || error.message.split('\n')[0];
        throw new Error(`Playwright ${name} could not be downloaded: ${detail}`);
      })
      .finally(() => installs.delete(name));
    installs.set(name, install);
  }
  return installs.get(name);
}

function explainLaunchError(error, label) {
  if (MISSING_LIBRARIES_ERROR.test(error.message)) {
    return new Error(
      `${label} is missing system libraries on this computer. ` +
        'Run "sudo npx playwright install-deps chromium firefox" in the QA Studio folder and retry.',
    );
  }
  return error;
}

// Launches Playwright's own Chromium or Firefox, downloading it first when it is missing.
export async function launchPlaywrightBrowser(type = chromium, options = {}) {
  const name = type === firefox ? 'firefox' : 'chromium';
  try {
    return await type.launch(options);
  } catch (error) {
    if (!MISSING_BROWSER_ERROR.test(error.message)) throw explainLaunchError(error, `Playwright ${name}`);
    await installPlaywrightBrowser(name);
    return type.launch(options).catch((retryError) => {
      throw explainLaunchError(retryError, `Playwright ${name}`);
    });
  }
}

export async function launchBrowser(name = 'chrome', { headless = true, slowMo = 0 } = {}) {
  // Replay and Debug follow along through step screenshots, so they still work without a window.
  if (!canShowBrowser()) headless = true;
  const type = browserType(name);
  const browserName = name || 'chrome';
  const channel = CHANNELS[browserName];
  const args = type === chromium ? CHROMIUM_ARGS : [];
  if (!channel) return launchPlaywrightBrowser(type, { args, headless, slowMo });
  try {
    return await type.launch({ channel, args, headless, slowMo });
  } catch (error) {
    if (!MISSING_BROWSER_ERROR.test(error.message)) throw explainLaunchError(error, browserLabels[browserName]);
    // Chrome or Edge is not installed on this computer, so use Playwright's Chromium,
    // which shares their engine.
    console.log(`${browserLabels[browserName]} is not installed; using Playwright Chromium.`);
    return launchPlaywrightBrowser(chromium, { args, headless, slowMo }).catch((fallbackError) => {
      throw new Error(
        `${browserLabels[browserName]} is not installed, and Chromium could not start either: ` +
          fallbackError.message.split('\n')[0],
      );
    });
  }
}
