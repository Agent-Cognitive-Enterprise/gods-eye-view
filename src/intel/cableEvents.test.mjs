import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cableRecord,
  liveRecords,
  publishKey,
  representativePoint,
} from './cableEvents.js';
import {
  cableRouteTargets,
  mergedCableFeatures,
  routeLines,
  routeFor,
} from './cableRoutes.js';
import { createIntelEngine } from './engine.js';
import { createMemoryIntelStore } from './memoryStore.js';
import { FAULT_FADE_MS } from './cableSignals.js';

const feature = {
  type: 'Feature',
  properties: { id: 'c-lion1', name: 'C-Lion1' },
  geometry: {
    type: 'MultiLineString',
    coordinates: [
      [
        [24.9, 60.1],
        [22.0, 59.5],
        [19.0, 57.5],
        [15.0, 55.5],
        [12.1, 54.2],
      ],
      [
        [24.9, 60.1],
        [24.5, 59.9],
      ],
    ],
  },
};
const features = new Map([['c-lion1', feature]]);
const publisherOf = (id) => (id === 'cinia-news' ? 'Cinia' : id);
const open = {
  cableId: 'c-lion1',
  status: 'open',
  openedAt: '2026-11-18T02:04:00.000Z',
  lastReportedAt: '2026-11-18T02:04:00.000Z',
  breakConfirmed: false,
  sourceId: 'cinia-news',
  sources: ['https://www.cinia.fi/en/news/fault'],
};

test('a cable incident is placed on its longest segment, at sea', () => {
  assert.deepEqual(representativePoint(feature), { lat: 57.5, lon: 19.0 });
  assert.equal(representativePoint({ geometry: null }), null);
});

test('an open incident becomes one primary-official record of a cable fault', () => {
  const record = cableRecord({
    cableId: 'c-lion1',
    incident: open,
    feature,
    publisher: 'Cinia',
  });
  assert.equal(record.provider, 'cables');
  assert.equal(record.source_type, 'primary_official');
  assert.equal(record.category, 'infrastructure_disruption');
  assert.equal(record.subtype, 'submarine_cable_fault');
  assert.equal(record.status_hint, 'ongoing');
  assert.equal(
    record.event_key,
    'submarine-cable:c-lion1:2026-11-18T02:04:00.000Z',
  );
  assert.equal(
    record.valid_until,
    Date.parse(open.lastReportedAt) + FAULT_FADE_MS,
  );
  assert.deepEqual(record.entities, ['cable:c-lion1']);
  assert.match(record.title, /C-Lion1 submarine cable fault, Cinia reports/);
  assert.match(record.summary, /does not by itself mean the cable is cut/);
  const cut = cableRecord({
    cableId: 'c-lion1',
    incident: { ...open, breakConfirmed: true },
    feature,
    publisher: 'Cinia',
  });
  assert.equal(cut.subtype, 'submarine_cable_break');
  const closed = cableRecord({
    cableId: 'c-lion1',
    incident: {
      ...open,
      status: 'closed',
      closedAt: '2026-11-28T10:00:00.000Z',
    },
    feature,
    publisher: 'Cinia',
  });
  assert.equal(closed.status_hint, 'resolved');
  assert.equal('valid_until' in closed, false);
  // Without a route there is nowhere to put it.
  assert.equal(
    cableRecord({
      cableId: 'x',
      incident: open,
      feature: undefined,
      publisher: 'Cinia',
    }),
    null,
  );
});

test('a record goes out only when what an operator sees changes', () => {
  const first = liveRecords({
    incidents: { 'c-lion1': open },
    features,
    publisherOf,
  });
  assert.equal(first.records.length, 1);
  const published = first.keys;
  // Nothing new: nothing sent.
  assert.equal(
    liveRecords({
      incidents: { 'c-lion1': open },
      published,
      features,
      publisherOf,
    }).records.length,
    0,
  );
  // A new report, then a repair.
  const updated = {
    ...open,
    lastReportedAt: '2026-11-20T08:00:00.000Z',
    sources: [...open.sources, 'https://www.cinia.fi/en/news/update'],
  };
  const second = liveRecords({
    incidents: { 'c-lion1': updated },
    published,
    features,
    publisherOf,
  });
  assert.equal(second.records.length, 1);
  assert.equal(second.records[0].status_hint, 'ongoing');
  const closed = {
    ...updated,
    status: 'closed',
    closedAt: '2026-11-28T10:00:00.000Z',
  };
  const third = liveRecords({
    incidents: { 'c-lion1': closed },
    published: second.keys,
    features,
    publisherOf,
  });
  assert.equal(third.records[0].status_hint, 'resolved');
  assert.equal(third.records[0].event_key, first.records[0].event_key);
});

