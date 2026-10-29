import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFeedRunner, feedStatus, nextDelayMs } from './feeds.js';
import {
  intelConnectors,
  intelEnabled,
  intelProxy,
  isLocalMutation,
} from './index.js';
import { createIntelService, sanitizeSettings } from './service.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const demo = JSON.parse(
  fs.readFileSync(path.join(here, 'fixtures/demo-scenario.json'), 'utf8'),
);
const T0 = Date.parse('2026-10-29T00:00:00Z');
const MIN = 60_000;

test('A13: feed health distinguishes offline, degraded and stale', () => {
  const connector = { intervalMs: 60_000, staleAfterMs: 3600_000 };
  const base = {
    consecutive_failures: 0,
    last_success_at: T0,
    latest_observation_at: T0,
  };
  assert.equal(feedStatus(base, connector, T0 + MIN), 'healthy');
  assert.equal(
    feedStatus({ ...base, consecutive_failures: 1 }, connector, T0),
    'degraded',
  );
  assert.equal(
    feedStatus({ ...base, consecutive_failures: 3 }, connector, T0),
    'offline',
  );
  assert.equal(feedStatus(base, connector, T0 + 10 * MIN), 'stale');
  assert.equal(
    feedStatus(
      { ...base, latest_observation_at: T0 - 2 * 3600_000 },
      connector,
      T0 + MIN,
    ),
    'stale',
  );
  assert.equal(
    feedStatus({ ...base, disabled: true }, connector, T0),
    'disabled',
  );
  assert.equal(
    feedStatus(base, { ...connector, requiresCredentials: () => true }, T0),
    'requires_credentials',
  );
  assert.equal(nextDelayMs({ consecutive_failures: 2 }, connector), 240_000);
  assert.equal(nextDelayMs({ consecutive_failures: 9 }, connector), 30 * MIN);
});

test('A13: a failing feed reports offline while another keeps ingesting', async () => {
  let now = T0;
  const ingested = [];
  const broken = createFeedRunner({
    connector: {
      id: 'down',
      intervalMs: 60_000,
      poll: async () => {
        throw new Error('ECONNRESET');
      },
    },
    ingest: () => [],
    now: () => now,
    log: () => {},
  });
  const working = createFeedRunner({
    connector: {
      id: 'up',
      intervalMs: 60_000,
      poll: async () => ({ records: [{ x: 1 }], latestObservationAt: now }),
    },
    ingest: (records) => {
      ingested.push(...records);
      return [{ status: 'new_event' }];
    },
    now: () => now,
  });
  for (let i = 0; i < 3; i++) {
    await broken.pollOnce();
    await working.pollOnce();
    now += MIN;
  }
  assert.equal(broken.health().status, 'offline');
  assert.equal(broken.health().last_error, 'ECONNRESET');
  assert.equal(working.health().status, 'healthy');
  assert.equal(ingested.length, 3);
});

test('feed runner sends conditional requests and accepts 304', async () => {
  const seen = [];
  let call = 0;
  const fetchImpl = async (url, init) => {
    seen.push(init.headers['If-None-Match'] ?? null);
    call += 1;
    return call === 1
      ? new Response(JSON.stringify({ ok: 1 }), { headers: { etag: '"v1"' } })
      : new Response(null, { status: 304 });
  };
  const results = [];
  const runner = createFeedRunner({
    connector: {
      id: 'c',
      intervalMs: 1000,
      poll: async ({ fetchJson }) => {
        results.push(await fetchJson('https://feed.example/x'));
        return { records: [] };
      },
    },
    ingest: () => [],
    now: () => T0,
    fetchImpl,
  });
  await runner.pollOnce();
  await runner.pollOnce();
  assert.deepEqual(seen, [null, '"v1"']);
  assert.equal(results[1].notModified, true);
});

