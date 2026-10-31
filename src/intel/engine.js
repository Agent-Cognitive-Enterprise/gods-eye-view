// The deterministic event engine: observations in, canonical events out.
// An event is a fold over its linked observations, so ingestion, replay and an
// operator's "this was merged by mistake" split all share one code path. The
// clock is injected; nothing here reads wall time. Persistence is a supplied
// store (memory for tests and replay, SQLite on the server). Pure and portable.

import {
  bestMatch,
  duplicateOf,
  isConsequence,
  lineageFor,
  materialChanges,
} from './correlate.js';
import {
  normalizeObservation,
  observationTime,
  stableHash,
  textTokens,
} from './evidence.js';
import { lifecycleAt } from './lifecycle.js';
import { ruleSeverity, scoreEvent, verificationOf } from './scoring.js';
import { CATEGORY_POLICY } from './taxonomy.js';

const MAX_TOKENS = 200;
const WITHDRAWN_TEXT = 'Report withdrawn by its source';
const MAX_HISTORY = 12;
const PRECISION_RANK = [
  'unresolved',
  'country',
  'region',
  'city',
  'point',
  'exact',
];
const LONGEST_MATCH_WINDOW_MS = Math.max(
  ...Object.values(CATEGORY_POLICY).map((p) => p.matchWindowMs),
);

/** When an observation changed what is known: publication, else occurrence, else receipt. */
export function updateTime(observation) {
  const at =
    observation.published_at ??
    observation.occurred_at ??
    observation.received_at;
  return Math.min(at, observation.received_at);
}

const authority = (o) =>
  o.official ? 2 : o.source_type === 'eyewitness' ? 1 : 0;

/**
 * A report family: one provider's stable key (an official warning and the
 * local measurement filed under it share one). Ownership of the summary and
 * of each metric is recorded by family, never by lineage: a lineage can be
 * inherited by a copy from someone else.
 */
const familyOf = (observation, lineage) =>
  observation.event_key
    ? `${observation.provider}|${observation.event_key}`
    : `lineage|${lineage.lineage_key}`;

function newEvent(observation, lineage) {
  const at = updateTime(observation);
  const event = {
    event_id: `evt_${stableHash(observation.observation_id)}`,
    revision: 1,
    category: observation.category,
    subtype: observation.subtype,
    title: observation.title,
    summary: observation.summary,
    // Which report family stated the summary and each metric.
    summary_source: observation.summary ? familyOf(observation, lineage) : null,
    language: observation.language,
    location: { ...observation.location },
    event_keys: observation.event_key
      ? [`${observation.provider}|${observation.event_key}`]
      : [],
    lineage_keys: [lineage.lineage_key],
    urls: observation.url ? [observation.url] : [],
    lineages: [
      {
        lineage_key: lineage.lineage_key,
        publisher: observation.publisher,
        provider: observation.provider,
        source_type: observation.source_type,
        official: observation.official,
        first_observation_id: observation.observation_id,
        first_seen_at: observation.received_at,
      },
    ],
    providers: [observation.provider],
    tokens: textTokens(`${observation.title} ${observation.summary}`).slice(
      0,
      MAX_TOKENS,
    ),
    entities: [...observation.entities],
    metrics: { ...observation.metrics },
    metric_sources: Object.fromEntries(
      Object.keys(observation.metrics).map((key) => [
        key,
        familyOf(observation, lineage),
      ]),
    ),
    status_hint: observation.status_hint,
    official: observation.official,
    time_zone_known: observation.time_zone_known,
    occurred_at: observation.occurred_at ?? observationTime(observation),
    // Matching needs a time; a card must still say when none was stated.
    event_time_known: observation.occurred_at !== null,
    first_published_at: observation.published_at,
    first_seen_at: observation.received_at,
    last_meaningful_update_at: at,
    last_seen_at: observation.received_at,
    valid_until: observation.valid_until,
    observation_count: 1,
    duplicate_count: 0,
    severity_history: [],
    assessment: null,
    links: [],
  };
  event.severity_history.push(ruleSeverity(event));
  return event;
}

/** A report can arrive late; the first publication stays the earliest known. */
function noteEarlierReport(event, observation) {
  const at = observation.published_at;
  if (at !== null && at < (event.first_published_at ?? Infinity))
    event.first_published_at = at;
}

