// SQLite evidence store (Node's built-in node:sqlite; no server, no native
// add-on). Implements the store contract of src/intel/memoryStore.js so the
// engine is identical in tests, replay and live use. Observations are
// immutable rows; events hold the current fold; revisions keep history after
// a marker leaves the map. Retention is bounded and a corrupt database file is
// set aside rather than crashing the dev server.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { matchesArchiveFilter } from '../../../src/intel/memoryStore.js';

const SCHEMA_VERSION = 1;
const MAX_OBSERVATIONS_PER_EVENT = 500;
const DAY = 24 * 3600_000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_meaningful_update_at INTEGER NOT NULL,
  body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_by_update ON events(last_meaningful_update_at);
CREATE TABLE IF NOT EXISTS observations (
  observation_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  url TEXT,
  publisher TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  material INTEGER NOT NULL,
  body TEXT NOT NULL,
  link TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS observations_by_event ON observations(event_id, received_at);
CREATE INDEX IF NOT EXISTS observations_by_url ON observations(url, content_digest);
CREATE INDEX IF NOT EXISTS observations_by_publisher ON observations(publisher, content_digest);
CREATE TABLE IF NOT EXISTS revisions (
  event_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  recorded_at INTEGER NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (event_id, revision)
);
CREATE TABLE IF NOT EXISTS duplicates (
  event_id TEXT,
  observation_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS duplicates_by_time ON duplicates(received_at);
CREATE TABLE IF NOT EXISTS flags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recorded_at INTEGER NOT NULL,
  body TEXT NOT NULL
);
`;

function openDatabase(file, warn) {
  const open = () => {
    const db = new DatabaseSync(file);
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
        throw new Error(`unsupported intel schema ${row.value}`);
      db.prepare('SELECT count(*) FROM events').get();
      return db;
    } catch (error) {
      // Windows cannot rename a file this handle still holds.
      db.close();
      throw error;
    }
  };
  if (file === ':memory:') return open();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    return open();
  } catch (error) {
    const aside = `${file}.corrupt-${Date.now()}`;
    warn(
      `[intel] evidence store unreadable (${error.message}); moved to ${aside}`,
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
 * @param {{file?: string, retentionDays?: number, now?: () => number,
 *   warn?: Function}} [options]
 */
export function createSqliteIntelStore({
  file = ':memory:',
  retentionDays = 90,
  now = () => Date.now(),
  warn = (...args) => console.warn(...args),
} = {}) {
  const db = openDatabase(file, warn);
  const q = {
    hasId: db.prepare(
      'SELECT event_id FROM observations WHERE observation_id = ?',
    ),
    hasUrl: db.prepare(
      'SELECT event_id FROM observations WHERE url = ? AND content_digest = ? LIMIT 1',
    ),
    hasPublisher: db.prepare(
      'SELECT event_id FROM observations WHERE publisher = ? AND content_digest = ? LIMIT 1',
    ),
    eventsSince: db.prepare(
      'SELECT body FROM events WHERE last_meaningful_update_at >= ?',
    ),
    getEvent: db.prepare('SELECT body FROM events WHERE event_id = ?'),
    putEvent: db.prepare(
      `INSERT INTO events (event_id, category, first_seen_at, last_meaningful_update_at, body)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(event_id) DO UPDATE SET category = excluded.category,
         first_seen_at = excluded.first_seen_at,
         last_meaningful_update_at = excluded.last_meaningful_update_at,
         body = excluded.body`,
    ),
    putObservation: db.prepare(
      `INSERT OR IGNORE INTO observations
       (observation_id, event_id, url, publisher, content_digest, received_at, material, body, link)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    observationBody: db.prepare(
      'SELECT body FROM observations WHERE observation_id = ?',
    ),
    putObservationBody: db.prepare(
      'UPDATE observations SET body = ? WHERE observation_id = ?',
    ),
    observationsFor: db.prepare(
      `SELECT body, link FROM (SELECT body, link, received_at, rowid FROM observations
         WHERE event_id = ? ORDER BY received_at DESC, rowid DESC LIMIT ?)
       ORDER BY received_at, rowid`,
    ),
    putRevision: db.prepare(
      'INSERT OR REPLACE INTO revisions (event_id, revision, recorded_at, body) VALUES (?, ?, ?, ?)',
    ),
    revisions: db.prepare(
      'SELECT body FROM revisions WHERE event_id = ? ORDER BY revision',
    ),
    putDuplicate: db.prepare(
      'INSERT INTO duplicates (event_id, observation_id, reason, received_at) VALUES (?, ?, ?, ?)',
    ),
    putFlag: db.prepare('INSERT INTO flags (recorded_at, body) VALUES (?, ?)'),
    flags: db.prepare('SELECT body FROM flags ORDER BY id'),
    listRecent: db.prepare(
      'SELECT body FROM events ORDER BY last_meaningful_update_at DESC',
    ),
    counts: db.prepare(
      `SELECT (SELECT count(*) FROM events) AS events,
              (SELECT count(*) FROM observations) AS observations,
              (SELECT count(*) FROM duplicates) AS duplicates_suppressed`,
    ),
  };
  const parse = (row) => (row ? JSON.parse(row.body) : null);

  const index = {
    byId: { has: (id) => Boolean(q.hasId.get(id)) },
    byUrlDigest: {
      has: (key) => {
        const cut = key.lastIndexOf('|');
        return Boolean(q.hasUrl.get(key.slice(0, cut), key.slice(cut + 1)));
      },
    },
    byPublisherDigest: {
      has: (key) => {
        const cut = key.lastIndexOf('|');
        return Boolean(
          q.hasPublisher.get(key.slice(0, cut), key.slice(cut + 1)),
        );
      },
    },
  };

  const store = {
    duplicateIndex: () => index,
    eventForDuplicate(observation) {
      return (
        q.hasId.get(observation.observation_id)?.event_id ??
        (observation.url
          ? q.hasUrl.get(observation.url, observation.content_digest)?.event_id
          : undefined) ??
        q.hasPublisher.get(observation.publisher, observation.content_digest)
          ?.event_id ??
        null
      );
    },
    noteDuplicate(eventId, observation, reason) {
      const event = store.getEvent(eventId);
      if (event)
        store.saveEvent({
          ...event,
          duplicate_count: event.duplicate_count + 1,
          last_seen_at: Math.max(event.last_seen_at, observation.received_at),
        });
      q.putDuplicate.run(
        eventId,
        observation.observation_id,
        reason,
        observation.received_at,
      );
    },
    eventsSince: (since) => q.eventsSince.all(since).map(parse),
    observationsFor: (eventId) =>
      q.observationsFor.all(eventId, MAX_OBSERVATIONS_PER_EVENT).map(parse),
    evidenceFor: (eventId) =>
      q.observationsFor.all(eventId, MAX_OBSERVATIONS_PER_EVENT).map((row) => ({
        observation: JSON.parse(row.body),
        link: JSON.parse(row.link),
      })),
    saveEvent(event) {
      q.putEvent.run(
        event.event_id,
        event.category,
        event.first_seen_at,
        event.last_meaningful_update_at,
        JSON.stringify(event),
      );
    },
    saveObservation(observation, link) {
      q.putObservation.run(
        observation.observation_id,
        link.event_id,
        observation.url,
        observation.publisher,
        observation.content_digest,
        observation.received_at,
        link.material ? 1 : 0,
        JSON.stringify(observation),
        JSON.stringify(link),
      );
    },
    /** Blank a report's words; the record that it existed stays. */
    redactObservation(observationId, patch) {
      const row = q.observationBody.get(observationId);
      if (row)
        q.putObservationBody.run(
          JSON.stringify({ ...JSON.parse(row.body), ...patch }),
          observationId,
        );
    },
    /** The same for what the history kept of its words. */
    redactRevisions(eventId, titles, replacement) {
      for (const revision of q.revisions.all(eventId).map(parse)) {
        if (!titles.has(revision.snapshot?.title)) continue;
        revision.snapshot.title = replacement;
        store.saveRevision(revision);
      }
    },
    saveRevision(revision) {
      q.putRevision.run(
        revision.event_id,
        revision.revision,
        revision.recorded_at,
        JSON.stringify(revision),
      );
    },
    getEvent: (id) => parse(q.getEvent.get(id)),
    revisions: (id) => q.revisions.all(id).map(parse),
    listEvents(filter = {}, { limit = 200 } = {}) {
      // Filters are applied in JS, sharing the memory store's semantics
      // exactly, over every stored event newest first (streamed, stopping at
      // the limit; retention bounds the table), so older matches are found.
      const out = [];
      for (const row of q.listRecent.iterate()) {
        const event = JSON.parse(row.body);
        if (matchesArchiveFilter(event, filter)) out.push(event);
        if (out.length >= limit) break;
      }
      return out;
    },
    flagMerge(flag) {
      q.putFlag.run(now(), JSON.stringify(flag));
    },
    flags: () => q.flags.all().map(parse),
    stats: () => ({ ...q.counts.get() }),
    /** Delete events (and their evidence) not meaningfully updated within retention. */
    prune(at = now()) {
      const cutoff = at - retentionDays * DAY;
      db.exec('BEGIN');
      try {
        const ids = db
          .prepare(
            'SELECT event_id FROM events WHERE last_meaningful_update_at < ?',
          )
          .all(cutoff)
          .map((row) => row.event_id);
        // Machine-coded news and lone social claims are voluminous and of
        // little value once cold.
        for (const provider of ['gdelt', 'bluesky', 'telegram'])
          for (const row of db
            .prepare(
              `SELECT event_id FROM events WHERE last_meaningful_update_at < ? AND body LIKE '%"providers":["${provider}"]%'`,
            )
            .all(at - 14 * DAY))
            if (!ids.includes(row.event_id)) ids.push(row.event_id);
        const del = (table) =>
          db.prepare(`DELETE FROM ${table} WHERE event_id = ?`);
        const statements = [
          'observations',
          'revisions',
          'duplicates',
          'events',
        ].map(del);
        for (const id of ids)
          for (const statement of statements) statement.run(id);
        db.prepare('DELETE FROM duplicates WHERE received_at < ?').run(cutoff);
        db.exec('COMMIT');
        return ids.length;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    /** Erase all stored evidence and history (operator request). */
    clear() {
      db.exec(
        'DELETE FROM observations; DELETE FROM revisions; DELETE FROM duplicates; DELETE FROM events; DELETE FROM flags;',
      );
    },
    close: () => db.close(),
  };
  return store;
}
