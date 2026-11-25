import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectionUrl, validateGeneratedTest } from '../inspection.mjs';
import { normalizeSteps } from '../model.mjs';

const project = { globalVariables: {}, environments: [], objects: [] };
const inspection = {
  title: 'Sign in',
  elements: [
    { tag: 'input', type: 'email', label: 'Email', locatorType: 'label', target: 'Email', matched: true, matchCount: 1 },
    { tag: 'button', text: 'Sign in', locatorType: 'text', target: 'Sign in', matched: true, matchCount: 1, disabled: true },
  ],
};

test('validation lists every step problem in plain language, keeping the first error for correction', () => {
  const steps = normalizeSteps([
    { action: 'navigate', value: 'https://example.com' },
    { action: 'fill', locatorType: 'label', target: 'Username', value: 'Alex' },
    { action: 'click', locatorType: 'text', target: 'Sign in' },
    { action: 'fill', locatorType: 'label', target: 'Email', value: 'NAME', valueMode: 'global' },
  ]);
  let thrown;
  try {
    validateGeneratedTest(project, { steps }, inspection);
  } catch (caught) {
    thrown = caught;
  }
  assert.match(thrown.message, /^Step 2: .*not observed/);
  assert.equal(thrown.code, 'GENERATED_LOCATOR_NOT_OBSERVED');
  assert.deepEqual(
    thrown.issues.map((issue) => issue.step),
    [2, 3, 4],
  );
  const [missing, disabled, variable] = thrown.issues;
  assert.match(missing.expected, /the label “Username” on “Sign in”/);
  assert.match(missing.found, /Nothing on the page matches the label “Username”.*Controls Studio did find: email field “Email”/);
  assert.match(disabled.found, /button “Sign in” is on the page but is disabled/);
  assert.match(variable.problem, /NAME, but it has no value/);
  assert.match(variable.found, /NAME does not exist in global variables/);
  for (const issue of thrown.issues) assert.ok(issue.problem && issue.expected && issue.found && issue.fix);
});

test('URL problems say what was expected and never echo variable values', () => {
  const secret = { ...project, globalVariables: { START: 'not-a-url-secret' } };
  const steps = normalizeSteps([{ action: 'navigate', value: 'START', valueMode: 'global' }]);
  let thrown;
  try {
    validateGeneratedTest(secret, { steps }, null);
  } catch (caught) {
    thrown = caught;
  }
  assert.equal(thrown.code, 'GENERATED_URL_INVALID');
  assert.match(thrown.issues[0].expected, /starts with http:\/\/ or https:\/\//);
  assert.doesNotMatch(JSON.stringify(thrown.issues), /not-a-url-secret/);

  assert.throws(
    () => inspectionUrl(project),
    (error) => /no URL and BASE_URL is not set/.test(error.issues[0].found),
  );
  assert.throws(
    () => inspectionUrl(project, 'https://user:pass@example.com'),
    (error) => /sign-in details/.test(error.issues[0].found) && !/user:pass/.test(JSON.stringify(error.issues)),
  );
});
