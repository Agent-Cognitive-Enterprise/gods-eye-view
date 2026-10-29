// Deterministic assessment: severity, confidence, verification, escalation and
// the attention score that decides what the camera may show. "Important" is
// not "true": severity and confidence are reported separately from attention,
// and a weakly sourced claim can never reach a critical interruption. An
// optional bounded model assessment (local LLM) feeds in as one input; the
// final number is always computed here. Pure and portable.

import {
  AUTOPILOT_DEFAULTS,
  CATEGORY_POLICY,
  SCORE_WEIGHTS,
} from './taxonomy.js';

const clamp = (value, lo = 0, hi = 100) =>
  Math.min(hi, Math.max(lo, Number.isFinite(value) ? value : lo));
const round = (value) => Math.round(value);

/** Logarithmic 0–100 scale for counts of people (1 → ~10, 10k → ~80, 1M → 100). */
export function peopleScale(count) {
  if (!Number.isFinite(count) || count <= 0) return 0;
  return clamp(10 + 17.5 * Math.log10(count));
}

const ALERT_SEVERITY = Object.freeze({
  green: 35,
  yellow: 60,
  orange: 80,
  red: 95,
});

/** Rule-based severity from measured facts only, 0–100. */
export function ruleSeverity(event) {
  const m = event.metrics;
  const parts = [];
  if (Number.isFinite(m.magnitude)) parts.push(clamp((m.magnitude - 3.5) * 20)); // M4.5→20, M6→50, M7.5→80
  if (m.alert_level && ALERT_SEVERITY[m.alert_level])
    parts.push(ALERT_SEVERITY[m.alert_level]);
  if (Number.isFinite(m.deaths)) parts.push(peopleScale(m.deaths * 20));
  if (Number.isFinite(m.injured)) parts.push(peopleScale(m.injured * 4));
  if (Number.isFinite(m.affected)) parts.push(peopleScale(m.affected) * 0.9);
  if (Number.isFinite(m.displaced)) parts.push(peopleScale(m.displaced));
  if (Number.isFinite(m.severity_hint)) parts.push(clamp(m.severity_hint));
  let severity = parts.length ? Math.max(...parts) : 35;
  if (m.tsunami === true) severity = Math.max(severity, 70);
  if (event.status_hint === 'evacuation') severity = Math.max(severity, 65);
  return round(severity);
}

/** Independent lineages; copies of one report count once. */
export function independentLineages(event) {
  return event.lineages.length;
}

/** Verification state from the event's sources and status reports. */
export function verificationOf(event) {
  if (event.status_hint === 'retracted') return 'retracted';
  if (event.status_hint === 'resolved') return 'resolved';
  if (event.status_hint === 'disputed') return 'disputed';
  if (event.official) return 'officially_reported';
  const publishers = new Set(event.lineages.map((l) => l.publisher));
  if (independentLineages(event) >= 2 && publishers.size >= 2)
    return 'corroborated';
  return 'unverified';
}

const SOURCE_CONFIDENCE = Object.freeze({
  primary_official: 0.85,
  eyewitness: 0.45,
  secondary_reporting: 0.4,
  analyst: 0.35,
  aggregator: 0.3,
  synthetic_fixture: 0.5,
});

/** Confidence 0–1 that the event happened as described (not how bad it is). */
export function confidenceOf(event, verification = verificationOf(event)) {
  if (verification === 'retracted') return 0.05;
  const best = Math.max(
    0,
    ...event.lineages.map((l) => SOURCE_CONFIDENCE[l.source_type] ?? 0.3),
  );
  let confidence = best;
  const extra = Math.max(0, independentLineages(event) - 1);
  if (extra)
    confidence = Math.max(confidence, Math.min(0.9, 0.6 + 0.08 * extra));
  if (verification === 'officially_reported')
    confidence = Math.max(confidence, 0.85);
  if (verification === 'disputed') confidence *= 0.5;
  if (event.location.geolocation_status === 'unresolved') confidence -= 0.05;
  if (!event.time_zone_known) confidence -= 0.02;
  return Math.round(clamp(confidence * 100)) / 100;
}

/** Corroboration quality 0–100, discounting copy chains. */
export function corroborationScore(event, verification) {
  if (verification === 'retracted') return 0;
  const n = independentLineages(event);
  let score = n >= 3 ? 80 : n === 2 ? 60 : n === 1 ? 30 : 0;
  if (event.official) score = Math.max(score, n >= 2 ? 100 : 80);
  if (verification === 'disputed') score -= 40;
  return clamp(score);
}

