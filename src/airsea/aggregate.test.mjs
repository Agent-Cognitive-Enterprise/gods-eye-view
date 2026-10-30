import test from 'node:test';
import assert from 'node:assert/strict';
import { latLngToCell } from 'h3-js';
import {
  aggregateCells,
  aircraftFromReadsb,
  aircraftFromStates,
  altitudeBand,
  cellRing,
  createTrafficTracker,
  rejectReason,
  resolutionForHeight,
  vesselsFromAisRows,
} from './aggregate.js';
import { domainCoverage, sourceStatus, TRAFFIC_SOURCES } from './sources.js';

const NOW = Date.UTC(2026, 9, 30, 12, 0, 0);
const sec = (ms) => Math.floor(ms / 1000);
// OpenSky state vector: [icao24, callsign, country, time_position,
// last_contact, lon, lat, baro_alt, on_ground, velocity, ...13: geo_alt]
const state = (hex, lat, lon, at = NOW, extra = {}) => {
  const s = [hex, 'TEST1', 'X', sec(at), sec(at), lon, lat, 10_000, false, 230];
  s[13] = extra.geoAlt ?? 10_100;
  if (extra.onGround) s[8] = true;
  if (extra.speed !== undefined) s[9] = extra.speed;
  return s;
};
const opensky = (states, at = NOW) =>
  aircraftFromStates(
    { time: sec(at), states },
    { provider: 'opensky', receivedAt: at },
  );

test('1: an aircraft reported by OpenSky and adsb.lol counts once, at the fresher fix', () => {
  const tracker = createTrafficTracker();
  tracker.ingest(opensky([state('ABC123', 51.47, -0.45, NOW - 20_000)]), NOW);
  const mil = aircraftFromReadsb(
    { now: NOW, ac: [{ hex: 'abc123', lat: 51.5, lon: -0.4, seen_pos: 2 }] },
    { provider: 'adsblol-mil', receivedAt: NOW },
  );
  tracker.ingest(mil, NOW);
  const air = tracker.current('air', NOW, 3600_000);
  assert.equal(air.length, 1, 'one object, not two');
  assert.equal(air[0].provider, 'adsblol-mil', 'fresher fix kept');
  assert.equal(air[0].lat, 51.5);
  // A later, older delivery never moves it back.
  tracker.ingest(opensky([state('abc123', 40, 0, NOW - 60_000)]), NOW);
  assert.equal(tracker.current('air', NOW, 3600_000)[0].lat, 51.5);
});

test('2: many AIS messages from one MMSI are one vessel', () => {
  const tracker = createTrafficTracker();
  const rows = [0, 30, 60, 90].map((s) => ({
    mmsi: 503000001,
    lat: -33.85 + s / 10_000,
    lon: 151.25,
    speed: 12,
    last_position_epoch: sec(NOW - 120_000 + s * 1000),
  }));
  for (const row of rows)
    tracker.ingest(
      vesselsFromAisRows([row], { provider: 'aisstream', receivedAt: NOW }),
      NOW,
    );
  const sea = tracker.current('sea', NOW, 3600_000);
  assert.equal(sea.length, 1);
  assert.equal(
    tracker.diagnostics().reports,
    4,
    'reports are diagnostics only',
  );
  const { cells, total } = aggregateCells(sea, { resolution: 3, now: NOW });
  assert.equal(total, 1);
  assert.equal(cells[0].uniqueCount, 1);
  assert.equal(cells[0].movingCount, 1);
});

test('3: future, out-of-range, null-island, unidentified and stale fixes are refused with counters', () => {
  const tracker = createTrafficTracker();
  tracker.ingest(
    opensky([
      state('f00001', 10, 10, NOW + 10 * 60_000), // future
      state('f00002', 95, 10), // out of range
      state('f00003', 0, 0), // null island
      state('', 10, 10), // no identity
      state('f00005', 10, 10, NOW - 25 * 3600_000), // beyond the longest window
      state('f00006', 10, 10, NOW - 30_000), // fine
    ]),
    NOW,
  );
  assert.equal(tracker.size(), 1);
  assert.deepEqual(tracker.diagnostics().rejected, {
    future: 1,
    out_of_range: 1,
    null_island: 1,
    no_identity: 1,
    stale: 1,
  });
  assert.equal(
    rejectReason({ id: 'x', lat: null, lon: 1 }, NOW),
    'no_position',
  );
  // Outside the chosen window an object stops counting.
  tracker.ingest(opensky([state('f00007', 20, 20, NOW - 40 * 60_000)]), NOW);
  assert.equal(tracker.current('air', NOW, 15 * 60_000).length, 1);
  assert.equal(tracker.current('air', NOW, 3600_000).length, 2);
});

test('4: H3 takes [lat, lng]; rings are GeoJSON [lon, lat] and closed', () => {
  // Sydney: lat −33.87, lon 151.21. Swapping them would land in Antarctica's sea.
  const h3 = latLngToCell(-33.87, 151.21, 3);
  const ring = cellRing(h3);
  assert.deepEqual(ring[0], ring.at(-1), 'closed');
  for (const [lon, lat] of ring) {
    assert.ok(lon > 150 && lon < 153, `lon ${lon}`);
    assert.ok(lat > -35 && lat < -33, `lat ${lat}`);
  }
  const { cells } = aggregateCells(opensky([state('a1b2c3', -33.87, 151.21)]), {
    resolution: 3,
    now: NOW,
  });
  assert.equal(cells[0].h3, h3);
});

