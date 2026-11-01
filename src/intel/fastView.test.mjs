import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyFastView,
  defaultFastView,
  fastActivity,
  fastEventVisible,
  isHeldCandidate,
  readFastView,
  writeFastView,
} from './fastView.js';

const NOW = Date.UTC(2026, 9, 31, 3, 0, 0);
const event = (over = {}) => ({
  event_id: 'evt_1',
  providers: ['bluesky'],
  fast_status: 'provisional',
  category: 'armed_conflict',
  first_seen_at: NOW - 60_000,
  ...over,
});
const view = (over = {}) => ({ ...defaultFastView(), ...over });
const memoryStorage = () => {
  const held = new Map();
  return {
    getItem: (key) => held.get(key) ?? null,
    setItem: (key, value) => held.set(key, value),
  };
};

test('feeds outside Fast Intelligence are never hidden by it', () => {
  const official = event({ providers: ['usgs'], fast_status: 'official' });
  const off = view({ enabled: false, windowMin: 5 });
  off.categories.armed_conflict = false;
  assert.equal(fastEventVisible(official, off, NOW + 3_600_000), true);
  assert.equal(
    fastEventVisible(
      event({ providers: ['ghostmaps'], fast_status: 'candidate' }),
      off,
      NOW,
    ),
    true,
  );
});

test('a post joining an official alert cannot hide the alert', () => {
  const joined = event({
    providers: ['nws', 'bluesky'],
    fast_status: 'official',
  });
  const off = view({ enabled: false, windowMin: 5 });
  off.categories.armed_conflict = false;
  off.sublayers.official = false;
  assert.equal(fastEventVisible(joined, off, NOW + 3_600_000), true);
});

test('the master switch hides the push sources and nothing else', () => {
  assert.equal(fastEventVisible(event(), view(), NOW), true);
  assert.equal(fastEventVisible(event(), view({ enabled: false }), NOW), false);
});

test('a held candidate is never drawn, however the view is set', () => {
  const candidate = event({ fast_status: 'candidate' });
  assert.equal(isHeldCandidate(candidate), true);
  assert.equal(fastEventVisible(candidate, view(), NOW), false);
});

test('each sublayer switches on its own; contested stays with provisional', () => {
  const v = view();
  v.sublayers.provisional = false;
  assert.equal(fastEventVisible(event(), v, NOW), false);
  assert.equal(
    fastEventVisible(event({ fast_status: 'contested' }), v, NOW),
    false,
  );
  assert.equal(
    fastEventVisible(event({ fast_status: 'corroborated' }), v, NOW),
    true,
  );
  assert.equal(
    fastEventVisible(event({ fast_status: 'official' }), v, NOW),
    true,
  );
});

test('categories and the new-in-last window filter', () => {
  const v = view({ windowMin: 5 });
  assert.equal(fastEventVisible(event(), v, NOW), true);
  assert.equal(
    fastEventVisible(event({ first_seen_at: NOW - 6 * 60_000 }), v, NOW),
    false,
  );
  v.windowMin = null;
  v.categories.armed_conflict = false;
  assert.equal(fastEventVisible(event(), v, NOW), false);
  assert.equal(
    fastEventVisible(event({ category: 'civil_unrest' }), v, NOW),
    true,
  );
});

test('a hidden event leaves the Autopilot too: its cluster goes with it', () => {
  const payload = {
    now: NOW,
    events: [
      event({ event_id: 'a' }),
      event({ event_id: 'b', providers: ['usgs'] }),
    ],
    clusters: [
      { event_ids: ['a'] },
      { event_ids: ['b'] },
      { event_ids: ['a', 'b'] },
    ],
  };
  const shown = applyFastView(payload, view({ enabled: false }), NOW);
  assert.deepEqual(
    shown.events.map((e) => e.event_id),
    ['b'],
  );
  assert.deepEqual(shown.clusters, [{ event_ids: ['b'] }]);
  assert.equal(
    payload.events.length,
    2,
    'the original stays whole for the next change',
  );
});

test('activity lists what came in, newest first, candidates included', () => {
  const list = fastActivity(
    [
      event({ event_id: 'old', first_seen_at: NOW - 600_000 }),
      event({ event_id: 'new', first_seen_at: NOW, fast_status: 'candidate' }),
      event({ event_id: 'usgs', providers: ['usgs'] }),
    ],
    view(),
  );
  assert.deepEqual(
    list.map((e) => e.event_id),
    ['new', 'old'],
  );
});

test('the view survives a reload, and damage to what was stored', () => {
  const storage = memoryStorage();
  const v = view({ enabled: false, windowMin: 15 });
  v.sublayers.official = false;
  writeFastView(storage, v);
  assert.deepEqual(readFastView(storage), v);
  storage.setItem('gev.fastintel.view', '{broken');
  assert.deepEqual(readFastView(storage), defaultFastView());
  storage.setItem(
    'gev.fastintel.view',
    JSON.stringify({
      enabled: 'yes',
      windowMin: 7,
      categories: { invented: false },
    }),
  );
  assert.deepEqual(readFastView(storage), defaultFastView());
  assert.deepEqual(readFastView(null), defaultFastView());
  writeFastView(
    {
      setItem() {
        throw new Error('full');
      },
    },
    v,
  );
});
