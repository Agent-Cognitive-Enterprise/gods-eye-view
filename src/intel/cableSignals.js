// Automatic submarine cable signals: which notices are red flags, which are
// clear enough to show without a person, and the incident each one opens,
// updates, closes or lets fade. Pure: no fetching, no clock, no storage.
//
// A clear signal is decided on the notice's title alone, which must have
// one of a few allowed shapes that tie the incident to the cable's name:
//   "A fault in the Cinia C-Lion1 submarine cable between Finland and Germany"
//   "Fault detected in Cinia C-Lion1 Submarine Cable"
//   "C-Lion1 submarine cable cut near Gotland"
//   "C-Lion1 cable outage"
//   "Cinia's C-Lion1 submarine cable has been repaired"
// Nothing else may be in the title, and no blocking word (negation, plans,
// history, business, hedging) either. The notice must also come from a
// primary source speaking for that cable, and it must be dated. Anything else
// that looks like an incident is "doubt": a local model may settle it
// (phase 2), and without one it is dropped. Allowed shapes, not blocked
// words, decide: review showed a blocklist alone never stops the next
// wrong signal ("Cinia files damages claim over C-Lion1 cable cut"). The
// summary is never judged: company boilerplate names cables too. Traffic
// data is never a cable signal.

import { cableMentions, claimCues, printable } from './cableInbox.js';

const PRIMARY = new Set(['operator', 'authority']);
// A notice about submarine cables, named or not, in English or the Nordic
// and German words the configured regulators use.
const SUBSEA =
  /\b(?:submarine|subsea|undersea|sea|offshore)[- ]?cables?\b|\bcables? (?:routes?|systems?|landings?|ships?|repairs?|cuts?|faults?|damage|breaks?)\b|sjøkab|sjökab|merikaapel|seekabel|undervannskab|havkab|merenalai/;
const THREAT =
  /\b(anchors?|anchor[- ]dragg\w*|dragg(?:ed|ing)|vessels?|ships?|trawl\w*|sabotage\w*|investigat\w*|police|navy|naval|coast ?guard|suspect\w*|tamper\w*|espionage|seiz\w*|detain\w*)\b/g;
export const FAULT_FADE_MS = 30 * 24 * 3600_000;
// A notice dated this long before it was first seen is old news under a new
// address (a page relayout, a sidebar link), not a new signal.
export const STALE_NOTICE_MS = 7 * 24 * 3600_000;

const INCIDENT_NOUN =
  '(?:fault|faults|disturbance|disturbances|outage|outages|damage|interruption|interruptions|failure|failures|cut|break)';
