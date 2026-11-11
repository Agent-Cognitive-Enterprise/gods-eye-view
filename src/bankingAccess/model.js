// Banking-access disruption model (fork feature): validates reviewed events,
// weights them, and rolls them up per country. Pure: no Cesium, no i18n, no
// I/O, shared by the server route and its tests.

export const EVENT_TYPES = Object.freeze([
  'technical_outage',
  'withdrawal_limits',
  'capital_controls',
  'deposit_freeze',
  'bank_failure',
]);
export const CONFIDENCE_LEVELS = Object.freeze([
  'social',
  'multiple_reports',
  'official',
]);
/** Severity 1-5: minor outage .. collapse, capital controls, deposit lock-up. */
export const SEVERITY_WEIGHT = Object.freeze([0, 0.3, 0.5, 0.7, 0.9, 1]);
export const CONFIDENCE_WEIGHT = Object.freeze({
  social: 0.4,
  multiple_reports: 0.7,
  official: 1,
});
/** A resolved event fades to nothing over this long, then is history. */
export const DECAY_MS = 5 * 24 * 3600_000;
/** An ongoing event not re-verified for this long counts half: stale. */
export const STALE_MS = 30 * 24 * 3600_000;
const HOUR = 3600_000;
/**
 * ISO 3166-1 codes the bundled Natural Earth pack spells differently: an
 * event may use either.
 */
export const COUNTRY_ALIASES = Object.freeze({
  SSD: 'SDS',
  PSE: 'PSX',
  XKX: 'KOS',
  ESH: 'SAH',
});
const MAX_TEXT = 600;
const MAX_SOURCES = 20;

/** Duration weight: under 6 h 0.25, under a day 0.5, under 3 days 0.75, else 1. */
export function durationWeight(hours) {
  if (!(hours >= 0)) return 0.25;
  if (hours < 6) return 0.25;
  if (hours < 24) return 0.5;
  if (hours < 72) return 0.75;
  return 1;
}

/** Map intensity for a weighted head-count: 10,000 or fewer 0, 100 million 1. */
export function reachIntensity(people) {
  if (!(people > 0)) return 0;
  return Math.min(1, Math.max(0, (Math.log10(people) - 4) / 4));
}

const time = (value) => {
  if (value == null || value === '') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : NaN;
};
const text = (value, max = MAX_TEXT) =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
const httpUrl = (value) => {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' || url.protocol === 'http:'
      ? url.href
      : null;
  } catch {
    return null;
  }
};

/**
 * One reviewed event from the data file, checked. Returns `{ event }` or
 * `{ error }` (a short reason): a bad entry is reported, never guessed at.
 */
export function normalizeEvent(raw, { now = Date.now() } = {}) {
  if (!raw || typeof raw !== 'object') return { error: 'not an object' };
  const id = text(raw.id, 120);
  if (!id || !/^[\w.:-]+$/.test(id)) return { error: 'missing or bad id' };
  const fail = (why) => ({ error: `${id}: ${why}` });
  const code = typeof raw.country_code === 'string' ? raw.country_code : '';
  const iso3 = COUNTRY_ALIASES[code] ?? code;
  if (!/^[A-Z]{3}$/.test(iso3))
    return fail('country_code must be ISO 3166-1 alpha-3');
  if (!EVENT_TYPES.includes(raw.event_type)) return fail('unknown event_type');
  const severity = raw.severity;
  if (!Number.isInteger(severity) || severity < 1 || severity > 5)
    return fail('severity must be 1-5');
  if (!CONFIDENCE_LEVELS.includes(raw.confidence))
    return fail('unknown confidence');
  const startedAt = time(raw.start_time);
  if (!Number.isFinite(startedAt)) return fail('start_time is required');
  const resolvedAt = time(raw.resolved_time);
  if (Number.isNaN(resolvedAt)) return fail('bad resolved_time');
  if (resolvedAt != null && resolvedAt < startedAt)
    return fail('resolved_time before start_time');
  const updatedAt = time(raw.last_update_time);
  if (Number.isNaN(updatedAt)) return fail('bad last_update_time');
  // A day of slack for time zones. An update dated later would stand in for
  // a verification (below) and keep the event from ever going stale.
  if (updatedAt != null && updatedAt > now + 86_400_000)
    return fail('last_update_time in the future');
  // When a reviewer last confirmed the event's status (still ongoing, or
  // resolved): a report's date is not a confirmation that it still holds.
  const verifiedAt = time(raw.last_verified_time);
  if (Number.isNaN(verifiedAt)) return fail('bad last_verified_time');
  if (verifiedAt != null && verifiedAt < startedAt)
    return fail('last_verified_time before start_time');
  // A day of slack for time zones; later would never go stale.
  if (verifiedAt != null && verifiedAt > now + 86_400_000)
    return fail('last_verified_time in the future');
  const people = raw.affected_people_est;
  if (people != null && !(Number.isFinite(people) && people >= 0))
    return fail('affected_people_est must be a number of people');
  const pct = raw.affected_population_pct;
  if (pct != null && !(Number.isFinite(pct) && pct >= 0 && pct <= 100))
    return fail('affected_population_pct must be 0-100');
  const sources = (Array.isArray(raw.sources) ? raw.sources : [])
    .slice(0, MAX_SOURCES)
    .map((s) => ({
      title: text(s?.title, 200),
      url: httpUrl(s?.url),
      publisher: text(s?.publisher, 120),
      published: text(s?.published, 40),
    }))
    .filter((s) => s.url);
  if (!sources.length) return fail('at least one source with a URL');
  const pastEnd = resolvedAt != null && resolvedAt <= now ? resolvedAt : null;
  return {
    event: {
      id,
      iso3,
      countryName: text(raw.country_name, 120),
      type: raw.event_type,
      severity,
      confidence: raw.confidence,
      startedAt,
      resolvedAt,
      updatedAt: updatedAt ?? pastEnd ?? startedAt,
      // Without a verification date, the latest date that has passed: a
      // planned end still ahead confirms nothing yet.
      verifiedAt: verifiedAt ?? updatedAt ?? pastEnd ?? startedAt,
      affectedPeople: people ?? null,
      affectedPct: pct ?? null,
      affectedBasis: text(raw.affected_basis),
      summary: text(raw.summary),
      sources,
    },
  };
}

