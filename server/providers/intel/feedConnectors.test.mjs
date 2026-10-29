import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { normalizeObservation } from '../../../src/intel/evidence.js';
import { feedStatus } from './feeds.js';
import {
  countriesInText,
  countryBounds,
  countryPoint,
  iso2Of,
  usStateBounds,
} from './geography.js';
import { acledConnector } from './connectors/acled.js';
import { eonetEventToRecord } from './connectors/eonet.js';
import { gdacsConnector, gdacsItemToRecord } from './connectors/gdacs.js';
import { gdeltConnector, gdeltCsvToRecords } from './connectors/gdelt.js';
import { nwsAlertToRecord, vtecKey } from './connectors/nws.js';
import {
  reliefWebConnector,
  reliefWebDisasterToRecord,
  reliefWebUrl,
} from './connectors/reliefWeb.js';
import {
  tsunamiConnector,
  tsunamiEntryToRecord,
} from './connectors/tsunami.js';
import { whoItemToRecord } from './connectors/who.js';
import { worldBankRowsToRecords } from './connectors/worldBank.js';
import { intelConnectors } from './index.js';

const NOW = Date.parse('2026-10-29T09:00:00Z');
const valid = (record) => {
  const result = normalizeObservation(record, { receivedAt: NOW });
  assert.ok(result.ok, result.reason);
  return result.observation;
};

test('geography: home territory, representative points and names', () => {
  assert.equal(iso2Of('FRA'), 'FR');
  assert.equal(iso2Of('fr'), 'FR');
  assert.equal(iso2Of('XYZ'), null);
  const france = countryBounds('FR');
  assert.ok(france.west > -10 && france.east < 12, 'no French Guiana');
  const us = countryBounds('US');
  assert.ok(us.west > -130, 'no Alaska or Hawaii');
  const russia = countryPoint('RU');
  assert.ok(russia.lat > 50 && russia.lat < 70, 'not pulled to the pole');
  assert.deepEqual(
    countriesInText(
      'Ebola, Democratic Republic of the Congo, Kenya and Nigeria',
    ),
    ['CD', 'NG', 'KE'],
  );
  assert.deepEqual(countriesInText('Marburg - Republic of the Congo'), ['CG']);
  assert.ok(usStateBounds('fl').south < 26);
});

const GDACS_ITEM = (level, type = 'TC', extra = '') => `
  <title>${level} notification for tropical cyclone EXAMPLE-26</title>
  <description>Population affected is 4.008 million.</description>
  <link>http://www.gdacs.org/report.aspx?eventtype=${type}&amp;eventid=1001345</link>
  <pubDate>Thu, 29 Oct 2026 06:00:00 GMT</pubDate>
  <gdacs:datemodified>Thu, 29 Oct 2026 06:10:00 GMT</gdacs:datemodified>
  <gdacs:iscurrent>true</gdacs:iscurrent>
  <gdacs:fromdate>Sun, 25 Oct 2026 18:00:00 GMT</gdacs:fromdate>
  <geo:Point><geo:lat>16.4</geo:lat><geo:long>81.8</geo:long></geo:Point>
  <gdacs:bbox>71.16 97.16 3.87 29.87</gdacs:bbox>
  <gdacs:eventtype>${type}</gdacs:eventtype>
  <gdacs:alertlevel>${level}</gdacs:alertlevel>
  <gdacs:eventid>1001345</gdacs:eventid>
  <gdacs:episodeid>7</gdacs:episodeid>
  <gdacs:severity unit="km/h" value="120">Category 1</gdacs:severity>
  <gdacs:population unit="Pop74" value="4007943" />
  <gdacs:iso3>IND</gdacs:iso3>
  <gdacs:country>India</gdacs:country>${extra}`;

test('GDACS: alerts become official records; routine green items are dropped', async () => {
  const red = valid(gdacsItemToRecord(GDACS_ITEM('Red')));
  assert.equal(red.event_key, 'TC1001345');
  assert.equal(red.metrics.gdacs_alert, 'red');
  assert.equal(red.metrics.affected, 4007943, 'Pop74: people in Cat 1+ winds');
  assert.equal(red.location.region_code, 'IN');
  assert.equal(red.url.startsWith('https://'), true);
  assert.deepEqual(red.location.bounds, {
    west: 71.16,
    south: 3.87,
    east: 97.16,
    north: 29.87,
  });
  assert.equal(gdacsItemToRecord(GDACS_ITEM('Green', 'WF')), null);
  assert.ok(gdacsItemToRecord(GDACS_ITEM('Green', 'EQ')));
  assert.equal(
    gdacsItemToRecord(
      GDACS_ITEM('Orange').replace(
        '<gdacs:iscurrent>true',
        '<gdacs:iscurrent>false',
      ),
    ),
    null,
  );
  const connector = gdacsConnector();
  const out = await connector.poll({
    fetchText: async () => ({
      notModified: false,
      body: `<rss><channel><item>${GDACS_ITEM('Red')}</item><item>${GDACS_ITEM('Green', 'DR')}</item></channel></rss>`,
    }),
  });
  assert.equal(out.records.length, 1);
});

