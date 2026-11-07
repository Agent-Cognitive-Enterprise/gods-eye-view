/**
 * AIS navigation-integrity screening, independent of networking and UI.
 *
 * Detects only coarse REGIONAL, multi-vessel patterns of implausible AIS
 * movement. It does not verify GNSS spoofing, infer transmitters, attribute
 * actors, or expose individual vessels' trajectories. A missing feed is not
 * evidence that shipping stopped. Requires genuine source timestamps.
 *
 * Integration: call `observe()` from the existing AISStream ingest path, and
 * `observeStatic()` for static reports (the ship type sets speed limits).
 * Never open another AIS socket.
 *
 * Fork redesign (6 November 2026): a segment model with three report states.
 * The principle: establish where a ship could NOT have travelled, rather than
 * prove where it is.
 *
 * - Each vessel has one TRUSTED segment: its credible movement history, kept
 *   up to 24 hours. Only plausible reports extend it. A new track is
 *   provisional for its first three reports: an implausible report then
 *   restarts it rather than condemning the ship.
 * - A report the trusted segment cannot explain opens or extends a
 *   QUARANTINED segment, marked `implausible` (beyond what this kind of ship
 *   can physically do, or a jump from sea to deep inland at speed) or
 *   `unknown` (merely suspicious: faster than the screening speed, onto land
 *   at a plausible speed, or with no water route of the needed length).
 * - An implausible report opens an EPISODE that only an explicit recovery
 *   closes. The episode remembers where its false positions went; while it
 *   is open, a report near any of those places, or one a quarantined segment
 *   explains, is still the spoof, whatever the old trusted fix would allow by
 *   now. Recovery takes three consecutive plausible reports, a minute or more
 *   apart in total, clear of all those places. So a spoof held, jittering,
 *   circling, hopping, moved, dragged or drifting is not adopted.
 * - A suspicious segment of a ship whose kind may be fast (ferries, small
 *   craft, unknown) joins the trusted history once it shows that speed
 *   itself; any suspicious segment, outside an episode, joins once it has
 *   moved for two minutes at no more than the screening speed.
 * - Silence is an observation gap, never a track: the last credible position
 *   is kept and a reappearance is judged over the whole gap. Silence alone is
 *   never evidence of anything.
 * - A vote needs an implausible jump from a trusted segment continuous for 30
 *   minutes (a gap, recovery or adoption restarts that clock), with a credible
 *   fix at most 30 minutes old; later implausible reports of the same episode
 *   renew it. Feed faults never vote: corrupted position fields (a zeroed,
 *   sign-flipped or swapped coordinate), a report repeating where the ship
 *   was earlier (a stale backlog), or two ships sharing one MMSI. A jump
 *   leaving one coordinate unchanged is ambiguous: it votes, but cannot make
 *   a region on its own, and marks no landing zone. A track restarted at 24 hours during an episode cannot
 *   vote for a day, nor can a ship first seen where other ships' spoofed
 *   positions were landing (it may be trusted at a false position). Regions
 *   are where the voting ships credibly were, in about 50 km H3 cells counted
 *   with their neighbours, and only when their false positions agree.
 *
 * Known limits: a track that starts while already spoofed is trusted as it
 * is; a spoof that moves at a believable speed from a believable start, or
 * that moved more than 2 km during a reception gap, is not caught without
 * independent reference data; river, lake and port traffic looks inland on
 * the coarse coastline, so land counts only for a jump from the sea by a
 * vessel never seen inland; landing zones live in memory, so after a restart
 * during a spoof a region can appear at the spoof target.
 */

import { cellToBoundary, gridDisk, latLngToCell } from 'h3-js';

/**
 * Speed limits in knots by kind of ship. Up to `screening`, a move is
 * plausible; up to `physical` it is suspicious; beyond, implausible. The
 * screening figure follows the JMIC practice of flagging commercial ships
 * over 30 kn, 40 kn for an unknown vessel. A vessel's own demonstrated speed
 * raises its screening limit (never above `physical`) only where fast craft
 * are normal (`fastAllowed`).
 */
export const SPEED_CLASSES = Object.freeze({
  merchant: Object.freeze({ screening: 30, physical: 40, fastAllowed: false }),
  work: Object.freeze({ screening: 30, physical: 50, fastAllowed: false }),
  passenger: Object.freeze({ screening: 40, physical: 60, fastAllowed: true }),
  fast: Object.freeze({ screening: 60, physical: 100, fastAllowed: true }),
  // An unknown vessel's own speed raises its screening limit to 60 kn at
  // most: sustained 60-100 kn earns no unknown vessel a clean record.
  unknown: Object.freeze({
    screening: 40,
    physical: 100,
    fastAllowed: true,
    raiseCap: 60,
  }),
});

/** The speed class of an AIS ship-type code (ITU-R M.1371). */
export function speedClassForShipType(code, { classB = false } = {}) {
  const type = Number(code);
  if (!Number.isInteger(type) || type <= 0 || type > 99)
    return classB ? 'fast' : 'unknown';
  if (type >= 70 && type <= 89) return 'merchant';
  if (type >= 60 && type <= 69) return 'passenger';
  if ((type >= 20 && type <= 29) || (type >= 40 && type <= 49)) return 'fast';
  if ([35, 36, 37, 50, 51, 55].includes(type)) return 'fast';
  if ([30, 31, 32, 33, 34, 52, 53, 54, 58].includes(type)) return 'work';
  return classB ? 'fast' : 'unknown';
}

export const REGIONAL_GNSS_RULES = Object.freeze({
  // Multi-vessel correlation: votes count for this long after their latest
  // report, so a region lives only while fresh observations support it.
  windowMs: 30 * 60_000,
  // Per-vessel memory: the last credible position is kept this long.
  historyMs: 24 * 60 * 60_000,
  maxFixAgeMs: 5 * 60_000,
  maxFutureMs: 2 * 60_000,
  // Silence longer than this is an observation gap.
  gapMs: 10 * 60_000,
  // Position and time slack when judging a step: AIS positions wobble, and a
  // report's time is known to about the adapter's 15-second tolerance.
  positionNoiseKm: 0.5,
  timeToleranceMs: 15_000,
  // Drag check: a report must also be reachable from segment points up to
  // this far back, so many short steps cannot add up to an impossible move.
  lookbackMs: 10 * 60_000,
  minJumpKm: 10,
  // A vote needs a jump this long (or one onto land), outside the source
  // cell's neighbourhood, so local glitches never count.
  minVoteJumpKm: 50,
  minTrackAgeMs: 30 * 60_000,
  provisionalReports: 3,
  recoveryReports: 3,
  recoveryMinSpanMs: 60_000,
  // A recovery candidate must be at least this far from every quarantined
  // position, so a spoof that jitters or circles is never its own recovery.
  recoveryClearKm: 10,
  // After a gap, a quarantined segment is continued only by a point this
  // close to where it was left.
  staleContinueKm: 2,
  promotionReports: 3,
  promotionMinSpanMs: 2 * 60_000,
  // Kilometres past the (coarse) coastline before a point counts as land.
  landToleranceKm: 10,
  // Only steps at least this long are checked for a water route, and at most
  // this many route searches run per minute of processing time.
  routeCheckKm: 20,
  routeSearchesPerMinute: 120,
  // At most this many searches back to back, whatever the rate allows.
  routeBurst: 4,
  // A report within this distance of where the ship was minutes or hours
  // earlier is a stale repeat, not a jump.
  staleRepeatKm: 1.5,
  minVessels: 3,
  // 'h3': regions in resolution-4 cells (about 50 km) with their neighbours;
  // false positions agree within a resolution-4 cell and its neighbours (up
  // to about 130 km apart: at resolution 3, 40% of random independent jumps
  // looked coherent); a jump must leave its resolution-5 neighbourhood
  // (about 20 km cells). 'degree': the older 1-degree grid, kept to compare.
  // The Danish AIS replay of the July 2025 Baltic spoofing chose these:
  // 20 km cells were too fine for open-sea traffic and missed most of a day.
  grid: 'h3',
  h3Resolution: 4,
  h3TargetResolution: 4,
  h3LocalResolution: 5,
  // Spoof landing zones (see `zoneSince`); false only to compare. A zone
  // forms when three vessels' first false positions land within this time,
  // so a spoof that captures ships one by one makes one too.
  landingZones: true,
  zoneFormMs: 3 * 60 * 60_000,
  cellDeg: 1,
  warmupMs: 30 * 60_000,
  // About 2 KB a track: 60,000 tracks is about 120 MB.
  maxTrackedVessels: 60_000,
  maxStatic: 100_000,
  maxCandidates: 20_000,
  maxQuarantineSegments: 3,
});

