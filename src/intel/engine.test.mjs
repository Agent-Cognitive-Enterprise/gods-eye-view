import test from 'node:test';
import assert from 'node:assert/strict';
import { createIntelEngine } from './engine.js';
import { createMemoryIntelStore } from './memoryStore.js';

const T0 = Date.parse('2026-10-29T00:00:00Z');
const MIN = 60_000;
const HOUR = 60 * MIN;

function harness(start = T0) {
  let clock = start;
  const store = createMemoryIntelStore();
  const engine = createIntelEngine({ store, now: () => clock });
  return {
    store,
    engine,
    at: (ms) => {
      clock = ms;
    },
    now: () => clock,
  };
}

const quake = (overrides = {}) => ({
  provider: 'usgs',
  source_item_id: 'us7000abcd',
  event_key: 'us7000abcd',
  publisher: 'USGS',
  source_type: 'primary_official',
  url: 'https://earthquake.usgs.gov/earthquakes/eventpage/us7000abcd',
  category: 'natural_disaster',
  subtype: 'earthquake',
  title: 'M 6.4 - 20 km S of Example',
  occurred_at: T0 - 10 * MIN,
  published_at: T0 - 5 * MIN,
  location: { lat: 38.1, lon: 142.5, precision: 'point' },
  metrics: { magnitude: 6.4, alert_level: 'yellow' },
  ...overrides,
});

const unrest = (n, overrides = {}) => ({
  provider: 'fixture',
  source_item_id: `article-${n}`,
  publisher: `Outlet ${n}`,
  source_type: 'secondary_reporting',
  url: `https://news${n}.example/article`,
  category: 'civil_unrest',
  subtype: 'large_demonstration',
  title: 'Thousands march on parliament in Example City over fuel prices',
  summary: 'Protesters gathered outside parliament demanding fuel subsidies.',
  published_at: T0 - 20 * MIN,
  location: { lat: 44.81, lon: 20.46, precision: 'city' },
  entities: ['parliament', 'example city'],
  ...overrides,
});

test('A01 baseline: one official quake becomes one officially reported event', () => {
  const { engine } = harness();
  const [result] = engine.ingest([quake()]);
  assert.equal(result.status, 'new_event');
  const [event] = engine.activeEvents();
  assert.equal(event.verification, 'officially_reported');
  assert.equal(event.lifecycle, 'active');
  assert.equal(event.camera_eligible, true);
  assert.ok(event.confidence >= 0.85);
});

test('A05: five syndicated copies of one wire report are one lineage', () => {
  const { engine } = harness();
  const wire = unrest(0, {
    publisher: 'Wire Agency',
    url: 'https://wire.example/story-1',
  });
  const copies = [1, 2, 3, 4, 5].map((n) =>
    unrest(n, {
      summary:
        n % 2
          ? wire.summary
          : 'Protesters gathered outside parliament demanding fuel subsidies today.',
      derived_from: n === 1 ? 'https://wire.example/story-1' : undefined,
      published_at: T0 - 10 * MIN + n * MIN,
    }),
  );
  engine.ingest([wire]);
  const results = engine.ingest(copies);
  assert.ok(
    results.every((r) => r.status !== 'new_event'),
    JSON.stringify(results),
  );
  const events = engine.activeEvents();
  assert.equal(events.length, 1);
  assert.equal(
    events[0].lineages.length,
    1,
    'copies must not count as corroboration',
  );
  assert.equal(events[0].verification, 'unverified');
});

test('A06: the same article republished every minute changes nothing', () => {
  const h = harness();
  h.engine.ingest([unrest(1)]);
  const before = h.engine.activeEvents()[0];
  for (let i = 1; i <= 30; i++) {
    h.at(T0 + i * MIN);
    const [result] = h.engine.ingest([
      unrest(1, { source_item_id: `repost-${i}` }),
    ]);
    assert.equal(result.status, 'duplicate');
  }
  const after = h.engine.activeEvents()[0];
  assert.equal(after.event_id, before.event_id);
  assert.equal(after.revision, before.revision);
  assert.equal(
    after.last_meaningful_update_at,
    before.last_meaningful_update_at,
  );
  assert.equal(after.duplicate_count, 30);
  assert.equal(after.expires_at, before.expires_at, 'TTL must not be renewed');
});

test('A07: a material development revises and reactivates with history kept', () => {
  const h = harness();
  h.engine.ingest([quake()]);
  const id = h.engine.activeEvents()[0].event_id;
  // Two hours later the quake is past its one-hour focus window.
  h.at(T0 + 2 * HOUR);
  assert.equal(h.engine.getEvent(id).camera_eligible, false);
  const [update] = h.engine.ingest([
    quake({
      source_item_id: 'us7000abcd-v2',
      published_at: T0 + 2 * HOUR - MIN,
      metrics: { magnitude: 6.9, alert_level: 'orange', tsunami: true },
    }),
  ]);
  assert.equal(update.status, 'material_update');
  assert.deepEqual(
    [...update.reasons].sort(),
    ['alert_level_changed', 'magnitude_revised', 'tsunami_flag'].sort(),
  );
  const event = h.engine.getEvent(id);
  assert.equal(event.revision, 2);
  assert.equal(event.camera_eligible, true);
  assert.equal(event.metrics.magnitude, 6.9);
  assert.equal(h.store.revisions(id).length, 2);
});

