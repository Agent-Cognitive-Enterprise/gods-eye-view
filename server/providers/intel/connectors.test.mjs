import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { createIntelEngine } from '../../../src/intel/engine.js';
import { createMemoryIntelStore } from '../../../src/intel/memoryStore.js';
import { readKmlFromKmz, readPlacemarks } from './kmz.js';
import {
  ghostMapsConnector,
  parseGhostMapsDate,
  placemarkToRecord,
} from './connectors/ghostMaps.js';
import { usgsConnector, usgsFeatureToRecord } from './connectors/usgs.js';

/** Minimal single-entry ZIP (deflate), enough to exercise the reader. */
function zipOf(name, text) {
  const data = Buffer.from(text, 'utf8');
  const deflated = zlib.deflateRawSync(data);
  const nameBytes = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(deflated.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(deflated.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE(0, 42);
  const cdOffset = local.length + nameBytes.length + deflated.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + nameBytes.length, 12);
  end.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([local, nameBytes, deflated, central, nameBytes, end]);
}

const PLACEMARK = (id, type, date, lon, lat, extra = '') => `
<Placemark id="${id}"><name>${type}</name>
<description><![CDATA[<html><body><script>alert(1)</script><table><tr><td><table>
<tr><td>SHAPE</td><td>Point</td></tr>
<tr><td>AttackType</td><td>${type}</td></tr>
<tr><td>Date</td><td>${date}</td></tr>
<tr><td>Notes</td><td>Depot targeted ${extra}</td></tr>
<tr><td>Research</td><td><a href="https://news.example/item-${id}">https://news.example/item-${id}</a></td></tr>
<tr><td>Civilian Killed</td><td>2</td></tr>
<tr><td>Enemy Killed</td><td>&lt;Null&gt;</td></tr>
</table></td></tr></table></body></html>]]></description>
<Point><coordinates>${lon},${lat},0</coordinates></Point></Placemark>`;

const KML = `<?xml version="1.0"?><kml><Document>
${PLACEMARK('ID_1', 'Drone Strike', '10/27/2026 9:15:00 PM', 30.7, 46.5)}
${PLACEMARK('ID_2', 'Vandalism', '6/7/2025', -105.07, 40.41)}
<Placemark><name>Front line</name><LineString><coordinates>1,1 2,2</coordinates></LineString></Placemark>
</Document></kml>`;

test('KMZ reader inflates the KML and reads point placemarks only', () => {
  const kml = readKmlFromKmz(zipOf('doc.kml', KML));
  const placemarks = readPlacemarks(kml);
  assert.equal(placemarks.length, 2);
  assert.equal(placemarks[0].lat, 46.5);
  assert.deepEqual(placemarks[0].links, ['https://news.example/item-ID_1']);
  assert.ok(!JSON.stringify(placemarks).includes('alert(1)'));
  assert.throws(
    () => readKmlFromKmz(Buffer.from('junk junk junk junk junk')),
    /not a ZIP/,
  );
});

test('GhostMaps NULL placeholders never become titles; CamelCase types split', () => {
  const placemark = {
    name: 'NULL',
    fields: [{ label: 'Date', value: '10/18/2026' }],
    links: [],
    lat: 1,
    lon: 1,
  };
  assert.equal(placemarkToRecord(placemark, { id: 'p', version: 'v' }), null);
  const sunk = placemarkToRecord(
    { ...placemark, name: 'MerchantVesselSunk' },
    { id: 'p', version: 'v' },
  );
  assert.equal(sunk.subtype, 'merchant_vessel_sunk');
  assert.equal(sunk.title, 'MerchantVesselSunk');
});

test('GhostMaps dates are parsed as zone-less UTC', () => {
  assert.equal(
    parseGhostMapsDate('10/27/2026 9:15:00 PM'),
    Date.UTC(2026, 9, 27, 21, 15),
  );
  assert.equal(parseGhostMapsDate('6/7/2025'), Date.UTC(2025, 5, 7));
  assert.equal(
    parseGhostMapsDate('12/1/2026 12:05 AM'),
    Date.UTC(2026, 11, 1, 0, 5),
  );
  assert.equal(parseGhostMapsDate('yesterday'), null);
});

test('GhostMaps placemarks become analyst observations with lineage and casualties', () => {
  const [strike] = readPlacemarks(KML);
  const record = placemarkToRecord(strike, {
    id: 'kinetic-30d',
    version: 'abc',
  });
  assert.equal(record.category, 'armed_conflict');
  assert.equal(record.subtype, 'drone_strike');
  assert.equal(record.source_type, 'analyst');
  assert.equal(record.lineage_key, 'https://news.example/item-ID_1');
  assert.equal(record.metrics.deaths, 2);
  assert.equal(record.time_zone_known, false);
  assert.match(record.attribution, /CC BY-NC-SA 4\.0/);
});

test('GhostMaps connector ingests only new editions and old incidents archive', async () => {
  const now = Date.UTC(2026, 9, 28);
  let fileReads = 0;
  const watcher = {
    start: async () => true,
    catalog: () => ({
      commit: 'c1',
      products: [
        { id: 'kinetic-30d', version: 'v1' },
        { id: 'cip', version: 'x' },
      ],
    }),
    file: async () => {
      fileReads += 1;
      return { bytes: zipOf('doc.kml', KML) };
    },
  };
  const connector = ghostMapsConnector({ watcher });
  const first = await connector.poll();
  assert.equal(first.records.length, 2);
  assert.equal(first.latestObservationAt, Date.UTC(2026, 9, 27, 21, 15));
  const again = await connector.poll();
  assert.equal(again.records.length, 0);
  assert.equal(
    fileReads,
    1,
    'the CIP and unchanged editions are never fetched',
  );

  const engine = createIntelEngine({
    store: createMemoryIntelStore(),
    now: () => now,
  });
  engine.ingest(first.records, { receivedAt: now });
  const active = engine.activeEvents();
  assert.equal(
    active.length,
    1,
    'the 2025 incident must not appear as current',
  );
  assert.equal(active[0].verification, 'unverified');
});

const FEATURE = (overrides = {}) => ({
  id: 'us7000test',
  geometry: { coordinates: [142.4, 38.3, 20] },
  properties: {
    mag: 6.4,
    magType: 'mww',
    time: Date.UTC(2026, 9, 29, 0, 0),
    updated: Date.UTC(2026, 9, 29, 0, 10),
    url: 'https://earthquake.usgs.gov/earthquakes/eventpage/us7000test',
    title: 'M 6.4 - 50 km E of Example',
    alert: 'yellow',
    tsunami: 0,
    status: 'reviewed',
    ...overrides,
  },
});

test('USGS features map to official observations; revisions are material', async () => {
  const record = usgsFeatureToRecord(FEATURE());
  assert.equal(record.source_type, 'primary_official');
  assert.equal(record.metrics.magnitude, 6.4);
  assert.equal(usgsFeatureToRecord({ id: 1 }), null);

  let payload = { features: [FEATURE()] };
  const fetchJson = async () => ({ body: payload, notModified: false });
  const connector = usgsConnector();
  const now = Date.UTC(2026, 9, 29, 0, 15);
  const engine = createIntelEngine({
    store: createMemoryIntelStore(),
    now: () => now,
  });
  engine.ingest((await connector.poll({ fetchJson })).records, {
    receivedAt: now,
  });
  const unchanged = engine.ingest(
    (await connector.poll({ fetchJson })).records,
    { receivedAt: now },
  );
  assert.equal(unchanged[0].status, 'duplicate');
  payload = {
    features: [
      FEATURE({
        mag: 6.9,
        alert: 'orange',
        updated: Date.UTC(2026, 9, 29, 0, 14),
      }),
    ],
  };
  const revised = engine.ingest((await connector.poll({ fetchJson })).records, {
    receivedAt: now,
  });
  assert.equal(revised[0].status, 'material_update');
  assert.equal(engine.activeEvents()[0].metrics.alert_level, 'orange');
});
