// The durable inbound queue: every report a push source delivers is written
// here, with that source's stream cursor, in one transaction, before anything
// looks at it. Writes are idempotent on (source, native id, revision), so a
// reconnect that replays the stream adds nothing and keeps the original times.
// Bounded: past the watermark the lowest-priority waiting report is dropped and
// counted, never silently lost. A file of its own, so a slow or damaged queue
// cannot touch the evidence store, and it is set aside rather than fatal.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS intake (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL,
  native_id TEXT NOT NULL,
  revision TEXT NOT NULL,
  kind TEXT NOT NULL,
  priority INTEGER NOT NULL,
  published_at INTEGER,
  received_at INTEGER NOT NULL,
  processed_at INTEGER,
  status TEXT NOT NULL,
  outcome TEXT,
  event_id TEXT,
  displayed_at INTEGER,
  body TEXT NOT NULL,
  UNIQUE (source_id, native_id, revision)
);
CREATE INDEX IF NOT EXISTS intake_waiting ON intake(status, source_id, priority, seq);
CREATE INDEX IF NOT EXISTS intake_by_native ON intake(source_id, native_id);
CREATE INDEX IF NOT EXISTS intake_by_event ON intake(event_id);
CREATE INDEX IF NOT EXISTS intake_by_time ON intake(received_at);
CREATE TABLE IF NOT EXISTS cursors (
  source_id TEXT PRIMARY KEY,
  cursor TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS counters (
  source_id TEXT NOT NULL,
  name TEXT NOT NULL,
  value INTEGER NOT NULL,
  PRIMARY KEY (source_id, name)
);
CREATE TABLE IF NOT EXISTS dead_letters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  reason TEXT NOT NULL,
  sample TEXT
);
`;
const DAY = 24 * 3600_000;
const MAX_DEAD_LETTERS = 500;
const MAX_SAMPLE = 400;

function open(file, warn) {
  const start = () => {
    const db = new DatabaseSync(file);
    try {
      db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
      db.exec('PRAGMA busy_timeout = 2000;');
      db.exec(SCHEMA);
      db.prepare('SELECT count(*) FROM intake').get();
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  };
  if (file === ':memory:') return start();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    return start();
  } catch (error) {
    const aside = `${file}.corrupt-${Date.now()}`;
    warn(`[fast-feeds] queue unreadable (${error.message}); moved to ${aside}`);
    for (const suffix of ['', '-wal', '-shm'])
      try {
        fs.renameSync(`${file}${suffix}`, `${aside}${suffix}`);
      } catch {
        /* absent */
      }
    return start();
  }
}

/**
 * @param {{file?: string, maxPending?: number, rawRetentionDays?: number,
 *   now?: () => number, warn?: Function}} [options]
 */
export function createIntake({
  file = ':memory:',
  maxPending = 20_000,
  rawRetentionDays = 14,
  now = () => Date.now(),
  warn = (...args) => console.warn(...args),
} = {}) {
  const db = open(file, warn);
  const q = {
    insert: db.prepare(
      `INSERT OR IGNORE INTO intake
       (source_id, native_id, revision, kind, priority, published_at, received_at, status, body)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    ),
    pendingCount: db.prepare(
      "SELECT count(*) AS n FROM intake WHERE status = 'pending'",
    ),
    lowestPending: db.prepare(
      `SELECT seq, source_id, priority FROM intake WHERE status = 'pending'
       ORDER BY priority, seq DESC LIMIT 1`,
    ),
    drop: db.prepare(
      "UPDATE intake SET status = 'dropped', outcome = 'overflow', processed_at = ?, body = '{}' WHERE seq = ?",
    ),
    waitingSources: db.prepare(
      "SELECT DISTINCT source_id FROM intake WHERE status = 'pending'",
    ),
    nextForSource: db.prepare(
      `SELECT * FROM intake WHERE status = 'pending' AND source_id = ?
       ORDER BY priority DESC, seq LIMIT ?`,
    ),
    complete: db.prepare(
      'UPDATE intake SET status = ?, outcome = ?, event_id = ?, processed_at = ? WHERE seq = ?',
    ),
    forNative: db.prepare(
      `SELECT seq, revision, kind, event_id, status FROM intake
       WHERE source_id = ? AND native_id = ? ORDER BY seq`,
    ),
    blank: db.prepare(
      "UPDATE intake SET body = '{}' WHERE source_id = ? AND native_id = ? AND kind != 'delete'",
    ),
    cursor: db.prepare('SELECT cursor FROM cursors WHERE source_id = ?'),
    putCursor: db.prepare(
      `INSERT INTO cursors (source_id, cursor, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(source_id) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`,
    ),
    bump: db.prepare(
      `INSERT INTO counters (source_id, name, value) VALUES (?, ?, ?)
       ON CONFLICT(source_id, name) DO UPDATE SET value = value + excluded.value`,
    ),
    counters: db.prepare('SELECT source_id, name, value FROM counters'),
    dead: db.prepare(
      'INSERT INTO dead_letters (source_id, at, reason, sample) VALUES (?, ?, ?, ?)',
    ),
    trimDead: db.prepare(
      'DELETE FROM dead_letters WHERE id <= (SELECT max(id) FROM dead_letters) - ?',
    ),
    deadList: db.prepare(
      'SELECT source_id, at, reason FROM dead_letters ORDER BY id DESC LIMIT ?',
    ),
    recent: db.prepare(
      `SELECT seq, source_id, native_id, kind, status, outcome, event_id,
              published_at, received_at, processed_at, displayed_at, body
       FROM intake WHERE status IN ('processed', 'filtered')
       ORDER BY seq DESC LIMIT ?`,
    ),
    forEvent: db.prepare(
      `SELECT source_id, native_id, published_at, received_at, processed_at, displayed_at
       FROM intake WHERE event_id = ? ORDER BY received_at`,
    ),
    display: db.prepare(
      `UPDATE intake SET displayed_at = ?
       WHERE event_id = ? AND displayed_at IS NULL AND status = 'processed'
       RETURNING source_id, received_at`,
    ),
    prune: db.prepare(
      'DELETE FROM intake WHERE received_at < ? AND status != ?',
    ),
  };

  let pending = q.pendingCount.get().n;

  const transaction = (work) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const value = work();
      db.exec('COMMIT');
      return value;
    } catch (error) {
      db.exec('ROLLBACK');
      pending = q.pendingCount.get().n;
      throw error;
    }
  };
  const count = (sourceId, name, by = 1) => {
    if (by) q.bump.run(sourceId, name, by);
  };

  /**
   * Past the watermark something gives: the lowest-priority report waiting, or
   * the new one if nothing waiting ranks below it. Returns whether it fits.
   */
  function makeRoom(priority) {
    if (pending < maxPending) return true;
    const lowest = q.lowestPending.get();
    if (!lowest || lowest.priority >= priority) return false;
    q.drop.run(now(), lowest.seq);
    count(lowest.source_id, 'dropped');
    pending -= 1;
    return true;
  }

  return {
    /**
     * Store a batch and, atomically with it, the cursor it reaches. After a
     * crash the stream resumes exactly where the stored reports end.
     * @returns {{accepted: number, duplicate: number, dropped: number}}
     */
    enqueue(sourceId, reports, { cursor } = {}) {
      const result = { accepted: 0, duplicate: 0, dropped: 0 };
      transaction(() => {
        for (const report of reports) {
          if (!makeRoom(report.priority ?? 0)) {
            result.dropped += 1;
            continue;
          }
          const { changes } = q.insert.run(
            sourceId,
            report.native_id,
            report.revision ?? '0',
            report.kind ?? 'post',
            report.priority ?? 0,
            report.published_at ?? null,
            report.received_at,
            JSON.stringify(report),
          );
          if (changes) {
            result.accepted += 1;
            pending += 1;
          } else result.duplicate += 1;
        }
        count(sourceId, 'received', result.accepted);
        count(sourceId, 'replayed', result.duplicate);
        count(sourceId, 'dropped', result.dropped);
        if (cursor !== undefined && cursor !== null)
          q.putCursor.run(sourceId, String(cursor), now());
      });
      return result;
    },
    /** The next reports to work on, a fair share per source, best first. */
    next(limit = 100) {
      const sources = q.waitingSources.all().map((row) => row.source_id);
      if (!sources.length) return [];
      const share = Math.max(1, Math.ceil(limit / sources.length));
      const rows = sources.flatMap((id) => q.nextForSource.all(id, share));
      return rows
        .sort((a, b) => b.priority - a.priority || a.seq - b.seq)
        .slice(0, limit)
        .map((row) => ({ ...row, report: JSON.parse(row.body) }));
    },
    complete(seq, { status, outcome = null, eventId = null }) {
      q.complete.run(status, outcome, eventId, now(), seq);
      pending = Math.max(0, pending - 1);
    },
    count,
    deadLetter(sourceId, reason, sample = '') {
      q.dead.run(
        sourceId,
        now(),
        String(reason).slice(0, 120),
        String(sample).slice(0, MAX_SAMPLE),
      );
      q.trimDead.run(MAX_DEAD_LETTERS);
      count(sourceId, 'dead_lettered');
    },
    deadLetters: (limit = 20) => q.deadList.all(limit),
    cursor: (sourceId) => q.cursor.get(sourceId)?.cursor ?? null,
    setCursor: (sourceId, cursor) =>
      q.putCursor.run(sourceId, String(cursor), now()),
    /** Earlier revisions of one report, oldest first. */
    history: (sourceId, nativeId) => q.forNative.all(sourceId, nativeId),
    /** A source took a report back: its words leave the queue too. */
    blank(sourceId, nativeId) {
      q.blank.run(sourceId, nativeId);
    },
    recent: (limit = 50) =>
      q.recent.all(limit).map((row) => ({ ...row, body: undefined })),
    forEvent: (eventId) => q.forEvent.all(eventId),
    /**
     * The first time an event's reports were served to the map.
     * @returns {Array<{source_id: string, received_at: number}>} Newly shown.
     */
    markDisplayed(eventId) {
      return q.display.all(now(), eventId);
    },
    counters() {
      const out = {};
      for (const { source_id: id, name, value } of q.counters.all())
        (out[id] ??= {})[name] = value;
      return out;
    },
    stats: () => ({ pending, max_pending: maxPending }),
    /** Raw report text older than retention is removed; waiting work is kept. */
    prune(at = now()) {
      return Number(
        q.prune.run(at - rawRetentionDays * DAY, 'pending').changes,
      );
    },
    close: () => db.close(),
  };
}
