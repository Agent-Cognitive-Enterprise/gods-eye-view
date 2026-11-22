import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  countryCodes,
  impactFor,
  impactSentence,
  landingCountries,
  landingPoints,
} from './cableImpact.js';
import { liveRecords } from './cableEvents.js';
import { createIntelEngine } from './engine.js';
import { createMemoryIntelStore } from './memoryStore.js';

const read = (path) =>
  JSON.parse(
    readFileSync(
      new URL(`../data/local_data/${path}`, import.meta.url),
      'utf8',
    ),
  );
const cables = read('telegeography_submarine_cables/cable-geo.json');
const codes = countryCodes(read('natural_earth/countries.json'));
const points = landingPoints(
  read('telegeography_submarine_cables/landing-point-geo.json'),
  codes,
);
const featureOf = (id) => ({
  geometry: {
    type: 'MultiLineString',
    coordinates: cables.features
      .filter((f) => f.properties.id === id)
      .flatMap((f) =>
        f.geometry.type === 'LineString'
          ? [f.geometry.coordinates]
          : f.geometry.coordinates,
      ),
  },
  properties: { id, name: id },
});

test('a cable lands in the countries at the ends of its catalogue lines', () => {
  assert.deepEqual(landingCountries(featureOf('c-lion1'), points), [
    'DE',
    'FI',
  ]);
  assert.deepEqual(landingCountries(featureOf('transworld-tw1'), points), [
    'AE',
    'OM',
    'PK',
  ]);
  assert.ok(landingCountries(featureOf('seamewe-5'), points).includes('PK'));
  // Two-part names and territories are known too.
  assert.equal(codes.get('congo, dem. rep.'), 'CD');
  assert.equal(codes.get('bahamas'), 'BS');
  assert.equal(landingCountries({ geometry: null }, points).length, 0);
});

const incident = {
  cableId: 'transworld-tw1',
  status: 'open',
  incidentId: '2026-11-18T06:00:00.000Z',
  openedAt: '2026-11-18T06:00:00.000Z',
  lastReportedAt: '2026-11-18T06:00:00.000Z',
  breakConfirmed: false,
  sourceId: 'transworld',
  sources: ['https://www.tw1.com/notice'],
};
const outage = (country, start, end, datasource = 'bgp') => ({
  country,
  name: country === 'PK' ? 'Pakistan' : country,
  start,
  end,
  signals: [{ datasource, start, end }],
});

test('only outages in a landing country, during the incident, are shown beside it', () => {
  const now = Date.parse('2026-11-19T00:00:00Z');
  const outages = [
    outage('PK', '2026-11-18T05:00:00.000Z', '2026-11-18T12:00:00.000Z'),
    // Another country.
    outage('IN', '2026-11-18T05:00:00.000Z', '2026-11-18T12:00:00.000Z'),
    // Ended two days before the incident.
    outage('OM', '2026-11-15T00:00:00.000Z', '2026-11-16T00:00:00.000Z'),
    // Running for weeks before it: not "at the same time".
    outage('AE', '2026-10-20T00:00:00.000Z', '2026-11-19T00:00:00.000Z'),
  ];
  const found = impactFor({
    incident,
    countries: ['AE', 'OM', 'PK'],
    outages,
    now,
  });
  assert.deepEqual(
    found.map((f) => f.country),
    ['PK'],
  );
  assert.deepEqual(found[0].datasources, ['bgp']);
  // A closed incident gets none.
  assert.deepEqual(
    impactFor({
      incident: { ...incident, status: 'closed' },
      countries: ['PK'],
      outages,
      now,
    }),
    [],
  );
  const sentence = impactSentence(found);
  // The qualifier comes first, so a card cut after three lines keeps it.
  assert.match(
    sentence,
    /^Impact only, cause unknown: around the time of this fault IODA \(Georgia Tech\)/,
  );
  assert.match(sentence, /Pakistan on 2026-11-18/);
  assert.equal(impactSentence([]), '');
});

