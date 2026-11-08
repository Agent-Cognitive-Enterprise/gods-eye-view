import test from 'node:test';
import assert from 'node:assert/strict';
import { createBankingAccessLayer } from './index.js';
import { createBankingAccessSource } from './source.js';
import {
  countryView,
  decodeRing,
  indexCountries,
} from '../../bankingAccess/geometry.js';

// A tiny pack: a 2x2 degree square for LBN, two parts for JPN.
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

function setup({ answer = ANSWER, error = null, click = false } = {}) {
  const requests = [];
  const source = {
    getSnapshot: async (options) => {
      requests.push(options);
      if (error) throw error;
      return answer;
    },
  };
  const cards = [];
  const flights = [];
  const overlayHost = {
    setEntries: (_id, entries) => cards.push(entries),
    setVisible() {},
    clearSource() {},
    hitTest: () => null,
  };
  const dataSources = [];
  const viewer = {
    dataSources: {
      add: (d) => dataSources.push(d),
      remove: (d) => dataSources.splice(dataSources.indexOf(d), 1),
    },
    scene: { requestRender() {} },
    camera: { flyTo: (o) => flights.push(o) },
  };
  // A click harness: the real handler path, with the scene pick faked.
  const handler = { action: null };
  const clickOptions = click
    ? {
        screenSpaceEventHandlerFactory: () => ({
          setInputAction: (fn) => (handler.action = fn),
          destroy() {},
        }),
        picking: {
          resolvePickId: (picked) => picked?.id?.id ?? null,
          isOwnedByOtherLayer: () => false,
        },
        pointer: { isPointerFree: () => true },
      }
    : {};
  const layer = createBankingAccessLayer({
    source,
    storage: memoryStorage(),
    overlayHost,
    loadCountries: async () => PACK,
    ...clickOptions,
  });
  layer.init(viewer);
  return { layer, viewer, requests, cards, flights, dataSources, handler };
}

test('geometry: rings decode, the main part frames the country', () => {
  assert.deepEqual(decodeRing([1000, 2000, 500, -500], 3), [
    [1, 2],
    [1.5, 1.5],
  ]);
  const index = indexCountries(PACK);
  assert.equal(index.has('-99'), false);
  const jpn = index.get('JPN');
  assert.equal(jpn.polygons.length, 2);
  assert.deepEqual(jpn.box, { west: 135, east: 141, south: 35, north: 41 });
  const v = countryView({ west: 179, east: 180, south: 88, north: 89 });
  assert.ok(v.east <= 180 && v.north <= 89);
});

test('affected countries are drawn and listed', async () => {
  const { layer, viewer, dataSources } = setup();
  layer.enable();
  assert.equal(await layer.update(viewer), true);
  const entities = dataSources[0].entities.values;
  assert.equal(entities.length, 1);
  assert.equal(entities[0].id, 'banking-access:LBN:0');
  assert.ok(entities[0].polygon, 'filled: the reach is known');
  const row = layer.getRowControls();
  assert.match(row.info, /Countries: 1/);
  assert.match(row.info, /Active events: 1/);
  assert.equal(row.list.items[0].id, 'LBN');
  assert.equal(row.list.items[0].lead, '9.4%');
  assert.match(
    row.list.items[0].text,
    /Lebanon · withdrawal limits · Severity 4\/5/,
  );
  assert.equal(layer.getStats().count, 1);
});

test('PEOPLE mode leads with the head-count and is remembered', async () => {
  const { layer, viewer } = setup();
  layer.enable();
  await layer.update(viewer);
  layer
    .getRowControls()
    .chips.find((c) => c.id === 'mode-people')
    .onClick();
  assert.equal(layer.getRowControls().list.items[0].lead, '550K');
});

