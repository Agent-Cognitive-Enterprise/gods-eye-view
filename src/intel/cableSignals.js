// Automatic submarine cable signals: which notices are red flags, which are
// clear enough to show without a person, and the incident each one opens,
// updates, closes or lets fade. Pure: no fetching, no clock, no storage.
//
// A clear signal needs all of these:
// - a primary source speaking for its own cable;
// - exactly one catalogue cable named;
// - a dated notice;
// - wording that matches a strict incident template ("fault detected in",
//   "a fault in", "cable cut", "has been repaired");
// - nothing that makes it doubtful: a negation, future or hypothetical
//   wording, maintenance, drills, business news, an anniversary, another
//   cable, a question.
// Anything else that looks like an incident is "doubt": a local model may
// settle it (phase 2), and without one it is dropped. A wrong clear signal
// would reach the map with nobody to stop it, so the templates are narrow
// on purpose. Traffic data is never a cable signal.

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

const INCIDENT =
  '(?:faults?|disturbances?|outages?|damage|interruptions?|failures?|cuts?|breaks?)';
// Fault templates: "fault detected", "a fault in …", "… cable cut".
const FAULT_TEMPLATES = [
  new RegExp(
    `\\b${INCIDENT} (?:has been |have been |was |were |is |are )?(?:detected|found|occurred|reported|identified|located|discovered)\\b`,
  ),
  new RegExp(
    `^(?:an? |the |some )?${INCIDENT} (?:in|on|to|of|affecting|at)\\b`,
  ),
  /\bcables? (?:has been |have been |was |were |is |are )?(?:cut|severed|damaged|broken|down|out of service|interrupted)\b/,
  // "EASSy cable outage", "C-Lion1 cable fault".
  // One incident on one cable: singular, ending the phrase. "Subsea cable
  // faults" (plural, a topic) is not one.
  /\bcable (?:fault|outage|disturbance|failure|interruption|damage|cut|break)(?:$|[:;,.]| (?:on|in|at|between|near|off|affecting)\b)/,
  // "Svalbard Undersea Cable System: fault", once the name is taken off.
  new RegExp(`^${INCIDENT}$`),
  new RegExp(`: ${INCIDENT}$`),
];
// Repair templates: the cable is back, stated as done.
const RESTORE_TEMPLATES = [
  /\b(?:has been |have been |was |were |is now |are now |has |have )?(?:fully )?(?:repaired|restored)\b/,
  /\bback (?:in|into) (?:service|operation)\b|\bback online\b|\brepair work (?:has been |was )?completed\b/,
];
// Any of these makes a notice doubtful. Each comes from a wrong clear
// signal found in review ("No fault found", "Planned maintenance …
// interruptions expected", "Cinia cuts latency", "One year since the cut").
const BLOCKERS = [
  // Negation and denial.
  /\b(?:no|not|none|never|nothing|without|zero|unaffected|unharmed|intact|normal|normally|deny|denies|denied|false|unfounded|rumou?rs?|hoax|untrue|ei)\b|n't\b|-free\b|\bfree of\b|\btolerant\b/,
  // Future, plans, conditions and questions.
  /(?<!\d )\bmay\b(?! \d)|\b(?:will|would|shall|might|could|can|should|must|to be|to start|expected|expects?|planned|plans?|scheduled|upcoming|soon|once|until|awaits?|awaiting|delayed|pending|if|whether|what|how|why|in case)\b|\?/,
  // Not confirmed.
  /\b(?:suspected|possible|possibly|potential|likely|reportedly|reports? of|alleged|allegedly|investigat\w*|probe)\b/,
  // Not an incident notice: maintenance, drills, history, business.
  /\b(?:maintenance|upgrade\w*|drills?|exercises?|simulat\w*|test(?:s|ed|ing)?|preparedness|readiness|prepar\w*|anniversary|celebrat\w*|years?|since|ago|last|lessons|looking back|history|reports?|results?|revenue|q[1-4]|quarter\w*|latency|awards?|wins?|contracts?|agreements?|signs?|mou|partner\w*|joins?|projects?|build\w*|construct\w*|routes?|ring|launch\w*|announc\w*|courts?|convict\w*|charges?|captain|minister|uptime|standby|resilien\w*|protect\w*|risks?|redundan\w*|prevent\w*|avoid\w*|helps?|customers?|capacity|demand|data cent\w*|fibre network|fiber network|lay|laying)\b/,
  // Another cable or another kind of line in the same notice.
  /\b(?:another|other|second|again|involved|belongs?|power cables?|power lines?|pipelines?|gas|electricity|interconnectors?)\b/,
];
const PHYSICAL = /\b(?:cut|cuts|severed|broken|break|breaks|breakage)\b/;

