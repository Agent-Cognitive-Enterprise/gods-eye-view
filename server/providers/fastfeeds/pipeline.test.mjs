import test from 'node:test';
import assert from 'node:assert/strict';
import { createIntelEngine } from '../../../src/intel/engine.js';
import { fastStatus } from '../../../src/intel/fastStatus.js';
import { createMemoryIntelStore } from '../../../src/intel/memoryStore.js';
import { AUTOPILOT_DEFAULTS } from '../../../src/intel/taxonomy.js';
import {
  backoffMs,
  createBlueskyAdapter,
  jetstreamUrl,
  publicationTime,
} from './adapters/bluesky.js';
import { canonicalLink } from './gate.js';
import { createIntake } from './intake.js';
import { createLatencyBook, percentile } from './latency.js';
import { createPipeline } from './pipeline.js';
import {
  SYNTHETIC_DID,
  SYNTHETIC_DID_2,
  SYNTHETIC_DID_3,
  deleteFrame,
  fakeSockets,
  fakeTimers,
  postFrame,
} from './testing.mjs';

const T0 = Date.parse('2026-10-31T03:20:04.000Z');

function rig({ accounts, intakeOptions = {}, pipelineOptions = {} } = {}) {
  let clock = T0;
  const now = () => clock;
  const sockets = fakeSockets();
  const timers = fakeTimers();
  const intake = createIntake({ now, ...intakeOptions });
  const store = createMemoryIntelStore();
  const engine = createIntelEngine({
    store,
    now,
    settings: AUTOPILOT_DEFAULTS,
  });
  const latency = createLatencyBook();
  const pipeline = createPipeline({
    intake,
    engine,
    latency,
    now,
    log: () => {},
    ...pipelineOptions,
  });
  const list = accounts ?? [
    { did: SYNTHETIC_DID, source_type: 'social_claim', tag: 'community' },
    { did: SYNTHETIC_DID_2, source_type: 'social_claim', tag: 'community' },
    { did: SYNTHETIC_DID_3, source_type: 'social_claim', tag: 'community' },
  ];
  const adapter = createBlueskyAdapter({
    accounts: () => list,
    intake,
    canonical: canonicalLink,
    WebSocketImpl: sockets.FakeSocket,
    now,
    log: () => {},
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    random: () => 0.5,
  });
  return {
    now,
    advance: (ms) => (clock += ms),
    sockets,
    timers,
    intake,
    store,
    engine,
    latency,
    pipeline,
    adapter,
    list,
    /** Stored reports, processed, then the events on the map. */
    settle() {
      adapter.flushForTest?.();
      timers.run();
      while (pipeline.pass()) {
        /* drain */
      }
      return engine.activeEvents(clock);
    },
  };
}

test('stream address: v2 route and parameters, never the v1 names', () => {
  const url = new URL(
    jetstreamUrl('host.example', ['did:plc:a', 'did:plc:b'], '42'),
  );
  assert.equal(url.protocol, 'wss:');
  assert.equal(url.pathname, '/xrpc/network.bsky.jetstream.subscribeEvents');
  assert.deepEqual(url.searchParams.getAll('dids'), ['did:plc:a', 'did:plc:b']);
  assert.deepEqual(url.searchParams.getAll('collections'), [
    'app.bsky.feed.post',
  ]);
  assert.deepEqual(url.searchParams.getAll('kinds'), ['commit']);
  assert.equal(url.searchParams.get('cursor'), '42');
  assert.equal(url.searchParams.has('wantedCollections'), false);
  assert.equal(url.searchParams.has('wantedDids'), false);
  assert.equal(
    new URL(jetstreamUrl('h', ['did:plc:a'], null)).searchParams.has('cursor'),
    false,
  );
});

test('stream address: a long list is filtered here, not in the address', () => {
  const dids = (count) =>
    Array.from(
      { length: count },
      (_, i) => `did:plc:${String(i).padStart(24, '0')}`,
    );
  const short = jetstreamUrl('jetstream.example', dids(150), null);
  assert.equal(new URL(short).searchParams.getAll('dids').length, 150);
  assert.ok(short.length < 8_000, 'the public hosts refuse about 8 KB and up');
  const long = new URL(jetstreamUrl('jetstream.example', dids(151), '7'));
  assert.equal(long.searchParams.has('dids'), false);
  assert.equal(long.searchParams.get('cursor'), '7');
  assert.deepEqual(long.searchParams.getAll('kinds'), ['commit']);
});

