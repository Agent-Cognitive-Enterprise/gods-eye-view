import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ENDED_SHOWN_MS,
  areaRing,
  normaliseArea,
  regionsFromAnswer,
  viewRectangle,
} from './gnssRegionsView.js';

const BALTIC = { south: 55.1, north: 55.6, west: 16.2, east: 17.1 };

test('a usable box is kept; malformed or huge ones are refused', () => {
  assert.deepEqual(normaliseArea(BALTIC), BALTIC);
  assert.equal(normaliseArea(null), null);
  assert.equal(normaliseArea({ ...BALTIC, north: 'x' }), null);
  assert.equal(normaliseArea({ ...BALTIC, north: 55.1 }), null);
  assert.equal(normaliseArea({ ...BALTIC, east: 16.2 }), null);
  assert.equal(
    normaliseArea({ south: -40, north: 40, west: 0, east: 1 }),
    null,
  );
  assert.equal(
    normaliseArea({ south: 0, north: 1, west: -100, east: 100 }),
    null,
  );
});

test('a box across the dateline keeps continuous longitudes', () => {
  // The detector reports a dateline box on the west side (west < -180).
  const box = normaliseArea({
    south: 50,
    north: 51,
    west: -180.6,
    east: -179.4,
  });
  assert.equal(box.west, 179.4);
  assert.ok(Math.abs(box.east - 180.6) < 1e-9);
  const ring = areaRing({ south: 50, north: 51, west: -180.6, east: -179.4 });
  const lons = ring.map(([lon]) => lon);
  assert.ok(Math.max(...lons) - Math.min(...lons) < 2, 'never wraps the world');
});

test('the ring is closed, densified, and follows the box edges', () => {
  const ring = areaRing(BALTIC, 0.25);
  assert.deepEqual(ring[0], ring.at(-1));
  assert.ok(ring.length >= 4 * 2 + 1);
  for (const [lon, lat] of ring) {
    assert.ok(lon >= BALTIC.west - 1e-9 && lon <= BALTIC.east + 1e-9);
    assert.ok(lat >= BALTIC.south - 1e-9 && lat <= BALTIC.north + 1e-9);
  }
  assert.equal(areaRing({ south: 1, north: 0, west: 0, east: 1 }), null);
});

test('the camera rectangle is padded, and crosses the dateline as Cesium expects', () => {
  const r = viewRectangle(BALTIC);
  assert.ok(r.west < BALTIC.west && r.east > BALTIC.east);
  assert.ok(r.south < BALTIC.south && r.north > BALTIC.north);
  const d = viewRectangle({ south: 50, north: 51, west: -180.6, east: -179.4 });
  assert.ok(d.west > 0 && d.east < 0, JSON.stringify(d));
  assert.ok(d.west >= -180 && d.west <= 180 && d.east >= -180 && d.east <= 180);
  const near = viewRectangle({
    south: 10,
    north: 10.5,
    west: 179.8,
    east: 179.95,
  });
  assert.ok(near.west > 0 && near.east < 0, JSON.stringify(near));
  assert.ok(
    viewRectangle({ south: 89.5, north: 89.8, west: 0, east: 1 }).north <= 89,
  );
});

test('active regions and recent ended incidents, newest first, never twice', () => {
  const now = Date.UTC(2026, 10, 7, 12);
  const answer = {
    regions: [
      {
        id: 'a',
        sourceLocation: 'credible',
        evidence: { uniqueVessels: 4 },
        firstSeenAt: now - 60_000 * 40,
        lastSeenAt: now - 60_000 * 10,
        area: BALTIC,
      },
      {
        id: 'b',
        sourceLocation: 'ambiguous',
        evidence: { uniqueVessels: 3 },
        firstSeenAt: now - 60_000 * 20,
        lastSeenAt: now - 60_000,
        area: { ...BALTIC, west: 18, east: 18.5 },
      },
      { id: 'bad', area: { south: 1 } },
      { id: 'a', area: BALTIC },
    ],
    recentIncidents: [
      {
        id: 'old',
        lastSeenAt: now - ENDED_SHOWN_MS - 1,
        area: BALTIC,
        peakVessels: 5,
      },
      {
        id: 'e',
        firstSeenAt: now - 3 * 3600_000,
        lastSeenAt: now - 2 * 3600_000,
        area: BALTIC,
        peakVessels: 6,
      },
      { id: 'a', lastSeenAt: now - 3600_000, area: BALTIC },
    ],
  };
  const { active, ended } = regionsFromAnswer(answer, { now });
  assert.deepEqual(
    active.map((r) => r.id),
    ['b', 'a'],
  );
  assert.equal(active[0].ambiguous, true);
  assert.equal(active[1].ambiguous, false);
  assert.equal(active[1].vessels, 4);
  assert.deepEqual(
    ended.map((r) => [r.id, r.vessels, r.state]),
    [['e', 6, 'ended']],
  );
});

test('an empty or broken answer draws nothing', () => {
  for (const answer of [null, {}, { regions: 'x', recentIncidents: 3 }])
    assert.deepEqual(regionsFromAnswer(answer), { active: [], ended: [] });
});
