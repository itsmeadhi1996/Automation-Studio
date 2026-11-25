import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { launchBrowser } from '../browsers.mjs';
import { normalizeProject, prepareRun } from '../model.mjs';
import { startRecording } from '../recorder.mjs';
import { createStudio } from './support.mjs';

const baseProject = { name: 'Processes', tests: [], environments: [], globalVariables: {} };
const step = { name: 'Open', action: 'navigate', value: 'https://example.com' };

test('processes keep a run count, survive saves without them and expand into one run entry per repetition', () => {
  const store = { nextTestNumber: 1 };
  const project = normalizeProject({ ...baseProject, processes: [{ id: 'invoice', name: 'Invoice entry', steps: [step], runCount: 3 }] }, null, store);
  assert.equal(project.processes[0].runCount, 3);

  // A save that does not know about processes, such as one from QA Studio, keeps them.
  const resaved = normalizeProject({ ...baseProject }, project, store);
  assert.deepEqual(resaved.processes, project.processes);

  const run = prepareRun(project, { processId: 'invoice', runCount: 2 });
  assert.deepEqual(
    run.tests.map((item) => [item.name, item.sourceTestId, item.iteration]),
    [
      ['Invoice entry [run 1 of 2]', 'invoice', 1],
      ['Invoice entry [run 2 of 2]', 'invoice', 2],
    ],
  );
  assert.equal(prepareRun(project, { processId: 'invoice' }).tests.length, 3);

  for (const runCount of [0, 1001, 2.5, '3']) {
    assert.throws(
      () => normalizeProject({ ...baseProject, processes: [{ name: 'Bad', steps: [], runCount }] }, null, store),
      /Run count must be a whole number from 1 to 1000/,
    );
  }
  assert.throws(() => prepareRun(project, { processId: 'missing' }), /Process not found/);
});

test('only steps marked Repeat run repeatedly, between steps that run once', () => {
  const store = { nextTestNumber: 1 };
  const steps = ['Open', 'Sign in', 'Add row', 'Save row', 'Sign out'].map((name, index) => ({
    name,
    action: index ? 'click' : 'navigate',
    locatorType: 'text',
    target: index ? name : '',
    value: index ? '' : 'https://example.com',
    repeat: index === 2 || index === 3,
  }));
  const project = normalizeProject({ ...baseProject, processes: [{ id: 'rows', name: 'Rows', steps, runCount: 2 }] }, null, store);
  assert.deepEqual(project.processes[0].steps.map((item) => Boolean(item.repeat)), [false, false, true, true, false]);

  const run = prepareRun(project, { processId: 'rows' });
  assert.equal(run.tests.length, 1);
  assert.equal(run.tests[0].name, 'Rows [steps 3–4 × 2]');
  assert.deepEqual(run.tests[0].steps.map((item) => item.name), [
    'Open',
    'Sign in',
    '[run 1 of 2] Add row',
    '[run 1 of 2] Save row',
    '[run 2 of 2] Add row',
    '[run 2 of 2] Save row',
    'Sign out',
  ]);

  // A split selection still saves, so work in progress is never lost, but cannot run.
  const split = normalizeProject(
    { ...baseProject, processes: [{ id: 'rows', name: 'Rows', steps: steps.map((item, index) => ({ ...item, repeat: index !== 3 && index > 1 })) }] },
    null,
    store,
  );
  assert.throws(() => prepareRun(split, { processId: 'rows' }), /Steps 3–5 include unmarked steps/);
  const big = normalizeProject(
    { ...baseProject, processes: [{ id: 'big', name: 'Big', steps: Array.from({ length: 20 }, () => ({ ...steps[2] })) }] },
    null,
    store,
  );
  assert.throws(() => prepareRun(big, { processId: 'big', runCount: 1000 }), /more than 10000 steps/);
});

