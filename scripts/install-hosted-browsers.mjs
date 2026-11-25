// Runs after npm install. On Render's Node runtime, download Playwright's Chromium into the
// project folder, because Google Chrome cannot be installed there without root.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { hostedBrowsersPath } from '../hosting.mjs';

if (!process.env.RENDER || process.env.PLAYWRIGHT_BROWSERS_PATH !== hostedBrowsersPath) process.exit(0);

const cli = path.join(path.dirname(createRequire(import.meta.url).resolve('playwright/package.json')), 'cli.js');
const result = spawnSync(process.execPath, [cli, 'install', 'chromium'], {
  stdio: 'inherit',
  env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: hostedBrowsersPath },
});
// A failed download should not fail the deploy: QA Studio works without a browser.
if (result.status !== 0) console.warn('Chromium could not be installed; automation runs will fail until it is.');
