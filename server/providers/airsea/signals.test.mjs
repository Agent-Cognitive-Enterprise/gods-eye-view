import test from 'node:test';
import assert from 'node:assert/strict';
import { latLngToCell, gridDisk } from 'h3-js';
import { createIntelEngine } from '../../../src/intel/engine.js';
import { createMemoryIntelStore } from '../../../src/intel/memoryStore.js';
import {
  airSeaRecords,
  anomalyRecords,
  boxCentre,
  createAirSeaHub,
  precisionForBox,
} from './signals.js';
import { airSeaConnector } from '../intel/connectors/airsea.js';

const T = Date.parse('2026-11-20T12:00:00Z');
const gale = {
  id: 'nws:gale-1',
  sourceId: 'nws-marine',
  domain: 'marine_weather',
  warningType: 'gale_warning',
  title: 'Gale Warning — Coastal waters from Example Point to Sample Bay',
  authority: 'NWS Example',
  status: 'active',
  severity: 'danger',
  trial: false,
  publishedAtUtc: '2026-11-20T05:40:00Z',
  effectiveFromUtc: '2026-11-20T06:00:00Z',
  effectiveUntilUtc: '2026-11-21T06:00:00Z',
  geometry: { type: 'Polygon', coordinates: [] },
  bounds: [-70.5, 41.0, -69.8, 41.6],
  sourceUrl: 'https://api.weather.gov/alerts/example',
};
const correlation = (overrides = {}) => ({
  warningId: gale.id,
  domain: 'sea',
  observation: 'possible_traffic_suppression',
  changePct: -62,
  surroundingChangePct: 4,
  reference: 'matched_baseline',
  baselineAvailable: true,
  baselineWeeks: 3,
  coverageQuality: 'adequate',
  confidence: 'medium',
  corroboratingSignals: ['adjacent_corridor_increase'],
  causeAssessment: 'unconfirmed',
  observedFromUtc: '2026-11-20T06:00:00.000Z',
  observedThroughUtc: '2026-11-20T12:00:00.000Z',
  ...overrides,
});
const quiet = (domain) => ({
  domain,
  status: 'baseline_insufficient',
  cells: [],
});
const fakes = (list, correlations) => ({
  warnings: { list: () => list },
  service: {
    correlations: () => correlations,
    anomalies: ({ domain }) => quiet(domain),
  },
});

function engine() {
  let clock = T;
  const store = createMemoryIntelStore();
  return {
    engine: createIntelEngine({ store, now: () => clock }),
    at: (ms) => {
      clock = ms;
    },
  };
}

test('Gate D: a warning with a verified traffic deviation is one intelligible alert', () => {
  const { engine: e } = engine();
  const records = airSeaRecords(fakes([gale], [correlation()]));
  assert.equal(records.length, 2);
  e.ingest(records, { receivedAt: T });
  const events = e.activeEvents();
  assert.equal(events.length, 1);
  const [event] = events;
  // The official warning and the local measurement: two receipts.
  assert.equal(event.lineages.length, 2);
  assert.equal(event.verification, 'officially_reported');
  assert.equal(event.title, gale.title);
  assert.match(
    event.summary,
    /62|60% below the same hours in the past 3 weeks/,
  );
  assert.match(event.summary, /possible rerouting/);
  assert.match(event.summary, /Association is not confirmed/);
  assert.equal(event.metrics.observation, 'possible_traffic_suppression');
  assert.equal(event.metrics.warning_domain, 'marine_weather');
  assert.equal(event.camera_eligible, true);
  // The same poll again changes nothing: no storm of repeat markers.
  const again = e.ingest(airSeaRecords(fakes([gale], [correlation()])), {
    receivedAt: T + 600_000,
  });
  assert.ok(
    again.every((r) => r.status === 'duplicate'),
    JSON.stringify(again),
  );
  assert.equal(e.activeEvents().length, 1);
});

test('either arrival order gives the same card, and a later reading refreshes it', () => {
  const records = airSeaRecords(fakes([gale], [correlation()]));
  const a = engine();
  const b = engine();
  a.engine.ingest(records, { receivedAt: T });
  b.engine.ingest([...records].reverse(), { receivedAt: T });
  assert.equal(
    a.engine.activeEvents()[0].summary,
    b.engine.activeEvents()[0].summary,
  );
  // Traffic is back to normal: after two new hourly readings (no flip-flop
  // around the threshold) the card says so.
  const followed = new Map([
    [gale.id, { misses: 0, lastTo: '2026-11-20T12:00:00.000Z' }],
  ]);
  const normal = (through) =>
    airSeaRecords({
      ...fakes(
        [gale],
        [
          correlation({
            observation: 'no_material_change',
            changePct: -8,
            confidence: null,
            corroboratingSignals: [],
            observedThroughUtc: through,
          }),
        ],
      ),
      followed,
    });
  assert.deepEqual(normal('2026-11-20T13:00:00.000Z'), []);
  assert.deepEqual(normal('2026-11-20T13:00:00.000Z'), []);
  const later = normal('2026-11-20T14:00:00.000Z');
  assert.equal(later.length, 2);
  a.at(T + 2 * 3600_000);
  a.engine.ingest(later, { receivedAt: T + 2 * 3600_000 });
  const [event] = a.engine.activeEvents();
  assert.match(event.summary, /within its usual range/);
  assert.equal(event.metrics.observation, 'no_material_change');
  assert.ok(event.metrics.severity_hint <= 25);
});

