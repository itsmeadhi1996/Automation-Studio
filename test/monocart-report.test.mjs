import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { hostname } from 'node:os';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { createStudio } from './support.mjs';
import { monocartReportHtml } from '../monocart-report.mjs';
import { playwrightJsonReport } from '../playwright-json.mjs';

const { inflateSync } = createRequire(import.meta.url)('lz-utils');
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==', 'base64');
const SECRET = 'stored-secret-value';
const ROW_SECRET = 'dataset-secret-value';
const FAILURE = 'Expected the dashboard heading';

const sampleRun = (extra = {}) => ({
  id: 'run-current',
  projectId: 'project',
  projectName: 'Payroll',
  name: 'Nightly',
  status: 'failed',
  mode: 'automation',
  browser: 'chrome',
  environmentName: 'Staging',
  startedAt: '2026-11-05T09:30:00.000Z',
  duration: 5000,
  context: { globals: { TOKEN: SECRET }, profile: { password: SECRET } },
  tests: [
    {
      id: 'pass',
      name: 'Sign in',
      tcNumber: 7,
      qa: { priority: 'high' },
      status: 'passed',
      duration: 1000,
      steps: [{ name: 'Check the title', action: 'text', status: 'passed', duration: 40, value: SECRET, expectedResult: 'The title is shown', actualResult: 'It was shown' }],
    },
    {
      id: 'fail',
      name: 'Reach the dashboard',
      tcNumber: 8,
      status: 'failed',
      duration: 4000,
      error: FAILURE,
      dataRow: { password: ROW_SECRET },
      dataRows: [{ password: ROW_SECRET }],
      steps: [{ name: 'Check the heading', action: 'text', status: 'failed', duration: 30, error: FAILURE, screenshot: 'evidence.png', targetScreenshots: ['missing.png'] }],
    },
    { id: 'skip', name: 'Lock the account', tcNumber: 9, status: 'skipped', duration: 0, steps: [] },
    { id: 'hold', name: 'Export payslips', tcNumber: 10, status: 'blocked', duration: 0, steps: [] },
  ],
  ...extra,
});

