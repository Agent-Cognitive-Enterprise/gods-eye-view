import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseS124Dataset } from '../../../src/airsea/s124.js';
import { warningStatus } from '../../../src/airsea/warnings.js';
import { airSeaProxy } from './index.js';
import { createWarningService, nwsMarineDrafts } from './warnings.js';

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
);
const read = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');
const parse = (name) =>
  parseS124Dataset(read(name), {
    sourceId: 's124-ccg-trial',
    sourceUrl: 'https://nis.ccg-gcc.gc.ca/public/rest/messages/en/s124-trial',
    idPrefix: 's124-ca:',
    fetchedFrom: name,
  });
const T = Date.parse('2026-10-30T12:00:00Z');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gev-warnings-'));

test('10: S-124 polygon: GML lat lon becomes GeoJSON lon lat, marked TRIAL', () => {
  const { draft } = parse('s124-polygon.gml');
  assert.equal(draft.id, 's124-ca:CCG.S124.CA01.C.3908.26');
  assert.equal(draft.trial, true);
  assert.equal(draft.geometry.type, 'Polygon');
  const [lon, lat] = draft.geometry.coordinates[0][0];
  assert.ok(lon < -70 && lon > -71, `lon ${lon}`);
  assert.ok(lat > 48 && lat < 49, `lat ${lat}`);
  assert.equal(draft.geometryPrecision, 'official');
  assert.match(draft.title, /Offshore Works — Grande-Anse/);
  assert.equal(draft.effectiveFromUtc, '2026-09-08T00:00:00Z');
  assert.equal(draft.effectiveUntilUtc, null, 'open-ended');
  assert.match(draft.originalText, /Drilling operations/);
});

test('10: S-124 point and line stay a point and a line (never buffered)', () => {
  const point = parse('s124-point.gml').draft;
  const pointGeometry =
    point.geometry.type === 'GeometryCollection'
      ? point.geometry.geometries.map((g) => g.type)
      : [point.geometry.type];
  assert.ok(
    pointGeometry.every((type) => type === 'Point'),
    pointGeometry.join(),
  );
  const curve = parse('s124-curve.gml').draft;
  const types =
    curve.geometry.type === 'GeometryCollection'
      ? curve.geometry.geometries.map((g) => g.type)
      : [curve.geometry.type];
  assert.ok(types.includes('LineString'), types.join());
  assert.ok(
    !types.includes('Polygon') || curve.geometryPrecision !== 'approximate',
  );
});

test('10: a stated circle is derived and checked; end dates close the day', () => {
  const circle = parse('s124-circle.gml').draft;
  assert.equal(circle.geometryPrecision, 'derived_checked');
  assert.match(circle.geometryNotes, /stated centre and radius/);
  const ending = parse('s124-dateend.gml').draft;
  assert.equal(ending.effectiveUntilUtc, '2026-11-18T23:59:59Z');
});

test('11: an S-124 cancellation message names the warning it cancels', () => {
  const { draft, cancels } = parse('s124-cancellation.gml');
  assert.ok(draft);
  assert.deepEqual(cancels, ['s124-ca:CCG.S124.CA01.C.3283.24']);
});

test('NWS marine alerts take the official zone outline', () => {
  const alerts = JSON.parse(read('nws-marine-alert.json'));
  const zone = JSON.parse(read('nws-zone-PKZ806.json'));
  const [draft] = nwsMarineDrafts(alerts, (url) =>
    url.endsWith('/PKZ806') ? zone.geometry : null,
  );
  assert.equal(draft.domain, 'marine_weather');
  assert.equal(draft.severity, 'caution', 'Gale Warning');
  assert.equal(draft.geometryPrecision, 'official');
  assert.equal(draft.geometry.type, 'MultiPolygon');
  const [noZone] = nwsMarineDrafts(alerts, () => null);
  assert.equal(noZone.geometry, null, 'no outline loaded: list record only');
  assert.match(noZone.geometryNotes, /not loaded/);
  const cancel = structuredClone(alerts);
  cancel.features[0].properties.messageType = 'Cancel';
  assert.ok(nwsMarineDrafts(cancel, () => null)[0].cancelledAtUtc);
});