/** Freshness 0–100 from the last meaningful update, never from reposts. */
export function freshnessScore(event, now) {
  const policy = CATEGORY_POLICY[event.category];
  const horizon = policy.markerTtlMs ?? 30 * 24 * 3600_000;
  const age = Math.max(0, now - event.last_meaningful_update_at);
  if (age <= policy.focusWindowMs)
    return round(100 - (age / policy.focusWindowMs) * 30);
  return round(clamp(70 * (1 - (age - policy.focusWindowMs) / horizon)));
}

/** Escalation from the severity history and status, newest last. */
export function escalationOf(event) {
  if (event.status_hint === 'resolved' || event.status_hint === 'retracted')
    return 'decreasing';
  if (event.status_hint === 'evacuation') return 'increasing';
  const history = event.severity_history;
  if (history.length < 2) return 'unknown';
  const delta = history[history.length - 1] - history[history.length - 2];
  return delta >= 5 ? 'increasing' : delta <= -5 ? 'decreasing' : 'stable';
}

const ESCALATION_SCORE = Object.freeze({
  increasing: 100,
  stable: 50,
  unknown: 40,
  decreasing: 20,
});

/** Human/geographic impact 0–100 from measured counts, else from severity. */
export function impactScore(event, severity) {
  const m = event.metrics;
  const measured = [m.deaths * 50, m.injured * 5, m.affected, m.displaced]
    .filter(Number.isFinite)
    .map(peopleScale);
  if (m.alert_level && ALERT_SEVERITY[m.alert_level])
    measured.push(ALERT_SEVERITY[m.alert_level]);
  return round(measured.length ? Math.max(...measured) : severity * 0.6);
}

/**
 * Bound a model assessment before it may influence a score. Out-of-range
 * numbers are clamped; anything else is ignored. The model may move severity
 * by at most `maxShift` points from the rule baseline.
 */
export function boundedModelSeverity(ruleValue, assessment, maxShift = 25) {
  if (!assessment || !Number.isFinite(assessment.severity)) return ruleValue;
  const lo = Math.max(0, ruleValue - maxShift);
  const hi = Math.min(100, ruleValue + maxShift);
  return round(clamp(assessment.severity, lo, hi));
}

/**
 * Score one event at `now`.
 * @param {object} event Canonical event (engine-owned).
 * @param {number} now Epoch ms.
 * @param {{weights?: object, categoryRelevance?: object,
 *   criticalInterruptThreshold?: number}} [settings]
 */
export function scoreEvent(event, now, settings = {}) {
  const weights = { ...SCORE_WEIGHTS, ...settings.weights };
  const critical =
    settings.criticalInterruptThreshold ??
    AUTOPILOT_DEFAULTS.criticalInterruptThreshold;
  const verification = verificationOf(event);
  const confidence = confidenceOf(event, verification);
  const baseline = ruleSeverity(event);
  const severity = boundedModelSeverity(baseline, event.assessment);
  const escalation =
    event.assessment?.escalation &&
    ESCALATION_SCORE[event.assessment.escalation]
      ? event.assessment.escalation
      : escalationOf(event);
  // Claimed severity and impact count in proportion to the evidence for them:
  // an anonymous post claiming thousands dead must not outrank an official
  // report on the strength of its own numbers. The event still reports the
  // claimed severity; only its pull on the camera is discounted.
  const evidenceFactor = 0.5 + 0.5 * Math.min(1, confidence / 0.85);
  const terms = {
    severity: round(severity * evidenceFactor),
    corroboration: corroborationScore(event, verification),
    freshness: freshnessScore(event, now),
    escalation: ESCALATION_SCORE[escalation],
    impact: round(impactScore(event, severity) * evidenceFactor),
    relevance: clamp(settings.categoryRelevance?.[event.category] ?? 100),
  };
  let attention = 0;
  for (const [term, value] of Object.entries(terms))
    attention += (weights[term] ?? 0) * value;
  attention = round(attention);

  const criticalQualified =
    (verification === 'officially_reported' ||
      verification === 'corroborated') &&
    confidence >= 0.7;
  let criticalBlocked = null;
  if (attention >= critical && !criticalQualified) {
    criticalBlocked = 'insufficient_corroboration_for_critical';
    attention = critical - 1;
  }
  if (verification === 'retracted' || verification === 'resolved')
    attention = 0;
  return {
    severity,
    rule_severity: baseline,
    confidence,
    verification,
    escalation,
    attention_score: attention,
    critical_qualified: criticalQualified,
    critical_blocked: criticalBlocked,
    evidence_factor: Math.round(evidenceFactor * 100) / 100,
    terms,
    weights,
  };
}
