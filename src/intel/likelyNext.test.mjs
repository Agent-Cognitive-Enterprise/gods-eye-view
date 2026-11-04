// likelyNext: the world overview's view of what the scheduler would turn to next.
// Read only, never the shot on screen, and the same order the scheduler itself uses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { clusterEvents } from './clustering.js';
import {
  createSchedulerState,
  likelyNext,
  setSchedulerMode,
  stepScheduler,
} from './scheduler.js';

const T0 = Date.parse('2026-10-29T00:00:00Z');
const SEC = 1000;
const settings = {
  minimumDwellMs: 30 * SEC,
  repeatFocusCooldownMs: 30 * 60 * SEC,
  preemptionConfirmMs: 10 * SEC,
  normalPreemptionMargin: 15,
  criticalInterruptThreshold: 95,
  minimumAttentionScore: 70,
  tourWhenIdle: false,
};
const event = (id, lat, lon, score, extra = {}) => ({
  event_id: id,
  attention_score: score,
  confidence: 0.85,
  camera_eligible: true,
  critical_qualified: false,
  revision: 1,
  lifecycle: 'active',
  category: 'natural_disaster',
  location: { lat, lon, precision: 'city', region_code: null },
  ...extra,
});
const world = [event('a', 10, 10, 90), event('b', 40, 100, 85), event('c', -30, -60, 80), event('d', 50, 0, 60)];
const input = (now, events = world, extra = {}) => ({
  now,
  events,
  clusters: clusterEvents(events.filter((e) => e.camera_eligible), { diameterKm: 800 }),
  settings: { ...settings, ...extra },
});

test('off or paused: nothing is likely next', () => {
  assert.deepEqual(likelyNext(createSchedulerState(), input(T0)), []);
  const paused = setSchedulerMode(createSchedulerState(), 'paused', 'manual_input');
  assert.deepEqual(likelyNext(paused, input(T0)), []);
});

test('it never changes the scheduler state', () => {
  const { state } = stepScheduler(setSchedulerMode(createSchedulerState(), 'auto'), input(T0));
  const before = structuredClone(state);
  likelyNext(state, input(T0 + 5 * SEC));
  assert.deepEqual(state, before);
});

test('the shot on screen is never listed; below the attention bar is not a candidate', () => {
  const { state } = stepScheduler(setSchedulerMode(createSchedulerState(), 'auto'), input(T0));
  assert.equal(state.current.key, 'a');
  const keys = likelyNext(state, input(T0 + 5 * SEC)).map((c) => c.event_ids[0]);
  assert.deepEqual(keys, ['b', 'c']);
});

test('the first candidate is where the scheduler actually goes after the dwell', () => {
  let { state } = stepScheduler(setSchedulerMode(createSchedulerState(), 'auto'), input(T0));
  const predicted = likelyNext(state, input(T0 + 31 * SEC))[0].event_ids[0];
  const out = stepScheduler(state, input(T0 + 31 * SEC));
  assert.equal(out.decision.type, 'fly');
  assert.equal(out.decision.cluster.event_ids[0], predicted);
  state = out.state;
  assert.ok(!likelyNext(state, input(T0 + 35 * SEC)).some((c) => c.event_ids.includes('b')));
});

test('with nothing left to alert, the tour order is shown when the tour is on', () => {
  const quiet = [event('x', 10, 10, 50), event('y', 40, 100, 45)];
  const tourSettings = { tourWhenIdle: true, tourMinimumScore: 40, minimumCameraConfidence: 0.35 };
  const { state } = stepScheduler(setSchedulerMode(createSchedulerState(), 'auto'), input(T0, quiet, tourSettings));
  assert.equal(state.current?.tour, true);
  const next = likelyNext(state, input(T0 + 5 * SEC, quiet, tourSettings));
  assert.equal(next.length, 1);
  assert.notEqual(next[0].event_ids[0], state.current.key);
  assert.deepEqual(likelyNext(state, input(T0 + 5 * SEC, quiet, { tourWhenIdle: false })), []);
});

test('the list is capped', () => {
  const many = Array.from({ length: 20 }, (_, i) => event(`e${i}`, -60 + i * 6, -170 + i * 17, 80 + (i % 10)));
  const state = setSchedulerMode(createSchedulerState(), 'auto');
  assert.equal(likelyNext(state, input(T0, many), 8).length, 8);
});