test('settings are bounded and unknown keys ignored', () => {
  assert.deepEqual(
    sanitizeSettings({
      minimumAttentionScore: 140,
      groupingRadiusKm: 'x',
      evil: 'rm -rf',
      autopilotEnabled: 'yes',
      categoryRelevance: { civil_unrest: -5, bogus: 3 },
    }),
    { minimumAttentionScore: 100, categoryRelevance: { civil_unrest: 0 } },
  );
});

test('home locations: one per label, rounded to ~1 km, junk dropped', () => {
  assert.deepEqual(
    sanitizeSettings({
      homeLocations: [
        { label: 'family', lat: 52.37021, lon: 4.89517 },
        { label: 'home', lat: -33.8688, lon: 151.2093, address: '1 Secret St' },
        { label: 'home', lat: -33.9, lon: 151.1 },
        { label: 'office', lat: 1, lon: 1 },
        { label: 'travel', lat: 95, lon: 0 },
        null,
      ],
      proximityRadiusKm: 99_999,
      proximityDecayKm: 1,
    }),
    {
      proximityRadiusKm: 5000,
      proximityDecayKm: 25,
      homeLocations: [
        { label: 'home', lat: -33.9, lon: 151.1 },
        { label: 'family', lat: 52.37, lon: 4.9 },
      ],
    },
  );
});

test('pull-back settings are bounded', () => {
  assert.deepEqual(
    sanitizeSettings({
      pullBackEnabled: false,
      pullBackHoldMs: -1,
      pullBackStepMs: 500,
    }),
    { pullBackEnabled: false, pullBackHoldMs: 0, pullBackStepMs: 2_000 },
  );
});

function replayAt(minutes) {
  let now = T0;
  const service = createIntelService({ scenarios: { demo }, now: () => now });
  service.startReplay('demo', { speed: 1 });
  now = T0 + minutes * MIN;
  return service;
}

test('demo replay: copies and reposts collapse; antimeridian pair clusters', () => {
  const service = replayAt(19);
  const { events, clusters } = service.listEvents('replay');
  const lima = events.filter((e) => e.title.includes('Lima'));
  assert.equal(lima.length, 1);
  assert.equal(
    lima[0].lineages.length,
    1,
    'four aggregators copying one wire is one source',
  );
  assert.equal(lima[0].duplicate_count, 10);
  const fiji = clusters.find((c) => c.bounds?.crosses_antimeridian);
  assert.ok(fiji, 'Taveuni and Vanua Balavu cluster across 180°');
  assert.equal(fiji.event_ids.length, 2);
  assert.ok(events.every((e) => e.synthetic));
});

test('demo replay: sensational rumour is held below critical, then retracted', () => {
  const at10 = replayAt(10).listEvents('replay').events;
  const rumour = at10.find((e) => e.title.includes('UNCONFIRMED'));
  assert.ok(rumour.attention_score < 95);
  assert.equal(rumour.verification, 'unverified');
  assert.equal(
    rumour.camera_eligible,
    false,
    'a candidate, never a camera target',
  );
  assert.ok(rumour.evidence_factor < 0.7);
  assert.match(
    rumour.summary,
    /IGNORE PREVIOUS INSTRUCTIONS/,
    'stored as inert text',
  );
  const at26 = replayAt(26).listEvents('replay').events;
  assert.equal(
    at26.find((e) => e.title.includes('missile')),
    undefined,
  );
});

test('A09 data: a corroborated official M8.2 qualifies as critical', () => {
  const { events } = replayAt(22).listEvents('replay');
  const chile = events.find((e) => e.title.includes('Valpara'));
  assert.equal(chile.verification, 'officially_reported');
  assert.equal(chile.critical_qualified, true);
  assert.ok(chile.attention_score >= 95, String(chile.attention_score));
  assert.equal(chile, events[0], 'it ranks first');
});

test('A07 data: quake revision and evacuation link survive in the detail view', () => {
  const service = replayAt(16);
  const quake = service
    .listEvents('replay')
    .events.find((e) => e.subtype === 'earthquake');
  const detail = service.eventDetail('replay', quake.event_id);
  assert.equal(detail.event.metrics.magnitude, 7.1);
  assert.equal(detail.revisions.length, 2);
  assert.equal(detail.event.links[0].relation, 'has_consequence');
  assert.ok(detail.event.explanation.attention.length === 6);
});

