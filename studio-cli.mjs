import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { studioHeaders } from './auth-client.mjs';

const DEFAULT_URL = 'http://127.0.0.1:3300';
const USAGE =
  'node studio-cli.mjs --project ID [--test ID | --suite ID] [--json results.json] [--junit results.xml] ' +
  `[--every-minutes N --count N] [--url ${DEFAULT_URL}]`;

const API_TIMEOUT_MS = 30000;
const RUN_POLL_MS = 250;
const STATUS_POLL_MS = 50;
const SLEEP_SLICE_MS = 1000;

const EXIT_PASSED = 0;
const EXIT_NOT_PASSED = 1;
const EXIT_ERROR = 2;
const EXIT_CANCELLED = 130;

const VALUE_OPTIONS = ['--project', '--test', '--suite', '--url', '--json', '--junit', '--every-minutes', '--count'];
const XML_ENTITIES = { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' };

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function argumentsFor(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === '--help') {
      options.help = true;
      continue;
    }
    const value = args[index + 1];
    if (!VALUE_OPTIONS.includes(key) || !value || value.startsWith('--')) {
      throw new Error(`Invalid argument: ${key}`);
    }
    options[key.slice(2)] = value;
    index += 1;
  }
  if (!options.help && !options.project) throw new Error('--project is required');
  if (options.test && options.suite) throw new Error('Choose --test or --suite');
  for (const key of ['every-minutes', 'count']) {
    if (options[key] && (!/^\d+$/.test(options[key]) || Number(options[key]) < 1)) {
      throw new Error(`${key} must be a positive integer`);
    }
  }
  return options;
}

const xml = (value) => String(value || '').replace(/[<>&"']/g, (character) => XML_ENTITIES[character]);

function junitCase(test) {
  let body = '<skipped/>';
  if (test.status === 'passed') body = '';
  if (test.status === 'failed') body = `<failure message="${xml(test.error || 'Test failed')}"/>`;
  return `<testcase name="${xml(test.name)}" time="${(test.duration || 0) / 1000}">${body}</testcase>`;
}

export function junit(run) {
  const failures = run.tests.filter((test) => test.status === 'failed').length;
  const skipped = run.tests.filter((test) => test.status !== 'passed' && test.status !== 'failed').length;
  const attributes = `name="${xml(run.projectName)}" tests="${run.tests.length}" failures="${failures}" skipped="${skipped}"`;
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<testsuite ${attributes}>${run.tests.map(junitCase).join('')}</testsuite>`
  );
}

function studioUrl(options) {
  const base = new URL(options.url || process.env.STUDIO_URL || DEFAULT_URL);
  if (base.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(base.hostname)) {
    throw new Error('Use a local Studio URL');
  }
  return base;
}

function runReport(run) {
  return {
    id: run.id,
    projectName: run.projectName,
    status: run.status,
    duration: run.duration,
    tests: run.tests.map((test) => ({
      id: test.id,
      name: test.name,
      status: test.status,
      duration: test.duration,
      error: test.error,
    })),
  };
}

export async function main(args = process.argv.slice(2)) {
  const options = argumentsFor(args);
  if (options.help) {
    console.log(USAGE);
    return EXIT_PASSED;
  }

  const base = studioUrl(options);
  const authHeaders = await studioHeaders(base);
  const api = async (route, method = 'GET', body) => {
    const response = await fetch(new URL(route, base), {
      method,
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    return data;
  };

  let cancelled = false;
  let runId = null;
  let failed = false;
  const stop = () => {
    cancelled = true;
    if (runId) void api(`/api/runs/${runId}/cancel`, 'POST', {}).catch(() => {});
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  const selector = {
    projectId: options.project,
    ...(options.test ? { testId: options.test } : {}),
    ...(options.suite ? { suiteId: options.suite } : {}),
  };
  // --count only has meaning for repeated runs.
  const count = options['every-minutes'] ? Number(options.count || Infinity) : 1;

  try {
    for (let iteration = 0; iteration < count && !cancelled; iteration += 1) {
      const readiness = await api('/api/preflight', 'POST', selector);
      if (!readiness.ok) throw new Error(readiness.errors.join('\n'));

      let run = await api('/api/runs', 'POST', selector);
      runId = run.id;
      while (run.status === 'running') {
        await delay(RUN_POLL_MS);
        run = await api(`/api/runs/${runId}`);
      }
      while ((await api('/api/status')).activeRun === runId) await delay(STATUS_POLL_MS);
      runId = null;
      failed ||= run.status !== 'passed';

      const report = runReport(run);
      console.log(JSON.stringify(report));
      if (options.json) await writeFile(options.json, JSON.stringify(report, null, 2));
      if (options.junit) await writeFile(options.junit, junit(run));

      if (iteration + 1 < count && !cancelled) {
        const until = Date.now() + Number(options['every-minutes']) * 60000;
        while (Date.now() < until && !cancelled) {
          await delay(Math.min(SLEEP_SLICE_MS, until - Date.now()));
        }
      }
    }
    if (cancelled) return EXIT_CANCELLED;
    return failed ? EXIT_NOT_PASSED : EXIT_PASSED;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = EXIT_ERROR;
    });
}
