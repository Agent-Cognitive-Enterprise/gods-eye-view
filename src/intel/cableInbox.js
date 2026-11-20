// Observe-only inbox for submarine cable notices: pure helpers, no fetching
// and no clock. A proposal is a suggestion for a reviewer, never evidence.
// Nothing here writes the reviewed evidence file, the globe or Autopilot, and
// an IODA traffic drop is impact in a country, never a named cable's fault.

const SINGLE_WORD = /^[^\s\d-]+$/u;
const WORD_CHAR = /[\p{L}\p{N}]/u;
const DAY_MS = 24 * 3600_000;

const fold = (text) =>
  String(text ?? '')
    .normalize('NFC')
    .toLowerCase();

/**
 * Catalogue names for matching in free text, one entry per cable ID.
 * A single word with no digit or hyphen ("Echo", "SAFE", "Blue") is weak:
 * it is matched only with its catalogue capitals and in text that also says
 * "cable", and reported as weak.
 */
export function catalogueNames(collection) {
  if (!Array.isArray(collection?.features))
    throw new Error('Expected cable GeoJSON features');
  const byId = new Map();
  for (const feature of collection.features) {
    const { id, name } = feature?.properties ?? {};
    if (typeof id !== 'string' || !id || typeof name !== 'string') continue;
    const trimmed = name.trim().normalize('NFC');
    if (!trimmed || byId.has(id)) continue;
    byId.set(id, {
      cableId: id,
      name: trimmed,
      key: fold(trimmed),
      weak: SINGLE_WORD.test(trimmed),
    });
  }
  return [...byId.values()].sort(
    (a, b) => b.name.length - a.name.length || (a.cableId < b.cableId ? -1 : 1),
  );
}

/** Every whole-word index of `needle` in `haystack`. */
function wholeWordAt(haystack, needle) {
  const found = [];
  let at = haystack.indexOf(needle);
  while (at >= 0) {
    const before = haystack[at - 1];
    const after = haystack[at + needle.length];
    if (
      (before === undefined || !WORD_CHAR.test(before)) &&
      (after === undefined || !WORD_CHAR.test(after))
    )
      found.push(at);
    at = haystack.indexOf(needle, at + 1);
  }
  return found;
}

/**
 * Catalogue cables named in `text`, by exact catalogue name (case-folded,
 * whole words). No fuzzy, partial or nearest match: "C-Lion 1" does not find
 * "C-Lion1". A name inside a longer matched name ("Atlantis" in
 * "Atlantis-2") is not reported separately.
 */
export function cableMentions(text, names) {
  const raw = String(text ?? '').normalize('NFC');
  const folded = fold(raw);
  const saysCable = /\bcables?\b/.test(folded);
  const taken = [];
  const out = [];
  for (const entry of names) {
    const spans = entry.weak
      ? saysCable
        ? wholeWordAt(raw, entry.name)
        : []
      : wholeWordAt(folded, entry.key);
    const free = spans.filter(
      (start) =>
        !taken.some(
          ([from, to]) => start < to && start + entry.name.length > from,
        ),
    );
    if (!free.length) continue;
    for (const start of free) taken.push([start, start + entry.name.length]);
    out.push({ cableId: entry.cableId, name: entry.name, weak: entry.weak });
  }
  return out.sort((a, b) => (a.cableId < b.cableId ? -1 : 1));
}

const CUES = [
  [
    'restored',
    /\b(restored|repaired|repair (?:work )?(?:is |was |has been )?(?:completed|finished)|back (?:in|into) (?:service|operation)|back online|fully operational)\b/g,
  ],
  [
    'break',
    /\b(cut|cuts|severed|broken|break|breaks|breakage|damaged|damage)\b/g,
  ],
  [
    'fault',
    /\b(faults?|outages?|disruptions?|disturbances?|interrupted|interruptions?|failures?|failed|down)\b/g,
  ],
];

/**
 * Wording cues for the reviewer. The suggestion is only `fault` or
 * `restored`: a physical `break` is never suggested, because the notice has
 * to confirm it expressly, so break wording is listed for the reviewer to
 * check instead.
 */
export function claimCues(text) {
  const folded = fold(text);
  const cues = {};
  for (const [claim, pattern] of CUES) {
    const words = [...new Set([...folded.matchAll(pattern)].map((m) => m[1]))];
    if (words.length) cues[claim] = words.sort();
  }
  const suggestedClaim = cues.restored
    ? 'restored'
    : cues.fault || cues.break
      ? 'fault'
      : null;
  return { suggestedClaim, cues };
}

