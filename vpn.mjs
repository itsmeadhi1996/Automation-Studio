import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { assert } from './model.mjs';

const COMMAND_TIMEOUT_MS = 15000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const PROFILE_ID = /^[\w-]{1,120}$/;

const execute = promisify(execFile);

function defaultExecutable() {
  if (process.env.OPENVPN_CONNECT_PATH) return process.env.OPENVPN_CONNECT_PATH;
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  return path.join(programFiles, 'OpenVPN Connect', 'OpenVPNConnect.exe');
}

// Native output can hold account details, so errors are always replaced with fixed text.
function commandFailure(error) {
  const timedOut = error.killed || error.code === 'ETIMEDOUT';
  return new Error(
    timedOut
      ? 'OpenVPN Connect did not respond. Open the desktop client, finish any prompts, then retry.'
      : 'OpenVPN Connect could not run. Check that the client is installed and available to the Studio Windows user.',
  );
}

function parseOutput(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    throw new Error('OpenVPN Connect returned an unexpected response. Open the desktop client and finish any startup prompts.');
  }
  if (result?.status === 'error') {
    if (/gdpr|consent/i.test(String(result.error))) {
      throw new Error('Open OpenVPN Connect and review its first-run consent before discovering profiles.');
    }
    throw new Error('OpenVPN Connect rejected the request. Check the desktop client for details.');
  }
  return result;
}

function publicProfile(profile) {
  assert(
    typeof profile.id === 'string' && PROFILE_ID.test(profile.id),
    'OpenVPN Connect returned an invalid profile ID.',
  );
  return {
    id: profile.id,
    name: String(profile.name || profile.id).slice(0, 250),
    type: String(profile.type || '').slice(0, 80),
  };
}

// Uses the desktop client's supported shortcuts. Authentication stays in OpenVPN
// Connect, so a request succeeding never means the tunnel is up.
export class OpenVpnConnect {
  constructor({ platform = process.platform, executable = defaultExecutable(), run = execute, exists = access } = {}) {
    this.platform = platform;
    this.executable = executable;
    this.run = run;
    this.exists = exists;
    this.busy = false;
    this.lastAction = null;
  }

  async status() {
    const supported = this.platform === 'win32';
    let installed = false;
    if (supported) {
      try {
        await this.exists(this.executable);
        installed = true;
      } catch {
        installed = false;
      }
    }
    return { supported, installed, busy: this.busy, lastAction: this.lastAction, tunnelStatus: 'unknown' };
  }

  async command(args) {
    const { supported, installed } = await this.status();
    assert(supported, 'OpenVPN Connect integration currently supports Windows.');
    assert(installed, 'OpenVPN Connect was not found. Install it or set OPENVPN_CONNECT_PATH on the Studio server.');
    let output;
    try {
      output = await this.run(this.executable, args, {
        windowsHide: true,
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        cwd: path.dirname(this.executable),
      });
    } catch (error) {
      throw commandFailure(error);
    }
    return parseOutput(output.stdout);
  }

  async profiles() {
    const result = await this.command(['--list-profiles']);
    assert(Array.isArray(result), 'OpenVPN Connect did not return a profile list. Open the desktop client and retry.');
    return result.map(publicProfile);
  }

  async action(action, profileId) {
    assert(action === 'connect' || action === 'disconnect', 'Unsupported VPN action');
    assert(!this.busy, 'An OpenVPN request is already in progress.');
    this.busy = true;
    try {
      let args = ['--disconnect-shortcut'];
      let requestedProfileId = null;
      if (action === 'connect') {
        assert(typeof profileId === 'string' && PROFILE_ID.test(profileId), 'Select an OpenVPN profile first.');
        const profiles = await this.profiles();
        const profile = profiles.find((candidate) => candidate.id === profileId);
        assert(profile, 'The selected profile no longer exists. Refresh profiles and select one.');
        args = [`--connect-shortcut=${profile.id}`];
        requestedProfileId = profile.id;
      }
      await this.command(args);
      this.lastAction = { action, profileId: requestedProfileId, requestedAt: new Date().toISOString() };
      return this.lastAction;
    } finally {
      this.busy = false;
    }
  }
}
