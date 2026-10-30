// Traffic history (fork feature): passages and object-minutes per H3 cell
// in 5-minute buckets (kept 3 days) and hourly totals (kept 120 days), plus
// how well each domain's feed was delivered each hour. One writer, SQLite,
// survives restarts. A corrupt file is set aside and a fresh one opened; a
// file that cannot be opened for another reason (locked by a second
// instance) is left alone and history is kept in memory for this run.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA_VERSION = 1;
const FIVE_MIN = 5 * 60_000;
const HOUR = 3600_000;
const FINE_RETAIN_MS = 3 * 24 * HOUR;
const HOURLY_RETAIN_MS = 120 * 24 * HOUR;
// Windows longer than this are summed from hourly totals.
const FINE_WINDOW_MAX_MS = 6 * HOUR;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS fine (
  domain TEXT NOT NULL, res INTEGER NOT NULL, cell TEXT NOT NULL,
  bucket INTEGER NOT NULL, passages INTEGER NOT NULL, minutes REAL NOT NULL,
  PRIMARY KEY (domain, res, cell, bucket)
);
CREATE INDEX IF NOT EXISTS fine_by_time ON fine (domain, res, bucket);
CREATE INDEX IF NOT EXISTS fine_by_bucket ON fine (bucket);
CREATE TABLE IF NOT EXISTS hourly (
  domain TEXT NOT NULL, res INTEGER NOT NULL, cell TEXT NOT NULL,
  hour INTEGER NOT NULL, passages INTEGER NOT NULL, minutes REAL NOT NULL,
  PRIMARY KEY (domain, res, cell, hour)
);
CREATE INDEX IF NOT EXISTS hourly_by_time ON hourly (domain, res, hour);
CREATE INDEX IF NOT EXISTS hourly_by_hour ON hourly (hour);
CREATE TABLE IF NOT EXISTS coverage (
  domain TEXT NOT NULL, hour INTEGER NOT NULL,
  snapshots INTEGER NOT NULL, objects INTEGER NOT NULL,
  PRIMARY KEY (domain, hour)
);
`;

// Errors that mean the file itself is damaged (or not ours to read).
const CORRUPT =
  /malformed|not a database|SQLITE_CORRUPT|SQLITE_NOTADB|unsupported traffic schema/i;
// After this many failed writes in a row, pending rows are dropped.
const MAX_FLUSH_FAILURES = 5;

function openDatabase(file, warn) {
  const open = (target = file) => {
    const db = new DatabaseSync(target);
    try {
      db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 2000;');
      db.exec(SCHEMA);
      const row = db
        .prepare("SELECT value FROM meta WHERE key = 'schema'")
        .get();
      if (!row)
        db.prepare("INSERT INTO meta (key, value) VALUES ('schema', ?)").run(
          String(SCHEMA_VERSION),
        );
      else if (Number(row.value) !== SCHEMA_VERSION)
        throw new Error(`unsupported traffic schema ${row.value}`);
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  };
  if (file === ':memory:') return open();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    return open();
  } catch (error) {
    if (!CORRUPT.test(String(error?.message))) {
      warn(
        `[airsea] traffic history not opened (${error.message}); kept in memory for this run`,
      );
      return open(':memory:');
    }
    const aside = `${file}.corrupt-${Date.now()}`;
    warn(
      `[airsea] traffic history unreadable (${error.message}); moved to ${aside}`,
    );
    for (const suffix of ['', '-wal', '-shm'])
      try {
        fs.renameSync(`${file}${suffix}`, `${aside}${suffix}`);
      } catch {
        /* absent */
      }
    return open();
  }
}

/**
 * @param {{file?: string, now?: () => number, warn?: Function}} [options]
 */
export function createTrafficHistory({
  file = ':memory:',
  now = () => Date.now(),
  warn = (...args) => console.warn(...args),
} = {}) {
  const db = openDatabase(file, warn);
  const q = {
    fine: db.prepare(
      `INSERT INTO fine (domain, res, cell, bucket, passages, minutes) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (domain, res, cell, bucket) DO UPDATE SET
         passages = passages + excluded.passages, minutes = minutes + excluded.minutes`,
    ),
    hourly: db.prepare(
      `INSERT INTO hourly (domain, res, cell, hour, passages, minutes) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (domain, res, cell, hour) DO UPDATE SET
         passages = passages + excluded.passages, minutes = minutes + excluded.minutes`,
    ),
    coverage: db.prepare(
      `INSERT INTO coverage (domain, hour, snapshots, objects) VALUES (?, ?, ?, ?)
       ON CONFLICT (domain, hour) DO UPDATE SET
         snapshots = snapshots + excluded.snapshots, objects = objects + excluded.objects`,
    ),
    sumFine: db.prepare(
      `SELECT cell, SUM(passages) AS passages, SUM(minutes) AS minutes FROM fine
       WHERE domain = ? AND res = ? AND bucket >= ? GROUP BY cell`,
    ),
    sumHourly: db.prepare(
      `SELECT cell, SUM(passages) AS passages, SUM(minutes) AS minutes FROM hourly
       WHERE domain = ? AND res = ? AND hour >= ? GROUP BY cell`,
    ),
    sumRange: db.prepare(
      `SELECT cell, SUM(passages) AS passages FROM hourly
       WHERE domain = ? AND res = ? AND hour >= ? AND hour < ? GROUP BY cell`,
    ),
    coverageRange: db.prepare(
      `SELECT COALESCE(SUM(snapshots), 0) AS snapshots, COALESCE(SUM(objects), 0) AS objects
       FROM coverage WHERE domain = ? AND hour >= ? AND hour < ?`,
    ),
    hour: db.prepare(
      'SELECT cell, passages, minutes FROM hourly WHERE domain = ? AND res = ? AND hour = ?',
    ),
    coverageAt: db.prepare(
      'SELECT snapshots, objects FROM coverage WHERE domain = ? AND hour = ?',
    ),
    coverageSince: db.prepare(
      'SELECT hour, snapshots, objects FROM coverage WHERE domain = ? AND hour >= ? ORDER BY hour',
    ),
    first: db.prepare(
      'SELECT MIN(hour) AS hour FROM coverage WHERE domain = ?',
    ),
    pruneFine: db.prepare('DELETE FROM fine WHERE bucket < ?'),
    pruneHourly: db.prepare('DELETE FROM hourly WHERE hour < ?'),
    pruneCoverage: db.prepare('DELETE FROM coverage WHERE hour < ?'),
  };

  // Pending additions, flushed in one transaction.
  const pending = new Map(); // key -> {domain, res, cell, at, passages, minutes}
  const pendingCoverage = new Map(); // `${domain}|${hour}` -> {snapshots, objects}

  const bucketOf = (ms) => Math.floor(ms / FIVE_MIN) * FIVE_MIN;
  const hourOf = (ms) => Math.floor(ms / HOUR) * HOUR;

  function add(domain, { passages = [], minutes = [] }) {
    const touch = (resolution, cell, at) => {
      const key = `${domain}|${resolution}|${cell}|${bucketOf(at)}`;
      let entry = pending.get(key);
      if (!entry) {
        entry = {
          domain,
          res: resolution,
          cell,
          at: bucketOf(at),
          passages: 0,
          minutes: 0,
        };
        pending.set(key, entry);
      }
      return entry;
    };
    for (const p of passages) touch(p.resolution, p.cell, p.at).passages += 1;
    for (const m of minutes)
      touch(m.resolution, m.cell, m.at).minutes += m.minutes;
  }

  /** One delivered snapshot of a domain's main feed, with its object count. */
  function noteSnapshot(domain, at, objects) {
    const key = `${domain}|${hourOf(at)}`;
    const entry = pendingCoverage.get(key) ?? { snapshots: 0, objects: 0 };
    entry.snapshots += 1;
    entry.objects += objects;
    pendingCoverage.set(key, entry);
  }

  let flushFailures = 0;
  function flush() {
    if (!pending.size && !pendingCoverage.size) return;
    try {
      db.exec('BEGIN');
    } catch (error) {
      failed(error);
      return;
    }
    try {
      for (const e of pending.values()) {
        q.fine.run(e.domain, e.res, e.cell, e.at, e.passages, e.minutes);
        q.hourly.run(
          e.domain,
          e.res,
          e.cell,
          hourOf(e.at),
          e.passages,
          e.minutes,
        );
      }
      for (const [key, e] of pendingCoverage) {
        const [domain, hour] = key.split('|');
        q.coverage.run(domain, Number(hour), e.snapshots, e.objects);
      }
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* nothing to roll back */
      }
      failed(error);
      return;
    }
    flushFailures = 0;
    pending.clear();
    pendingCoverage.clear();
  }

  /** A write failed: keep the rows for the next try, a few times only. */
  function failed(error) {
    flushFailures += 1;
    warn(`[airsea] history write failed: ${error.message}`);
    if (flushFailures >= MAX_FLUSH_FAILURES) {
      warn(`[airsea] dropping ${pending.size} unsaved history rows`);
      pending.clear();
      pendingCoverage.clear();
      flushFailures = 0;
    }
  }

  return {
    add,
    noteSnapshot,
    flush,
    /** Passages and object-minutes per cell over the last `windowMs`. */
    footprint({ domain, resolution, windowMs }) {
      flush();
      const t = now();
      const rows =
        windowMs <= FINE_WINDOW_MAX_MS
          ? q.sumFine.all(domain, resolution, bucketOf(t - windowMs))
          : q.sumHourly.all(domain, resolution, hourOf(t - windowMs));
      return rows.map((r) => ({
        cell: r.cell,
        passages: r.passages,
        minutes: r.minutes,
      }));
    },
    /** Hourly totals of one past hour: Map cell -> passages. */
    hourCells({ domain, resolution, hour }) {
      flush();
      return new Map(
        q.hour.all(domain, resolution, hour).map((r) => [r.cell, r.passages]),
      );
    },
    /** Passages per cell over whole hours [from, to): Map cell -> passages. */
    rangeCells({ domain, resolution, from, to }) {
      flush();
      return new Map(
        q.sumRange
          .all(domain, resolution, hourOf(from), hourOf(to))
          .map((r) => [r.cell, r.passages]),
      );
    },
    /** Snapshots and objects delivered over whole hours [from, to). */
    rangeCoverage(domain, from, to) {
      flush();
      const row = q.coverageRange.get(domain, hourOf(from), hourOf(to));
      return { snapshots: row.snapshots, objects: row.objects };
    },
    coverage(domain, hour) {
      flush();
      return q.coverageAt.get(domain, hour) ?? null;
    },
    coverageSince(domain, since) {
      flush();
      return q.coverageSince.all(domain, hourOf(since));
    },
    /** Start of the first recorded hour of a domain, or null. */
    since(domain) {
      flush();
      return q.first.get(domain)?.hour ?? null;
    },
    prune() {
      flush();
      const t = now();
      try {
        q.pruneFine.run(t - FINE_RETAIN_MS);
        q.pruneHourly.run(t - HOURLY_RETAIN_MS);
        q.pruneCoverage.run(t - HOURLY_RETAIN_MS);
      } catch (error) {
        warn(`[airsea] history prune failed: ${error.message}`);
      }
    },
    close() {
      flush();
      try {
        db.close();
      } catch (error) {
        warn(`[airsea] history close failed: ${error.message}`);
      }
    },
  };
}

export const HOUR_MS = HOUR;
