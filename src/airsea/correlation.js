// Warning × traffic correlation (fork feature): did traffic through a
// warning area change after the warning took effect, more than around it?
// Pure and portable apart from h3-js.
//
// Three zones per warning: the cells its stated geometry reaches (inside),
// one ring of cells around them (buffer) and two more rings (comparison).
// Passages inside after the warning began are compared with a reference:
// the same hours one to four weeks earlier when two such weeks exist
// (matched baseline), otherwise the same length of time just before the
// warning (pre-warning, low confidence). The comparison ring is the control
// for time of day and feed-wide swings: only a change inside that the ring
// does not share counts. A feed that delivered too little is inconclusive,
// never a change. Association is never causation: causeAssessment stays
// "unconfirmed".

import {
  POLYGON_TO_CELLS_FLAGS,
  getHexagonAreaAvg,
  gridDisk,
  polygonToCellsExperimental,
} from 'h3-js';
import { ANOMALY_RULES, coverageAdequate, median } from './anomaly.js';
import { continuousRing } from './warnings.js';

const HOUR = 3600_000;
const WEEK = 7 * 24 * HOUR;

export const CORRELATION_RULES = Object.freeze({
  // Grids the history keeps hourly; sea zones are often small.
  resolution: Object.freeze({ air: 3, sea: 4 }),
  coarser: Object.freeze({ air: 2, sea: 3 }),
  maxInsideCells: 1500,
  // More corners than this is not a warning area anyone drew by hand.
  maxVertices: 10_000,
  bufferRings: 1,
  comparisonRings: 3,
  minPostMs: HOUR,
  maxPostMs: 6 * HOUR,
  // Passages in the reference (or after, for an increase) before a change
  // is judged at all.
  minSample: 8,
  minRelativeChange: 0.4,
  // A rise around a suppressed area this large reads as possible rerouting.
  reroutingIncrease: 0.25,
  minBaselineWeeks: ANOMALY_RULES.minWeeks,
});

/** Warning domains and the traffic they concern. */
export const TRAFFIC_DOMAIN = Object.freeze({
  aviation: 'air',
  maritime: 'sea',
  marine_weather: 'sea',
});

function polygonsOf(geometry, out = []) {
  if (!geometry) return out;
  if (geometry.type === 'Polygon') out.push(geometry.coordinates);
  else if (geometry.type === 'MultiPolygon') out.push(...geometry.coordinates);
  else if (geometry.type === 'GeometryCollection')
    for (const part of geometry.geometries ?? []) polygonsOf(part, out);
  return out;
}

/**
 * Cells a warning's stated polygons reach, and the rings around them.
 * Points and lines have no area: null (the warning stays a list record).
 */
export function warningZones(geometry, domain, rules = CORRELATION_RULES) {
  const polygons = polygonsOf(geometry);
  if (!polygons.length) return null;
  // Areas h3 cannot read faithfully are not correlated: wider than half the
  // globe (read as their complement), circling a pole, or absurdly detailed.
  let vertices = 0;
  let areaKm2 = 0;
  for (const polygon of polygons) {
    const ring = continuousRing(polygon[0] ?? []);
    vertices += polygon.reduce((n, r) => n + r.length, 0);
    if (ring.length < 4) return null;
    const lons = ring.map(([lon]) => lon);
    const lats = ring.map(([, lat]) => lat);
    const span = Math.max(...lons) - Math.min(...lons);
    if (span > 180 || Math.abs(lons.at(-1) - lons[0]) > 1) return null;
    const midLat =
      ((Math.max(...lats) + Math.min(...lats)) / 2) * (Math.PI / 180);
    areaKm2 +=
      span *
      111.32 *
      Math.cos(midLat) *
      (Math.max(...lats) - Math.min(...lats)) *
      110.57;
  }
  if (vertices > rules.maxVertices) return null;
  // The bounding boxes bound the cell count from above: skip a grid that
  // would be too fine before asking h3 for thousands of cells.
  const fits = (resolution) =>
    areaKm2 / getHexagonAreaAvg(resolution, 'km2') <= 4 * rules.maxInsideCells;
  const reach = (resolution) => {
    if (!fits(resolution)) return null;
    const cells = new Set();
    for (const polygon of polygons) {
      for (const cell of polygonToCellsExperimental(
        polygon,
        resolution,
        POLYGON_TO_CELLS_FLAGS.containmentOverlapping,
        true,
      )) {
        cells.add(cell);
        if (cells.size > rules.maxInsideCells) return null;
      }
    }
    return cells;
  };
  let resolution = rules.resolution[domain];
  let inside = reach(resolution);
  if (!inside) {
    resolution = rules.coarser[domain];
    inside = reach(resolution);
  }
  if (!inside?.size) return null;
  const within = (k) => {
    const out = new Set();
    for (const cell of inside) for (const c of gridDisk(cell, k)) out.add(c);
    return out;
  };
  const near = within(rules.bufferRings);
  const far = within(rules.bufferRings + rules.comparisonRings);
  const buffer = new Set([...near].filter((c) => !inside.has(c)));
  const comparison = new Set([...far].filter((c) => !near.has(c)));
  return { resolution, inside, buffer, comparison };
}

const total = (cells, zone) => {
  let sum = 0;
  for (const cell of zone) sum += cells.get(cell) ?? 0;
  return sum;
};
const change = (after, before, rules) =>
  before >= rules.minSample ? (after - before) / before : null;