const R = 6371.0088;
const toRad = (degrees) => (degrees * Math.PI) / 180;
const isFiniteNumber = (x) => typeof x === 'number' && Number.isFinite(x);
const KNOT_KMH = 1.852;

export function distanceKm(a, b) {
  const p1 = toRad(a.lat);
  const p2 = toRad(b.lat);
  const dLat = p2 - p1;
  const dLon = toRad(((b.lon - a.lon + 540) % 360) - 180);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(p1) * Math.cos(p2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Bounded degree cells. 180 longitude maps into -180 and polar points are excluded. */
export function regionalCell(lat, lon, cellDeg = 1) {
  if (
    !isFiniteNumber(lat) ||
    !isFiniteNumber(lon) ||
    Math.abs(lat) >= 85 ||
    Math.abs(lon) > 180
  )
    return null;
  const normalizedLon = ((((lon + 180) % 360) + 360) % 360) - 180;
  const row = Math.floor((lat + 90) / cellDeg);
  const col = Math.floor((normalizedLon + 180) / cellDeg);
  return `${row}:${col}`;
}

/** Cells apart (Chebyshev), longitude wrapping at the dateline. */
export function cellDistance(a, b, cellDeg = 1) {
  const [ra, ca] = a.split(':').map(Number);
  const [rb, cb] = b.split(':').map(Number);
  const cols = 360 / cellDeg;
  const dc = Math.abs(ca - cb) % cols;
  return Math.max(Math.abs(ra - rb), Math.min(dc, cols - dc));
}

/**
 * The cell scheme: a source cell, its neighbourhood, a coarser target cell
 * and whether two target cells agree, and a cell's bounds.
 */
function gridScheme(rules) {
  if (rules.grid === 'degree') {
    const deg = rules.cellDeg;
    if (!(deg > 0) || 360 % deg !== 0)
      throw new RangeError('cellDeg must divide 360');
    return {
      label: `degree-${deg}`,
      source: (p) => regionalCell(p.lat, p.lon, deg),
      target: (p) => regionalCell(p.lat, p.lon, deg),
      near: (a, b) => cellDistance(a, b, deg) <= 1,
      agree: (a, b) => cellDistance(a, b, deg) <= 1,
      localCell: (p) => regionalCell(p.lat, p.lon, deg),
      localNeighbours(cell) {
        const [r, c] = cell.split(':').map(Number);
        const cols = 360 / deg;
        const out = [];
        for (let dr = -1; dr <= 1; dr++)
          for (let dc = -1; dc <= 1; dc++)
            out.push(`${r + dr}:${(((c + dc) % cols) + cols) % cols}`);
        return out;
      },
      local(a, b) {
        const ca = regionalCell(a.lat, a.lon, deg);
        const cb = regionalCell(b.lat, b.lon, deg);
        return ca !== null && cb !== null && cellDistance(ca, cb, deg) <= 1;
      },
      neighbours(cell) {
        const [r, c] = cell.split(':').map(Number);
        const cols = 360 / deg;
        const out = [];
        for (let dr = -1; dr <= 1; dr++)
          for (let dc = -1; dc <= 1; dc++)
            out.push(`${r + dr}:${(((c + dc) % cols) + cols) % cols}`);
        return out;
      },
      bounds(cell) {
        const [r, c] = cell.split(':').map(Number);
        const south = -90 + r * deg;
        const west = -180 + c * deg;
        return { south, west, north: south + deg, east: west + deg };
      },
    };
  }
  const res = rules.h3Resolution;
  const targetRes = rules.h3TargetResolution;
  const localRes = rules.h3LocalResolution ?? res;
  const inRange = (p) =>
    isFiniteNumber(p.lat) &&
    isFiniteNumber(p.lon) &&
    Math.abs(p.lat) < 85 &&
    Math.abs(p.lon) <= 180;
  const disks = new Map();
  const disk = (cell) => {
    let set = disks.get(cell);
    if (!set) {
      if (disks.size > 50_000) disks.clear();
      disks.set(cell, (set = new Set(gridDisk(cell, 1))));
    }
    return set;
  };
  return {
    label: `h3-r${res}`,
    source: (p) => (inRange(p) ? latLngToCell(p.lat, p.lon, res) : null),
    target: (p) => (inRange(p) ? latLngToCell(p.lat, p.lon, targetRes) : null),
    near: (a, b) => a === b || disk(a).has(b),
    agree: (a, b) => a === b || disk(a).has(b),
    neighbours: (cell) => [...disk(cell)],
    // Whether b lies in a's own fine neighbourhood (about 50 km across): a
    // jump that stays there is local, whatever the region cells.
    localCell: (p) =>
      inRange(p) ? latLngToCell(p.lat, p.lon, localRes) : null,
    localNeighbours: (cell) => [...disk(cell)],
    local(a, b) {
      if (!inRange(a) || !inRange(b)) return true;
      const ca = latLngToCell(a.lat, a.lon, localRes);
      const cb = latLngToCell(b.lat, b.lon, localRes);
      return ca === cb || disk(ca).has(cb);
    },
    bounds(cell) {
      const ring = cellToBoundary(cell);
      const lats = ring.map(([lat]) => lat);
      const lons = ring.map(([, lon]) => lon);
      // A cell straddling the dateline: report it on the west side.
      let west = Math.min(...lons);
      let east = Math.max(...lons);
      if (east - west > 180) {
        const shifted = lons.map((lon) => (lon < 0 ? lon + 360 : lon));
        west = Math.min(...shifted) - 360;
        east = Math.max(...shifted) - 360;
      }
      return {
        south: Math.min(...lats),
        north: Math.max(...lats),
        west,
        east,
      };
    },
  };
}

/**
 * Fork: a ship station's MMSI: nine digits with a maritime identification
 * digit (MID) of 201-775. A placeholder of one repeated digit (222222222) is
 * refused: one MMSI on several ships is the classic source of fake jumps.
 */
export function validMmsi(id) {
  const text = String(id ?? '');
  if (!/^[0-9]{9}$/.test(text)) return false;
  const mid = Number(text.slice(0, 3));
  if (mid < 201 || mid > 775) return false;
  // One digit nine times, or a country code with six zeros (412000000):
  // defaults that many unconfigured transponders share.
  return !/^(\d)\1{8}$/.test(text) && !/^\d{3}0{6}$/.test(text);
}

/**
 * Fork: a jump that looks like a corrupted position field rather than a
 * moved ship.
 * - `zeroed`: a coordinate collapsed towards 0 while the ship was well away
 *   from it. Seen in live AISStream data (6 November 2026): inland vessels
 *   near 52 N 5 E reported single positions at their own latitude with a
 *   longitude of 0.007 to 0.1, several ships within minutes.
 * - `sign_flip`: a coordinate with its sign flipped.
 * - `swapped`: latitude and longitude swapped.
 * - `one_axis`: one coordinate unchanged while the other moves far.
 * `toleranceDeg` is how far the ship may really have moved since `a`; the
 * caller scales it with the time elapsed.
 */
export function encodingArtefact(a, b, toleranceDeg = 0.0005) {
  const tol = Math.max(0.0005, toleranceDeg);
  const same = (x, y) => Math.abs(x - y) <= tol;
  const dLat = Math.abs(a.lat - b.lat);
  const dLon = Math.abs(((b.lon - a.lon + 540) % 360) - 180);
  if (
    Math.abs(a.lon) >= 1 &&
    Math.abs(b.lon) < Math.min(0.15, 0.05 * Math.abs(a.lon))
  )
    return 'zeroed';
  if (
    Math.abs(a.lat) >= 1 &&
    Math.abs(b.lat) < Math.min(0.15, 0.05 * Math.abs(a.lat))
  )
    return 'zeroed';
  if (Math.abs(a.lat) >= 0.1 && same(a.lat, -b.lat)) return 'sign_flip';
  if (Math.abs(a.lon) >= 0.1 && same(a.lon, -b.lon)) return 'sign_flip';
  if (same(a.lat, b.lon) && same(a.lon, b.lat)) return 'swapped';
  if (same(a.lat, b.lat) && dLon >= 0.1) return 'one_axis';
  if (same(a.lon, b.lon) && dLat >= 0.1) return 'one_axis';
  return null;
}

// Sparse ring sizes: the trusted ring spans the 10-minute drag lookback at
// one point a minute; other segments keep fewer.
const TRUSTED_RING = 11;
const OTHER_RING = 4;
// The trusted trail: one point every 15 minutes for two hours, to recognise a
// stale repeat of an earlier position.
const TRAIL_EVERY_MS = 15 * 60_000;
const TRAIL_POINTS = 8;

/** A segment: its kind, its start, its last two points and a sparse ring. */
function newSegment(kind, point, extra = {}) {
  return {
    kind,
    startedAt: point.observedAt,
    first: point,
    tail: point,
    prev: null,
    ring: [point],
    reports: 1,
    ...extra,
  };
}

function extendSegment(segment, point) {
  segment.prev = segment.tail;
  segment.tail = point;
  segment.reports++;
  const last = segment.ring.at(-1);
  if (point.observedAt - last.observedAt >= 60_000) {
    segment.ring.push(point);
    const cap = segment.kind === 'trusted' ? TRUSTED_RING : OTHER_RING;
    if (segment.ring.length > cap) segment.ring.shift();
  }
}

/** A segment's points in time order, for adopting it into the trusted one. */
const pointsOf = (segment) => {
  const out = [segment.first, ...segment.ring, segment.tail];
  return out.filter((p, k) => k === 0 || p.observedAt > out[k - 1].observedAt);
};

/**
 * Input contract:
 * { mmsi, lat, lon, observedAt, receivedAt?, timeQuality:'source',
 *   provider?:'aisstream', transponderClass?: 'A'|'B' }
 * observedAt / receivedAt are epoch milliseconds, never seconds.
 * `timeQuality` must be 'source': fallback-ingest timestamps aren't evidence.
 * `geography` (optional): { inlandKm(lat, lon), routeKm(a, b, limitKm),
 * straightLineClear(a, b) }, see gnssGeography.js.
 */
export function createRegionalGnssDetector({
  now = () => Date.now(),
  rules = REGIONAL_GNSS_RULES,
  geography = null,
  // Processing time, for the route-search budget: AIS times arrive out of
  // order across vessels and must not refill it.
  clock = () => performance.now(),
} = {}) {
  const grid = gridScheme(rules);
  const tracks = new Map();
  const statics = new Map();
  const votes = new Map();
  const incidents = new Map();
  // Spoof landing points: target cell -> vessel -> when a false position of
  // that vessel last landed there.
  const landings = new Map();
  // When votes last renewed at a landing cell: a spoof still holding there.
  // Renewals refresh existing cells only, so a dragged spoof paints no lane.
  const activity = new Map();
  const counters = {
    accepted: 0,
    ignored: 0,
    outOfOrder: 0,
    gaps: 0,
    implausible: 0,
    unknown: 0,
    plausible: 0,
    recoveries: 0,
    promotions: 0,
    resolved: 0,
    restarts: 0,
    historyResets: 0,
    identityConflicts: 0,
    zoneExcluded: 0,
    routeSearches: 0,
    routeSkipped: 0,
    evicted: 0,
  };
  const evidence = {
    ambiguous_axis: 0,
    speed: 0,
    land: 0,
    route: 0,
    encoding: 0,
    stale: 0,
    after_gap: 0,
  };
  let lastReportAt = null;
  let lastPruneAt = -Infinity;
  let routeTokens = rules.routeBurst;
  let routeClock = null;
  const startedAt = now();

  function prune(at, { force = false } = {}) {
    // Sweep at most every 30 seconds: AIS delivers thousands of reports a
    // second, and a clock moved back cannot force a sweep per message.
    if (force || at - lastPruneAt >= 30_000) {
      for (const [id, vote] of votes)
        if (vote.at < at - rules.windowMs) votes.delete(id);
      for (const [id, track] of tracks)
        if (track.latestAt < at - rules.historyMs) tracks.delete(id);
      for (const [id, item] of statics)
        if (item.at < at - rules.historyMs) statics.delete(id);
      for (const [id, item] of incidents)
        if (item.lastSeenAt < at - rules.historyMs) incidents.delete(id);
      for (const [cell, byVessel] of landings) {
        for (const [id, t] of byVessel)
          if (t < at - rules.historyMs) byVessel.delete(id);
        if (!byVessel.size) landings.delete(cell);
      }
      for (const [cell, t] of activity)
        if (t < at - rules.historyMs || !landings.has(cell))
          activity.delete(cell);
      lastPruneAt = at;
    }
    while (landings.size > rules.maxCandidates)
      landings.delete(landings.keys().next().value);
    for (const map of [tracks, statics, votes]) {
      const cap =
        map === tracks
          ? rules.maxTrackedVessels
          : map === statics
            ? rules.maxStatic
            : rules.maxCandidates;
      while (map.size > cap) {
        map.delete(map.keys().next().value);
        counters.evicted++;
      }
    }
  }

  function reject(fix, at) {
    if (!fix || !validMmsi(fix.mmsi)) return 'invalid_id';
    if (
      !isFiniteNumber(fix.lat) ||
      !isFiniteNumber(fix.lon) ||
      Math.abs(fix.lat) >= 85 ||
      Math.abs(fix.lon) > 180 ||
      // Null Island placeholders: a coordinate exactly zero within a degree
      // of 0 N 0 E is a transponder without a fix (seen in Danish data: a
      // fishing vessel at 0.98 N, 0.000000 E). Real positions nearby count.
      (Math.abs(fix.lat) < 1 &&
        Math.abs(fix.lon) < 1 &&
        (fix.lat === 0 || fix.lon === 0))
    )
      return 'invalid_position';
    if (!isFiniteNumber(fix.observedAt) || fix.timeQuality !== 'source')
      return 'untrusted_time';
    if (
      fix.observedAt > at + rules.maxFutureMs ||
      fix.observedAt < at - rules.maxFixAgeMs
    )
      return 'stale_or_future';
    return null;
  }

  /** Static report: remember the ship type, which sets its speed limits. */
  function observeStatic({ mmsi, shipType, receivedAt } = {}) {
    if (!validMmsi(mmsi)) return false;
    const type = Number(shipType);
    if (!Number.isInteger(type) || type <= 0 || type > 99) return false;
    const id = String(mmsi);
    statics.delete(id);
    statics.set(id, {
      type,
      at: isFiniteNumber(receivedAt) ? receivedAt : now(),
    });
    return true;
  }

  function limitsFor(id, track) {
    const kind = speedClassForShipType(statics.get(id)?.type, {
      classB: track.classB,
    });
    const cls = SPEED_CLASSES[kind];
    const demonstrated =
      track.demonstratedAt != null &&
      track.latestAt - track.demonstratedAt <= rules.historyMs
        ? track.demonstratedKnots
        : 0;
    const screening = cls.fastAllowed
      ? Math.max(
          cls.screening,
          Math.min(cls.raiseCap ?? cls.physical, 1.2 * demonstrated),
        )
      : cls.screening;
    return { kind, screening, physical: cls.physical, cls };
  }

  /** Lenient implied speed: allows position noise and timing slack. */
  function knots(a, b, km = distanceKm(a, b)) {
    const hours =
      (Math.abs(b.observedAt - a.observedAt) + rules.timeToleranceMs) /
      3600_000;
    return Math.max(0, km - rules.positionNoiseKm) / hours / KNOT_KMH;
  }

  const inland = (p) => geography?.inlandKm?.(p.lat, p.lon) ?? 0;

  /**
   * How a point relates to a segment: the implied speed from its last two
   * points (the better of the two, so one glitch does not block; the earlier
   * one only if within a minute of the last), at least
   * the speed from the sparse ring within `lookbackMs` (so short steps
   * cannot add up to a drag), and the straight-line distance.
   */
  function relate(segment, point) {
    const fromTail = knots(segment.tail, point);
    // The point before the tail counts only when close to it in time: it
    // forgives one glitch, not a jump measured from an old fix.
    const fromPrev =
      segment.prev &&
      segment.tail.observedAt - segment.prev.observedAt <= 60_000
        ? knots(segment.prev, point)
        : Infinity;
    let speed = Math.min(fromTail, fromPrev);
    for (const r of segment.ring) {
      const age = point.observedAt - r.observedAt;
      if (age >= 60_000 && age <= rules.lookbackMs)
        speed = Math.max(speed, knots(r, point));
    }
    return { speed, km: distanceKm(segment.tail, point) };
  }

  /**
   * At most `routeSearchesPerMinute` searches, `routeBurst` back to back,
   * refilled by processing time (monotonic), never by AIS time.
   */
  function routeAllowed() {
    const at = clock();
    if (routeClock === null) routeClock = at;
    const elapsed = Math.max(0, at - routeClock);
    routeTokens = Math.min(
      rules.routeBurst,
      routeTokens + (elapsed / 60_000) * rules.routeSearchesPerMinute,
    );
    routeClock = at;
    if (routeTokens < 1) return false;
    routeTokens--;
    return true;
  }

  /** The water route from the trusted tail, cached per tail and target. */
  function route(track, tail, point, budgetKm) {
    const key = `${tail.observedAt}:${Math.round(point.lat * 20)}:${Math.round(point.lon * 20)}`;
    const cached = track.routeCache?.key === key ? track.routeCache : null;
    // A found route's length holds for any budget; "longer than" holds only
    // for a budget no more than 10% larger than the one it was searched with.
    if (cached?.answer.status === 'route') return cached.answer;
    // A search that gave up (time or size) is not repeated for the same
    // budget either: a held ship would otherwise use the shared budget on
    // every report.
    if (
      (cached?.answer.status === 'longer' ||
        cached?.answer.status === 'unknown') &&
      budgetKm <= cached.budgetKm * 1.1
    )
      return cached.answer;
    if (!routeAllowed()) {
      counters.routeSkipped++;
      return { status: 'unknown', why: 'rate' };
    }
    counters.routeSearches++;
    const answer = geography.routeKm(tail, point, budgetKm);
    track.routeCache = { key, answer, budgetKm };
    return answer;
  }

  /**
   * Judge a point against the trusted segment: plausible, unknown or
   * implausible, with the evidence.
   */
  function judge(track, point, limits) {
    const { speed, km } = relate(track.trusted, point);
    const tail = track.trusted.tail;
    const found = [];
    let routeSpeed = speed;
    // A water route around land between two sea points, for long steps that
    // would otherwise be plausible: a route can only make a move suspicious.
    if (
      geography?.routeKm &&
      km >= rules.routeCheckKm &&
      speed <= limits.screening &&
      !geography.straightLineClear?.(tail, point)
    ) {
      const hours =
        (point.observedAt - tail.observedAt + rules.timeToleranceMs) / 3600_000;
      const budgetKm =
        limits.physical * KNOT_KMH * hours + rules.positionNoiseKm;
      const answer = route(track, tail, point, budgetKm);
      if (answer.status === 'longer') {
        routeSpeed = Infinity;
        found.push('route');
      } else if (answer.status === 'route') {
        routeSpeed = Math.max(speed, knots(tail, point, answer.km));
        if (routeSpeed > limits.screening) found.push('route');
      }
    }
    // Onto land from the sea, by a vessel never seen inland.
    const onto =
      !track.seenInland &&
      km >= rules.minJumpKm &&
      inland(point) >= rules.landToleranceKm &&
      inland(tail) < rules.landToleranceKm;
    if (onto) found.push('land');
    if (speed > limits.screening) found.push('speed');
    let state = 'plausible';
    if (speed > limits.physical) state = 'implausible';
    else if (onto && speed > limits.screening) state = 'implausible';
    else if (speed > limits.screening || onto || routeSpeed > limits.screening)
      // Suspicious, not proof: the coastline is coarse and a route search
      // can miss a channel, so neither land at a ship's pace nor a missing
      // route alone marks a report implausible.
      state = 'unknown';
    let encoding = null;
    let stale = false;
    if (state !== 'plausible' && km >= rules.minJumpKm) {
      // How far the ship may really have moved since its tail, in degrees.
      const reach =
        (limits.physical *
          KNOT_KMH *
          ((point.observedAt - tail.observedAt) / 3600_000)) /
        111;
      const artefact = encodingArtefact(
        tail,
        point,
        Math.min(0.005, 0.0005 + reach),
      );
      // One coordinate unchanged could be a corrupted field or a real spoof
      // along a parallel or meridian: ambiguous, so it votes but cannot make
      // a region on its own. A zeroed, sign-flipped or swapped field is
      // corruption and never votes.
      // Ambiguous when the coordinate matches, to 55 m, the last fix or where
      // the ship would be now on its course: a moving ship's corrupted report
      // keeps its current latitude, not its last fix's.
      if (artefact === 'one_axis') {
        const v = velocityOf(track);
        const hours = Math.min(
          24,
          Math.max(0, (point.observedAt - tail.observedAt) / 3600_000),
        );
        const reckoned = {
          lat: tail.lat + v.lat * hours,
          lon: tail.lon + v.lon * hours,
        };
        if (
          encodingArtefact(tail, point) === 'one_axis' ||
          encodingArtefact(reckoned, point) === 'one_axis'
        )
          found.push('ambiguous_axis');
      } else if (artefact) {
        encoding = artefact;
        found.push('encoding');
      }
      // A stale repeat: back where the ship was minutes or hours ago.
      stale = [...track.trusted.ring, ...track.trail].some(
        (p) =>
          tail.observedAt - p.observedAt >= 2 * 60_000 &&
          distanceKm(p, point) <= rules.staleRepeatKm,
      );
      if (stale) found.push('stale');
    }
    return { state, speed, km, evidence: found, onto, encoding, stale };
  }

  function newTrack(point, fix, carry = {}) {
    return {
      firstSeenAt: point.observedAt,
      latestAt: point.observedAt,
      classB: fix.transponderClass === 'B',
      trusted: newSegment('trusted', point),
      firstPoint: point,
      trail: [point],
      spoofPoints: [],
      spoofOrigin: null,
      velocity: null,
      // Since when the trusted history has been continuous: votes need 30
      // minutes of it.
      sourceSince: point.observedAt,
      quarantine: [],
      recovery: null,
      lastImplausibleAt: null,
      episode: 0,
      episodeOpen: false,
      demonstratedKnots: 0,
      demonstratedAt: null,
      seenInland: inland(point) >= rules.landToleranceKm,
      taintedUntil: null,
      conflictAt: null,
      routeCache: null,
      ...carry,
    };
  }

  function result(state, reason, extra = {}) {
    counters[state]++;
    return { accepted: true, assessment: state, reason, ...extra };
  }

  /** Extend the trusted segment with a plausible point. */
  function trust(track, point, { keepClock = false } = {}) {
    const tail = track.trusted.tail;
    // A trusted history that lapsed for a gap is continuous again only from
    // here: the 30 minutes before a vote start afresh. Not after a recovery
    // from a spoof the ship reported through without falling silent.
    if (!keepClock && point.observedAt - tail.observedAt > rules.gapMs)
      track.sourceSince = point.observedAt;
    const back = track.trusted.ring.find(
      (r) =>
        point.observedAt - r.observedAt >= 2 * 60_000 &&
        point.observedAt - r.observedAt <= rules.lookbackMs,
    );
    if (back) {
      // An honest measure of its pace over two minutes or more.
      const pace =
        distanceKm(back, point) /
        ((point.observedAt - back.observedAt) / 3600_000) /
        KNOT_KMH;
      const current =
        track.demonstratedAt != null &&
        point.observedAt - track.demonstratedAt <= rules.historyMs
          ? track.demonstratedKnots
          : 0;
      if (pace > current) {
        track.demonstratedKnots = pace;
        track.demonstratedAt = point.observedAt;
      }
      // Course and speed, for where the ship would be if it held them.
      const hours = (point.observedAt - back.observedAt) / 3600_000;
      track.velocity = {
        lat: (point.lat - back.lat) / hours,
        lon:
          (((((point.lon - back.lon + 540) % 360) + 360) % 360) - 180) / hours,
        at: point.observedAt,
      };
    }
    extendSegment(track.trusted, point);
    if (point.observedAt - track.trail.at(-1).observedAt >= TRAIL_EVERY_MS) {
      track.trail.push(point);
      if (track.trail.length > TRAIL_POINTS) track.trail.shift();
    }
    if (inland(point) >= rules.landToleranceKm) track.seenInland = true;
  }

  /** Make a segment part of the trusted history. */
  function adopt(track, segment, options) {
    for (const p of pointsOf(segment))
      if (p.observedAt > track.trusted.tail.observedAt)
        trust(track, p, options);
    track.quarantine = [];
    track.recovery = null;
    track.routeCache = null;
  }

  /**
   * Remember where a voting vessel's false position first landed, in the
   * fine cells. Only the jump that creates a vote counts, not its renewals,
   * so a spoof dragged along a lane marks one point, not the lane; and votes
   * already need a clean, continuous track and a long jump, so ordinary
   * glitches mark nothing.
   */
  function land(id, point) {
    const cell = grid.localCell(point);
    if (!cell) return;
    const byVessel = landings.get(cell) ?? new Map();
    // Re-inserted, so eviction drops the zone longest without a landing.
    landings.delete(cell);
    landings.set(cell, byVessel);
    byVessel.delete(id);
    byVessel.set(id, point.observedAt);
    if (byVessel.size > 1000) byVessel.delete(byVessel.keys().next().value);
  }

  /**
   * A spoof landing zone: within this fine cell or its neighbours (about
   * 50 km across), the first false positions of at least `minVessels` other
   * vessels landed within `zoneFormMs` of one another in the last day.
   */
  function zoneSpan(cell, id, at) {
    if (!rules.landingZones || !cell) return null;
    const times = [];
    let until = -Infinity;
    for (const near of grid.localNeighbours(cell)) {
      for (const [vid, t] of landings.get(near) ?? [])
        if (vid !== id && at - t <= rules.historyMs && t <= at) times.push(t);
      until = Math.max(until, activity.get(near) ?? -Infinity);
    }
    if (times.length < rules.minVessels) return null;
    times.sort((a, b) => a - b);
    for (let i = 0; i + rules.minVessels - 1 < times.length; i++)
      if (times[i + rules.minVessels - 1] - times[i] <= rules.zoneFormMs)
        return { since: times[i], until: Math.max(until, times.at(-1)) };
    return null;
  }

  /** When a zone began here, or null. */
  const zoneSince = (cell, id, at) => zoneSpan(cell, id, at)?.since ?? null;

  /**
   * A ship first seen inside a landing zone while spoofed positions were
   * landing or holding there may be trusted at a false position, so it is
   * no vote source. (After a restart in the middle of a spoof, ships already at the
   * spoof point were first seen before any landing: a known gap.) In
   * the July 2025 Baltic replay every vote from near Kaliningrad came from
   * such a place, and its "return" to where it really was would have put a
   * region at the spoof target. A ship that was there before, or sailed in,
   * still votes.
   */
  function firstSeenInZone(track, id, at) {
    const span = zoneSpan(grid.localCell(track.firstPoint), id, at);
    return (
      span !== null &&
      track.firstSeenAt >= span.since - rules.windowMs &&
      track.firstSeenAt <= span.until + rules.windowMs
    );
  }

  function vote(id, track, point, jump) {
    // Feed faults are not navigation faults: corrupted position fields, a
    // stale repeat of an earlier position, two ships on one MMSI.
    if (jump.encoding || jump.stale) return false;
    if (
      track.conflictAt !== null &&
      point.observedAt - track.conflictAt <= rules.historyMs
    ) {
      votes.delete(id);
      return false;
    }
    if (track.taintedUntil !== null && point.observedAt < track.taintedUntil)
      return false;
    if (firstSeenInZone(track, id, point.observedAt)) {
      counters.zoneExcluded++;
      votes.delete(id);
      return false;
    }
    const sourceCell = grid.source(track.trusted.tail);
    const targetCell = grid.target(point);
    if (!sourceCell || !targetCell) return false;
    const existing = votes.get(id);
    if (existing && existing.episode === track.episode) {
      // A later report of the same episode keeps the vote fresh and follows
      // a moving false position, while it is implausible from the trusted fix
      // or within a recent spoof place's clear radius: a ship held by
      // mistake, sailing or anchored nearby, keeps no region alive.
      if (jump.state === 'plausible' && clearOfSpoof(track, point))
        return false;
      existing.at = point.observedAt;
      existing.targetCell = targetCell;
      // Ambiguous only while the latest report is: a ship sailing east under
      // a spoof point due north of it matches its longitude for a minute.
      existing.ambiguous = jump.evidence.includes('ambiguous_axis');
      const here = grid.localCell(point);
      const landed = !existing.ambiguous && here && landings.get(here);
      if (landed) {
        // A spoof still holding here: refresh the zone, and its place in
        // the eviction order.
        activity.set(here, point.observedAt);
        landings.delete(here);
        landings.set(here, landed);
      }
      existing.land ||= jump.onto;
      votes.delete(id);
      votes.set(id, existing);
      return true;
    }
    const eligible =
      jump.state === 'implausible' &&
      point.observedAt - track.sourceSince >= rules.minTrackAgeMs &&
      track.trusted.reports >= 2 &&
      point.observedAt - track.trusted.tail.observedAt <= rules.windowMs &&
      (jump.km >= rules.minVoteJumpKm ||
        (jump.onto && jump.km >= rules.minJumpKm)) &&
      !grid.local(track.trusted.tail, point);
    if (!eligible) return false;
    votes.set(id, {
      id,
      episode: track.episode,
      sourceCell,
      sourceLocal: grid.localCell(track.trusted.tail),
      targetCell,
      land: jump.onto,
      ambiguous: jump.evidence.includes('ambiguous_axis'),
      firstAt: point.observedAt,
      at: point.observedAt,
    });
    return true;
  }

  /** Mark a recovery candidate as interrupted by a quarantined report. */
  function interrupt(track, point) {
    if (track.recovery) {
      track.recovery.interrupted = point;
      track.recovery.run = 0;
    }
  }

  /**
   * Remember a point this episode's false positions reached, with a clear
   * radius: half its jump from the trusted fix, at most `recoveryClearKm`, so
   * a 3 km glitch does not hold an honest ship sailing 2 km away.
   */
  function markSpoof(track, point, km) {
    const radius = Math.min(rules.recoveryClearKm, Math.max(1, km / 2));
    const known = track.spoofPoints.find((p) => distanceKm(p, point) <= 2);
    if (known) {
      known.radius = Math.max(known.radius, radius);
      known.at = point.observedAt;
      return;
    }
    track.spoofPoints.push({
      lat: point.lat,
      lon: point.lon,
      radius,
      at: point.observedAt,
    });
    if (track.spoofPoints.length > 16) track.spoofPoints.shift();
  }

  /**
   * True when the point is clear of every place this episode's spoof went
   * in the last `windowMs` (a held or hopping spoof keeps revisiting them).
   */
  function clearOfSpoof(track, point) {
    return !track.spoofPoints.some(
      (p) =>
        point.observedAt - p.at <= rules.windowMs &&
        distanceKm(p, point) < p.radius,
    );
  }

  /** Close an episode: its spoof points no longer matter. */
  function closeEpisode(track) {
    track.episodeOpen = false;
    track.spoofPoints = [];
    track.spoofOrigin = null;
  }

  /**
   * How far a point is from where the ship would be on its own track: the
   * line from its last trusted fix to where holding its course and speed
   * would have taken it by now (a ship may have slowed or stopped).
   */
  function ownTrackKm(track, point) {
    const tail = track.trusted.tail;
    const hours = Math.min(
      24,
      Math.max(0, (point.observedAt - tail.observedAt) / 3600_000),
    );
    const v = velocityOf(track);
    const kx = 111.32 * Math.cos(toRad(tail.lat));
    const ky = 110.574;
    const ex = v.lon * hours * kx;
    const ey = v.lat * hours * ky;
    const px =
      (((((point.lon - tail.lon + 540) % 360) + 360) % 360) - 180) * kx;
    const py = (point.lat - tail.lat) * ky;
    const len2 = ex * ex + ey * ey;
    const t =
      len2 > 0 ? Math.max(0, Math.min(1, (px * ex + py * ey) / len2)) : 0;
    return Math.hypot(px - t * ex, py - t * ey);
  }

  /**
   * The ship's course and speed: from its last two minutes or more of
   * trusted reports, else from its 15-minute trail, else none.
   */
  function velocityOf(track) {
    // Only a course measured at the trusted fix: a ship that has since
    // reported sparsely may have turned long ago.
    const v = track.velocity;
    if (v && track.trusted.tail.observedAt - v.at <= rules.lookbackMs) return v;
    const trail = track.trail;
    if (trail.length >= 2) {
      const [a, b] = trail.slice(-2);
      const hours = (b.observedAt - a.observedAt) / 3600_000;
      if (hours > 0)
        return {
          lat: (b.lat - a.lat) / hours,
          lon: (((((b.lon - a.lon + 540) % 360) + 360) % 360) - 180) / hours,
        };
    }
    return { lat: 0, lon: 0 };
  }

  /**
   * How far a point lies off the ship's course line ahead (not bounded by
   * how far it could have sailed): a spoof that landed on its course is one
   * the real ship may sail through.
   */
  function offCourseKm(track, point) {
    const tail = track.trusted.tail;
    const v = velocityOf(track);
    const kx = 111.32 * Math.cos(toRad(tail.lat));
    const ky = 110.574;
    const ex = v.lon * kx;
    const ey = v.lat * ky;
    const px =
      (((((point.lon - tail.lon + 540) % 360) + 360) % 360) - 180) * kx;
    const py = (point.lat - tail.lat) * ky;
    const len2 = ex * ex + ey * ey;
    const t = len2 > 0 ? Math.max(0, (px * ex + py * ey) / len2) : 0;
    return Math.hypot(px - t * ex, py - t * ey);
  }

  /** The nearest place this episode's spoof ever went, km. */
  function spoofKm(track, point) {
    let best = track.spoofOrigin
      ? distanceKm(track.spoofOrigin, point)
      : Infinity;
    for (const p of track.spoofPoints)
      best = Math.min(best, distanceKm(p, point));
    return best;
  }

  function observe(fix) {
    const at = isFiniteNumber(fix?.receivedAt) ? fix.receivedAt : now();
    prune(at);
    const reason = reject(fix, at);
    if (reason) {
      counters.ignored++;
      return { accepted: false, reason };
    }
    lastReportAt = Math.max(lastReportAt ?? 0, at);
    const id = String(fix.mmsi);
    let track = tracks.get(id);
    if (track && fix.observedAt <= track.latestAt) {
      counters.outOfOrder++;
      return { accepted: false, reason: 'duplicate_or_out_of_order' };
    }
    counters.accepted++;
    const point = { lat: fix.lat, lon: fix.lon, observedAt: fix.observedAt };
    let carry = {};
    if (
      track &&
      point.observedAt - track.trusted.tail.observedAt > rules.historyMs
    ) {
      // Its last credible position is older than the history: start afresh.
      // Restarted in the middle of an episode, the new track may sit on a
      // false position, so it cannot vote for a day.
      counters.historyResets++;
      carry = {
        taintedUntil: track.episodeOpen
          ? point.observedAt + rules.historyMs
          : track.taintedUntil,
        conflictAt: track.conflictAt,
      };
      track = null;
    }
    if (!track) {
      tracks.delete(id);
      tracks.set(id, newTrack(point, fix, carry));
      return result('unknown', 'first_seen');
    }
    const afterGap = point.observedAt - track.latestAt > rules.gapMs;
    if (afterGap) {
      counters.gaps++;
      evidence.after_gap++;
      if (track.episodeOpen) track.episodeSilent = true;
    }
    track.latestAt = point.observedAt;
    track.classB = fix.transponderClass === 'B';
    tracks.delete(id);
    tracks.set(id, track);

    const limits = limitsFor(id, track);
    const verdict = judge(track, point, limits);
    for (const e of verdict.evidence) if (e in evidence) evidence[e]++;
    const extra = { evidence: verdict.evidence, afterGap };

    // Provisional: a track's first reports are not yet a history. One that
    // does not fit them restarts the track instead of condemning the ship.
    if (
      !track.episodeOpen &&
      track.trusted.reports < rules.provisionalReports &&
      verdict.state !== 'plausible'
    ) {
      counters.restarts++;
      tracks.set(
        id,
        newTrack(point, fix, {
          taintedUntil: track.taintedUntil,
          conflictAt: track.conflictAt,
        }),
      );
      return result('unknown', 'first_seen', extra);
    }

    // The quarantined segment this point continues best, if any: within the
    // physical limit of its last points, and either soon after its last
    // point or, after a gap, still at it.
    let best = null;
    for (const segment of track.quarantine) {
      const { speed, km } = relate(segment, point);
      const recent = point.observedAt - segment.tail.observedAt <= rules.gapMs;
      if (
        speed <= limits.physical &&
        (recent || km <= rules.staleContinueKm) &&
        (!best || speed < best.speed)
      )
        best = { segment, speed };
    }

    if (track.episodeOpen) {
      // An open episode. Where the ship would be on its own track, against
      // where the spoof went, decides; the old trusted fix can reach further
      // every hour, so being reachable from it is not enough.
      const clear = clearOfSpoof(track, point);
      const plausible = verdict.state === 'plausible';
      const own = plausible ? ownTrackKm(track, point) : Infinity;
      const spoofed = spoofKm(track, point);
      const recover = () => recoveryStep(id, track, point, limits, extra);
      const keep = () =>
        continueQuarantine(id, track, point, best, verdict, limits, extra);
      // A quarantined segment of the spoof that explains the point keeps it
      // (a spoof held through a reception gap): if the point is implausible,
      // or the segment is more than one glitch report and the point is not
      // nearer the ship's own track.
      if (
        best?.segment.kind === 'implausible' &&
        (!plausible ||
          (best.segment.reports >= 2 &&
            !(
              clear &&
              own < spoofed &&
              // Only a spoof that landed on the ship's own course can be
              // sailed through by the real ship; one that landed off it and
              // drags back onto the line is still the spoof.
              track.originOffCourseKm <= 2 * rules.minJumpKm
            )))
      ) {
        interrupt(track, point);
        return keep();
      }
      // Back on its own track: a recovery candidate, even if a one-report
      // glitch segment could also explain it (a ship sailing on through the
      // place a spoof or glitch put it).
      if (plausible && clear && own < spoofed) return recover();
      // Anything below interrupts a recovery run.
      interrupt(track, point);
      // Near where the spoof went, or plausible but nearer the spoof than
      // its own track: held, with no segment moved onto the point.
      if (!clear || plausible)
        return holdAsSpoof(id, track, point, verdict, extra);
      // Suspicious, during an episode, and far from where the ship would be
      // on its own track: another place the spoof went. (A fast boat after a
      // glitch stays near its own line, so its real track is not marked.)
      if (
        verdict.evidence.includes('speed') &&
        ownTrackKm(track, point) > 2 * rules.minJumpKm
      )
        markSpoof(track, point, verdict.km);
      if (best) return keep();
      return openSegment(id, track, point, verdict, extra);
    }

    if (verdict.state === 'plausible') {
      // Outside an episode only suspicious segments exist; one that explains
      // the point better than the trusted history keeps it (a fast boat).
      if (best && best.speed < verdict.speed)
        return continueQuarantine(
          id,
          track,
          point,
          best,
          verdict,
          limits,
          extra,
        );
      track.quarantine = [];
      trust(track, point);
      return result('plausible', 'plausible', extra);
    }
    if (best)
      return continueQuarantine(id, track, point, best, verdict, limits, extra);
    return openSegment(id, track, point, verdict, extra);
  }

  /** A point near where this episode's spoof went: still the spoof. */
  function holdAsSpoof(id, track, point, verdict, extra) {
    track.lastImplausibleAt = point.observedAt;
    // Refresh the place it is near; never add one, or an honest ship held
    // here would mark its own track as spoof and never get free.
    for (const p of track.spoofPoints)
      if (distanceKm(p, point) < p.radius) p.at = point.observedAt;
    // A held report the old fix explains renews a vote only within a spoof
    // place's clear radius (see vote()).
    const candidate = vote(id, track, point, verdict);
    return result('implausible', 'quarantined', { ...extra, candidate });
  }

  function openSegment(id, track, point, verdict, extra) {
    const kind = verdict.state === 'implausible' ? 'implausible' : 'suspect';
    const segment = newSegment(kind, point, {
      entrySpeed: verdict.speed,
      openedBy: verdict.evidence.includes('speed')
        ? 'speed'
        : verdict.onto
          ? 'land'
          : 'route',
      calmSince: null,
      calmReports: 0,
    });
    track.quarantine.push(segment);
    if (track.quarantine.length > rules.maxQuarantineSegments)
      track.quarantine.shift();
    if (kind === 'implausible') {
      if (!track.episodeOpen) {
        track.episode++;
        track.spoofOrigin = { lat: point.lat, lon: point.lon };
        track.originOffCourseKm = offCourseKm(track, point);
        track.episodeSilent = false;
      }
      track.episodeOpen = true;
      track.lastImplausibleAt = point.observedAt;
      markSpoof(track, point, verdict.km);
      const fresh = !votes.has(id);
      const candidate = vote(id, track, point, verdict);
      // An ambiguous vote marks no landing zone: a feed fault must not exclude
      // ships later first seen where it pointed.
      if (candidate && fresh && !verdict.evidence.includes('ambiguous_axis'))
        land(id, point);
      return result('implausible', 'implausible_jump', { ...extra, candidate });
    }
    return result('unknown', 'suspect_move', extra);
  }

  /**
   * During an episode, a point the trusted history explains and well away
   * from every false position: a recovery candidate. Three consecutive
   * consistent ones over a minute end the episode. If quarantined reports
   * keep interrupting a candidate that then carries on, two ships are
   * sharing the MMSI: its votes are dropped for a day.
   */
  function recoveryStep(id, track, point, limits, extra) {
    const candidate = track.recovery;
    if (candidate && relate(candidate, point).speed <= limits.screening) {
      if (candidate.interrupted) {
        // Two ships on one MMSI, unless the interrupting positions lie where
        // other vessels' false positions landed too: then it is a spoof
        // flickering on and off at the edge of its reach.
        const where = candidate.interrupted;
        candidate.interrupted = null;
        if (zoneSince(grid.localCell(where), id, point.observedAt) === null) {
          if (track.conflictAt === null) counters.identityConflicts++;
          track.conflictAt = point.observedAt;
          votes.delete(id);
        }
      }
      extendSegment(candidate, point);
      if (!candidate.run) candidate.runStart = point.observedAt;
      candidate.run = (candidate.run ?? 0) + 1;
    } else {
      track.recovery = newSegment('recovery', point, {
        run: 1,
        runStart: point.observedAt,
      });
    }
    const current = track.recovery;
    if (
      current.run >= rules.recoveryReports &&
      point.observedAt - current.runStart >= rules.recoveryMinSpanMs
    ) {
      // The ship reported through the spoof without falling silent, and
      // comes back on its own course: its history stays continuous.
      adopt(track, current, {
        keepClock:
          !track.episodeSilent &&
          offCourseKm(track, current.first) <= 2 * rules.minJumpKm,
      });
      closeEpisode(track);
      counters.recoveries++;
      return result('plausible', 'recovered', extra);
    }
    return result('unknown', 'recovery_pending', extra);
  }

  function continueQuarantine(id, track, point, best, verdict, limits, extra) {
    const { segment } = best;
    extendSegment(segment, point);
    if (segment.kind === 'implausible') {
      track.lastImplausibleAt = point.observedAt;
      // Still the spoof: remember where it goes while it is implausible. A
      // report the old fix explains only refreshes a place it is near: it
      // may be the ship's real track, which must not become a spoof place.
      if (verdict.state !== 'plausible') markSpoof(track, point, verdict.km);
      else
        for (const p of track.spoofPoints)
          if (distanceKm(p, point) < p.radius) p.at = point.observedAt;
      const candidate = vote(id, track, point, verdict);
      return result('implausible', 'quarantined', { ...extra, candidate });
    }
    // A suspicious segment. Calm: moving no faster than the screening speed.
    if (best.speed > limits.screening) {
      segment.calmSince = null;
      segment.calmReports = 0;
    } else {
      segment.calmSince ??= point.observedAt;
      segment.calmReports++;
    }
    const span = segment.tail.observedAt - segment.startedAt;
    const pace =
      span > 0
        ? distanceKm(segment.first, segment.tail) / (span / 3600_000) / KNOT_KMH
        : 0;
    // A ship that may be fast, opened on speed, showing that pace itself. It
    // ends an open episode too (a fast boat after a glitch), but only well
    // away from every false position.
    if (
      limits.cls.fastAllowed &&
      segment.openedBy === 'speed' &&
      segment.reports >= rules.promotionReports &&
      span >= rules.promotionMinSpanMs &&
      pace >= 0.7 * Math.min(segment.entrySpeed, limits.physical) &&
      pace <= limits.physical &&
      (!track.episodeOpen || ownTrackKm(track, point) < spoofKm(track, point))
    ) {
      track.demonstratedKnots = Math.max(track.demonstratedKnots, pace);
      track.demonstratedAt = point.observedAt;
      adopt(track, segment);
      track.sourceSince = point.observedAt;
      closeEpisode(track);
      counters.promotions++;
      return result('plausible', 'fast_vessel_confirmed', extra);
    }
    // Any suspicious segment, outside an episode, once it has moved calmly
    // for two minutes: a burst of speed, a berth up a river, a coastline
    // the route search got wrong. Its votes wait 30 minutes from here.
    if (
      !track.episodeOpen &&
      segment.calmReports >= rules.promotionReports &&
      point.observedAt - segment.calmSince >= rules.promotionMinSpanMs
    ) {
      adopt(track, segment);
      track.sourceSince = point.observedAt;
      counters.resolved++;
      return result('plausible', 'suspect_resolved', extra);
    }
    return result('unknown', 'suspect_held', extra);
  }

  function snapshot({ at = now(), feedStatus = 'unknown' } = {}) {
    prune(at, { force: true });
    // Live votes: one per vessel, fresh within the window.
    // Zones change as spoofs go on: a vote from a ship first seen where a
    // zone has since formed no longer counts.
    const live = [...votes.values()].filter((v) => {
      if (v.at > at + rules.maxFutureMs || at - v.at > rules.windowMs)
        return false;
      const track = tracks.get(v.id);
      return !track || !firstSeenInZone(track, v.id, at);
    });
    const bySource = new Map();
    for (const v of live) {
      if (!bySource.has(v.sourceCell)) bySource.set(v.sourceCell, []);
      bySource.get(v.sourceCell).push(v);
    }
    // Seed cells with the most supporting vessels in their neighbourhood
    // first, so a cluster split by a cell edge forms one region.
    const around = (cell) =>
      grid.neighbours(cell).flatMap((n) => bySource.get(n) ?? []);
    const seeds = [...bySource.keys()]
      .map((cell) => ({ cell, n: around(cell).length }))
      .sort((a, b) => b.n - a.n || a.cell.localeCompare(b.cell));
    const used = new Set();
    const claimed = new Set();
    const regions = [];
    for (const { cell } of seeds) {
      // Each pass forms one region from vessels whose false positions agree;
      // others nearby stay free for a second, distinct incident. A group that
      // fails is set aside for this seed only.
      const setAside = new Set();
      for (;;) {
        const members = around(cell).filter(
          (v) => !used.has(v.id) && !setAside.has(v.id),
        );
        if (members.length < rules.minVessels) break;
        // Agreement: the most false positions within one target cell and its
        // neighbours. Independent jumps to scattered places do not count.
        const byTarget = new Map();
        for (const v of members)
          byTarget.set(v.targetCell, (byTarget.get(v.targetCell) ?? 0) + 1);
        let focus = null;
        let focusCount = 0;
        for (const target of byTarget.keys()) {
          let n = 0;
          for (const near of grid.neighbours(target))
            n += byTarget.get(near) ?? 0;
          if (n > focusCount || (n === focusCount && target < focus)) {
            focus = target;
            focusCount = n;
          }
        }
        if (focusCount < rules.minVessels) break;
        const coherent = members.filter((v) => grid.agree(focus, v.targetCell));
        // Ambiguous one-axis jumps support a region but cannot make one.
        const clear = coherent.filter((v) => !v.ambiguous);
        if (clear.length < rules.minVessels) {
          for (const v of coherent) setAside.add(v.id);
          continue;
        }
        // Ships trusted where other vessels' spoofed positions landed may be
        // trusted at a false position, or may really be there (a port beside
        // the spoofer): AIS cannot tell. Such a region is kept, marked.
        const inZone = coherent.filter((v) => {
          const track = tracks.get(v.id);
          return (
            track &&
            zoneSince(grid.localCell(track.firstPoint), v.id, at) !== null
          );
        }).length;
        for (const v of coherent) used.add(v.id);
        const cells = [...new Set(coherent.map((v) => v.sourceCell))].sort();
        // Longitudes unwrapped against the first cell, so a region across the
        // dateline is not a box around the whole world.
        const boxes = cells.map((c) => grid.bounds(c));
        const ref = boxes[0].west;
        for (const b of boxes) {
          const shift =
            b.west - ref > 180 ? -360 : ref - b.west > 180 ? 360 : 0;
          b.west += shift;
          b.east += shift;
        }
        const area = {
          south: Math.min(...boxes.map((b) => b.south)),
          north: Math.max(...boxes.map((b) => b.north)),
          west: Math.min(...boxes.map((b) => b.west)),
          east: Math.max(...boxes.map((b) => b.east)),
        };
        const firstAt = Math.min(...coherent.map((v) => v.firstAt));
        const lastAt = Math.max(...coherent.map((v) => v.at));
        // The same incident keeps its id while its cells overlap and its false
        // positions still agree, however its membership changes; a new one is
        // named by its seed, its target focus and its start.
        let regionId = null;
        for (const [known, incident] of incidents)
          if (
            incident.active &&
            !claimed.has(known) &&
            cells.some((c) => incident.cells.has(c)) &&
            (!incident.focus || grid.agree(incident.focus, focus))
          ) {
            regionId = known;
            break;
          }
        regionId ??= `regional-navigation:${grid.label}:${cell}:${focus}:${Math.floor(firstAt / 60_000)}`;
        claimed.add(regionId);
        const incident = incidents.get(regionId) ?? {
          firstSeenAt: firstAt,
          peakVessels: 0,
        };
        incident.firstSeenAt = Math.min(incident.firstSeenAt, firstAt);
        incident.lastSeenAt = lastAt;
        incident.peakVessels = Math.max(incident.peakVessels, coherent.length);
        incident.area = area;
        incident.cells = new Set(cells);
        incident.focus = focus;
        incidents.set(regionId, incident);
        regions.push({
          id: regionId,
          domain: 'sea',
          observation: 'correlated_ais_kinematic_anomalies',
          interpretation: 'possible_navigation_integrity_issue',
          causeAssessment: 'unconfirmed',
          confidence: 'low', // AISStream is one feed, not independent corroboration.
          eventPriority: 'advisory', // Never independently trigger a critical camera interrupt.
          // Ships trusted where spoofed positions landed: an ambiguous source
          // location, labelled so on the endpoint.
          sourceLocation:
            inZone * 2 >= coherent.length ? 'ambiguous' : 'credible',
          evidence: {
            uniqueVessels: coherent.length,
            coherentTargetVessels: coherent.length,
            ambiguousAxisVessels: coherent.length - clear.length,
            otherNearbyVessels: members.length - coherent.length,
            landTargetVessels: coherent.filter((v) => v.land).length,
            observationWindowMinutes: rules.windowMs / 60_000,
            independentProviders: 1,
            aggregation: grid.label,
            cells: cells.length,
            sourceInLandingZone: inZone * 2 >= coherent.length,
          },
          area,
          firstSeenAt: incident.firstSeenAt,
          lastSeenAt: lastAt,
        });
      }
    }
    regions.sort(
      (a, b) => b.lastSeenAt - a.lastSeenAt || a.id.localeCompare(b.id),
    );
    // Ended incidents: kept as history for a day, never as an alert.
    const recentIncidents = [];
    for (const [regionId, incident] of incidents) {
      incident.active = claimed.has(regionId);
      if (incident.active) continue;
      recentIncidents.push({
        id: regionId,
        state: 'ended',
        firstSeenAt: incident.firstSeenAt,
        lastSeenAt: incident.lastSeenAt,
        peakVessels: incident.peakVessels,
        area: incident.area,
      });
    }
    recentIncidents.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    const degraded = !['healthy', 'ok'].includes(feedStatus);
    const stale = lastReportAt == null || at - lastReportAt > rules.maxFixAgeMs;
    return {
      schemaVersion: 2,
      status:
        feedStatus === 'unconfigured'
          ? 'unconfigured'
          : degraded || stale
            ? 'coverage_uncertain'
            : regions.length
              ? 'candidate_regions'
              : at - startedAt < rules.warmupMs
                ? 'warming_up'
                : 'observing',
      coverage: {
        feedStatus,
        stale,
        source: 'existing_aisstream_connection',
        scope: 'received-vessels-only',
        globalCoverageClaimed: false,
        geography: geography?.source ?? 'none',
      },
      regions: degraded || stale ? [] : regions,
      recentIncidents: recentIncidents.slice(0, 50),
      diagnostic: {
        ...counters,
        evidence: { ...evidence },
        tracked: tracks.size,
        quarantined: [...tracks.values()].filter((t) => t.quarantine.length)
          .length,
        staticTypes: statics.size,
        candidateReports: votes.size,
        landingCells: landings.size,
        aggregation: grid.label,
        lastReportAt,
      },
      disclaimer:
        'AIS-only regional anomaly screen. Neither spoofing nor transmitter location is established.',
    };
  }

  return { observe, observeStatic, snapshot, prune, rules };
}