test('11: lifecycle in the service: new, changed, cancelled, removed, and history', () => {
  let clock = T;
  const svc = createWarningService({
    dir: tmp(),
    now: () => clock,
    log: () => {},
  });
  const draft = (extra = {}) => ({
    id: 'nws:a',
    sourceId: 'nws-marine',
    domain: 'marine_weather',
    title: 'Gale Warning',
    effectiveFromUtc: new Date(T - 3600_000).toISOString(),
    effectiveUntilUtc: new Date(T + 6 * 3600_000).toISOString(),
    geometry: { type: 'Point', coordinates: [-160, 64] },
    ...extra,
  });
  svc.apply('nws-marine', [draft()], { complete: true, parserVersion: 't' });
  assert.equal(svc.detail('nws:a').lastChange.kind, 'new');
  assert.equal(svc.list()[0].isNew, true);
  clock += 600_000;
  svc.apply('nws-marine', [draft({ title: 'Storm Warning' })], {
    complete: true,
    parserVersion: 't',
  });
  assert.equal(svc.detail('nws:a').lastChange.kind, 'changed');
  // A newer alert supersedes it.
  svc.apply('nws-marine', [draft({ id: 'nws:b', supersedes: ['nws:a'] })], {
    complete: true,
    parserVersion: 't',
  });
  const old = svc.detail('nws:a');
  assert.equal(old.status, 'expired');
  assert.equal(old.endReason, 'superseded');
  assert.deepEqual(
    old.history.map((h) => h.kind),
    ['new', 'changed', 'expired'],
  );
  assert.deepEqual(
    svc.list().map((w) => w.id),
    ['nws:b'],
  );
  assert.equal(svc.list({ includeEnded: true }).length, 2);
});

test('11: a failing feed never ends the warnings it already reported', async () => {
  const dir = tmp();
  let fail = false;
  const svc = createWarningService({
    dir,
    now: () => T,
    log: () => {},
    fetchImpl: async () => {
      if (fail) throw new Error('network down');
      return new Response(
        JSON.stringify({
          type: 'FeatureCollection',
          features: [
            {
              id: 'https://api.weather.gov/alerts/x1',
              geometry: { type: 'Point', coordinates: [-160, 64] },
              properties: {
                id: 'x1',
                event: 'Gale Warning',
                areaDesc: 'Somewhere',
                onset: '2026-10-30T10:00:00Z',
                ends: '2026-10-31T10:00:00Z',
                affectedZones: [],
              },
            },
          ],
        }),
        { status: 200 },
      );
    },
  });
  await svc.pollSource('nws-marine');
  assert.equal(svc.list().length, 1);
  fail = true;
  await svc.pollSource('nws-marine');
  assert.equal(svc.list().length, 1, 'still active');
  const source = svc.sources().find((s) => s.id === 'nws-marine');
  assert.equal(source.status, 'degraded');
  // Restart: the warning is remembered.
  svc.stop();
  const again = createWarningService({ dir, now: () => T, log: () => {} });
  assert.equal(again.list().length, 1);
});

test('unconnected sources are reported honestly and never fetched', async () => {
  const urls = [];
  const svc = createWarningService({
    dir: tmp(),
    now: () => T,
    log: () => {},
    fetchImpl: async (url) => {
      urls.push(String(url));
      throw new Error('offline');
    },
  });
  const byId = Object.fromEntries(svc.sources().map((s) => [s.id, s]));
  assert.equal(byId['faa-notam'].status, 'permission_required');
  assert.equal(byId['airservices-naips'].status, 'permission_required');
  assert.equal(byId['eurocontrol-ead'].status, 'permission_required');
  assert.equal(byId['navarea-coordinators'].status, 'unconfigured');
  await svc.pollSource('nws-marine');
  await svc.pollSource('s124-ccg-trial');
  assert.ok(
    urls.every((u) => /api\.weather\.gov|nis\.ccg-gcc\.gc\.ca/.test(u)),
    urls.join(),
  );
  const withKeys = createWarningService({
    dir: tmp(),
    log: () => {},
    env: { FAA_NOTAM_CLIENT_ID: 'a', FAA_NOTAM_CLIENT_SECRET: 'b' },
  });
  const faa = withKeys.sources().find((s) => s.id === 'faa-notam');
  assert.equal(
    faa.status,
    'unconfigured',
    'credentials alone do not invent a feed',
  );
});