test('with a long list, only listed accounts are kept and the cursor still moves', () => {
  const r = rig({
    accounts: Array.from({ length: 200 }, (_, i) => ({
      did: i === 0 ? SYNTHETIC_DID : `did:plc:listed${i}`,
      source_type: 'social_claim',
    })),
  });
  r.adapter.start();
  assert.equal(new URL(r.sockets.last().url).searchParams.has('dids'), false);
  r.sockets.last().open();
  for (let i = 0; i < 50; i++)
    r.sockets
      .last()
      .frame(postFrame({ did: SYNTHETIC_DID_2, seq: i + 1, rkey: `s${i}` }));
  r.timers.run();
  assert.equal(
    r.intake.cursor('bluesky'),
    '50',
    'no replay of everything after a drop',
  );
  assert.equal(r.intake.counters().bluesky?.received ?? 0, 0);
  assert.equal(r.intake.counters().bluesky?.skip_unlisted_account, undefined);
  r.sockets.last().frame(postFrame({ seq: 51, rkey: 'mine' }));
  assert.equal(r.settle().length, 1);
});

test('a refused connection says so, even with an empty error', () => {
  const r = rig();
  r.adapter.start();
  r.sockets.last().onerror({ message: '' });
  r.sockets.last().drop(1006);
  assert.equal(r.adapter.health().last_error, 'connection failed');
});

test('a close event arriving after shutdown cannot stop the server', () => {
  const r = rig();
  r.adapter.start();
  const socket = r.sockets.last();
  socket.open();
  socket.frame(postFrame({ seq: 1 }));
  // close() answers at once on the fake; a real socket answers later.
  socket.close = () => {};
  r.adapter.stop();
  r.intake.close();
  assert.doesNotThrow(() => socket.onclose({ code: 1000 }));
  assert.doesNotThrow(() => socket.frame(postFrame({ seq: 2, rkey: 'late' })));
});

test('a failing queue is reported, never thrown into the server', () => {
  const r = rig();
  r.adapter.start();
  r.sockets.last().open();
  r.intake.enqueue = () => {
    throw new Error('database or disk is full');
  };
  r.sockets.last().frame(postFrame({ seq: 1 }));
  assert.doesNotThrow(() => r.timers.run());
  assert.equal(r.adapter.health().last_error, 'database or disk is full');
  assert.doesNotThrow(() => r.sockets.last().drop(1006));
});

test('publication time: a post cannot make itself look newer', () => {
  const stream = '2026-10-31T03:20:00.000Z';
  const seen = Date.parse(stream);
  assert.equal(
    publicationTime(stream, '2026-10-31T03:19:59.000Z').published_at,
    seen - 1000,
  );
  assert.equal(
    publicationTime(stream, '2030-01-01T00:00:00.000Z').published_at,
    seen,
    'future claim',
  );
  assert.equal(
    publicationTime(stream, '2030-01-01T00:00:00.000Z').suspect,
    true,
  );
  assert.equal(
    publicationTime(stream, '2021-01-01T00:00:00.000Z').published_at,
    Date.parse('2021-01-01T00:00:00.000Z'),
    'an import stays old',
  );
  assert.equal(publicationTime(stream, 'nonsense').published_at, seen);
});

test('backoff: capped, growing, jittered', () => {
  assert.equal(
    backoffMs(0, () => 0),
    500,
  );
  assert.equal(
    backoffMs(0, () => 1),
    1000,
  );
  assert.ok(backoffMs(3, () => 1) > backoffMs(1, () => 1));
  assert.equal(
    backoffMs(40, () => 1),
    300_000,
  );
});

test('1: a pushed post is stored, timestamped and reaches the engine once', () => {
  const r = rig();
  r.adapter.start();
  r.sockets.last().open();
  r.sockets.last().frame(postFrame({ seq: 1000 }));
  const [event] = r.settle();
  assert.equal(event.verification, 'unverified');
  assert.equal(event.category, 'armed_conflict');
  assert.equal(event.location.place, 'Kharkiv');
  assert.equal(fastStatus(event), 'provisional');
  assert.equal(event.published_at, undefined, 'times live on the observation');
  const [observation] = r.store.observationsFor(event.event_id);
  assert.equal(
    observation.published_at,
    Date.parse('2026-10-31T03:19:59.000Z'),
  );
  assert.equal(observation.received_at, T0);
  assert.equal(observation.occurred_at, null, 'when it happened stays unknown');
  assert.equal(observation.source_type, 'social_claim');
  assert.equal(observation.publisher, `bsky:${SYNTHETIC_DID}`);
  const latency = r.latency.summary().bluesky;
  assert.equal(latency.publish_to_receive.p50_ms, 5_000);
  assert.equal(latency.receive_to_event.samples, 1);
});

