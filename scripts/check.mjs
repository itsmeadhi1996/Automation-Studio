// Syntax-checks every source file so new modules are covered without editing package.json.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skip = new Set([
  'node_modules',
  '.test-output',
  '.playwright-mcp',
  'data',
  'artifacts',
  'fixtures',
  '.git',
]);

function collectSourceFiles(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectSourceFiles(full, files);
    else if (/\.(mjs|js)$/.test(entry.name)) files.push(full);
  }
  return files;
}

const files = collectSourceFiles(root);
let failed = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    failed += 1;
    console.error(`FAIL ${path.relative(root, file)}\n${result.stderr}`);
  }
}
console.log(`${files.length - failed}/${files.length} files passed syntax check`);
process.exit(failed ? 1 : 0);