test('a repair of an incident never sent, a fade or an older incident sends nothing', () => {
  const closedOnly = {
    ...open,
    status: 'closed',
    closedAt: '2026-11-28T10:00:00.000Z',
  };
  const none = liveRecords({
    incidents: { 'c-lion1': closedOnly },
    features,
    publisherOf,
  });
  assert.deepEqual(none.records, []);
  assert.equal(none.keys['c-lion1'].key, publishKey(closedOnly));
  const faded = liveRecords({
    incidents: {
      'c-lion1': {
        ...open,
        status: 'faded',
        fadedAt: '2026-12-18T00:00:00.000Z',
      },
    },
    published: {
      'c-lion1': {
        key: publishKey(open),
        openedAt: open.openedAt,
        status: 'open',
      },
    },
    features,
    publisherOf,
  });
  assert.deepEqual(faded.records, []);
  // The repair of a newer incident does not close the one that was shown.
  const newer = { ...closedOnly, openedAt: '2026-12-01T00:00:00.000Z' };
  assert.deepEqual(
    liveRecords({
      incidents: { 'c-lion1': newer },
      published: {
        'c-lion1': {
          key: publishKey(open),
          openedAt: open.openedAt,
          status: 'open',
        },
      },
      features,
      publisherOf,
    }).records,
    [],
  );
});

test('through the engine: an officially reported event for 30 days, closed by the repair', () => {
  let clock = Date.parse('2026-11-18T03:00:00Z');
  const engine = createIntelEngine({
    store: createMemoryIntelStore(),
    now: () => clock,
  });
  const first = liveRecords({
    incidents: { 'c-lion1': open },
    features,
    publisherOf,
  });
  engine.ingest(first.records);
  const [event] = engine.activeEvents();
  assert.equal(event.verification, 'officially_reported');
  assert.equal(event.subtype, 'submarine_cable_fault');
  assert.ok(
    event.expires_at >= Date.parse(open.lastReportedAt) + FAULT_FADE_MS - 1000,
  );
  // Still shown 20 days later, beyond the category's usual day.
  clock += 20 * 24 * 3600_000;
  assert.equal(engine.activeEvents().length, 1);
  // A nearby news item does not join it.
  engine.ingest([
    {
      provider: 'fixture',
      source_item_id: 'news-1',
      publisher: 'Outlet',
      source_type: 'secondary_reporting',
      url: 'https://news.example/a',
      category: 'infrastructure_disruption',
      title: 'C-Lion1 submarine cable fault',
      published_at: clock,
      location: { lat: 57.5, lon: 19.0, precision: 'point' },
    },
  ]);
  assert.equal(
    engine.activeEvents().find((e) => e.subtype === 'submarine_cable_fault')
      .lineages.length,
    1,
  );
  const closed = {
    ...open,
    status: 'closed',
    closedAt: new Date(clock).toISOString(),
  };
  engine.ingest(
    liveRecords({
      incidents: { 'c-lion1': closed },
      published: first.keys,
      features,
      publisherOf,
    }).records,
  );
  const ended = engine
    .activeEvents()
    .find((e) => e.subtype === 'submarine_cable_fault');
  assert.equal(ended.verification, 'resolved');
  assert.equal(ended.lifecycle, 'resolved');
  // An hour later it is archived.
  clock += 2 * 3600_000;
  assert.equal(
    engine.activeEvents().some((e) => e.subtype === 'submarine_cable_fault'),
    false,
  );
});

test('the globe highlights only cable-feed events that are shown', () => {
  const event = (overrides) => ({
    subtype: 'submarine_cable_fault',
    providers: ['cables'],
    entities: ['cable:c-lion1'],
    lifecycle: 'active',
    opacity: 1,
    verification: 'officially_reported',
    ...overrides,
  });
  assert.deepEqual(
    [...cableRouteTargets([event({})])],
    [['c-lion1', { opacity: 1, resolved: false }]],
  );
  assert.equal(cableRouteTargets([event({ providers: ['gdelt'] })]).size, 0);
  assert.equal(cableRouteTargets([event({ subtype: 'power_outage' })]).size, 0);
  assert.equal(cableRouteTargets([event({ lifecycle: 'archived' })]).size, 0);
  assert.equal(
    cableRouteTargets([event({ entities: ['cable:../x'] })]).size,
    0,
  );
  assert.equal(
    cableRouteTargets([event({ verification: 'resolved', opacity: 0.35 })]).get(
      'c-lion1',
    ).resolved,
    true,
  );
});