test('5: changing resolution never changes how many objects are counted', () => {
  const fixes = [];
  for (let i = 0; i < 400; i++)
    fixes.push(
      ...opensky([
        state(
          `c${String(i).padStart(5, '0')}`,
          40 + (i % 20) * 0.37,
          -100 + Math.floor(i / 20) * 0.53,
        ),
      ]),
    );
  const totals = [2, 3, 4].map(
    (resolution) => aggregateCells(fixes, { resolution, now: NOW }).total,
  );
  assert.deepEqual(totals, [400, 400, 400]);
  // Every object sits in exactly one cell at every resolution. (H3 cells
  // do not nest exactly, so a child's parent is not re-counted.)
  for (const resolution of [2, 3, 4]) {
    const { cells } = aggregateCells(fixes, { resolution, now: NOW });
    assert.equal(
      cells.reduce((sum, c) => sum + c.uniqueCount, 0),
      400,
    );
  }
  // Density is per area, so it is comparable across resolutions.
  const one = aggregateCells(fixes.slice(0, 1), { resolution: 2, now: NOW });
  const oneFine = aggregateCells(fixes.slice(0, 1), {
    resolution: 4,
    now: NOW,
  });
  assert.ok(
    oneFine.cells[0].densityPer10kKm2 > one.cells[0].densityPer10kKm2 * 40,
    'the same aircraft is denser in a 49× smaller cell',
  );
});

test('12: cells on the antimeridian stay continuous; polar cells are left out', () => {
  const h3 = latLngToCell(-16.8, 179.99, 2);
  const ring = cellRing(h3);
  const lons = ring.map(([lon]) => lon);
  assert.ok(Math.max(...lons) - Math.min(...lons) < 10, lons.join());
  assert.ok(
    lons.some((lon) => lon > 180),
    'unwrapped past 180°',
  );
  const pole = latLngToCell(89.99, 0, 1);
  assert.equal(cellRing(pole), null);
  const { cells } = aggregateCells(
    opensky([state('d00001', 89.99, 10), state('d00002', 10, 10)]),
    { resolution: 1, now: NOW },
  );
  assert.equal(cells.length, 1, 'the polar cell is dropped, not drawn wrong');
});

test('boxes: a view box across the antimeridian keeps both sides', () => {
  const fixes = opensky([
    state('e00001', -17, 179.5),
    state('e00002', -17, -179.5),
    state('e00003', -17, 100),
  ]);
  const { total } = aggregateCells(fixes, {
    resolution: 4,
    now: NOW,
    box: [170, -30, -170, 0],
  });
  assert.equal(total, 2);
});

test('moving, stationary and altitude bands are separated', () => {
  const fixes = opensky([
    state('a00001', 10, 10, NOW, { geoAlt: 11_000 }),
    state('a00002', 10.01, 10.01, NOW, { geoAlt: 1_000 }),
    state('a00003', 10.02, 10.02, NOW, { onGround: true, speed: 5 }),
  ]);
  const [cell] = aggregateCells(fixes, { resolution: 2, now: NOW }).cells;
  assert.equal(cell.uniqueCount, 3);
  assert.equal(cell.movingCount, 2);
  assert.equal(cell.stationaryCount, 1);
  assert.deepEqual(cell.bands, { high: 1, low: 1, ground: 1 });
  assert.equal(altitudeBand({ onGround: false, altitudeM: null }), 'unknown');
  assert.equal(cell.newestAgeMs, 0);
});

test('zoom policy: coarse for the globe, finer when close', () => {
  assert.equal(resolutionForHeight(18_000_000), 2);
  assert.equal(resolutionForHeight(2_000_000), 3);
  assert.equal(resolutionForHeight(300_000), 4);
});

test('6/7: an outage reads as missing coverage, never as traffic that vanished', () => {
  const opensky = TRAFFIC_SOURCES.find((s) => s.id === 'opensky');
  const ais = TRAFFIC_SOURCES.find((s) => s.id === 'aisstream');
  assert.equal(sourceStatus(opensky, null, NOW).status, 'stale');
  assert.equal(
    sourceStatus(opensky, { receivedAt: NOW - 20 * 60_000, objects: 9000 }, NOW)
      .status,
    'stale',
  );
  assert.equal(
    sourceStatus(
      opensky,
      { receivedAt: NOW, newestFixAt: NOW - 40 * 60_000, objects: 9000 },
      NOW,
    ).reason,
    'positions_old',
  );
  assert.equal(
    sourceStatus(opensky, { receivedAt: NOW, objects: 0 }, NOW).reason,
    'empty_snapshot',
  );
  assert.equal(
    sourceStatus(ais, { configured: false }, NOW).status,
    'unconfigured',
  );
  // Socket silence: configured, but nothing received recently.
  assert.equal(
    sourceStatus(
      ais,
      { configured: true, receivedAt: NOW - 11 * 60_000, objects: 50 },
      NOW,
    ).status,
    'stale',
  );
  assert.deepEqual(
    domainCoverage('sea', { aisstream: { status: 'unconfigured' } }),
    {
      level: 'none',
      reason: 'not_configured',
    },
  );
  assert.deepEqual(
    domainCoverage('air', {
      opensky: { status: 'stale' },
      'adsblol-mil': { status: 'healthy' },
    }),
    { level: 'partial', reason: 'only_regional_or_military_feeds' },
  );
  assert.equal(
    domainCoverage('air', { opensky: { status: 'healthy' } }).level,
    'global',
  );
});
