// Air/sea traffic aggregation (fork feature): one normalized stream of
// aircraft and vessel fixes from the app's existing feeds, reduced to H3 cell
// counts for the strategic density view. Pure and portable apart from h3-js.
//
// Counting rules (spec §5.1): one object counts once, at its freshest valid
// fix inside the observation window; reports are diagnostics, not traffic.
// Coordinates: h3-js takes and returns [lat, lng]; everything this module
// emits as geometry is GeoJSON order [lon, lat].

import {
  cellToBoundary,
  getHexagonAreaAvg,
  isPentagon,
  latLngToCell,
} from 'h3-js';

export const DOMAINS = Object.freeze(['air', 'sea']);
// A fix this far ahead of its receipt is a clock or parser error.
export const MAX_FUTURE_MS = 2 * 60_000;
// Oldest fix accepted into the tracker (the longest window offered).
export const MAX_FIX_AGE_MS = 24 * 3600_000;
// Below this speed a vessel is stationary (anchored, moored, drifting).
const SEA_MOVING_KNOTS = 1;
// Below this ground speed an aircraft not flagged on-ground still counts as
// stationary (taxiing, parked transponders).
const AIR_MOVING_MPS = 25;

const finite = (value) =>
  value === null || value === undefined || value === ''
    ? null
    : Number.isFinite(Number(value))
      ? Number(value)
      : null;

/** Why a fix was refused, or null when it is usable. */
export function rejectReason(fix, receivedAt) {
  if (!fix.id) return 'no_identity';
  if (fix.lat === null || fix.lon === null) return 'no_position';
  if (Math.abs(fix.lat) > 90 || Math.abs(fix.lon) > 180) return 'out_of_range';
  // "Null Island" is a default value, not a position.
  if (fix.lat === 0 && fix.lon === 0) return 'null_island';
  if (!Number.isFinite(fix.observedAt)) return 'no_time';
  if (fix.observedAt > receivedAt + MAX_FUTURE_MS) return 'future';
  if (fix.observedAt < receivedAt - MAX_FIX_AGE_MS) return 'stale';
  return null;
}

/**
 * OpenSky `states/all` (and the app's adsb.lol fallback, which uses the same
 * vectors): [icao24, callsign, country, time_position, last_contact, lon,
 * lat, baro_alt, on_ground, velocity, track, vrate, sensors, geo_alt, ...].
 */
export function aircraftFromStates(payload, { provider, receivedAt }) {
  const snapshotSec = finite(payload?.time);
  const fixes = [];
  for (const s of Array.isArray(payload?.states) ? payload.states : []) {
    if (!Array.isArray(s)) continue;
    const seconds = finite(s[3]) ?? finite(s[4]) ?? snapshotSec;
    const altitude = finite(s[13]) ?? finite(s[7]);
    fixes.push({
      domain: 'air',
      id: typeof s[0] === 'string' ? s[0].trim().toLowerCase() : null,
      lat: finite(s[6]),
      lon: finite(s[5]),
      observedAt: seconds === null ? NaN : seconds * 1000,
      provider,
      onGround: s[8] === true,
      altitudeM: altitude,
      speedMps: finite(s[9]),
      receivedAt,
    });
  }
  return fixes;
}

/** adsb.lol readsb rows (`/v2/mil`): hex, lat, lon, seen_pos, alt_baro, gs. */
export function aircraftFromReadsb(payload, { provider, receivedAt }) {
  const nowMs = (() => {
    const now = finite(payload?.now);
    if (now === null) return receivedAt;
    return now > 10_000_000_000 ? now : now * 1000;
  })();
  const fixes = [];
  for (const row of Array.isArray(payload?.ac) ? payload.ac : []) {
    const seenPos = finite(row?.seen_pos) ?? finite(row?.seen) ?? 0;
    const altFt = row?.alt_baro === 'ground' ? 0 : finite(row?.alt_baro);
    const gsKt = finite(row?.gs);
    fixes.push({
      domain: 'air',
      id:
        typeof row?.hex === 'string'
          ? row.hex.replace(/^~/, '').trim().toLowerCase()
          : null,
      lat: finite(row?.lat),
      lon: finite(row?.lon),
      observedAt: nowMs - seenPos * 1000,
      provider,
      onGround: row?.alt_baro === 'ground',
      altitudeM: altFt === null ? null : altFt * 0.3048,
      speedMps: gsKt === null ? null : gsKt * 0.514444,
      receivedAt,
    });
  }
  return fixes;
}

