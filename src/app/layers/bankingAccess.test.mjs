// Fork: the banking layer's clicks through the real input dispatcher, its
// Cesium native-click adapter, the pick registry and the app's adapter
// (dispatcherClickHandler). The merge of upstream 76d203c8 made
// resolvePickId read the dispatcher's hit; a raw entity pick then resolved
// to no id and every click on a country cleared the selection.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBankingAccessLayer } from '../../layers/bankingAccess/index.js';
import * as picking from '../../data/pickRegistry.js';
import {
  FAKE_EVENT_TYPES as TYPES,
  FakeScreenSpaceEventHandler as FakeHandler,
  fakeInput,
} from '../../input/testDoubles.mjs';
import '../../render/cesium/nativeClick.js';
import { dispatcherClickHandler } from './bankingAccess.js';
import { loadForkEngine } from '../../fork/engine.js';

// The fork's Cesium-drawn code needs its engine (src/fork/engine.js).
await loadForkEngine();
const square = (lon, lat, size) => [
  [lon * 1000, lat * 1000, size * 1000, 0, 0, size * 1000, -size * 1000, 0],
];
const PACK = {
  meta: { decimals: 3 },
  features: [
    { name: 'Lebanon', iso: 'LBN', polygons: [square(35, 33, 2)] },
    {
      name: 'Japan',
      iso: 'JPN',
      polygons: [square(130, 30, 1), square(135, 35, 6)],
    },
    { name: 'Nowhere', iso: '-99', polygons: [square(0, 0, 1)] },
  ],
};

const country = (over = {}) => ({
  iso3: 'LBN',
  countryName: 'Lebanon',
  active: true,
  historical: false,
  type: 'withdrawal_limits',
  severity: 4,
  affectedPeople: 550_000,
  affectedPct: 9.4,
  systemic: false,
  scores: { share: 0.085, people: 495_000 },
  intensity: { share: 0.34, people: 0.42 },
  classes: { share: 'moderate', people: 'moderate' },
  decay: 1,
  updatedAt: Date.UTC(2026, 2, 1),
  eventIds: ['lbn'],
  leadEventId: 'lbn',
  reachUnknown: false,
  ...over,
});
const ANSWER = {
  countries: [country()],
  events: [
    {
      id: 'lbn',
      severity: 4,
      durationHours: 24 * 2500,
      startedAt: Date.UTC(2019, 9, 17),
      confidence: 'official',
      sourceCount: 3,
      sources: [
        { url: 'https://lbci.example/a', publisher: 'LBCI' },
        { url: 'https://lbci.example/b', publisher: 'LBCI' },
        { url: 'https://agbi.example/c' },
      ],
      affectedBasis: 'Lower bound from one study.',
      updatedAt: Date.UTC(2026, 2, 1),
      resolvedAt: null,
      summary: 'Withdrawals capped.',
    },
  ],
  counts: { active: 1 },
  problems: [],
  news: {
    enabled: true,
    candidates: [
      {
        id: 'n1',
        title: 'Bank run',
        url: 'https://a.example/1',
        domain: 'a.example',
      },
      { id: 'n2', title: 'Bad', url: 'javascript:alert(1)', domain: 'x' },
    ],
  },
};

function memoryStorage() {
  const map = new Map();
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
  };
}

function harness(pickFn) {
  const stock = new FakeHandler();
  stock.setInputAction(() => {}, TYPES.LEFT_CLICK);
  stock.setInputAction(() => {}, TYPES.LEFT_DOUBLE_CLICK);
  const dataSources = [];
  const viewer = {
    isDestroyed: () => false,
    screenSpaceEventHandler: stock,
    camera: { pickEllipsoid: () => null, flyTo() {} },
    dataSources: { add: (d) => dataSources.push(d), remove() {} },
    scene: {
      canvas: {},
      requestRender() {},
      screenSpaceCameraController: { enableInputs: true },
      pick: (...a) => pickFn(...a),
      drillPick: () => [],
    },
  };
  const { input, handler } = fakeInput(viewer, { now: () => 0 });
  return {
    viewer,
    input,
    handler,
    dataSources,
    click(x = 10, y = 10) {
      handler.fire(TYPES.LEFT_DOWN, { position: { x, y } });
      handler.fire(TYPES.LEFT_UP, { position: { x, y } });
      handler.fire(TYPES.LEFT_CLICK, { position: { x, y } });
    },
  };
}

test('a click on a country selects it; the globe, tiles and unowned items clear it', async () => {
  let picked;
  const h = harness(() => picked);
  const layer = createBankingAccessLayer({
    source: { getSnapshot: async () => ANSWER },
    storage: memoryStorage(),
    overlayHost: {
      setEntries() {},
      setVisible() {},
      clearSource() {},
      hitTest: () => null,
    },
    loadCountries: async () => PACK,
    screenSpaceEventHandlerFactory: dispatcherClickHandler,
    picking,
    pointer: { isPointerFree: () => true },
  });
  layer.init(h.viewer);
  layer.enable();
  await layer.update(h.viewer);
  const [entity] = h.dataSources[0].entities.values;
  // Polygon fill (GroundPrimitive) and outline (GroundPolylinePrimitive) both pick as the entity.
  picked = { primitive: {}, id: entity };
  h.click();
  assert.equal(layer.getStats().selected, 'LBN');
  picked = undefined;
  h.click();
  assert.equal(layer.getStats().selected, null, 'globe clears');
  picked = { primitive: {}, id: entity };
  h.click();
  assert.equal(layer.getStats().selected, 'LBN');
  picking.registerPickOwner('other', (id) => id === 'plane-1');
  picked = { primitive: { id: 'plane-1' } };
  h.click();
  assert.equal(
    layer.getStats().selected,
    'LBN',
    'owned by another layer: kept',
  );
  picked = { id: { set: 'quakes:1', id: 'quake:a' } };
  h.click();
  assert.equal(layer.getStats().selected, null, 'unowned draw item: cleared');
  picking.registerPickOwner('intel', (id) => id.startsWith('intel:'));
  picked = { primitive: {}, id: entity };
  h.click();
  picked = { primitive: {}, collection: {}, id: 'intel:abc' };
  h.click();
  assert.equal(layer.getStats().selected, 'LBN', 'intel point owned: kept');
  picked = { content: {}, primitive: { isCesium3DTileset: true } };
  h.click();
  assert.equal(layer.getStats().selected, null, 'tiles clear');
  picking.unregisterPickOwner('other');
  picking.unregisterPickOwner('intel');
  h.input.destroy();
});

test('an Autopilot point resolves to its string id through the hit', () => {
  const h = harness(() => ({
    primitive: {},
    collection: {},
    id: 'intel:ev-1',
  }));
  const seen = [];
  h.input.onClick((e) =>
    seen.push(picking.resolvePickId(e.topHit), picking.resolvePickId(e.pick)),
  );
  h.click();
  assert.deepEqual(seen, ['intel:ev-1', 'intel:ev-1']);
  h.input.destroy();
});
