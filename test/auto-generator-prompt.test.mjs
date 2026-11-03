import test from 'node:test';
import assert from 'node:assert/strict';
import '../public/auto-generator-prompt.js';

const {build, precondition, verification} = globalThis.StudioAutoPrompt;
const qa = {
  description: 'Verify error message when performance_glitch_user attempts login.',
  preconditions: 'User is on Saucedemo login page.',
  expectedResult: "Error message: 'Epic sadface: Sorry, this user has been locked out.'",
  manualSteps: [
    {id: 'r1', instruction: "Enter username 'performance_glitch_user'", expectedResult: 'Username field populated'},
    {id: 'r2', instruction: "Enter password 'secret_sauce'", expectedResult: 'Password field populated'},
    {id: 'r3', instruction: 'Click Login button', expectedResult: 'Error message displayed'}
  ]
};
const project = {requirements: [{id: 'req', url: 'https://www.saucedemo.com/', testIds: ['qa-case']}]};

test('auto generator prompt uses the requirement URL and ends with the overall verification', () => {
  const prompt = build(project, {id: 'auto-id', qaCaseId: 'qa-case', name: 'Performance Glitch User Login Validation', qa});
  assert.equal(prompt, [
    'User is on https://www.saucedemo.com/ login page.',
    "1. Enter username 'performance_glitch_user' Expected: Username field populated",
    "2. Enter password 'secret_sauce' Expected: Password field populated",
    '3. Click Login button Expected: Error message displayed',
    "4. Verify the error message: 'Epic sadface: Sorry, this user has been locked out.'"
  ].join('\n'));
});

test('auto generator prompt keeps existing URLs and avoids duplicate checks', () => {
  assert.equal(precondition('Open https://example.test/login', 'https://www.saucedemo.com/'), 'Open https://example.test/login');
  assert.equal(precondition('User is signed out.', 'https://example.test/'), 'User is signed out (https://example.test/).');
  assert.equal(precondition('', 'https://example.test/'), 'User is on https://example.test/.');
  assert.equal(precondition('User is on Saucedemo login page.', ''), 'User is on Saucedemo login page.');
  assert.equal(verification('Verify the Dashboard heading'), 'Verify the Dashboard heading');
  assert.equal(verification('The cart shows 1 item'), 'Verify the cart shows 1 item');
  const repeated = build({}, {id: 'x', qa: {...qa, preconditions: '', expectedResult: 'Error message displayed'}});
  assert.equal(repeated.split('\n').length, 3);
});
