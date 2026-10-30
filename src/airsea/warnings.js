// Aviation and maritime warning areas (fork feature): the canonical warning
// record, geometry validation and lifecycle. Pure and portable.
//
// Geometry is GeoJSON, EPSG:4326, [lon, lat]. Only geometry stated by the
// source is drawn: a circle is built from its stated centre and radius, a
// point or line stays a point or line (never buffered into a made-up area),
// and a warning without usable geometry is a list record, not a polygon.

// Portable module: user-facing defaults are marked, not translated, here.
const msg = (text) => text;

export const WARNING_DOMAINS = Object.freeze([
  'aviation',
  'maritime',
  'marine_weather',
]);
export const WARNING_STATUSES = Object.freeze([
  'scheduled',
  'active',
  'expired',
  'cancelled',
  'unknown',
]);
export const WARNING_SEVERITIES = Object.freeze([
  'advisory',
  'caution',
  'restricted',
  'danger',
  'unknown',
]);
export const GEOMETRY_PRECISIONS = Object.freeze([
  'official',
  'derived_checked',
  'approximate',
  'none',
]);
// A warning first seen within this window is drawn as new.
export const NEW_WARNING_MS = 6 * 3600_000;

const EARTH_RADIUS_KM = 6371.0088;
const MAX_POSITIONS = 20_000;
const toRad = (deg) => (deg * Math.PI) / 180;
const toDeg = (rad) => (rad * 180) / Math.PI;

const isPosition = (p) =>
  Array.isArray(p) &&
  p.length >= 2 &&
  Number.isFinite(p[0]) &&
  Number.isFinite(p[1]) &&
  Math.abs(p[0]) <= 180 &&
  Math.abs(p[1]) <= 90;

const samePosition = (a, b) => a[0] === b[0] && a[1] === b[1];

/** A closed linear ring of at least four positions, or null. */
function cleanRing(ring, notes) {
  if (!Array.isArray(ring)) return null;
  const positions = ring.filter(isPosition).map((p) => [p[0], p[1]]);
  if (positions.length !== ring.length) notes.push('invalid_positions_dropped');
  if (positions.length < 3) return null;
  if (!samePosition(positions[0], positions.at(-1))) {
    positions.push([...positions[0]]);
    notes.push('ring_closed');
  }
  return positions.length >= 4 ? positions : null;
}

function cleanPolygon(rings, notes) {
  if (!Array.isArray(rings)) return null;
  const [outer, ...holes] = rings.map((r) => cleanRing(r, notes));
  if (!outer) return null;
  return [outer, ...holes.filter(Boolean)];
}

/**
 * A validated copy of a GeoJSON geometry, or null when nothing usable is
 * left. Notes say what was repaired or dropped.
 * @returns {{geometry: object|null, notes: string[]}}
 */
export function validateGeometry(geometry) {
  const notes = [];
  const check = (g) => {
    if (!g || typeof g !== 'object') return null;
    switch (g.type) {
      case 'Point':
        return isPosition(g.coordinates)
          ? { type: 'Point', coordinates: g.coordinates.slice(0, 2) }
          : null;
      case 'MultiPoint': {
        const points = (g.coordinates ?? []).filter(isPosition);
        return points.length
          ? { type: 'MultiPoint', coordinates: points }
          : null;
      }
      case 'LineString': {
        const line = (g.coordinates ?? []).filter(isPosition);
        return line.length >= 2
          ? { type: 'LineString', coordinates: line }
          : null;
      }
      case 'MultiLineString': {
        const lines = (g.coordinates ?? [])
          .map((l) => (Array.isArray(l) ? l.filter(isPosition) : []))
          .filter((l) => l.length >= 2);
        return lines.length
          ? { type: 'MultiLineString', coordinates: lines }
          : null;
      }
      case 'Polygon': {
        const polygon = cleanPolygon(g.coordinates, notes);
        return polygon ? { type: 'Polygon', coordinates: polygon } : null;
      }
      case 'MultiPolygon': {
        const polygons = (g.coordinates ?? [])
          .map((p) => cleanPolygon(p, notes))
          .filter(Boolean);
        return polygons.length
          ? { type: 'MultiPolygon', coordinates: polygons }
          : null;
      }
      case 'GeometryCollection': {
        const parts = (g.geometries ?? []).map(check).filter(Boolean);
        if (!parts.length) return null;
        return parts.length === 1
          ? parts[0]
          : { type: 'GeometryCollection', geometries: parts };
      }
      default:
        notes.push(`unsupported_geometry_${String(g.type).slice(0, 24)}`);
        return null;
    }
  };
  const result = check(geometry);
  if (result && countPositions(result) > MAX_POSITIONS) {
    notes.push('too_many_positions');
    return { geometry: null, notes };
  }
  if (!result && geometry) notes.push('geometry_unusable');
  return { geometry: result, notes };
}