const BROKEN = '(?:cut|severed|damaged|broken|down|out of service|interrupted)';
const REPAIRED = '(?:repaired|restored)';
// Where it happened: "between Finland and Germany", "near Gotland", "in the
// Gulf of Finland". Letters only, a few words.
const W = "[\\p{L}][\\p{L}'-]*";
// Words allowed before a cable's name ("Cinia's", "the Cinia"): never a verb
// or question word, so "Is the C-Lion1 cable down" is no title shape.
const LEAD = `(?!(?:is|are|was|were|has|have|had|did|does|do|why|how|what|when|who|which|will)\\b)${W}`;
const PLACE = `(?: between ${W}(?: ${W})? and ${W}(?: ${W})?| (?:off|near|in|at) (?:the )?${W}(?: ${W}){0,3})?`;
// Any of these in the title makes it doubtful, whatever its shape.
const BLOCKERS = [
  // Negation, denial, hedging.
  /\b(?:no|not|none|never|nothing|without|zero|unaffected|unharmed|intact|normal|normally|usual|deny|denies|denied|false|unfounded|baseless|rumou?rs?|hoax|untrue|claims?|rejects?|refutes?|feared|unconfirmed|confirm\w*|suspected|possible|possibly|potential|likely|reportedly|alleged|allegedly|ei)\b|n't\b|-free\b|\btolerant\b/u,
  // Future, plans, conditions, questions.
  /(?<!(?:^|[^\p{L}\p{N}-])\d{1,2} )\bmay\b(?! \d)|\b(?:will|would|shall|might|could|can|should|must|to be|to start|expected|expects?|planned|plans?|scheduled|upcoming|soon|once|until|awaits?|awaiting|delayed|pending|if|whether|what|how|why|in case)\b|\?/u,
  // Partial, temporary or moved: not a clean repair.
  /\b(?:partial|partially|alternative|alternate|backup|rerout\w*|remains?|continues?|still|during|while|temporar\w*|resolved|fixed|ended|over|again|second|another|other)\b/u,
  // Not an incident notice: maintenance, drills, history, money, law.
  /\b(?:maintenance|upgrade\w*|drills?|exercises?|simulat\w*|test(?:s|ed|ing)?|inspection|decommission\w*|spare|preparedness|readiness|anniversary|years?|since|ago|last|lessons|timeline|history|explained|review\w*|insights|report|reports|results?|revenue|cost|costs|eur|usd|damages|compensation|lasted|latency|award\w*|contracts?|agreements?|mou|partner\w*|projects?|routes?|courts?|prosecutor\w*|crew|sanctions?|statement|thanks|welcomes?|reminder|impact|standby|power|pipeline|gas|electricity|converter|exchange|data cent\w*)\b/u,
];
const PHYSICAL = /\b(?:cut|cuts|severed|broken|break|breaks|breakage)\b/;
const APOSTROPHES = /[‘’ʼ´`′]/g;

const fold = (text) =>
  String(text ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(APOSTROPHES, "'");
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];
const LEADING_DATES = [
  [/^(\d{1,2})\.(\d{1,2})\.(\d{4})\s+/, (m) => [m[3], m[2], m[1]]],
  [/^(\d{4})-(\d{2})-(\d{2})\s+/, (m) => [m[1], m[2], m[3]]],
  [
    new RegExp(`^(${MONTHS.join('|')}) (\\d{1,2}),? (\\d{4})\\s+`, 'i'),
    (m) => [m[3], MONTHS.indexOf(m[1].toLowerCase()) + 1, m[2]],
  ],
  [
    new RegExp(`^(\\d{1,2}) (${MONTHS.join('|')}),? (\\d{4})\\s+`, 'i'),
    (m) => [m[3], MONTHS.indexOf(m[2].toLowerCase()) + 1, m[1]],
  ],
];

function leadingDate(text) {
  for (const [pattern, parts] of LEADING_DATES) {
    const m = pattern.exec(text);
    if (!m) continue;
    const [y, mo, d] = parts(m).map(Number);
    const back = new Date(Date.UTC(y, mo - 1, d));
    if (
      back.getUTCFullYear() !== y ||
      back.getUTCMonth() !== mo - 1 ||
      back.getUTCDate() !== d
    )
      return null;
    return { length: m[0].length, iso: back.toISOString() };
  }
  return null;
}

/**
 * A listing page puts the date in front of the title or the card text
 * ("18.11.2024 A fault in…", "August 14, 2024 WIOCC…"). Returns the item
 * with that date as `publishedAt` (UTC midnight) when it had none, and the
 * date taken off the title.
 */
export function datedNotice(item) {
  const title = String(item.title ?? '').trim();
  const summary = String(item.summary ?? '').trim();
  const inTitle = leadingDate(title);
  const inSummary = inTitle ? null : leadingDate(summary);
  const found = inTitle ?? inSummary;
  if (!found) return item;
  return {
    ...item,
    title: inTitle ? title.slice(inTitle.length) : title,
    summary: inSummary ? summary.slice(inSummary.length) : item.summary,
    publishedAt: item.publishedAt ?? found.iso,
  };
}

// "the Cinia C-Lion1 submarine cable", "Cinia's C-Lion1 cable system".
const cablePhrase = (name) =>
  `(?:the )?(?:${LEAD} ){0,2}${escape(fold(name))}(?: (?:submarine|subsea|undersea|sea))?(?: cable(?: system)?)?`;

/** Sentence openings that state a physical break of the named cable. */
function breakShapesFor(name) {
  const cable = cablePhrase(name);
  return [
    new RegExp(`^(?:the |a )?(?:break|cut) (?:in|on|of|to) ${cable}\\b`, 'u'),
    new RegExp(`^${cable} (?:was|has been|is) (?:cut|severed|broken)\\b`, 'u'),
  ];
}

/** The allowed title shapes for one cable name, as [claim, pattern]. */
function shapesFor(name) {
  const cable = cablePhrase(name);
  const u = 'u';
  return [
    // "A fault in the Cinia C-Lion1 submarine cable between …"
    [
      'fault',
      new RegExp(
        `^(?:an? |the |some )?${INCIDENT_NOUN}(?: (?:has been|was|is))?(?: (?:detected|found|identified|located))? (?:in|on|to|at|affecting) ${cable}${PLACE}$`,
        u,
      ),
    ],
    // "C-Lion1 cable outage", "C-Lion1 Fault Detected"
    [
      'fault',
      new RegExp(`^${cable} ${INCIDENT_NOUN}(?: detected)?${PLACE}$`, u),
    ],
    // "C-Lion1 submarine cable cut near Gotland", "C-Lion1 cable damaged"
    [
      'fault',
      new RegExp(`^${cable} (?:(?:has been|was|is) )?${BROKEN}${PLACE}$`, u),
    ],
    // "Svalbard Undersea Cable System: fault"
    [
      'fault',
      new RegExp(`^${cable}: (?:an? )?${INCIDENT_NOUN}(?: detected)?$`, u),
    ],
    // "Cinia's C-Lion1 submarine cable has been repaired", "… Fully Restored"
    [
      'restored',
      new RegExp(
        `^${cable} (?:(?:has been|have been|was|is now|has) )?(?:fully )?${REPAIRED}$`,
        u,
      ),
    ],
    // "C-Lion1 cable back in service"
    [
      'restored',
      new RegExp(
        `^${cable} (?:is )?back (?:in service|online|in operation)$`,
        u,
      ),
    ],
    // "Disturbance in Cinia's C-Lion1 submarine cable has been repaired",
    // "The Finland-Estonia 2 cable fault has been repaired"
    [
      'restored',
      new RegExp(
        `^(?:the )?${INCIDENT_NOUN} (?:in|on) ${cable} (?:has been|was) (?:fully )?${REPAIRED}$`,
        u,
      ),
    ],
    [
      'restored',
      new RegExp(
        `^${cable} ${INCIDENT_NOUN} (?:has been|was) (?:fully )?${REPAIRED}$`,
        u,
      ),
    ],
  ];
}

/**
 * The claim a title states in an allowed shape about the named cable, or
 * why it does not: {claim, breakConfirmed} or {reason}. `summary` may only
 * confirm a break, and only in an allowed shape of its own.
 */
export function templateClaim(title, cableName, noticeYear, summary = '') {
  const clean = (text) =>
    fold(text)
      .replace(/\s+/g, ' ')
      // A leading "Cinia:" or "Traficom:" names the speaker, not the event.
      .replace(/^(?!.*\bcable\b.*:)[\p{L}\p{N} .&'-]{1,40}: /u, '')
      // Decoration: emoji, punctuation and spaces at either end.
      .replace(/^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu, '');
  // A question is never a report, whatever its shape.
  if (/[?？]/.test(title)) return { reason: 'doubtful-wording' };
  const text = clean(title);
  if (BLOCKERS.some((pattern) => pattern.test(text)))
    return { reason: 'doubtful-wording' };
  // A year in the title other than the notice's own is history; so is '24.
  for (const m of text.matchAll(/\b(19\d\d|20\d\d)\b/g))
    if (Number(m[1]) !== noticeYear) return { reason: 'doubtful-wording' };
  if (/'\d\d\b/.test(text)) return { reason: 'doubtful-wording' };
  const shapes = shapesFor(cableName);
  const match = shapes.find(([, pattern]) => pattern.test(text));
  if (!match) return { reason: 'no-allowed-title-shape' };
  const [claim] = match;
  // A break stated in the summary counts only when a sentence opens with
  // it: "The break in Cinia's C-Lion1 submarine cable has been repaired …",
  // "C-Lion1 was cut …". Nothing else in the summary is judged.
  const summaryBreak = String(summary)
    .split(/(?<=[.!])\s+/)
    .map(clean)
    .some((sentence) =>
      breakShapesFor(cableName).some((pattern) => pattern.test(sentence)),
    );
  return { claim, breakConfirmed: PHYSICAL.test(text) || summaryBreak };
}

/**
 * One notice, judged without a person:
 * - `redFlag`: it is about submarine cables (it names a catalogue cable, or
 *   says submarine cable, cable route, sjøkabel and the like);
 * - `priority`: `incident` (fault, cut, repair wording), `threat` (anchor,
 *   vessel, sabotage, investigation) or `mention`;
 * - `signal`: `clear` (show it), `doubt` (a local model may settle it) or
 *   `none`, with the `reason`;
 * - for a clear signal, `claim` (`fault` or `restored`), `breakConfirmed`
 *   and `cableIds`.
 * `source` is {id, sourceKind, cables: [catalogue IDs it speaks for]}. Give
 * `item` through datedNotice() first; a page item without a heading has
 * `titleKnown: false`. `now` rejects notices dated in the future.
 */
export function assessNotice({ item, source, names, now = Date.now() }) {
  const text = `${item.title ?? ''}\n${item.summary ?? ''}`;
  const folded = fold(text);
  const cables = cableMentions(text, names);
  const { cues } = claimCues(text);
  const threat = [
    ...new Set([...folded.slice(0, 4000).matchAll(THREAT)].map((m) => m[1])),
  ].sort();
  const redFlag = cables.length > 0 || SUBSEA.test(folded);
  const incident = Boolean(cues.fault || cues.break || cues.restored);
  const base = {
    redFlag,
    priority: !redFlag
      ? null
      : incident
        ? 'incident'
        : threat.length
          ? 'threat'
          : 'mention',
    cables,
    cues,
    threat,
  };
  if (!redFlag) return { ...base, signal: 'none', reason: 'not-about-cables' };
  if (!incident && !threat.length)
    return { ...base, signal: 'none', reason: 'no-incident-wording' };
  const remit = new Set(source.cables ?? []);
  const doubt = (reason) => ({ ...base, signal: 'doubt', reason });
  if (!PRIMARY.has(source.sourceKind) || item.offHost)
    return doubt('not-a-primary-source');
  if (!incident) return doubt('threat-wording-only');
  if (item.titleKnown === false) return doubt('no-title');
  const inTitle = cableMentions(item.title ?? '', names);
  if (!inTitle.length) return doubt('no-catalogue-cable-in-title');
  if (inTitle.length > 1) return doubt('several-cables-named');
  if (!remit.has(inTitle[0].cableId))
    return doubt('cable-outside-source-remit');
  const published = Date.parse(item.publishedAt ?? '');
  if (!Number.isFinite(published)) return doubt('undated');
  if (published > now + 24 * 3600_000) return doubt('dated-in-the-future');
  const judged = templateClaim(
    item.title ?? '',
    inTitle[0].name,
    new Date(published).getUTCFullYear(),
    item.summary ?? '',
  );
  if (judged.reason) return doubt(judged.reason);
  return {
    ...base,
    signal: 'clear',
    reason: null,
    claim: judged.claim,
    breakConfirmed: judged.breakConfirmed,
    cableIds: [inTitle[0].cableId],
  };
}

/** When a notice says it happened: its date if plausible, else when seen. */
export function noticeTime(item, seenAt) {
  const published = Date.parse(item.publishedAt ?? '');
  const seen = Date.parse(seenAt);
  return Number.isFinite(published) && published <= seen ? published : seen;
}

/**
 * Apply one clear signal to the shadow incidents ({[cableId]: incident}),
 * in time order. A cable has at most one incident at a time:
 * - A fault opens an incident on the cable, or updates the open one.
 * - A fault dated no later than the last close or fade belongs to that
 *   incident and changes nothing.
 * - A repair notice closes the open incident, unless it is dated before
 *   that incident began.
 * - With no incident open, a repair notice changes nothing.
 * Returns the new incidents and what an operator would have seen.
 */
export function applySignal(
  incidents,
  { cableId, claim, breakConfirmed, at, url, sourceId },
) {
  const next = { ...incidents };
  const current = next[cableId] ?? null;
  const open = current?.status === 'open' ? current : null;
  const when = new Date(at).toISOString();
  const ended = current?.closedAt ?? current?.fadedAt ?? null;
  if (claim === 'restored') {
    if (!open)
      return { incidents: next, change: 'restore-without-open-incident' };
    if (Date.parse(when) < Date.parse(open.openedAt))
      return { incidents: next, change: 'restore-before-incident' };
    next[cableId] = {
      ...open,
      status: 'closed',
      closedAt: when,
      breakConfirmed: open.breakConfirmed || breakConfirmed,
      sources: [...new Set([...open.sources, url])],
    };
    return { incidents: next, change: 'would-close' };
  }
  if (!open && ended && Date.parse(when) <= Date.parse(ended))
    return { incidents: next, change: 'late-report-of-ended-incident' };
  if (!open) {
    next[cableId] = {
      cableId,
      status: 'open',
      openedAt: when,
      lastReportedAt: when,
      breakConfirmed,
      sourceId,
      sources: [url],
    };
    return { incidents: next, change: 'would-show' };
  }
  next[cableId] = {
    ...open,
    openedAt: when < open.openedAt ? when : open.openedAt,
    lastReportedAt: when > open.lastReportedAt ? when : open.lastReportedAt,
    breakConfirmed: open.breakConfirmed || breakConfirmed,
    sources: [...new Set([...open.sources, url])],
  };
  return {
    incidents: next,
    change:
      breakConfirmed && !open.breakConfirmed
        ? 'would-confirm-break'
        : 'would-update',
  };
}

/**
 * Open incidents with no report for FAULT_FADE_MS fade: they were last
 * reported then, not proven repaired. Returns the new incidents and the IDs
 * that faded.
 */
export function fadeIncidents(incidents, now) {
  const next = { ...incidents };
  const faded = [];
  for (const [cableId, incident] of Object.entries(next)) {
    if (
      incident.status === 'open' &&
      now - Date.parse(incident.lastReportedAt) > FAULT_FADE_MS
    ) {
      next[cableId] = {
        ...incident,
        status: 'faded',
        fadedAt: new Date(now).toISOString(),
      };
      faded.push(cableId);
    }
  }
  return { incidents: next, faded };
}

/** A log line for the shadow log: what was seen and what would have happened. */
export function shadowLine({
  item,
  source,
  assessment,
  change = null,
  seenAt,
}) {
  return {
    seenAt,
    source: source.id,
    sourceKind: source.sourceKind,
    url: item.url,
    title: printable(item.title).slice(0, 300),
    priority: assessment.priority,
    signal: assessment.signal,
    reason: assessment.reason,
    cables: assessment.cables.map((c) => c.cableId),
    claim: assessment.claim ?? null,
    breakConfirmed: assessment.breakConfirmed ?? false,
    threat: assessment.threat,
    change,
  };
}

/**
 * Score the rules on labelled notices ({sourceId, title, summary, expected:
 * 'clear-fault' | 'clear-restored' | 'not-clear', breakConfirmed?}). A clear
 * signal is right only with the expected claim and break flag; anything else
 * clear is wrong.
 */
export function scoreLabelled({ notices, sources, names }) {
  const byId = new Map(sources.map((s) => [s.id, s]));
  const wrongClear = [];
  const missed = [];
  let expectedClear = 0;
  let rightClear = 0;
  let redFlags = 0;
  for (const notice of notices) {
    const source = byId.get(notice.sourceId);
    if (!source) throw new Error(`Unknown source ${notice.sourceId}`);
    const got = assessNotice({ item: datedNotice(notice), source, names });
    if (got.redFlag) redFlags += 1;
    const wanted = notice.expected;
    if (wanted !== 'not-clear') expectedClear += 1;
    if (got.signal === 'clear') {
      const right =
        wanted === `clear-${got.claim}` &&
        Boolean(notice.breakConfirmed) === got.breakConfirmed;
      if (right) rightClear += 1;
      else wrongClear.push({ title: notice.title, got: got.claim, wanted });
    } else if (wanted !== 'not-clear')
      missed.push({
        title: notice.title,
        reason: got.reason,
        synthetic: Boolean(notice.synthetic),
      });
  }
  return {
    total: notices.length,
    expectedClear,
    rightClear,
    wrongClear,
    missed,
    redFlags,
  };
}
