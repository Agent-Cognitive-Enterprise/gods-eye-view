// Observation (evidence) normalization. Every connector hands raw records to
// `normalizeObservation`, which bounds and sanitizes them into the one shape
// the correlator accepts. Source text is untrusted data: it is reduced to plain
// text, length-capped and never interpreted. Coordinates are never invented —
// a report without a valid point keeps only its region and an `unresolved`
// geolocation status. Pure and portable.

import { isGeoPoint } from '../geoDistance.js';
import { isCategory, isPrecision, isSourceType } from './taxonomy.js';

export const MAX_TITLE = 240;
export const MAX_SUMMARY = 1200;
export const MAX_ENTITIES = 24;
export const MAX_METRICS = 24;
const MAX_ID = 200;
const MAX_URL = 2048;
const MAX_SHORT = 120;

/** Markup and control characters to one bounded line of plain text. */
export function plainText(value, max = MAX_SUMMARY) {
  const text = String(value ?? '')
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** An http(s) URL without credentials, or null. */
export function safeUrl(value) {
  if (typeof value !== 'string' || value.length > MAX_URL) return null;
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password) return null;
  return url.href;
}

/** A finite epoch-millisecond time from a number, Date or ISO string; else null. */
export function epochMs(value) {
  if (value === null || value === undefined || value === '') return null;
  const ms =
    typeof value === 'number'
      ? value
      : value instanceof Date
        ? value.getTime()
        : Date.parse(String(value));
  // Years 1900–2200: anything else is a broken feed, not an event time.
  return Number.isFinite(ms) &&
    ms > -2_208_988_800_000 &&
    ms < 7_258_118_400_000
    ? ms
    : null;
}

/** cyrb53: a fast, stable 53-bit string hash rendered as hex. Not cryptographic. */
export function stableHash(text, seed = 0) {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  const value = String(text);
  for (let i = 0; i < value.length; i++) {
    const ch = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0))
    .toString(16)
    .padStart(14, '0');
}

/** Lower-cased word tokens (any script), for similarity, not display. */
export function textTokens(text) {
  return [
    ...new Set(
      String(text ?? '')
        .toLowerCase()
        .normalize('NFKC')
        .split(/[^\p{L}\p{N}]+/u)
        .filter((word) => word.length > 2),
    ),
  ];
}

const shortId = (value) => {
  const id = plainText(value, MAX_ID);
  return id || null;
};

function normalizeLocation(raw) {
  const location = raw && typeof raw === 'object' ? raw : {};
  const point = { lat: Number(location.lat), lon: Number(location.lon) };
  const hasPoint =
    location.lat !== null &&
    location.lat !== undefined &&
    location.lon !== null &&
    location.lon !== undefined &&
    isGeoPoint(point);
  const regionCode = /^[A-Z]{2}(?:-[A-Z0-9]{1,3})?$/.test(
    String(location.region_code ?? ''),
  )
    ? location.region_code
    : null;
  let precision = isPrecision(location.precision)
    ? location.precision
    : hasPoint
      ? 'point'
      : regionCode
        ? 'country'
        : 'unresolved';
  if (!hasPoint && (precision === 'exact' || precision === 'point'))
    precision = regionCode ? 'country' : 'unresolved';
  const status = hasPoint
    ? ['verified', 'approximate', 'needs_verification'].includes(
        location.geolocation_status,
      )
      ? location.geolocation_status
      : 'approximate'
    : 'unresolved';
  return {
    lat: hasPoint ? point.lat : null,
    lon: hasPoint ? point.lon : null,
    precision,
    geolocation_status: status,
    region_code: regionCode,
    place: plainText(location.place, MAX_SHORT) || null,
    bounds: normalizeBounds(location.bounds),
  };
}

function normalizeBounds(bounds) {
  if (!bounds || typeof bounds !== 'object') return null;
  const { west, south, east, north } = bounds;
  const valid =
    [west, south, east, north].every(Number.isFinite) &&
    south >= -90 &&
    north <= 90 &&
    south <= north &&
    Math.abs(west) <= 180 &&
    Math.abs(east) <= 180;
  return valid ? { west, south, east, north } : null;
}

