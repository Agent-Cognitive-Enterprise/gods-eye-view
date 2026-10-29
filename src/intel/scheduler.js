// Autopilot attention scheduler. A pure, deterministic step function: the same
// state, input, settings and clock always produce the same decision. It never
// touches the camera; it says which cluster deserves the next shot and why, and
// the UI controller hands that shot to the application's camera owners.
//
// Rules (spec §5.3–5.4):
//  - a shot holds for the minimum dwell; only a qualified critical cluster may
//    cut it short, and at most one interruption per dwell;
//  - after the dwell, a challenger must beat the current shot by the
//    preemption margin and stay ahead for a confirmation interval, otherwise
//    the scheduler rotates to the best cluster not yet shown;
//  - focus cooldown is reserved per event only when it was actually presented,
//    and a materially newer revision lifts it;
//  - clusters that have waited get bounded fairness credit, so a distant
//    high-priority cluster eventually gets airtime without stale content
//    dominating;
//  - with nothing eligible, the tour (when on) slowly visits other active
//    events in turn, each once before any repeats; tour shots never count as
//    presented alerts and give way at once to anything that qualifies;
//  - with the tour off, the camera returns once to a still global view.

import { clusterEvents } from './clustering.js';
import { AUTOPILOT_DEFAULTS } from './taxonomy.js';

const FAIRNESS_POINTS_PER_MIN = 0.5;
const MAX_FAIRNESS_POINTS = 10;
const MIN_FLIGHT_GAP_MS = 5_000;

/** A fresh scheduler state. */
export function createSchedulerState() {
  return {
    mode: 'off', // off | auto | paused
    pauseReason: null,
    current: null, // {key, eventIds, revisions, score, critical, startedAt, interrupted}
    presented: {}, // eventId -> {at, revision}
    waitingSince: {}, // cluster key -> first time it was eligible and unshown
    toured: {}, // eventId -> last tour visit (separate from alert cooldown)
    challenger: null, // {key, since}
    lastFlightAt: null,
    idle: false,
  };
}

/** The stable identity of a cluster: its highest-ranked event. */
export function clusterKey(cluster) {
  return cluster.event_ids[0];
}

function inCooldown(cluster, eventsById, state, now, cooldownMs) {
  return cluster.event_ids.every((id) => {
    const seen = state.presented[id];
    if (!seen) return false;
    const revision = eventsById.get(id)?.revision ?? 0;
    return revision <= seen.revision && now - seen.at < cooldownMs;
  });
}

const TOUR_LIFECYCLES = new Set(['active', 'cooling', 'fading']);
const TOUR_EXCLUDED = new Set(['retracted', 'resolved', 'disputed']);

/** Clusters worth an ambient tour visit: located, credible, not filtered out. */
export function tourClusters(events, s) {
  const usable = events.filter(
    (e) =>
      TOUR_LIFECYCLES.has(e.lifecycle) &&
      !TOUR_EXCLUDED.has(e.verification) &&
      (e.confidence ?? 0) >= s.minimumCameraConfidence &&
      (e.attention_score ?? 0) >= s.tourMinimumScore &&
      s.categoryRelevance?.[e.category] !== 0 &&
      ((e.location?.lat !== null && e.location?.lat !== undefined) ||
        e.location?.bounds),
  );
  return clusterEvents(usable, { diameterKm: s.groupingRadiusKm });
}

function isCritical(cluster, eventsById, threshold) {
  return cluster.event_ids.some((id) => {
    const event = eventsById.get(id);
    return event?.critical_qualified && event.attention_score >= threshold;
  });
}

/**
 * One scheduler step.
 * @param {object} state From createSchedulerState or a previous step.
 * @param {{now: number, clusters: object[], events: object[], settings?: object}} input
 * @returns {{state: object, decision: {type: 'none'|'hold'|'fly'|'idle',
 *   cluster?: object, reason: string}}}
 */
