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
//  - with nothing eligible the camera returns once to a still global view.

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

  // Keep the current shot's score in step with its live data.
  // Ranks can shift inside the cluster on screen; it is still the same shot
  // while it contains the event the shot was anchored on.
  const holds = (cluster) =>
    Boolean(next.current) && cluster.event_ids.includes(next.current.key);
  const live = next.current && eligible.find(holds);
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

  if (!next.current) {
    if (fresh.length) return fly(fresh[0], 'highest_priority');
    if (next.idle)
      return { state: next, decision: { type: 'none', reason: 'idle' } };
    next.idle = true;
    return {
      state: next,
      decision: { type: 'idle', reason: 'nothing_eligible' },
    };
  }

  const elapsed = now - next.current.startedAt;
  const sinceFlight = now - (next.lastFlightAt ?? -Infinity);
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
    if (!live) {
      next.current = null;
      next.idle = true;
      return {
        state: next,
        decision: { type: 'idle', reason: 'current_no_longer_eligible' },
      };
    }
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
