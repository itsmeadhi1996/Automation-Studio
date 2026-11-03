import { execFile, spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceVersion } from './runtime-version.mjs';
import { resolveStudioStorage, restartStudio } from './studio-restart.mjs';

const DEFAULT_PORT = 3300;
const READY_TIMEOUT_MS = 1000;
const START_POLL_ATTEMPTS = 30;
const START_POLL_MS = 500;
const EXIT_NEEDS_SIGN_IN = 3;

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || DEFAULT_PORT);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');

const url = `http://127.0.0.1:${port}`;
const flags = process.argv.slice(2);
const installedVersion = await sourceVersion(root);

let runningVersion;
let runningPid;

async function ready() {
  try {
    const response = await fetch(`${url}/api/auth/session`, { signal: AbortSignal.timeout(READY_TIMEOUT_MS) });
    if (response.status === 404) {
      const legacy = await fetch(`${url}/api/state`, { signal: AbortSignal.timeout(READY_TIMEOUT_MS) });
      runningVersion = undefined;
      runningPid = undefined;
      return legacy.ok && Array.isArray((await legacy.json()).projects);
    }
    if (!response.ok) return false;
    const session = await response.json();
    runningVersion = session.runtime?.sourceVersion;
    runningPid = session.runtime?.pid;
    return typeof session.setupRequired === 'boolean';
  } catch {
    return false;
  }
}

// Returns false when the launcher should stop with the exit code it has set.
async function restartIfRequested(isRunning, storage) {
  const isOutdated = flags.includes('--upgrade') && runningVersion !== installedVersion;
  if (!isRunning || !(flags.includes('--restart') || isOutdated)) return true;

  console.log('Restart required to load the installed QA Studio files.');
  try {
    await restartStudio({ url, directory: path.join(storage, 'data') });
    console.log('Restarting Studio to load the latest code.');
    return true;
  } catch (error) {
    console.error(error.message);
    if (error.code === 'STUDIO_RESTART_AUTH') {
      console.error('Use Start QA Studio.cmd or Restart QA Studio.cmd to sign in locally and complete the restart.');
      process.exitCode = EXIT_NEEDS_SIGN_IN;
    } else {
      process.exitCode = 1;
    }
    return false;
  }
}

function serverEnvironment(storage) {
  const environment = { ...process.env, STUDIO_STORAGE_DIR: storage };
  const isWorkingWorkspace = storage === path.join(root, '.test-output', 'working-workspace');
  if (!environment.PLAYWRIGHT_BROWSERS_PATH && isWorkingWorkspace) {
    environment.PLAYWRIGHT_BROWSERS_PATH = path.join(root, '.test-output', 'playwright-browsers');
  }
  // Restart credentials are for the launcher only, never the background server.
  for (const name of ['STUDIO_USERNAME', 'STUDIO_PASSWORD', 'STUDIO_SESSION_TOKEN']) {
    delete environment[name];
  }
  return environment;
}

async function startServer(storage) {
  const out = openSync(path.join(root, 'server.stdout.log'), 'a');
  const err = openSync(path.join(root, 'server.stderr.log'), 'a');
  const child = spawn(process.execPath, [path.join(root, 'server.mjs')], {
    cwd: root,
    env: serverEnvironment(storage),
    detached: true,
    windowsHide: true,
    stdio: ['ignore', out, err],
  });
  child.on('error', (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.unref();
  closeSync(out);
  closeSync(err);
  for (let attempt = 0; attempt < START_POLL_ATTEMPTS && !(await ready()); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, START_POLL_MS));
  }
}

function openBrowser() {
  if (!flags.includes('--open') || process.platform !== 'win32') return;
  const command = `Start-Process '${url}'`;
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true }, (error) => {
    if (error) console.log('Open the URL above in your browser.');
  });
}

async function launch() {
  const isRunning = await ready();
  const storage = await resolveStudioStorage(root, {
    storage: process.env.STUDIO_STORAGE_DIR,
    pid: isRunning ? runningPid : undefined,
  });
  if (!(await restartIfRequested(isRunning, storage))) return;

  if (!(await ready())) await startServer(storage);

  if (!(await ready())) {
    console.error('Studio did not start. Check server.stderr.log and run npm run doctor.');
    process.exitCode = 1;
    return;
  }
  if (runningVersion !== installedVersion) {
    console.error(`Port ${port} is still serving an older Studio process. Run Restart QA Studio.cmd from the workspace folder.`);
    process.exitCode = 1;
    return;
  }
  console.log(`QA Studio is ready: ${url}`);
  openBrowser();
}

try {
  await launch();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
