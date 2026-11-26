// Run by the start scripts before launch.mjs, so a computer with only Node.js can start Studio:
// installs the npm packages when they are missing or package-lock.json has changed, then
// downloads Playwright's Chromium when it is missing. Firefox downloads on its first run.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lockFile = path.join(root, 'package-lock.json');
const stamp = path.join(root, 'node_modules', '.studio-install');
const nodeDir = path.dirname(process.execPath);

const lockHash = () => createHash('sha256').update(readFileSync(lockFile)).digest('hex');

// npm ships beside node: in the same folder on Windows, in ../lib on Linux and macOS.
function npmCommand() {
  const bundled = [
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].find((file) => existsSync(file));
  return bundled ? [process.execPath, [bundled]] : ['npm', [], { shell: true }];
}

function installPackages() {
  const installed = existsSync(path.join(root, 'node_modules', '.package-lock.json'));
  // A folder installed before this script existed has packages but no stamp yet.
  if (installed && !existsSync(stamp)) writeFileSync(stamp, lockHash());
  if (installed && readFileSync(stamp, 'utf8') === lockHash()) return;
  console.log('Installing QA Studio packages. This takes a few minutes the first time.');
  const [command, args, options = {}] = npmCommand();
  // npm scripts call "node", which may be the private copy in .runtime rather than one on PATH.
  const env = { ...process.env, PATH: `${nodeDir}${path.delimiter}${process.env.PATH || ''}` };
  // A running Studio keeps using node_modules, so update it in place rather than deleting it.
  const mode = installed ? ['install'] : ['ci'];
  const result = spawnSync(command, [...args, ...mode, '--no-audit', '--no-fund'], {
    cwd: root,
    env,
    stdio: 'inherit',
    ...options,
  });
  if (result.status !== 0) {
    throw new Error('npm could not install the QA Studio packages. Check the internet connection and run the start script again.');
  }
  writeFileSync(stamp, lockHash());
}

async function installChromium() {
  const { chromium } = await import('playwright');
  if (existsSync(chromium.executablePath())) return;
  const { installPlaywrightBrowser } = await import('../browsers.mjs');
  try {
    await installPlaywrightBrowser('chromium');
  } catch (error) {
    // Studio still opens; runs download Chromium again when they need it.
    console.warn(`${error.message}\nStudio will start, and will try again when a test run needs a browser.`);
  }
}

try {
  installPackages();
  await installChromium();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