test('3: an imported old post does not become a new event on the map', () => {
  const r = rig();
  r.adapter.start();
  r.sockets.last().open();
  r.sockets.last().frame(postFrame({ createdAt: '2024-03-01T00:00:00.000Z' }));
  assert.equal(r.settle().length, 0);
});

test('2: posts arriving out of order keep their own times', () => {
  const r = rig();
  r.adapter.start();
  r.sockets.last().open();
  r.sockets.last().frame(
    postFrame({
      seq: 1,
      rkey: 'late',
      did: SYNTHETIC_DID_2,
      time: '2026-10-31T03:20:03.000Z',
      createdAt: '2026-10-31T03:20:02.000Z',
      text: 'Explosions in Kharkiv centre, second account',
    }),
  );
  r.sockets.last().frame(
    postFrame({
      seq: 2,
      rkey: 'early',
      time: '2026-10-31T03:15:00.000Z',
      createdAt: '2026-10-31T03:14:59.000Z',
      text: 'Explosions in Kharkiv centre, first account',
    }),
  );
  const [event] = r.settle();
  const times = r.store
    .observationsFor(event.event_id)
    .map((o) => o.published_at)
    .sort();
  assert.deepEqual(times, [
    Date.parse('2026-10-31T03:14:59.000Z'),
    Date.parse('2026-10-31T03:20:02.000Z'),
  ]);
  assert.equal(event.verification, 'corroborated');
});

test('10: an outage resumes from the cursor; a replay adds nothing and loses nothing', () => {
  const r = rig();
  r.adapter.start();
  r.sockets.last().open();
  r.sockets
    .last()
    .frame(
      postFrame({ seq: 100, rkey: 'a', text: 'Explosions in Kharkiv, first' }),
    );
  r.timers.run();
  r.sockets.last().drop(1006);
  assert.equal(r.adapter.health().connected, false);
  r.timers.run();
  assert.equal(new URL(r.sockets.last().url).searchParams.get('cursor'), '100');
  r.sockets.last().open();
  // The cursor is inclusive: event 100 comes again, then what was missed.
  r.sockets
    .last()
    .frame(
      postFrame({ seq: 100, rkey: 'a', text: 'Explosions in Kharkiv, first' }),
    );
  r.sockets.last().frame(
    postFrame({
      seq: 101,
      rkey: 'b',
      did: SYNTHETIC_DID_2,
      text: 'Blasts shake Kharkiv this evening',
    }),
  );
  const events = r.settle();
  assert.equal(events.length, 1);
  assert.equal(r.store.observationsFor(events[0].event_id).length, 2);
  const counters = r.intake.counters().bluesky;
  assert.equal(counters.received, 2);
  assert.equal(counters.replayed, 1);
  assert.equal(r.adapter.health().reconnects, 1);
});

test('19: a restart resumes from the stored cursor', () => {
  const r = rig();
  r.adapter.start();
  r.sockets.last().open();
  r.sockets.last().frame(postFrame({ seq: 777 }));
  r.timers.run();
  r.adapter.stop();
  const again = createBlueskyAdapter({
    accounts: () => r.list,
    intake: r.intake,
    canonical: canonicalLink,
    WebSocketImpl: r.sockets.FakeSocket,
    log: () => {},
  });
  again.start();
  assert.equal(new URL(r.sockets.last().url).searchParams.get('cursor'), '777');
  again.stop();
});

test('a cursor the stream refuses is dropped, and the possible gap is reported', () => {
  const r = rig();
  r.intake.setCursor('bluesky', '5');
  r.adapter.start();
  for (let attempt = 0; attempt < 4; attempt++) {
    r.sockets.last().drop(1006);
    r.timers.run();
  }
  r.sockets.last().open();
  assert.equal(new URL(r.sockets.last().url).searchParams.has('cursor'), false);
  assert.equal(r.intake.counters().bluesky.cursor_abandoned, 1);
  assert.equal(r.adapter.health().status, 'healthy');
});

test('nothing on the account list opens no connection', () => {
  const r = rig({ accounts: [] });
  r.adapter.start();
  assert.equal(r.sockets.sockets.length, 0);
  assert.equal(r.adapter.health().status, 'needs_sources');
});

