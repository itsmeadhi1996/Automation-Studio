// Removes disposable per-test workspaces from .test-output. Keeps benchmark baselines and logs.
// Usage: node scripts/clean-test-output.mjs [--dry-run]
import { readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const outputDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.test-output');
const dryRun = process.argv.includes('--dry-run');
const disposable = /^(admin-integrity-|workspace-|test-workspace-|tmp-)/;

let removed = 0;
try {
  for (const name of readdirSync(outputDir)) {
    const full = path.join(outputDir, name);
    if (!disposable.test(name) || !statSync(full).isDirectory()) continue;
    if (!dryRun) rmSync(full, { recursive: true, force: true });
    removed += 1;
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
console.log(`${dryRun ? 'Would remove' : 'Removed'} ${removed} disposable test workspace(s).`);