test('routes are split at the antimeridian, and a cable listed twice is one route', () => {
  assert.deepEqual(
    routeLines({
      geometry: {
        type: 'LineString',
        coordinates: [
          [179, 0],
          [179.5, 1],
          [-179.5, 2],
          [-179, 3],
        ],
      },
    }),
    [
      [
        [179, 0],
        [179.5, 1],
      ],
      [
        [-179.5, 2],
        [-179, 3],
      ],
    ],
  );
  const merged = mergedCableFeatures({
    features: [
      {
        properties: { id: 'topaz' },
        geometry: {
          type: 'LineString',
          coordinates: [
            [0, 0],
            [1, 1],
          ],
        },
      },
      {
        properties: { id: 'topaz' },
        geometry: {
          type: 'LineString',
          coordinates: [
            [2, 2],
            [3, 3],
          ],
        },
      },
    ],
  });
  assert.equal(merged.get('topaz').geometry.coordinates.length, 2);
});

test('an earlier-dated report keeps the incident, and its event, the same (review round 1)', () => {
  const first = liveRecords({
    incidents: { 'c-lion1': { ...open, incidentId: open.openedAt } },
    features,
    publisherOf,
  });
  // A later report dates the fault a day earlier: openedAt moves, the id does not.
  const backdated = {
    ...open,
    incidentId: open.openedAt,
    openedAt: '2026-11-17T00:00:00.000Z',
    lastReportedAt: '2026-11-19T00:00:00.000Z',
  };
  const second = liveRecords({
    incidents: { 'c-lion1': backdated },
    published: first.keys,
    features,
    publisherOf,
  });
  assert.equal(second.records[0].event_key, first.records[0].event_key);
  // Backdated and repaired in one poll: the repair still closes it.
  const closed = {
    ...backdated,
    status: 'closed',
    closedAt: '2026-11-25T00:00:00.000Z',
  };
  const third = liveRecords({
    incidents: { 'c-lion1': closed },
    published: first.keys,
    features,
    publisherOf,
  });
  assert.equal(third.records[0].status_hint, 'resolved');
  assert.equal(third.records[0].event_key, first.records[0].event_key);
});

test('after a lost shadow state, a later repair notice still closes the shown event', () => {
  const first = liveRecords({
    incidents: { 'c-lion1': open },
    features,
    publisherOf,
  });
  // The state was reset: the repair is a marker with no incident behind it.
  const marker = {
    cableId: 'c-lion1',
    openedAt: null,
    sources: ['https://www.cinia.fi/en/news/repaired'],
    status: 'closed',
    closedAt: '2026-11-25T00:00:00.000Z',
  };
  const after = liveRecords({
    incidents: { 'c-lion1': marker },
    published: first.keys,
    features,
    publisherOf,
  });
  assert.equal(after.records.length, 1);
  assert.equal(after.records[0].status_hint, 'resolved');
  assert.equal(after.records[0].event_key, first.records[0].event_key);
  // A repair dated before the shown incident's last report closes nothing.
  const early = liveRecords({
    incidents: {
      'c-lion1': { ...marker, closedAt: '2026-11-01T00:00:00.000Z' },
    },
    published: first.keys,
    features,
    publisherOf,
  });
  assert.deepEqual(early.records, []);
});

test('through the engine: a new report keeps the event on, a confirmed cut changes it', () => {
  let clock = Date.parse('2026-11-18T03:00:00Z');
  const engine = createIntelEngine({
    store: createMemoryIntelStore(),
    now: () => clock,
  });
  const first = liveRecords({
    incidents: { 'c-lion1': open },
    features,
    publisherOf,
  });
  engine.ingest(first.records);
  // 25 days later the operator reports it again and confirms a cut.
  clock += 25 * 24 * 3600_000;
  const again = {
    ...open,
    lastReportedAt: new Date(clock).toISOString(),
    breakConfirmed: true,
    sources: [...open.sources, 'https://www.cinia.fi/en/news/cut'],
  };
  const [result] = engine.ingest(
    liveRecords({
      incidents: { 'c-lion1': again },
      published: first.keys,
      features,
      publisherOf,
    }).records,
  );
  assert.equal(result.status, 'material_update');
  // 20 more days: past the first report's 30 days, still shown, now a cut.
  clock += 20 * 24 * 3600_000;
  const [event] = engine.activeEvents();
  assert.equal(event.subtype, 'submarine_cable_break');
  assert.match(event.title, /cable cut/);
});

test('a cable id cut to 80 characters in its entity still finds its route', () => {
  const long =
    'gulf-bridge-international-cable-systemmiddle-east-north-africa-cable-system-gbicsmena';
  const index = new Map([
    [
      long,
      [
        [
          [50, 26],
          [51, 25],
        ],
      ],
    ],
  ]);
  const entity = `cable:${long}`.slice(0, 80);
  const [id] = cableRouteTargets([
    {
      subtype: 'submarine_cable_fault',
      providers: ['cables'],
      entities: [entity],
      lifecycle: 'active',
      opacity: 1,
    },
  ]).keys();
  assert.deepEqual(routeFor(index, id), index.get(long));
  assert.equal(routeFor(index, 'c-lion'), null);
});
