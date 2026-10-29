import test from 'node:test';
import assert from 'node:assert/strict';
import { clusterEvents } from './clustering.js';
import { frameCluster, heightForRadius, minHalfFov } from './framing.js';
import {
  createSchedulerState,
  setSchedulerMode,
  stepScheduler,
} from './scheduler.js';

const T0 = Date.parse('2026-10-29T00:00:00Z');
const SEC = 1000;
const MIN = 60 * SEC;
const settings = {
  minimumDwellMs: 30 * SEC,
  repeatFocusCooldownMs: 30 * MIN,
  preemptionConfirmMs: 10 * SEC,
  normalPreemptionMargin: 15,
  criticalInterruptThreshold: 95,
  minimumAttentionScore: 70,
};

const event = (id, lat, lon, score, extra = {}) => ({
  event_id: id,
  attention_score: score,
  camera_eligible: true,
  critical_qualified: false,
  revision: 1,
  location: { lat, lon, precision: 'city', region_code: null },
  ...extra,
});

function run(events, steps, start = createSchedulerState()) {
  let state = setSchedulerMode(start, 'auto');
  const log = [];
  for (const { at, update } of steps) {
    const current = update ? update(events) : events;
    const out = stepScheduler(state, {
      now: T0 + at,
      events: current,
      clusters: clusterEvents(
        current.filter((e) => e.camera_eligible),
        { diameterKm: 800 },
      ),
      settings,
    });
    state = out.state;
    log.push({
      at,
      ...out.decision,
      key: out.decision.cluster?.event_ids.join('+'),
    });
  }
  return { state, log };
}

const every = (ms, n) => Array.from({ length: n }, (_, i) => ({ at: i * ms }));

test('A01: one eligible event is flown to once and held', () => {
  const { log } = run([event('a', 38, 142, 90)], every(5 * SEC, 10));
  assert.deepEqual(
    log.map((d) => d.type),
    ['fly', ...Array(9).fill('hold')],
  );
});

test('below-threshold events never take the camera; idle happens once', () => {
  const { log } = run([event('a', 38, 142, 60)], every(5 * SEC, 4));
  assert.deepEqual(
    log.map((d) => d.type),
    ['idle', 'none', 'none', 'none'],
  );
});

test('A03: distant clusters rotate after the dwell, without returning during cooldown', () => {
  const events = [event('tokyo', 35.7, 139.7, 85), event('lima', -12, -77, 80)];
  const { log } = run(events, every(10 * SEC, 13));
  const flights = log.filter((d) => d.type === 'fly').map((d) => [d.at, d.key]);
  assert.deepEqual(flights, [
    [0, 'tokyo'],
    [30 * SEC, 'lima'],
  ]);
});

test('A08: close scores alternating 79/82 do not oscillate', () => {
  let flip = false;
  const steps = every(5 * SEC, 60).map((s) => ({
    ...s,
    update: (events) => {
      flip = !flip;
      return events.map((e) =>
        e.event_id === 'a'
          ? { ...e, attention_score: flip ? 79 : 82 }
          : { ...e, attention_score: flip ? 82 : 79 },
      );
    },
  }));
  const { log } = run([event('a', 10, 10, 80), event('b', 50, 100, 80)], steps);
  const flights = log.filter((d) => d.type === 'fly');
  assert.equal(
    flights.length,
    2,
    JSON.stringify(flights.map((f) => [f.at, f.key])),
  );
  assert.ok(flights[1].at >= 30 * SEC, 'no switch before the dwell');
});

test('preemption needs the margin and a confirmation interval', () => {
  const steps = [
    { at: 0 },
    ...[35, 40, 45, 50].map((s) => ({
      at: s * SEC,
      update: (events) => [...events, event('big', -33, -71, 99)],
    })),
  ];
  const { log } = run([event('a', 10, 10, 80)], steps);
  // At 35 s the challenger appears: it outranks by ≥ 15 but must hold 10 s.
  assert.deepEqual(
    log.map((d) => [d.at / SEC, d.type, d.reason]),
    [
      [0, 'fly', 'highest_priority'],
      [35, 'hold', 'confirming_challenger'],
      [40, 'hold', 'confirming_challenger'],
      [45, 'fly', 'clearly_higher_priority'],
      [50, 'hold', 'minimum_dwell'],
    ],
  );
});

test('A09: a qualified critical event interrupts a dwell once; an unqualified one cannot', () => {
  const critical = (qualified) => (events) => [
    ...events,
    event('crit', -33, -71, 97, { critical_qualified: qualified }),
  ];
  const interrupted = run(
    [event('a', 10, 10, 80)],
    [{ at: 0 }, { at: 8 * SEC, update: critical(true) }],
  ).log;
  assert.equal(interrupted[1].type, 'fly');
  assert.equal(interrupted[1].reason, 'critical_interrupt');
  const refused = run(
    [event('a', 10, 10, 80)],
    [{ at: 0 }, { at: 8 * SEC, update: critical(false) }],
  ).log;
  assert.equal(refused[1].type, 'hold', 'A10: score alone cannot interrupt');
});

