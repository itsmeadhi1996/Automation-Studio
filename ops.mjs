import { access, constants, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

// Rolling request metrics kept in memory: counts by status class and recent latencies.
export function createMetrics(limit = 500) {
  const startedAt = Date.now();
  const latencies = [];
  const statuses = {};
  let total = 0;

  return {
    record(method, status, milliseconds) {
      total += 1;
      const statusClass = `${Math.floor(status / 100)}xx`;
      statuses[statusClass] = (statuses[statusClass] || 0) + 1;
      latencies.push(milliseconds);
      if (latencies.length > limit) latencies.shift();
    },
    snapshot() {
      const sorted = [...latencies].sort((a, b) => a - b);
      const percentile = (fraction) => {
        if (!sorted.length) return 0;
        const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));
        return Number(sorted[index].toFixed(2));
      };
      return {
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        requests: total,
        statuses: { ...statuses },
        latencyMs: {
          samples: sorted.length,
          p50: percentile(0.5),
          p95: percentile(0.95),
          max: percentile(1),
        },
      };
    },
  };
}

// Reports storage health without exposing data: writable directories and backup count.
export async function storageHealth(dataDir, artifactsDir) {
  const isWritable = (directory) => access(directory, constants.W_OK).then(() => true, () => false);
  let backups = 0;
  let newestBackup = null;
  try {
    const names = (await readdir(dataDir)).filter((name) => /^backup-[\w-]+\.json$/.test(name)).sort();
    backups = names.length;
    if (names.length) newestBackup = (await stat(path.join(dataDir, names.at(-1)))).mtime.toISOString();
  } catch {
    // A missing data directory is reported through dataWritable below.
  }
  return {
    dataWritable: await isWritable(dataDir),
    artifactsWritable: await isWritable(artifactsDir),
    backups,
    newestBackup,
  };
}

export function eventLoopDelay() {
  return new Promise((resolve) => {
    const startedAt = process.hrtime.bigint();
    setImmediate(() => resolve(Number(process.hrtime.bigint() - startedAt) / 1e6));
  });
}