test('an unlisted account in the stream is not kept', () => {
  const r = rig({
    accounts: [{ did: SYNTHETIC_DID_2, source_type: 'social_claim' }],
  });
  r.adapter.start();
  r.sockets.last().open();
  r.sockets.last().frame(postFrame({ did: SYNTHETIC_DID }));
  assert.equal(r.settle().length, 0);
  assert.equal(r.intake.counters().bluesky?.received ?? 0, 0);
});

test('replies and text-free posts are not reports', () => {
  const r = rig();
  r.adapter.start();
  r.sockets.last().open();
  r.sockets
    .last()
    .frame(postFrame({ seq: 1, reply: { root: {}, parent: {} } }));
  r.sockets.last().frame(postFrame({ seq: 2, rkey: 'x', text: '   ' }));
  assert.equal(r.settle().length, 0);
});

test('3 and 4: a shared article, however linked, is one origin', () => {
  const r = rig();
  r.adapter.start();
  r.sockets.last().open();
  const embed = (uri) => ({
    embed: { $type: 'app.bsky.embed.external', external: { uri } },
  });
  r.sockets.last().frame(
    postFrame({
      seq: 1,
      rkey: 'a',
      text: 'Explosions in Kharkiv say officials',
      ...embed('https://example.com/report?utm_source=x'),
    }),
  );
  r.sockets.last().frame(
    postFrame({
      seq: 2,
      rkey: 'b',
      did: SYNTHETIC_DID_2,
      text: 'Blasts in Kharkiv tonight, very worrying',
      ...embed('http://www.example.com/report'),
    }),
  );
  const [event] = r.settle();
  assert.equal(event.lineages.length, 1);
  assert.equal(event.verification, 'unverified');
});

test('3: a quote post is not an independent source', () => {
  const r = rig();
  r.adapter.start();
  r.sockets.last().open();
  r.sockets.last().frame(
    postFrame({
      seq: 1,
      rkey: 'orig',
      text: 'Explosions in Kharkiv reported now',
    }),
  );
  r.sockets.last().frame(
    postFrame({
      seq: 2,
      rkey: 'quote',
      did: SYNTHETIC_DID_2,
      text: 'Terrible, explosions in Kharkiv tonight',
      embed: {
        $type: 'app.bsky.embed.record',
        record: { uri: `at://${SYNTHETIC_DID}/app.bsky.feed.post/orig` },
      },
    }),
  );
  const [event] = r.settle();
  assert.equal(event.verification, 'unverified');
});

test('5: two independent accounts with different words correlate', () => {
  const r = rig();
  r.adapter.start();
  r.sockets.last().open();
  r.sockets
    .last()
    .frame(
      postFrame({ seq: 1, rkey: 'a', text: 'Explosions heard in Kharkiv' }),
    );
  r.sockets.last().frame(
    postFrame({
      seq: 2,
      rkey: 'b',
      did: SYNTHETIC_DID_2,
      text: 'В Харькове прогремел мощный взрыв',
    }),
  );
  const events = r.settle();
  assert.equal(events.length, 1);
  assert.equal(events[0].verification, 'corroborated');
  assert.equal(fastStatus(events[0]), 'corroborated');
});

test('6: like incidents in nearby towns stay apart', () => {
  const r = rig();
  r.adapter.start();
  r.sockets.last().open();
  r.sockets
    .last()
    .frame(
      postFrame({ seq: 1, rkey: 'a', text: 'Explosions heard in Kharkiv' }),
    );
  r.sockets.last().frame(
    postFrame({
      seq: 2,
      rkey: 'b',
      did: SYNTHETIC_DID_2,
      text: 'Explosions heard in Belgorod',
    }),
  );
  assert.equal(r.settle().length, 2);
});

test('7: a country-only claim gets no point; nothing the post states adds one', () => {
  const r = rig();
  r.adapter.start();
  r.sockets.last().open();
  r.sockets.last().frame(
    postFrame({
      text: 'Fuel shortage spreading across Lebanon',
      location: { lat: 1, lon: 2 },
    }),
  );
  const [event] = r.settle();
  assert.equal(event.location.lat, null);
  assert.equal(event.location.region_code, 'LB');
  assert.equal(event.confidence, 0.2);
});