test('EONET: newest track point, wind severity and the source as lineage', () => {
  const record = eonetEventToRecord({
    id: 'EONET_1',
    title: 'Tropical Cyclone Example',
    categories: [{ id: 'severeStorms' }],
    sources: [
      {
        id: 'JTWC',
        url: 'https://www.metoc.navy.mil/jtwc/products/io0226.tcw',
      },
    ],
    geometry: [
      {
        date: '2026-10-26T00:00:00Z',
        type: 'Point',
        coordinates: [88.8, 15.3],
        magnitudeValue: 50,
        magnitudeUnit: 'kts',
      },
      {
        date: '2026-10-27T00:00:00Z',
        type: 'Point',
        coordinates: [85.8, 16],
        magnitudeValue: 100,
        magnitudeUnit: 'kts',
      },
    ],
  });
  const o = valid(record);
  assert.equal(o.subtype, 'tropical_cyclone');
  assert.equal(o.location.lon, 85.8);
  assert.equal(o.metrics.severity_hint, 75);
  assert.equal(
    o.lineage_key,
    'https://www.metoc.navy.mil/jtwc/products/io0226.tcw',
  );
  assert.equal(
    eonetEventToRecord({
      id: 'x',
      title: 'Iceberg',
      categories: [{ id: 'seaLakeIce' }],
      geometry: [],
    }),
    null,
  );
});

const nwsAlert = (overrides = {}, geometry = null) => ({
  id: 'https://api.weather.gov/alerts/urn:oid:2',
  geometry,
  properties: {
    id: 'urn:oid:2',
    status: 'Actual',
    messageType: 'Update',
    severity: 'Severe',
    certainty: 'Observed',
    urgency: 'Immediate',
    event: 'Flood Warning',
    headline: 'Flood Warning issued October 28 by NWS Melbourne FL',
    areaDesc: 'Lake, FL; Volusia, FL',
    sent: '2026-10-28T21:56:00-04:00',
    onset: '2026-10-28T21:56:00-04:00',
    ends: '2026-10-29T20:00:00-04:00',
    geocode: { UGC: ['FLC069', 'FLC127'] },
    parameters: { VTEC: ['/O.CON.KMLB.FL.W.0004.000000T0000Z-261030T0000Z/'] },
    references: [
      { identifier: 'urn:oid:1', sent: '2026-10-28T09:03:00-04:00' },
    ],
    ...overrides,
  },
});

test('NWS: VTEC ties updates together; area from polygon or states', () => {
  assert.equal(
    vtecKey('/O.CON.KMLB.FL.W.0004.000000T0000Z-261030T0000Z/'),
    'KMLB.FL.W.0004',
  );
  const byState = valid(nwsAlertToRecord(nwsAlert()));
  assert.equal(byState.event_key, '2026.KMLB.FL.W.0004');
  assert.equal(byState.location.precision, 'region');
  assert.ok(byState.location.lat > 24 && byState.location.lat < 31.5);
  assert.equal(byState.metrics.severity_hint, 60);
  const watch = nwsAlertToRecord(
    nwsAlert({
      certainty: 'Possible',
      urgency: 'Future',
      parameters: {
        VTEC: ['/O.NEW.KFGZ.FA.A.0012.000000T0000Z-261030T0000Z/'],
      },
    }),
  );
  assert.equal(watch.metrics.severity_hint, 40, 'a watch ranks under warnings');
  assert.equal(byState.status_hint, 'warning');
  assert.ok(byState.valid_until > NOW);
  const polygon = valid(
    nwsAlertToRecord(
      nwsAlert(
        {},
        {
          type: 'Polygon',
          coordinates: [
            [
              [-81.5, 28.8],
              [-81.0, 28.8],
              [-81.0, 29.2],
              [-81.5, 28.8],
            ],
          ],
        },
      ),
    ),
  );
  assert.equal(polygon.location.precision, 'city');
  assert.equal(polygon.location.lon, -81.25);
  const cancel = valid(nwsAlertToRecord(nwsAlert({ messageType: 'Cancel' })));
  assert.equal(cancel.status_hint, 'resolved');
  assert.equal(nwsAlertToRecord(nwsAlert({ status: 'Test' })), null);
  assert.equal(nwsAlertToRecord(nwsAlert({ severity: 'Moderate' })), null);
  const marine = valid(
    nwsAlertToRecord(nwsAlert({ geocode: { UGC: ['PKZ783'] } })),
  );
  assert.equal(marine.location.lat, null, 'no invented point for marine zones');
  const hazmat = nwsAlertToRecord(
    nwsAlert({ event: 'Hazardous Materials Warning' }),
  );
  assert.equal(hazmat.category, 'infrastructure_disruption');
});

