function check(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

// Narrows a selection to one saved plan, returning the IDs the plan allows.
function planTestIds(project, planId, testId, testIds) {
  const plan = project.testPlans?.find((item) => item.id === planId);
  check(plan, 'Unknown test plan');
  check(plan.status === 'open', 'Reopen this test plan before execution');

  const available = project.tests.filter((test) => plan.testIds.includes(test.qaCaseId || test.id));
  check(available.length === plan.testIds.length, 'Configure automation for every case in this test plan first');

  const allowed = new Set(available.map((test) => test.id));
  check(!testId || allowed.has(testId), 'Test case is outside this test plan');
  check(
    !testIds || (Array.isArray(testIds) && testIds.every((id) => allowed.has(id))),
    'Test cases are outside this test plan',
  );
  return testIds || [...allowed];
}

// Manual runs require plan membership; automation can execute cases directly.
export function selectPlannedTests(project, { testId, testIds, suiteId, planId } = {}, { requirePlan = true } = {}) {
  const chosenIds = planId ? planTestIds(project, planId, testId, testIds) : testIds;
  const testExists = (id) => project.tests.some((test) => test.id === id);

  if (testId) {
    check(testExists(testId), 'Choose existing test cases');
  }
  if (chosenIds !== undefined) {
    check(
      Array.isArray(chosenIds) && chosenIds.length > 0 && chosenIds.every(testExists),
      'Choose existing test cases',
    );
  }
  if (suiteId) {
    check(
      project.suites.some((suite) => suite.id === suiteId),
      'Unknown suite',
    );
  }

  const selected = project.tests.filter((test) => {
    const matchesTest = !testId || test.id === testId;
    const matchesList = !chosenIds || chosenIds.includes(test.id);
    const matchesSuite = !suiteId || test.suiteId === suiteId || test.additionalSuiteIds?.includes(suiteId);
    return matchesTest && matchesList && matchesSuite;
  });
  check(selected.length, 'No tests selected');

  if (!requirePlan && !planId) {
    return selected;
  }
  if (testId || chosenIds) {
    check(
      selected.every((test) => test.inTestPlan === true),
      'Transfer every selected test case to the Test plan from Test cases before execution.',
    );
  }
  const planned = selected.filter((test) => test.inTestPlan === true);
  check(
    planned.length,
    'No test cases in the Test plan for this selection. Transfer cases from Test cases before execution.',
  );
  return planned;
}
