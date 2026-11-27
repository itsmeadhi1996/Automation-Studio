// Verifies backups are readable and structurally restorable without touching live data.
// Usage: node scripts/restore-drill.mjs [dataDir]
import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(process.argv[2] || path.join(process.env.STUDIO_STORAGE_DIR || path.join(scriptDir, '..'), 'data'));
const requiredFiles = ['credentials.key', 'users.json', 'studio.json'];

const exists = (file) => access(path.join(dataDir, file)).then(() => true, () => false);

const backups = (await readdir(dataDir)).filter((name) => /^backup-[\w-]+\.json$/.test(name)).sort();
let badBackups = 0;
for (const name of backups) {
  try {
    const backup = JSON.parse(await readFile(path.join(dataDir, name), 'utf8'));
    if (!Array.isArray(backup.projects)) throw new Error('missing projects array');
  } catch (error) {
    badBackups += 1;
    console.error(`FAIL ${name}: ${error.message}`);
  }
}

let missingFiles = 0;
for (const file of requiredFiles) {
  const present = await exists(file);
  if (!present) missingFiles += 1;
  console.log(`${present ? 'OK  ' : 'MISSING'} ${file}`);
}

console.log(`${backups.length - badBackups}/${backups.length} backups parse and contain a projects array.`);
console.log(
  'Note: a full recovery also needs users.json, credentials.key (same Windows account), the project-documents and local-test-files folders, and the artifacts folder. See docs/RECOVERY.md.',
);
process.exit(badBackups || missingFiles ? 1 : 0);