test('an unknown reach is an outline only', async () => {
  const answer = {
    ...ANSWER,
    countries: [
      country({
        affectedPeople: null,
        affectedPct: null,
        scores: { share: null, people: null },
        intensity: { share: null, people: null },
        classes: { share: 'unknown', people: 'unknown' },
      }),
    ],
  };
  const { layer, viewer, dataSources } = setup({ answer });
  layer.enable();
  await layer.update(viewer);
  const [entity] = dataSources[0].entities.values;
  // An all-but-invisible interior keeps it clickable.
  assert.ok(entity.polygon);
  assert.ok(entity.polygon.material.color.getValue().alpha < 0.05);
  assert.ok(entity.polyline);
  assert.equal(layer.getRowControls().list.items[0].lead, '?');
});

test('choosing a country flies there and shows its card', async () => {
  const paused = [];
  globalThis.__gevIntel = { voiceControl: (w) => paused.push(w) };
  try {
    const { layer, viewer, cards, flights } = setup();
    layer.enable();
    await layer.update(viewer);
    layer.setParams({ select: 'LBN' });
    assert.equal(flights.length, 1);
    assert.deepEqual(paused, ['pause']);
    const [card] = cards.at(-1);
    assert.equal(card.title, 'LEBANON · withdrawal limits');
    assert.match(card.details[0], /Affected: 550K \(9\.4% of the population\)/);
    assert.match(
      card.details[1],
      /Severity 4\/5 · Since Oct 17, 2019 · Confidence: official/,
    );
    assert.match(card.details[2], /Sources: LBCI, agbi\.example/);
    assert.equal(card.details[3], 'Estimate: Lower bound from one study.');
    assert.equal(card.details[4], 'Withdrawals capped.');
    assert.equal(layer.getStats().selected, 'LBN');
    const source = layer
      .getRowControls()
      .chips.find((c) => c.id === 'open-source');
    assert.equal(source.title, 'https://lbci.example/a');
  } finally {
    delete globalThis.__gevIntel;
  }
});

test('HISTORY asks the server for past events', async () => {
  const { layer, viewer, requests } = setup();
  layer.enable();
  await layer.update(viewer);
  assert.equal(requests.at(-1).history, false);
  layer
    .getRowControls()
    .chips.find((c) => c.id === 'history')
    .onClick();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(requests.at(-1).history, true);
});

test('news leads are listed on request, never drawn, and only http links open', async () => {
  const opened = [];
  const open = globalThis.open;
  globalThis.open = (url) => opened.push(url);
  try {
    const { layer, viewer, dataSources } = setup();
    layer.enable();
    await layer.update(viewer);
    layer
      .getRowControls()
      .chips.find((c) => c.id === 'news')
      .onClick();
    const items = layer.getRowControls().list.items;
    assert.deepEqual(
      items.map((i) => i.id),
      ['n1', 'n2'],
    );
    layer.setParams({ openNews: 'n1' });
    layer.setParams({ openNews: 'n2' });
    assert.deepEqual(opened, ['https://a.example/1']);
    assert.equal(dataSources[0].entities.values.length, 1, 'still one country');
  } finally {
    globalThis.open = open;
  }
});

test('a server without the route says so and is not retried', async () => {
  const source = createBankingAccessSource({
    fetchImpl: async () => ({ ok: false, status: 404, body: null }),
  });
  const layer = createBankingAccessLayer({
    source,
    storage: memoryStorage(),
    loadCountries: async () => PACK,
  });
  layer.init({
    dataSources: { add() {}, remove() {} },
    scene: {},
    camera: {},
  });
  layer.enable();
  assert.equal(await layer.update(), false);
  assert.equal(
    layer.getStats().error,
    'Banking access monitor is not available on this server',
  );
});

test('nothing is fetched while off; destroy removes the drawing', async () => {
  const { layer, viewer, requests, dataSources } = setup();
  assert.equal(await layer.update(viewer), false);
  assert.equal(requests.length, 0);
  layer.destroy();
  assert.equal(dataSources.length, 0);
});

test('selecting redraws nothing; changed figures refresh the card', async () => {
  const answer = structuredClone(ANSWER);
  const { layer, viewer, cards, dataSources } = setup({ answer });
  layer.enable();
  await layer.update(viewer);
  const before = dataSources[0].entities.values[0];
  layer.setParams({ select: 'LBN' });
  assert.equal(dataSources[0].entities.values[0], before, 'same entity');
  answer.countries[0].affectedPeople = 600_000;
  await layer.update(viewer);
  assert.match(cards.at(-1)[0].details[0], /600K/);
});

