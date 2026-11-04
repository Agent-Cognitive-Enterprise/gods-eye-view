// The world overview's owner: a read-only observer that publishes only real changes,
// follows the camera only while someone can see the map, and lets go of everything.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia } from 'pinia';
import { nextTick } from 'vue';
import { createWorldOverview } from './worldOverview.js';
import { useWorldOverviewStore } from './stores/worldOverview.js';

const deg = (d) => (d * Math.PI) / 180;

function harness({ visible = true, hidden = false } = {}) {
  const listeners = { postRender: new Set(), moveEnd: new Set() };
  const event = (set) => ({
    addEventListener(fn) {
      set.add(fn);
      return () => set.delete(fn);
    },
  });
  const camera = {
    positionCartographic: { latitude: deg(10), longitude: deg(20), height: 5000 },
    heading: deg(90),
    moveEnd: event(listeners.moveEnd),
  };
  const viewer = { camera, scene: { postRender: event(listeners.postRender) } };
  const docListeners = new Map();
  const documentRef = {
    hidden,
    addEventListener: (type, fn) => docListeners.set(type, fn),
    removeEventListener: (type) => docListeners.delete(type),
  };
  const store = useWorldOverviewStore(createPinia());
  store.setVisible(visible);
  let clock = 1000;
  const selected = [];
  const overview = createWorldOverview({
    viewer,
    store,
    documentRef,
    now: () => clock,
    onSelect: (id) => selected.push(id),
  });
  const publishes = { model: 0, camera: 0 };
  store.$onAction(({ name }) => {
    if (name === 'publish') publishes.model += 1;
    if (name === 'publishCamera') publishes.camera += 1;
  });
  return {
    overview,
    store,
    camera,
    listeners,
    documentRef,
    docListeners,
    selected,
    publishes,
    tick: (ms) => (clock += ms),
    render: () => [...listeners.postRender].forEach((fn) => fn()),
  };
}

const events = [
  { event_id: 'a', title: 'Flood', location: { lat: 10, lon: 20, precision: 'city' } },
  { event_id: 'b', title: 'Quake', location: { lat: -30, lon: 150, precision: 'city' } },
];
const clusters = [
  { event_ids: ['a'], center: { lat: 10, lon: 20 }, framing: 'point' },
  { event_ids: ['b'], center: { lat: -30, lon: 150 }, framing: 'point' },
];
const input = (extra = {}) => ({
  mode: 'auto',
  world: 'live',
  schedulerCurrent: { key: 'a', eventIds: ['a'] },
  clusters,
  events,
  likely: () => [clusters[1]],
  ...extra,
});

test('it publishes the model, and an identical update publishes nothing', () => {
  const h = harness();
  h.overview.update(input());
  assert.equal(h.store.model.current.key, 'a');
  assert.deepEqual(h.store.model.next.map((n) => n.key), ['b']);
  const before = h.publishes.model;
  h.overview.update(input());
  h.overview.update(input({ events: events.map((e) => ({ ...e })) }));
  assert.equal(h.publishes.model, before, 'no redraw for the same picture');
  h.overview.update(input({ mode: 'paused', schedulerCurrent: null }));
  assert.equal(h.store.model.mode, 'paused');
  h.overview.destroy();
});

test('the camera is its own value: following it never rebuilds the model', () => {
  const h = harness();
  h.overview.update(input());
  const models = h.publishes.model;
  assert.equal(h.store.camera.heading, 90);
  h.camera.positionCartographic = { latitude: deg(40), longitude: deg(-70), height: 9e6 };
  h.tick(200);
  h.render();
  assert.ok(h.store.camera.x < 0.5, 'the camera marker moved west');
  assert.equal(h.store.model.current.key, 'a', 'a zoom-out does not move the target');
  assert.equal(h.publishes.model, models);
  h.overview.destroy();
});

test('camera updates are throttled while rendering', () => {
  const h = harness();
  const start = h.publishes.camera;
  for (let i = 0; i < 20; i += 1) {
    h.camera.positionCartographic = { latitude: deg(i), longitude: deg(i), height: 1000 };
    h.tick(10);
    h.render();
  }
  assert.ok(h.publishes.camera - start <= 2, `${h.publishes.camera - start} updates in 200 ms`);
  h.overview.destroy();
});

test('nothing happens while nobody can see it, and it catches up when they can', async () => {
  const h = harness({ visible: false });
  h.overview.update(input());
  assert.equal(h.store.model, null, 'no work while off screen');
  h.camera.positionCartographic = { latitude: deg(5), longitude: deg(5), height: 1 };
  h.tick(500);
  const cameraBefore = h.publishes.camera;
  h.render();
  assert.equal(h.publishes.camera, cameraBefore);
  h.store.setVisible(true);
  await nextTick();
  assert.equal(h.store.model.current.key, 'a');
  h.documentRef.hidden = true;
  h.overview.update(input({ mode: 'paused', schedulerCurrent: null }));
  assert.equal(h.store.model.mode, 'auto', 'a hidden tab does no work');
  h.documentRef.hidden = false;
  h.docListeners.get('visibilitychange')();
  assert.equal(h.store.model.mode, 'paused');
  h.overview.destroy();
});

test('only arrivals are visited; a click asks the console to show the event', () => {
  const h = harness();
  h.overview.update(input({ schedulerCurrent: { key: 'b', eventIds: ['b'] } }));
  h.overview.visit({ key: 'a', title: 'Flood', lat: 10, lon: 20 });
  assert.deepEqual(h.store.model.visited.map((v) => v.key), ['a']);
  h.store.act('select', 'a');
  assert.deepEqual(h.selected, ['a']);
  h.overview.destroy();
});

test('the person can hide the map; it is remembered', () => {
  const h = harness();
  assert.equal(h.store.open, true);
  h.store.act('toggle');
  assert.equal(h.store.open, false);
  assert.equal(globalThis.localStorage.getItem('gev.worldOverview.open'), '0');
  h.store.act('toggle');
  h.overview.destroy();
});

test('destroy removes every listener and clears the map', () => {
  const h = harness();
  h.overview.update(input());
  h.overview.destroy();
  assert.equal(h.listeners.postRender.size, 0);
  assert.equal(h.listeners.moveEnd.size, 0);
  assert.equal(h.docListeners.size, 0);
  assert.equal(h.store.model, null);
  assert.equal(h.store.camera, null);
  assert.equal(h.store.act('select', 'a'), undefined);
});