function reportData(html) {
  return JSON.parse(inflateSync(html.match(/window\.reportData = '([^']+)'/)[1]));
}

function cases(data) {
  const found = [];
  const walk = (rows) => {
    for (const row of rows) {
      if (row.type === 'case') found.push(row);
      else if (row.subs) walk(row.subs);
    }
  };
  walk(data.rows);
  return found;
}

test('Playwright JSON follows the reporter format and never includes stored or dataset values', () => {
  const report = playwrightJsonReport(sampleRun());
  assert.deepEqual(report.stats, { startTime: '2026-11-05T09:30:00.000Z', duration: 5000, expected: 1, unexpected: 1, flaky: 0, skipped: 2 });
  assert.equal(report.config.projects[0].name, 'Google Chrome');
  const [pass, fail, skip, hold] = report.suites[0].specs;
  assert.equal(pass.ok, true);
  assert.deepEqual(pass.tags, ['high']);
  assert.equal(pass.tests[0].status, 'expected');
  assert.equal(fail.ok, false);
  assert.equal(fail.tests[0].results[0].status, 'failed');
  assert.equal(fail.tests[0].results[0].error.message, FAILURE);
  assert.equal(fail.tests[0].results[0].steps[0].error.message, FAILURE);
  assert.equal(fail.tests[0].results[0].attachments[0].path, '/artifacts/evidence.png');
  assert.equal(fail.tests[0].results[0].startTime, '2026-11-05T09:30:01.000Z');
  assert.equal(skip.tests[0].results[0].status, 'skipped');
  assert.equal(hold.ok, true);
  assert.equal(hold.tests[0].status, 'skipped');
  assert.equal(hold.tests[0].results[0].status, 'interrupted');
  assert.ok(hold.tests[0].annotations.some((item) => item.type === 'qa-status' && item.description === 'blocked'));
  const text = JSON.stringify(report);
  assert.ok(!text.includes(SECRET) && !text.includes(ROW_SECRET));
});

test('the interactive report embeds evidence, adds history and leaves out secrets and server details', async (t) => {
  const artifacts = path.resolve('.test-output', `monocart-${Date.now()}`);
  await mkdir(artifacts, { recursive: true });
  await writeFile(path.join(artifacts, 'evidence.png'), PIXEL);
  const before = (await readdir(tmpdir())).filter((name) => name.startsWith('qa-studio-report-')).length;
  const history = [
    { startedAt: '2026-11-03T09:30:00.000Z', duration: 3000, tests: [{ id: 'pass', status: 'failed' }, { id: 'fail', status: 'passed' }] },
    { startedAt: '2026-11-04T09:30:00.000Z', duration: 4000, tests: [{ id: 'pass', status: 'passed' }, { id: 'fail', status: 'passed' }] },
  ];
  const logged = [];
  const log = t.mock.method(console, 'log', (...args) => logged.push(args));
  const html = await monocartReportHtml(sampleRun(), artifacts, { history });
  log.mock.restore();
  assert.deepEqual(logged, [], 'report generation stays out of the server log');
  assert.equal((await readdir(tmpdir())).filter((name) => name.startsWith('qa-studio-report-')).length, before);

  const data = reportData(html);
  const [pass, fail, skip, hold] = cases(data);
  assert.equal(data.summary.tests.value, 4);
  assert.equal(data.summary.failed.value, 1);
  assert.equal(data.summary.errors.value, 1, 'a failure on both the case and its step is one error');
  assert.equal(pass.tc, 'TC-0007');
  assert.deepEqual(pass.tags, ['@high']);
  assert.equal(pass.recent, '2/3 ×✓✓');
  assert.equal(pass.subs[0].expected, 'The title is shown');
  assert.equal(pass.subs[0].actual, 'It was shown');
  assert.equal(fail.recent, '2/3 ✓✓×');
  assert.equal(fail.errorNum, 1);
  assert.equal(fail.errorId, fail.subs[0].id);
  assert.deepEqual(fail.errors, [FAILURE]);
  assert.equal(fail.attachments.length, 1, 'a missing image is left out');
  assert.ok(fail.attachments[0].path.startsWith('data:image/png;base64,'));
  assert.equal(skip.caseType, 'skipped');
  assert.equal(hold.qaStatus, 'blocked');
  assert.deepEqual(data.trends.map((item) => [item.date, item.tests, item.failed, item.passed]), [
    [Date.parse('2026-11-03T09:30:00.000Z'), 2, 1, 1],
    [Date.parse('2026-11-04T09:30:00.000Z'), 2, 0, 2],
  ]);
  assert.equal(data.metadata.environment, 'Staging');

  const text = JSON.stringify(data);
  for (const hidden of [SECRET, ROW_SECRET, hostname(), process.cwd().replaceAll('\\', '/'), tmpdir().replaceAll('\\', '/')]) {
    assert.ok(!text.includes(hidden) && !text.includes(JSON.stringify(hidden).slice(1, -1)), `report must not include ${hidden}`);
  }
  assert.equal(data.traceViewerUrl, '');
  assert.deepEqual(data.system.map((item) => item.hostname), ['Google Chrome']);
});

test('screenshots over the size limit are dropped after failure evidence and the report says so', async () => {
  const artifacts = path.resolve('.test-output', `monocart-limit-${Date.now()}`);
  await mkdir(artifacts, { recursive: true });
  await writeFile(path.join(artifacts, 'big.png'), Buffer.alloc(15 * 1024 * 1024));
  await writeFile(path.join(artifacts, 'proof.png'), Buffer.alloc(15 * 1024 * 1024));
  const step = (name, status, screenshot, extra = {}) => ({ name, action: 'click', status, duration: 1, screenshot, ...extra });
  const run = sampleRun({
    tests: [
      { id: 'first', name: 'Passes first', status: 'passed', duration: 1, steps: [step('Passing', 'passed', 'big.png')] },
      { id: 'second', name: 'Fails later', status: 'failed', duration: 1, error: FAILURE, steps: [step('Failing', 'failed', 'proof.png', { error: FAILURE })] },
    ],
  });
  const [first, second] = cases(reportData(await monocartReportHtml(run, artifacts)));
  assert.equal(second.attachments.length, 1, 'the failed case keeps its evidence');
  assert.equal(first.attachments, undefined);
  assert.match(first.actual, /1 screenshot\(s\) were left out/);
});

test('report routes serve JSON and a sandboxed interactive report, scoped to a case', { timeout: 60000 }, async (t) => {
  const storage = path.resolve('.test-output', `monocart-route-${Date.now()}`);
  const studio = await createStudio({ port: 3921, storage });
  await studio.listen();
  const browser = await chromium.launch({ channel: 'chrome' });
  t.after(async () => {
    await browser.close();
    await studio.close();
  });
  const base = 'http://127.0.0.1:3921';
  const projectId = studio.store.projects[0].id;
  const hostile = '</script><img src=x onerror="alert(1)">';
  const current = sampleRun({ projectId, projectName: hostile });
  const earlier = { ...sampleRun({ projectId, id: 'run-earlier', startedAt: '2026-11-04T09:30:00.000Z', status: 'passed' }) };
  earlier.tests = earlier.tests.slice(0, 2).map((item) => ({ ...item, status: 'passed', error: undefined }));
  const otherProject = sampleRun({ projectId: 'someone-else', id: 'run-other', startedAt: '2026-11-03T09:30:00.000Z' });
  const later = sampleRun({ projectId, id: 'run-later', startedAt: '2026-11-06T09:30:00.000Z' });
  studio.store.runs = [later, current, earlier, otherProject];

  const json = await fetch(`${base}/api/runs/${current.id}/report.json`);
  assert.equal(json.status, 200);
  assert.match(json.headers.get('content-disposition'), /attachment; filename="run-run-current\.json"/);
  const body = await json.text();
  assert.ok(!body.includes(SECRET) && !body.includes(ROW_SECRET));
  assert.equal(JSON.parse(body).suites[0].specs.length, 4);

  const scopedJson = await (await fetch(`${base}/api/runs/${current.id}/report.json?testId=fail`)).json();
  assert.deepEqual(scopedJson.suites[0].specs.map((spec) => spec.title), ['Reach the dashboard']);
  assert.equal((await fetch(`${base}/api/runs/${current.id}/report.json?testId=unknown`)).status, 404);
  assert.equal((await fetch(`${base}/api/runs/${current.id}/report/interactive?testId=unknown`)).status, 404);

  const response = await fetch(`${base}/api/runs/${current.id}/report/interactive`);
  assert.equal(response.status, 200);
  const policy = response.headers.get('content-security-policy');
  assert.match(policy, /^sandbox allow-scripts allow-downloads;/);
  assert.doesNotMatch(policy, /allow-same-origin/);
  const data = reportData(await response.text());
  assert.deepEqual(data.trends.map((item) => item.date), [Date.parse(earlier.startedAt)], 'only earlier runs of this project');

  const scoped = reportData(await (await fetch(`${base}/api/runs/${current.id}/report/interactive?testId=fail`)).text());
  assert.deepEqual(cases(scoped).map((item) => item.title), ['Reach the dashboard']);
  assert.deepEqual(scoped.trends.map((item) => [item.tests, item.passed]), [[1, 1]], 'a case report trends only that case');

  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  const external = [];
  let dialogs = 0;
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('dialog', (dialog) => {
    dialogs += 1;
    dialog.dismiss();
  });
  page.on('request', (request) => {
    if (!/^(data|blob):/.test(request.url()) && request.url() !== response.url) external.push(request.url());
  });
  await page.goto(`${base}/api/runs/${current.id}/report/interactive`);
  await page.getByText('TC-0008').waitFor();
  await page.getByText('Reach the dashboard').first().click();
  await page.getByText(FAILURE).first().waitFor();
  assert.equal(await page.getByText(hostile).count() > 0, true, 'a hostile project name stays plain text');
  await page.locator('.vui-flyover-show [name="close"]').click();
  await page.locator('.vui-flyover-show').waitFor({ state: 'hidden' });
  await page.locator('.vui-icon-label-button').nth(1).click();
  await page.getByText('Trends').first().waitFor();
  assert.equal(await page.locator('.mcr-usage-list').first().isVisible().catch(() => false), false, 'server details stay hidden');
  assert.deepEqual(errors, []);
  assert.equal(dialogs, 0);
  assert.deepEqual(external, []);
  const access = await page.evaluate(async () => {
    const attempt = async (action) => {
      try {
        await action();
        return 'allowed';
      } catch {
        return 'blocked';
      }
    };
    return {
      cookie: await attempt(() => document.cookie),
      api: await attempt(() => fetch('/api/state')),
    };
  });
  assert.deepEqual(access, { cookie: 'blocked', api: 'blocked' }, 'report scripts have no session or API access');
});