test('Process automation records a flow and runs it the chosen number of times', { timeout: 90000 }, async (t) => {
  let session;
  const port = 3822;
  const base = `http://127.0.0.1:${port}`;
  const studio = await createStudio({
    port,
    storage: path.resolve('.test-output', `process-automation-${Date.now()}`),
    recordingLauncher: async (...args) => {
      session = await startRecording(args[0], args[1], args[2], { ...args[3], headless: true });
      return session;
    },
  });
  await studio.listen();
  const browser = await launchBrowser('chrome');
  t.after(async () => {
    await browser.close();
    await studio.close();
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${base}/automation`);

  await page.getByRole('button', { name: /^Process automation/ }).click();
  await page.getByText('Automate a repetitive process').waitFor();
  await page.getByRole('button', { name: 'New process' }).click();
  await page.locator('#dialog [name="name"]').fill('Welcome form entry');
  await page.locator('#dialog-submit').click();
  await page.getByRole('heading', { name: 'Process details' }).waitFor();

  await page.getByRole('button', { name: 'Record Web', exact: true }).click();
  await page.getByRole('button', { name: 'Start recording', exact: true }).click();
  await page.getByRole('button', { name: 'Stop and review' }).waitFor();
  assert.match(await page.locator('.recorder-map-hint').textContent(), /step of this process/);
  await session.page.getByLabel('Your name').fill('Process');
  await session.page.getByRole('button', { name: 'Get started' }).click();
  await session.page.evaluate(() => window.__studioRecord({ action: 'barrier' }));
  await page.getByRole('button', { name: 'Stop and review' }).click();
  await page.getByRole('button', { name: 'Replace process steps' }).click();
  await page.getByRole('heading', { name: 'Process details' }).waitFor();

  await page.getByLabel('Number of times to run Welcome form entry').fill('3');
  await page.getByLabel('Number of times to run Welcome form entry').press('Tab');
  await page.getByRole('button', { name: 'Run 3 times' }).click();
  await page.waitForURL('**/automation?view=history*');

  let state = (await (await fetch(`${base}/api/state`)).json());
  const saved = state.projects[0].processes[0];
  assert.equal(saved.runCount, 3);
  assert.ok(saved.steps.some((item) => item.action === 'fill' && item.value === 'Process'));
  assert.equal(state.projects[0].tests.some((item) => item.name === 'Welcome form entry'), false);

  let run;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const status = await (await fetch(`${base}/api/status`)).json();
    run = status.runs.find((item) => item.mode === 'process');
    if (run && run.status !== 'running' && !status.activeRun) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.equal(run.name, 'Welcome form entry × 3');
  assert.equal(run.status, 'passed', JSON.stringify(run.tests.map((item) => item.error)));
  assert.deepEqual(
    run.tests.map((item) => item.name),
    ['Welcome form entry [run 1 of 3]', 'Welcome form entry [run 2 of 3]', 'Welcome form entry [run 3 of 3]'],
  );

  const outOfRange = await fetch(`${base}/api/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: state.projects[0].id, processId: saved.id, runCount: 0 }),
  });
  assert.equal(outOfRange.status, 400);
  state = await (await fetch(`${base}/api/state`)).json();
  assert.equal(state.projects[0].processes.length, 1);

  // Only the step marked Repeat runs three times; the others run once, in one session.
  const fillIndex = saved.steps.findIndex((item) => item.action === 'fill');
  await page.locator('#explorer [data-view="processes"]').click();
  await page.getByRole('button', { name: 'Edit steps →' }).click();
  await page.getByLabel(`Repeat step ${fillIndex + 1}`).check();
  const summary = await page.locator('.process-hint').textContent();
  assert.match(summary, new RegExp(`step ${fillIndex + 1} repeats 3 times`, "i"));
  await page.getByRole('button', { name: `Run, repeating step ${fillIndex + 1} × 3` }).click();
  await page.waitForURL('**/automation?view=history*');
  let repeatedRun;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const status = await (await fetch(`${base}/api/status`)).json();
    repeatedRun = status.runs.find((item) => item.mode === 'process' && item.id !== run.id);
    if (repeatedRun && repeatedRun.status !== 'running' && !status.activeRun) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.equal(repeatedRun.status, 'passed', JSON.stringify(repeatedRun.tests.map((item) => item.error)));
  assert.equal(repeatedRun.tests.length, 1);
  const actions = repeatedRun.tests[0].steps.map((item) => item.action);
  assert.equal(actions.filter((action) => action === 'fill').length, 3);
  assert.equal(actions.length, saved.steps.length + 2);
  assert.match(repeatedRun.tests[0].steps[fillIndex + 2].name, /^\[run 3 of 3\]/);

  // A split selection cannot run.
  const split = structuredClone((await (await fetch(`${base}/api/state`)).json()).projects[0]);
  split.processes[0].steps = split.processes[0].steps.map((item, index, all) => ({
    ...item,
    repeat: index === 0 || index === all.length - 1,
  }));
  const savedSplit = await fetch(`${base}/api/projects/${split.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...split, workspace: 'automation' }),
  });
  assert.equal(savedSplit.status, 200);
  const blocked = await fetch(`${base}/api/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: split.id, processId: saved.id }),
  });
  assert.equal(blocked.status, 400);
  assert.match((await blocked.json()).error, /must be next to each other/);
  assert.deepEqual(errors, []);
});
