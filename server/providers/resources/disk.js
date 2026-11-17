// Fork: how much each top-level entry of the server's cache folder holds on
// disk, for the RESOURCES panel. Measured in the background at most every few
// minutes (a walk of thousands of files is not free), never following links.

import fs from 'node:fs/promises';
import path from 'node:path';

async function sizeOf(target) {
  let stat;
  try {
    stat = await fs.lstat(target);
  } catch {
    return { bytes: 0, files: 0 };
  }
  if (stat.isSymbolicLink()) return { bytes: 0, files: 0 };
  if (!stat.isDirectory()) return { bytes: stat.size, files: 1 };
  let bytes = 0;
  let files = 0;
  let entries = [];
  try {
    entries = await fs.readdir(target, { withFileTypes: true });
  } catch {
    return { bytes, files };
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const inner = await sizeOf(path.join(target, entry.name));
    bytes += inner.bytes;
    files += inner.files;
  }
  return { bytes, files };
}

/**
 * @param {{dir: string, everyMs?: number, now?: () => number, top?: number}} options
 */
export function createDiskSizes({
  dir,
  everyMs = 5 * 60_000,
  now = () => Date.now(),
  top = 10,
}) {
  let result = null;
  let measuredAt = -Infinity;
  let running = null;

  async function measure() {
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return { dir: path.basename(dir), total_bytes: 0, entries: [] };
    }
    const sized = [];
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const { bytes, files } = await sizeOf(path.join(dir, entry.name));
      sized.push({ name: entry.name, bytes, files });
    }
    sized.sort((a, b) => b.bytes - a.bytes);
    return {
      dir: path.basename(dir),
      total_bytes: sized.reduce((sum, e) => sum + e.bytes, 0),
      entries: sized.slice(0, top),
    };
  }

  return {
    /** The last measurement (null before the first); starts a new one when due. */
    current() {
      if (!running && now() - measuredAt >= everyMs) {
        measuredAt = now();
        running = measure()
          .then((value) => {
            result = { ...value, measured_at: measuredAt };
          })
          .catch(() => {})
          .finally(() => {
            running = null;
          });
      }
      return result;
    },
    /** For tests: wait for a measurement in progress. */
    settled: () => running ?? Promise.resolve(),
  };
}