/**
 * An event as of `now`: its duration, its fade after resolution, and its
 * scores. `population` is the country's, or null. Scores are null when the
 * share affected is unknown: the extent is shown as unknown, never guessed.
 */
export function assessEvent(event, { now, population = null }) {
  // Not started yet: kept out of the map until it starts.
  const upcoming = event.startedAt > now;
  // A planned end in the future does not count as time already elapsed.
  const end = Math.min(event.resolvedAt ?? now, now);
  const durationHours = Math.max(0, (end - event.startedAt) / HOUR);
  const active =
    !upcoming && (event.resolvedAt == null || event.resolvedAt > now);
  const decay = active
    ? 1
    : Math.max(0, 1 - (now - event.resolvedAt) / DECAY_MS);
  const people =
    event.affectedPeople ??
    (event.affectedPct != null && population
      ? Math.round((event.affectedPct / 100) * population)
      : null);
  const pct =
    event.affectedPct ??
    (event.affectedPeople != null && population
      ? Math.min(100, (event.affectedPeople / population) * 100)
      : null);
  const stale = active && now - event.verifiedAt > STALE_MS;
  const weight =
    (upcoming ? 0 : 1) *
    (stale ? 0.5 : 1) *
    SEVERITY_WEIGHT[event.severity] *
    durationWeight(durationHours) *
    CONFIDENCE_WEIGHT[event.confidence] *
    decay;
  return {
    ...event,
    active,
    upcoming,
    stale,
    historical: !upcoming && !active && decay === 0,
    decay,
    durationHours,
    affectedPeople: people,
    affectedPct: pct,
    sourceCount: event.sources.length,
    // share: weighted fraction of the population (0-1); people: weighted
    // head-count.
    scores: {
      share: pct == null ? null : (pct / 100) * weight,
      people: people == null ? null : people * weight,
    },
  };
}

/** Near-systemic: an active, severe restriction reaching many people. */
export function isSystemic(e) {
  return (
    e.active &&
    !e.stale &&
    e.severity >= 4 &&
    ((e.affectedPct ?? 0) >= 25 || (e.affectedPeople ?? 0) >= 10_000_000)
  );
}

// Class bounds per mode: weighted share of the population, or weighted
// head-count. none / low / moderate / high below each bound, then severe.
const BOUNDS = Object.freeze({
  share: [0.005, 0.03, 0.1, 0.25],
  people: [10_000, 100_000, 1_000_000, 10_000_000],
});
// 'minimal' (below the first bound) is drawn as an outline, not a fill.
const CLASSES = ['minimal', 'low', 'moderate', 'high', 'severe'];

/**
 * Colour class for a score in a mode ('share' or 'people'): minimal, low,
 * moderate, high, severe; or unknown when the reach is not known. The fill
 * follows the chosen metric only: systemic importance is a separate flag,
 * drawn as a border, never a darker fill.
 */
