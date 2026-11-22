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
  assert.match(sentence, /Pakistan from 2026-11-18 \(routing \(BGP\)\)/);
  assert.match(sentence, /does not say this cable caused it/);
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
    'transworld-tw1': impactFor({
      incident,
      countries: ['PK'],
      outages: [
        outage('PK', '2026-11-18T05:00:00.000Z', '2026-11-18T12:00:00.000Z'),
      ],
      now: clock,
    }),
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
  assert.match(
    event.summary,
    /IODA \(Georgia Tech\) saw internet outage signals/,
  );
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