test('A11: pausing stops decisions until the operator resumes', () => {
  let { state } = run([event('a', 10, 10, 90)], [{ at: 0 }]);
  state = setSchedulerMode(state, 'paused', 'manual_input');
  const paused = stepScheduler(state, {
    now: T0 + 60 * MIN,
    events: [event('b', 50, 50, 99)],
    clusters: clusterEvents([event('b', 50, 50, 99)]),
    settings,
  });
  assert.equal(paused.decision.type, 'none');
  assert.equal(paused.state.pauseReason, 'manual_input');
  const resumed = stepScheduler(setSchedulerMode(paused.state, 'auto'), {
    now: T0 + 61 * MIN,
    events: [event('b', 50, 50, 99)],
    clusters: clusterEvents([event('b', 50, 50, 99)]),
    settings,
  });
  assert.equal(resumed.decision.type, 'fly');
});

test('cooldown applies only to what was shown, and a material revision lifts it', () => {
  const steps = [
    { at: 0 },
    { at: 35 * SEC },
    { at: 2 * MIN, update: (events) => [{ ...events[0], revision: 2 }] },
  ];
  const { log } = run([event('a', 10, 10, 90)], steps);
  assert.deepEqual(
    log.map((d) => d.type),
    ['fly', 'hold', 'hold'],
    'still the current shot: no re-flight',
  );
  // After moving away, a revision makes it eligible again before cooldown.
  const away = run(
    [event('a', 10, 10, 90), event('b', 60, 60, 85)],
    [
      { at: 0 },
      { at: 31 * SEC },
      {
        at: 70 * SEC,
        update: (events) => [{ ...events[0], revision: 2 }, events[1]],
      },
    ],
  ).log;
  assert.deepEqual(
    away.map((d) => d.key),
    ['a', 'b', 'a'],
  );
});

test('a revision that lands while on screen does not re-interrupt later', () => {
  const crit = (revision) =>
    event('crit', -33, -71, 97, { critical_qualified: true, revision });
  const { log } = run(
    [event('a', 10, 10, 80)],
    [
      { at: 0 },
      { at: 8 * SEC, update: (events) => [...events, crit(1)] },
      { at: 15 * SEC, update: (events) => [...events, crit(2)] },
      {
        at: 45 * SEC,
        update: (events) => [...events, crit(2), event('b', 50, 50, 85)],
      },
      {
        at: 50 * SEC,
        update: (events) => [...events, crit(2), event('b', 50, 50, 85)],
      },
    ],
  );
  assert.deepEqual(
    log.map((d) => [d.at / SEC, d.type, d.key]),
    [
      [0, 'fly', 'a'],
      [8, 'fly', 'crit'],
      [15, 'hold', undefined],
      [45, 'fly', 'b'],
      [50, 'hold', undefined],
    ],
  );
});

test('a rank change inside the cluster on screen keeps the same shot', () => {
  const { log } = run(
    [event('a', 10, 10, 90), event('b', 10.5, 10.5, 80)],
    [
      { at: 0 },
      {
        at: 40 * SEC,
        update: (events) => [events[0], { ...events[1], attention_score: 95 }],
      },
    ],
  );
  assert.deepEqual(
    log.map((d) => d.type),
    ['fly', 'hold'],
  );
});

test('fairness: a waiting cluster eventually beats a slightly higher unshown one', () => {
  const events = [
    event('a', 10, 10, 90),
    event('b', 40, 100, 80),
    event('c', -30, -60, 78),
  ];
  const { log } = run(events, every(30 * SEC, 4));
  assert.deepEqual(
    log.filter((d) => d.type === 'fly').map((d) => d.key),
    ['a', 'b', 'c'],
  );
});

test('A19: a long gap (hidden tab) produces one decision, not a backlog', () => {
  const events = [event('a', 10, 10, 90), event('b', 60, 60, 85)];
  const { log } = run(events, [{ at: 0 }, { at: 3 * 3600 * SEC }]);
  assert.equal(log.length, 2);
  assert.equal(log[1].type, 'fly');
});

test('framing: a single event uses the precision floor; a group fits its radius', () => {
  const half = minHalfFov(Math.PI / 3, 16 / 9);
  assert.ok(half < Math.PI / 6);
  const [single] = clusterEvents([event('a', 44.8, 20.4, 80)]);
  assert.equal(frameCluster(single, { precisions: ['city'] }).height, 80_000);
  // A02: Belgrade–Skopje, 322 km apart, both inside the padded view.
  const [pair] = clusterEvents([
    event('bg', 44.81, 20.46, 80),
    event('sk', 42.0, 21.43, 75),
  ]);
  const shot = frameCluster(pair, { precisions: ['city'] });
  assert.equal(shot.kind, 'group');
  const needed = heightForRadius(pair.radius_km, half);
  assert.ok(shot.height > needed, `${shot.height} > ${needed}`);
  assert.ok(shot.height < 2_000_000, 'not an absurd global fit');
});

