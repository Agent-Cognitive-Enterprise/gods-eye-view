// Geographic grouping for the camera. Complete-link with a bounded diameter:
// every member of a cluster is within `diameterKm` of every other member, so a
// chain of neighbouring incidents can never stretch one cluster across a
// continent. Seeded in attention order, ties by id, so the same input always
// yields the same clusters. Bounds take the smallest longitude arc, which
// keeps groups straddling ±180° together. Events without a point are never
// placed at an invented coordinate: each becomes its own regional cluster.
// Pure and portable; distances use the shared great-circle convention.

import { greatCircleKm, isGeoPoint } from '../geoDistance.js';
import { stableHash } from './evidence.js';

const DEG = Math.PI / 180;

const hasPoint = (event) =>
  isGeoPoint({ lat: event.location?.lat, lon: event.location?.lon });

const pointOf = (event) => ({
  lat: event.location.lat,
  lon: event.location.lon,
});

/** Normalize a longitude into (-180, 180]. */
export function wrapLon(lon) {
  const wrapped = ((((lon + 180) % 360) + 360) % 360) - 180;
  return wrapped === -180 ? 180 : wrapped;
}

/**
 * Smallest bounding box of points, possibly crossing the antimeridian
 * (then `west > east`). Returns null for no points.
 */
export function boundsOf(points) {
  if (!points.length) return null;
  const lats = points.map((p) => p.lat);
  const lons = [...new Set(points.map((p) => wrapLon(p.lon)))].sort(
    (a, b) => a - b,
  );
  let west = lons[0];
  let east = lons[lons.length - 1];
  if (lons.length > 1) {
    // The widest empty gap (circularly) is what the box leaves out.
    let gap = lons[0] + 360 - lons[lons.length - 1];
    for (let i = 1; i < lons.length; i++) {
      const g = lons[i] - lons[i - 1];
      if (g > gap) {
        gap = g;
        west = lons[i];
        east = lons[i - 1];
      }
    }
  }
  const span = west <= east ? east - west : east + 360 - west;
  return {
    west,
    east,
    south: Math.min(...lats),
    north: Math.max(...lats),
    lon_span_deg: Math.round(span * 1e6) / 1e6,
    crosses_antimeridian: west > east,
  };
}

/** Spherical centroid of points (mean unit vector), robust at the antimeridian. */
export function centroidOf(points) {
  let x = 0;
  let y = 0;
  let z = 0;
  for (const p of points) {
    const lat = p.lat * DEG;
    const lon = p.lon * DEG;
    x += Math.cos(lat) * Math.cos(lon);
    y += Math.cos(lat) * Math.sin(lon);
    z += Math.sin(lat);
  }
  const hyp = Math.hypot(x, y);
  if (hyp < 1e-12 && Math.abs(z) < 1e-12) return null; // antipodal set
  return {
    lat: Math.atan2(z, hyp) / DEG,
    lon: hyp < 1e-12 ? 0 : wrapLon(Math.atan2(y, x) / DEG),
  };
}

function describe(members, id) {
  const points = members.filter(hasPoint).map(pointOf);
  if (!points.length) {
    const first = members[0];
    return {
      cluster_id: id,
      event_ids: members.map((e) => e.event_id),
      framing: 'region',
      region_code: first.location?.region_code ?? null,
      bounds: first.location?.bounds ?? null,
      center: null,
      radius_km: null,
      diameter_km: null,
      top_score: Math.max(...members.map((e) => e.attention_score ?? 0)),
    };
  }
  const center = centroidOf(points);
  let diameter = 0;
  for (let i = 0; i < points.length; i++)
    for (let j = i + 1; j < points.length; j++)
      diameter = Math.max(diameter, greatCircleKm(points[i], points[j]));
  const radius = center
    ? Math.max(0, ...points.map((p) => greatCircleKm(center, p)))
    : null;
  const bounds = boundsOf(points);
  // Near a pole or over half the globe a lat/lon box misleads; frame a cap.
  const polar =
    points.some((p) => Math.abs(p.lat) > 85) || bounds.lon_span_deg > 180;
  return {
    cluster_id: id,
    event_ids: members.map((e) => e.event_id),
    framing: points.length === 1 ? 'point' : polar ? 'cap' : 'bounds',
    region_code: null,
    bounds,
    center,
    radius_km: radius === null ? null : Math.round(radius * 10) / 10,
    diameter_km: Math.round(diameter * 10) / 10,
    top_score: Math.max(...members.map((e) => e.attention_score ?? 0)),
  };
}

/**
 * Group events into bounded-diameter clusters.
 * @param {object[]} events Each with `event_id`, `attention_score`, `location`.
 * @param {{diameterKm?: number}} [options]
 * @returns {object[]} Clusters, highest-ranked first.
 */
export function clusterEvents(events, { diameterKm = 800 } = {}) {
  const ordered = [...events].sort(
    (a, b) =>
      (b.attention_score ?? 0) - (a.attention_score ?? 0) ||
      (a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0),
  );
  const groups = [];
  for (const event of ordered) {
    if (!hasPoint(event)) {
      groups.push([event]);
      continue;
    }
    const point = pointOf(event);
    const home = groups.find(
      (members) =>
        hasPoint(members[0]) &&
        members.every((m) => greatCircleKm(pointOf(m), point) <= diameterKm),
    );
    if (home) home.push(event);
    else groups.push([event]);
  }
  return groups.map((members) =>
    describe(
      members,
      `cluster:${stableHash(
        members
          .map((m) => m.event_id)
          .sort()
          .join('+'),
      )}`,
    ),
  );
}
