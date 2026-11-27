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

const until = async (condition, timeout = 15000) => {
  const end = Date.now() + timeout;
  while (!(await condition()) && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 100));
  return condition();
};

// A Studio without a screen, a form site and a browser. The API helper fails on any error.
async function hostedStudio(t, port) {
  withoutScreen(t);
  const url = await formServer(t);
  const base = `http://127.0.0.1:${port}`;
  const storage = path.resolve('.test-output', `remote-recording-${port}-${Date.now()}`);
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
  const start = () => api('/api/recordings', 'POST', { projectId: project.id, testId: 'welcome', url });
  const steps = async () => (await api('/api/status')).activeRecording?.steps || [];
  return { base, url, browser, api, start, steps };
}

const shown = (page) => page.waitForFunction(() => document.querySelector('#remote-screen')?.naturalWidth > 0);

test('without a screen, recording streams the hidden browser and records input sent to it', { timeout: 60000 }, async (t) => {
  withoutScreen(t);
  const url = await formServer(t);
  const session = await startRecording({ id: 'p', browser: 'chrome', tests: [{ id: 't', name: 'Remote' }] }, 't', url);
  t.after(() => session.stop());
  assert.deepEqual(session.summary().remote, { width: 1440, height: 900, stream: true });

  assert.equal(await session.page.locator('qa-studio-recorder-toolbox').count(), 0, 'the toolbox lives in the recording window');
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

test('Record Web opens a recording window that turns clicks and typing into steps', { timeout: 90000 }, async (t) => {
  const { base, url, browser, api, steps } = await hostedStudio(t, 3541);
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${base}/automation`);
  await page.getByRole('button', { name: 'Record Web', exact: true }).click();
  await page.getByLabel('Starting URL').fill(url);
  const opened = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Start recording', exact: true }).click();
  const popup = await opened;
  popup.on('pageerror', (error) => errors.push(error.message));
  await page.getByRole('button', { name: 'Stop and review' }).waitFor();
  // The main page does not show the browser; the recording window does.
  assert.equal(await page.locator('#remote-screen').count(), 0);
  assert.equal(new URL(popup.url()).pathname, '/automation/live');
  await popup.setViewportSize({ width: 1600, height: 1200 });
  await shown(popup);
  await popup.getByText(/1 steps saved/).waitFor();

  // Aim at the field and button through the scaled image, as a user would.
  const box = await popup.locator('#remote-screen').boundingBox();
  const scale = box.width / 1440;
  await popup.mouse.click(box.x + 250 * scale, box.y + 120 * scale);
  assert.equal(await popup.locator('.click-mark').count(), 1, 'the click is marked in red at once');
  await popup.keyboard.type('Remote user');
  await popup.mouse.click(box.x + 160 * scale, box.y + 220 * scale);
  const typed = (list) => list.some((step) => step.action === 'fill' && step.value === 'Remote user');
  const saved = (list) => list.some((step) => step.action === 'click' && step.target.includes('save'));
  assert.ok(await until(async () => typed(await steps()) && saved(await steps())), JSON.stringify(await steps()));
  const count = (await steps()).length;
  await popup.getByText(`${count} steps saved`).waitFor();

  // Elements are inspected from the window's own toolbar; the streamed page carries no toolbox.
  assert.equal(await page.locator('#record-mode').count(), 0);
  const tools = popup.getByRole('navigation', { name: 'Recorder' });
  await tools.getByRole('button', { name: 'Verify visible' }).click();
  await tools.getByRole('button', { name: 'Verify visible', pressed: true }).waitFor();
  assert.equal((await api('/api/status')).activeRecording.mode, 'visible');
  await popup.mouse.click(box.x + 160 * scale, box.y + 220 * scale);
  assert.ok(await until(async () => (await steps()).at(-1).action === 'visible'), JSON.stringify((await steps()).at(-1)));
  await tools.getByRole('button', { name: 'Undo last step' }).click();
  assert.ok(await until(async () => (await steps()).length === count));
  await tools.getByRole('button', { name: 'Record actions' }).click();
  await tools.getByRole('button', { name: 'Record actions', pressed: true }).waitFor();

  // Closing the window leaves the recording running, and the button opens it again.
  await popup.close();
  const reopened = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Open recording window' }).click();
  const again = await reopened;
  await shown(again);

  // Stopping the recording closes the window.
  const closed = again.waitForEvent('close');
  await page.getByRole('button', { name: 'Stop and review' }).click();
  await closed;
  assert.equal(await page.getByRole('button', { name: 'Open recording window' }).count(), 0);
  assert.deepEqual(errors, []);
});

test('over a slow link, the recording window streams frames and pointer moves never hold back a click', { timeout: 90000 }, async (t) => {
  const { base, browser, api, start, steps } = await hostedStudio(t, 3542);
  const recording = await start();
  assert.equal(recording.remote.stream, true);

  const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
  // Each input takes 400 ms to reach the server, as from a browser far from a hosted Studio.
  let sent = 0;
  await page.route('**/input', async (route) => {
    sent += 1;
    await new Promise((resolve) => setTimeout(resolve, 400));
    await route.continue();
  });
  await page.goto(`${base}/automation/live`);
  await shown(page);

  const box = await page.locator('#remote-screen').boundingBox();
  const scale = box.width / 1440;
  for (let i = 0; i < 40; i++) {
    await page.mouse.move(box.x + (300 + i * 10) * scale, box.y + 400 * scale);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const clickedAt = Date.now();
  await page.mouse.click(box.x + 160 * scale, box.y + 220 * scale);
  const saved = (list) => list.some((step) => step.action === 'click' && step.target.includes('save'));
  await until(async () => saved(await steps()), 10000);
  assert.ok(Date.now() - clickedAt < 2000, `the click took ${Date.now() - clickedAt} ms behind queued moves`);
  assert.ok(sent < 15, `${sent} inputs were sent for 40 pointer moves and a click`);
  // The streamed view shows changes without asking for frames.
  const polled = await page.evaluate(() => performance.getEntriesByType('resource').some((entry) => entry.name.includes('/screen?')));
  assert.equal(polled, false);
  await api(`/api/recordings/${recording.id}/stop`, 'POST', {});
});

test('when the stream shows no frame, the recording window asks for frames instead', { timeout: 90000 }, async (t) => {
  const { base, browser, api, start } = await hostedStudio(t, 3543);
  const recording = await start();
  const page = await browser.newPage();
  // A proxy that never passes the stream on.
  await page.route('**/stream', () => {});
  await page.goto(`${base}/automation/live`);
  await page.waitForFunction(() => /\/screen\?/.test(document.querySelector('#remote-screen')?.src || ''), null, { timeout: 15000 });
  await shown(page);
  await api(`/api/recordings/${recording.id}/stop`, 'POST', {});
});

test('a recorded click outlines its element in red for a moment', { timeout: 60000 }, async (t) => {
  const url = await formServer(t);
  const session = await startRecording({ id: 'p', browser: 'chrome', tests: [{ id: 't', name: 'Flash' }] }, 't', url, { headless: true });
  t.after(() => session.stop());
  const outline = () =>
    session.page.evaluate(() => {
      const box = document.querySelector('qa-studio-recorder-feedback')?.shadowRoot.querySelector('[data-capture-highlight]');
      return box && !box.hidden ? { color: getComputedStyle(box).borderTopColor, width: box.style.width } : null;
    });
  await session.page.click('#save');
  assert.deepEqual(await outline(), { color: 'rgb(229, 72, 77)', width: '120px' });
  // Moving the pointer away does not clear it at once, but it clears soon after.
  await session.page.mouse.move(700, 700);
  assert.notEqual(await outline(), null);
  assert.ok(await until(async () => (await outline()) === null, 3000));
  await drain(session);
  assert.ok(session.steps.some((step) => step.action === 'click'), 'the click is still recorded');
});
