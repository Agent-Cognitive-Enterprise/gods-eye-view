// NASA EONET (Earth Observatory Natural Event Tracker): open natural events
// curated from operational sources (JTWC, InciWeb/IRWIN, Smithsonian GVP...).
// EONET re-publishes those sources, so each event's lineage is its first
// source URL, not EONET itself. Public domain (NASA). No conditional requests.
//
// Kept: storms, wildfires, volcanoes, floods, landslides. Sea/lake ice and
// earthquakes (USGS is primary for those) are skipped.

import { boundsCenter } from '../geography.js';
import { boundsOf } from '../../../../src/intel/clustering.js';

export const EONET_URL =
  'https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=30&limit=500';
const MAX_EVENTS = 500;
const SUBTYPES = Object.freeze({
  severeStorms: 'severe_storm',
  wildfires: 'wildfire',
  volcanoes: 'volcano',
  floods: 'flood',
  landslides: 'landslide',
});

/** Sustained wind (knots) to a rule severity: tropical storm, hurricane, major. */
function windSeverity(kts) {
  if (!Number.isFinite(kts)) return undefined;
  if (kts >= 113) return 85;
  if (kts >= 96) return 75;
  if (kts >= 64) return 65;
  if (kts >= 34) return 45;
  return undefined;
}

/** The newest geometry's point, or the centre of its polygon. */
function placeOf(geometry) {
  if (geometry?.type === 'Point') {
    const [lon, lat] = geometry.coordinates ?? [];
    return { lat, lon, precision: 'point', bounds: undefined };
  }
  if (geometry?.type === 'Polygon') {
    const ring = (geometry.coordinates?.[0] ?? []).map(([lon, lat]) => ({
      lat,
      lon,
    }));
    const b = boundsOf(ring.filter((p) => Number.isFinite(p.lat)));
    if (!b) return null;
    const bounds = {
      west: b.west,
      south: b.south,
      east: b.east,
      north: b.north,
    };
    return { ...boundsCenter(bounds), precision: 'region', bounds };
  }
  return null;
}

/** One EONET event to a raw observation, or null when skipped. */
export function eonetEventToRecord(event) {
  const categoryId = event?.categories?.[0]?.id;
  const subtype = SUBTYPES[categoryId];
  if (!subtype || typeof event.id !== 'string' || event.closed) return null;
  const geometries = Array.isArray(event.geometry) ? event.geometry : [];
  const latest = geometries.reduce(
    (best, g) => (Date.parse(g.date) > Date.parse(best?.date ?? 0) ? g : best),
    null,
  );
  const place = placeOf(latest);
  if (!latest || !place) return null;
  const sourceUrl = event.sources?.find((s) =>
    /^https?:/.test(s.url ?? ''),
  )?.url;
  const magnitude = Number(latest.magnitudeValue);
  const unit = String(latest.magnitudeUnit ?? '');
  const kts = unit === 'kts' ? magnitude : undefined;
  const acres = /acre/i.test(unit) ? magnitude : undefined;
  const cyclone =
    subtype === 'severe_storm' &&
    /tropical|cyclone|hurricane|typhoon/i.test(event.title ?? '');
  const parts = [
    Number.isFinite(kts) ? `sustained wind ${kts} kt` : null,
    Number.isFinite(acres)
      ? `${Math.round(acres).toLocaleString('en-US')} acres`
      : null,
    `track points ${geometries.length}`,
    event.sources?.length
      ? `sources ${event.sources.map((s) => s.id).join(', ')}`
      : null,
  ].filter(Boolean);
  return {
    provider: 'eonet',
    source_item_id: `${event.id}@${latest.date}`,
    event_key: event.id,
    publisher: 'NASA EONET',
    source_type: 'secondary_reporting',
    url: sourceUrl ?? event.link,
    lineage_key: sourceUrl ?? undefined,
    license: 'Public domain (NASA)',
    attribution: 'NASA Earth Observatory Natural Event Tracker (EONET)',
    language: 'en',
    category: 'natural_disaster',
    subtype: cyclone ? 'tropical_cyclone' : subtype,
    title: event.title,
    summary: parts.join('; '),
    occurred_at: latest.date,
    published_at: latest.date,
    location: {
      lat: place.lat,
      lon: place.lon,
      precision: place.precision,
      geolocation_status: 'approximate',
      bounds: place.bounds,
    },
    metrics: {
      wind_kts: Number.isFinite(kts) ? kts : undefined,
      area_acres: Number.isFinite(acres) ? acres : undefined,
      severity_hint: windSeverity(kts),
    },
  };
}

export function eonetConnector({ url = EONET_URL } = {}) {
  return {
    id: 'nasa-eonet',
    provider: 'eonet',
    url,
    intervalMs: 30 * 60_000,
    staleAfterMs: 3 * 24 * 3600_000,
    license: 'Public domain (NASA)',
    attribution: 'NASA EONET',
    async poll({ fetchJson }) {
      const { body, notModified } = await fetchJson(url, {
        maxBytes: 4 * 1024 * 1024,
        timeoutMs: 40_000,
      });
      if (notModified) return { records: [], notModified: true };
      if (!Array.isArray(body?.events)) throw new Error('malformed EONET JSON');
      const records = body.events
        .slice(0, MAX_EVENTS)
        .map(eonetEventToRecord)
        .filter(Boolean);
      return {
        records,
        latestObservationAt: Math.max(
          0,
          ...records.map((r) => Date.parse(r.published_at) || 0),
        ),
      };
    },
  };
}
