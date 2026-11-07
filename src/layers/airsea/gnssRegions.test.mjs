import test from 'node:test';
import assert from 'node:assert/strict';
import { createShipGnssRegionsLayer } from './gnssRegions.js';
import { createAirSeaSource } from './source.js';

const NOW = Date.UTC(2026, 10, 7, 12);
const BALTIC = { south: 55.1, north: 55.6, west: 16.2, east: 17.1 };
const ANSWER = {
  schemaVersion: 2,
  status: 'candidate_regions',
  diagnostic: { tracked: 28_498 },
  regions: [
    {
      id: 'r1',
      sourceLocation: 'credible',
      evidence: { uniqueVessels: 5 },
      firstSeenAt: NOW - 40 * 60_000,
      lastSeenAt: NOW - 5 * 60_000,
      area: BALTIC,
    },
  ],
  recentIncidents: [
    {
      id: 'r0',
      state: 'ended',
      firstSeenAt: NOW - 5 * 3600_000,
      lastSeenAt: NOW - 4 * 3600_000,
      peakVessels: 3,
      area: { ...BALTIC, west: 18, east: 18.6 },
    },
  ],
};

function memoryStorage() {
  const map = new Map();
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
  };
}

function fakeViewer() {
  const added = [];
  const flights = [];
  return {
    added,
    flights,
    scene: {
      primitives: {
        add: (p) => (added.push(p), p),
        remove: (p) => added.splice(added.indexOf(p), 1),
      },
      requestRender() {},
    },
    camera: { flyTo: (options) => flights.push(options) },
  };
}

function setup(answer = ANSWER, { storage = memoryStorage() } = {}) {
  let calls = 0;
  const source = {
    getGnssRegions: async () => {
      calls++;
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  const layer = createShipGnssRegionsLayer({ source, storage, now: () => NOW });
  const viewer = fakeViewer();
  layer.init(viewer);
  return { layer, viewer, storage, calls: () => calls };
}

test('regions are drawn, counted and listed with their state', async () => {
  const { layer, viewer } = setup();
  layer.enable();
  assert.equal(await layer.update(viewer), true);
  assert.equal(layer.getStats().count, 1);
  const collection = viewer.added[0];
  assert.equal(collection.length, 2, 'one fill and one outline primitive');
  const row = layer.getRowControls();
  assert.match(row.info, /Regions: 1/);
  assert.match(row.info, /28,498|28 498|28498/);
  assert.deepEqual(
    row.list.items.map((i) => [i.id, i.lead]),
    [
      ['r1', ''],
      ['r0', 'ENDED'],
    ],
  );
  assert.match(row.list.items[0].text, /Vessels: 5/);
  assert.match(row.list.items[0].text, /11:20–11:55Z/);
  assert.deepEqual(
    row.legend.map((l) => l.count),
    [1, 0, 1],
  );
});

test('an ambiguous region is grey, marked and says so', async () => {
  const answer = structuredClone(ANSWER);
  answer.regions[0].sourceLocation = 'ambiguous';
  const { layer, viewer } = setup(answer);
  layer.enable();
  await layer.update(viewer);
  const [item] = layer.getRowControls().list.items;
  assert.equal(item.lead, '?');
  assert.match(item.text, /source location ambiguous/);
  assert.equal(item.color, '#a0a8b8');
});

test('an ended ambiguous incident keeps its caveat', async () => {
  const answer = structuredClone(ANSWER);
  answer.recentIncidents[0].sourceLocation = 'ambiguous';
  const { layer, viewer } = setup(answer);
  layer.enable();
  await layer.update(viewer);
  const ended = layer.getRowControls().list.items.find((i) => i.id === 'r0');
  assert.equal(ended.lead, 'ENDED ?');
  assert.match(ended.text, /source location ambiguous/);
  assert.equal(ended.color, '#a0a8b8');
});

test('a span not all today carries its dates', async () => {
  const answer = structuredClone(ANSWER);
  answer.regions[0].firstSeenAt = NOW - 3 * 24 * 3600_000;
  const { layer, viewer } = setup(answer);
  layer.enable();
  await layer.update(viewer);
  const [item] = layer.getRowControls().list.items;
  assert.match(item.text, /11-04 12:00–11-07 11:55Z/);
});

test('ended incidents can be hidden, and the choice is remembered', async () => {
  const { layer, viewer, storage } = setup();
  layer.enable();
  await layer.update(viewer);
  const outlines = () => viewer.added[0].get(1).geometryInstances.length;
  assert.equal(outlines(), 2);
  const chip = layer.getRowControls().chips.find((c) => c.id === 'ended');
  assert.equal(chip.active, true);
  chip.onClick();
  assert.deepEqual(
    layer.getRowControls().list.items.map((i) => i.id),
    ['r1'],
  );
  assert.equal(storage.map.get('gev.airsea.gnss-ship-regions.ended'), '0');
  assert.equal(outlines(), 1, 'the ended outline is gone');
  const again = setup(ANSWER, { storage });
  again.layer.enable();
  await again.layer.update(again.viewer);
  assert.equal(again.layer.getRowControls().list.items.length, 1);
});

test('choosing a region flies there and pauses the Autopilot', async () => {
  const paused = [];
  globalThis.__gevIntel = { voiceControl: (what) => paused.push(what) };
  try {
    const { layer, viewer } = setup();
    layer.enable();
    await layer.update(viewer);
    layer.setParams({ open: 'r1' });
    assert.equal(viewer.flights.length, 1);
    const rect = viewer.flights[0].destination;
    const deg = (r) => (r * 180) / Math.PI;
    assert.ok(deg(rect.west) < BALTIC.west && deg(rect.east) > BALTIC.east);
    assert.deepEqual(paused, ['pause']);
    assert.equal(layer.getStats().selected, 'r1');
    assert.equal(layer.getRowControls().list.items[0].active, true);
    layer.setParams({ open: 'nope' });
    assert.equal(viewer.flights.length, 1);
  } finally {
    delete globalThis.__gevIntel;
  }
});

test('a selection that disappears is cleared', async () => {
  const answer = structuredClone(ANSWER);
  const { layer, viewer } = setup(answer);
  layer.enable();
  await layer.update(viewer);
  layer.setParams({ open: 'r1' });
  answer.regions = [];
  await layer.update(viewer);
  assert.equal(layer.getStats().selected, null);
});

test('a server without the screen says so, and is not retried', async () => {
  const source = createAirSeaSource({
    fetchImpl: async () => ({ ok: false, status: 404 }),
  });
  const layer = createShipGnssRegionsLayer({
    source,
    storage: memoryStorage(),
  });
  const viewer = fakeViewer();
  layer.init(viewer);
  layer.enable();
  assert.equal(await layer.update(viewer), false);
  assert.equal(
    layer.getStats().error,
    'Ship GNSS screen is not enabled on this server',
  );
  assert.match(String(layer.getRowControls().info), /not enabled/);
});

test('the status line follows the screen', async () => {
  for (const [status, text] of [
    ['warming_up', /warming up/],
    ['observing', /observing/],
    ['coverage_uncertain', /coverage uncertain/],
    ['unconfigured', /AIS feed not configured/],
  ]) {
    const { layer, viewer } = setup({ ...ANSWER, status, regions: [] });
    layer.enable();
    await layer.update(viewer);
    assert.match(layer.getRowControls().info, text);
  }
});

test('nothing is fetched while the layer is off', async () => {
  const { layer, viewer, calls } = setup();
  assert.equal(await layer.update(viewer), false);
  assert.equal(calls(), 0);
  layer.destroy();
  assert.equal(viewer.added.length, 0);
});