test('framing: antimeridian group centres near 180°; region needs bounds', () => {
  const [fiji] = clusterEvents([
    event('e', -16.85, 179.95, 80),
    event('w', -17.25, -178.95, 78),
  ]);
  const shot = frameCluster(fiji);
  assert.ok(Math.abs(Math.abs(shot.lon) - 180) < 1, String(shot.lon));
  const region = { framing: 'region', event_ids: ['r'], bounds: null };
  assert.equal(frameCluster(region), null);
  const argentina = frameCluster({
    framing: 'region',
    event_ids: ['r'],
    bounds: { west: -73.6, south: -55.1, east: -53.6, north: -21.8 },
  });
  assert.equal(argentina.kind, 'region');
  assert.ok(argentina.height > 2_000_000);
});

// ---------------------------------------------------------------- tour
const cooling = (id, lat, lon, score, extra = {}) =>
  event(id, lat, lon, score, {
    lifecycle: 'cooling',
    camera_eligible: false,
    confidence: 0.85,
    verification: 'officially_reported',
    category: 'natural_disaster',
    ...extra,
  });

function runTour(events, steps, tourSettings = {}) {
  let state = setSchedulerMode(createSchedulerState(), 'auto');
  const log = [];
  for (const { at, update } of steps) {
    const current = update ? update(events) : events;
    const out = stepScheduler(state, {
      now: T0 + at,
      events: current,
      clusters: clusterEvents(
        current.filter((e) => e.camera_eligible && e.attention_score >= 70),
      ),
      settings: {
        ...settings,
        tourWhenIdle: true,
        tourDwellMs: 45 * SEC,
        ...tourSettings,
      },
    });
    state = out.state;
    log.push({
      at,
      ...out.decision,
      key: out.decision.cluster?.event_ids.join('+'),
    });
  }
  return { state, log };
}

const quiet = [
  cooling('a', 10, 10, 55),
  cooling('b', -30, 140, 50),
  cooling('c', 50, -100, 45),
];

test('tour: with nothing urgent, every active event is visited once before any repeats', () => {
  const { log } = runTour(quiet, every(15 * SEC, 13));
  const stops = log
    .filter((d) => d.type === 'fly')
    .map((d) => [d.at / SEC, d.key, d.reason]);
  assert.deepEqual(stops, [
    [0, 'a', 'tour'],
    [45, 'b', 'tour'],
    [90, 'c', 'tour'],
    [135, 'a', 'tour'],
    [180, 'b', 'tour'],
  ]);
});

test('tour: a qualifying alert takes over at once, and touring never hid it', () => {
  const alert = (events) => [
    ...events.filter((e) => e.event_id !== 'a'),
    event('a', 10, 10, 90, { lifecycle: 'active', confidence: 0.85 }),
  ];
  const { log } = runTour(quiet, [
    { at: 0 }, // tour visits a
    { at: 10 * SEC, update: alert }, // a becomes an alert while on screen
  ]);
  assert.deepEqual(
    log.map((d) => [d.type, d.reason, d.key]),
    [
      ['fly', 'tour', 'a'],
      ['fly', 'highest_priority', 'a'],
    ],
  );
});

test('tour: after an alert dwell with nothing else urgent, it tours on instead of freezing', () => {
  const events = [
    event('alert', 0, 0, 90, { lifecycle: 'active', confidence: 0.85 }),
    ...quiet,
  ];
  const { log } = runTour(events, [{ at: 0 }, { at: 31 * SEC }]);
  assert.deepEqual(
    log.map((d) => [d.reason, d.key]),
    [
      ['highest_priority', 'alert'],
      ['tour', 'a'],
    ],
  );
});

test('tour: off means one still global view, as before', () => {
  const { log } = runTour(quiet, every(15 * SEC, 3), { tourWhenIdle: false });
  assert.deepEqual(
    log.map((d) => d.type),
    ['idle', 'none', 'none'],
  );
});

test('tour: retracted, low-confidence, filtered, weak and unlocated events are skipped', () => {
  const skipped = [
    cooling('r', 1, 1, 80, { verification: 'retracted' }),
    cooling('d', 2, 2, 80, { verification: 'disputed' }),
    cooling('low', 3, 3, 80, { confidence: 0.2 }),
    cooling('cat', 4, 4, 80, { category: 'civil_unrest' }),
    cooling('weak', 5, 5, 20),
    cooling('nowhere', null, null, 80),
    cooling('archived', 6, 6, 80, { lifecycle: 'archived' }),
  ];
  const { log } = runTour(skipped, every(15 * SEC, 2), {
    categoryRelevance: { civil_unrest: 0 },
  });
  assert.deepEqual(
    log.map((d) => d.type),
    ['idle', 'none'],
  );
});