/**
 * A reviewer proposal for one new notice. `id`, `seenAt` and the source come
 * from the caller; the notice text only fills in suggestions.
 */
export function proposalFor({ id, source, item, seenAt, names }) {
  const text = `${item.title ?? ''}\n${item.summary ?? ''}`;
  const { suggestedClaim, cues } = claimCues(text);
  return {
    id,
    status: 'new',
    sourceId: source.id,
    sourceKind: source.sourceKind,
    publisher: source.publisher ?? null,
    url: item.url,
    title: String(item.title ?? '').slice(0, 300),
    summary: String(item.summary ?? '').slice(0, 600),
    publishedAt: item.publishedAt ?? null,
    seenAt,
    cables: cableMentions(text, names),
    suggestedClaim,
    cues,
  };
}

const incidentKey = (incident) =>
  JSON.stringify([incident.cableId, incident.incidentId]);

/**
 * What changed between two replays of the same reviewed evidence, for
 * example yesterday's and today's. Only incidents are compared: an outage
 * or a lead never becomes a cable change.
 */
export function diffSnapshots(before, after) {
  const earlier = new Map(before.incidents.map((i) => [incidentKey(i), i]));
  const changes = [];
  for (const incident of after.incidents) {
    const previous = earlier.get(incidentKey(incident));
    earlier.delete(incidentKey(incident));
    const base = {
      cableId: incident.cableId,
      incidentId: incident.incidentId,
      status: incident.status,
      reason: incident.reason,
      breakConfirmed: incident.breakConfirmed,
      sources: incident.evidence.map((row) => row.sourceUrl),
    };
    if (!previous) changes.push({ change: 'new', ...base });
    else if (
      previous.status !== incident.status ||
      previous.breakConfirmed !== incident.breakConfirmed
    )
      changes.push({
        change: 'updated',
        from: {
          status: previous.status,
          breakConfirmed: previous.breakConfirmed,
        },
        ...base,
      });
  }
  // Evidence only accumulates, so this means the reviewed file was edited.
  for (const incident of earlier.values())
    changes.push({
      change: 'removed',
      cableId: incident.cableId,
      incidentId: incident.incidentId,
      status: incident.status,
    });
  return changes;
}

/** `asOf` minus one day, as the UTC string the replay takes. */
export function dayBefore(asOf) {
  const time = Date.parse(asOf);
  if (!Number.isFinite(time)) throw new Error('asOf must be a UTC timestamp');
  return new Date(time - DAY_MS).toISOString();
}

const COUNTRY = /^country\/([A-Z]{2})$/;
const DATASOURCES = new Set(['bgp', 'gtr', 'ping-slash24', 'merit-nt']);

/**
 * IODA /v2/outages/events to country outages: when traffic or reachability
 * signals dropped, per country, with each signal kept separate. It says
 * nothing about which cable, if any, was involved.
 */
export function iodaOutages(body, { maxEvents = 2000 } = {}) {
  if (!Array.isArray(body?.data)) throw new Error('malformed IODA events');
  const byCountry = new Map();
  for (const event of body.data.slice(0, maxEvents)) {
    const code = COUNTRY.exec(String(event?.location ?? ''))?.[1];
    const start = Number(event?.start);
    const duration = Number(event?.duration);
    const score = Number(event?.score);
    if (
      !code ||
      !DATASOURCES.has(event?.datasource) ||
      !Number.isFinite(start) ||
      start <= 0 ||
      !Number.isFinite(duration) ||
      duration < 0
    )
      continue;
    if (!byCountry.has(code))
      byCountry.set(code, {
        country: code,
        name: String(event.location_name ?? code).slice(0, 80),
        signals: [],
      });
    byCountry.get(code).signals.push({
      datasource: event.datasource,
      method: String(event.method ?? '').slice(0, 40) || null,
      start: new Date(start * 1000).toISOString(),
      end: new Date((start + duration) * 1000).toISOString(),
      score: Number.isFinite(score) ? Math.round(score) : null,
    });
  }
  return [...byCountry.values()]
    .map((outage) => {
      outage.signals.sort((a, b) =>
        a.start < b.start ? -1 : a.start > b.start ? 1 : 0,
      );
      return {
        ...outage,
        start: outage.signals[0].start,
        end: outage.signals.reduce(
          (latest, s) => (s.end > latest ? s.end : latest),
          outage.signals[0].end,
        ),
      };
    })
    .sort((a, b) => (a.country < b.country ? -1 : 1));
}