test('the impact goes on the card of the confirmed event, and a change updates it', () => {
  const feature = {
    ...featureOf('transworld-tw1'),
    properties: { id: 'transworld-tw1', name: 'Transworld (TW1)' },
  };
  const features = new Map([['transworld-tw1', feature]]);
  const publisherOf = () => 'Transworld';
  let clock = Date.parse('2026-11-18T07:00:00Z');
  const engine = createIntelEngine({
    store: createMemoryIntelStore(),
    now: () => clock,
  });
  const first = liveRecords({
    incidents: { 'transworld-tw1': incident },
    features,
    publisherOf,
  });
  engine.ingest(first.records);
  assert.doesNotMatch(engine.activeEvents()[0].summary, /IODA/);
  clock += 3 * 3600_000;
  const impact = {
    'transworld-tw1': {
      incidentId: incident.incidentId,
      entries: impactFor({
        incident,
        countries: ['PK'],
        outages: [
          outage('PK', '2026-11-18T05:00:00.000Z', '2026-11-18T12:00:00.000Z'),
        ],
        now: clock,
      }),
    },
  };
  const second = liveRecords({
    incidents: { 'transworld-tw1': incident },
    published: first.keys,
    features,
    publisherOf,
    impact,
  });
  assert.equal(second.records.length, 1);
  const [result] = engine.ingest(second.records);
  assert.equal(result.status, 'material_update');
  const [event] = engine.activeEvents();
  assert.match(event.summary, /^Impact only, cause unknown: around the time/);
  // Shown, but no news: the camera cooldown is not lifted.
  assert.equal(event.revision - (event.quiet_revisions ?? 0), 1);
  // Another incident on the cable gets none of it.
  const other = {
    ...incident,
    incidentId: '2026-12-01T00:00:00.000Z',
    openedAt: '2026-12-01T00:00:00.000Z',
  };
  const fresh = liveRecords({
    incidents: { 'transworld-tw1': other },
    features,
    publisherOf,
    impact,
  });
  assert.doesNotMatch(fresh.records[0].summary, /IODA/);
  // Impact changes nothing else: still the operator's fault, still one source.
  assert.equal(event.subtype, 'submarine_cable_fault');
  assert.equal(event.lineages.length, 1);
  // Nothing new: nothing sent.
  assert.equal(
    liveRecords({
      incidents: { 'transworld-tw1': incident },
      published: second.keys,
      features,
      publisherOf,
      impact,
    }).records.length,
    0,
  );
});

test('a cable landing in many countries still fits its qualifier on a three-line card', () => {
  const many = ['AE', 'DJ', 'EG', 'IN', 'OM', 'PK'].map((country) => ({
    country,
    name: `Country ${country}`,
    start: '2026-11-18T05:00:00.000Z',
    end: '2026-11-18T09:00:00.000Z',
    datasources: ['bgp'],
  }));
  const sentence = impactSentence(many);
  assert.match(sentence, /and 2 more\. $/);
  // The card wraps the summary at 60 characters on 3 lines.
  assert.match(
    sentence.slice(0, 180),
    /^Impact only, cause unknown: around the time of this fault IODA \(Georgia Tech\)/,
  );
  // Malformed stored entries are dropped, never thrown on.
  assert.equal(impactSentence([{ country: 'PK' }]), '');
});

test('an outage shows its days, and one over before the fault is not listed (review round 2)', () => {
  const now = Date.parse('2026-12-15T00:00:00Z');
  const found = impactFor({
    incident,
    countries: ['OM', 'PK'],
    outages: [
      // Two hours on the fault's first day.
      outage('PK', '2026-11-18T05:00:00.000Z', '2026-11-18T07:00:00.000Z'),
      // Began 23 hours before the fault and was over before it.
      outage('OM', '2026-11-17T08:00:00.000Z', '2026-11-17T10:00:00.000Z'),
    ],
    now,
  });
  assert.deepEqual(
    found.map((f) => f.country),
    ['PK'],
  );
  assert.match(impactSentence(found), /Pakistan on 2026-11-18\. $/);
  const long = [{ ...found[0], end: '2026-11-20T00:00:00.000Z' }];
  assert.match(impactSentence(long), /Pakistan 2026-11-18 to 2026-11-20\. $/);
});

test('switching IODA off after it showed something changes the card again', () => {
  const feature = {
    ...featureOf('transworld-tw1'),
    properties: { id: 'transworld-tw1', name: 'Transworld (TW1)' },
  };
  const features = new Map([['transworld-tw1', feature]]);
  const publisherOf = () => 'Transworld';
  let clock = Date.parse('2026-11-18T07:00:00Z');
  const engine = createIntelEngine({
    store: createMemoryIntelStore(),
    now: () => clock,
  });
  const first = liveRecords({
    incidents: { 'transworld-tw1': incident },
    features,
    publisherOf,
  });
  engine.ingest(first.records);
  const entries = impactFor({
    incident,
    countries: ['PK'],
    outages: [
      outage('PK', '2026-11-18T05:00:00.000Z', '2026-11-18T09:00:00.000Z'),
    ],
    now: clock,
  });
  const shown = liveRecords({
    incidents: { 'transworld-tw1': incident },
    published: first.keys,
    features,
    publisherOf,
    impact: { 'transworld-tw1': { incidentId: incident.incidentId, entries } },
  });
  clock += 3600_000;
  engine.ingest(shown.records);
  // IODA switched off: no impact passed any more.
  const off = liveRecords({
    incidents: { 'transworld-tw1': incident },
    published: shown.keys,
    features,
    publisherOf,
  });
  assert.equal(off.records.length, 1);
  clock += 3600_000;
  const [result] = engine.ingest(off.records);
  assert.equal(result.status, 'material_update');
  const [event] = engine.activeEvents();
  assert.doesNotMatch(event.summary, /saw internet outages/);
  assert.match(
    event.summary,
    /^IODA outage signals for Pakistan are no longer shown here\./,
  );
  // And it stays so: nothing more is sent.
  assert.equal(
    liveRecords({
      incidents: { 'transworld-tw1': incident },
      published: off.keys,
      features,
      publisherOf,
    }).records.length,
    0,
  );
});
