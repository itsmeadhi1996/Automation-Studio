import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DPAPI_TIMEOUT_MS = 15000;
const IV_BYTES = 12;
const TAG_BYTES = 16;

const UNLOCK_FAILURE =
  'Cannot unlock workspace credentials for this Windows user. Start the server from the Windows ' +
  'account that created data/credentials.key (a normal, loaded user session; not a service or ' +
  'sandboxed account). To recover on another account, restore credentials.key from a backup made ' +
  'under the original account. See docs/RECOVERY.md.';

const MISSING_KEY_FAILURE =
  'data/credentials.key is missing, but this workspace contains encrypted data that needs it. ' +
  'Nothing was changed. Restore credentials.key from a backup made under the original account. ' +
  'See docs/RECOVERY.md.';

const PROTECTED_KEYS = new Set([
  'agentDrafts',
  'password',
  'apiKey',
  'apiKeys',
  'globalVariables',
  'variables',
  'globals',
  'environment',
  'dataRow',
  'dataRows',
  'localTestData',
  'localValues',
  'localDataFile',
  'projectMembers',
  'projectAccessRevisions',
  'workLog',
]);

function dpapi(bytes, decrypt = false) {
  return new Promise((resolve, reject) => {
    const method = decrypt ? 'Unprotect' : 'Protect';
    const script =
      'Add-Type -AssemblyName System.Security; ' +
      '$bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd()); ' +
      `$result=[Security.Cryptography.ProtectedData]::${method}($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); ` +
      '[Console]::Out.Write([Convert]::ToBase64String($result))';
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.resume();
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Windows credential protection timed out'));
    }, DPAPI_TIMEOUT_MS);
    child.on('error', () => {
      clearTimeout(timer);
      reject(new Error('Windows credential protection could not start'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && output.trim()) resolve(Buffer.from(output.trim(), 'base64'));
      else reject(new Error(UNLOCK_FAILURE));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(bytes.toString('base64'));
  });
}

async function fileHasSealedData(file) {
  try {
    return (await readFile(file, 'utf8')).includes('"$sealed"');
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

// A new key would orphan anything already sealed, so look everywhere sealed data can live.
async function workspaceHasSealedData(directory) {
  const names = await readdir(directory);
  const candidates = names
    .filter((name) => /^(studio\.json|recording\.json|backup-[\w-]+\.json)$/.test(name))
    .map((name) => path.join(directory, name));
  if (names.includes('local-test-files')) {
    const uploads = await readdir(path.join(directory, 'local-test-files'));
    candidates.push(...uploads.map((name) => path.join(directory, 'local-test-files', name)));
  }
  for (const file of candidates) {
    if (await fileHasSealedData(file)) return true;
  }
  return false;
}

async function createKey(file, directory) {
  if (await workspaceHasSealedData(directory)) throw new Error(MISSING_KEY_FAILURE);
  const key = randomBytes(32);
  const wrapped =
    process.platform === 'win32'
      ? { dpapi: (await dpapi(key)).toString('base64') }
      : { key: key.toString('base64') };
  await writeFile(file, JSON.stringify(wrapped), { mode: 0o600, flag: 'wx' });
  return key;
}

async function loadKey(directory) {
  const file = path.join(directory, 'credentials.key');
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return createKey(file, directory);
  }
  let saved;
  try {
    saved = JSON.parse(text);
  } catch {
    throw new Error(UNLOCK_FAILURE);
  }
  if (saved.dpapi) return dpapi(Buffer.from(saved.dpapi, 'base64'), true);
  const key = Buffer.from(String(saved.key ?? ''), 'base64');
  if (key.length !== 32) throw new Error(UNLOCK_FAILURE);
  return key;
}

export async function createVault(directory) {
  const key = await loadKey(directory);

  const seal = (value) => {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return { $sealed: Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64') };
  };

  const open = (value) => {
    const data = Buffer.from(value.$sealed, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, IV_BYTES));
    decipher.setAuthTag(data.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    const plain = Buffer.concat([decipher.update(data.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]);
    return JSON.parse(plain.toString());
  };

  const isSealed = (value) => Boolean(value) && typeof value === 'object' && typeof value.$sealed === 'string';

  const encode = (value) => {
    if (isSealed(value)) return value;
    if (Array.isArray(value)) return value.map(encode);
    if (!value || typeof value !== 'object') return value;
    const result = {};
    for (const [name, item] of Object.entries(value)) {
      const shouldSeal = PROTECTED_KEYS.has(name) || (name === 'value' && value.sensitive);
      result[name] = shouldSeal && !isSealed(item) ? seal(item) : encode(item);
    }
    return result;
  };

  // Opened values can contain nothing sealed, but legacy plaintext can sit beside sealed fields.
  const decode = (value) => {
    if (isSealed(value)) return open(value);
    if (Array.isArray(value)) return value.map(decode);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, decode(item)]));
  };

  return { encode, decode };
}
