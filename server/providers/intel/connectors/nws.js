// U.S. National Weather Service active alerts (official, public domain):
// Severe and Extreme "Actual" alerts only. An alert's VTEC event number ties
// its updates together, so an extension or upgrade revises one event and a
// cancellation resolves it. Area: the alert polygon when given, else the
// union of the states its UGC zones name. Conditional requests supported.

import { boundsCenter, unionBounds, usStateBounds } from '../geography.js';
import { boundsOf } from '../../../../src/intel/clustering.js';

export const NWS_ALERTS_URL =
  'https://api.weather.gov/alerts/active?status=actual&severity=Extreme,Severe';
const MAX_ALERTS = 500;

const SUBTYPES = [
  [/tornado/i, 'tornado'],
  [/hurricane|tropical storm|typhoon|storm surge/i, 'tropical_cyclone'],
  [/tsunami/i, 'tsunami_warning'],
  [/flood/i, 'flood'],
  [/fire|red flag/i, 'wildfire'],
  [/blizzard|winter|ice storm|snow|lake effect/i, 'winter_storm'],
  [/heat/i, 'extreme_heat'],
  [/freeze|frost|cold|chill/i, 'extreme_cold'],
  [/earthquake/i, 'earthquake'],
  [/volcan|ashfall/i, 'volcano'],
  [/avalanche/i, 'avalanche'],
  [/dust/i, 'dust_storm'],
  [/wind|storm|thunder|hail|squall|surf|marine|gale/i, 'severe_storm'],
];
// Non-weather messages the NWS relays for emergency managers.
const CIVIL = [
  [
    /hazardous materials|nuclear|radiological|power outage|telephone outage|911/i,
    'infrastructure_disruption',
  ],
  [
    /civil|law enforcement|shelter in place|evacuation|child abduction|blue alert/i,
    'breaking_news',
  ],
];

/** "/O.CON.KMLB.FL.W.0004.000000T0000Z-261030T0000Z/" to "KMLB.FL.W.0004". */
export function vtecKey(vtec) {
  const match =
    /\/[OTEX]\.[A-Z]{3}\.([A-Z]{4})\.([A-Z]{2})\.([A-Z])\.(\d{4})\./.exec(
      String(vtec ?? ''),
    );
  return match ? match.slice(1).join('.') : null;
}

function areaOf(feature) {
  const ring =
    feature.geometry?.type === 'Polygon'
      ? feature.geometry.coordinates?.[0]
      : feature.geometry?.type === 'MultiPolygon'
        ? feature.geometry.coordinates?.flatMap((polygon) => polygon[0] ?? [])
        : null;
  if (Array.isArray(ring) && ring.length >= 3) {
    const b = boundsOf(ring.map(([lon, lat]) => ({ lat, lon })));
    if (b) {
      const bounds = {
        west: b.west,
        south: b.south,
        east: b.east,
        north: b.north,
      };
      return { ...boundsCenter(bounds), bounds, precision: 'city' };
    }
  }
  const states = [
    ...new Set(
      (feature.properties?.geocode?.UGC ?? []).map((code) =>
        String(code).slice(0, 2),
      ),
    ),
  ];
  const bounds = unionBounds(states.map(usStateBounds));
  return bounds
    ? { ...boundsCenter(bounds), bounds, precision: 'region' }
    : { lat: null, lon: null, bounds: undefined, precision: 'country' };
}

/** One GeoJSON alert feature to a raw observation, or null when skipped. */
export function nwsAlertToRecord(feature) {
  const p = feature?.properties;
  if (!p || p.status !== 'Actual' || typeof p.id !== 'string') return null;
  if (!['Severe', 'Extreme'].includes(p.severity)) return null;
  const eventName = String(p.event ?? '');
  const civil = CIVIL.find(([pattern]) => pattern.test(eventName));
  const subtype = civil
    ? null
    : (SUBTYPES.find(([pattern]) => pattern.test(eventName))?.[1] ??
      'weather_alert');
  const year = String(p.sent ?? '').slice(0, 4);
  const vtec = vtecKey(p.parameters?.VTEC?.[0]);
  // The first message of an update chain is its oldest reference.
  const origin = [...(p.references ?? [])].sort(
    (a, b) => Date.parse(a.sent) - Date.parse(b.sent),
  )[0]?.identifier;
  const area = areaOf(feature);
  // Calibrated below GDACS Orange/Red: an NWS "Severe" alert is a local
  // threat, not a humanitarian-scale disaster. Watches (VTEC significance A)
  // are possibilities, so they rank under warnings.
  let severityHint = p.severity === 'Extreme' ? 75 : 50;
  if (p.certainty === 'Observed') severityHint += 5;
  if (p.urgency === 'Immediate') severityHint += 5;
  if (vtec?.split('.')[2] === 'A') severityHint -= 10;
  return {
    provider: 'nws',
    source_item_id: p.id,
    event_key: vtec ? `${year}.${vtec}` : (origin ?? p.id),
    publisher: p.senderName || 'U.S. National Weather Service',
    source_type: 'primary_official',
    url: feature.id ?? p['@id'],
    license: 'Public domain (U.S. Government)',
    attribution: 'U.S. National Weather Service (api.weather.gov)',
    language: 'en',
    category: civil?.[1] ?? 'natural_disaster',
    subtype,
    title: p.headline || `${eventName} for ${p.areaDesc}`,
    summary: [
      eventName,
      p.areaDesc,
      p.parameters?.NWSheadline?.[0],
      p.description,
    ]
      .filter(Boolean)
      .join(' — '),
    occurred_at: p.onset ?? p.effective ?? p.sent,
    published_at: p.sent,
    valid_until: p.ends ?? p.expires,
    location: {
      lat: area.lat,
      lon: area.lon,
      precision: area.precision,
      geolocation_status: area.lat === null ? undefined : 'approximate',
      region_code: 'US',
      place: String(p.areaDesc ?? '').slice(0, 120),
      bounds: area.bounds,
    },
    metrics: {
      severity_hint: Math.min(90, severityHint),
      nws_severity: p.severity.toLowerCase(),
      nws_certainty: String(p.certainty ?? '').toLowerCase() || undefined,
      nws_urgency: String(p.urgency ?? '').toLowerCase() || undefined,
    },
    status_hint:
      p.messageType === 'Cancel'
        ? 'resolved'
        : /evacuation/i.test(eventName)
          ? 'evacuation'
          : /warning|emergency/i.test(eventName)
            ? 'warning'
            : null,
  };
}

export function nwsConnector({
  url = NWS_ALERTS_URL,
  intervalMs = 3 * 60_000,
} = {}) {
  return {
    id: 'nws-alerts',
    provider: 'nws',
    url,
    intervalMs,
    // Quiet days have no Severe alerts at all; the feed itself is the signal.
    staleAfterMs: 2 * 24 * 3600_000,
    license: 'Public domain (U.S. Government)',
    attribution: 'U.S. National Weather Service',
    async poll({ fetchJson }) {
      const { body, notModified } = await fetchJson(url, {
        maxBytes: 8 * 1024 * 1024,
        accept: 'application/geo+json',
      });
      if (notModified) return { records: [], notModified: true };
      if (!Array.isArray(body?.features))
        throw new Error('malformed NWS GeoJSON');
      const records = body.features
        .slice(0, MAX_ALERTS)
        .map(nwsAlertToRecord)
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
