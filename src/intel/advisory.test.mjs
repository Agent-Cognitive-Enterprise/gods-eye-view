// Fork: advisory subtypes (the regional AIS GNSS screen) never join another
// event and never take the camera as an alert (taxonomy.ADVISORY_SUBTYPES).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createIntelEngine } from './engine.js';
import { createMemoryIntelStore } from './memoryStore.js';
import { matchCandidate } from './correlate.js';
import { AUTOPILOT_DEFAULTS, isAdvisorySubtype } from './taxonomy.js';
import { regionalGnssIntelRecords } from '../../server/providers/airsea/gnssRegionalIntel.js';

const T = Date.parse('2026-11-05T10:00:00Z');

const advisory = (lastSeenAt = T - 60_000) =>
  regionalGnssIntelRecords({
    schemaVersion: 1,
    status: 'candidate_regions',
    coverage: { feedStatus: 'healthy', stale: false },
    regions: [
      {
        id: 'regional-navigation:150:200',
        domain: 'sea',
        confidence: 'low',
        causeAssessment: 'unconfirmed',
        eventPriority: 'advisory',
        evidence: { uniqueVessels: 3, coherentTargetVessels: 3 },
        area: { south: 60, north: 61, west: 20, east: 21 },
        firstSeenAt: T - 5 * 60_000,
        lastSeenAt,
      },
    ],
  });

// News worded like the advisory itself, inside its box: without the guard
// this text overlap and distance join them into one event.
const news = (provider, n) => {
  const [record] = advisory();
  return {
    provider,
    source_item_id: `n${n}`,
    publisher: provider,
    source_type: 'secondary_reporting',
    category: 'infrastructure_disruption',
    title: record.title,
    summary: record.summary,
    occurred_at: T - 30 * 60_000,
    location: { lat: 60.6, lon: 20.4, precision: 'city' },
  };
};

function engine(settings = {}) {
  return createIntelEngine({
    store: createMemoryIntelStore(),
    now: () => T,
    settings: { ...AUTOPILOT_DEFAULTS, autopilotEnabled: true, ...settings },
  });
}

test('the GNSS advisory subtype is an advisory', () => {
  assert.equal(isAdvisorySubtype(advisory()[0].subtype), true);
  assert.equal(isAdvisorySubtype('sea_traffic_anomaly'), false);
});

test('an advisory never corroborates a nearby news event, either way round', () => {
  const eng = engine();
  eng.ingest([news('outletA', 1), news('outletB', 2)]);
  const before = eng.activeEvents(T)[0];
  eng.ingest(advisory());
  const events = eng.activeEvents(T);
  assert.equal(events.length, 2, 'the advisory is its own event');
  const story = events.find((e) => e.event_id === before.event_id);
  assert.equal(story.lineages.length, before.lineages.length);
  assert.equal(story.confidence, before.confidence);
  assert.equal(story.critical_qualified, before.critical_qualified);
  // And a later report does not join the advisory's event.
  const reversed = engine();
  reversed.ingest(advisory());
  reversed.ingest([news('outletC', 3)]);
  assert.equal(reversed.activeEvents(T).length, 2);
});

test('an advisory may be a tour stop but never camera-eligible, even near home', () => {
  const eng = engine({
    homeLocations: [{ label: 'home', lat: 60.5, lon: 20.5 }],
    proximityEnabled: true,
  });
  eng.ingest(advisory());
  const [event] = eng.activeEvents(T);
  assert.equal(event.camera_eligible, false);
});

test('advisory refreshes keep their own event live', () => {
  const eng = engine();
  eng.ingest(advisory(T - 60_000));
  const [first] = eng.activeEvents(T);
  eng.ingest(advisory(T + 9 * 60_000));
  const [second] = eng.activeEvents(T);
  assert.equal(second.event_id, first.event_id);
  assert.ok(second.expires_at > first.expires_at);
});

test('the correlator refuses to pair an advisory with any other event', () => {
  const [record] = advisory();
  const observation = { ...record, entities: [], subtype: record.subtype };
  const event = {
    event_keys: [],
    lineage_keys: [],
    urls: [],
    category: record.category,
    subtype: 'outage',
    tokens: [],
    entities: [],
  };
  assert.equal(matchCandidate(observation, event), null);
});
