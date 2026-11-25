import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import { chromium } from 'playwright';
import { startRecording } from '../recorder.mjs';
import { createStudio } from './support.mjs';

// A field and a button at fixed positions, so clicks on the streamed screen can aim at them.
const FORM = `<!doctype html><style>body{margin:0}#name{position:absolute;left:100px;top:100px;width:300px;height:40px}
#save{position:absolute;left:100px;top:200px;width:120px;height:40px}</style>
<input id="name" aria-label="Name"><button id="save" onclick="document.title='saved'">Save</button>`;

async function formServer(t) {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(FORM);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

function withoutScreen(t) {
  process.env.STUDIO_NO_SCREEN = '1';
  t.after(() => delete process.env.STUDIO_NO_SCREEN);
}

const drain = (session) => session.page.evaluate(() => window.__studioRecord({ action: 'barrier' }));

test('without a screen, recording streams the hidden browser and records input sent to it', { timeout: 60000 }, async (t) => {
  withoutScreen(t);
  const url = await formServer(t);
  const session = await startRecording({ id: 'p', browser: 'chrome', tests: [{ id: 't', name: 'Remote' }] }, 't', url);
  t.after(() => session.stop());
  assert.deepEqual(session.summary().remote, { width: 1440, height: 900 });

  const frame = await session.screen();
  assert.equal(frame.subarray(0, 2).toString('hex'), 'ffd8', 'the screen is a JPEG');

  await session.input({ type: 'click', x: 250, y: 120 });
  await session.input({ type: 'text', text: 'Alex' });
  await session.input({ type: 'key', key: 'Tab' });
  await session.input({ type: 'scroll', dx: 0, dy: 100 });
  await session.input({ type: 'click', x: 160, y: 220 });
  await drain(session);
  assert.ok(session.steps.some((step) => step.action === 'fill' && step.value === 'Alex'), 'typing became a fill step');
  assert.ok(session.steps.some((step) => step.action === 'click' && /save/i.test(step.name)), 'the click became a step');

  for (const bad of [{ type: 'click', x: 5000, y: 10 }, { type: 'key', key: 'F12' }, { type: 'run', code: 'x' }, null]) {
    await assert.rejects(session.input(bad));
  }
  await session.stop();
  await assert.rejects(session.input({ type: 'text', text: 'late' }), /already stopped/);
});

test('Record Web shows the remote browser and turns clicks and typing on it into steps', { timeout: 90000 }, async (t) => {
  withoutScreen(t);
  const url = await formServer(t);
  const port = 3541;
  const base = `http://127.0.0.1:${port}`;
  const storage = path.resolve('.test-output', `remote-recording-${Date.now()}`);
  const studio = await createStudio({ port, storage });
  await studio.listen();
  const browser = await chromium.launch();
  t.after(async () => {
    await browser.close();
    await studio.close();
    await rm(storage, { recursive: true, force: true }).catch(() => {});
  });
  const api = async (route, method = 'GET', body) => {
    const response = await fetch(base + route, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.ok(response.ok, await response.clone().text());
    return response.json();
  };
  const project = (await api('/api/state?workspace=automation')).projects[0];
  const recording = await api('/api/recordings', 'POST', { projectId: project.id, testId: 'welcome', url });
  assert.ok(recording.remote);
  // Each click or key is not a separate work log entry.
  await api(`/api/recordings/${recording.id}/input`, 'POST', { type: 'move', x: 10, y: 10 });

  const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${base}/automation?projectId=${project.id}&view=recording`);
  const viewer = page.locator('#remote-screen');
  await viewer.waitFor();
  await page.waitForFunction(() => document.querySelector('#remote-screen')?.naturalWidth > 0);

  // Aim at the field and button through the scaled image, as a user would.
  const box = await viewer.boundingBox();
  const scale = box.width / 1440;
  await page.mouse.click(box.x + 250 * scale, box.y + 120 * scale);
  await page.keyboard.type('Remote user');
  await page.mouse.click(box.x + 160 * scale, box.y + 220 * scale);

  // Keys travel one at a time, so wait for the whole value and the Save click.
  const steps = async () => (await api('/api/status')).activeRecording?.steps || [];
  const typed = (list) => list.some((step) => step.action === 'fill' && step.value === 'Remote user');
  const saved = (list) => list.some((step) => step.action === 'click' && step.target.includes('save'));
  for (let i = 0; i < 60 && !(typed(await steps()) && saved(await steps())); i++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const recorded = await steps();
  assert.ok(typed(recorded), JSON.stringify(recorded));
  assert.ok(saved(recorded), JSON.stringify(recorded));
  assert.deepEqual(errors, []);

  const stopped = await api(`/api/recordings/${recording.id}/stop`, 'POST', {});
  assert.equal(stopped.status, 'stopped');
  assert.equal((await fetch(`${base}/api/recordings/${recording.id}/screen`)).status, 400);
  await page.waitForFunction(() => !document.querySelector('#remote-screen'));
});
