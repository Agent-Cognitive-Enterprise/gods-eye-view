import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { fastStatus } from '../../../src/intel/fastStatus.js';
import { createIntelService } from '../intel/service.js';
import { publicationTime } from './adapters/bluesky.js';
import { createFastFeeds } from './index.js';
import { createIntake } from './intake.js';
import { createLatencyBook } from './latency.js';
import { createPipeline } from './pipeline.js';
import { SYNTHETIC_DID, fakeSockets, postFrame } from './testing.mjs';

const T0 = Date.parse('2026-10-31T03:20:04.000Z');

function instance(dir, sockets) {
  const service = createIntelService({
    storeFile: path.join(dir, 'intel.sqlite'),
    settingsFile: path.join(dir, 'settings.json'),
    now: () => T0,
    log: () => {},
  });
  const fast = createFastFeeds({
    engine: service.engine,
    store: service.store,
    dir,
    env: {},
    now: () => T0,
    log: () => {},
    WebSocketImpl: sockets.FakeSocket,
    loadTelegramLogin: async () => null,
    intervalMs: 3_600_000,
  });
  return {
    service,
    fast,
    async close() {
      await fast.close();
      service.close();
    },
  };
}

test('19: a restart keeps events, the cursor, the sources and the queue', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-fast-restart-'));
  const sockets = fakeSockets();

  const first = instance(dir, sockets);
  first.fast.updateSettings({
    bluesky: {
      accounts: [{ did: SYNTHETIC_DID, label: 'Kept', tag: 'reporter' }],
    },
    rawRetentionDays: 9,
  });
  first.fast.start();
  sockets.last().open();
  sockets.last().frame(postFrame({ seq: 500, rkey: 'a' }));
  await first.fast.adapters[0].stop();
  first.fast.pipeline().pass();
  const [before] = first.service.listEvents('live').events;
  assert.equal(before.lineages[0].source_type, 'secondary_reporting');
  // One more report stored and not yet processed when the server stops.
  first.fast.intake.enqueue(
    'bluesky',
    [
      {
        native_id: 'at://waiting',
        revision: 'r1',
        received_at: T0,
        provider: 'bluesky',
        publisher: `bsky:${SYNTHETIC_DID}`,
        source_type: 'secondary_reporting',
        published_at: T0 - 1_000,
        text: 'Tornado hits Hilo, roofs gone',
      },
    ],
    { cursor: 501 },
  );
  await first.close();

  const second = instance(dir, sockets);
  // Windows refuses to delete an open database: close first, then remove.
  t.after(async () => {
    await second.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const held = second.fast.settings();
  assert.equal(held.bluesky.accounts[0].label, 'Kept');
  assert.equal(held.rawRetentionDays, 9);
  assert.equal(second.fast.intake.stats().pending, 1, 'waiting work survives');
  second.fast.start();
  assert.equal(
    new URL(sockets.last().url).searchParams.get('cursor'),
    '501',
    'resumes where the stored reports end',
  );
  sockets.last().open();
  sockets.last().frame(postFrame({ seq: 500, rkey: 'a' }));
  await second.fast.adapters[0].stop();
  second.fast.pipeline().pass();
  const events = second.service.listEvents('live').events;
  assert.equal(events.length, 2, 'the waiting report became an event');
  const same = events.find((e) => e.event_id === before.event_id);
  assert.ok(same, 'the event keeps its id');
  assert.equal(
    second.service.store.observationsFor(same.event_id).length,
    1,
    'no duplicate',
  );
  assert.equal(fastStatus(same), 'provisional');
});

test('a handled report keeps its record and none of its words', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-fast-words-'));
  const file = path.join(dir, 'fast-intake.sqlite');
  const intake = createIntake({ file });
  const words = 'distinctive words of a stranger';
  for (const native_id of ['filtered', 'processed'])
    intake.enqueue('s', [{ native_id, received_at: T0, text: words }]);
  const [first, second] = intake.next(2);
  intake.complete(first.seq, { status: 'filtered', outcome: 'no_topic' });
  intake.complete(second.seq, { status: 'processed', outcome: 'new_event' });
  intake.close();
  const db = new DatabaseSync(file);
  const rows = db.prepare('SELECT body FROM intake').all();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(rows.length, 2, 'the records stay');
  assert.ok(
    rows.every((row) => row.body === '{}'),
    'the words go',
  );
});

test('a pass stops at its time budget and leaves the rest waiting', () => {
  const intake = createIntake({ now: () => T0 });
  intake.enqueue(
    's',
    Array.from({ length: 100 }, (_, i) => ({
      native_id: `n${i}`,
      received_at: T0,
      published_at: T0,
      text: `Explosions heard in Kharkiv, report ${i}`,
      provider: 'bluesky',
      publisher: `bsky:did:plc:a${i}`,
      source_type: 'social_claim',
    })),
  );
  const pipeline = createPipeline({
    intake,
    latency: createLatencyBook(),
    now: () => T0,
    log: () => {},
    engine: {
      ingest() {
        const until = performance.now() + 15;
        while (performance.now() < until) {
          /* a slow engine */
        }
        return [{ status: 'new_event', event_id: 'evt_1' }];
      },
    },
  });
  const handled = pipeline.pass();
  assert.ok(handled >= 1 && handled < 10, `${handled} handled in one pass`);
  assert.equal(intake.stats().pending, 100 - handled);
  intake.close();
});

test('intake: an unreadable queue file is set aside, never fatal', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-fast-corrupt-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'fast-intake.sqlite');
  fs.writeFileSync(file, 'this is not a database, not even a little');
  const warnings = [];
  const intake = createIntake({ file, warn: (text) => warnings.push(text) });
  assert.equal(
    intake.enqueue('s', [{ native_id: 'x', received_at: T0 }]).accepted,
    1,
  );
  intake.close();
  assert.equal(warnings.length, 1);
  assert.ok(fs.readdirSync(dir).some((name) => name.includes('.corrupt-')));
});

test('22: times are compared as instants, whatever zone a post states', () => {
  const stream = '2026-10-31T03:20:00.000Z';
  const seen = Date.parse(stream);
  // Three hours ahead of UTC, one second before the stream saw it.
  assert.equal(
    publicationTime(stream, '2026-10-31T06:19:59.000+03:00').published_at,
    seen - 1000,
  );
  assert.equal(
    publicationTime(stream, '2026-10-30T17:19:59-10:00').published_at,
    seen - 1000,
  );
  // A local clock read as UTC would look like the future; it is held to the stream.
  const naive = publicationTime(stream, '2026-10-31T14:20:00+00:00');
  assert.equal(naive.published_at, seen);
  assert.equal(naive.suspect, true);
});

test('22: an instant across a daylight-saving change stays one instant', () => {
  // 2026-10-25 01:30 UTC, the European change: the two local spellings agree.
  const utc = '2026-10-25T01:30:00.000Z';
  assert.equal(
    publicationTime(utc, '2026-10-25T02:30:00.000+01:00').published_at,
    Date.parse(utc),
  );
  assert.equal(
    publicationTime(utc, '2026-10-25T03:30:00.000+02:00').published_at,
    Date.parse(utc),
  );
});
