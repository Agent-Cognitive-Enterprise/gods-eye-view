// Movement footprint (fork feature): turn consecutive fixes of one aircraft
// or vessel into the H3 cells it passed through and the time it spent in
// each. Pure and portable apart from h3-js.
//
// Rules: a move between two fixes is followed along the great circle only
// when the gap and the implied speed are plausible for the domain; anything
// else is an uncertain gap and paints nothing in between. A passage is one
// entry of one object into one cell: further updates while it stays in the
// cell add time, never another passage.

import { latLngToCell } from 'h3-js';

export const FOOTPRINT_RULES = Object.freeze({
  air: Object.freeze({
    resolutions: Object.freeze([2, 3]),
    maxGapMs: 20 * 60_000,
    maxSpeedKmh: 1300,
    sampleKm: 15,
  }),
  sea: Object.freeze({
    // 2 and 3 match the air grids so the two can share hexagons.
    resolutions: Object.freeze([2, 3, 4]),
    maxGapMs: 3 * 3600_000,
    maxSpeedKmh: 90,
    sampleKm: 4,
  }),
});

const R_KM = 6371.0088;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

export function distanceKm(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Point a fraction `f` of the way along the great circle from a to b. */
export function intermediate(a, b, f) {
  const d = distanceKm(a, b) / R_KM;
  if (d < 1e-9) return { lat: a.lat, lon: a.lon };
  const s = Math.sin(d);
  const A = Math.sin((1 - f) * d) / s;
  const B = Math.sin(f * d) / s;
  const [lat1, lon1, lat2, lon2] = [
    rad(a.lat),
    rad(a.lon),
    rad(b.lat),
    rad(b.lon),
  ];
  const x =
    A * Math.cos(lat1) * Math.cos(lon1) + B * Math.cos(lat2) * Math.cos(lon2);
  const y =
    A * Math.cos(lat1) * Math.sin(lon1) + B * Math.cos(lat2) * Math.sin(lon2);
  const z = A * Math.sin(lat1) + B * Math.sin(lat2);
  return {
    lat: deg(Math.atan2(z, Math.sqrt(x * x + y * y))),
    lon: deg(Math.atan2(y, x)),
  };
}

/**
 * Cells visited between two fixes at one resolution, in order, each with the
 * minutes spent in it; `uncertain` when the move cannot be followed.
 * @returns {{cells: {cell: string, minutes: number, at: number}[],
 *   uncertain: boolean}}
 */
export function segmentCells(previous, next, resolution, rules) {
  const at = next.observedAt;
  const endCell = latLngToCell(next.lat, next.lon, resolution);
  if (!previous)
    return { cells: [{ cell: endCell, minutes: 0, at }], uncertain: false };
  const dtMs = next.observedAt - previous.observedAt;
  if (!(dtMs > 0)) return { cells: [], uncertain: false };
  const km = distanceKm(previous, next);
  const kmh = km / (dtMs / 3600_000);
  if (dtMs > rules.maxGapMs || kmh > rules.maxSpeedKmh)
    return { cells: [{ cell: endCell, minutes: 0, at }], uncertain: true };
  const steps = Math.max(1, Math.ceil(km / rules.sampleKm));
  const cells = [];
  for (let i = 0; i < steps; i++) {
    // Each step's time goes to the cell under its midpoint.
    const mid = intermediate(previous, next, (i + 0.5) / steps);
    const cell = latLngToCell(mid.lat, mid.lon, resolution);
    const minutes = dtMs / steps / 60_000;
    const stepAt = previous.observedAt + (dtMs * (i + 0.5)) / steps;
    const last = cells.at(-1);
    if (last?.cell === cell) last.minutes += minutes;
    else cells.push({ cell, minutes, at: stepAt });
  }
  if (cells.at(-1).cell !== endCell)
    cells.push({ cell: endCell, minutes: 0, at });
  return { cells, uncertain: false };
}

/**
 * Per-object footprint state: the cell each object was last in, per
 * resolution. `observe` returns the passages (new cell entries) and the
 * minutes a new fix adds.
 */
export function createFootprintTracker({ maxObjects = 300_000 } = {}) {
  const state = new Map(); // `${domain}:${id}` -> {fix, cells: {res: cell}}

  function observe(fix, previousFix = null) {
    const rules = FOOTPRINT_RULES[fix.domain];
    if (!rules) return { passages: [], minutes: [], uncertain: false };
    const key = `${fix.domain}:${fix.id}`;
    const known = state.get(key);
    const previous = previousFix ?? known?.fix ?? null;
    if (previous && fix.observedAt <= previous.observedAt)
      return { passages: [], minutes: [], uncertain: false };
    const passages = [];
    const minutes = [];
    let uncertain = false;
    const lastCells = { ...(known?.cells ?? {}) };
    for (const resolution of rules.resolutions) {
      const segment = segmentCells(previous, fix, resolution, rules);
      // After an uncertain gap the object may be on a new trip: its next
      // cell is a new passage even if it is the same cell as before.
      if (segment.uncertain) {
        uncertain = true;
        lastCells[resolution] = null;
      }
      for (const step of segment.cells) {
        if (step.minutes > 0)
          minutes.push({
            resolution,
            cell: step.cell,
            minutes: step.minutes,
            at: step.at,
          });
        if (lastCells[resolution] !== step.cell) {
          passages.push({ resolution, cell: step.cell, at: step.at });
          lastCells[resolution] = step.cell;
        }
      }
    }
    state.delete(key);
    state.set(key, { fix, cells: lastCells });
    for (const oldest of state.keys()) {
      if (state.size <= maxObjects) break;
      state.delete(oldest);
    }
    return { passages, minutes, uncertain };
  }

  return { observe, size: () => state.size };
}