function countPositions(g) {
  switch (g.type) {
    case 'Point':
      return 1;
    case 'MultiPoint':
    case 'LineString':
      return g.coordinates.length;
    case 'MultiLineString':
    case 'Polygon':
      return g.coordinates.reduce((n, part) => n + part.length, 0);
    case 'MultiPolygon':
      return g.coordinates.reduce(
        (n, polygon) => n + polygon.reduce((m, ring) => m + ring.length, 0),
        0,
      );
    case 'GeometryCollection':
      return g.geometries.reduce((n, part) => n + countPositions(part), 0);
    default:
      return 0;
  }
}

/**
 * Polygon approximating a geodesic circle stated by a source (centre and
 * radius): a derived, checked geometry, never a guess.
 */
export function circlePolygon({ lat, lon }, radiusKm, segments = 64) {
  const angular = radiusKm / EARTH_RADIUS_KM;
  const lat1 = toRad(lat);
  const lon1 = toRad(lon);
  const ring = [];
  for (let i = 0; i <= segments; i++) {
    const bearing = (2 * Math.PI * (i % segments)) / segments;
    const lat2 = Math.asin(
      Math.sin(lat1) * Math.cos(angular) +
        Math.cos(lat1) * Math.sin(angular) * Math.cos(bearing),
    );
    const lon2 =
      lon1 +
      Math.atan2(
        Math.sin(bearing) * Math.sin(angular) * Math.cos(lat1),
        Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2),
      );
    const lonDeg = ((toDeg(lon2) + 540) % 360) - 180;
    ring.push([
      Math.round(lonDeg * 1e6) / 1e6,
      Math.round(toDeg(lat2) * 1e6) / 1e6,
    ]);
  }
  ring[ring.length - 1] = [...ring[0]];
  return { type: 'Polygon', coordinates: [ring] };
}

/**
 * A ring for drawing: longitudes made continuous across the antimeridian
 * (they may exceed ±180), so a renderer never wraps it around the globe.
 */
export function continuousRing(ring) {
  const out = [];
  for (const [lon, lat] of ring) {
    if (!out.length) {
      out.push([lon, lat]);
      continue;
    }
    let next = lon;
    const previous = out.at(-1)[0];
    while (next - previous > 180) next -= 360;
    while (next - previous < -180) next += 360;
    out.push([next, lat]);
  }
  return out;
}

/** Every position of a geometry, flattened. */
export function positionsOf(g) {
  if (!g) return [];
  switch (g.type) {
    case 'Point':
      return [g.coordinates];
    case 'MultiPoint':
    case 'LineString':
      return g.coordinates;
    case 'MultiLineString':
    case 'Polygon':
      return g.coordinates.flat();
    case 'MultiPolygon':
      return g.coordinates.flat(2);
    case 'GeometryCollection':
      return g.geometries.flatMap(positionsOf);
    default:
      return [];
  }
}

/**
 * Bounds [west, south, east, north] of a geometry, taking the narrower way
 * round the globe: a box across the antimeridian has west > east, never a
 * misleading box (or centroid) spanning the whole world.
 */
export function geometryBounds(g) {
  const points = positionsOf(g);
  if (!points.length) return null;
  const lats = points.map((p) => p[1]);
  const lons = [...new Set(points.map((p) => p[0]))].sort((a, b) => a - b);
  // The widest gap between neighbouring longitudes is the part of the
  // globe the geometry does not cover; the box is everything else.
  let gap = 360 - (lons.at(-1) - lons[0]);
  let west = lons[0];
  let east = lons.at(-1);
  for (let i = 1; i < lons.length; i++) {
    const g2 = lons[i] - lons[i - 1];
    if (g2 > gap) {
      gap = g2;
      west = lons[i];
      east = lons[i - 1];
    }
  }
  return [west, Math.min(...lats), east, Math.max(...lats)];
}