test('A07: an evacuation order becomes a linked consequence event', () => {
  const { engine } = harness();
  engine.ingest([quake()]);
  const [child] = engine.ingest([
    {
      provider: 'fixture',
      source_item_id: 'evac-1',
      publisher: 'Civil Defence',
      source_type: 'primary_official',
      category: 'natural_disaster',
      subtype: 'evacuation_order',
      title: 'Evacuation ordered for coastal Example after M6.4 earthquake',
      published_at: T0 - MIN,
      location: { lat: 38.2, lon: 142.4, precision: 'city' },
      entities: ['example'],
    },
  ]);
  assert.equal(child.status, 'linked_child');
  const parent = engine.getEvent(child.parent_event_id);
  assert.deepEqual(parent.links, [
    { event_id: child.event_id, relation: 'has_consequence' },
  ]);
});

test('two separate protests in one city stay separate events', () => {
  const { engine } = harness();
  engine.ingest([
    unrest(1),
    unrest(2, {
      title: 'Dock workers strike closes Example City port terminals',
      summary: 'Container traffic halted as port unions walk out.',
      entities: ['port', 'dock workers'],
      subtype: 'strike',
      location: { lat: 44.83, lon: 20.42, precision: 'city' },
    }),
  ]);
  assert.equal(engine.activeEvents().length, 2);
});

test('an independent second source corroborates', () => {
  const { engine } = harness();
  engine.ingest([unrest(1)]);
  const [result] = engine.ingest([
    unrest(2, {
      title: 'Police estimate 20,000 at Example City parliament fuel protest',
      summary: 'Demonstrators blocked the boulevard outside parliament.',
      publisher: 'Local Radio',
      source_type: 'eyewitness',
      metrics: { affected: 20000 },
    }),
  ]);
  assert.equal(result.status, 'material_update');
  assert.ok(result.reasons.includes('new_independent_source'));
  const [event] = engine.activeEvents();
  assert.equal(event.verification, 'corroborated');
  assert.equal(event.lineages.length, 2);
});

test('A10: a sensational single-source story cannot reach critical', () => {
  const { engine } = harness();
  engine.ingest([
    unrest(1, {
      category: 'armed_conflict',
      subtype: 'shelling',
      title: 'Massive strikes reported, thousands feared dead',
      metrics: { deaths: 5000, severity_hint: 99 },
      status_hint: 'evacuation',
    }),
  ]);
  const [event] = engine.activeEvents();
  assert.equal(event.verification, 'unverified');
  assert.ok(event.attention_score < 95, `score ${event.attention_score}`);
  assert.equal(event.critical_qualified, false);
});

test('A12: a marker fades over its final quarter, then archives and stays queryable', () => {
  const h = harness();
  h.engine.ingest([unrest(1)]);
  const id = h.engine.activeEvents()[0].event_id;
  const start = T0 - 20 * MIN; // last meaningful update = publication time
  h.at(start + 17 * HOUR); // 24 h TTL: fading starts at 18 h
  assert.equal(h.engine.getEvent(id).lifecycle, 'cooling');
  h.at(start + 21 * HOUR);
  const fading = h.engine.getEvent(id);
  assert.equal(fading.lifecycle, 'fading');
  assert.ok(
    fading.opacity > 0.4 && fading.opacity < 0.6,
    String(fading.opacity),
  );
  h.at(start + 24 * HOUR);
  assert.equal(h.engine.getEvent(id).lifecycle, 'archived');
  assert.equal(h.engine.activeEvents().length, 0);
  assert.equal(h.store.listEvents({ category: 'civil_unrest' }).length, 1);
});

test('an old incident arriving now is archived, not presented as new', () => {
  const { engine } = harness();
  engine.ingest([
    unrest(1, { published_at: undefined, occurred_at: T0 - 120 * 24 * HOUR }),
  ]);
  assert.equal(engine.activeEvents().length, 0);
});

test('an official retraction hides the marker; a stranger cannot retract', () => {
  const { engine } = harness();
  engine.ingest([unrest(1)]);
  const [stranger] = engine.ingest([
    unrest(3, {
      title: 'Example City parliament protest report false, says blogger',
      publisher: 'Blog',
      status_hint: 'retracted',
    }),
  ]);
  assert.equal(engine.getEvent(stranger.event_id).verification, 'disputed');
  engine.ingest([
    unrest(4, {
      title: 'Ministry: Example City parliament protest report was false',
      publisher: 'Interior Ministry',
      source_type: 'primary_official',
      status_hint: 'retracted',
    }),
  ]);
  const event = engine.getEvent(stranger.event_id);
  assert.equal(event.lifecycle, 'retracted');
  assert.equal(event.opacity, 0);
  assert.equal(engine.activeEvents().length, 0);
});

