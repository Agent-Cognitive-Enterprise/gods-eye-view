import test from 'node:test';
import assert from 'node:assert/strict';
import { latLngToCell } from 'h3-js';
import { evaluateAnomalies } from './anomaly.js';
import {
  createFootprintTracker,
  distanceKm,
  intermediate,
  segmentCells,
  FOOTPRINT_RULES,
} from './trajectory.js';

const T = Date.UTC(2026, 9, 30, 0, 0);
const MIN = 60_000;
const plane = (lat, lon, at) => ({
  domain: 'air',
  id: 'abc123',
  lat,
  lon,
  observedAt: at,
});

test('a flight across many cells is one passage per cell; updates in a cell add time only', () => {
  const footprint = createFootprintTracker();
  // Sydney to Perth-ish at ~850 km/h, a fix every 5 minutes for 4 hours.
  const fixes = [];
  for (let i = 0; i <= 48; i++)
    fixes.push(
      plane(-33.9 + (i / 48) * 2, 151.2 - (i / 48) * 33, T + i * 5 * MIN),
    );
  const passages = [];
  const minutes = [];
  for (const fix of fixes) {
    const step = footprint.observe(fix);
    passages.push(...step.passages.filter((p) => p.resolution === 3));
    minutes.push(...step.minutes.filter((m) => m.resolution === 3));
  }
  const cells = passages.map((p) => p.cell);
  assert.ok(cells.length > 20, `${cells.length} cells crossed`);
  assert.equal(new Set(cells).size, cells.length, 'each cell entered once');
  const total = minutes.reduce((sum, m) => sum + m.minutes, 0);
  assert.ok(Math.abs(total - 240) < 0.01, `${total} minutes`);
  // The same fix again, or an older one, changes nothing.
  assert.deepEqual(footprint.observe(fixes.at(-1)).passages, []);
  assert.deepEqual(footprint.observe(fixes[3]).passages, []);
});

test('a parked aircraft or a moored ship accumulates time, not passages', () => {
  const footprint = createFootprintTracker();
  const ship = (at) => ({
    domain: 'sea',
    id: '503000001',
    lat: -33.86,
    lon: 151.21,
    observedAt: at,
  });
  let passages = 0;
  let minutes = 0;
  for (let i = 0; i < 12; i++) {
    const step = footprint.observe(ship(T + i * 10 * MIN));
    passages += step.passages.filter((p) => p.resolution === 4).length;
    minutes += step.minutes
      .filter((m) => m.resolution === 4)
      .reduce((s, m) => s + m.minutes, 0);
  }
  // First sighting is no passage: a restart cannot make every moored
  // ship "arrive" at once.
  assert.equal(passages, 0);
  assert.equal(minutes, 110);
});

test('edge jitter, feed timestamp jitter and quick re-entries are no new passages', () => {
  const footprint = createFootprintTracker();
  const cell = latLngToCell(-33.86, 151.21, 4);
  // Find a point just on the other side of an edge of that cell.
  let other = null;
  for (let d = 0.001; !other && d < 0.2; d += 0.001)
    if (latLngToCell(-33.86, 151.21 + d, 4) !== cell) other = 151.21 + d;
  const at = (lon, ms) => ({
    domain: 'sea',
    id: '503000002',
    lat: -33.86,
    lon,
    observedAt: ms,
  });
  let passages = 0;
  for (let i = 0; i < 120; i++) {
    const lon = i % 2 ? other : other - 0.0004;
    passages += footprint
      .observe(at(lon, T + i * 30_000))
      .passages.filter((p) => p.resolution === 4).length;
  }
  assert.ok(passages <= 1, `${passages} passages from jitter`);
  // The same aircraft from two feeds 0.4 s and 0.4 km apart is no jump.
  const jitter = createFootprintTracker();
  jitter.observe(plane(-33.9, 151.2, T));
  const next = jitter.observe(plane(-33.9, 151.2045, T + 400));
  assert.equal(next.uncertain, false);
});