function normalizeMetrics(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, value] of Object.entries(raw).slice(0, MAX_METRICS)) {
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(key)) continue;
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (typeof value === 'boolean') out[key] = value;
    else if (typeof value === 'string' && value.length <= 40)
      out[key] = plainText(value, 40);
  }
  return out;
}

/**
 * Validate and bound one raw observation.
 * @param {object} raw Connector record.
 * @param {{receivedAt: number}} context Ingestion clock.
 * @returns {{ok: true, observation: object} | {ok: false, reason: string}}
 */
export function normalizeObservation(raw, { receivedAt } = {}) {
  if (!raw || typeof raw !== 'object')
    return { ok: false, reason: 'not_object' };
  const provider = shortId(raw.provider);
  const sourceItemId = shortId(raw.source_item_id);
  if (!provider || !sourceItemId)
    return { ok: false, reason: 'missing_provider_or_item' };
  if (!isCategory(raw.category)) return { ok: false, reason: 'bad_category' };
  const title = plainText(raw.title, MAX_TITLE);
  if (!title) return { ok: false, reason: 'missing_title' };
  const received = epochMs(receivedAt) ?? epochMs(raw.received_at);
  if (received === null) return { ok: false, reason: 'missing_received_at' };

  const occurredAt = epochMs(raw.occurred_at);
  const publishedAt = epochMs(raw.published_at);
  // An event time in the future of its own receipt is a feed error; keep the
  // record but do not let it claim to be newer than it is.
  const clamp = (ms) => (ms !== null && ms > received + 5 * 60_000 ? null : ms);
  const summary = plainText(raw.summary, MAX_SUMMARY);
  const metrics = normalizeMetrics(raw.metrics);
  const entities = Array.isArray(raw.entities)
    ? [
        ...new Set(
          raw.entities
            .map((entity) => plainText(entity, 80).toLowerCase())
            .filter(Boolean),
        ),
      ].slice(0, MAX_ENTITIES)
    : [];
  const sourceType = isSourceType(raw.source_type)
    ? raw.source_type
    : 'secondary_reporting';
  const url = safeUrl(raw.url);
  const location = normalizeLocation(raw.location);
  // The place is part of the content: two generic reports ("Drone strike")
  // from one publisher in different cities are different observations.
  const place =
    location.lat !== null
      ? `${location.lat.toFixed(2)},${location.lon.toFixed(2)}`
      : (location.region_code ?? null);
  const contentDigest = stableHash(
    JSON.stringify([title, summary, metrics, raw.status_hint ?? null, place]),
  );
  const observation = {
    observation_id: `${provider}:${sourceItemId}:${contentDigest}`,
    provider,
    source_item_id: sourceItemId,
    publisher: plainText(raw.publisher, MAX_SHORT) || provider,
    source_type: sourceType,
    url,
    license: plainText(raw.license, MAX_SHORT) || null,
    attribution: plainText(raw.attribution, 240) || null,
    language: /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/.test(String(raw.language))
      ? raw.language
      : 'und',
    title,
    summary,
    category: raw.category,
    subtype: /^[a-z][a-z0-9_]{0,47}$/.test(String(raw.subtype))
      ? raw.subtype
      : null,
    event_key: shortId(raw.event_key),
    lineage_key:
      shortId(raw.lineage_key) || url || `${provider}:${sourceItemId}`,
    derived_from: shortId(raw.derived_from),
    location,
    occurred_at: clamp(occurredAt),
    published_at: clamp(publishedAt),
    received_at: received,
    // Authoritative end of validity (an official alert's expiry), if stated.
    valid_until: epochMs(raw.valid_until),
    time_zone_known: raw.time_zone_known !== false,
    status_hint: [
      'warning',
      'ongoing',
      'resolved',
      'retracted',
      'disputed',
      'evacuation',
    ].includes(raw.status_hint)
      ? raw.status_hint
      : null,
    official: sourceType === 'primary_official' && raw.official !== false,
    metrics,
    entities,
    content_digest: contentDigest,
  };
  return { ok: true, observation };
}

/** The best time an observation describes: occurrence, else publication, else receipt. */
export function observationTime(observation) {
  return (
    observation.occurred_at ??
    observation.published_at ??
    observation.received_at
  );
}