test('only qualified records: no marine weather alone, no TRIAL, no degraded coverage', () => {
  const trial = { ...gale, id: 's124:x', trial: true, domain: 'maritime' };
  const aviation = {
    ...gale,
    id: 'faa:1',
    domain: 'aviation',
    severity: 'restricted',
    title: 'Temporary flight restriction',
  };
  const advisory = { ...aviation, id: 'faa:2', severity: 'advisory' };
  const records = airSeaRecords(
    fakes(
      [gale, trial, aviation, advisory],
      [
        correlation({
          coverageQuality: 'degraded',
          observation: 'inconclusive',
        }),
      ],
    ),
  );
  assert.deepEqual(
    records.map((r) => [r.source_item_id, r.subtype]),
    [['warning:faa:1', 'airspace_warning']],
  );
  // A pre-warning reference needs a large change.
  const small = airSeaRecords(
    fakes(
      [gale],
      [
        correlation({
          reference: 'pre_warning',
          changePct: -45,
          confidence: 'low',
        }),
      ],
    ),
  );
  assert.equal(small.length, 0);
});

test('14: an anomaly without a baseline never reaches the queue; clusters are one record', () => {
  assert.deepEqual(anomalyRecords(quiet('air')), []);
  const centre = latLngToCell(51.5, -0.1, 2);
  const [a, b] = gridDisk(centre, 1);
  const cell = (id, current) => ({
    cell: id,
    current,
    baseline: 100,
    changePct: current - 100,
    robustZ: -6,
    observation: 'possible_traffic_suppression',
    confidence: 'medium',
  });
  const records = anomalyRecords({
    domain: 'air',
    status: 'ok',
    weeksUsed: 3,
    confidence: 'medium',
    hour_start: T - 3600_000,
    cells: [cell(a, 20), cell(b, 30)],
  });
  assert.equal(records.length, 1);
  assert.equal(records[0].subtype, 'air_traffic_anomaly');
  assert.equal(records[0].source_type, 'analyst');
  assert.equal(records[0].metrics.cells, 2);
});

test('geometry helpers: antimeridian centre, precision from size', () => {
  assert.deepEqual(boxCentre([179, -10, -179, -8]), { lat: -9, lon: 180 });
  assert.equal(precisionForBox([-70.5, 41.0, -69.8, 41.6]), 'city');
  assert.equal(precisionForBox([-75, 38, -70, 42]), 'region');
  assert.equal(precisionForBox([-90, 20, -60, 45]), 'country');
});

test('the connector waits for the air/sea plugin, then reports it if it never starts', async () => {
  const hub = createAirSeaHub();
  const connector = airSeaConnector({ hub });
  // A poll that comes first waits for the air/sea plugin to start.
  const early = connector.poll({ now: () => T });
  const detach = hub.attach(fakes([gale], [correlation()]));
  assert.equal((await early).records.length, 2);
  detach();
  assert.equal(await hub.whenReady(10), false);
  const again = hub.attach(fakes([gale], [correlation()]));
  const result = await connector.poll({ now: () => T });
  assert.equal(result.records.length, 2);
  again();
  assert.equal(hub.ready(), false);
});

test('a reissued warning stays one event; an ended one is resolved', () => {
  const followed = new Map();
  const first = airSeaRecords({
    ...fakes([gale], [correlation()]),
    followed,
  });
  // NWS reissues the alert under a new id in the same chain.
  const reissued = { ...gale, id: 'nws:gale-2', chainId: gale.id };
  const second = airSeaRecords({
    ...fakes([reissued], [correlation({ warningId: reissued.id })]),
    followed,
  });
  assert.equal(first[0].event_key, second[0].event_key);
  assert.equal(second[1].lineage_key, `airsea:warning:${gale.id}`);
  // Cancelled: no longer listed as active; the card is resolved once.
  const ended = { ...reissued, status: 'cancelled' };
  const closing = airSeaRecords({
    warnings: {
      list: ({ includeEnded = false } = {}) => (includeEnded ? [ended] : []),
    },
    service: {
      correlations: () => [],
      anomalies: ({ domain }) => quiet(domain),
    },
    followed,
  });
  assert.equal(closing.length, 1);
  assert.equal(closing[0].status_hint, 'resolved');
  assert.equal(followed.size, 0);
});

test('a continuing anomaly stays one live event, hour after hour', () => {
  const { engine: e, at } = engine();
  const centre = latLngToCell(51.5, -0.1, 2);
  const [a, b] = gridDisk(centre, 1);
  const cell = (id) => ({
    cell: id,
    current: 20,
    baseline: 100,
    changePct: -80,
    robustZ: -8,
    observation: 'possible_traffic_suppression',
    confidence: 'medium',
  });
  for (let h = 0; h < 8; h++) {
    const hourStart = T + h * 3600_000;
    at(hourStart + 3600_000 + 60_000);
    e.ingest(
      anomalyRecords({
        domain: 'air',
        status: 'ok',
        weeksUsed: 3,
        confidence: 'medium',
        hour_start: hourStart,
        cells: [cell(a), cell(b)],
      }),
      { receivedAt: hourStart + 3600_000 + 60_000 },
    );
  }
  const live = e
    .activeEvents()
    .filter(
      (ev) =>
        ev.lifecycle !== 'archived' && ev.subtype === 'air_traffic_anomaly',
    );
  assert.equal(live.length, 1);
});
