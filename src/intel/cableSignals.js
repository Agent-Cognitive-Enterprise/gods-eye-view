// Automatic submarine cable signals: which notices are red flags, which are
// clear enough to show without a person, and the incident each one opens,
// updates, closes or lets fade. Pure: no fetching, no clock, no storage.
//
// A clear signal needs a primary source speaking for one of its own cables,
// exact catalogue cable names, incident wording and nothing doubtful. Anything
// else that looks like an incident is "doubt": a local model may settle it
// (phase 2); without one it is dropped. Traffic data is never a cable signal.

import { cableMentions, claimCues, printable } from './cableInbox.js';

const PRIMARY = new Set(['operator', 'authority']);
// A notice about submarine cables, named or not, in English or the Nordic
// and German words the configured regulators use.
const SUBSEA =
  /\b(?:submarine|subsea|undersea|sea|offshore)[- ]?cables?\b|\bcables? (?:routes?|systems?|landings?|ships?|repairs?|cuts?|faults?|damage|breaks?)\b|sjøkab|sjökab|merikaapel|seekabel|undervannskab|havkab|merenalai/;
const THREAT =
  /\b(anchors?|anchor[- ]dragg\w*|dragg(?:ed|ing)|vessels?|ships?|trawl\w*|sabotage\w*|investigat\w*|police|navy|naval|coast ?guard|suspect\w*|tamper\w*|espionage|seiz\w*|detain\w*)\b/g;
// Words that state a physical break, not only a fault.
const PHYSICAL = new Set([
  'cut',
  'cuts',
  'severed',
  'broken',
  'break',
  'breaks',
  'breakage',
]);
export const FAULT_FADE_MS = 30 * 24 * 3600_000;

const fold = (text) =>
  String(text ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'");

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
 * `source` is {id, sourceKind, cables: [catalogue IDs it speaks for]}.
 */
export function assessNotice({ item, source, names }) {
  const text = `${item.title ?? ''}\n${item.summary ?? ''}`;
  const folded = fold(text);
  const cables = cableMentions(text, names);
  const { suggestedClaim, cues } = claimCues(text);
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
  if (cables.some((c) => !remit.has(c.cableId)))
    return doubt('cable-outside-source-remit');
  if (cues.doubt || !suggestedClaim) return doubt('doubtful-wording');
  return {
    ...base,
    signal: 'clear',
    reason: null,
    claim: suggestedClaim,
    breakConfirmed: (cues.break ?? []).some((word) => PHYSICAL.has(word)),
    cableIds: cables.map((c) => c.cableId),
  };
}

/** When a notice says it happened: its date if plausible, else when seen. */
export function noticeTime(item, seenAt) {
  const published = Date.parse(item.publishedAt ?? '');
  const seen = Date.parse(seenAt);
  return Number.isFinite(published) && published <= seen ? published : seen;
}

/**
 * Apply one clear signal to the shadow incidents ({[cableId]: incident}).
 * A fault opens an incident on the cable, or updates the open one. A repair
 * notice closes the open one; with none open it changes nothing. Returns the
 * new incidents and what an operator would have seen.
 */
export function applySignal(
  incidents,
  { cableId, claim, breakConfirmed, at, url, sourceId },
) {
  const next = { ...incidents };
  const open = next[cableId]?.status === 'open' ? next[cableId] : null;
  const when = new Date(at).toISOString();
  if (claim === 'restored') {
    if (!open)
      return { incidents: next, change: 'restore-without-open-incident' };
    next[cableId] = {
      ...open,
      status: 'closed',
      closedAt: when,
      breakConfirmed: open.breakConfirmed || breakConfirmed,
      sources: [...new Set([...open.sources, url])],
    };
    return { incidents: next, change: 'would-close' };
  }
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
    const got = assessNotice({ item: notice, source, names });
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
      missed.push({ title: notice.title, reason: got.reason });
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
