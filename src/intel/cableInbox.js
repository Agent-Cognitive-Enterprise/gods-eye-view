// Observe-only inbox for submarine cable notices: pure helpers, no fetching
// and no clock. A proposal is a suggestion for a reviewer, never evidence.
// Nothing here writes the reviewed evidence file, the globe or Autopilot, and
// an IODA traffic drop is impact in a country, never a named cable's fault.

const SINGLE_WORD = /^[^\s\d-]+$/u;
const WORD_CHAR = /[\p{L}\p{N}]/u;
const DAY_MS = 24 * 3600_000;
// Text that names a cable has to be about a cable: catalogue names include
// "Northern Lights", "Cook Strait", "Italy-Albania" and "T3". Nordic and
// German regulators write kabel, kabler, kablene, kablar, sjøkabel, Seekabel or
// (meri)kaapeli, often inside a compound word, so those match anywhere.
const ABOUT_CABLES =
  /\b(?:cables?|subsea|submarine|undersea)\b|kabel|kabl[aeiu]|kaapeli/;
// One token of five or more characters with a digit ("SeaMeWe-4",
// "2Africa", "C-Lion1") is distinctive enough to match without that word.
// Names with a space are not: "Germany-Denmark 3" is also a football score.
const DISTINCT = (name) =>
  /\d/.test(name) && name.length >= 5 && !/\s/.test(name);
// Names written in other spellings: news writes "SEA-ME-WE 5" and "SMW5"
// for the catalogue's "SeaMeWe-5". Spacing, hyphens and capitals are
// matched loosely (see LOOSE); these are the other forms.
const ALIASES = Object.freeze({
  'seamewe-4': ['SMW4'],
  'seamewe-5': ['SMW5'],
  'seamewe-6': ['SMW6'],
  'europe-india-gateway-eig': ['EIG'],
  imewe: ['I-ME-WE'],
  'transworld-tw1': ['TW-1'],
});
// Spaces, hyphens, dashes and underscores inside a name: "SEA-ME-WE 5",
// "Sea Me We 5" and "SeaMeWe-5" are one name.
const SEPARATOR = /[\s\-‐-―−_]/u;
// A name is matched with any spacing only when it has a letter and a digit
// and four or more characters without separators: "seamewe5", "clion1",
// "aae1". Without a digit ("Northern Lights") or shorter ("T3") the exact
// spelling is needed.
const LOOSE = (key) => key.length >= 4 && /\p{L}/u.test(key) && /\d/.test(key);
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

/** A name folded, with no spaces, hyphens or dashes: "seamewe5". */
const compact = (name) =>
  [...fold(name)].filter((c) => !SEPARATOR.test(c)).join('');

/**
 * Every [start, end) in `folded` that spells `key` (a compact name) with
 * any spaces, hyphens or dashes, as whole words: "SEA-ME-WE 5" for
 * "seamewe5". It is no match when a number goes on after it ("Africa 1,000
 * km", "SeaMeWe 5 000 km"), or when a number stands apart before the
 * letters ("Top 2 Africa"): that is counting, not a name.
 */
function looseAt(folded, key) {
  let text = '';
  const at = [];
  for (let i = 0; i < folded.length; i += 1)
    if (!SEPARATOR.test(folded[i])) {
      text += folded[i];
      at.push(i);
    }
  const found = [];
  for (let j = text.indexOf(key); j >= 0; j = text.indexOf(key, j + 1)) {
    const start = at[j];
    const end = at[j + key.length - 1] + 1;
    const before = folded[start - 1];
    const after = folded[end];
    if (before !== undefined && WORD_CHAR.test(before)) continue;
    if (after !== undefined && WORD_CHAR.test(after)) continue;
    if (/^[.,\s]?\d/.test(folded.slice(end, end + 2))) continue;
    const lead = /^\d+/.exec(folded.slice(start, end))?.[0];
    if (lead && SEPARATOR.test(folded[start + lead.length] ?? '')) continue;
    found.push([start, end]);
  }
  return found;
}

/**
 * Whether `text` names a cable by `name`: the exact name as whole words,
 * any case, or for a name with a letter and a digit, any spacing and
 * hyphens ("SEA-ME-WE 5" for "SeaMeWe-5"). It does not ask whether the
 * text is about cables.
 */
export function namesIn(text, name) {
  return nameSpans(text, name).length > 0;
}