test('8: a source correcting itself retracts; someone else only disputes', () => {
  const own = rig();
  own.adapter.start();
  own.sockets.last().open();
  own.sockets.last().frame(
    postFrame({
      seq: 1,
      rkey: 'a',
      text: 'Explosions heard in Kharkiv centre',
    }),
  );
  own.settle();
  own.sockets.last().frame(
    postFrame({
      seq: 2,
      rkey: 'b',
      text: 'Correction: no explosions in Kharkiv centre, it was fireworks',
    }),
  );
  assert.equal(own.settle().length, 0, 'retracted');

  const other = rig();
  other.adapter.start();
  other.sockets.last().open();
  other.sockets.last().frame(
    postFrame({
      seq: 1,
      rkey: 'a',
      text: 'Explosions heard in Kharkiv centre',
    }),
  );
  other.settle();
  other.sockets.last().frame(
    postFrame({
      seq: 2,
      rkey: 'b',
      did: SYNTHETIC_DID_2,
      text: 'That explosion in Kharkiv was debunked, fake news',
    }),
  );
  const [event] = other.settle();
  assert.equal(fastStatus(event), 'contested');
  assert.equal(event.camera_eligible, false);
});

test('23: an edit updates the record; a delete withdraws it, words and all', () => {
  const r = rig();
  r.adapter.start();
  r.sockets.last().open();
  r.sockets.last().frame(
    postFrame({
      seq: 1,
      rkey: 'a',
      text: 'Explosions heard in Kharkiv centre',
    }),
  );
  r.sockets.last().frame(
    postFrame({
      seq: 2,
      rkey: 'a',
      operation: 'update',
      cid: 'bafyedit',
      text: 'Explosions heard in Kharkiv centre, windows broken',
    }),
  );
  const [event] = r.settle();
  assert.equal(r.store.observationsFor(event.event_id).length, 2);
  r.sockets.last().frame(deleteFrame({ seq: 3, rkey: 'a' }));
  assert.equal(r.settle().length, 0, 'withdrawn with its only source');
  const held = r.store.observationsFor(event.event_id);
  assert.ok(held.every((o) => o.withdrawn && !o.summary));
  assert.equal(r.engine.getEvent(event.event_id).verification, 'retracted');
  assert.equal(r.intake.counters().bluesky.deleted, 1);
});

test('12: malformed, oversized and hostile frames are contained', () => {
  const r = rig();
  r.adapter.start();
  r.sockets.last().open();
  r.sockets.last().frame('{not json');
  r.sockets.last().frame(`"${'x'.repeat(300_000)}"`);
  r.sockets.last().frame({ payload: null });
  r.sockets.last().frame({ payload: { $type: 'x#commit', did: 'nonsense' } });
  r.sockets.last().frame({
    $type: 'message',
    payload: {
      $type: 'x#commit',
      collection: 'app.bsky.feed.post',
      did: SYNTHETIC_DID,
      rkey: '../../etc',
      seq: 5,
    },
  });
  r.sockets
    .last()
    .frame({ $type: 'error', error: 'ConsumerTooSlow', message: 'x' });
  r.sockets.last().frame(
    postFrame({
      seq: 9,
      text: '<img src=x onerror=alert(1)> explosions in Kharkiv',
    }),
  );
  const [event] = r.settle();
  assert.ok(!event.title.includes('<img'));
  const counters = r.intake.counters().bluesky;
  assert.equal(counters.dead_lettered, 2);
  assert.equal(r.intake.deadLetters().length, 2);
  assert.equal(r.adapter.health().last_error, 'ConsumerTooSlow');
});

test('a post that breaks the engine never blocks the next one', () => {
  const r = rig();
  const real = r.engine.ingest;
  let calls = 0;
  const pipeline = createPipeline({
    intake: r.intake,
    latency: r.latency,
    log: () => {},
    now: r.now,
    engine: {
      ...r.engine,
      ingest(...args) {
        calls += 1;
        if (calls === 1) throw new Error('boom');
        return real(...args);
      },
    },
  });
  r.adapter.start();
  r.sockets.last().open();
  r.sockets.last().frame(postFrame({ seq: 1, rkey: 'a' }));
  r.sockets.last().frame(
    postFrame({
      seq: 2,
      rkey: 'b',
      did: SYNTHETIC_DID_2,
      text: 'Second report: tornado hits Kyiv',
    }),
  );
  r.timers.run();
  pipeline.pass();
  assert.equal(r.engine.activeEvents(r.now()).length, 1);
  assert.equal(r.intake.counters().bluesky.dead_lettered, 1);
});

