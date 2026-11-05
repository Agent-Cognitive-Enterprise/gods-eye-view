// The WORLD OVERVIEW view: red Autopilot markers, the shot on screen blinking, the
// camera separate, and every marker reachable by keyboard with a spoken description.
import '../../../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createApp, nextTick } from 'vue';
import { createPinia } from 'pinia';
import { useWorldOverviewStore } from '../../stores/worldOverview.js';
import WorldOverview from './WorldOverview.vue';

function mount(t) {
  document.body.replaceChildren();
  const pinia = createPinia();
  const store = useWorldOverviewStore(pinia);
  const calls = [];
  store.connect({ select: (id) => calls.push(['select', id]), toggle: () => store.setOpen(!store.open) });
  const app = createApp(WorldOverview).use(pinia);
  app.mount(document.body.appendChild(document.createElement('div')));
  t.after(() => app.unmount());
  return { store, calls, root: () => document.getElementById('world-overview') };
}

const model = (extra = {}) => ({
  mode: 'auto',
  world: 'live',
  demo: false,
  status: 'ready',
  unplaced: 0,
  current: { key: 'a', title: 'Flood in the delta', lat: 10, lon: 20, regional: false, eventIds: ['a'] },
  visited: [{ key: 'v', title: 'Old quake', lat: 35, lon: 139 }],
  next: [
    { key: 'b', title: 'Storm', lat: -30, lon: 150, rank: 1, prediction: 'candidate' },
    { key: 'c', title: 'Fire', lat: 40, lon: -120, rank: 2, prediction: 'candidate' },
  ],
  ...extra,
});

test('the shot on screen is the one blinking red dot; other stops are faded red', async (t) => {
  const { store, root } = mount(t);
  store.publish(model());
  await nextTick();
  const current = root().querySelectorAll('.wo-point--current');
  assert.equal(current.length, 1);
  assert.equal(root().querySelectorAll('.wo-point--next').length, 2);
  assert.equal(root().querySelectorAll('.wo-point--visited').length, 1);
  assert.match(root().querySelector('.wo-status').textContent, /LIKELY NEXT: 2/);
  assert.match(root().querySelector('.wo-badge').textContent, /AUTO/);
});

test('likely next stops are labelled as such, never as a committed route', async (t) => {
  const { store, root } = mount(t);
  store.publish(model());
  await nextTick();
  const labels = [...root().querySelectorAll('.wo-point--next')].map((c) => c.getAttribute('aria-label'));
  assert.ok(labels.every((l) => l.startsWith('LIKELY NEXT')));
  assert.equal(root().querySelectorAll('.wo-route--next').length, 1, 'only one dashed hop, to the first candidate');
});

test('markers are keyboard reachable and a click asks to show the event', async (t) => {
  const { store, calls, root } = mount(t);
  store.publish(model());
  await nextTick();
  const current = root().querySelector('.wo-point--current');
  assert.equal(current.getAttribute('tabindex'), '0');
  assert.equal(current.getAttribute('role'), 'button');
  assert.match(current.getAttribute('aria-label'), /NOW · Flood in the delta/);
  current.dispatchEvent(new Event('click'));
  assert.deepEqual(calls, [['select', 'a']]);
  assert.match(root().querySelector('svg').getAttribute('aria-label'), /Now: Flood in the delta/);
});

test('the camera is drawn apart from the target', async (t) => {
  const { store, root } = mount(t);
  store.publish(model());
  store.publishCamera({ x: 0.9, y: 0.4, heading: 45 });
  await nextTick();
  const camera = root().querySelector('.wo-camera');
  assert.match(camera.getAttribute('transform'), /rotate\(45\)/);
  assert.match(camera.getAttribute('transform'), /translate\(900\.0 400\.0\)/);
});

test('regional, beyond the map, demo and paused are said, not hidden', async (t) => {
  const { store, root } = mount(t);
  store.publish(
    model({
      demo: true,
      mode: 'paused',
      current: { key: 'r', title: 'Drought', lat: 35, lon: 105, regional: true, eventIds: ['r'] },
      visited: [{ key: 'n', title: 'Arctic', lat: 82, lon: 30 }],
      next: [],
      unplaced: 2,
    }),
  );
  await nextTick();
  const current = root().querySelector('.wo-point--current');
  assert.ok(current.classList.contains('wo-point--regional'));
  assert.match(current.getAttribute('aria-label'), /REGIONAL · DEMO/);
  assert.match(root().querySelector('.wo-point--visited').getAttribute('aria-label'), /beyond the edge/);
  assert.ok(root().querySelector('.wo-badge--demo'));
  assert.match(root().querySelector('.wo-badge').textContent, /PAUSED/);
  assert.match(root().querySelector('.wo-note').textContent, /2 without a map position/);
});

test('no targets and unknown position are stated', async (t) => {
  const { store, root } = mount(t);
  store.publish(model({ current: null, next: [], status: 'no_targets' }));
  await nextTick();
  assert.match(root().querySelector('.wo-status').textContent, /NO TARGETS/);
  store.publish(model({ status: 'unknown_position' }));
  await nextTick();
  assert.match(root().querySelector('.wo-status').textContent, /POSITION UNKNOWN/);
});

test('hiding the map removes it and keeps the header', async (t) => {
  const { store, root } = mount(t);
  store.publish(model());
  await nextTick();
  root().querySelector('.wo-toggle').click();
  await nextTick();
  assert.equal(root().querySelector('svg'), null);
  assert.ok(root().querySelector('.world-overview__head'));
  assert.equal(root().querySelector('.wo-toggle').getAttribute('aria-expanded'), 'false');
  root().querySelector('.wo-toggle').click();
  await nextTick();
  assert.ok(root().querySelector('svg'));
});

test('the status wraps onto its own line rather than being cut off', async (t) => {
  const { store, root } = mount(t);
  store.publish(model({ demo: true }));
  await nextTick();
  const label = root().querySelector('.world-overview__label');
  assert.ok(label.contains(root().querySelector('.wo-status')), 'status shares the wrapping label with title and badges');
  assert.ok(!label.contains(root().querySelector('.wo-toggle')), 'the toggle stays on the first line, outside the wrap');
  store.publish(model({ next: [], status: 'ready' }));
  await nextTick();
  assert.equal(root().querySelector('.wo-status'), null, 'no empty status takes up a line');
  const css = readFileSync(new URL('../../styles/intel.css', import.meta.url), 'utf8');
  const rule = /\.wo-status \{([^}]*)\}/.exec(css)[1];
  assert.doesNotMatch(rule, /text-overflow:\s*ellipsis/);
  assert.doesNotMatch(rule, /white-space:\s*nowrap/);
});
