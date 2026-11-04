import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NEXT_LIMIT,
  VISITED_LIMIT,
  clusterPlace,
  overviewModel,
  recordVisit,
  sameModel,
} from './overviewModel.js';

const event = (id, lat, lon, extra = {}) => ({
  event_id: id,
  title: `Event ${id}`,
  location: { lat, lon, precision: 'city' },
  ...extra,
});
const cluster = (ids, lat, lon, extra = {}) => ({ event_ids: ids, center: { lat, lon }, framing: 'point', ...extra });
const events = [event('a', 10, 20), event('b', -30, 150), event('c', 50, -100), event('d', 0, 0)];
const clusters = [cluster(['a'], 10, 20), cluster(['b'], -30, 150), cluster(['c', 'd'], 50, -100)];

test('the current target is the shot the scheduler holds, at its cluster, not the camera', () => {
  const m = overviewModel({ mode: 'auto', world: 'live', schedulerCurrent: { key: 'c', eventIds: ['c', 'd'] }, clusters, events });
  assert.deepEqual([m.current.key, m.current.lat, m.current.lon], ['c', 50, -100]);
  assert.deepEqual(m.current.eventIds, ['c', 'd']);
  assert.equal(m.status, 'ready');
  // The camera is not part of the model: a zoom-out cannot move the target.
  assert.equal('camera' in m, false);
});

test('nothing on screen and nothing likely next reads as no targets', () => {
  const m = overviewModel({ mode: 'auto', world: 'live', schedulerCurrent: null, clusters, events });
  assert.equal(m.current, null);
  assert.equal(m.status, 'no_targets');
});

test('paused and off: paused keeps no target from the scheduler, off draws none', () => {
  const paused = overviewModel({ mode: 'paused', world: 'live', schedulerCurrent: null, visited: [{ key: 'a', lat: 10, lon: 20 }], clusters, events });
  assert.equal(paused.mode, 'paused');
  assert.equal(paused.visited.length, 1, 'where it has been stays on the map');
  const off = overviewModel({ mode: 'off', world: 'live', schedulerCurrent: { key: 'a', eventIds: ['a'] }, clusters, events });
  assert.equal(off.current, null);
});

test('unknown camera position is its own status', () => {
  const m = overviewModel({ mode: 'auto', world: 'live', schedulerCurrent: { key: 'a', eventIds: ['a'] }, clusters, events, cameraKnown: false });
  assert.equal(m.status, 'unknown_position');
});

test('likely next stops are candidates, ranked, never a committed route', () => {
  const m = overviewModel({ mode: 'auto', world: 'live', schedulerCurrent: { key: 'a', eventIds: ['a'] }, clusters, events, likely: [clusters[1], clusters[2]] });
  assert.deepEqual(m.next.map((n) => [n.key, n.rank, n.prediction]), [
    ['b', 1, 'candidate'],
    ['c', 2, 'candidate'],
  ]);
  const many = Array.from({ length: 12 }, (_, i) => cluster([`x${i}`], i, i));
  const big = overviewModel({ mode: 'auto', world: 'live', schedulerCurrent: null, clusters: many, events: many.map((c, i) => event(`x${i}`, i, i)), likely: many });
  assert.equal(big.next.length, NEXT_LIMIT);
});

test('a country-level report is drawn as regional; one with no position is counted, not invented', () => {
  const regional = [event('r', 35, 105, { location: { lat: 35, lon: 105, precision: 'country' } })];
  const place = clusterPlace(cluster(['r'], 35, 105), new Map(regional.map((e) => [e.event_id, e])));
  assert.equal(place.regional, true);
  const nowhere = [event('n', null, null, { location: { lat: null, lon: null, precision: 'unresolved' } })];
  const m = overviewModel({ mode: 'auto', world: 'live', schedulerCurrent: null, clusters: [{ event_ids: ['n'] }], events: nowhere, likely: [{ event_ids: ['n'] }] });
  assert.equal(m.next.length, 0);
  assert.equal(m.unplaced, 1);
});

test('a drill is marked as a demo, never mixed in as live', () => {
  assert.equal(overviewModel({ mode: 'auto', world: 'replay', schedulerCurrent: null, clusters, events }).demo, true);
  assert.equal(overviewModel({ mode: 'auto', world: 'live', schedulerCurrent: null, clusters, events: [event('s', 1, 1, { synthetic: true })] }).demo, true);
  assert.equal(overviewModel({ mode: 'auto', world: 'live', schedulerCurrent: null, clusters, events }).demo, false);
});

test('visited: newest first, limited, a repeat moves to the front, no place is no visit', () => {
  let visited = [];
  for (const key of ['a', 'b', 'c', 'b', 'd', 'e', 'f', 'g']) visited = recordVisit(visited, { key, lat: 1, lon: 1 });
  assert.equal(visited.length, VISITED_LIMIT);
  assert.deepEqual(visited.map((v) => v.key), ['g', 'f', 'e', 'd', 'b']);
  assert.equal(recordVisit(visited, { key: 'x', lat: null, lon: 1 }), visited);
});

test('a refused or cancelled flight never reaches the visited list, because only arrivals are recorded', () => {
  // The console calls recordVisit only from a flight's onSettled; nothing else does.
  const before = [{ key: 'a', lat: 10, lon: 20 }];
  const m = overviewModel({ mode: 'paused', world: 'live', schedulerCurrent: null, visited: before, clusters, events });
  assert.deepEqual(m.visited.map((v) => v.key), ['a']);
});

test('the current shot is not also drawn as visited', () => {
  const m = overviewModel({ mode: 'auto', world: 'live', schedulerCurrent: { key: 'a', eventIds: ['a'] }, visited: [{ key: 'a', lat: 10, lon: 20 }, { key: 'b', lat: -30, lon: 150 }], clusters, events });
  assert.deepEqual(m.visited.map((v) => v.key), ['b']);
});

test('an identical state compares equal, so it causes no redraw; a real change does not', () => {
  const input = { mode: 'auto', world: 'live', schedulerCurrent: { key: 'a', eventIds: ['a'] }, clusters, events, likely: [clusters[1]] };
  assert.ok(sameModel(overviewModel(input), overviewModel({ ...input, events: events.map((e) => ({ ...e })) })));
  assert.ok(!sameModel(overviewModel(input), overviewModel({ ...input, likely: [clusters[2]] })));
  assert.ok(!sameModel(overviewModel(input), overviewModel({ ...input, mode: 'paused', schedulerCurrent: null })));
});