test('nationwide reports keep no invented point and stay regional', () => {
  const { engine } = harness();
  engine.ingest([
    unrest(1, {
      category: 'economic_stress',
      subtype: 'fuel_shortage',
      title: 'Nationwide fuel queues as rationing begins',
      location: { region_code: 'RS' },
    }),
  ]);
  const [event] = engine.activeEvents();
  assert.equal(event.location.lat, null);
  assert.equal(event.location.geolocation_status, 'unresolved');
  assert.equal(event.location.precision, 'country');
  assert.equal(
    event.camera_eligible,
    true,
    'regional events are framed by region',
  );
});

test('malformed records are rejected without touching state', () => {
  const { engine, store } = harness();
  const results = engine.ingest([
    null,
    { provider: 'x', source_item_id: '1', category: 'weather', title: 'bad' },
    {
      provider: 'x',
      source_item_id: '2',
      category: 'breaking_news',
      title: '',
    },
  ]);
  assert.deepEqual(
    results.map((r) => r.reasons[0]),
    ['not_object', 'bad_category', 'missing_title'],
  );
  assert.equal(store.stats().events, 0);
});

test('ingestion is deterministic regardless of batch order', () => {
  const batch = [
    quake(),
    unrest(1),
    unrest(2, {
      publisher: 'Other',
      title: 'Fuel price protest at parliament grows in Example City',
      source_type: 'eyewitness',
    }),
  ];
  const a = harness();
  const b = harness();
  a.engine.ingest(batch);
  b.engine.ingest([...batch].reverse());
  const ids = (h) =>
    h.engine
      .activeEvents()
      .map((e) => [e.event_id, e.revision, e.attention_score]);
  assert.deepEqual(ids(a), ids(b));
});

test('machine-coded (aggregator) reports never corroborate or re-alert', () => {
  const { engine } = harness();
  engine.ingest([unrest(1)]);
  const [result] = engine.ingest([
    unrest(2, {
      provider: 'gdelt',
      publisher: 'GDELT Project (machine-coded)',
      source_type: 'aggregator',
      title:
        'Machine-coded news: protest reported near Example City parliament',
      summary: 'Automatically coded from 12 news articles about fuel protest.',
    }),
  ]);
  assert.notEqual(result.status, 'material_update');
  for (const event of engine.activeEvents())
    assert.equal(event.verification, 'unverified');
});

test('a GDACS alert-level change is a material update', () => {
  const { engine } = harness();
  const gdacs = (level, id) => ({
    provider: 'gdacs',
    source_item_id: id,
    event_key: 'TC1001345',
    publisher: 'GDACS',
    source_type: 'primary_official',
    url: 'https://www.gdacs.org/report.aspx?eventtype=TC&eventid=1001345',
    category: 'natural_disaster',
    subtype: 'tropical_cyclone',
    title: `${level} notification for tropical cyclone EXAMPLE-26`,
    published_at: T0 - 10 * MIN,
    location: { lat: 16.4, lon: 81.8, precision: 'region' },
    metrics: { gdacs_alert: level.toLowerCase() },
  });
  engine.ingest([gdacs('Orange', 'TC1001345-1')]);
  const [result] = engine.ingest([gdacs('Red', 'TC1001345-2')]);
  assert.equal(result.status, 'material_update');
  assert.ok(result.reasons.includes('gdacs_alert_changed'));
  assert.ok(engine.activeEvents()[0].severity >= 95);
});

test('a copy that inherits an official lineage never overwrites official facts', () => {
  const { engine, at } = harness();
  engine.ingest([quake({ summary: 'Official USGS summary.' })]);
  const copy = (n, extra) => ({
    provider: 'fixture',
    source_item_id: `copy-${n}`,
    event_key: 'copy-9',
    publisher: 'Copy Desk',
    source_type: 'secondary_reporting',
    derived_from: quake().url,
    category: 'natural_disaster',
    subtype: 'earthquake',
    title: 'M 6.4 - 20 km S of Example',
    occurred_at: T0 - 10 * MIN,
    published_at: T0 + n * MIN,
    location: { lat: 38.1, lon: 142.5, precision: 'point' },
    ...extra,
  });
  engine.ingest([copy(1, { metrics: { magnitude: 6.4 } })]);
  at(T0 + 30 * MIN);
  engine.ingest([
    copy(2, {
      summary: 'Unconfirmed reports say thousands dead.',
      metrics: { magnitude: 7.9, alert_level: 'red', severity_hint: 85 },
    }),
  ]);
  const [event] = engine.activeEvents();
  assert.equal(event.summary, 'Official USGS summary.');
  assert.equal(event.metrics.alert_level, 'yellow');
  assert.equal(event.metrics.magnitude, 6.4);
  assert.equal(event.metrics.severity_hint, undefined);
});
