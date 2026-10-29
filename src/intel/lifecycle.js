// Lifecycle: four distinct clocks kept apart (spec §6) —
//  1. report age (observation times, owned by evidence),
//  2. camera eligibility (focus window after the last meaningful update),
//  3. visible-marker lifetime (TTL, fading over its final quarter),
//  4. historical retention (archive; owned by the store).
// The last meaningful update and any authoritative validity/closure drive
// the state; feed poll times and reposts never do. Pure and portable.

import { CATEGORY_POLICY, FADE_FRACTION } from './taxonomy.js';

/** Unbounded categories (economic stress) still leave the map after this without news. */
export const OPEN_ENDED_TTL_MS = 30 * 24 * 3600_000;
/** How long a resolved event stays visible, dimmed, before archiving. */
export const RESOLVED_DISPLAY_MS = 3600_000;

/**
 * Marker TTL for an event: category policy, overridden by per-category
 * operator settings, and capped by an authoritative `valid_until`.
 */
export function markerTtlMs(event, overrides = {}) {
  const policy = {
    ...CATEGORY_POLICY[event.category],
    ...overrides[event.category],
  };
  let ttl = policy.markerTtlMs ?? OPEN_ENDED_TTL_MS;
  if (Number.isFinite(event.valid_until))
    ttl = Math.max(0, event.valid_until - event.last_meaningful_update_at);
  return ttl;
}

/**
 * Lifecycle state at `now`.
 * @returns {{lifecycle: string, opacity: number, focus_eligible: boolean,
 *   focus_until: number, fade_starts_at: number, expires_at: number}}
 */
export function lifecycleAt(event, now, overrides = {}) {
  const policy = {
    ...CATEGORY_POLICY[event.category],
    ...overrides[event.category],
  };
  const since = event.last_meaningful_update_at;
  const ttl = markerTtlMs(event, overrides);
  const expiresAt = since + ttl;
  const fadeStartsAt = since + ttl * (1 - FADE_FRACTION);
  const focusUntil = Math.min(since + policy.focusWindowMs, expiresAt);
  const base = {
    focus_until: focusUntil,
    fade_starts_at: fadeStartsAt,
    expires_at: expiresAt,
  };

  if (event.verification === 'retracted')
    return {
      ...base,
      lifecycle: 'retracted',
      opacity: 0,
      focus_eligible: false,
    };
  if (event.verification === 'resolved') {
    const shown = now < since + RESOLVED_DISPLAY_MS;
    return {
      ...base,
      expires_at: since + RESOLVED_DISPLAY_MS,
      lifecycle: shown ? 'resolved' : 'archived',
      opacity: shown ? 0.35 : 0,
      focus_eligible: false,
    };
  }
  if (now >= expiresAt)
    return {
      ...base,
      lifecycle: 'archived',
      opacity: 0,
      focus_eligible: false,
    };
  const focusEligible = now <= focusUntil && event.verification !== 'disputed';
  if (now >= fadeStartsAt) {
    const remaining = (expiresAt - now) / Math.max(1, expiresAt - fadeStartsAt);
    return {
      ...base,
      lifecycle: 'fading',
      opacity: Math.round(Math.max(0, Math.min(1, remaining)) * 100) / 100,
      focus_eligible: focusEligible,
    };
  }
  return {
    ...base,
    lifecycle: focusEligible ? 'active' : 'cooling',
    opacity: 1,
    focus_eligible: focusEligible,
  };
}
