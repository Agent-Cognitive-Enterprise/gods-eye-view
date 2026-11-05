// Fork: the regional GNSS screen wired into the air/sea plugin, the AIS ingest
// tap and the Autopilot records. Synthetic envelopes only; no socket is opened.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { airSeaProxy } from './index.js';
import { airSeaRecords } from './signals.js';
import {
  publishRegionalAisPosition,
  tapRegionalAisIngest,
} from './gnssRegionalBus.js';
import { regionalGnssIntelRecords } from './gnssRegionalIntel.js';
import { gridDisk, latLngToCell } from 'h3-js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const utc = (ms) =>
  new Date(ms).toISOString().replace('T', ' ').replace('Z', '000 +0000 UTC');

function envelope(id, at, lat, lon, type = 'PositionReport') {
  const mmsi = 210000000 + id;
  return {
    MessageType: type,
    MetaData: { MMSI: mmsi, time_utc: utc(at) },
    Message: {
      [type]: {
        UserID: mmsi,
        Valid: true,
        Timestamp: new Date(at).getUTCSeconds(),
        Latitude: lat,
        Longitude: lon,
      },
    },
  };
}

/** Three vessels, steady for two fixes, then all jump to one distant cell. */
function publishCoherentJumps(now = Date.now()) {
  for (let id = 1; id <= 3; id++) {
    const lat = 22.1 + id * 0.01;
    publishRegionalAisPosition(envelope(id, now - 180_000, lat, 31.1), now);
    publishRegionalAisPosition(
      envelope(id, now - 120_000, lat + 0.001, 31.101),
      now,
    );
    publishRegionalAisPosition(envelope(id, now - 60_000, 25.1, 35.1), now);
  }
}

/**
 * Attach the plugin to a fake server. Every mount is recorded (a double mount
 * would show), and the server is closed after the test even if it fails, so
 * no listener stays on the shared bus.
 */
function mount(t, { env, aisStatus = 'healthy', real = false, hub } = {}) {
  const service = real
    ? undefined
    : { sources: () => [{ id: 'aisstream', status: aisStatus }] };
  const plugin = airSeaProxy({ service, env, hub });
  const mounts = [];
  const closers = [];
  plugin.configureServer({
    middlewares: { use: (prefix, fn) => mounts.push([prefix, fn]) },
    httpServer: {
      once: (name, fn) => name === 'close' && closers.push(fn),
      address: () => ({ port: 0 }),
    },
  });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    closers.forEach((fn) => fn());
  };
  t.after(close);
  const route = (prefix) => mounts.find(([p]) => p === prefix)?.[1];
  const call = async (prefix, url = '/') => {
    const res = {
      statusCode: 200,
      body: '',
      destroyed: false,
      setHeader() {},
      writeHead(s) {
        res.statusCode = s;
      },
      end(b = '') {
        res.body += b;
      },
    };
    await route(prefix)({ method: 'GET', url }, res);
    return { status: res.statusCode, json: JSON.parse(res.body || '{}') };
  };
  return { mounts, call, close };
}

const ON = { GEV_AIRSEA_ENABLED: '1', GEV_GNSS_REGIONAL: '1' };

test('regional GNSS is off by default: no route, and the air/sea handler answers 404', async (t) => {
  const app = mount(t, { env: { GEV_AIRSEA_ENABLED: '1' } });
  assert.deepEqual(
    app.mounts.map(([p]) => p),
    ['/api/airsea'],
  );
  const answer = await app.call('/api/airsea', '/gnss-regions');
  assert.equal(answer.status, 404);
});

test('with the flag on the route is mounted once, before the air/sea handler', (t) => {
  const app = mount(t, { env: ON });
  assert.deepEqual(
    app.mounts.map(([p]) => p),
    ['/api/airsea/gnss-regions', '/api/airsea'],
  );
});

test('with the flag on but no AIS key the endpoint says unconfigured, with no regions', async (t) => {
  const app = mount(t, { env: ON, aisStatus: 'unconfigured' });
  publishCoherentJumps();
  const answer = await app.call('/api/airsea/gnss-regions');
  assert.equal(answer.status, 200);
  assert.equal(answer.json.status, 'unconfigured');
  assert.deepEqual(answer.json.regions, []);
});

test('AIS envelopes on the bus become one coarse advisory region, without vessel data', async (t) => {
  const app = mount(t, { env: ON });
  publishCoherentJumps();
  const answer = await app.call('/api/airsea/gnss-regions');
  assert.equal(answer.json.status, 'candidate_regions');
  assert.equal(answer.json.regions.length, 1);
  const [region] = answer.json.regions;
  assert.deepEqual(region.area, { south: 22, west: 31, north: 23, east: 32 });
  assert.equal(region.evidence.coherentTargetVessels, 3);
  const text = JSON.stringify(answer.json);
  assert.doesNotMatch(text, /21000000\d|35\.1|25\.1|mmsi/i);
});

test('a degraded feed withholds regions rather than clearing the sea', async (t) => {
  const app = mount(t, { env: ON, aisStatus: 'degraded' });
  publishCoherentJumps();
  const answer = await app.call('/api/airsea/gnss-regions');
  assert.equal(answer.json.status, 'coverage_uncertain');
  assert.deepEqual(answer.json.regions, []);
});