const epoch = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};

/**
 * Lifecycle at `now` from the source's own times. A warning never expires
 * just because its feed went quiet: only its stated end, a cancellation or
 * an authoritative removal (`endedAtUtc`) ends it.
 */
export function warningStatus(record, now) {
  const cancelled = epoch(record.cancelledAtUtc);
  if (cancelled !== null && cancelled <= now) return 'cancelled';
  const ended = epoch(record.endedAtUtc);
  if (ended !== null && ended <= now) return 'expired';
  const from = epoch(record.effectiveFromUtc);
  const until = epoch(record.effectiveUntilUtc);
  if (until !== null && until < now) return 'expired';
  if (from !== null && from > now) return 'scheduled';
  if (from === null && until === null && epoch(record.publishedAtUtc) === null)
    return 'unknown';
  return 'active';
}

/** FNV-1a over a string: a stable content hash for change detection. */
export function stableHash(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Hash of what a reader would call a change to the warning. */
export function contentHash(record) {
  return stableHash(
    JSON.stringify([
      record.title,
      record.originalText,
      record.warningType,
      record.severity,
      record.effectiveFromUtc,
      record.effectiveUntilUtc,
      record.cancelledAtUtc,
      record.geometry,
      record.altitudeFloor ?? null,
      record.altitudeCeiling ?? null,
    ]),
  );
}

const text = (value, max) =>
  typeof value === 'string'
    ? value
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
        .trim()
        .slice(0, max)
    : null;

/**
 * A canonical WarningRecord from a connector's draft, with validated
 * geometry, bounded text and provenance; null when it has no identity.
 */
export function normalizeWarning(draft, { receivedAtUtc, parserVersion }) {
  if (!draft?.id || !draft.sourceId) return null;
  const { geometry, notes } = validateGeometry(draft.geometry);
  const record = {
    id: String(draft.id).slice(0, 160),
    sourceId: draft.sourceId,
    originalId: text(draft.originalId, 160),
    domain: WARNING_DOMAINS.includes(draft.domain) ? draft.domain : 'maritime',
    warningType: text(draft.warningType, 120) || 'unspecified',
    authority: text(draft.authority, 160),
    title: text(draft.title, 300) || msg('Untitled warning'),
    originalText: text(draft.originalText, 8000),
    sourceUrl: /^https:\/\//.test(draft.sourceUrl ?? '')
      ? draft.sourceUrl
      : null,
    publishedAtUtc: draft.publishedAtUtc ?? null,
    effectiveFromUtc: draft.effectiveFromUtc ?? null,
    effectiveUntilUtc: draft.effectiveUntilUtc ?? null,
    cancelledAtUtc: draft.cancelledAtUtc ?? null,
    endedAtUtc: null,
    receivedAtUtc,
    severity: WARNING_SEVERITIES.includes(draft.severity)
      ? draft.severity
      : 'unknown',
    geometry,
    geometryPrecision: geometry
      ? GEOMETRY_PRECISIONS.includes(draft.geometryPrecision)
        ? draft.geometryPrecision
        : 'approximate'
      : 'none',
    geometryNotes:
      [draft.geometryNotes, ...notes].filter(Boolean).join('; ') || null,
    altitudeFloor: draft.altitudeFloor ?? null,
    altitudeCeiling: draft.altitudeCeiling ?? null,
    recurrence: text(draft.recurrence, 300),
    trial: draft.trial === true,
    supersedes: Array.isArray(draft.supersedes)
      ? draft.supersedes.slice(0, 20).map(String)
      : [],
    provenance: {
      fetchedFrom: draft.fetchedFrom ?? null,
      sourceHash: draft.sourceHash ?? null,
      parserVersion,
    },
  };
  record.contentHash = contentHash(record);
  return record;
}

/**
 * What changed between the stored and the incoming version of a warning:
 * 'new', 'changed', 'cancelled', 'expired' or null.
 */
export function changeKind(previous, next, now) {
  if (!previous) return 'new';
  const before = warningStatus(previous, now);
  const after = warningStatus(next, now);
  if (after === 'cancelled' && before !== 'cancelled') return 'cancelled';
  if (after === 'expired' && before !== 'expired') return 'expired';
  return previous.contentHash !== next.contentHash ? 'changed' : null;
}
