// S2 Underground GhostMaps incident products, read through the app's existing
// GhostMaps watcher (one repository watcher, one disk cache — no second
// scraper). Only dated incident products are ingested; the Common
// Intelligence Picture is a standing picture, not a stream of events.
//
// Licence: CC BY-NC-SA 4.0 (S2 Underground © by S2A1). Records are processed
// locally with attribution and are never redistributed by this module.
// S2 is an analyst compilation: its placemarks are `analyst` sources, and the
// cited research link is the lineage, so a news report S2 cites and that same
// news report arriving from another feed are one source, not two.

import { readKmlFromKmz, readPlacemarks } from '../kmz.js';

export const GHOSTMAPS_INCIDENT_PRODUCTS = Object.freeze([
  'kinetic-30d',
  'iran-kinetic',
]);
const ATTRIBUTION =
  'S2 GhostMaps intel products: S2 Underground © by S2A1, CC BY-NC-SA 4.0';

/** `M/D/YYYY[ h:mm[:ss] AM]` (no zone in the data) → epoch ms as UTC, or null. */
export function parseGhostMapsDate(text) {
  const match =
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M)?)?$/i.exec(
      String(text ?? '').trim(),
    );
  if (!match) return null;
  const [, month, day, year, h = '0', m = '0', s = '0', meridiem] = match;
  let hour = Number(h);
  if (meridiem) hour = (hour % 12) + (/pm/i.test(meridiem) ? 12 : 0);
  const ms = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    hour,
    Number(m),
    Number(s),
  );
  return Number.isFinite(ms) ? ms : null;
}

const CONFLICT =
  /air ?strike|missile|drone|uav|artillery|shell|rocket|bomb|explosi|ied|attack|shooting|gunfire|clash|raid|ambush|assassinat|kinetic/i;
const UNREST = /protest|riot|demonstrat|vandal|arson|unrest|looting|strike/i;

function classify(type) {
  if (CONFLICT.test(type)) return 'armed_conflict';
  if (UNREST.test(type)) return 'civil_unrest';
  return 'breaking_news';
}

const subtypeOf = (type) =>
  String(type)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 47) || null;

const fieldMap = (fields) =>
  Object.fromEntries(
    fields.map(({ label, value }) => [
      label.toLowerCase().replace(/\s+/g, ''),
      value,
    ]),
  );

const sumOf = (map, keys) => {
  const values = keys.map((key) => Number(map[key])).filter(Number.isFinite);
  return values.length ? values.reduce((a, b) => a + b, 0) : undefined;
};

/** One placemark of a dated incident product to a raw observation, or null. */
export function placemarkToRecord(placemark, product) {
  const f = fieldMap(placemark.fields);
  // ArcGIS exports write "NULL"/"<Null>" for empty cells, including names.
  const present = (value) =>
    value && !/^(?:<?null>?|n\/a|none|-)$/i.test(String(value).trim())
      ? value
      : null;
  const typed =
    present(f.attacktype) || present(f.incidenttype) || present(placemark.name);
  const type = typed || 'Incident';
  const occurredAt =
    parseGhostMapsDate(f.date) ?? parseGhostMapsDate(placemark.when);
  if (occurredAt === null) return null;
  const notes = [f.incidentname, f.description, f.notes]
    .map(present)
    .filter(Boolean)
    .join(' — ');
  if (!typed && !notes) return null; // nothing describes what happened
  const link = placemark.links[0] ?? null;
  const key = `${product.id}:${type}:${occurredAt}:${placemark.lat.toFixed(4)},${placemark.lon.toFixed(4)}`;
  return {
    provider: 'ghostmaps',
    source_item_id: `${key}@${product.version}`,
    event_key: key,
    publisher: 'S2 Underground',
    source_type: 'analyst',
    url: link,
    lineage_key: link ?? undefined,
    license: 'CC BY-NC-SA 4.0',
    attribution: ATTRIBUTION,
    language: 'en',
    category: classify(type),
    subtype: subtypeOf(type),
    title: notes ? `${type}: ${notes}` : type,
    summary: [
      notes,
      f.geolocationnotes ? `Geolocation: ${f.geolocationnotes}` : null,
    ]
      .filter(Boolean)
      .join('. '),
    occurred_at: occurredAt,
    time_zone_known: false,
    location: {
      lat: placemark.lat,
      lon: placemark.lon,
      precision: f.fullstreetaddress ? 'exact' : 'point',
      geolocation_status: 'approximate',
    },
    metrics: {
      deaths: sumOf(f, [
        'enemykilled',
        'friendlykilled',
        'civiliankilled',
        'neutralkilled',
        'unknownkilled',
      ]),
      injured: sumOf(f, [
        'enemywounded',
        'friendlywounded',
        'civilianwounded',
        'neutralwounded',
        'unknownwounded',
      ]),
    },
  };
}

/**
 * Connector over a GhostMaps watcher (`createGhostMapsWatcher`).
 * Only product editions not yet ingested are downloaded and parsed.
 */
export function ghostMapsConnector({
  watcher,
  products = GHOSTMAPS_INCIDENT_PRODUCTS,
}) {
  const ingested = new Map(); // product id -> version
  return {
    id: 'ghostmaps-incidents',
    provider: 'ghostmaps',
    url: 'https://github.com/s2underground/GhostMaps',
    intervalMs: 5 * 60_000,
    // An incident product whose newest entry is a week old is not a live feed.
    staleAfterMs: 7 * 24 * 3600_000,
    license: 'CC BY-NC-SA 4.0',
    attribution: ATTRIBUTION,
    async poll() {
      await watcher.start();
      const catalog = watcher.catalog();
      if (!catalog.commit)
        throw new Error(catalog.error || 'GhostMaps catalog unavailable');
      const records = [];
      let latest = 0;
      for (const product of catalog.products.filter((p) =>
        products.includes(p.id),
      )) {
        if (ingested.get(product.id) === product.version) continue;
        const found = await watcher.file(product.id);
        if (!found) continue;
        const placemarks = readPlacemarks(readKmlFromKmz(found.bytes));
        for (const placemark of placemarks) {
          const record = placemarkToRecord(placemark, product);
          if (!record) continue;
          records.push(record);
          latest = Math.max(latest, record.occurred_at);
        }
        ingested.set(product.id, product.version);
      }
      return {
        records,
        notModified: records.length === 0,
        latestObservationAt: latest || null,
      };
    },
  };
}
