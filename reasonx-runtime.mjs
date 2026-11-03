import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const STARTUP_DEADLINE_MS = 30000;
const POLL_INTERVAL_MS = 1000;
const JAVA_ARGS = ['-Xms64m', '-Xmx384m', '-jar'];

// Launches only the installed JAR, never a command supplied by an HTTP client.
export function createReasonxRuntime({
  home,
  launch = spawn,
  inspect = stat,
  pause = delay,
  attempts = 30,
  now = Date.now,
} = {}) {
  let pending = null;
  let child = null;

  async function launchJar() {
    const jar = path.join(home, 'target', 'reasonx-console.jar');
    try {
      if (!(await inspect(jar)).isFile()) throw new Error('Not a file');
    } catch {
      throw new Error(
        'ReasonX is not installed at the configured location. Set REASONX_HOME to its project folder and restart Studio.',
      );
    }

    // Detached and unreferenced, so ReasonX keeps running after Studio stops.
    const current = launch(process.env.REASONX_JAVA || 'java', [...JAVA_ARGS, jar], {
      cwd: home,
      windowsHide: true,
      detached: true,
      stdio: 'ignore',
      shell: false,
    });
    child = current;
    current.once('exit', () => {
      if (child === current) child = null;
    });

    try {
      await new Promise((resolve, reject) => {
        current.once('spawn', resolve);
        current.once('error', reject);
      });
    } catch {
      child = null;
      throw new Error('Could not start ReasonX. Install Java 21 or set REASONX_JAVA to its executable, then try again.');
    }
    current.unref();
  }

  async function startOrAttach(probe) {
    if ((await probe()).reachable) return { status: 'running', alreadyRunning: true };
    if (!child) await launchJar();

    const deadline = now() + STARTUP_DEADLINE_MS;
    for (let attempt = 0; attempt < attempts && now() < deadline; attempt += 1) {
      if ((await probe()).reachable) return { status: 'running', alreadyRunning: false };
      if (!child) {
        throw new Error(
          'ReasonX stopped during startup. Check Java 21 and whether ports 8080 and 8081 are available, then try again.',
        );
      }
      await pause(POLL_INTERVAL_MS);
    }
    return {
      status: 'starting',
      message: 'ReasonX is still starting. Wait a moment, then use Check connection. Keep Ollama running for generation.',
    };
  }

  return {
    start(probe) {
      if (!pending) {
        pending = startOrAttach(probe).finally(() => {
          pending = null;
        });
      }
      return pending;
    },
  };
}
