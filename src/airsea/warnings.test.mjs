import test from 'node:test';
import assert from 'node:assert/strict';
import {
  changeKind,
  circlePolygon,
  continuousRing,
  geometryBounds,
  normalizeWarning,
  validateGeometry,
  warningStatus,
} from './warnings.js';

const T = Date.parse('2026-10-30T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const H = 3600_000;
const meta = { receivedAtUtc: iso(T), parserVersion: 'test' };

test('12: rings are closed, invalid positions dropped, unusable geometry refused', () => {
  const open = validateGeometry({
    type: 'Polygon',
    coordinates: [
      [
        [10, 10],
        [11, 10],
        [11, 11],
      ],
    ],
  });
  assert.deepEqual(open.geometry.coordinates[0].at(-1), [10, 10]);
  assert.ok(open.notes.includes('ring_closed'));
  const bad = validateGeometry({
    type: 'Polygon',
    coordinates: [
      [
        [10, 10],
        [200, 10],
        [11, 11],
      ],
    ],
  });
  assert.equal(bad.geometry, null, 'out-of-range point leaves too few');
  const multi = validateGeometry({
    type: 'MultiPolygon',
    coordinates: [
      [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 0],
        ],
      ],
      [[[5, 5]]],
    ],
  });
  assert.equal(multi.geometry.coordinates.length, 1, 'degenerate part dropped');
  assert.equal(validateGeometry({ type: 'Circle' }).geometry, null);
});

test('stated circles become geodesic polygons of the stated radius', () => {
  const circle = circlePolygon({ lat: 43.86, lon: -78.71 }, 0.5);
  const ring = circle.coordinates[0];
  assert.deepEqual(ring[0], ring.at(-1));
  for (const [lon, lat] of ring.slice(0, -1)) {
    const dLat = ((lat - 43.86) * Math.PI) / 180;
    const dLon = ((lon + 78.71) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((43.86 * Math.PI) / 180) *
        Math.cos((lat * Math.PI) / 180) *
        Math.sin(dLon / 2) ** 2;
    const km = 2 * 6371.0088 * Math.asin(Math.sqrt(a));
    assert.ok(Math.abs(km - 0.5) < 0.005, String(km));
  }
});

test('12: antimeridian rings stay continuous and bounds take the short way round', () => {
  const ring = [
    [179.5, -17],
    [-179.5, -17],
    [-179.5, -18],
    [179.5, -18],
    [179.5, -17],
  ];
  const drawn = continuousRing(ring);
  assert.ok(
    drawn.every(([lon]) => lon >= 179 && lon <= 181),
    JSON.stringify(drawn),
  );
  const [west, south, east, north] = geometryBounds({
    type: 'Polygon',
    coordinates: [ring],
  });
  assert.ok(west > east, 'crosses the antimeridian');
  assert.deepEqual([west, south, east, north], [179.5, -18, -179.5, -17]);
});

test('11: lifecycle follows the source times; a quiet feed never expires a warning', () => {
  const base = {
    effectiveFromUtc: iso(T + H),
    effectiveUntilUtc: iso(T + 5 * H),
    publishedAtUtc: iso(T - H),
  };
  assert.equal(warningStatus(base, T), 'scheduled');
  assert.equal(warningStatus(base, T + 2 * H), 'active');
  assert.equal(warningStatus(base, T + 6 * H), 'expired');
  assert.equal(
    warningStatus({ ...base, cancelledAtUtc: iso(T + 2 * H) }, T + 3 * H),
    'cancelled',
  );
  const openEnded = { effectiveFromUtc: iso(T - 100 * H) };
  assert.equal(
    warningStatus(openEnded, T + 1000 * H),
    'active',
    'no stated end',
  );
  assert.equal(warningStatus({}, T), 'unknown');
  // Overlapping windows are independent.
  const a = { effectiveFromUtc: iso(T), effectiveUntilUtc: iso(T + 2 * H) };
  const b = { effectiveFromUtc: iso(T + H), effectiveUntilUtc: iso(T + 3 * H) };
  assert.deepEqual(
    [warningStatus(a, T + 2.5 * H), warningStatus(b, T + 2.5 * H)],
    ['expired', 'active'],
  );
});

test('9: a warning without geometry is a list record, never a made-up area', () => {
  const record = normalizeWarning(
    {
      id: 'x:1',
      sourceId: 'x',
      domain: 'aviation',
      title: 'Airspace restriction near the capital',
      geometry: null,
    },
    meta,
  );
  assert.equal(record.geometry, null);
  assert.equal(record.geometryPrecision, 'none');
});

test('11: change detection: new, changed, cancelled, expired, unchanged', () => {
  const draft = {
    id: 'x:1',
    sourceId: 'x',
    domain: 'maritime',
    title: 'Firing exercise',
    effectiveFromUtc: iso(T - H),
    effectiveUntilUtc: iso(T + H),
    geometry: { type: 'Point', coordinates: [10, 10] },
  };
  const v1 = normalizeWarning(draft, meta);
  assert.equal(changeKind(null, v1, T), 'new');
  assert.equal(changeKind(v1, normalizeWarning(draft, meta), T), null);
  const v2 = normalizeWarning(
    { ...draft, title: 'Firing exercise extended' },
    meta,
  );
  assert.equal(changeKind(v1, v2, T), 'changed');
  const v3 = normalizeWarning({ ...draft, cancelledAtUtc: iso(T) }, meta);
  assert.equal(changeKind(v1, v3, T), 'cancelled');
  assert.equal(changeKind(v1, v1, T + 2 * H), null, 'same record');
  assert.equal(changeKind({ ...v1 }, v1, T + 2 * H), null);
  const expiredNow = normalizeWarning(
    { ...draft, effectiveUntilUtc: iso(T - 1) },
    meta,
  );
  assert.equal(changeKind(v1, expiredNow, T), 'expired');
});

test('only https source links are kept', () => {
  const record = normalizeWarning(
    { id: 'x:2', sourceId: 'x', sourceUrl: 'javascript:alert(1)' },
    meta,
  );
  assert.equal(record.sourceUrl, null);
});
