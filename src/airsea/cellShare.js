// Shared hexagons (fork feature): when air traffic, sea traffic and warning
// areas fall in the same H3 cell, each gets its own slice of the hexagon
// instead of colours stacking into mud. Two owners split the cell in
// halves, three in thirds, always in the order air, sea, warning.
// Pure and portable.

export const SHARE_ORDER = Object.freeze(['air', 'sea', 'warning']);

/**
 * One slice of a closed cell ring ([lon, lat], first point repeated): the
 * centre plus a run of consecutive corners. Halves of a hexagon take three
 * edges each, thirds take two.
 */
export function sectorRing(ring, slot, count) {
  if (!(count > 1)) return ring;
  const corners = ring.slice(0, -1);
  const n = corners.length;
  const centre = [
    corners.reduce((s, [lon]) => s + lon, 0) / n,
    corners.reduce((s, [, lat]) => s + lat, 0) / n,
  ];
  const from = Math.round((slot * n) / count);
  const to = Math.round(((slot + 1) * n) / count);
  const out = [centre];
  for (let i = from; i <= to; i++) out.push(corners[i % n]);
  out.push(centre);
  return out;
}

const bbox = (ring) => {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const [lon, lat] of ring) {
    if (lon < w) w = lon;
    if (lon > e) e = lon;
    if (lat < s) s = lat;
    if (lat > n) n = lat;
  }
  return [w, s, e, n];
};

function inside([x, y], ring) {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)
      hit = !hit;
  }
  return hit;
}

const cross = (a, b, c) =>
  (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const crosses = (p1, p2, q1, q2) =>
  cross(p1, p2, q1) * cross(p1, p2, q2) < 0 &&
  cross(q1, q2, p1) * cross(q1, q2, p2) < 0;

/** Shift a ring by whole turns so it sits beside `near` in longitude. */
function beside(ring, near) {
  const mid = (r) => {
    const [w, , e] = bbox(r);
    return (w + e) / 2;
  };
  const shift = Math.round((mid(near) - mid(ring)) / 360) * 360;
  return shift ? ring.map(([lon, lat]) => [lon + shift, lat]) : ring;
}

/** Do two rings ([lon, lat]) overlap? Flat lon/lat geometry, cell-sized. */
export function ringsOverlap(a, b) {
  const other = beside(b, a);
  const [aw, as, ae, an] = bbox(a);
  const [bw, bs, be, bn] = bbox(other);
  if (aw > be || bw > ae || as > bn || bs > an) return false;
  if (a.some((p) => inside(p, other))) return true;
  if (other.some((p) => inside(p, a))) return true;
  for (let i = 1; i < a.length; i++)
    for (let j = 1; j < other.length; j++)
      if (crosses(a[i - 1], a[i], other[j - 1], other[j])) return true;
  return false;
}

/**
 * The meeting point of the layers. Traffic layers publish the cells they
 * draw; the warning layer publishes its visible area rings. Every layer
 * asks `shares` how to slice a cell and re-renders when told to.
 */
export function createCellShare({ defer = (fn) => queueMicrotask(fn) } = {}) {
  const traffic = { air: new Map(), sea: new Map() }; // h3 -> ring
  const resolutions = { air: null, sea: null };
  let areas = []; // { ring, color, box }
  let warningHits = new Map(); // h3 -> color | null
  const listeners = new Set();
  let pending = false;
  const notify = () => {
    if (pending) return;
    pending = true;
    defer(() => {
      pending = false;
      for (const fn of [...listeners]) fn();
    });
  };

  function warningColor(h3, ring) {
    if (warningHits.has(h3)) return warningHits.get(h3);
    const [w, s, e, n] = bbox(ring);
    // Boxes first: areas can have hundreds of corners.
    const near = ({ box: [aw, as, ae, an] }) =>
      as <= n &&
      an >= s &&
      [-360, 0, 360].some((k) => aw + k <= e && ae + k >= w);
    // A cell wholly inside a hole of the area (water left open) is outside.
    const inHole = (area) =>
      (area.holes ?? []).some((hole) => {
        const shifted = beside(hole, ring);
        return ring.every((p) => inside(p, shifted));
      });
    const hit = areas.find(
      (area) => near(area) && ringsOverlap(ring, area.ring) && !inHole(area),
    );
    const color = hit?.color ?? null;
    warningHits.set(h3, color);
    return color;
  }

  function shares(h3, ring) {
    const owners = SHARE_ORDER.slice(0, 2).filter((o) => traffic[o].has(h3));
    const color = owners.length ? warningColor(h3, ring) : null;
    if (color) owners.push('warning');
    return { owners, warningColor: color };
  }

  return {
    /** @param {'air'|'sea'} owner @param {{h3: string, ring: number[][]}[]} cells */
    publishTraffic(owner, cells, resolution = null) {
      const next = new Map(cells.map((c) => [c.h3, c.ring]));
      const same =
        resolution === resolutions[owner] &&
        next.size === traffic[owner].size &&
        [...next.keys()].every((k) => traffic[owner].has(k));
      if (same) return;
      traffic[owner] = next;
      resolutions[owner] = next.size ? resolution : null;
      notify();
    },
    /** @param {{ring: number[][], holes?: number[][][], color: string}[]} rings */
    publishWarnings(rings) {
      const key = (list) =>
        list.map((a) => `${a.color}:${a.ring}:${a.holes ?? ''}`).join('|');
      if (key(rings) === key(areas)) return;
      areas = rings.map((a) => ({ ...a, box: bbox(a.ring) }));
      warningHits = new Map();
      notify();
    },
    /** The resolution a traffic layer is drawing at, or null when hidden. */
    resolutionOf(owner) {
      return resolutions[owner];
    },
    /**
     * Who shares this cell, in slicing order, and the warning colour when
     * a warning area reaches into it.
     */
    shares,
    /** Every traffic cell a warning area reaches into, with its slice. */
    warningSlices() {
      const cells = new Map();
      for (const owner of ['air', 'sea'])
        for (const [h3, ring] of traffic[owner]) cells.set(h3, ring);
      const out = [];
      for (const [h3, ring] of cells) {
        const { owners, warningColor: color } = shares(h3, ring);
        if (!color) continue;
        out.push({
          h3,
          color,
          ring: sectorRing(ring, owners.indexOf('warning'), owners.length),
        });
      }
      return out;
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