const fold = (text) =>
  String(text ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'");

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

/**
 * A listing page puts the date in front of the title ("18.11.2024 A fault
 * in…", "August 14, 2024 WIOCC…"). Returns the item with that date as
 * `publishedAt` (UTC midnight) when it had none, and the date removed from
 * the title.
 */
export function datedNotice(item) {
  const title = String(item.title ?? '').trim();
  for (const [pattern, parts] of LEADING_DATES) {
    const m = pattern.exec(title);
    if (!m) continue;
    const [y, mo, d] = parts(m).map(Number);
    const time = Date.UTC(y, mo - 1, d);
    const back = new Date(time);
    if (
      back.getUTCFullYear() !== y ||
      back.getUTCMonth() !== mo - 1 ||
      back.getUTCDate() !== d
    )
      break;
    return {
      ...item,
      title: title.slice(m[0].length),
      publishedAt: item.publishedAt ?? back.toISOString(),
    };
  }
  return item;
}

/**
 * The claim a notice states by a strict template, or why it does not:
 * {claim, breakConfirmed} or {reason}.
 */
export function templateClaim(text, noticeYear) {
  // A leading "Cinia:" or "Traficom:" names the speaker, not the event.
  const folded = fold(text).replace(/^[\p{L}\p{N} .&'-]{1,40}: /u, '');
  if (BLOCKERS.some((pattern) => pattern.test(folded)))
    return { reason: 'doubtful-wording' };
  // A year other than the notice's own, or the one before, is history.
  for (const m of folded.matchAll(/\b(19\d\d|20\d\d)\b/g)) {
    const year = Number(m[1]);
    if (year > noticeYear || year < noticeYear - 1)
      return { reason: 'doubtful-wording' };
  }
  const fault = FAULT_TEMPLATES.some((pattern) => pattern.test(folded));
  const restored = RESTORE_TEMPLATES.some((pattern) => pattern.test(folded));
  if (fault && restored) return { reason: 'fault-and-repair-wording' };
  if (!fault && !restored) return { reason: 'no-incident-template' };
  return {
    claim: restored ? 'restored' : 'fault',
    breakConfirmed: PHYSICAL.test(folded),
  };
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
 *   (the notice says cut, severed, broken or break) and `cableIds`.
 * `source` is {id, sourceKind, cables: [catalogue IDs it speaks for]}. Give
 * `item` through datedNotice() first.
 */
export function assessNotice({ item, source, names }) {
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
  if (!cables.length) return doubt('no-catalogue-cable-named');
  if (cables.length > 1) return doubt('several-cables-named');
  if (!remit.has(cables[0].cableId)) return doubt('cable-outside-source-remit');
  const published = Date.parse(item.publishedAt ?? '');
  if (!Number.isFinite(published)) return doubt('undated');
  const judged = templateClaim(
    `${item.title ?? ''} ${item.summary ?? ''}`.trim(),
    new Date(published).getUTCFullYear(),
  );
  if (judged.reason) return doubt(judged.reason);
  return {
    ...base,
    signal: 'clear',
    reason: null,
    claim: judged.claim,
    breakConfirmed: judged.breakConfirmed,
    cableIds: [cables[0].cableId],
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
