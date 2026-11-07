/**
 * Land and water for the regional GNSS screen: a coarse raster of land built
 * from coastline rings, how far a point lies inland, and whether a water
 * route between two sea points fits a distance budget.
 *
 * Coarse on purpose. A cell is 0.05 degrees (about 5.5 km); the Natural Earth
 * pack it is built from is simplified to about 1 km and has no rivers, lakes
 * or canals. So a point counts as inland only well past the coast (callers
 * pick the tolerance), river and lake traffic look inland, and the main ship
 * canals are opened by hand below. A route answer is evidence of an
 * implausible move, never proof: it is `unknown` whenever an end point is
 * inland or the search runs out of budget.
 */

const KM_PER_DEG_LAT = 110.574;
const KM_PER_DEG_LON = 111.32;
// Inland distance is stored in half-kilometre steps, capped (127 km).
const UNIT_KM = 0.5;
const CAP = 255;

function greatCircleKm(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (((b.lon - a.lon + 540) % 360) - 180) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Ship canals and narrow straits that a coarse coastline closes. Each is a
 * line of [lat, lon] points that is forced to water.
 */
export const OPEN_CHANNELS = Object.freeze([
  // Suez Canal: Port Said, Ismailia, Suez.
  [
    [31.27, 32.31],
    [30.6, 32.27],
    [30.3, 32.43],
    [29.95, 32.55],
  ],
  // Panama Canal: Colon, Gatun, Pedro Miguel, Balboa.
  [
    [9.37, -79.92],
    [9.27, -79.92],
    [9.12, -79.75],
    [9.02, -79.61],
    [8.9, -79.53],
  ],
  // Kiel Canal: Brunsbuttel, Rendsburg, Holtenau.
  [
    [53.89, 9.14],
    [54.3, 9.67],
    [54.37, 10.14],
  ],
  // Bosporus, Sea of Marmara edge, Dardanelles.
  [
    [41.23, 29.12],
    [41.0, 29.0],
  ],
  [
    [40.45, 26.7],
    [40.0, 26.2],
  ],
  // Strait of Messina; Corinth Canal.
  [
    [38.27, 15.65],
    [38.05, 15.6],
  ],
  [
    [37.95, 22.95],
    [37.9, 23.0],
  ],
]);

/**
 * @param {Iterable<Array<[number, number]>>} rings outer land rings, [lon, lat]
 * @param {{cellDeg?: number, latMax?: number, channels?: number[][][]}} [options]
 */
export function createLandGrid(
  rings,
  { cellDeg = 0.05, latMax = 85, channels = OPEN_CHANNELS } = {},
) {
  const cols = Math.round(360 / cellDeg);
  const rows = Math.round((2 * latMax) / cellDeg);
  const land = new Uint8Array(cols * rows);
  const rowOf = (lat) => Math.floor((lat + latMax) / cellDeg);
  const colOf = (lon) =>
    ((Math.floor((lon + 180) / cellDeg) % cols) + cols) % cols;
  const latOfRow = (r) => -latMax + (r + 0.5) * cellDeg;

  // Scanline fill, one ring at a time, OR-ed together: a cell is land when
  // its centre is inside any ring. Rings never cross the dateline here
  // (Natural Earth splits them at 180).
  for (const ring of rings) {
    if (!ring || ring.length < 3) continue;
    const crossings = new Map();
    for (let i = 0; i < ring.length; i++) {
      const [x1, y1] = ring[i];
      const [x2, y2] = ring[(i + 1) % ring.length];
      if (y1 === y2) continue;
      const lo = Math.min(y1, y2);
      const hi = Math.max(y1, y2);
      const first = Math.max(0, Math.ceil((lo + latMax) / cellDeg - 0.5));
      const last = Math.min(
        rows - 1,
        Math.floor((hi + latMax) / cellDeg - 0.5),
      );
      for (let r = first; r <= last; r++) {
        const y = latOfRow(r);
        if (y < lo || y >= hi) continue;
        const x = x1 + ((y - y1) * (x2 - x1)) / (y2 - y1);
        let list = crossings.get(r);
        if (!list) crossings.set(r, (list = []));
        list.push(x);
      }
    }
    for (const [r, xs] of crossings) {
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const c0 = Math.ceil((xs[k] + 180) / cellDeg - 0.5);
        const c1 = Math.floor((xs[k + 1] + 180) / cellDeg - 0.5);
        for (let c = Math.max(0, c0); c <= Math.min(cols - 1, c1); c++)
          land[r * cols + c] = 1;
      }
    }
  }

  // Open the hand-listed channels: every cell along each line is water.
  for (const line of channels) {
    for (let i = 0; i + 1 < line.length; i++) {
      const [la1, lo1] = line[i];
      const [la2, lo2] = line[i + 1];
      const steps = Math.ceil(
        Math.max(Math.abs(la2 - la1), Math.abs(lo2 - lo1)) / (cellDeg / 3),
      );
      for (let s = 0; s <= steps; s++) {
        const lat = la1 + ((la2 - la1) * s) / steps;
        const lon = lo1 + ((lo2 - lo1) * s) / steps;
        const r = rowOf(lat);
        if (r >= 0 && r < rows) land[r * cols + colOf(lon)] = 0;
      }
    }
  }

  // Inland distance: a two-pass chamfer transform in half-km units, with
  // east-west steps shrinking with latitude. Water is 0.
  const dist = new Uint8Array(cols * rows);
  const vStep = Math.max(1, Math.round((cellDeg * KM_PER_DEG_LAT) / UNIT_KM));
  const hStep = new Uint8Array(rows);
  const dStep = new Uint8Array(rows);
  for (let r = 0; r < rows; r++) {
    const h =
      (cellDeg * KM_PER_DEG_LON * Math.cos((latOfRow(r) * Math.PI) / 180)) /
      UNIT_KM;
    hStep[r] = Math.max(1, Math.round(h));
    dStep[r] = Math.max(1, Math.round(Math.hypot(h, vStep)));
  }
  for (let i = 0; i < land.length; i++) dist[i] = land[i] ? CAP : 0;
  const relax = (i, j, step) => {
    const v = dist[j] + step;
    if (v < dist[i]) dist[i] = v > CAP ? CAP : v;
  };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (!dist[i]) continue;
      const w = r * cols + ((c - 1 + cols) % cols);
      relax(i, w, hStep[r]);
      if (r > 0) {
        const up = (r - 1) * cols;
        relax(i, up + c, vStep);
        relax(i, up + ((c - 1 + cols) % cols), dStep[r]);
        relax(i, up + ((c + 1) % cols), dStep[r]);
      }
    }
  }
  for (let r = rows - 1; r >= 0; r--) {
    for (let c = cols - 1; c >= 0; c--) {
      const i = r * cols + c;
      if (!dist[i]) continue;
      relax(i, r * cols + ((c + 1) % cols), hStep[r]);
      if (r < rows - 1) {
        const down = (r + 1) * cols;
        relax(i, down + c, vStep);
        relax(i, down + ((c - 1 + cols) % cols), dStep[r]);
        relax(i, down + ((c + 1) % cols), dStep[r]);
      }
    }
  }

  const index = (lat, lon) => {
    const r = rowOf(lat);
    if (!(r >= 0 && r < rows) || !Number.isFinite(lon)) return -1;
    return r * cols + colOf(lon);
  };

  /** Kilometres inland from the nearest water cell; 0 at sea; null off-grid. */
  function inlandKm(lat, lon) {
    const i = index(lat, lon);
    return i < 0 ? null : dist[i] * UNIT_KM;
  }

  // East-west size of a cell in row r, km.
  const cellKm = (r) =>
    Math.max(
      0.001,
      cellDeg * KM_PER_DEG_LON * Math.cos((latOfRow(r) * Math.PI) / 180),
    );

  /**
   * Shortest water route between two points, bounded by `limitKm`.
   * `passableKm`: cells this far inland or less count as water, so narrow
   * straits and the coastline's own error do not close a route. Inland
   * distance runs between cell centres, so the first land cell is already
   * about one cell (5.5 km at the equator) inland: 6 km lets the coastal
   * row through at any latitude, and land necks up to about two cells wide
   * open with it. `maxNodes` and `maxMs` bound one search (20 ms by default):
   * past either it answers `unknown`.
   * @returns {{status:'route', km:number} | {status:'longer'} | {status:'unknown', why:string}}
   */
  function routeKm(
    a,
    b,
    limitKm,
    {
      passableKm = 6,
      maxNodes = 30_000,
      maxMs = 20,
      clock = () => performance.now(),
    } = {},
  ) {
    const deadline = clock() + maxMs;
    const start = index(a.lat, a.lon);
    const goal = index(b.lat, b.lon);
    if (start < 0 || goal < 0) return { status: 'unknown', why: 'off_grid' };
    const passUnits = passableKm / UNIT_KM;
    if (dist[start] > passUnits || dist[goal] > passUnits)
      return { status: 'unknown', why: 'inland_end' };
    const centre = (i) => ({
      lat: latOfRow(Math.floor(i / cols)),
      lon: -180 + ((i % cols) + 0.5) * cellDeg,
    });
    const goalPoint = centre(goal);
    // A slightly shrunk great-circle distance never overestimates a grid path.
    const heuristic = (i) => 0.97 * greatCircleKm(centre(i), goalPoint);
    const g = new Map([[start, 0]]);
    // Binary heap of [f, cell].
    const heap = [[heuristic(start), start]];
    const push = (item) => {
      heap.push(item);
      let k = heap.length - 1;
      while (k > 0) {
        const p = (k - 1) >> 1;
        if (heap[p][0] <= heap[k][0]) break;
        [heap[p], heap[k]] = [heap[k], heap[p]];
        k = p;
      }
    };
    const pop = () => {
      const top = heap[0];
      const end = heap.pop();
      if (heap.length) {
        heap[0] = end;
        let k = 0;
        for (;;) {
          const l = 2 * k + 1;
          const r = l + 1;
          let m = k;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === k) break;
          [heap[m], heap[k]] = [heap[k], heap[m]];
          k = m;
        }
      }
      return top;
    };
    let expanded = 0;
    while (heap.length) {
      const [f, i] = pop();
      if (f > limitKm) return { status: 'longer' };
      const gi = g.get(i);
      if (i === goal) return { status: 'route', km: gi };
      if (f - heuristic(i) > gi + 1e-9) continue; // stale entry
      if (++expanded > maxNodes) return { status: 'unknown', why: 'budget' };
      // A search runs on the AIS ingest path: it stops at its time limit.
      if (expanded % 2048 === 0 && clock() > deadline)
        return { status: 'unknown', why: 'time' };
      const r = Math.floor(i / cols);
      const c = i % cols;
      for (let dr = -1; dr <= 1; dr++) {
        const nr = r + dr;
        if (nr < 0 || nr >= rows) continue;
        const hx = (cellKm(r) + cellKm(nr)) / 2;
        const vy = cellDeg * KM_PER_DEG_LAT;
        for (let dc = -1; dc <= 1; dc++) {
          if (!dr && !dc) continue;
          const j = nr * cols + ((c + dc + cols) % cols);
          if (dist[j] > passUnits) continue;
          const step = Math.hypot(dc * hx, dr * vy);
          const gj = gi + step;
          if (gj < (g.get(j) ?? Infinity)) {
            g.set(j, gj);
            push([gj + heuristic(j), j]);
          }
        }
      }
    }
    return { status: 'longer' };
  }

  /** True when the straight line between two points stays on passable cells. */
  function straightLineClear(a, b, { passableKm = 6 } = {}) {
    const passUnits = passableKm / UNIT_KM;
    let dLon = ((b.lon - a.lon + 540) % 360) - 180;
    const steps = Math.ceil(
      Math.max(Math.abs(b.lat - a.lat), Math.abs(dLon)) / (cellDeg / 2),
    );
    for (let s = 0; s <= steps; s++) {
      const i = index(
        a.lat + ((b.lat - a.lat) * s) / Math.max(1, steps),
        a.lon + (dLon * s) / Math.max(1, steps),
      );
      if (i < 0 || dist[i] > passUnits) return false;
    }
    return true;
  }

  return { inlandKm, routeKm, straightLineClear, cellDeg, source: 'raster' };
}
