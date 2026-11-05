/**
 * AIS navigation-integrity screening, independent of networking and UI.
 *
 * Detects only coarse REGIONAL, multi-vessel patterns of implausible AIS
 * movement. It does not verify GNSS spoofing, infer transmitters, attribute
 * actors, or expose individual vessels' trajectories. A missing feed is not
 * evidence that shipping stopped. Requires genuine source timestamps.
 *
 * Integration: call `observe()` from the existing AISStream ingest path,
 * passing one new position report per vessel. Never open another AIS socket.
 *
 * Fork rework (four adversarial reviews, 5 November 2026): a vessel's
 * trusted fix moves only by a plausible step from the last one, and a step at
 * an impossible speed is never adopted, however short. A HARD outlier (over
 * 100 knots, or jumping away from a point the vessel sat at) puts it under
 * suspicion for `windowMs`: fixes within `outlierAreaKm` of where the hard
 * outlier went are held and renew it; fixes elsewhere faster than a ship's
 * pace are held but renew nothing. So a spoof held at one point, moved to a
 * second, or dragged at impossible speed is not adopted, the alert region
 * stays where the ships were, and honest ships (fast craft included) are
 * trusted again. Known gaps, by design of a kinematic screen: a track that
 * starts while already spoofed, a reception gap mid-spoof, a drag at ship
 * speeds, or a drift longer than the suspicion window can still anchor a
 * vessel on a false fix. Tracks younger than `minTrackAgeMs` never vote.
 */

export const REGIONAL_GNSS_RULES = Object.freeze({
  windowMs: 30 * 60_000,
  maxFixAgeMs: 5 * 60_000,
  maxFutureMs: 2 * 60_000,
  maxTrackGapMs: 20 * 60_000,
  minFixGapMs: 5_000,
  maxSpeedKnots: 100,
  minJumpKm: 10,
  // Fork: a vote needs a jump at least this long, into another cell, so
  // local glitches never count however the cell grid falls.
  minVoteJumpKm: 50,
  // Fork: a track must be watched this long before it votes, so a vessel
  // first seen mid-spoof (after a restart, say) cannot vote from a false fix.
  minTrackAgeMs: 30 * 60_000,
  // Fork: fixes this close to the point an impossible jump went to stay
  // outliers while the anomaly is recent, so a long spoof is never adopted.
  outlierAreaKm: 20,
  // Fork: while under suspicion, a trusted move may not exceed this, or 1.5
  // times the vessel's own earlier speed if that is higher.
  suspectSpeedKnots: 30,
  minVessels: 3,
  // A degree-scale area is deliberately an alert region, not a location
  // estimate for a transmitter or an affected ship. Must divide 360.
  cellDeg: 1,
  // Fork: the screen says `warming_up` until it has watched this long.
  warmupMs: 30 * 60_000,
  maxTrackedVessels: 50_000,
  maxCandidates: 20_000,
});

const R = 6371.0088;
const toRad = (degrees) => (degrees * Math.PI) / 180;
const isFiniteNumber = (x) => typeof x === 'number' && Number.isFinite(x);

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