const TSUNAMI_ENTRY = (category) => `
  <title>BONIN ISLANDS  JAPAN REGION</title><updated>2026-10-25T02:27:01Z</updated>
  <geo:lat>28.</geo:lat><geo:long>139.9</geo:long>
  <summary type="xhtml"><div><strong>Category:</strong> ${category}<br/><strong>Bulletin Issue Time: </strong> 2026.10.25 02:27:01 UTC <br/><strong>Preliminary Magnitude: </strong>7.0(Mwp)<br/>
  <a href="https://www.tsunami.gov/events/PHEB/2026/10/24/26297050/1/WEGM42/WEGM42.txt">View bulletin</a></div></summary>`;

test('tsunami centres: information is skipped, warnings kept, cancellation resolves', async () => {
  const meta = {
    provider: 'ptwc',
    publisher: 'NOAA Pacific Tsunami Warning Center',
  };
  assert.equal(tsunamiEntryToRecord(TSUNAMI_ENTRY('Information'), meta), null);
  const warning = valid(tsunamiEntryToRecord(TSUNAMI_ENTRY('Warning'), meta));
  assert.equal(warning.event_key, 'PHEB-26297050');
  assert.equal(warning.metrics.severity_hint, 95);
  assert.equal(warning.metrics.magnitude, 7);
  assert.equal(warning.status_hint, 'warning');
  const cancel = valid(
    tsunamiEntryToRecord(TSUNAMI_ENTRY('Cancellation'), meta),
  );
  assert.equal(cancel.event_key, warning.event_key);
  assert.equal(cancel.status_hint, 'resolved');
  const out = await tsunamiConnector('ptwc').poll({
    fetchText: async () => ({
      body: `<feed><title>x</title><updated>2026-10-25T02:27:01Z</updated><entry>${TSUNAMI_ENTRY('Advisory')}</entry></feed>`,
    }),
  });
  assert.equal(out.records[0].metrics.severity_hint, 75);
});

test('WHO DON: country-level location, recent items only', () => {
  const item = {
    Id: 'abc',
    Title: 'Ebola disease, Democratic Republic of the Congo and Kenya',
    UrlName: '2026-DON622',
    PublicationDateAndTime: '2026-10-23T15:03:45Z',
    Summary: '<p>Since the previous report...</p>',
  };
  const o = valid(whoItemToRecord(item, { now: NOW }));
  assert.equal(
    o.url,
    'https://www.who.int/emergencies/disease-outbreak-news/item/2026-DON622',
  );
  assert.equal(o.location.precision, 'country');
  assert.equal(o.location.region_code, 'CD');
  assert.match(o.location.place, /Congo/);
  assert.equal(o.summary, 'Since the previous report...');
  assert.equal(
    whoItemToRecord(
      { ...item, PublicationDateAndTime: '2026-06-01T00:00:00Z' },
      { now: NOW },
    ),
    null,
  );
  assert.equal(
    whoItemToRecord({ ...item, UrlName: '../x' }, { now: NOW }),
    null,
  );
});

test('World Bank: very high or doubled inflation, recent years, no aggregates', () => {
  const row = (iso3, year, value) => ({
    countryiso3code: iso3,
    country: { value: iso3 },
    date: String(year),
    value,
  });
  const rows = [
    row('ARG', 2025, 120),
    row('ARG', 2024, 210),
    row('ARG', 2023, 130),
    row('TUR', 2025, 25),
    row('TUR', 2024, 9),
    row('TUR', 2023, 10),
    row('TUR', 2022, 11),
    row('TUR', 2021, 12),
    row('USA', 2025, 3),
    row('USA', 2024, 4),
    row('USA', 2023, 4),
    row('SDN', 2022, 138),
    row('AFE', 2025, 90),
  ];
  const records = worldBankRowsToRecords(rows, { lastUpdated: NOW, now: NOW });
  assert.deepEqual(records.map((r) => r.event_key).sort(), [
    'cpi-ARG-2025',
    'cpi-TUR-2025',
  ]);
  const arg = valid(records.find((r) => r.event_key === 'cpi-ARG-2025'));
  assert.equal(arg.category, 'economic_stress');
  assert.equal(arg.metrics.severity_hint, 70);
});

