import test from 'node:test';
import assert from 'node:assert/strict';
import { collectionPlan, createAirSeaService, parseBox } from './index.js';

const NOW = Date.UTC(2026, 9, 30, 12, 0, 0);
const sec = (ms) => Math.floor(ms / 1000);
const states = (rows, at = NOW) =>
  JSON.stringify({
    time: sec(at),
    states: rows.map(([hex, lat, lon]) => [
      hex,
      'CS',
      'X',
      sec(at),
      sec(at),
      lon,
      lat,
      10_000,
      false,
      230,
    ]),
  });

function service({ snaps = [], aisRows = [], aisKey = false, clock } = {}) {
  let seq = 0;
  const queue = snaps.map((s) => ({ ...s, seq: ++seq }));
  return createAirSeaService({
    now: () => clock?.value ?? NOW,
    snapshots: (after) => queue.filter((s) => s.seq > after),
    readAisRows: () => aisRows,
    aisConfigured: () => aisKey,
  });
}

test('density counts each aircraft once across the existing feeds and reports coverage', () => {
  const svc = service({
    snaps: [
      {
        provider: 'opensky',
        body: states([
          ['aaa001', 51.47, -0.45],
          ['aaa002', 40.64, -73.78],
        ]),
        receivedAt: NOW,
      },
      {
        provider: 'adsblol-mil',
        body: JSON.stringify({
          now: NOW,
          ac: [{ hex: 'aaa001', lat: 51.48, lon: -0.44, seen_pos: 1 }],
        }),
        receivedAt: NOW,
      },
    ],
  });
  const result = svc.density({
    domain: 'air',
    resolution: 2,
    windowMs: 3600_000,
  });
  assert.equal(result.total, 2);
  assert.equal(result.coverage.level, 'global');
  assert.equal(result.sources.opensky.status, 'healthy');
  assert.equal(result.sources['adsblol-mil'].status, 'healthy');
  assert.ok(result.cells.every((c) => c.ring.length >= 6));
});

test('6/7: no feed means no coverage, and a feed outage is not an empty sky', () => {
  const clock = { value: NOW };
  const svc = service({
    clock,
    snaps: [
      {
        provider: 'opensky',
        body: states([['bbb001', 10, 10]]),
        receivedAt: NOW,
      },
    ],
  });
  assert.equal(
    svc.density({ domain: 'air', windowMs: 3600_000 }).coverage.level,
    'global',
  );
  // Twenty minutes without a new snapshot: the cell is still inside the
  // window, but the answer says the coverage behind it has lapsed.
  clock.value = NOW + 20 * 60_000;
  const later = svc.density({ domain: 'air', windowMs: 3600_000 });
  assert.equal(later.sources.opensky.status, 'stale');
  assert.deepEqual(later.coverage, {
    level: 'none',
    reason: 'feeds_stale_or_down',
  });
  const sea = svc.density({ domain: 'sea', windowMs: 3600_000 });
  assert.deepEqual(sea.coverage, { level: 'none', reason: 'not_configured' });
  assert.equal(sea.sources.aisstream.status, 'unconfigured');
});

test('2/17: vessels come from the shared AIS store; the key never appears in output', () => {
  process.env.AISSTREAM_API_KEY = 'secret-test-key-123';
  try {
    const svc = service({
      aisKey: true,
      aisRows: [
        {
          mmsi: 1,
          lat: -33.85,
          lon: 151.25,
          speed: 10,
          last_position_epoch: sec(NOW - 60_000),
        },
        {
          mmsi: 1,
          lat: -33.86,
          lon: 151.25,
          speed: 10,
          last_position_epoch: sec(NOW - 30_000),
        },
        {
          mmsi: 2,
          lat: -33.9,
          lon: 151.3,
          speed: 0,
          last_position_epoch: sec(NOW - 30_000),
        },
      ],
    });
    const result = svc.density({
      domain: 'sea',
      resolution: 3,
      windowMs: 3600_000,
    });
    assert.equal(result.total, 2);
    assert.equal(result.coverage.level, 'global');
    const text = JSON.stringify([result, svc.sources()]);
    assert.ok(!text.includes('secret-test-key-123'));
  } finally {
    delete process.env.AISSTREAM_API_KEY;
  }
});