/** Apply a material observation to an event (returns a new object). */
function applyMaterial(event, observation, lineage, reasons) {
  const next = structuredClone(event);
  next.revision += 1;
  next.observation_count += 1;
  next.last_seen_at = Math.max(next.last_seen_at, observation.received_at);
  next.last_meaningful_update_at = Math.max(
    next.last_meaningful_update_at,
    updateTime(observation),
  );
  if (!next.lineage_keys.includes(lineage.lineage_key)) {
    next.lineage_keys.push(lineage.lineage_key);
    next.lineages.push({
      lineage_key: lineage.lineage_key,
      publisher: observation.publisher,
      provider: observation.provider,
      source_type: observation.source_type,
      official: observation.official,
      first_observation_id: observation.observation_id,
      first_seen_at: observation.received_at,
    });
  }
  if (observation.url && !next.urls.includes(observation.url))
    next.urls.push(observation.url);
  if (observation.event_key) {
    const key = `${observation.provider}|${observation.event_key}`;
    if (!next.event_keys.includes(key)) next.event_keys.push(key);
  }
  if (!next.providers.includes(observation.provider))
    next.providers.push(observation.provider);
  for (const entity of observation.entities)
    if (!next.entities.includes(entity)) next.entities.push(entity);
  for (const token of textTokens(`${observation.title} ${observation.summary}`))
    if (next.tokens.length < MAX_TOKENS && !next.tokens.includes(token))
      next.tokens.push(token);

  // One report family (same provider and stable key, e.g. an official
  // warning and the local traffic measurement filed under it) may fill in
  // what nobody stated and refresh what it stated itself; it never
  // overrides another source.
  const familyKey = familyOf(observation, lineage);
  const family = event.event_keys.includes(familyKey);
  // Facts nobody stated may be filled in only where that provider itself
  // vouches for the event with an official record of its own.
  const vouched =
    family &&
    event.lineages.some(
      (l) => l.provider === observation.provider && l.official,
    );
  next.metric_sources ??= {};
  // Measured facts: counts only grow; the most authoritative source sets the rest.
  const m = observation.metrics;
  for (const [key, value] of Object.entries(m)) {
    if (['deaths', 'injured', 'affected', 'displaced', 'arrests'].includes(key))
      next.metrics[key] = Math.max(next.metrics[key] ?? 0, value);
    else if (
      authority(observation) >= (next.official ? 2 : 0) ||
      (family &&
        (next.metric_sources[key] === familyKey ||
          (next.metrics[key] === undefined && vouched)))
    ) {
      next.metrics[key] = value;
      next.metric_sources[key] = familyKey;
    }
  }
  // Ending an event (retracted, resolved) or reviving an ended one only
  // counts from an authority or from the claim's own origin. Anyone else's
  // retraction makes it disputed; their "resolved" or a status that would
  // revive a retracted/resolved event is ignored.
  if (observation.status_hint) {
    const own = event.lineage_keys.includes(lineage.lineage_key);
    const trusted = observation.official || own;
    const ended = (hint) => hint === 'retracted' || hint === 'resolved';
    if (trusted) next.status_hint = observation.status_hint;
    else if (observation.status_hint === 'retracted')
      next.status_hint = ended(event.status_hint)
        ? event.status_hint
        : 'disputed';
    else if (!ended(observation.status_hint) && !ended(event.status_hint))
      next.status_hint = observation.status_hint;
  }
  if (observation.official) next.official = true;
  if (
    PRECISION_RANK.indexOf(observation.location.precision) >
      PRECISION_RANK.indexOf(next.location.precision) ||
    (observation.official &&
      !event.official &&
      observation.location.lat !== null)
  )
    next.location = { ...observation.location };
  if (authority(observation) >= authority({ official: event.official })) {
    next.title = observation.title;
    if (observation.summary) {
      next.summary = observation.summary;
      next.summary_source = familyKey;
    }
  } else if (
    family &&
    observation.summary &&
    (next.summary_source === familyKey || (!next.summary && vouched))
  ) {
    next.summary = observation.summary;
    next.summary_source = familyKey;
  }
  if (observation.subtype && !next.subtype) next.subtype = observation.subtype;
  if (Number.isFinite(observation.valid_until))
    next.valid_until = Math.max(next.valid_until ?? 0, observation.valid_until);
  if (!observation.time_zone_known) next.time_zone_known = false;
  next.severity_history.push(ruleSeverity(next));
  if (next.severity_history.length > MAX_HISTORY) next.severity_history.shift();
  next.last_change_reasons = reasons;
  if (observation.occurred_at !== null) next.event_time_known = true;
  noteEarlierReport(next, observation);
  if (
    !next.first_corroborated_at &&
    ['corroborated', 'officially_reported'].includes(verificationOf(next))
  )
    next.first_corroborated_at = observation.received_at;
  return next;
}

/**
 * Create an engine over a store.
 * @param {{store: object, now: () => number, settings?: object}} options
 */
