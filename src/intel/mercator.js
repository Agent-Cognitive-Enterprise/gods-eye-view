// Web Mercator for the Autopilot world overview (fork feature). Pure and portable:
// map coordinates are unit squares, x and y in 0..1, with the latitude clamped to the
// Mercator limits. Routes split where they cross the ±180° meridian, so a hop from
// Fiji to Samoa is two short lines, not one across the whole map.

export const MERCATOR_MAX_LAT = 85.05112878;

const toRad = (deg) => (deg * Math.PI) / 180;
const finite = (value) => typeof value === 'number' && Number.isFinite(value);

/** Longitude wrapped into [-180, 180). */
export function wrapLon(lon) {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/**
 * A point on the unit map, or null when the coordinates are missing or not numbers.
 * @param {number} lat Degrees.
 * @param {number} lon Degrees.
 * @returns {{x: number, y: number}|null}
 */
export function project(lat, lon) {
  if (!finite(lat) || !finite(lon)) return null;
  const clamped = Math.max(-MERCATOR_MAX_LAT, Math.min(MERCATOR_MAX_LAT, lat));
  const phi = toRad(clamped);
  const y = (1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2;
  return { x: (wrapLon(lon) + 180) / 360, y };
}

/**
 * Splits a route of points ({lat, lon}) into polylines on the unit map. A leg whose
 * shorter way round crosses the ±180° meridian ends at the map edge and resumes on
 * the other side. Points without coordinates break the route.
 * @param {Array<{lat: number, lon: number}>} points
 * @returns {Array<Array<{x: number, y: number}>>}
 */
export function routeSegments(points) {
  const segments = [];
  let current = [];
  let previous = null;
  const close = () => {
    if (current.length > 1) segments.push(current);
    current = [];
  };
  for (const point of points) {
    const here = project(point?.lat, point?.lon);
    if (!here) {
      close();
      previous = null;
      continue;
    }
    if (previous) {
      const dLon = wrapLon(point.lon) - wrapLon(previous.lon);
      if (Math.abs(dLon) > 180) {
        // The short way crosses the meridian: find where, and cut there.
        const east = dLon < 0; // e.g. 170 to -170 travels east across 180
        const span = 360 - Math.abs(dLon);
        const toEdge = east
          ? 180 - wrapLon(previous.lon)
          : wrapLon(previous.lon) + 180;
        const share = span === 0 ? 0 : toEdge / span;
        const latAtEdge = previous.lat + (point.lat - previous.lat) * share;
        const edge = project(latAtEdge, 0);
        current.push({ x: east ? 1 : 0, y: edge.y });
        close();
        current.push({ x: east ? 0 : 1, y: edge.y });
      }
    }
    current.push(here);
    previous = point;
  }
  close();
  return segments;
}

/** SVG path data for polylines on a map `width` × `height` pixels. */
export function segmentsPath(segments, width, height) {
  return segments
    .map(
      (segment) =>
        `M${segment.map((p) => `${(p.x * width).toFixed(1)} ${(p.y * height).toFixed(1)}`).join('L')}`,
    )
    .join('');
}

/**
 * The camera's heading as an SVG rotation in degrees, 0 pointing up the map. Cesium
 * reports heading in radians, clockwise from north.
 * @param {number} headingRad
 */
export function headingDegrees(headingRad) {
  if (!finite(headingRad)) return 0;
  return ((((headingRad * 180) / Math.PI) % 360) + 360) % 360;
}
