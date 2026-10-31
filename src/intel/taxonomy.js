// Early-warning event vocabulary and initial policy defaults. Pure and portable:
// ids only (the UI owns display text), no DOM, no Cesium, no Node.
//
// Every threshold here is a product choice, not a validated measurement of
// danger. Operators can override them; tests pin the defaults so a change is
// deliberate.

export const CATEGORIES = Object.freeze([
  'natural_disaster',
  'armed_conflict',
  'civil_unrest',
  'economic_stress',
  'infrastructure_disruption',
  'public_health',
  'breaking_news',
]);

/** Reliability of what is known about an event, weakest to strongest claim. */
export const VERIFICATION_STATES = Object.freeze([
  'unverified',
  'corroborated',
  'officially_reported',
  'disputed',
  'retracted',
  'resolved',
]);

/** Provenance of one observation. Analyst/aggregator reports are not primary. */
export const SOURCE_TYPES = Object.freeze([
  'primary_official',
  'eyewitness',
  'secondary_reporting',
  'aggregator',
  'analyst',
  // A public post from a social platform: a claim, whoever it says it is from.
  'social_claim',
  'synthetic_fixture',
]);

export const FEED_STATUSES = Object.freeze([
  'healthy',
  'degraded',
  'stale',
  'offline',
  'disabled',
  'requires_credentials',
  'blocked_by_terms',
]);

/** Where a marker stands in its life. `archived` events stay queryable. */
export const LIFECYCLE_STATES = Object.freeze([
  'active',
  'cooling',
  'fading',
  'archived',
  'retracted',
  'resolved',
]);

export const ESCALATION_STATES = Object.freeze([
  'increasing',
  'stable',
  'decreasing',
  'unknown',
]);

/** How precisely a location is known; drives framing and matching radius. */
export const LOCATION_PRECISIONS = Object.freeze([
  'exact',
  'point',
  'city',
  'region',
  'country',
  'unresolved',
]);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * Category lifecycle and correlation defaults.
 *  - focusWindowMs: camera eligibility after the last meaningful update.
 *  - markerTtlMs: visible-marker lifetime without a further meaningful update
 *    (`null` = until a newer observation or a documented recovery).
 *  - matchWindowMs / matchRadiusKm: how far apart two observations may be and
 *    still describe the same event.
 */
export const CATEGORY_POLICY = Object.freeze({
  breaking_news: Object.freeze({
    focusWindowMs: 20 * MINUTE,
    markerTtlMs: 2 * HOUR,
    matchWindowMs: 6 * HOUR,
    matchRadiusKm: 75,
  }),
  civil_unrest: Object.freeze({
    focusWindowMs: HOUR,
    markerTtlMs: 24 * HOUR,
    matchWindowMs: 24 * HOUR,
    matchRadiusKm: 25,
  }),
  armed_conflict: Object.freeze({
    focusWindowMs: 2 * HOUR,
    markerTtlMs: 72 * HOUR,
    matchWindowMs: 12 * HOUR,
    matchRadiusKm: 30,
  }),
  natural_disaster: Object.freeze({
    focusWindowMs: HOUR,
    markerTtlMs: 72 * HOUR,
    matchWindowMs: 48 * HOUR,
    matchRadiusKm: 100,
  }),
  economic_stress: Object.freeze({
    focusWindowMs: 24 * HOUR,
    markerTtlMs: null,
    matchWindowMs: 30 * 24 * HOUR,
    matchRadiusKm: 500,
  }),
  infrastructure_disruption: Object.freeze({
    focusWindowMs: HOUR,
    markerTtlMs: 24 * HOUR,
    matchWindowMs: 24 * HOUR,
    matchRadiusKm: 50,
  }),
  public_health: Object.freeze({
    focusWindowMs: 6 * HOUR,
    markerTtlMs: 7 * 24 * HOUR,
    matchWindowMs: 7 * 24 * HOUR,
    matchRadiusKm: 200,
  }),
});

/**
 * Social posts alone may be seen, never believed: however many accounts agree,
 * confidence stays below what a critical interruption needs, and an unconfirmed
 * claim leaves the map after a few hours instead of its category's lifetime.
 */
export const SOCIAL_ONLY_CONFIDENCE_CAP = 0.6;
export const SOCIAL_MARKER_TTL_MS = 6 * HOUR;

/** Every source of the event is a social post. */
export const isSocialOnly = (event) =>
  (event.lineages?.length ?? 0) > 0 &&
  event.lineages.every((l) => l.source_type === 'social_claim');

/** Marker fade covers the final quarter of the remaining display lifetime. */
export const FADE_FRACTION = 0.25;

/** Initial operator-configurable Autopilot defaults (spec §5.1). */
export const AUTOPILOT_DEFAULTS = Object.freeze({
  autopilotEnabled: false,
  minimumAttentionScore: 70,
  // Below this confidence an event is a marked candidate, never a camera target.
  minimumCameraConfidence: 0.35,
  groupingRadiusKm: 800,
  minimumDwellMs: 30_000,
  repeatFocusCooldownMs: 30 * MINUTE,
  criticalInterruptThreshold: 95,
  normalPreemptionMargin: 15,
  preemptionConfirmMs: 10_000,
  maxMarkersInView: 200,
  narrationEnabled: false,
  // Ambient tour of other active events while nothing qualifies as an alert.
  tourWhenIdle: true,
  tourDwellMs: 45_000,
  tourMinimumScore: 40,
  // Analyst incidents (S2) as tour stops despite low confidence and score.
  tourAnalystIncidents: true,
  // After a shot settles: hold, then zoom out in steps until the whole globe
  // is in view; the next flight turns the globe first, then zooms in.
  pullBackEnabled: true,
  pullBackHoldMs: 10_000,
  pullBackStepMs: 5_000,
  // Personal relevance: attention rises toward 100 near these places
  // ({label: home|family|travel|custom, lat, lon}), fading exponentially to
  // nothing at the radius. Confidence is never changed by proximity.
  proximityEnabled: true,
  homeLocations: [],
  proximityRadiusKm: 1000,
  proximityDecayKm: 400,
  // Local model assessments (Phase 3); off means rule-based scoring only.
  localAiEnabled: true,
});

/** Attention-score weights (spec §5.2). Each term is normalized 0–100. */
export const SCORE_WEIGHTS = Object.freeze({
  severity: 0.3,
  corroboration: 0.2,
  freshness: 0.15,
  escalation: 0.15,
  impact: 0.1,
  relevance: 0.1,
});

export const isCategory = (value) => CATEGORIES.includes(value);
export const isSourceType = (value) => SOURCE_TYPES.includes(value);
export const isVerification = (value) => VERIFICATION_STATES.includes(value);
export const isPrecision = (value) => LOCATION_PRECISIONS.includes(value);
