// Runs the test files, or named tests, that a phase gate in the build plan requires.
// Usage: node test/phase-gates.mjs <phase>
import { spawnSync } from 'node:child_process';

const gates = {
  1: [['test/ops.test.mjs'], ['test/auth.test.mjs', '--test-name-pattern=login throttles repeated failed attempts']],
};

const phase = process.argv[2];
if (!gates[phase]) {
  console.error(`Unknown phase: ${phase}`);
  process.exit(2);
}

let failed = 0;
for (const [file, ...flags] of gates[phase]) {
  const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...flags, file], {
    encoding: 'utf8',
    env: { ...process.env, QA_TEST_PORTABLE_VAULT: '1' },
  });
  const summary = result.stdout.split('\n').filter((line) => /^(# |ℹ )(tests|pass|fail|cancelled|skipped)\b/.test(line));
  console.log(`--- ${file} ${flags.join(' ')}\n${summary.join('\n')}`);
  if (result.status !== 0) {
    failed += 1;
    console.log(result.stdout.slice(-3000));
    console.log(result.stderr.slice(-1500));
  }
}
process.exit(failed ? 1 : 0);
