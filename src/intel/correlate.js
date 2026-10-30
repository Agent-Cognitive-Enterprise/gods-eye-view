// Correlation: which canonical event an observation belongs to, whether it is
// an independent source or a copy of one already held, and whether it changes
// anything that matters. Pure functions over plain objects; the engine owns
// state. Every decision returns machine-readable reasons so the UI can answer
// "why grouped?" and an operator can flag a mistaken merge.

import { greatCircleKm } from '../geoDistance.js';
import { observationTime, textTokens } from './evidence.js';
import { CATEGORY_POLICY } from './taxonomy.js';

/** Subtypes that describe a consequence of another event, linked rather than merged. */
export const CONSEQUENCE_SUBTYPES = Object.freeze([
  'tsunami_warning',
  'evacuation_order',
  'curfew',
  'state_of_emergency',
  'power_outage',
  'aftershock_warning',
]);

/** Near-identical wording from another publisher is a copy, not corroboration. */
export const COPY_SIMILARITY = 0.8;
/** Minimum wording overlap for two nearby reports to describe one event. */
export const MATCH_SIMILARITY = 0.2;

const PRECISION_RADIUS_KM = Object.freeze({
  exact: 5,
  point: 10,
  city: 40,
  region: 250,
  country: 1000,
  unresolved: Infinity,
});

/** Jaccard overlap of two token lists, 0–1. */
export function similarity(a, b) {
  if (!a.length || !b.length) return 0;
  const left = new Set(a);
  let shared = 0;
  for (const token of new Set(b)) if (left.has(token)) shared += 1;
  return shared / (left.size + new Set(b).size - shared);
}

const tokensOf = (item) => textTokens(`${item.title} ${item.summary ?? ''}`);
const titleTokensOf = (item) => textTokens(item.title);

/**
 * Is `observation` already held? Same id, same URL with the same content, or
 * the same publisher with the same content digest (a republish).
 * @param {object} observation
 * @param {{byId: Map, byUrlDigest: Set, byPublisherDigest: Set}} index
 */
export function duplicateOf(observation, index) {
  if (index.byId.has(observation.observation_id))
    return { duplicate: true, reason: 'same_observation_id' };
  if (
    observation.url &&
    index.byUrlDigest.has(`${observation.url}|${observation.content_digest}`)
  )
    return { duplicate: true, reason: 'same_url_and_content' };
  if (
    index.byPublisherDigest.has(
      `${observation.publisher}|${observation.content_digest}`,
    )
  )
    return { duplicate: true, reason: 'same_publisher_and_content' };
  return { duplicate: false };
}

/** Distance between an observation and an event location, or null when either lacks a point. */
function distanceKm(observation, event) {
  const a = observation.location;
  const b = event.location;
  if (a.lat === null || b.lat === null) return null;
  return greatCircleKm(a, b);
}

function radiusFor(observation, event) {
  const policy = CATEGORY_POLICY[event.category];
  const precisionSlack = Math.max(
    PRECISION_RADIUS_KM[observation.location.precision] ?? 0,
    PRECISION_RADIUS_KM[event.location.precision] ?? 0,
  );
  return Math.max(policy.matchRadiusKm, Math.min(precisionSlack, 1000));
}

function withinTime(observation, event) {
  const policy = CATEGORY_POLICY[event.category];
  const at = observationTime(observation);
  const start =
    (event.occurred_at ?? event.first_seen_at) - policy.matchWindowMs;
  const end = event.last_meaningful_update_at + policy.matchWindowMs;
  return at >= start && at <= end;
}

/**
 * Score how well an observation matches one candidate event; null when it cannot.
 * @returns {null | {score: number, method: string, distance_km: ?number,
 *   similarity: number, shared_entities: string[]}}
 */
export function matchCandidate(observation, event) {
  if (
    observation.event_key &&
    event.event_keys.includes(
      `${observation.provider}|${observation.event_key}`,
    )
  )
    return {
      score: 10,
      method: 'event_key',
      distance_km: distanceKm(observation, event),
      similarity: 1,
      shared_entities: [],
    };
  // Two feed-native ids from the same provider are two events, whatever the wording.
  if (
    observation.event_key &&
    event.event_keys.some((key) => key.startsWith(`${observation.provider}|`))
  )
    return null;
  // One article can describe several incidents, so a shared lineage still has
  // to agree in space and time before it means "same event".
  const lineageMethod = event.lineage_keys.includes(observation.lineage_key)
    ? 'same_lineage'
    : observation.derived_from &&
        (event.lineage_keys.includes(observation.derived_from) ||
          event.urls.includes(observation.derived_from))
      ? 'derived_from'
      : null;
  if (lineageMethod) {
    const distance = distanceKm(observation, event);
    if (
      withinTime(observation, event) &&
      (distance === null || distance <= radiusFor(observation, event))
    )
      return {
        score: 9,
        method: lineageMethod,
        distance_km: distance === null ? null : Math.round(distance * 10) / 10,
        similarity: 1,
        shared_entities: [],
      };
  }
  const sameFamily =
    observation.category === event.category ||
    observation.category === 'breaking_news' ||
    event.category === 'breaking_news';
  if (!sameFamily || !withinTime(observation, event)) return null;

  const sim = similarity(tokensOf(observation), event.tokens);
  const shared = observation.entities.filter((e) => event.entities.includes(e));
  const distance = distanceKm(observation, event);
  if (distance !== null) {
    if (distance > radiusFor(observation, event)) return null;
    // A consequence (evacuation, tsunami warning) rarely repeats its cause's
    // wording; nearby in space and time is enough to link it to a primary event.
    if (
      CONSEQUENCE_SUBTYPES.includes(observation.subtype) &&
      !CONSEQUENCE_SUBTYPES.includes(event.subtype) &&
      observation.subtype !== event.subtype
    )
      return {
        score: 1.5 + sim * 4 - distance / 1000,
        method: 'proximity_consequence',
        distance_km: Math.round(distance * 10) / 10,
        similarity: Math.round(sim * 100) / 100,
        shared_entities: shared,
      };
    if (sim < MATCH_SIMILARITY && shared.length === 0) return null;
    return {
      score: 2 + sim * 4 + Math.min(shared.length, 3) - distance / 1000,
      method: 'proximity_and_text',
      distance_km: Math.round(distance * 10) / 10,
      similarity: Math.round(sim * 100) / 100,
      shared_entities: shared,
    };
  }
  // No point on one side: only a same-region report with strong overlap may join.
  const region =
    observation.location.region_code &&
    observation.location.region_code === event.location.region_code;
  if (!region || (sim < 0.45 && shared.length < 2)) return null;
  return {
    score: 1 + sim * 4 + Math.min(shared.length, 3),
    method: 'region_and_text',
    distance_km: null,
    similarity: Math.round(sim * 100) / 100,
    shared_entities: shared,
  };
}

