// Imported first by server.mjs: Playwright reads PLAYWRIGHT_BROWSERS_PATH when it loads.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Render keeps only the project folder between build and run, so its browsers live there.
// The Docker image sets its own PLAYWRIGHT_BROWSERS_PATH, which is left alone.
export const hostedBrowsersPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '.browsers');

if (process.env.RENDER && !process.env.PLAYWRIGHT_BROWSERS_PATH) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = hostedBrowsersPath;
}