/** AISStream rows from the app's vessel store (ais-store.js). */
export function vesselsFromAisRows(rows, { provider, receivedAt }) {
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const epoch = finite(row?.last_position_epoch);
    const parsed = Date.parse(row?.last_position_UTC ?? '');
    return {
      domain: 'sea',
      id: row?.mmsi ? String(row.mmsi).trim() : null,
      lat: finite(row?.lat),
      lon: finite(row?.lon),
      observedAt:
        epoch !== null ? epoch * 1000 : Number.isFinite(parsed) ? parsed : NaN,
      provider,
      speedKn: finite(row?.speed),
      vesselType: row?.type ?? null,
      receivedAt,
    };
  });
}

const isMoving = (fix) =>
  fix.domain === 'sea'
    ? (fix.speedKn ?? 0) >= SEA_MOVING_KNOTS
    : !fix.onGround && (fix.speedMps ?? AIR_MOVING_MPS) >= AIR_MOVING_MPS;

/** Altitude band for an aircraft fix (metres above mean sea level). */
export function altitudeBand(fix) {
  if (fix.onGround) return 'ground';
  const m = fix.altitudeM;
  if (m === null || m === undefined) return 'unknown';
  if (m < 3000) return 'low';
  if (m < 9000) return 'mid';
  return 'high';
}

/**
 * Latest fix per object across providers. Two providers reporting the same
 * ICAO hex or MMSI are one object: the fresher fix wins.
 */
export function createTrafficTracker({ maxObjects = 200_000 } = {}) {
  // Insertion order is update order (an update re-inserts), so the oldest
  // objects are always at the head and eviction never sorts.
  const objects = new Map(); // `${domain}:${id}` -> fix
  const rejected = {}; // reason -> count (diagnostics)
  let reports = 0;
  let version = 0;

  function ingest(fixes, receivedAt) {
    let accepted = 0;
    for (const fix of fixes) {
      reports += 1;
      const reason = rejectReason(fix, receivedAt);
      if (reason) {
        rejected[reason] = (rejected[reason] ?? 0) + 1;
        continue;
      }
      const key = `${fix.domain}:${fix.id}`;
      const seen = objects.get(key);
      // An older fix (late delivery, a slower provider) never moves an object back.
      if (seen && seen.observedAt >= fix.observedAt) continue;
      objects.delete(key);
      objects.set(key, fix);
      accepted += 1;
    }
    for (const key of objects.keys()) {
      if (objects.size <= maxObjects) break;
      objects.delete(key);
    }
    if (accepted) version += 1;
    return accepted;
  }

  /** Objects whose latest fix falls inside [now - windowMs, now]. */
  function current(domain, now, windowMs) {
    const out = [];
    for (const fix of objects.values())
      if (fix.domain === domain && fix.observedAt >= now - windowMs)
        out.push(fix);
    return out;
  }

  function prune(now) {
    for (const [key, fix] of objects)
      if (fix.observedAt < now - MAX_FIX_AGE_MS) objects.delete(key);
  }

  return {
    ingest,
    current,
    prune,
    size: () => objects.size,
    version: () => version,
    diagnostics: () => ({ reports, rejected: { ...rejected } }),
  };
}

/**
 * GeoJSON ring [lon, lat] for a cell, closed, continuous across the
 * antimeridian (longitudes may exceed ±180 so the ring never wraps the
 * globe). Null for a cell that contains a pole, which no flat ring encloses.
 */