test('economic stress keeps official and field channels apart', () => {
  const { events } = replayAt(12).listEvents('replay');
  const official = events.find((e) => e.subtype === 'inflation_shock');
  const field = events.find((e) => e.subtype === 'fuel_shortage');
  assert.ok(official && field);
  assert.notEqual(official.event_id, field.event_id);
  assert.equal(
    official.location.lat,
    null,
    'country-level indicator gets no invented point',
  );
});

test('replay never writes to the live store', () => {
  const service = replayAt(30);
  service.listEvents('replay');
  assert.equal(service.store.stats().events, 0);
});

test('feature flag and mutation guard', async () => {
  assert.equal(intelEnabled({}), false);
  assert.equal(intelEnabled({ GEV_INTEL_ENABLED: '1' }), true);
  const req = (address, headers = {}) => ({
    socket: { remoteAddress: address },
    headers: { host: 'localhost:4174', ...headers },
  });
  assert.equal(isLocalMutation(req('127.0.0.1')), true);
  assert.equal(
    isLocalMutation(req('::1', { origin: 'http://localhost:4174' })),
    true,
  );
  assert.equal(isLocalMutation(req('192.168.0.20')), false);
  assert.equal(
    isLocalMutation(req('127.0.0.1', { origin: 'https://evil.example' })),
    false,
  );
  assert.equal(
    isLocalMutation(req('127.0.0.1', { 'x-forwarded-for': '1.2.3.4' })),
    false,
  );

  const plugin = intelProxy({ env: {} });
  let handler;
  plugin.configureServer({ middlewares: { use: (_p, h) => (handler = h) } });
  const response = await new Promise((resolve) => {
    const res = {
      writeHead(status) {
        this.status = status;
      },
      end(body) {
        resolve({ status: this.status, body: JSON.parse(body) });
      },
    };
    handler({ url: '/status', method: 'GET', headers: {} }, res);
  });
  assert.deepEqual(response, { status: 200, body: { enabled: false } });
});

test('A18: offline mode lists no feed and a full drill makes no network request', async () => {
  assert.deepEqual(intelConnectors({ env: { GEV_INTEL_OFFLINE: '1' } }), []);
  const requests = [];
  let now = T0;
  const service = createIntelService({
    scenarios: { demo },
    connectors: intelConnectors({ env: { GEV_INTEL_OFFLINE: '1' } }),
    now: () => now,
    fetchImpl: async (url) => {
      requests.push(String(url));
      throw new Error('network blocked');
    },
  });
  service.start();
  try {
    service.startReplay('demo', { speed: 1 });
    for (let minute = 0; minute <= 40; minute += 5) {
      now = T0 + minute * MIN;
      service.listEvents('replay');
    }
    assert.ok(service.listEvents('replay').events.length > 3);
    assert.deepEqual(service.feeds(), []);
  } finally {
    service.stop();
  }
  assert.deepEqual(requests, []);
});

test('records older than retention are skipped, not re-ingested every restart', async () => {
  const ingested = [];
  const runner = createFeedRunner({
    connector: {
      id: 'old-feed',
      provider: 'fixture',
      url: 'https://example.invalid/',
      intervalMs: 60_000,
      staleAfterMs: 3600_000,
      poll: async () => ({
        records: [
          { source_item_id: 'old', occurred_at: T0 - 200 * 24 * 3600_000 },
          { source_item_id: 'new', occurred_at: T0 - 3600_000 },
        ],
      }),
    },
    ingest: (records) => {
      ingested.push(...records);
      return records.map(() => ({ status: 'new_event' }));
    },
    now: () => T0,
    maxRecordAgeMs: 90 * 24 * 3600_000,
  });
  const batch = await runner.pollOnce();
  assert.deepEqual(
    ingested.map((r) => r.source_item_id),
    ['new'],
  );
  assert.equal(batch.outcomes.beyond_retention, 1);
});
