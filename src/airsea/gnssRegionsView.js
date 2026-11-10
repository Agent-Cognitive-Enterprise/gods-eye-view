// Pure helpers for the Ship GNSS Screen layer (fork feature): what the
// `/api/airsea/gnss-regions` answer draws and lists. No Cesium, no i18n.

export const GNSS_REGIONS_LAYER_ID = 'gnss-ship-regions';
/** Ended incidents stay listed (and drawn when asked) for a day. */
export const ENDED_SHOWN_MS = 24 * 3600_000;
const MAX_SPAN_DEG = 60;

const finite = (...values) => values.every((v) => Number.isFinite(v));

/**
 * A region's box with its west edge in [-180, 180) and its east edge after
 * it (possibly beyond 180, across the dateline), or null when it is not a
 * usable box. The detector's boxes are a few H3 cells; anything larger than
 * 60° is refused rather than drawn around the world.
 */
export function normaliseArea(area) {
  if (!area || typeof area !== 'object') return null;
  let { south, north, west, east } = area;
  if (!finite(south, north, west, east)) return null;
  if (!(south < north) || !(west < east)) return null;
  if (north - south > MAX_SPAN_DEG || east - west > MAX_SPAN_DEG) return null;
  south = Math.max(-89.9, south);
  north = Math.min(89.9, north);
  if (!(south < north)) return null;
  const shift = Math.floor((west + 180) / 360) * 360;
  return { south, north, west: west - shift, east: east - shift };
}

/**
 * The box as a closed ring of [lon, lat] degrees, its edges along parallels
 * and meridians densified every `stepDeg`, longitudes continuous (east of
 * the dateline as more than 180) so the ring never wraps the other way.
 */
export function areaRing(area, stepDeg = 0.5) {
  const box = normaliseArea(area);
  if (!box) return null;
  const { south, north, west, east } = box;
  const along = (from, to) => {
    const n = Math.max(1, Math.ceil(Math.abs(to - from) / stepDeg));
    return Array.from({ length: n }, (_, k) => from + ((to - from) * k) / n);
  };
  const ring = [
    ...along(west, east).map((lon) => [lon, south]),
    ...along(south, north).map((lat) => [east, lat]),
    ...along(east, west).map((lon) => [lon, north]),
    ...along(north, south).map((lat) => [west, lat]),
  ];
  ring.push([...ring[0]]);
  return ring;
}

/**
 * The camera rectangle for a box, padded, in Cesium's convention: west and
 * east in [-180, 180], west greater than east when it crosses the dateline.
 */
export function viewRectangle(area) {
  const box = normaliseArea(area);
  if (!box) return null;
  // Generous, so the coast or traffic around it is in view.
  const pad = Math.max(1, box.north - box.south);
  const wrap = (lon) => (lon > 180 ? lon - 360 : lon);
  const width = Math.min(359, box.east - box.west + 2 * pad);
  const west = wrap(
    box.west - pad < -180 ? box.west - pad + 360 : box.west - pad,
  );
  return {
    west,
    east: wrap(west + width),
    south: Math.max(-89, box.south - pad),
    north: Math.min(89, box.north + pad),
  };
}

/**
 * The regions to draw and list: active ones, then incidents that ended in
 * the last day (not listed twice). Malformed entries are dropped.
 */
export function regionsFromAnswer(answer, { now = Date.now() } = {}) {
  const active = [];
  const seen = new Set();
  for (const r of Array.isArray(answer?.regions) ? answer.regions : []) {
    const box = normaliseArea(r?.area);
    if (!box || typeof r.id !== 'string' || seen.has(r.id)) continue;
    seen.add(r.id);
    active.push({
      id: r.id,
      state: 'active',
      ambiguous: r.sourceLocation === 'ambiguous',
      vessels: Number(r.evidence?.uniqueVessels) || 0,
      firstSeenAt: Number(r.firstSeenAt) || null,
      lastSeenAt: Number(r.lastSeenAt) || null,
      area: box,
    });
  }
  const ended = [];
  for (const r of Array.isArray(answer?.recentIncidents)
    ? answer.recentIncidents
    : []) {
    const box = normaliseArea(r?.area);
    if (!box || typeof r.id !== 'string' || seen.has(r.id)) continue;
    const last = Number(r.lastSeenAt);
    if (!Number.isFinite(last) || now - last > ENDED_SHOWN_MS) continue;
    seen.add(r.id);
    ended.push({
      id: r.id,
      state: 'ended',
      ambiguous: r.sourceLocation === 'ambiguous',
      vessels: Number(r.peakVessels) || 0,
      firstSeenAt: Number(r.firstSeenAt) || null,
      lastSeenAt: last,
      area: box,
    });
  }
  active.sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0));
  ended.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  return { active, ended };
}
