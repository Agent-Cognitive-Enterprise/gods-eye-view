// In-memory event store: the reference implementation of the store contract
// the engine uses, and the store behind deterministic replay and tests. The
// SQLite store on the server implements the same methods. Pure and portable.

const MAX_OBSERVATIONS_PER_EVENT = 500;

/** Shared archive filter, so every store answers the same query identically. */
export function matchesArchiveFilter(event, filter = {}) {
  if (filter.category && event.category !== filter.category) return false;
  if (filter.provider && !event.providers.includes(filter.provider))
    return false;
  if (
    Number.isFinite(filter.since) &&
    event.last_meaningful_update_at < filter.since
  )
    return false;
  if (Number.isFinite(filter.until) && event.first_seen_at > filter.until)
    return false;
  if (filter.bbox) {
    const { west, south, east, north } = filter.bbox;
    const { lat, lon } = event.location;
    if (lat === null || lat < south || lat > north) return false;
    const inLon =
      west <= east ? lon >= west && lon <= east : lon >= west || lon <= east;
    if (!inLon) return false;
  }
  return true;
}

export function createMemoryIntelStore() {
  const events = new Map();
  const observations = new Map(); // observation_id -> {observation, link}
  const byEvent = new Map(); // event_id -> observation ids, oldest first
  const revisions = new Map(); // event_id -> revision records
  const urlDigest = new Map(); // `${url}|${digest}` -> event_id
  const publisherDigest = new Map(); // `${publisher}|${digest}` -> event_id
  const duplicates = []; // bounded audit of suppressed republishes
  const flags = [];

  const index = {
    byId: { has: (id) => observations.has(id) },
    byUrlDigest: { has: (key) => urlDigest.has(key) },
    byPublisherDigest: { has: (key) => publisherDigest.has(key) },
  };

  return {
    duplicateIndex: () => index,
    eventForDuplicate(observation) {
      return (
        observations.get(observation.observation_id)?.link.event_id ??
        (observation.url
          ? urlDigest.get(`${observation.url}|${observation.content_digest}`)
          : undefined) ??
        publisherDigest.get(
          `${observation.publisher}|${observation.content_digest}`,
        ) ??
        null
      );
    },
    noteDuplicate(eventId, observation, reason) {
      const event = events.get(eventId);
      if (event)
        events.set(eventId, {
          ...event,
          duplicate_count: event.duplicate_count + 1,
          last_seen_at: Math.max(event.last_seen_at, observation.received_at),
        });
      duplicates.push({
        event_id: eventId,
        observation_id: observation.observation_id,
        reason,
      });
      if (duplicates.length > 1000) duplicates.shift();
    },
    eventsSince(since) {
      return [...events.values()].filter(
        (e) => e.last_meaningful_update_at >= since,
      );
    },
    observationsFor(eventId) {
      return (byEvent.get(eventId) ?? [])
        .slice(-MAX_OBSERVATIONS_PER_EVENT)
        .map((id) => observations.get(id).observation);
    },
    evidenceFor(eventId) {
      return (byEvent.get(eventId) ?? []).map((id) => observations.get(id));
    },
    saveEvent(event) {
      events.set(event.event_id, structuredClone(event));
    },
    saveObservation(observation, link) {
      observations.set(observation.observation_id, { observation, link });
      const list = byEvent.get(link.event_id) ?? [];
      list.push(observation.observation_id);
      byEvent.set(link.event_id, list);
      if (observation.url)
        urlDigest.set(
          `${observation.url}|${observation.content_digest}`,
          link.event_id,
        );
      publisherDigest.set(
        `${observation.publisher}|${observation.content_digest}`,
        link.event_id,
      );
    },
    saveRevision(revision) {
      const list = revisions.get(revision.event_id) ?? [];
      list.push(structuredClone(revision));
      revisions.set(revision.event_id, list);
    },
    getEvent: (id) => (events.has(id) ? structuredClone(events.get(id)) : null),
    revisions: (id) => structuredClone(revisions.get(id) ?? []),
    listEvents(filter = {}, { limit = 200 } = {}) {
      return [...events.values()]
        .filter((event) => matchesArchiveFilter(event, filter))
        .sort(
          (a, b) => b.last_meaningful_update_at - a.last_meaningful_update_at,
        )
        .slice(0, limit)
        .map((event) => structuredClone(event));
    },
    flagMerge(flag) {
      flags.push(structuredClone(flag));
    },
    flags: () => structuredClone(flags),
    duplicates: () => structuredClone(duplicates),
    stats: () => ({
      events: events.size,
      observations: observations.size,
      duplicates_suppressed: duplicates.length,
    }),
  };
}
