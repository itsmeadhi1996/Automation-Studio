import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { studioHeaders } from './auth-client.mjs';
import { createVault } from './storage.mjs';

const STOP_POLL_ATTEMPTS = 40;
const STOP_POLL_MS = 250;
const RECORDING_ID = /^[\w-]+$/;

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assertRestartIdle(status, message) {
  const recording = status.activeRecording;
  if (status.activeRun || status.activeDebug || (recording && recording.status !== 'stopped')) {
    throw new Error(message);
  }
  if (status.activeGenerations?.length) {
    throw new Error('A generation is still running. Finish or cancel it, then restart Studio.');
  }
  if (recording?.saving) {
    throw new Error('The stopped recording is still saving. Wait for it to finish, then restart Studio.');
  }
  if (recording?.saveError) {
    throw new Error('The stopped recording could not be saved. Resolve the recording save error in Studio before restarting.');
  }
}

export async function resolveStudioStorage(root, { storage, pid } = {}) {
  if (storage) return path.resolve(storage);
  if (!Number.isInteger(pid) || pid <= 0) return root;
  const candidates = [root, path.join(root, '.test-output', 'working-workspace')];
  const matches = [];
  for (const candidate of candidates) {
    try {
      const lock = JSON.parse(await readFile(path.join(candidate, 'data', 'studio.lock'), 'utf8'));
      if (lock.pid === pid) matches.push(candidate);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  if (matches.length !== 1) {
    throw new Error(
      'Cannot identify the running Studio workspace. Use the shortcut that started this server or set STUDIO_STORAGE_DIR.',
    );
  }
  return matches[0];
}

// createVault makes a key when none exists. The running server holds its key in
// memory, so a missing file here must stop the restart instead of replacing it.
async function verifyVaultAccess(directory) {
  try {
    await access(path.join(directory, 'credentials.key'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    throw new Error(
      'data/credentials.key is missing, so a restarted server could not open this workspace. ' +
        'Studio was not stopped and nothing was changed. Restore credentials.key from a backup made ' +
        'under the original account. See docs/RECOVERY.md.',
    );
  }
  await createVault(directory);
}

/**
 * Builds the default `kill`. On Windows, process.kill(pid, 'SIGTERM') ends the
 * process at once, skipping close(), so the server is asked to shut itself down.
 * It flushes saves and releases its workspace lock before exiting.
 */
export function studioStopper({ url, headers, request = fetch, platform = process.platform, killProcess = process.kill }) {
  return async (pid, signal) => {
    if (signal !== 'SIGTERM' || platform !== 'win32') return killProcess.call(process, pid, signal);
    let response;
    try {
      response = await request(`${url}/api/admin/shutdown`, {
        method: 'POST',
        headers: { ...JSON_HEADERS, ...headers },
        body: JSON.stringify({ pid }),
      });
    } catch {
      throw new Error('Could not ask Studio to stop. Studio was not stopped.');
    }
    // An older server has no shutdown route. Its data was flushed by the backup step.
    if (response.status === 404) return killProcess.call(process, pid, signal);
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(`Studio refused to stop: ${data.error || `HTTP ${response.status}`}`);
    }
    return undefined;
  };
}

async function readStatus(url, headers, request) {
  return request(`${url}/api/status`, { headers });
}

async function flushStoppedRecording(url, recording, headers, request) {
  if (typeof recording.id !== 'string' || !RECORDING_ID.test(recording.id)) {
    throw new Error('Cannot identify the stopped recording. Studio was not stopped.');
  }
  // Stopping an already stopped draft drains pending captures and saves it without discarding it.
  const response = await request(`${url}/api/recordings/${recording.id}/stop`, {
    method: 'POST',
    headers: { ...JSON_HEADERS, ...headers },
    body: '{}',
  });
  if (!response.ok) throw new Error('Could not save the stopped recording. Studio was not stopped.');
  const saved = await response.json();
  if (saved?.id !== recording.id || saved.status !== 'stopped' || saved.saving || saved.saveError) {
    throw new Error('Could not verify that the stopped recording was saved. Studio was not stopped.');
  }
}

async function readLockedPid(directory) {
  const { pid } = JSON.parse(await readFile(path.join(directory, 'studio.lock'), 'utf8'));
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
    throw new Error('Cannot identify the running Studio server.');
  }
  return pid;
}

export async function restartStudio({ url, directory, headers, request = fetch, unlock = verifyVaultAccess, kill, wait = pause }) {
  const authHeaders = headers ?? (await studioHeaders(url));

  const statusResponse = await readStatus(url, authHeaders, request);
  if (!statusResponse.ok) {
    const isAuthFailure = statusResponse.status === 401 || statusResponse.status === 403;
    throw Object.assign(
      new Error('Cannot verify Studio activity. Sign in with a QA Studio administrator account before restarting.'),
      { code: isAuthFailure ? 'STUDIO_RESTART_AUTH' : 'STUDIO_RESTART_STATUS' },
    );
  }
  const status = await statusResponse.json();
  assertRestartIdle(status, 'Finish the active run, debug session, or recording before restarting Studio.');

  // Prove this Windows account can reopen the vault before stopping anything.
  await unlock(directory);
  const pid = await readLockedPid(directory);

  if (status.activeRecording) {
    await flushStoppedRecording(url, status.activeRecording, authHeaders, request);
  }

  // The running server flushes pending saves before it copies the backup.
  const backup = await request(`${url}/api/backups`, {
    method: 'POST',
    headers: { ...JSON_HEADERS, ...authHeaders },
    body: '{}',
  });
  if (!backup.ok) throw new Error('Could not back up the workspace. Studio was not stopped.');
  await backup.json();

  const latestResponse = await readStatus(url, authHeaders, request);
  if (!latestResponse.ok) throw new Error('Cannot recheck Studio activity. Studio was not stopped.');
  const latest = await latestResponse.json();
  assertRestartIdle(latest, 'Studio became busy. Finish the active session before restarting.');
  if (latest.activeRecording && latest.activeRecording.id !== status.activeRecording?.id) {
    throw new Error('A new recording appeared during restart. Studio was not stopped. Save the recording and retry.');
  }

  const stop = kill ?? studioStopper({ url, headers: authHeaders, request });
  await stop(pid, 'SIGTERM');
  for (let attempt = 0; attempt < STOP_POLL_ATTEMPTS; attempt += 1) {
    await wait(STOP_POLL_MS);
    try {
      await stop(pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') return;
      throw error;
    }
  }
  throw new Error('Studio is still stopping. Wait a moment, then launch it again.');
}