export function cellRing(h3Index) {
  const boundary = cellToBoundary(h3Index); // [[lat, lng], ...]
  const lons = boundary.map(([, lng]) => lng);
  let ring = boundary.map(([lat, lng]) => [lng, lat]);
  if (Math.max(...lons) - Math.min(...lons) > 180) {
    ring = ring.map(([lng, lat]) => [lng < 0 ? lng + 360 : lng, lat]);
    const span =
      Math.max(...ring.map(([lng]) => lng)) -
      Math.min(...ring.map(([lng]) => lng));
    if (span > 180) return null; // circles a pole
  }
  if (Math.max(...boundary.map(([lat]) => Math.abs(lat))) > 89.9) return null;
  ring.push([...ring[0]]);
  return ring;
}

/** Inside [west, south, east, north]; west > east crosses the antimeridian. */
function inBox(fix, box) {
  if (!box) return true;
  const [west, south, east, north] = box;
  if (fix.lat < south || fix.lat > north) return false;
  return west <= east
    ? fix.lon >= west && fix.lon <= east
    : fix.lon >= west || fix.lon <= east;
}

/**
 * H3 cell counts for one domain at one resolution.
 * @returns {{cells: object[], total: number, truncated: boolean}}
 */
export function aggregateCells(
  fixes,
  { resolution, now, box = null, maxCells = 8_000 },
) {
  const areaKm2 = getHexagonAreaAvg(resolution, 'km2');
  const cells = new Map();
  for (const fix of fixes) {
    if (!inBox(fix, box)) continue;
    const h3 = latLngToCell(fix.lat, fix.lon, resolution);
    let cell = cells.get(h3);
    if (!cell) {
      cell = {
        h3,
        uniqueCount: 0,
        movingCount: 0,
        stationaryCount: 0,
        newestAt: -Infinity,
        oldestAt: Infinity,
        providers: new Set(),
        bands: {},
      };
      cells.set(h3, cell);
    }
    cell.uniqueCount += 1;
    if (isMoving(fix)) cell.movingCount += 1;
    else cell.stationaryCount += 1;
    cell.newestAt = Math.max(cell.newestAt, fix.observedAt);
    cell.oldestAt = Math.min(cell.oldestAt, fix.observedAt);
    cell.providers.add(fix.provider);
    if (fix.domain === 'air') {
      const band = altitudeBand(fix);
      cell.bands[band] = (cell.bands[band] ?? 0) + 1;
    }
  }
  const ranked = [...cells.values()].sort(
    (a, b) => b.uniqueCount - a.uniqueCount || (a.h3 < b.h3 ? -1 : 1),
  );
  const out = [];
  for (const cell of ranked.slice(0, maxCells)) {
    const ring = cellRing(cell.h3);
    if (!ring) continue;
    // Pentagons are smaller than the average hexagon: density uses the
    // resolution's average area either way, so counts stay comparable.
    out.push({
      h3: cell.h3,
      ring,
      uniqueCount: cell.uniqueCount,
      movingCount: cell.movingCount,
      stationaryCount: cell.stationaryCount,
      densityPer10kKm2:
        Math.round((cell.uniqueCount / areaKm2) * 10_000 * 100) / 100,
      newestAgeMs: Math.max(0, now - cell.newestAt),
      oldestAgeMs: Math.max(0, now - cell.oldestAt),
      providers: [...cell.providers].sort(),
      ...(Object.keys(cell.bands).length ? { bands: cell.bands } : {}),
      pentagon: isPentagon(cell.h3),
    });
  }
  return {
    cells: out,
    total: ranked.reduce((sum, c) => sum + c.uniqueCount, 0),
    // Objects in cells actually drawn: polar cells and cells beyond the cap
    // are counted in `total` but not shown.
    drawn: out.reduce((sum, c) => sum + c.uniqueCount, 0),
    truncated: ranked.length > maxCells,
  };
}

/** H3 resolution for a camera height (m): coarse for the globe, finer close. */
export function resolutionForHeight(heightM) {
  if (!(heightM > 0)) return 2;
  if (heightM >= 5_000_000) return 2;
  if (heightM >= 1_200_000) return 3;
  return 4;
}