/** The best-matching candidate, deterministic on ties (lowest event id). */
export function bestMatch(observation, candidates) {
  let best = null;
  for (const event of candidates) {
    const match = matchCandidate(observation, event);
    if (!match) continue;
    if (
      !best ||
      match.score > best.match.score ||
      (match.score === best.match.score && event.event_id < best.event.event_id)
    )
      best = { event, match };
  }
  return best;
}

/** Whether the observation starts a linked consequence event instead of merging. */
export function isConsequence(observation, event) {
  return (
    CONSEQUENCE_SUBTYPES.includes(observation.subtype) &&
    observation.subtype !== event.subtype
  );
}

/**
 * The lineage an observation belongs to. A report that names its origin, or
 * whose wording nearly duplicates an earlier report from another publisher,
 * joins that report's lineage: syndicated copies are one source, not many.
 */
export function lineageFor(observation, priorObservations) {
  // Priors may carry the lineage they were resolved into (`resolved_lineage`,
  // from their stored link): a copy's later revision joins the original's
  // lineage, not the copy's own key.
  const resolved = (prior) => prior.resolved_lineage ?? prior.lineage_key;
  if (observation.derived_from) {
    const origin = priorObservations.find(
      (prior) =>
        prior.url === observation.derived_from ||
        prior.lineage_key === observation.derived_from ||
        resolved(prior) === observation.derived_from,
    );
    return {
      lineage_key: origin ? resolved(origin) : observation.derived_from,
      copy_of: origin?.observation_id ?? null,
      reason: 'declared_origin',
    };
  }
  const titleTokens = titleTokensOf(observation);
  const bodyTokens = tokensOf(observation);
  for (const prior of priorObservations) {
    if (prior.lineage_key === observation.lineage_key)
      return {
        lineage_key: resolved(prior),
        copy_of: prior.observation_id,
        reason: 'same_lineage',
      };
    if (prior.publisher === observation.publisher) continue;
    const titleSim = similarity(titleTokens, titleTokensOf(prior));
    const bodySim = similarity(bodyTokens, tokensOf(prior));
    if (titleSim >= COPY_SIMILARITY && bodySim >= COPY_SIMILARITY)
      return {
        lineage_key: resolved(prior),
        copy_of: prior.observation_id,
        reason: 'near_identical_text',
      };
  }
  return {
    lineage_key: observation.lineage_key,
    copy_of: null,
    reason: 'independent',
  };
}

const IMPACT_METRICS = [
  'deaths',
  'injured',
  'affected',
  'displaced',
  'arrests',
];

/**
 * What, if anything, this observation materially changes about the event.
 * Rewording and repetition are not material; new independent sources, larger
 * measured impact, status changes and better geolocation are.
 * @returns {string[]} Reasons; empty when not material.
 */
export function materialChanges(observation, event, lineage) {
  const reasons = [];
  const independent = !event.lineages.some(
    (known) => known.lineage_key === lineage.lineage_key,
  );
  // An aggregator echo is not a new source (see scoring.independentLineages).
  if (independent && observation.source_type !== 'aggregator')
    reasons.push('new_independent_source');
  if (observation.official && !event.official)
    reasons.push('first_official_report');
  const m = observation.metrics;
  const e = event.metrics;
  if (
    Number.isFinite(m.magnitude) &&
    Number.isFinite(e.magnitude) &&
    Math.abs(m.magnitude - e.magnitude) >= 0.2
  )
    reasons.push('magnitude_revised');
  if (m.alert_level && m.alert_level !== e.alert_level)
    reasons.push('alert_level_changed');
  if (m.gdacs_alert && m.gdacs_alert !== e.gdacs_alert)
    reasons.push('gdacs_alert_changed');
  if (m.tsunami === true && e.tsunami !== true) reasons.push('tsunami_flag');
  for (const key of IMPACT_METRICS)
    if (Number.isFinite(m[key]) && m[key] > (e[key] ?? 0))
      reasons.push(`${key}_increased`);
  if (
    Number.isFinite(m.severity_hint) &&
    m.severity_hint >= (e.severity_hint ?? 0) + 10
  )
    reasons.push('reported_severity_increased');
  if (observation.status_hint && observation.status_hint !== event.status_hint)
    reasons.push(`status_${observation.status_hint}`);
  const rank = ['unresolved', 'country', 'region', 'city', 'point', 'exact'];
  if (
    rank.indexOf(observation.location.precision) >
    rank.indexOf(event.location.precision)
  )
    reasons.push('geolocation_improved');
  return reasons;
}