/**
 * @param {{warning: object, zones: object, domain: 'air'|'sea',
 *   post: {cells: Map, coverage: {snapshots: number, objects: number}},
 *   pre?: {cells: Map, coverage: object}|null,
 *   weeks?: {cells: Map, coverage: object}[],
 *   expectedSnapshots: number, from: number, to: number}} input
 *   `post`, `pre` and each of `weeks` are passages per cell over windows of
 *   the same length: after the warning began, just before it, and the same
 *   hours 1..n weeks earlier.
 */
export function evaluateCorrelation(
  {
    warning,
    zones,
    domain,
    post,
    pre = null,
    weeks = [],
    expectedSnapshots,
    from,
    to,
  },
  rules = CORRELATION_RULES,
) {
  const base = {
    warningId: warning.id,
    domain,
    resolution: zones.resolution,
    observation: 'inconclusive',
    reason: null,
    changePct: null,
    surroundingChangePct: null,
    reference: null,
    baselineAvailable: false,
    baselineWeeks: 0,
    coverageQuality: 'adequate',
    confidence: null,
    corroboratingSignals: [],
    causeAssessment: 'unconfirmed',
    observedFromUtc: new Date(from).toISOString(),
    observedThroughUtc: new Date(to).toISOString(),
    cells: {
      inside: zones.inside.size,
      buffer: zones.buffer.size,
      comparison: zones.comparison.size,
    },
    passages: null,
  };
  // Weeks the feed delivered in full, judged as the anomaly rules judge.
  const delivered = weeks.filter(
    (w) => coverageAdequate(w.coverage, expectedSnapshots, 0).ok,
  );
  const normalObjects = median(
    delivered.map((w) => w.coverage.objects / w.coverage.snapshots),
  );
  const usable = delivered.filter(
    (w) => coverageAdequate(w.coverage, expectedSnapshots, normalObjects).ok,
  );
  const matched = usable.length >= rules.minBaselineWeeks;
  const preOk =
    pre && coverageAdequate(pre.coverage, expectedSnapshots, 0).ok ? pre : null;
  const reference = matched ? 'matched_baseline' : preOk ? 'pre_warning' : null;
  base.reference = reference;
  base.baselineAvailable = matched;
  base.baselineWeeks = usable.length;
  if (!reference) return { ...base, reason: 'no_reference' };
  const normal = matched
    ? normalObjects
    : preOk.coverage.objects / preOk.coverage.snapshots;
  const now = coverageAdequate(post.coverage, expectedSnapshots, normal);
  if (!now.ok)
    return { ...base, coverageQuality: 'degraded', reason: now.reason };

  const zone = (name) => {
    const after = total(post.cells, zones[name]);
    const before = matched
      ? median(usable.map((w) => total(w.cells, zones[name])))
      : total(preOk.cells, zones[name]);
    return { after, before, change: change(after, before, rules) };
  };
  const inside = zone('inside');
  const buffer = zone('buffer');
  const comparison = zone('comparison');
  base.passages = {
    inside: [inside.before, inside.after],
    buffer: [buffer.before, buffer.after],
    comparison: [comparison.before, comparison.after],
  };
  // Without a comparison ring, a pre-warning reference has no control for
  // the time of day: nothing is judged.
  if (comparison.change === null && !matched)
    return { ...base, reason: 'no_control' };
  // A small reference makes any percentage meaningless, both ways.
  if (inside.change === null) return { ...base, reason: 'insufficient_sample' };
  const insideChange = inside.change;
  const excess = insideChange - (comparison.change ?? 0);
  base.changePct = Math.round(insideChange * 100);
  base.surroundingChangePct =
    comparison.change === null ? null : Math.round(comparison.change * 100);
  let observation = 'no_material_change';
  if (
    insideChange <= -rules.minRelativeChange &&
    excess <= -rules.minRelativeChange
  )
    observation = 'possible_traffic_suppression';
  else if (
    insideChange >= rules.minRelativeChange &&
    excess >= rules.minRelativeChange
  )
    observation = 'possible_traffic_increase';
  const signals = [];
  if (
    observation === 'possible_traffic_suppression' &&
    Math.max(buffer.change ?? -1, comparison.change ?? -1) >=
      rules.reroutingIncrease
  )
    signals.push('adjacent_corridor_increase');
  const confidence =
    reference === 'pre_warning'
      ? 'low'
      : usable.length >= 4
        ? 'high'
        : usable.length >= 3 || comparison.change !== null
          ? 'medium'
          : 'low';
  return {
    ...base,
    observation,
    confidence: observation === 'no_material_change' ? null : confidence,
    corroboratingSignals: signals,
  };
}

/**
 * The window a warning is judged over, in whole hours (as history keeps
 * them), or null while it has not run a complete hour yet.
 */
export function correlationWindow(
  warning,
  now,
  historySince,
  rules = CORRELATION_RULES,
) {
  const start = Date.parse(warning.effectiveFromUtc ?? warning.publishedAtUtc);
  if (!Number.isFinite(start)) return null;
  const end = Date.parse(warning.effectiveUntilUtc ?? '') || Infinity;
  const to = Math.floor(Math.min(now, end) / HOUR) * HOUR;
  const from = Math.max(Math.ceil(start / HOUR) * HOUR, to - rules.maxPostMs);
  if (to - from < rules.minPostMs) return null;
  const length = to - from;
  // The pre-warning window ends at the hour the warning began.
  const preTo = Math.floor(start / HOUR) * HOUR;
  const pre =
    historySince !== null && historySince <= preTo - length
      ? { from: preTo - length, to: preTo }
      : null;
  // Baseline weeks must end before the warning began: a week already under
  // the warning would make a long closure look normal.
  const weeks = [1, 2, 3, 4].filter((k) => to - k * WEEK <= preTo);
  return { from, to, pre, weeks };
}