test('13: a 10,000-message flood stays bounded, counted and fair', () => {
  const r = rig({ intakeOptions: { maxPending: 2_000 } });
  r.adapter.start();
  r.sockets.last().open();
  const started = performance.now();
  for (let i = 0; i < 10_000; i++)
    r.sockets.last().frame(
      postFrame({
        seq: i + 1,
        rkey: `flood${i}`,
        text: `Flood message ${i}: nothing to see`,
      }),
    );
  r.timers.run();
  const { pending, max_pending: maxPending } = r.intake.stats();
  assert.ok(pending <= maxPending, `${pending} waiting`);
  const counters = r.intake.counters().bluesky;
  assert.equal(counters.received + counters.dropped, 10_000);
  assert.ok(counters.dropped >= 8_000, 'overflow is visible');
  // A higher-priority account still gets in while the queue is full.
  const official = createBlueskyAdapter({
    id: 'official-source',
    accounts: () => [
      {
        did: SYNTHETIC_DID_3,
        source_type: 'primary_official',
        tag: 'official',
      },
    ],
    intake: r.intake,
    canonical: canonicalLink,
    WebSocketImpl: r.sockets.FakeSocket,
    log: () => {},
    setTimer: r.timers.setTimer,
    clearTimer: r.timers.clearTimer,
  });
  official.start();
  r.sockets.last().open();
  r.sockets.last().frame(
    postFrame({
      did: SYNTHETIC_DID_3,
      seq: 1,
      rkey: 'real',
      text: 'Official: tsunami warning for Hilo',
    }),
  );
  r.timers.run();
  assert.equal(r.intake.counters()['official-source'].received, 1);
  const first = r.intake.next(10);
  assert.equal(first[0].source_id, 'official-source', 'served first');
  while (r.pipeline.pass()) {
    /* drain */
  }
  assert.equal(r.intake.stats().pending, 0);
  assert.ok(performance.now() - started < 30_000);
});

test('one account cannot fill the queue', () => {
  const r = rig({ pipelineOptions: { accountPostsPerMinute: 3 } });
  r.adapter.start();
  r.sockets.last().open();
  for (let i = 0; i < 10; i++)
    r.sockets.last().frame(
      postFrame({
        seq: i + 1,
        rkey: `r${i}`,
        text: `Explosions in Kharkiv, update number ${i}`,
      }),
    );
  r.settle();
  assert.equal(r.intake.counters().bluesky.deferred, 7);
});

test('intake: idempotent on source, id and revision; a new revision is new', () => {
  const r = rig();
  const report = { native_id: 'x', revision: 'r1', received_at: T0, text: 't' };
  assert.equal(r.intake.enqueue('s', [report]).accepted, 1);
  assert.equal(r.intake.enqueue('s', [report]).duplicate, 1);
  assert.equal(
    r.intake.enqueue('s', [{ ...report, revision: 'r2' }]).accepted,
    1,
  );
  assert.equal(r.intake.enqueue('other', [report]).accepted, 1);
});

test('intake: the cursor is stored with the reports, or not at all', () => {
  const r = rig();
  assert.throws(() =>
    r.intake.enqueue(
      's',
      [{ native_id: 'x', received_at: T0 }, { received_at: T0 }],
      { cursor: 9 },
    ),
  );
  assert.equal(r.intake.stats().pending, 0);
  assert.equal(r.intake.cursor('s'), null, 'rolled back together');
});

test('intake: raw text leaves after retention; waiting work does not', () => {
  const r = rig({ intakeOptions: { rawRetentionDays: 7 } });
  r.intake.enqueue('s', [{ native_id: 'old', received_at: T0, text: 't' }]);
  r.intake.complete(r.intake.next(1)[0].seq, { status: 'filtered' });
  r.intake.enqueue('s', [{ native_id: 'waiting', received_at: T0, text: 't' }]);
  assert.equal(r.intake.prune(T0 + 8 * 24 * 3600_000), 1);
  assert.equal(r.intake.stats().pending, 1);
});

test('latency: only real measurements, and a skewed clock adds none', () => {
  const book = createLatencyBook({ window: 4 });
  book.record('s', 'x', -5);
  book.record('s', 'x', Number.NaN);
  assert.deepEqual(book.summary(), {});
  for (const ms of [10, 20, 30, 40, 50]) book.record('s', 'x', ms);
  assert.deepEqual(book.summary().s.x, {
    samples: 4,
    p50_ms: 30,
    p95_ms: 50,
    max_ms: 50,
  });
  assert.equal(percentile([], 0.5), null);
});
