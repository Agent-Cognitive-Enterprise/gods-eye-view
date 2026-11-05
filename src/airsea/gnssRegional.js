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
 */

export const REGIONAL_GNSS_RULES = Object.freeze({
  windowMs: 30 * 60_000,
  maxFixAgeMs: 5 * 60_000,
  maxFutureMs: 2 * 60_000,
  maxTrackGapMs: 20 * 60_000,
  minFixGapMs: 5_000,
  maxSpeedKnots: 100,
  minJumpKm: 10,
  minVessels: 3,
  // A degree-scale area is deliberately an alert region, not a location
  // estimate for a transmitter or an affected ship.
  cellDeg: 1,
  // Fork: a vote needs its target this many cells away (Chebyshev, in cells),
  // so local glitches inside one or two neighbouring cells never count.
  minTargetCells: 2,
  // Fork: the screen says `warming_up` until it has watched this long.
  warmupMs: 10 * 60_000,
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
  const cols = Math.round(360 / cellDeg);
  const dc = Math.abs(ca - cb) % cols;
  return Math.max(Math.abs(ra - rb), Math.min(dc, cols - dc));
}

/**
 * Fork: a ship station's MMSI: nine digits with a maritime identification
 * digit (MID) of 201-775. Placeholders that many unconfigured transponders
 * share (one repeated digit, 123456789) are refused: one MMSI on several
 * ships is the classic source of fake jumps.
 */
export function validMmsi(id) {
  const text = String(id ?? '');
  if (!/^[0-9]{9}$/.test(text)) return false;
  const mid = Number(text.slice(0, 3));
  if (mid < 201 || mid > 775) return false;
  if (/^(\d){8}$/.test(text) || text === '123456789') return false;
  return true;
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
    // Fork: tracks carry `anchorCell` (the trusted cell when an anomaly began,
    // the only cell this vessel may vote for), `lastOutlierAt`, `suspect`
    // (an outlier since the last trusted fix) and `tainted` (the trusted fix
    // moved away during an anomaly, so this vessel never votes again).
    const makeTrack = (stableCount, from = {}) => ({
      baseline: point,
      latestAt: point.observedAt,
      stableCount,
      anchorCell: from.anchorCell ?? null,
      lastOutlierAt: from.lastOutlierAt ?? null,
      suspect: false,
      tainted: from.tainted ?? false,
    });
    if (!prev) {
      tracks.set(id, makeTrack(1));
      return { accepted: true, reason: 'warming' };
    }
    // Fork: a gap is silence since the LAST report, outliers included. Timed
    // from the trusted fix, a spoof lasting the gap length used to pass as a
    // feed gap and make the false position the trusted one.
    if (fix.observedAt - prev.latestAt > rules.maxTrackGapMs) {
      counters.gaps++;
      tracks.delete(id);
      tracks.set(id, makeTrack(1));
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
    if (km >= rules.minJumpKm && apparentKnots > rules.maxSpeedKnots) {
      counters.impossible++;
      const sourceCell = regionalCell(
        prev.baseline.lat,
        prev.baseline.lon,
        rules.cellDeg,
      );
      const targetCell = regionalCell(point.lat, point.lon, rules.cellDeg);
      // A new anomaly anchors to the trusted cell; one that ended a window
      // ago no longer binds the vessel.
      if (
        prev.anchorCell === null ||
        point.observedAt - prev.lastOutlierAt > rules.windowMs
      )
        prev.anchorCell = sourceCell;
      prev.lastOutlierAt = point.observedAt;
      prev.suspect = true;
      const votes =
        prev.stableCount >= 2 &&
        !prev.tainted &&
        sourceCell !== null &&
        targetCell !== null &&
        sourceCell === prev.anchorCell &&
        cellDistance(sourceCell, targetCell, rules.cellDeg) >=
          rules.minTargetCells;
      if (votes) {
        // Retain only a bounded candidate with no coordinates.
        const key = `${id}:${sourceCell}:${targetCell}`;
        candidates.delete(key);
        candidates.set(key, {
          id,
          sourceCell,
          targetCell,
          at: point.observedAt,
        });
      }
      return { accepted: true, reason: 'kinematic_outlier', candidate: votes };
    }
    // A physically consistent fix is the only fix allowed to update baseline.
    // Do not use the broadcast speed as an independent source: it too may be
    // wrong. A trusted fix that moves far while the vessel is suspect is the
    // anomaly being adopted (a long spoof eventually looks plausible against
    // an old fix): the vessel is tainted and never votes again.
    const adopted = prev.suspect && km >= rules.minJumpKm;
    tracks.delete(id);
    tracks.set(
      id,
      makeTrack(Math.min(3, prev.stableCount + 1), {
        anchorCell: prev.anchorCell,
        lastOutlierAt: prev.lastOutlierAt,
        tainted: prev.tainted || adopted,
      }),
    );
    return {
      accepted: true,
      reason: adopted ? 'adopted_tainted' : 'plausible',
    };
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
        tainted: [...tracks.values()].filter((t) => t.tainted).length,
        candidateReports: candidates.size,
        lastReportAt,
      },
      disclaimer:
        'AIS-only regional anomaly screen. Neither spoofing nor transmitter location is established.',
    };
  }

  return { observe, snapshot, prune };
}