export function createIntelEngine({ store, now, settings = {} }) {
  let config = { ...settings };

  function candidates(observation) {
    return store.eventsSince(
      observationTime(observation) - LONGEST_MATCH_WINDOW_MS,
    );
  }

  function snapshotRevision(event, observation, reasons, outcome) {
    store.saveRevision({
      event_id: event.event_id,
      revision: event.revision,
      recorded_at: now(),
      update_time: event.last_meaningful_update_at,
      outcome,
      reasons,
      observation_id: observation.observation_id,
      snapshot: {
        title: event.title,
        status_hint: event.status_hint,
        metrics: event.metrics,
        location: event.location,
        lineages: event.lineages.length,
        rule_severity: event.severity_history.at(-1),
      },
    });
  }

  /** Ingest one normalized observation. */
  function ingestOne(observation) {
    const dup = duplicateOf(observation, store.duplicateIndex());
    if (dup.duplicate) {
      const eventId = store.eventForDuplicate(observation);
      // The same record polled again is not news and not a repost: nothing
      // is written (a feed without 304 would otherwise add a row per poll).
      if (eventId && dup.reason !== 'same_observation_id')
        store.noteDuplicate(eventId, observation, dup.reason);
      return { status: 'duplicate', event_id: eventId, reasons: [dup.reason] };
    }
    const found = bestMatch(observation, candidates(observation));
    if (!found) {
      const lineage = lineageFor(observation, []);
      const event = newEvent(observation, lineage);
      store.saveEvent(event);
      store.saveObservation(observation, {
        event_id: event.event_id,
        method: 'new_event',
        lineage,
        material: true,
        reasons: ['new_event'],
      });
      snapshotRevision(event, observation, ['new_event'], 'new_event');
      return {
        status: 'new_event',
        event_id: event.event_id,
        reasons: ['new_event'],
      };
    }
    const { event: parent, match } = found;
    if (isConsequence(observation, parent)) {
      const lineage = lineageFor(observation, []);
      const child = newEvent(observation, lineage);
      child.links.push({
        event_id: parent.event_id,
        relation: 'consequence_of',
      });
      const updatedParent = structuredClone(parent);
      updatedParent.links.push({
        event_id: child.event_id,
        relation: 'has_consequence',
      });
      store.saveEvent(child);
      store.saveEvent(updatedParent);
      store.saveObservation(observation, {
        event_id: child.event_id,
        method: 'consequence',
        match,
        lineage,
        material: true,
        reasons: ['consequence_of', parent.event_id],
      });
      snapshotRevision(child, observation, ['consequence_of'], 'linked_child');
      return {
        status: 'linked_child',
        event_id: child.event_id,
        parent_event_id: parent.event_id,
        reasons: ['consequence_of'],
      };
    }
    const prior = store
      .evidenceFor(parent.event_id)
      .map(({ observation: o, link }) => ({
        ...o,
        resolved_lineage: link?.lineage?.lineage_key ?? o.lineage_key,
      }));
    const lineage = lineageFor(observation, prior);
    const reasons = materialChanges(observation, parent, lineage);
    const link = {
      event_id: parent.event_id,
      method: match.method,
      match,
      lineage,
      reasons,
    };
    if (!reasons.length) {
      const updated = structuredClone(parent);
      updated.observation_count += 1;
      updated.last_seen_at = Math.max(
        updated.last_seen_at,
        observation.received_at,
      );
      // A source already on the event saying it is still in force extends
      // the marker's lifetime; it is no news, so no re-alert.
      if (
        Number.isFinite(observation.valid_until) &&
        parent.lineage_keys.includes(lineage.lineage_key) &&
        observation.valid_until > (updated.valid_until ?? 0)
      )
        updated.valid_until = observation.valid_until;
      noteEarlierReport(updated, observation);
      store.saveEvent(updated);
      store.saveObservation(observation, { ...link, material: false });
      return { status: 'non_material', event_id: parent.event_id, reasons: [] };
    }
    const updated = applyMaterial(parent, observation, lineage, reasons);
    store.saveEvent(updated);
    store.saveObservation(observation, { ...link, material: true });
    snapshotRevision(updated, observation, reasons, 'material_update');
    return { status: 'material_update', event_id: parent.event_id, reasons };
  }

  /**
   * Normalize and ingest raw connector records in a stable order (event time,
   * then id) so the same batch always produces the same events.
   */
  function ingest(rawRecords, { receivedAt = now() } = {}) {
    const results = [];
    const normalized = [];
    for (const raw of rawRecords) {
      const result = normalizeObservation(raw, { receivedAt });
      if (result.ok) normalized.push(result.observation);
      else
        results.push({
          status: 'rejected',
          reasons: [result.reason],
          source_item_id: raw?.source_item_id ?? null,
        });
    }
    normalized.sort(
      (a, b) =>
        observationTime(a) - observationTime(b) ||
        (a.observation_id < b.observation_id ? -1 : 1),
    );
    for (const observation of normalized) results.push(ingestOne(observation));
    return results;
  }

  /** The event with scores and lifecycle evaluated at `at`. */
  function evaluate(event, at = now()) {
    const score = scoreEvent(event, at, config);
    const withVerification = { ...event, verification: score.verification };
    const life = lifecycleAt(withVerification, at, config.categoryOverrides);
    const enabled = config.categoryRelevance?.[event.category] !== 0;
    return {
      ...event,
      severity: score.severity,
      rule_severity: score.rule_severity,
      confidence: score.confidence,
      verification: score.verification,
      escalation: score.escalation,
      attention_score: score.attention_score,
      base_attention_score: score.base_attention_score,
      proximity: score.proximity,
      critical_qualified: score.critical_qualified,
      critical_blocked: score.critical_blocked,
      evidence_factor: score.evidence_factor,
      model_applied: score.model_applied,
      score_terms: score.terms,
      score_weights: score.weights,
      lifecycle: life.lifecycle,
      opacity: life.opacity,
      focus_until: life.focus_until,
      fade_starts_at: life.fade_starts_at,
      expires_at: life.expires_at,
      camera_eligible:
        enabled &&
        life.focus_eligible &&
        score.confidence >= (config.minimumCameraConfidence ?? 0) &&
        (event.location.lat !== null || event.location.region_code !== null),
    };
  }

  /** Events visible on the map at `at` (not archived/retracted), best first. */
  function activeEvents(at = now()) {
    const horizon = at - 31 * 24 * 3600_000;
    return store
      .eventsSince(horizon)
      .map((event) => evaluate(event, at))
      .filter(
        (event) =>
          event.lifecycle !== 'archived' && event.lifecycle !== 'retracted',
      )
      .sort(
        (a, b) =>
          b.attention_score - a.attention_score ||
          (a.event_id < b.event_id ? -1 : 1),
      );
  }

  /**
   * A source took its report back (a deleted post). The report stops counting
   * and its words are blanked; that it existed, and what the event looked like
   * then, stay in the history. Other sources keep the event alive; with none
   * left it is retracted. Attention is not renewed.
   * @returns {?{event_id: string, retracted: boolean}}
   */
  function withdrawReport(eventId, { provider, sourceItemId }) {
    const event = store.getEvent(eventId);
    if (!event) return null;
    const evidence = store.evidenceFor(eventId);
    const isReport = ({ observation: o }) =>
      o.provider === provider && o.source_item_id === sourceItemId;
    const held = evidence.filter(isReport);
    if (!held.length || held.every((e) => e.observation.withdrawn)) return null;
    const lineageOf = (e) =>
      e.link?.lineage?.lineage_key ?? e.observation.lineage_key;
    const others = evidence.filter(
      (e) => !isReport(e) && !e.observation.withdrawn,
    );
    const standing = new Set(others.map(lineageOf));
    const gone = new Set(held.map(lineageOf).filter((k) => !standing.has(k)));
    const next = structuredClone(event);
    next.revision += 1;
    next.lineages = next.lineages.filter((l) => !gone.has(l.lineage_key));
    next.lineage_keys = next.lineage_keys.filter((k) => !gone.has(k));
    if (!next.lineages.length) next.status_hint = 'retracted';
    const withdrawnTitles = new Set(held.map((e) => e.observation.title));
    if (withdrawnTitles.has(next.title)) {
      const remaining = others.at(-1)?.observation;
      next.title = remaining?.title ?? WITHDRAWN_TEXT;
      next.summary = remaining?.summary ?? '';
    }
    next.last_change_reasons = ['source_withdrew_report'];
    store.saveEvent(next);
    for (const { observation } of held)
      store.redactObservation(observation.observation_id, {
        title: WITHDRAWN_TEXT,
        summary: '',
        withdrawn: true,
      });
    snapshotRevision(
      next,
      held[0].observation,
      ['source_withdrew_report'],
      'source_withdrawn',
    );
    return { event_id: eventId, retracted: !next.lineages.length };
  }

  /** Attach a bounded, already-validated model assessment to an event. */
  function setAssessment(eventId, assessment) {
    const event = store.getEvent(eventId);
    if (!event) return false;
    store.saveEvent({ ...event, assessment });
    return true;
  }

  return {
    ingest,
    evaluate,
    activeEvents,
    setAssessment,
    withdrawReport,
    getEvent: (id, at = now()) => {
      const event = store.getEvent(id);
      return event ? evaluate(event, at) : null;
    },
    configure(next) {
      config = { ...config, ...next };
    },
    settings: () => ({ ...config }),
  };
}