test('routes: list, detail, sources', async () => {
  const svc = createWarningService({ dir: tmp(), now: () => T, log: () => {} });
  svc.apply('s124-ccg-trial', [{ ...parse('s124-polygon.gml').draft }], {
    complete: true,
    parserVersion: 't',
  });
  const plugin = airSeaProxy({ service: { sources: () => [] }, warnings: svc });
  let handler;
  plugin.configureServer({ middlewares: { use: (_p, fn) => (handler = fn) } });
  const call = async (url) => {
    const res = {
      status: 0,
      body: '',
      writeHead(s) {
        res.status = s;
      },
      end(b = '') {
        res.body += b;
      },
    };
    await handler({ method: 'GET', url }, res);
    return { status: res.status, json: JSON.parse(res.body) };
  };
  const list = await call('/warnings');
  assert.equal(list.json.warnings.length, 1);
  assert.equal(list.json.warnings[0].trial, true);
  assert.equal(warningStatus(list.json.warnings[0], T), 'active');
  const id = encodeURIComponent(list.json.warnings[0].id);
  const detail = await call(`/warnings/${id}`);
  assert.match(detail.json.originalText, /Drilling/);
  assert.equal((await call('/warnings/nope')).status, 404);
  assert.ok((await call('/warning-sources')).json.sources.length >= 7);
});

test('one short listing ends nothing; a re-listed warning is reinstated; chains keep one id', () => {
  let clock = T;
  const svc = createWarningService({
    dir: tmp(),
    now: () => clock,
    log: () => {},
  });
  const draft = (extra = {}) => ({
    id: 'nws:a',
    sourceId: 'nws-marine',
    domain: 'marine_weather',
    title: 'Gale Warning',
    effectiveFromUtc: new Date(T - 3600_000).toISOString(),
    effectiveUntilUtc: new Date(T + 6 * 3600_000).toISOString(),
    geometry: { type: 'Point', coordinates: [-160, 64] },
    ...extra,
  });
  const listing = (drafts) =>
    svc.apply('nws-marine', drafts, { complete: true, parserVersion: 't' });
  listing([draft()]);
  // One empty answer: still in force.
  listing([]);
  assert.deepEqual(
    svc.list().map((w) => w.id),
    ['nws:a'],
  );
  // Two in a row: ended. Listed again afterwards: reinstated.
  listing([]);
  assert.equal(svc.list().length, 0);
  listing([draft()]);
  const back = svc.detail('nws:a');
  assert.equal(back.status, 'active');
  assert.equal(back.endReason, null);
  assert.equal(back.lastChange.kind, 'reinstated');
  // NWS reissues the alert under a new id: one chain.
  clock += 600_000;
  listing([draft({ id: 'nws:b', supersedes: ['nws:a'] })]);
  clock += 600_000;
  listing([draft({ id: 'nws:c', supersedes: ['nws:b'] })]);
  assert.equal(svc.list()[0].chainId, 'nws:a');
});

test('an NWS Cancel message cancels what it references and is no warning itself', () => {
  const svc = createWarningService({ dir: tmp(), now: () => T, log: () => {} });
  const alerts = (features) => ({ type: 'FeatureCollection', features });
  const feature = (id, extra = {}) => ({
    id: `https://api.weather.gov/alerts/${id}`,
    geometry: { type: 'Point', coordinates: [-160, 64] },
    properties: {
      id,
      event: 'Gale Warning',
      areaDesc: 'Somewhere',
      onset: '2026-10-30T10:00:00Z',
      ends: '2026-10-31T10:00:00Z',
      affectedZones: [],
      ...extra,
    },
  });
  const drafts = nwsMarineDrafts(
    alerts([
      feature('A'),
      feature('B', {
        messageType: 'Cancel',
        references: [{ identifier: 'A' }],
      }),
    ]),
    () => null,
  );
  svc.apply(
    'nws-marine',
    drafts.filter((d) => !d.cancel),
    {
      complete: true,
      cancels: drafts.filter((d) => d.cancel).flatMap((d) => d.supersedes),
      parserVersion: 't',
    },
  );
  assert.equal(svc.detail('nws:A').status, 'cancelled');
  assert.equal(svc.detail('nws:B'), null);
});
