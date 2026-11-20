// Observe-only inbox for submarine cable notices: pure helpers, no fetching
// and no clock. A proposal is a suggestion for a reviewer, never evidence.
// Nothing here writes the reviewed evidence file, the globe or Autopilot, and
// an IODA traffic drop is impact in a country, never a named cable's fault.

const SINGLE_WORD = /^[^\s\d-]+$/u;
const WORD_CHAR = /[\p{L}\p{N}]/u;
const DAY_MS = 24 * 3600_000;
// Text that names a cable has to be about a cable: catalogue names include
// "Northern Lights", "Cook Strait", "Italy-Albania" and "T3".
const ABOUT_CABLES = /\b(?:cables?|subsea|submarine|undersea)\b/;
// One token of five or more characters with a digit ("SeaMeWe-4",
// "2Africa", "C-Lion1") is distinctive enough to match without that word.
// Names with a space are not: "Germany-Denmark 3" is also a football score.
const DISTINCT = (name) =>
  /\d/.test(name) && name.length >= 5 && !/\s/.test(name);
// C0 and C1 controls (terminal escapes, BEL) and bidirectional overrides.
const UNPRINTABLE =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

/** Text safe to store and print: no control or bidi characters. */
export const printable = (value) =>
  String(value ?? '')
    .replace(UNPRINTABLE, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * NFC and lower case, one UTF-16 unit per unit, so an index in the folded
 * text is the same index in the original ("İ" lengthens when lower-cased
 * and is kept as it is).
 */
function fold(text) {
  const raw = String(text ?? '').normalize('NFC');
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const lower = raw[i].toLowerCase();
    out += lower.length === 1 ? lower : raw[i];
  }
  return out;
}

/**
 * Catalogue names for matching in free text, one entry per cable ID.
 * A single word with no digit or hyphen ("Echo", "SAFE", "Blue") is weak:
 * it is matched only with its catalogue capitals, and reported as weak.
 * Every match also needs text about a cable (see cableMentions).
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
      distinct: DISTINCT(trimmed),
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
 * whole words), and only when the text says cable, subsea, submarine or
 * undersea, unless the name has a digit and five or more characters. No fuzzy, partial or nearest match: "C-Lion 1" does not find
 * "C-Lion1". A name inside a longer matched name ("Atlantis" in
 * "Atlantis-2") is not reported separately.
 */
export function cableMentions(text, names) {
  const raw = String(text ?? '').normalize('NFC');
  const folded = fold(raw);
  const aboutCables = ABOUT_CABLES.test(folded);
  const taken = [];
  const out = [];
  for (const entry of names) {
    if (!aboutCables && !entry.distinct) continue;
    const spans = entry.weak
      ? wholeWordAt(raw, entry.name)
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
  // Wording that makes "restored" doubtful: a negation, a repair still to
  // come, or traffic moved to other routes.
  [
    'doubt',
    /\b(not|cannot|never|no longer|\w+n't|yet to be|awaits?|awaiting|until|pending|partial(?:ly)?|(?:alternative|alternate|backup) routes?|rerouted|rerouting)\b/g,
  ],
];

/**
 * Wording cues for the reviewer. The suggestion is only `fault` or
 * `restored`, and `restored` only when no doubtful wording comes with it:
 * repair wording next to a negation ("not yet restored", "will not be
 * restored until"), a repair still to come or rerouting suggests nothing,
 * because a wrong `restored` would close an incident. A physical `break` is
 * never suggested: the notice has to confirm it expressly, so break wording
 * is listed for the reviewer to check instead.
 */
export function claimCues(text) {
  // Curly and look-alike apostrophes, as in "hasn’t", read as straight ones.
  const folded = fold(String(text ?? '').slice(0, 4000)).replace(/[‘’ʼ]/g, "'");
  const cues = {};
  for (const [claim, pattern] of CUES) {
    const words = [...new Set([...folded.matchAll(pattern)].map((m) => m[1]))];
    if (words.length) cues[claim] = words.sort();
  }
  const suggestedClaim = cues.restored
    ? cues.doubt
      ? null
      : 'restored'
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
    // A feed link to another host is not the publisher's own notice: it is
    // proposed as news, whatever the source is.
    ...(item.offHost ? { offHost: true } : {}),
    id,
    status: 'new',
    sourceId: source.id,
    sourceKind: item.offHost ? 'news' : source.sourceKind,
    publisher: source.publisher ?? null,
    url: item.url,
    title: printable(item.title).slice(0, 300),
    summary: printable(item.summary).slice(0, 600),
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
      previous.breakConfirmed !== incident.breakConfirmed ||
      previous.reason !== incident.reason ||
      previous.evidence.length !== incident.evidence.length
    )
      changes.push({
        change: 'updated',
        from: {
          status: previous.status,
          breakConfirmed: previous.breakConfirmed,
          evidence: previous.evidence.length,
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
export function iodaOutages(
  body,
  { maxEvents = 2000, from = -Infinity, until = Infinity } = {},
) {
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
      duration < 0 ||
      // Outside the window asked for (seconds), or no valid date.
      start > until ||
      start + duration < from ||
      start > 1e10 ||
      start + duration > 1e10
    )
      continue;
    if (!byCountry.has(code))
      byCountry.set(code, {
        country: code,
        name: printable(event.location_name ?? code).slice(0, 80),
        signals: [],
      });
    byCountry.get(code).signals.push({
      datasource: event.datasource,
      method: printable(event.method).slice(0, 40) || null,
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