export function stepScheduler(state, { now, clusters, events, settings = {} }) {
  const s = { ...AUTOPILOT_DEFAULTS, ...settings };
  const next = structuredClone(state);
  if (next.mode !== 'auto')
    return { state: next, decision: { type: 'none', reason: next.mode } };

  const eventsById = new Map(events.map((event) => [event.event_id, event]));
  const eligible = clusters.filter(
    (cluster) =>
      cluster.top_score >= s.minimumAttentionScore &&
      (cluster.framing !== 'region' || cluster.bounds) &&
      cluster.event_ids.every(
        (id) => eventsById.get(id)?.camera_eligible !== false,
      ),
  );

  // Fairness bookkeeping: how long has each unshown cluster been waiting?
  const keys = new Set(eligible.map(clusterKey));
  for (const key of Object.keys(next.waitingSince))
    if (!keys.has(key)) delete next.waitingSince[key];
  for (const cluster of eligible) {
    const key = clusterKey(cluster);
    if (next.current?.key === key) delete next.waitingSince[key];
    else next.waitingSince[key] ??= now;
  }
  const rank = (cluster) => {
    const waited =
      (now - (next.waitingSince[clusterKey(cluster)] ?? now)) / 60_000;
    return (
      cluster.top_score +
      Math.min(MAX_FAIRNESS_POINTS, waited * FAIRNESS_POINTS_PER_MIN)
    );
  };
  const fresh = eligible
    .filter(
      (c) => !inCooldown(c, eventsById, next, now, s.repeatFocusCooldownMs),
    )
    .sort(
      (a, b) => rank(b) - rank(a) || (clusterKey(a) < clusterKey(b) ? -1 : 1),
    );

  const fly = (cluster, reason, interrupted = false) => {
    const key = clusterKey(cluster);
    next.current = {
      key,
      eventIds: [...cluster.event_ids],
      score: cluster.top_score,
      critical: isCritical(cluster, eventsById, s.criticalInterruptThreshold),
      startedAt: now,
      interrupted,
    };
    for (const id of cluster.event_ids)
      next.presented[id] = {
        at: now,
        revision: eventsById.get(id)?.revision ?? 0,
      };
    delete next.waitingSince[key];
    next.challenger = null;
    next.lastFlightAt = now;
    next.idle = false;
    return { state: next, decision: { type: 'fly', cluster, reason } };
  };
  const hold = (reason) => ({
    state: next,
    decision: { type: 'hold', reason },
  });

  // Tour bookkeeping and the next stop: least recently toured first, then the
  // most important, never the cluster already on screen.
  next.toured ??= {};
  for (const id of Object.keys(next.toured))
    if (!eventsById.has(id)) delete next.toured[id];
  const nextTourStop = () => {
    if (!s.tourWhenIdle) return null;
    const lastVisit = (c) =>
      Math.max(...c.event_ids.map((id) => next.toured[id] ?? -Infinity));
    return (
      tourClusters(events, s)
        .filter((c) => !holds(c) && (c.framing !== 'region' || c.bounds))
        .sort(
          (a, b) =>
            lastVisit(a) - lastVisit(b) ||
            b.top_score - a.top_score ||
            (clusterKey(a) < clusterKey(b) ? -1 : 1),
        )[0] ?? null
    );
  };
  const tour = (cluster) => {
    next.current = {
      key: clusterKey(cluster),
      eventIds: [...cluster.event_ids],
      score: cluster.top_score,
      critical: false,
      startedAt: now,
      interrupted: false,
      tour: true,
    };
    for (const id of cluster.event_ids) next.toured[id] = now;
    next.challenger = null;
    next.lastFlightAt = now;
    next.idle = false;
    return { state: next, decision: { type: 'fly', cluster, reason: 'tour' } };
  };
  const idle = (reason) => {
    next.current = null;
    if (next.idle)
      return { state: next, decision: { type: 'none', reason: 'idle' } };
    next.idle = true;
    return { state: next, decision: { type: 'idle', reason } };
  };

  // Keep the current shot's score in step with its live data.
  // Ranks can shift inside the cluster on screen; it is still the same shot
  // while it contains the event the shot was anchored on.
  const holds = (cluster) =>
    Boolean(next.current) && cluster.event_ids.includes(next.current.key);
  const live = next.current && !next.current.tour && eligible.find(holds);
  if (next.current && live) {
    next.current.score = live.top_score;
    // Whatever changes while a cluster is on screen has been seen: a revision
    // that lands during its shot must not earn it a second interruption later.
    for (const id of live.event_ids)
      next.presented[id] = {
        at: now,
        revision: eventsById.get(id)?.revision ?? 0,
      };
  }

  const elapsed = next.current ? now - next.current.startedAt : 0;
  const sinceFlight = now - (next.lastFlightAt ?? -Infinity);

  if (!next.current) {
    if (fresh.length) return fly(fresh[0], 'highest_priority');
    const stop = nextTourStop();
    if (stop) return tour(stop);
    return idle('nothing_eligible');
  }

  // A tour shot gives way at once to anything that qualifies as an alert.
  if (next.current.tour) {
    if (fresh.length && sinceFlight >= MIN_FLIGHT_GAP_MS)
      return fly(fresh[0], 'highest_priority');
    if (!s.tourWhenIdle) return idle('nothing_eligible');
    if (elapsed < s.tourDwellMs) return hold('tour_dwell');
    const stop = nextTourStop();
    return stop ? tour(stop) : hold('tour_dwell');
  }
  const others = fresh.filter((c) => !holds(c));

  // A qualified critical cluster may cut a dwell short, once per dwell.
  if (elapsed < s.minimumDwellMs) {
    const critical = others.find((c) =>
      isCritical(c, eventsById, s.criticalInterruptThreshold),
    );
    if (
      critical &&
      !next.current.critical &&
      !next.current.interrupted &&
      sinceFlight >= MIN_FLIGHT_GAP_MS
    )
      return fly(critical, 'critical_interrupt', true);
    return hold('minimum_dwell');
  }

  const best = others[0];
  if (!best) {
    // Nothing else qualifies: continue as a tour after the dwell.
    const stop = nextTourStop();
    if (stop) return tour(stop);
    if (!live) return idle('current_no_longer_eligible');
    return hold('nothing_else_eligible');
  }
  // The current shot is still eligible and strong: a challenger must clearly
  // outrank it for a confirmation interval (hysteresis) before preempting.
  if (live && best.top_score >= next.current.score + s.normalPreemptionMargin) {
    if (next.challenger?.key !== clusterKey(best))
      next.challenger = { key: clusterKey(best), since: now };
    if (now - next.challenger.since >= s.preemptionConfirmMs)
      return fly(best, 'clearly_higher_priority');
    return hold('confirming_challenger');
  }
  next.challenger = null;
  // Otherwise the dwell is over: rotate to the best cluster not yet shown.
  return fly(best, live ? 'rotation' : 'current_no_longer_eligible');
}

/** Operator and ownership transitions. */
export function setSchedulerMode(state, mode, reason = null) {
  const next = structuredClone(state);
  next.mode = mode;
  next.pauseReason = mode === 'paused' ? reason : null;
  if (mode !== 'auto') {
    next.current = null;
    next.challenger = null;
  }
  if (mode === 'auto') next.idle = false;
  return next;
}