test('an implausible jump or a long gap paints nothing in between', () => {
  const footprint = createFootprintTracker();
  footprint.observe(plane(-33.9, 151.2, T));
  // 3,000 km in 10 minutes: not the same flight path, never interpolated.
  const jump = footprint.observe(plane(-31.9, 115.9, T + 10 * MIN));
  assert.equal(jump.uncertain, true);
  assert.equal(jump.minutes.length, 0);
  assert.deepEqual(
    jump.passages.map((p) => p.cell).filter((_, i, all) => i < all.length),
    jump.passages.map((p) => latLngToCell(-31.9, 115.9, p.resolution)),
  );
  // A 2-hour gap, even at a plausible speed, is not followed either; back
  // in the same cell it is no new passage, somewhere else it is one.
  footprint.observe(plane(-31.9, 115.9, T + 20 * MIN));
  const same = footprint.observe(plane(-31.9, 115.9, T + 3 * 60 * MIN));
  assert.equal(same.uncertain, true);
  assert.equal(same.passages.length, 0);
  const moved = footprint.observe(plane(-25, 130, T + 6 * 60 * MIN));
  assert.equal(moved.uncertain, true);
  assert.equal(moved.minutes.length, 0);
  assert.equal(moved.passages.length, FOOTPRINT_RULES.air.resolutions.length);
});

test('a track across the antimeridian stays on the short great circle', () => {
  const a = { lat: -17, lon: 179.5 };
  const b = { lat: -17, lon: -179.5 };
  assert.ok(distanceKm(a, b) < 120);
  const mid = intermediate(a, b, 0.5);
  assert.ok(Math.abs(Math.abs(mid.lon) - 180) < 0.1, String(mid.lon));
  const segment = segmentCells(
    { ...a, observedAt: T },
    { ...b, observedAt: T + 8 * MIN },
    3,
    FOOTPRINT_RULES.air,
  );
  assert.equal(segment.uncertain, false);
  assert.ok(segment.cells.length <= 4, `${segment.cells.length} cells`);
});

// ------------------------------------------------------------- anomalies
const healthy = { snapshots: 12, objects: 12 * 8000 };
const week = (value, coverage = healthy) => ({
  cells: new Map([
    ['busy', value],
    ['quiet', 2],
  ]),
  coverage,
});

test('Gate C: a real drop with healthy feeds is a possible suppression', () => {
  const result = evaluateAnomalies({
    current: new Map([
      ['busy', 8],
      ['quiet', 2],
    ]),
    currentCoverage: healthy,
    weeks: [week(40), week(44), week(38), week(42)],
    expectedSnapshots: 12,
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.confidence, 'high');
  assert.equal(result.cells.length, 1, 'tiny cells are not judged');
  assert.equal(result.cells[0].cell, 'busy');
  assert.equal(result.cells[0].observation, 'possible_traffic_suppression');
  assert.ok(result.cells[0].changePct <= -75);
});

test('Gate C: the same drop from missing snapshots or lost receivers is inconclusive', () => {
  const base = {
    current: new Map([['busy', 8]]),
    weeks: [week(40), week(44), week(38), week(42)],
    expectedSnapshots: 12,
  };
  const fewSnapshots = evaluateAnomalies({
    ...base,
    currentCoverage: { snapshots: 4, objects: 4 * 8000 },
  });
  assert.equal(fewSnapshots.status, 'coverage_degraded');
  assert.equal(fewSnapshots.reason, 'too_few_snapshots');
  assert.deepEqual(fewSnapshots.cells, []);
  const fewerObjects = evaluateAnomalies({
    ...base,
    currentCoverage: { snapshots: 12, objects: 12 * 2500 },
  });
  assert.equal(fewerObjects.status, 'coverage_degraded');
  assert.equal(fewerObjects.reason, 'feed_sees_fewer_objects');
});

test('14: without two comparable weeks nothing is reported', () => {
  const oneWeek = evaluateAnomalies({
    current: new Map([['busy', 0]]),
    currentCoverage: healthy,
    weeks: [week(40)],
    expectedSnapshots: 12,
  });
  assert.equal(oneWeek.status, 'baseline_insufficient');
  assert.deepEqual(oneWeek.cells, []);
  // A week whose own feed was broken does not count as a comparable week.
  const brokenWeek = evaluateAnomalies({
    current: new Map([['busy', 0]]),
    currentCoverage: healthy,
    weeks: [week(40), week(0, { snapshots: 2, objects: 100 })],
    expectedSnapshots: 12,
  });
  assert.equal(brokenWeek.status, 'baseline_insufficient');
});