test('closing the server detaches the screen from the bus', async (t) => {
  const app = mount(t, { env: ON });
  app.close();
  publishCoherentJumps();
  const answer = await app.call('/api/airsea/gnss-regions');
  assert.equal(answer.json.diagnostic.accepted, 0);
});

test('the real attach path hands the Autopilot a records callback that follows AIS health', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-gnss-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let attached = null;
  const hub = {
    attach(shared) {
      attached = shared;
      return () => {};
    },
  };
  const app = mount(t, {
    real: true,
    hub,
    env: {
      ...ON,
      GEV_AIRSEA_COLLECT: '0',
      GEV_AIRSEA_WARNINGS: '0',
      GEV_AIRSEA_DIR: dir,
    },
  });
  assert.equal(typeof attached?.gnssRegionalRecords, 'function');
  publishCoherentJumps();
  // The detector holds a pattern, but this test's AIS feed is not healthy:
  // neither the endpoint nor the Autopilot may report it.
  const answer = await app.call('/api/airsea/gnss-regions');
  assert.ok(answer.json.diagnostic.candidateReports >= 3);
  assert.notEqual(answer.json.coverage.feedStatus, 'healthy');
  assert.deepEqual(answer.json.regions, []);
  assert.deepEqual(attached.gnssRegionalRecords(), []);
  app.close();
});

test('the AIS ingest tap publishes stored envelopes only and returns the store answer', () => {
  const published = [];
  const ingest = tapRegionalAisIngest(
    (envelope) => envelope.store,
    (envelope) => published.push(envelope),
  );
  assert.equal(ingest({ store: true, n: 1 }), true);
  assert.equal(ingest({ store: false, n: 2 }), false);
  assert.deepEqual(
    published.map((e) => e.n),
    [1],
  );
  // And the one AIS connection's ingest is the tapped store.
  const live = fs.readFileSync(
    path.join(HERE, '../vessels/ais-live.js'),
    'utf8',
  );
  assert.match(
    live,
    /ingestEnvelope: tapRegionalAisIngest\(ingestAisStreamEnvelope\)/,
  );
});

const SNAPSHOT_AT = Date.parse('2026-11-05T00:00:00Z');
const snapshot = {
  schemaVersion: 1,
  status: 'candidate_regions',
  coverage: { feedStatus: 'healthy', stale: false },
  regions: [
    {
      id: 'regional-navigation:112:211',
      domain: 'sea',
      confidence: 'low',
      causeAssessment: 'unconfirmed',
      eventPriority: 'advisory',
      area: { south: 22, north: 23, west: 31, east: 32 },
      firstSeenAt: SNAPSHOT_AT,
      lastSeenAt: SNAPSHOT_AT,
      evidence: { uniqueVessels: 10, coherentTargetVessels: 3 },
    },
  ],
};

/** A traffic anomaly the air/sea records already carry (signals.test.mjs 14). */
const [cellA, cellB] = gridDisk(latLngToCell(51.5, -0.1, 2), 1);
const anomalyCell = (cell, current) => ({
  cell,
  current,
  baseline: 100,
  changePct: current - 100,
  robustZ: -6,
  observation: 'possible_traffic_suppression',
  confidence: 'medium',
});
const service = {
  anomalies: ({ domain }) =>
    domain !== 'sea'
      ? { status: 'insufficient', cells: [] }
      : {
          domain,
          status: 'ok',
          weeksUsed: 3,
          confidence: 'medium',
          hour_start: SNAPSHOT_AT - 3600_000,
          cells: [anomalyCell(cellA, 20), anomalyCell(cellB, 30)],
        },
};

test('Autopilot records carry the advisory beside the others, and its failure keeps them', () => {
  const records = airSeaRecords({
    service,
    warnings: null,
    gnssRegionalRecords: () => regionalGnssIntelRecords(snapshot),
  });
  const advisory = records.find(
    (r) => r.subtype === 'possible_navigation_integrity_anomaly',
  );
  assert.ok(advisory, 'the advisory is among the air/sea records');
  assert.equal(advisory.metrics.severity_hint, 25);
  assert.match(advisory.summary, /At least 3 vessels/);
  assert.equal('navigation_safe' in advisory.metrics, false);
  const others = records.filter((r) => r !== advisory);
  assert.ok(others.length > 0, 'the fixture has other records to keep');
  const warn = console.warn;
  console.warn = () => {};
  try {
    const kept = airSeaRecords({
      service,
      warnings: null,
      gnssRegionalRecords: () => {
        throw new Error('test-only failure');
      },
    });
    assert.deepEqual(kept, others);
  } finally {
    console.warn = warn;
  }
});

test('a region still reported is a new observation every 10 minutes', () => {
  const later = structuredClone(snapshot);
  later.regions[0].lastSeenAt = SNAPSHOT_AT + 11 * 60_000;
  const [first] = regionalGnssIntelRecords(snapshot);
  const [second] = regionalGnssIntelRecords(later);
  assert.notEqual(
    first.metrics.observed_through,
    second.metrics.observed_through,
  );
});
