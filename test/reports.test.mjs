import test from 'node:test';
import assert from 'node:assert/strict';
import { reportHtml } from '../reports.mjs';

const render = (tests, extra = {}) =>
  reportHtml({ id: 'run-1', projectName: 'Sample', status: 'failed', duration: 1000, tests, ...extra }, '.test-output');
const cases = (status, count) => Array.from({ length: count }, (_, index) => ({ name: `${status} ${index}`, status, steps: [] }));

test('the pass rate never rounds a run with a failure up to 100%', async () => {
  const html = await render([...cases('passed', 999), ...cases('failed', 1)]);
  assert.match(html, /<strong>99<small>%<\/small><\/strong>/);
  assert.match(html, /999 of 1000 test cases passed\./);
  assert.match(await render(cases('passed', 1), { status: 'passed' }), /<strong>100<small>%<\/small><\/strong>/);
});

test('needs attention links only failed cases to their details, with escaped text', async () => {
  const html = await render([
    { name: 'Fine', status: 'passed', steps: [] },
    { name: '<img src=x>', status: 'failed', error: 'First <line>\nSecond line', steps: [] },
  ]);
  const attention = html.match(/<section class="attention">.*?<\/section>/)[0];
  assert.match(attention, /href="#case-2">&lt;img src=x&gt;<\/a>/);
  assert.match(attention, /First &lt;line&gt;/);
  assert.doesNotMatch(attention, /Fine|Second line/);
  assert.match(html, /<details class="case failed" id="case-2" open>/);
  assert.doesNotMatch(await render(cases('passed', 2), { status: 'passed' }), /Needs attention/);
});

test('every test is counted, and an empty run has no pass rate', async () => {
  const html = await render([...cases('passed', 1), ...cases('blocked', 1), ...cases('interrupted', 1)]);
  assert.match(html, /<dt>Not completed<\/dt><dd>2<\/dd>/);
  assert.doesNotMatch(await render(cases('passed', 1), { status: 'passed' }), /Not completed/);
  const empty = await render([]);
  assert.match(empty, /<strong>—<\/strong>/);
  assert.doesNotMatch(empty, /NaN|Infinity/);
});

test('reports are self-contained and print with the full layout', async () => {
  const html = await render(cases('failed', 1));
  assert.doesNotMatch(html, /<script|<link|@import|https?:\/\//);
  assert.match(html, /@media screen and \(max-width:760px\)/);
});
