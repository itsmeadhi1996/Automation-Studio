import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium } from 'playwright';
import { createStudio } from './support.mjs';

const stepDefaults = { name: 'Generated action', locatorType: 'css', target: '', replacement: '', value: '', valueMode: 'static', framePath: [] };
const navigate = { action: 'navigate', value: 'BASE_URL', valueMode: 'environment' };
const fill = (value) => ({ action: 'fill', locatorType: 'id', target: 'name', value, qaRequirementId: 'requirement-name' });

test('Auto generator regenerates from a selected step and keeps the earlier steps', { timeout: 60000 }, async (t) => {
  const port = 3821;
  const base = `http://127.0.0.1:${port}`;
  let reply = [navigate, fill('Alex')];
  const bodies = [];
  const studio = await createStudio({
    port,
    storage: path.resolve('.test-output', `regenerate-from-${Date.now()}`),
    aiFetcher: async (url, options) => {
      bodies.push(options.body);
      const steps = reply.map((step) => ({ ...stepDefaults, ...step }));
      const content = JSON.stringify({ name: 'Draft', explanation: 'Inspected controls.', steps });
      return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content } }] }) };
    },
  });
  await studio.listen();
  let browser;
  t.after(async () => {
    await browser?.close();
    await studio.close();
  });
  const api = async (route, method = 'GET', body) => {
    const response = await fetch(base + route, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };

  const project = structuredClone(studio.store.projects[0]);
  const original = project.tests[0];
  original.qa.manualSteps = [{ id: 'requirement-name', instruction: 'Fill Your name with Alex', expectedResult: 'Alex is entered' }];
  original.steps = [];
  original.automation = null;
  await api(`/api/projects/${project.id}`, 'PUT', project);
  const opened = await api('/api/automation/handoff', 'POST', { projectId: project.id, testId: original.id });
  const testId = opened.data.testIds[0];
  await api('/api/settings', 'PUT', { provider: 'groq', apiKey: 'mock-key' });
  const prompt = 'Open the page and fill Your name';

  const generated = await api('/api/ai/create', 'POST', { projectId: project.id, testId, prompt });
  assert.equal(generated.status, 201);
  const before = (await api('/api/state')).data.projects[0].tests[0].steps;
  assert.equal(before.length, 2);

  // An out-of-range step is rejected before the model is called.
  const outOfRange = await api('/api/ai/create', 'POST', { projectId: project.id, testId, prompt, regenerateFrom: 2 });
  assert.equal(outOfRange.status, 400);
  assert.match(outOfRange.data.error, /Select a step of this test case to regenerate from/);
  const untargeted = await api('/api/ai/create', 'POST', { projectId: project.id, prompt, regenerateFrom: 1 });
  assert.equal(untargeted.status, 400);
  assert.equal(bodies.length, 1);

  // The model receives the kept step and returns only what follows it.
  reply = [fill('Sam')];
  const regenerated = await api('/api/ai/create', 'POST', { projectId: project.id, testId, prompt, regenerateFrom: 1 });
  assert.equal(regenerated.status, 201);
  assert.match(bodies.at(-1), /kept unchanged/);
  const after = (await api('/api/state')).data.projects[0].tests[0].steps;
  assert.equal(after.length, 2);
  assert.deepEqual(after[0], before[0]);
  assert.equal(after[1].value, 'Sam');
  assert.equal(after[1].qaRequirementId, 'requirement-name');

  // A reply with nothing after the kept steps changes nothing.
  reply = [];
  const empty = await api('/api/ai/create', 'POST', { projectId: project.id, testId, prompt, regenerateFrom: 1 });
  assert.equal(empty.status, 400);
  assert.deepEqual((await api('/api/state')).data.projects[0].tests[0].steps, after);

  // The step row action opens Auto generator with that step selected.
  browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`${base}/automation`);
  await page.getByRole('button', { name: 'Regenerate steps from step 2' }).click();
  assert.equal(await page.locator('#ai-regenerate-from').inputValue(), '1');
  await page.getByRole('button', { name: 'Regenerate from step 2' }).waitFor();

  // A failed generation opens a small alert window that explains the problem.
  await page.getByRole('button', { name: 'Regenerate from step 2' }).click();
  const dialog = page.locator('dialog.issue-dialog');
  await dialog.waitFor();
  assert.equal(await page.locator('#dialog-title').textContent(), 'Generation stopped');
  assert.match(await dialog.textContent(), /Step 2: The AI returned no new steps after step 1\..*Expected.*New steps from step 2 onward/s);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'View details' }).click();
  await dialog.waitFor();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();

  await page.locator('#ai-regenerate-from').selectOption('0');
  await page.getByRole('button', { name: 'Generate steps' }).waitFor();
});