export function scoreClass(score, mode = 'share') {
  if (score == null) return 'unknown';
  const bounds = BOUNDS[mode] ?? BOUNDS.share;
  const k = bounds.findIndex((b) => score < b);
  return CLASSES[k === -1 ? 4 : k];
}

// Reach across several events: overlap between them is unknown (two banks
// may share customers), so the figure is a range, from the largest single
// event (full overlap) to their sum (none), capped at the population.
function reachRange(events, key, cap) {
  const known = events.map((e) => e[key]).filter((v) => v != null);
  if (!known.length) return { low: null, high: null };
  const low = Math.max(...known);
  const sum = known.reduce((n, v) => n + v, 0);
  return { low, high: cap == null ? sum : Math.min(cap, sum) };
}

/**
 * Countries with at least one event that is not yet history (or every event,
 * with `history`). Each says its lead event's type, its reach as a range, and
 * a class per mode. `populationOf(iso3)` caps the head-count range.
 */
export function aggregateCountries(
  assessed,
  { history = false, populationOf = () => null } = {},
) {
  const byCountry = new Map();
  for (const e of assessed) {
    if (e.upcoming || (e.historical && !history)) continue;
    const list = byCountry.get(e.iso3) ?? [];
    list.push(e);
    byCountry.set(e.iso3, list);
  }
  const countries = [];
  for (const [iso3, events] of byCountry) {
    // The lead is the most serious live event (severity first, then reach,
    // then the latest), whether or not its reach is known: it gives the
    // country its type, pattern and card.
    events.sort(
      (a, b) =>
        Number(a.historical) - Number(b.historical) ||
        Number(b.active) - Number(a.active) ||
        b.severity - a.severity ||
        (b.scores.share ?? -1) - (a.scores.share ?? -1) ||
        b.updatedAt - a.updatedAt,
    );
    const live = events.filter((e) => !e.historical);
    const lead = events[0];
    // Reach and shade say who is cut off now: from the active events when
    // there are any. A resolved event still fading is recent history: it
    // shades the country only while nothing there is active, and its people
    // never count towards an ongoing disruption's reach.
    const active = live.filter((e) => e.active);
    const current = active.length ? active : live;
    // History keeps its figures for the card.
    const counted = current.length ? current : events;
    const people = reachRange(counted, 'affectedPeople', populationOf(iso3));
    const pct = reachRange(counted, 'affectedPct', 100);
    const systemic = live.some(isSystemic);
    // Scored on the largest single event: the lower bound of the reach, so
    // a country is never redder than its measured disruption.
    const best = (key) => {
      const v = current.map((e) => e.scores[key]).filter((x) => x != null);
      return v.length ? Math.max(...v) : null;
    };
    const share = best('share');
    const reach = best('people');
    countries.push({
      iso3,
      countryName: lead.countryName,
      leadEventId: lead.id,
      active: active.length > 0,
      historical: live.length === 0,
      stale: lead.stale === true,
      type: lead.type,
      severity: lead.severity,
      affectedPeople: people.low,
      affectedPeopleHigh: people.high,
      affectedPct: pct.low,
      affectedPctHigh: pct.high,
      // A range is shown: several events with a known figure may overlap.
      overlapPossible:
        (people.high ?? 0) > (people.low ?? 0) ||
        (pct.high ?? 0) > (pct.low ?? 0),
      // Head-count and share come from different events (no population to
      // derive one from the other): shown apart, never as one figure.
      mixedFigures: counted.some(
        (e) => (e.affectedPeople == null) !== (e.affectedPct == null),
      ),
      // A current event (active, or fading when nothing is active) whose
      // reach no source gives: the shade may understate.
      reachUnknown: current.some(
        (e) => e.affectedPeople == null && e.affectedPct == null,
      ),
      systemic,
      scores: { share, people: reach },
      // Fill strength 0-1 per mode.
      intensity: {
        share: share == null ? null : Math.min(1, share / 0.25),
        people: reach == null ? null : reachIntensity(reach),
      },
      classes: live.length
        ? {
            share: scoreClass(share, 'share'),
            people: scoreClass(reach, 'people'),
          }
        : { share: 'history', people: 'history' },
      decay: Math.max(...events.map((e) => e.decay)),
      updatedAt: Math.max(...events.map((e) => e.updatedAt)),
      verifiedAt: Math.max(...events.map((e) => e.verifiedAt)),
      eventIds: events.map((e) => e.id),
    });
  }
  countries.sort(
    (a, b) =>
      (b.scores.share ?? -1) - (a.scores.share ?? -1) ||
      b.updatedAt - a.updatedAt,
  );
  return countries;
}
