import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = path.dirname(fileURLToPath(import.meta.url));

async function sourceFilesIn(directory, folder) {
  const entries = await readdir(path.join(directory, folder), { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /\.(?:m?js|html|css)$/.test(entry.name))
    .map((entry) => path.posix.join(folder, entry.name));
}

// Capture the installed application files once at startup. Data and credentials
// are deliberately excluded; changing a project must not require a restart.
export async function sourceVersion(directory = appRoot) {
  const groups = await Promise.all(['', 'public'].map((folder) => sourceFilesIn(directory, folder)));
  const names = groups.flat().sort();
  const contents = await Promise.all(names.map((name) => readFile(path.join(directory, name))));
  const hash = createHash('sha256');
  names.forEach((name, index) => {
    hash.update(name).update('\0').update(contents[index]).update('\0');
  });
  return hash.digest('hex');
}
