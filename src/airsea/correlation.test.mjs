import test from 'node:test';
import assert from 'node:assert/strict';
import {
  correlationWindow,
  evaluateCorrelation,
  warningZones,
} from './correlation.js';

const HOUR = 3600_000;
const T = Date.parse('2026-11-20T12:00:00Z');
const square = (lon, lat, half) => ({
  type: 'Polygon',
  coordinates: [
    [
      [lon - half, lat - half],
      [lon + half, lat - half],
      [lon + half, lat + half],
      [lon - half, lat + half],
      [lon - half, lat - half],
    ],
  ],
});
const zones = warningZones(square(151.5, -34, 0.3), 'sea');
const warning = { id: 'nws:test', effectiveFromUtc: '2026-11-20T06:00:00Z' };
// Passages: `inside`, `buffer` and `comparison` per cell of each zone.
const cells = ({ inside, buffer = 10, comparison = 10 }) => {
  const map = new Map();
  for (const c of zones.inside) map.set(c, inside / zones.inside.size);
  for (const c of zones.buffer) map.set(c, buffer / zones.buffer.size);
  for (const c of zones.comparison)
    map.set(c, comparison / zones.comparison.size);
  return map;
};
const healthy = { snapshots: 720, objects: 720 * 1500 };
const week = (counts) => ({ cells: cells(counts), coverage: healthy });
const base = {
  warning,
  zones,
  domain: 'sea',
  expectedSnapshots: 720,
  from: T - 6 * HOUR,
  to: T,
};
const usual = { inside: 100, buffer: 80, comparison: 300 };
const weeks = [week(usual), week(usual), week(usual)];

test('zones: inside, buffer and comparison rings are disjoint; points have none', () => {
  assert.equal(zones.resolution, 4);
  assert.ok(zones.inside.size >= 1);
  for (const c of zones.buffer) assert.equal(zones.inside.has(c), false);
  for (const c of zones.comparison) {
    assert.equal(zones.inside.has(c), false);
    assert.equal(zones.buffer.has(c), false);
  }
  assert.equal(
    warningZones({ type: 'Point', coordinates: [151, -34] }, 'sea'),
    null,
  );
  const pacific = warningZones(
    {
      type: 'Polygon',
      coordinates: [
        [
          [179.8, -10],
          [-179.8, -10],
          [-179.8, -9.6],
          [179.8, -9.6],
          [179.8, -10],
        ],
      ],
    },
    'sea',
  );
  // A small box across the antimeridian stays small.
  assert.ok(pacific.inside.size > 0 && pacific.inside.size < 20);
});

test('a drop inside that the surrounding ring does not share is a possible suppression', () => {
  const result = evaluateCorrelation({
    ...base,
    post: {
      cells: cells({ inside: 30, buffer: 110, comparison: 310 }),
      coverage: healthy,
    },
    weeks,
  });
  assert.equal(result.observation, 'possible_traffic_suppression');
  assert.equal(result.reference, 'matched_baseline');
  assert.equal(result.changePct, -70);
  assert.equal(result.confidence, 'medium');
  assert.deepEqual(result.corroboratingSignals, ['adjacent_corridor_increase']);
  assert.equal(result.causeAssessment, 'unconfirmed');
});

test('the same drop everywhere (night, feed-wide swing) is no material change', () => {
  const result = evaluateCorrelation({
    ...base,
    post: {
      cells: cells({ inside: 30, buffer: 24, comparison: 90 }),
      coverage: healthy,
    },
    weeks,
  });
  assert.equal(result.observation, 'no_material_change');
  assert.equal(result.confidence, null);
});

test('the same drop from a feed that delivered too little is inconclusive', () => {
  for (const coverage of [
    { snapshots: 200, objects: 200 * 1500 },
    { snapshots: 720, objects: 720 * 600 },
  ]) {
    const result = evaluateCorrelation({
      ...base,
      post: { cells: cells({ inside: 30 }), coverage },
      weeks,
    });
    assert.equal(result.observation, 'inconclusive');
    assert.equal(result.coverageQuality, 'degraded');
  }
});

test('without a baseline, the hours before the warning count only with a control', () => {
  const pre = { cells: cells(usual), coverage: healthy };
  const result = evaluateCorrelation({
    ...base,
    post: {
      cells: cells({ inside: 20, buffer: 80, comparison: 300 }),
      coverage: healthy,
    },
    pre,
  });
  assert.equal(result.reference, 'pre_warning');
  assert.equal(result.observation, 'possible_traffic_suppression');
  assert.equal(result.confidence, 'low');
  const noControl = evaluateCorrelation({
    ...base,
    post: {
      cells: cells({ inside: 20, buffer: 0, comparison: 0 }),
      coverage: healthy,
    },
    pre: {
      cells: cells({ inside: 100, buffer: 0, comparison: 0 }),
      coverage: healthy,
    },
  });
  assert.equal(noControl.observation, 'inconclusive');
  assert.equal(noControl.reason, 'no_control');
  const nothing = evaluateCorrelation({
    ...base,
    post: { cells: cells(usual), coverage: healthy },
  });
  assert.equal(nothing.reason, 'no_reference');
});

test('tiny counts are not judged', () => {
  const result = evaluateCorrelation({
    ...base,
    post: { cells: cells({ inside: 0 }), coverage: healthy },
    weeks: [week({ inside: 4 }), week({ inside: 4 })],
  });
  assert.equal(result.observation, 'inconclusive');
  assert.equal(result.reason, 'insufficient_sample');
});

test('windows are whole hours after the warning began, with a pre-warning window', () => {
  const now = Date.parse('2026-11-20T12:20:00Z');
  const window = correlationWindow(
    { effectiveFromUtc: '2026-11-20T09:10:00Z' },
    now,
    now - 48 * HOUR,
  );
  assert.equal(new Date(window.from).toISOString(), '2026-11-20T10:00:00.000Z');
  assert.equal(new Date(window.to).toISOString(), '2026-11-20T12:00:00.000Z');
  assert.equal(
    new Date(window.pre.from).toISOString(),
    '2026-11-20T07:00:00.000Z',
  );
  assert.equal(
    new Date(window.pre.to).toISOString(),
    '2026-11-20T09:00:00.000Z',
  );
  // Not a complete hour yet; scheduled for later.
  assert.equal(
    correlationWindow({ effectiveFromUtc: '2026-11-20T11:30:00Z' }, now, 0),
    null,
  );
  // History began after the pre-warning window would start.
  assert.equal(
    correlationWindow(
      { effectiveFromUtc: '2026-11-20T09:10:00Z' },
      now,
      now - HOUR * 4,
    ).pre,
    null,
  );
});
