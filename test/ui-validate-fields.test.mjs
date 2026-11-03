import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { executeStep, parseFieldChecks } from '../runner.mjs';

test('parseFieldChecks splits on semicolons and newlines, honours escapes and states', () => {
  assert.deepEqual(parseFieldChecks('A = 1; B ~ x\\;y\nTerms : Checked').map(({ key, op, expected }) => [key, op, expected]),
    [['A', '=', '1'], ['B', '~', 'x;y'], ['Terms', ':', 'checked']]);
  assert.throws(() => parseFieldChecks('no operator'), /Use Field/);
});

test('Validate UI checks many fields in one line and reports every failure', { timeout: 30000 }, async t => {
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent('<label>Email <input value="a@b.com"></label><input placeholder="Full name" value="Ann Lee"><input name="zip" value="12345" disabled><label><input type="checkbox" checked>Terms</label><p id="status">Active</p><input id="empty">');
  const run = value => executeStep(page, { action: 'uiValidate', value, timeoutMs: 500 }, { objects: [] });
  await run('Email = a@b.com; Full name ~ Ann; zip : disabled; Terms : checked; status = Active; missing : hidden; empty : empty');
  await assert.rejects(run('Email = wrong; Full name ~ Bob; Terms : checked'), /2 field check\(s\) failed: Email = wrong.*\| Full name ~ Bob/);
});
