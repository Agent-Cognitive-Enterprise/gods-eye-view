// Camera framing for an Autopilot shot: which point to look down on and from
// what height so the whole cluster, plus padding, fits the viewport. Pure math
// on a sphere, independent of Cesium: the controller converts the result into
// a camera destination. Heights are metres above the WGS84 ellipsoid.

import { EARTH_RADIUS_KM, greatCircleKm } from '../geoDistance.js';
import { centroidOf, wrapLon } from './clustering.js';

/** Lowest useful height for a lone event, by location precision (metres). */
export const MIN_HEIGHT_BY_PRECISION = Object.freeze({
  exact: 25_000,
  point: 40_000,
  city: 80_000,
  region: 600_000,
  country: 1_500_000,
  unresolved: 3_000_000,
});
export const GLOBAL_VIEW_HEIGHT = 18_000_000;
const MAX_HEIGHT = 20_000_000;

/**
 * Height (m) at which a nadir camera sees a ground radius `radiusKm` within
 * the half-angle `halfFovRad`, on a spherical Earth. Exact for the visible
 * cap: tan(half) = R sinθ / (h + R − R cosθ), θ = radius / R.
 */
export function heightForRadius(radiusKm, halfFovRad) {
  const theta = Math.min(radiusKm / EARTH_RADIUS_KM, Math.PI / 2 - 0.01);
  const r = EARTH_RADIUS_KM * 1000;
  const height =
    (r * Math.sin(theta)) / Math.tan(halfFovRad) - r + r * Math.cos(theta);
  return Math.max(0, height);
}

/** The smaller half field of view, from Cesium's horizontal-or-larger fov convention. */
export function minHalfFov(fovRad, aspect) {
  const half = fovRad / 2;
  // Cesium's PerspectiveFrustum: fov spans the larger dimension.
  return aspect >= 1
    ? Math.atan(Math.tan(half) / aspect)
    : Math.atan(Math.tan(half) * aspect);
}

/**
 * The shot for one cluster.
 * @param {object} cluster From clusterEvents.
 * @param {{precisions?: string[], fovRad?: number, aspect?: number,
 *   padding?: number}} [options]
 * @returns {{lat: number, lon: number, height: number, kind: string} | null}
 */
export function frameCluster(
  cluster,
  {
    precisions = [],
    fovRad = Math.PI / 3,
    aspect = 16 / 9,
    padding = 1.35,
  } = {},
) {
  const half = minHalfFov(fovRad, aspect);
  // The least precise member decides how close the camera may go: a
  // city-level report is never shown at street level.
  const floor = Math.max(
    ...(precisions.length ? precisions : ['point']).map(
      (p) => MIN_HEIGHT_BY_PRECISION[p] ?? MIN_HEIGHT_BY_PRECISION.point,
    ),
  );
  if (cluster.framing === 'region') {
    const b = cluster.bounds;
    if (!b) return null; // nowhere honest to look
    const corners = [
      { lat: b.south, lon: b.west },
      { lat: b.north, lon: b.east },
      { lat: b.south, lon: b.east },
      { lat: b.north, lon: b.west },
    ];
    const center = centroidOf(corners);
    if (!center) return null;
    const radius = Math.max(...corners.map((c) => greatCircleKm(center, c)));
    return {
      lat: center.lat,
      lon: wrapLon(center.lon),
      height: clampHeight(
        heightForRadius(radius * padding, half),
        MIN_HEIGHT_BY_PRECISION.country,
      ),
      kind: 'region',
    };
  }
  if (!cluster.center) return null;
  if (cluster.framing === 'cap' && (cluster.radius_km ?? 0) > 3000)
    return {
      lat: cluster.center.lat,
      lon: cluster.center.lon,
      height: GLOBAL_VIEW_HEIGHT,
      kind: 'global',
    };
  const radius = cluster.radius_km ?? 0;
  return {
    lat: cluster.center.lat,
    lon: wrapLon(cluster.center.lon),
    height: clampHeight(heightForRadius(radius * padding, half), floor),
    kind: cluster.event_ids.length > 1 ? 'group' : 'single',
  };
}

const clampHeight = (height, floor) =>
  Math.round(Math.min(MAX_HEIGHT, Math.max(floor, height)));