test('ReliefWeb waits for an app name; records map OCHA types', () => {
  const off = reliefWebConnector({ appname: '' });
  assert.equal(
    feedStatus({ consecutive_failures: 0 }, off, NOW),
    'requires_credentials',
  );
  assert.match(reliefWebUrl('my-app'), /appname=my-app/);
  const o = valid(
    reliefWebDisasterToRecord({
      id: 52001,
      fields: {
        name: 'India: Cyclone Example - Oct 2026',
        status: 'alert',
        date: { created: '2026-10-26T00:00:00+00:00' },
        url: 'https://reliefweb.int/disaster/tc-2026-000001-ind',
        primary_country: { iso3: 'ind', name: 'India' },
        primary_type: { name: 'Tropical Cyclone' },
      },
    }),
  );
  assert.equal(o.subtype, 'tropical_cyclone');
  assert.equal(o.location.region_code, 'IN');
  assert.equal(o.source_type, 'secondary_reporting');
});

test('ACLED is never polled: needs a key, then blocked by terms', () => {
  const state = { consecutive_failures: 0 };
  assert.equal(
    feedStatus(state, acledConnector(), NOW),
    'requires_credentials',
  );
  assert.equal(
    feedStatus(state, acledConnector({ email: 'a@b.example', key: 'k' }), NOW),
    'blocked_by_terms',
  );
});

/** A GDELT 61-column row. */
function gdeltRow({
  id = '1',
  day = '20261029',
  root = '14',
  articles = '8',
  geoType = '4',
  added = '20261029083000',
  url = 'https://news.example/a',
} = {}) {
  const row = new Array(61).fill('');
  Object.assign(row, {
    0: id,
    1: day,
    28: root,
    30: '-6.5',
    31: '20',
    32: '3',
    33: articles,
    51: geoType,
    52: 'New Delhi, Delhi, India',
    56: '28.6',
    57: '77.2',
    59: added,
    60: url,
  });
  return row.join('\t');
}

test('GDELT: protest/violence only, enough articles, city-level, recent, aggregator', async () => {
  const csv = [
    gdeltRow(),
    gdeltRow({ id: '2', root: '07' }), // aid: not kept
    gdeltRow({ id: '3', articles: '2' }),
    gdeltRow({ id: '4', geoType: '1' }), // country centroid
    gdeltRow({ id: '5', day: '20260901' }), // old story resurfacing
    gdeltRow({ id: '6', root: '19', articles: '30' }),
  ].join('\n');
  const records = gdeltCsvToRecords(csv);
  assert.deepEqual(
    records.map((r) => r.source_item_id),
    ['6', '1'],
  );
  const o = valid(records[1]);
  assert.equal(o.source_type, 'aggregator');
  assert.match(o.title, /^Machine-coded news/);
  assert.equal(o.location.geolocation_status, 'needs_verification');

  // Poll: listing -> zip -> records; the same export is not re-read.
  const data = Buffer.from(csv);
  const deflated = zlib.deflateRawSync(data);
  const name = Buffer.from('20261029083000.export.CSV');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(deflated.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(deflated.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + deflated.length, 16);
  const zip = Buffer.concat([local, name, deflated, central, name, end]);
  const fetched = [];
  const connector = gdeltConnector();
  const poll = () =>
    connector.poll({
      fetchText: async () => ({
        body: '63782 b935 http://data.gdeltproject.org/gdeltv2/20261029083000.export.CSV.zip\n',
      }),
      fetchBytes: async (url) => {
        fetched.push(url);
        return { body: zip };
      },
    });
  assert.equal((await poll()).records.length, 2);
  assert.equal((await poll()).notModified, true);
  assert.deepEqual(fetched, [
    'https://data.gdeltproject.org/gdeltv2/20261029083000.export.CSV.zip',
  ]);
});

test('feed set: public feeds by default, GDELT opt-in, each can be switched off', () => {
  const ids = (env) => intelConnectors({ env }).map((c) => c.id);
  const base = ids({});
  for (const id of [
    'usgs-earthquakes',
    'gdacs-alerts',
    'tsunami-ptwc',
    'tsunami-ntwc',
    'nws-alerts',
    'nasa-eonet',
    'who-don',
    'worldbank-inflation',
    'reliefweb-disasters',
    'acled-conflict',
  ])
    assert.ok(base.includes(id), id);
  assert.ok(!base.includes('gdelt-events'));
  assert.ok(ids({ GEV_INTEL_GDELT: '1' }).includes('gdelt-events'));
  assert.ok(!ids({ GEV_INTEL_NWS: '0' }).includes('nws-alerts'));
});