/**
 * Where `text` names a cable by `name`, as namesIn decides: [start, end)
 * pairs in the NFC text. Lets a caller blank out one cable's names before
 * looking for another ("Atlantis" inside "Atlantis-2").
 */
export function nameSpans(text, name) {
  const folded = fold(String(text ?? '').normalize('NFC'));
  const key = fold(String(name ?? '').normalize('NFC'));
  if (!key) return [];
  const spans = wholeWordAt(folded, key).map((s) => [s, s + key.length]);
  const loose = compact(name);
  if (LOOSE(loose))
    for (const span of looseAt(folded, loose))
      if (!spans.some(([s]) => s === span[0])) spans.push(span);
  return spans;
}

/**
 * Catalogue names for matching in free text: each cable's full name, plus
 * distinctive parts of a bracketed name, plus the other spellings in
 * ALIASES.
 * A single word with no digit or hyphen ("Echo", "SAFE", "Blue") is weak:
 * it is matched only with its catalogue capitals, and reported as weak.
 * Every match also needs text about a cable (see cableMentions).
 */
export function catalogueNames(collection) {
  if (!Array.isArray(collection?.features))
    throw new Error('Expected cable GeoJSON features');
  const seen = new Set();
  const entries = [];
  const add = (cableId, name) => {
    const loose = compact(name);
    entries.push({
      cableId,
      name,
      key: fold(name),
      ...(LOOSE(loose) ? { loose } : {}),
      weak: SINGLE_WORD.test(name),
      distinct: DISTINCT(name),
    });
  };
  for (const feature of collection.features) {
    const { id, name } = feature?.properties ?? {};
    if (typeof id !== 'string' || !id || typeof name !== 'string') continue;
    const trimmed = name.trim().normalize('NFC');
    if (!trimmed || seen.has(id)) continue;
    seen.add(id);
    add(id, trimmed);
    // "Finland-Estonia 2 (EESF-2)", "Eastern Africa Submarine System
    // (EASSy)": notices often use one part on its own. A part is a name of
    // the cable too only when it is distinctive: it has a digit, or it is
    // a mixed-case acronym like EASSy. "LION", "MSC", "BICS", "Sweden-
    // Estonia" and "Norte Conectado" are not.
    const parts = /^(.*\S)\s*\(([^()]+)\)$/.exec(trimmed);
    if (parts)
      for (const part of [parts[1].trim(), parts[2].trim()])
        if (
          /\d/.test(part) ||
          /^(?=.*[A-Z].*[A-Z])(?=.*[a-z])[A-Za-z]{4,}$/.test(part)
        )
          add(id, part);
    for (const alias of ALIASES[id] ?? []) add(id, alias);
  }
  return entries.sort(
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
 * Catalogue cables named in `text`, by catalogue name (case-folded, whole
 * words), and only when the text says cable, subsea, submarine or
 * undersea, unless the name has a digit and five or more characters.
 * In text about cables, a name with a letter and a digit may also be
 * spaced or hyphenated differently: "SEA-ME-WE 5" and "C-Lion 1" find
 * "SeaMeWe-5" and "C-Lion1". No other fuzzy, partial or nearest match:
 * "C-Lion12" does not find "C-Lion1". A name inside a longer matched name
 * ("Atlantis" in "Atlantis-2") is not reported separately.
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
      ? wholeWordAt(raw, entry.name).map((s) => [s, s + entry.name.length])
      : wholeWordAt(folded, entry.key).map((s) => [s, s + entry.key.length]);
    // Another spelling counts only in text about cables.
    if (entry.loose && aboutCables)
      for (const span of looseAt(folded, entry.loose))
        if (!spans.some(([s]) => s === span[0])) spans.push(span);
    const free = spans.filter(
      ([start, end]) => !taken.some(([from, to]) => start < to && end > from),
    );
    if (!free.length) continue;
    for (const span of free) taken.push(span);
    // One result per cable; a strong name beats a weak one ("EASSy").
    const known = out.find((m) => m.cableId === entry.cableId);
    if (!known)
      out.push({ cableId: entry.cableId, name: entry.name, weak: entry.weak });
    else if (known.weak && !entry.weak)
      Object.assign(known, { name: entry.name, weak: false });
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
    /\b(faults?|outages?|disruptions?|disturbances?|interrupted|interruptions?|failures?|failed|down|out of service)\b/g,
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