function coarseGeometry(cell, cellDeg) {
  const [r, c] = cell.split(':').map(Number);
  const south = -90 + r * cellDeg;
  const west = -180 + c * cellDeg;
  return {
    // Region, not a point / not an emitter estimate.
    south,
    west,
    north: south + cellDeg,
    east: west + cellDeg,
  };
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
 * Input contract:
 * { mmsi, lat, lon, observedAt, receivedAt?, timeQuality:'source',
 *   provider?:'aisstream', speedKn?: number|null }
 * observedAt / receivedAt are epoch milliseconds, never seconds.
 * `timeQuality` must be 'source': fallback-ingest timestamps aren't evidence.
 */
export function createRegionalGnssDetector({
  now = () => Date.now(),
  rules = REGIONAL_GNSS_RULES,
} = {}) {
  if (!(rules.cellDeg > 0) || 360 % rules.cellDeg !== 0)
    throw new RangeError('cellDeg must divide 360');
  const tracks = new Map();
  const candidates = new Map();
  const counters = {
    accepted: 0,
    ignored: 0,
    outOfOrder: 0,
    gaps: 0,
    impossible: 0,
    evicted: 0,
  };
  let lastReportAt = null;
  let lastPruneAt = -Infinity;
  const startedAt = now();

  function prune(at, { force = false } = {}) {
    // AIS can deliver thousands of positions per second. O(n) scanning per
    // message would be disastrous; sweep at most once every 30 seconds.
    // Clock rollback cannot force an O(n) sweep on every incoming message.
    if (force || at - lastPruneAt >= 30_000) {
      const candidateCutoff = at - rules.windowMs;
      for (const [id, item] of candidates)
        if (item.at < candidateCutoff) candidates.delete(id);
      for (const [id, item] of tracks)
        if (item.latestAt < at - rules.maxTrackGapMs) tracks.delete(id);
      lastPruneAt = at;
    }
    while (tracks.size > rules.maxTrackedVessels) {
      tracks.delete(tracks.keys().next().value);
      counters.evicted++;
    }
    while (candidates.size > rules.maxCandidates) {
      candidates.delete(candidates.keys().next().value);
      counters.evicted++;
    }
  }

  function reject(fix, at) {
    if (!fix || !validMmsi(fix.mmsi)) return 'invalid_id';
    if (
      !isFiniteNumber(fix.lat) ||
      !isFiniteNumber(fix.lon) ||
      Math.abs(fix.lat) >= 85 ||
      Math.abs(fix.lon) > 180 ||
      (fix.lat === 0 && fix.lon === 0)
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
    const prev = tracks.get(id);
    if (prev && fix.observedAt <= prev.latestAt) {
      counters.outOfOrder++;
      return { accepted: false, reason: 'duplicate_or_out_of_order' };
    }
    counters.accepted++;
    const point = { lat: fix.lat, lon: fix.lon, observedAt: fix.observedAt };
    // A track: the trusted fix (`baseline`), its plausible-fix count, when it
    // was first seen, its latest report, and where its recent outliers went.
    const newTrack = () => ({
      baseline: point,
      stableCount: 1,
      firstSeenAt: point.observedAt,
      latestAt: point.observedAt,
      speedKnots: 0,
      outlierPoint: null,
      lastOutlierAt: null,
      lastPoint: point,
      lastWasOutlier: false,
      parkedReports: 0,
    });
    if (!prev) {
      tracks.set(id, newTrack());
      return { accepted: true, reason: 'warming' };
    }
    // A gap is silence since the LAST report, outliers included; timed from
    // the trusted fix, a long spoof would pass as a feed gap.
    if (fix.observedAt - prev.latestAt > rules.maxTrackGapMs) {
      counters.gaps++;
      tracks.delete(id);
      tracks.set(id, newTrack());
      return { accepted: true, reason: 'gap_reset' };
    }
    // Every report keeps the vessel fresh for eviction, and records its time,
    // which also blocks same-timestamp replays.
    prev.latestAt = point.observedAt;
    tracks.delete(id);
    tracks.set(id, prev);
    const dt = fix.observedAt - prev.baseline.observedAt;
    if (dt < rules.minFixGapMs) return { accepted: true, reason: 'too_soon' };
    const km = distanceKm(prev.baseline, point);
    const apparentKnots = km / (dt / 3600_000) / 1.852;
    const cell = regionalCell(point.lat, point.lon, rules.cellDeg);
    const recentOutlier =
      prev.lastOutlierAt !== null &&
      point.observedAt - prev.lastOutlierAt <= rules.windowMs;
    // Still at the point its last impossible jump went to: an old trusted fix
    // makes a long spoof look reachable, but it is the same anomaly. The point
    // is fixed by impossible jumps only, so a vessel sailing on leaves it.
    const inOutlierArea =
      recentOutlier &&
      km >= rules.minJumpKm &&
      distanceKm(point, prev.outlierPoint) <= rules.outlierAreaKm;
    // Under suspicion, a new trusted fix must be reachable at a ship's pace
    // (its own earlier speed, with room), not just at 100 knots: otherwise a
    // spoof that moves to a second point is adopted from the stale fix.
    const speedLimit = recentOutlier
      ? Math.max(rules.suspectSpeedKnots, 1.5 * prev.speedKnots)
      : rules.maxSpeedKnots;
    const overSuspicionSpeed =
      km >= rules.minJumpKm && apparentKnots > speedLimit;
    // A HARD outlier is impossible for any ship: over 100 knots from the
    // trusted fix, or a jump away from a point the vessel sat at for two or
    // more outlying reports (a spoof moving on). Only hard outliers and holds
    // at their point renew suspicion and vote. Over the suspicion speed alone
    // a ship might still be (a ferry speeding up after a glitch): held, not
    // adopted, but it neither renews suspicion nor votes, so it cannot freeze.
    const last = prev.lastPoint;
    const stepKm = last ? distanceKm(last, point) : 0;
    const stepHours = last
      ? (point.observedAt - last.observedAt) / 3600_000
      : 0;
    const leavesParkedPoint =
      prev.parkedReports >= 2 &&
      stepKm >= rules.minJumpKm &&
      stepHours > 0 &&
      stepKm / stepHours / 1.852 > rules.maxSpeedKnots;
    const hard =
      km >= rules.minJumpKm &&
      (apparentKnots > rules.maxSpeedKnots || leavesParkedPoint);
    const outlying = hard || inOutlierArea || overSuspicionSpeed;
    // Consecutive outlying reports close together: the vessel sits at a point.
    prev.parkedReports =
      outlying && prev.lastWasOutlier && last && stepKm <= rules.outlierAreaKm
        ? prev.parkedReports + 1
        : outlying
          ? 1
          : 0;
    prev.lastWasOutlier = outlying;
    prev.lastPoint = point;
    if (overSuspicionSpeed && !hard && !inOutlierArea)
      return { accepted: true, reason: 'suspect_hold', candidate: false };
    if (hard || inOutlierArea) {
      counters.impossible++;
      if (hard) prev.outlierPoint = point;
      prev.lastOutlierAt = point.observedAt;
      const sourceCell = regionalCell(
        prev.baseline.lat,
        prev.baseline.lon,
        rules.cellDeg,
      );
      const votes =
        prev.stableCount >= 2 &&
        point.observedAt - prev.firstSeenAt >= rules.minTrackAgeMs &&
        sourceCell !== null &&
        cell !== null &&
        cell !== sourceCell &&
        km >= rules.minVoteJumpKm;
      if (votes) {
        // Retain only a bounded candidate with no coordinates.
        const key = `${id}:${sourceCell}:${cell}`;
        candidates.delete(key);
        candidates.set(key, {
          id,
          sourceCell,
          targetCell: cell,
          at: point.observedAt,
        });
      }
      return { accepted: true, reason: 'kinematic_outlier', candidate: votes };
    }
    // A physically consistent fix away from the outlier area is the only fix
    // allowed to update the baseline: the ship's real track, also after a
    // spoof ends. Do not use the broadcast speed as an independent source: it
    // too may be wrong.
    // Steps under 10 km are checked too: one at an impossible speed (a drag of
    // a few km per report, or a glitch) is held, never adopted.
    if (km >= 1 && apparentKnots > rules.maxSpeedKnots)
      return { accepted: true, reason: 'too_fast_hold', candidate: false };
    // Its pace between trusted fixes, for the suspicion speed limit above;
    // steps under 1 km are mostly position noise.
    if (!recentOutlier && km >= 1)
      prev.speedKnots = Math.min(apparentKnots, rules.maxSpeedKnots);
    prev.baseline = point;
    prev.stableCount = Math.min(3, prev.stableCount + 1);
    return { accepted: true, reason: 'plausible' };
  }

  function snapshot({ at = now(), feedStatus = 'unknown' } = {}) {
    prune(at, { force: true });
    const grouped = new Map();
    // One distinct MMSI per source cell per window, regardless of how many
    // identical messages or target cells it visited.
    for (const candidate of candidates.values()) {
      if (
        candidate.at > at + rules.maxFutureMs ||
        at - candidate.at > rules.windowMs
      )
        continue;
      if (!grouped.has(candidate.sourceCell))
        grouped.set(candidate.sourceCell, new Map());
      const byId = grouped.get(candidate.sourceCell);
      const old = byId.get(candidate.id);
      if (!old || candidate.at > old.at) byId.set(candidate.id, candidate);
    }
    const regions = [];
    for (const [cell, byId] of grouped) {
      if (byId.size < rules.minVessels) continue;
      const byTarget = new Map();
      for (const item of byId.values())
        byTarget.set(item.targetCell, (byTarget.get(item.targetCell) ?? 0) + 1);
      const targetMax = Math.max(...byTarget.values());
      // Only coherent target patterns; independent isolated jumps do not count.
      if (targetMax < rules.minVessels) continue;
      const ordered = [...byId.values()].sort((a, b) => a.at - b.at);
      regions.push({
        id: `regional-navigation:${cell}`,
        domain: 'sea',
        observation: 'correlated_ais_kinematic_anomalies',
        interpretation: 'possible_navigation_integrity_issue',
        causeAssessment: 'unconfirmed',
        confidence: 'low', // AISStream is one feed, not independent corroboration.
        eventPriority: 'advisory', // Never independently trigger a critical camera interrupt.
        evidence: {
          uniqueVessels: byId.size,
          coherentTargetVessels: targetMax,
          observationWindowMinutes: rules.windowMs / 60_000,
          independentProviders: 1,
        },
        area: coarseGeometry(cell, rules.cellDeg),
        firstSeenAt: ordered[0].at,
        lastSeenAt: ordered.at(-1).at,
      });
    }
    regions.sort(
      (a, b) => b.lastSeenAt - a.lastSeenAt || a.id.localeCompare(b.id),
    );
    const degraded = !['healthy', 'ok'].includes(feedStatus);
    const stale = lastReportAt == null || at - lastReportAt > rules.maxFixAgeMs;
    return {
      schemaVersion: 1,
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
      },
      regions: degraded || stale ? [] : regions,
      diagnostic: {
        ...counters,
        tracked: tracks.size,
        candidateReports: candidates.size,
        lastReportAt,
      },
      disclaimer:
        'AIS-only regional anomaly screen. Neither spoofing nor transmitter location is established.',
    };
  }

  return { observe, snapshot, prune, rules };
}