test('a corrupt snapshot is counted, not fatal', () => {
  const svc = service({
    snaps: [{ provider: 'opensky', body: '{not json', receivedAt: NOW }],
  });
  const result = svc.density({ domain: 'air', windowMs: 3600_000 });
  assert.equal(result.total, 0);
  assert.equal(result.diagnostics.parse_errors.opensky, 1);
});

test('collection stays within the shared proxies and the anonymous budget', () => {
  assert.deepEqual(
    collectionPlan({}).map((j) => [j.path, j.everyMs]),
    [
      ['/api/flights', 30 * 60_000],
      ['/api/military', 5 * 60_000],
    ],
  );
  assert.equal(
    collectionPlan({ OPENSKY_CLIENT_ID: 'a', OPENSKY_CLIENT_SECRET: 'b' })[0]
      .everyMs,
    5 * 60_000,
  );
  // Credentials the proxy will not use do not buy a faster cadence.
  assert.equal(
    collectionPlan({
      OPENSKY_AUTH_MODE: 'anon',
      OPENSKY_CLIENT_ID: 'a',
      OPENSKY_CLIENT_SECRET: 'b',
    })[0].everyMs,
    30 * 60_000,
  );
  assert.equal(collectionPlan({ AISSTREAM_API_KEY: 'k' }).length, 3);
  assert.deepEqual(collectionPlan({ GEV_AIRSEA_COLLECT: '0' }), []);
  // Every path is this app's own proxy route, never a provider URL.
  for (const job of collectionPlan({ AISSTREAM_API_KEY: 'k' }))
    assert.ok(job.path.startsWith('/api/'));
});

test('view boxes are validated', () => {
  assert.deepEqual(parseBox('170,-30,-170,0'), [170, -30, -170, 0]);
  assert.equal(parseBox('1,2,3'), null);
  assert.equal(parseBox('0,50,10,40'), null);
  assert.equal(parseBox('-400,-10,400,10'), null);
});

test('review: snapshots published while hidden all count, not only the last', async () => {
  const { publishTrafficSnapshot, resetTrafficSnapshots } =
    await import('./bus.js');
  resetTrafficSnapshots();
  const svc = createAirSeaService({
    now: () => NOW,
    readAisRows: () => [],
    aisConfigured: () => false,
  });
  try {
    publishTrafficSnapshot('opensky', {
      body: states([['ccc001', 10, 10]], NOW - 20 * 60_000),
      receivedAt: NOW - 20 * 60_000,
    });
    await new Promise((resolve) => setImmediate(resolve));
    publishTrafficSnapshot('opensky', {
      body: states([['ccc002', 20, 20]]),
      receivedAt: NOW,
    });
    await new Promise((resolve) => setImmediate(resolve));
    const result = svc.density({ domain: 'air', windowMs: 24 * 3600_000 });
    assert.equal(result.total, 2);
  } finally {
    svc.close();
    resetTrafficSnapshots();
  }
});

test('review: staleness allows for the collection cadence', () => {
  const clock = { value: NOW };
  let seq = 0;
  const svc = createAirSeaService({
    now: () => clock.value,
    snapshots: (after) =>
      [
        {
          provider: 'opensky',
          body: states([['ddd001', 10, 10]]),
          receivedAt: NOW,
          seq: 1,
        },
      ].filter((snap) => snap.seq > after && ++seq),
    subscribe: null,
    readAisRows: () => [],
    aisConfigured: () => false,
    cadenceMs: { opensky: 30 * 60_000 },
  });
  // 31 minutes: a scheduled fetch is just due, not a lapsed feed.
  clock.value = NOW + 31 * 60_000;
  const result = svc.density({ domain: 'air', windowMs: 3600_000 });
  assert.equal(result.sources.opensky.status, 'healthy');
  assert.equal(result.collection_ms, 30 * 60_000);
  clock.value = NOW + 46 * 60_000;
  assert.equal(
    svc.density({ domain: 'air', windowMs: 3600_000 }).sources.opensky.status,
    'stale',
  );
});