test('a share without a head-count is shown as a share, not as unknown', async () => {
  const answer = {
    ...ANSWER,
    countries: [country({ affectedPeople: null, affectedPct: 30 })],
  };
  const { layer, viewer, cards } = setup({ answer });
  layer.enable();
  await layer.update(viewer);
  layer.setParams({ select: 'LBN' });
  assert.equal(cards.at(-1)[0].details[0], 'Affected: 30% of the population');
});

test('a minimal class is an outline; an unknown reach beside a known one is dashed', async () => {
  const answer = {
    ...ANSWER,
    countries: [
      country({
        classes: { share: 'minimal', people: 'minimal' },
        reachUnknown: true,
      }),
    ],
  };
  const { layer, viewer, dataSources } = setup({ answer });
  layer.enable();
  await layer.update(viewer);
  const [entity] = dataSources[0].entities.values;
  // An all-but-invisible interior keeps it clickable.
  assert.ok(entity.polygon);
  assert.ok(entity.polygon.material.color.getValue().alpha < 0.05);
  assert.equal(
    entity.polyline.material.constructor.name,
    'PolylineDashMaterialProperty',
  );
});

test('clicking inside an unfilled country selects it and shows its card', async () => {
  const answer = {
    ...ANSWER,
    countries: [
      country({
        affectedPeople: null,
        affectedPct: null,
        intensity: { share: null, people: null },
        classes: { share: 'unknown', people: 'unknown' },
        reachUnknown: true,
      }),
    ],
  };
  const { layer, viewer, cards, dataSources, handler } = setup({
    answer,
    click: true,
  });
  layer.enable();
  await layer.update(viewer);
  const [interior] = dataSources[0].entities.values;
  viewer.scene.pick = () => ({ id: interior });
  handler.action({ position: { x: 10, y: 10 } });
  assert.equal(layer.getStats().selected, 'LBN');
  assert.match(cards.at(-1)[0].details[0], /Affected: not known/);
  // A click on empty globe clears it.
  viewer.scene.pick = () => undefined;
  handler.action({ position: { x: 1, y: 1 } });
  assert.equal(layer.getStats().selected, null);
});

test('overlapping events show a range; a stale lead says so; systemic is a border', async () => {
  const answer = structuredClone(ANSWER);
  Object.assign(answer.countries[0], {
    affectedPeople: 500_000,
    affectedPeopleHigh: 900_000,
    affectedPct: 9,
    affectedPctHigh: 16,
    overlapPossible: true,
    systemic: true,
  });
  Object.assign(answer.events[0], {
    stale: true,
    verifiedAt: Date.UTC(2026, 2, 1),
  });
  const { layer, viewer, cards, dataSources } = setup({ answer });
  layer.enable();
  await layer.update(viewer);
  layer.setParams({ select: 'LBN' });
  const [card] = cards.at(-1);
  assert.match(
    card.details[0],
    /Affected: 500K–900K \(9%–16% of the population\)/,
  );
  assert.match(card.details[1], /Events may overlap/);
  assert.match(card.details[2], /Not re-verified since Mar 1, 2026/);
  assert.equal(layer.getRowControls().list.items[0].lead, '9%+');
  const [entity] = dataSources[0].entities.values;
  assert.equal(entity.polyline.width.getValue(), 3, 'systemic border');
  assert.ok(
    layer
      .getRowControls()
      .legend.some((l) => /Systemic \(border\)/.test(l.label)),
  );
});

test('a systemic country with some reach unknown keeps the dash, in the systemic colour', async () => {
  const answer = {
    ...ANSWER,
    countries: [country({ systemic: true, reachUnknown: true })],
  };
  const { layer, viewer, dataSources } = setup({ answer });
  layer.enable();
  await layer.update(viewer);
  const [entity] = dataSources[0].entities.values;
  assert.equal(
    entity.polyline.material.constructor.name,
    'PolylineDashMaterialProperty',
  );
  assert.equal(entity.polyline.width.getValue(), 3);
});
