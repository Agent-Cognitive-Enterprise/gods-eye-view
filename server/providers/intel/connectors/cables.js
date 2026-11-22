// Submarine cable notices (fork). Off unless GEV_INTEL_CABLES=1. Polls
// operator, regulator and news sources and judges every new notice
// automatically (src/intel/cableSignals.js, and the local model for doubt:
// src/intel/cableAssessment.js). What would be shown, updated, closed or
// faded goes to cables-shadow.jsonl in the intel folder, beside the state it
// needs (cables-shadow-state.json). In shadow mode that is all. With
// GEV_INTEL_CABLES_LIVE=1 (phase 3) the confirmed incidents also go to the
// engine as records (src/intel/cableEvents.js); news never does. Reuse: each
// publisher's own terms; only titles, summaries and links are kept.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  articleText,
  canonicalUrl,
  fetchText,
  itemsFromFeed,
  itemsFromPage,
  pollIoda,
  sameSite,
} from '../cableInbox.js';
import {
  countryCodes,
  impactFor,
  landingCountries,
  landingPoints,
  mergeImpact,
} from '../../../../src/intel/cableImpact.js';
import {
  cableMentions,
  catalogueNames,
  printable,
} from '../../../../src/intel/cableInbox.js';
import {
  CABLE_PROMPT_VERSION,
  MAX_ARTICLE_CHARS,
  buildCablePrompt,
  cableAssessmentSchema,
  validateCableAssessment,
} from '../../../../src/intel/cableAssessment.js';
import {
  incidentIdOf,
  liveRecords,
} from '../../../../src/intel/cableEvents.js';
import { mergedCableFeatures } from '../../../../src/intel/cableRoutes.js';
import {
  STALE_NOTICE_MS,
  applySignal,
  assessNotice,
  datedNotice,
  fadeIncidents,
  noticeTime,
  shadowLine,
} from '../../../../src/intel/cableSignals.js';

const DATA = '../../../../src/data/local_data';
const LANDING_POINTS = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  `${DATA}/telegeography_submarine_cables/landing-point-geo.json`,
);
const COUNTRIES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  `${DATA}/natural_earth/countries.json`,
);
const CATALOGUE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../src/data/local_data/telegeography_submarine_cables/cable-geo.json',
);
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_SEEN = 20_000;
const MAX_LOG_BYTES = 5 * 1024 * 1024;

/**
 * The checked sources (2026-11-20; see tools/cable-incidents/README.md).
 * `vocabulary` are other capitalised words its notices use that name no
 * cable: the model check masks them with `speakers` and `places` before
 * looking for another cable in a quote.
 * `speakers` are the source's own names: the only words allowed before a
 * cable's name in a clear title, and `places` the only names a "between A
 * and B" clause may use. `cables` lists the catalogue cables a source
 * speaks for: an operator's own
 * cables, a regulator's cables in its country. A notice about any other
 * cable is never a clear signal from that source. WIOCC holds capacity on
 * EASSy, Equiano and 2Africa but does not run them, so it speaks for none.
 */
export const CABLE_SOURCES = Object.freeze([
  {
    id: 'cinia-news',
    places: ['Finland', 'Germany', 'Helsinki', 'Rostock'],
    speakers: ['Cinia', 'Cinia Oy'],
    // Other words its notices write with capitals that name no cable.
    vocabulary: [
      'Finnish',
      'German',
      'Swedish',
      'Sweden',
      'Gotland',
      'Öland',
      'Baltic Sea',
      'Gulf of Finland',
    ],
    format: 'rss',
    url: 'https://www.cinia.fi/en/news/rss.xml',
    sourceKind: 'operator',
    cables: ['c-lion1'],
  },
  {
    id: 'wiocc-news',
    speakers: ['WIOCC'],
    format: 'page',
    url: 'https://www.wiocc.net/news',
    pathPrefix: '/news/',
    sourceKind: 'operator',
    cables: [],
  },
  {
    id: 'space-norway',
    places: ['Norway', 'Svalbard', 'Longyearbyen'],
    speakers: ['Space Norway'],
    format: 'rss',
    url: 'https://spacenorway.com/feed/',
    sourceKind: 'operator',
    cables: ['svalbard-undersea-cable-system', 'arctic-way'],
  },
  {
    id: 'seaborn-news',
    places: ['Brazil', 'United States', 'US', 'USA'],
    speakers: ['Seaborn', 'Seaborn Networks'],
    format: 'rss',
    url: 'https://seabornnetworks.com/feed/',
    sourceKind: 'operator',
    cables: ['seabras-1'],
  },
  {
    id: 'tata-communications',
    speakers: ['Tata Communications', 'Tata'],
    format: 'rss',
    url: 'https://www.tatacommunications.com/press-release/rss.xml',
    sourceKind: 'operator',
    cables: [
      'tata-tgn-atlantic-south',
      'tata-tgn-gulf',
      'tata-tgn-intra-asia-tgn-ia',
      'tata-tgn-pacific',
      'tata-tgn-tata-indicom',
      'tata-tgn-western-europe',
    ],
  },
  {
    id: 'traficom-news',
    places: [
      'Finland',
      'Estonia',
      'Sweden',
      'Germany',
      'Helsinki',
      'Tallinn',
      'Stockholm',
    ],
    speakers: ['Traficom'],
    // The model check takes only a cable's own places after it: C-Lion1
    // "between Estonia and Sweden" is about another cable.
    cablePlaces: {
      'c-lion1': ['Finland', 'Germany', 'Helsinki', 'Rostock'],
      'eastern-light-sweden-finland-i': [
        'Sweden',
        'Finland',
        'Stockholm',
        'Helsinki',
      ],
      'eastern-light-sweden-finland-ii': [
        'Sweden',
        'Finland',
        'Stockholm',
        'Helsinki',
      ],
      'finland-estonia-2-eesf-2': ['Finland', 'Estonia', 'Helsinki', 'Tallinn'],
      'finland-estonia-3-eesf-3': ['Finland', 'Estonia', 'Helsinki', 'Tallinn'],
      'finland-estonia-connection-1-fec-1': [
        'Finland',
        'Estonia',
        'Helsinki',
        'Tallinn',
      ],
      'finland-estonia-connection-2-fec-2': [
        'Finland',
        'Estonia',
        'Helsinki',
        'Tallinn',
      ],
    },
    format: 'page',
    url: 'https://www.traficom.fi/en/newsroom',
    pathPrefix: '/en/news/',
    sourceKind: 'authority',
    cables: [
      'c-lion1',
      'eastern-light-sweden-finland-i',
      'eastern-light-sweden-finland-ii',
      'finland-estonia-2-eesf-2',
      'finland-estonia-3-eesf-3',
      'finland-estonia-connection-1-fec-1',
      'finland-estonia-connection-2-fec-2',
    ],
  },
  {
    id: 'nkom-news',
    places: ['Norway', 'Svalbard', 'Longyearbyen'],
    speakers: ['Nkom'],
    format: 'page',
    url: 'https://nkom.no/aktuelt',
    pathPrefix: '/aktuelt/',
    sourceKind: 'authority',
    cables: ['svalbard-undersea-cable-system', 'arctic-way'],
  },
  {
    id: 'subtel-forum',
    speakers: ['SubTel Forum'],
    format: 'rss',
    url: 'https://subtelforum.com/feed/',
    sourceKind: 'news',
    cables: [],
  },
  // Checked 2026-11-21, after the SEA-ME-WE 5 fault off Pakistan
  // (2026-11-18) reached none of the sources above. Transworld lands
  // SEA-ME-WE 5 in Pakistan and runs TW1; its feed is mostly marketing.
  {
    id: 'transworld',
    places: ['Pakistan', 'Karachi', 'Oman', 'UAE'],
    speakers: [
      'Transworld',
      'Transworld Associates',
      'Transworld Associates (Pvt) Ltd',
      'TWA',
    ],
    vocabulary: [
      'Pakistani',
      'Gwadar',
      'Arabian Sea',
      'PTA',
      'Pakistan Telecommunication Authority',
    ],
    format: 'rss',
    url: 'https://www.tw1.com/feed/',
    sourceKind: 'operator',
    cables: ['transworld-tw1', 'seamewe-5'],
    // One landing party of a consortium cable: its fault notices count,
    // but its repair notice cannot close the whole cable's incident.
    consortium: ['seamewe-5'],
  },
  // News from Pakistan, the Gulf and the Red Sea: leads only.
  {
    id: 'dawn-news',
    speakers: ['Dawn'],
    format: 'rss',
    url: 'https://www.dawn.com/feeds/home',
    sourceKind: 'news',
    cables: [],
  },
  {
    id: 'propakistani',
    speakers: ['ProPakistani'],
    format: 'rss',
    url: 'https://propakistani.pk/feed/',
    sourceKind: 'news',
    cables: [],
  },
  {
    id: 'telecom-review',
    speakers: ['Telecom Review'],
    format: 'rss',
    url: 'https://www.telecomreview.com/feed/',
    sourceKind: 'news',
    cables: [],
  },
  {
    id: 'arab-news',
    speakers: ['Arab News'],
    format: 'rss',
    url: 'https://www.arabnews.com/rss.xml',
    sourceKind: 'news',
    cables: [],
  },
  {
    id: 'gulf-news',
    speakers: ['Gulf News'],
    format: 'rss',
    url: 'https://gulfnews.com/stories.rss',
    sourceKind: 'news',
    cables: [],
  },
]);

/** Saved state: notices seen, sources with a baseline, shadow incidents. */
const isObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Saved state, or a fresh one. A file that cannot be read as a state is
 * moved aside (cables-shadow-state.json.corrupt-<time>) and reported in
 * `reset`, so lost incidents are visible in the log, never silent.
 */
export function readShadowState(file, now = Date.now()) {
  const fresh = { version: 1, seen: {}, baselines: {}, incidents: {} };
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return fresh;
  }
  try {
    const state = JSON.parse(text);
    if (
      state?.version === 1 &&
      isObject(state.seen) &&
      isObject(state.baselines) &&
      isObject(state.incidents)
    )
      return state;
  } catch {
    // Not JSON: handled below.
  }
  const aside = `${file}.corrupt-${now}`;
  try {
    fs.renameSync(file, aside);
  } catch {
    // Left in place: it is overwritten by the next save.
  }
  return { ...fresh, reset: aside };
}

/** Write beside the target, then rename: crash-recoverable, not atomically visible. */
function writeJson(file, value) {
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value));
  fs.renameSync(temp, file);
}

function appendLines(file, lines) {
  if (!lines.length) return;
  try {
    if (fs.statSync(file).size > MAX_LOG_BYTES)
      fs.renameSync(file, `${file}.1`);
  } catch {
    // No log yet.
  }
  fs.appendFileSync(
    file,
    lines.map((line) => `${JSON.stringify(line)}\n`).join(''),
  );
}

/** Keep the newest MAX_SEEN notice URLs. */
function trimSeen(seen) {
  const entries = Object.entries(seen);
  if (entries.length <= MAX_SEEN) return seen;
  entries.sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return Object.fromEntries(entries.slice(-MAX_SEEN));
}

/**
 * One poll of every source, judged and recorded. Pure apart from the
 * injected fetch: takes and returns the state, plus the log lines.
 */
export async function pollCableSources({
  sources,
  state,
  names,
  fetchImpl,
  now,
}) {
  const seenAt = new Date(now()).toISOString();
  const next = structuredClone(state);
  const lines = state.reset
    ? [{ seenAt, change: 'state-reset', movedTo: state.reset }]
    : [];
  delete next.reset;
  const errors = [];
  let latest = 0;
  const primaryIds = new Set(
    sources.filter((s) => PRIMARY_KINDS.has(s.sourceKind)).map((s) => s.id),
  );
  for (const source of sources) {
    let items;
    try {
      const fetched = await fetchText(source.url, {
        fetchImpl,
        maxBytes: MAX_SOURCE_BYTES,
        accept:
          source.format === 'rss'
            ? 'application/rss+xml, application/atom+xml, application/xml, text/xml'
            : 'text/html',
      });
      items =
        source.format === 'rss'
          ? itemsFromFeed(fetched.text, fetched.url)
          : itemsFromPage(fetched.text, fetched.url, source.pathPrefix);
    } catch (error) {
      errors.push(
        `${source.id}: ${String(error?.message ?? error).slice(0, 120)}`,
      );
      continue;
    }
    // Listing pages carry their date in front of the title.
    const fresh = items
      .filter((item) => !Object.hasOwn(next.seen, item.url))
      .map(datedNotice);
    for (const item of fresh) next.seen[item.url] = seenAt;
    // The first poll that lists notices only records them: old news is
    // not a new signal.
    if (!Object.hasOwn(next.baselines, source.id)) {
      if (items.length) next.baselines[source.id] = seenAt;
      continue;
    }
    // Oldest first, a fault before a repair at the same time.
    const judged = fresh
      .map((item) => ({
        item,
        at: noticeTime(item, seenAt),
        assessment: assessNotice({ item, source, names, now: now() }),
      }))
      .sort(
        (a, b) =>
          a.at - b.at ||
          (a.assessment.claim === 'restored') -
            (b.assessment.claim === 'restored'),
      );
    for (const { item, at, assessment: judgedNow } of judged) {
      latest = Math.max(latest, at);
      let assessment = judgedNow;
      if (!assessment.redFlag) continue;
      // Old news under a new address is not a new signal.
      if (
        assessment.signal === 'clear' &&
        Date.parse(seenAt) - at > STALE_NOTICE_MS
      )
        assessment = { ...assessment, signal: 'doubt', reason: 'stale-notice' };
      if (assessment.signal !== 'clear') {
        lines.push(shadowLine({ item, source, assessment, seenAt }));
        // Doubt that names a cable waits for the local model (phase 2). So
        // does an operator's or regulator's incident wording that names
        // none ("International submarine cable develops fault: PTA"): its
        // article may name the cable. News that names no cable does not:
        // general news says "cable fault" of power cuts all the time.
        const primary = PRIMARY_KINDS.has(source.sourceKind) && !item.offHost;
        if (
          assessment.signal === 'doubt' &&
          (assessment.cables.length ||
            (primary && assessment.priority === 'incident'))
        )
          queueForModel(
            next,
            { item, sourceId: source.id, seenAt, at, primary },
            primaryIds,
          );
        continue;
      }
      for (const cableId of assessment.cableIds) {
        const applied = applySignal(next.incidents, {
          cableId,
          claim: assessment.claim,
          breakConfirmed: assessment.breakConfirmed,
          at,
          url: item.url,
          sourceId: source.id,
        });
        next.incidents = applied.incidents;
        lines.push(
          shadowLine({
            item,
            source,
            assessment,
            change: applied.change,
            seenAt,
          }),
        );
      }
    }
  }
  const { incidents, faded } = fadeIncidents(next.incidents, now());
  next.incidents = incidents;
  for (const cableId of faded)
    lines.push({ seenAt, change: 'would-fade', cables: [cableId] });
  next.seen = trimSeen(next.seen);
  return { state: next, lines, errors, latest };
}

const PRIMARY_KINDS = new Set(['operator', 'authority']);
const MAX_PENDING = 200;
const MAX_ATTEMPTS = 3;
const MAX_MODEL_CHECKS_PER_POLL = 3;
// Articles fetched per poll, whether the model then reads them or not.
const MAX_FETCHES_PER_POLL = 5;
const MAX_MODEL_CHECKS_PER_HOUR = 12;
const HOUR_MS = 3600_000;

/**
 * Keep a doubtful notice for the model. When the queue is full the oldest
 * news goes first, and an operator's or regulator's notice only when
 * nothing else is left.
 */
function queueForModel(
  state,
  { item, sourceId, seenAt, at, primary },
  primaryIds = new Set(),
) {
  state.pending ??= [];
  if (state.pending.some((p) => p.item.url === item.url)) return;
  state.pending.push({ item, sourceId, seenAt, at, primary, attempts: 0 });
  // Entries saved before `primary` was kept: judged by their source.
  const isPrimary = (p) =>
    p.primary ?? (primaryIds.has(p.sourceId) && !p.item?.offHost);
  while (state.pending.length > MAX_PENDING) {
    const news = state.pending.findIndex((p) => !isPrimary(p));
    state.pending.splice(news >= 0 ? news : 0, 1);
  }
}

/**
 * Phase 2: let the local model read queued doubtful notices, a few per poll
 * and under an hourly cap. It runs only while the model is online and idle
 * and no one is talking to it (voice). A primary source's confirmed notice
 * updates the shadow incidents; anything else is only logged. Returns the
 * new state and the log lines. A busy or failing model leaves the queue
 * for the next poll.
 */
export async function checkWithModel({
  state,
  sources,
  names,
  llm,
  fetchImpl,
  now,
  foreground = () => false,
}) {
  const next = structuredClone(state);
  const lines = [];
  next.pending ??= [];
  next.modelChecks = (next.modelChecks ?? []).filter(
    (t) => now() - t < HOUR_MS,
  );
  if (!llm || !next.pending.length) return { state: next, lines };
  const byId = new Map(sources.map((s) => [s.id, s]));
  let checked = 0;
  let fetched = 0;
  while (next.pending.length && checked < MAX_MODEL_CHECKS_PER_POLL) {
    if (next.modelChecks.length >= MAX_MODEL_CHECKS_PER_HOUR) break;
    if (fetched >= MAX_FETCHES_PER_POLL) break;
    if (foreground()) break;
    if (llm.status().status !== 'online') await llm.probe();
    if (llm.status().status !== 'online') break;
    if (await llm.busy()) break;
    // Operators and regulators first: a news source can only ever give an
    // unverified report, so it must not use up their checks.
    const primaryAt = next.pending.findIndex((p) =>
      PRIMARY_KINDS.has(byId.get(p.sourceId)?.sourceKind),
    );
    const index = primaryAt >= 0 ? primaryAt : 0;
    const entry = next.pending[index];
    const take = () => next.pending.splice(index, 1);
    const source = byId.get(entry.sourceId);
    const base = {
      seenAt: new Date(now()).toISOString(),
      source: entry.sourceId,
      url: entry.item.url,
      title: printable(entry.item.title).slice(0, 300),
    };
    // Old news is not a new signal, model or not.
    if (!source || now() - entry.at > STALE_NOTICE_MS) {
      take();
      lines.push({ ...base, signal: 'llm-skipped', reason: 'stale-notice' });
      continue;
    }
    // The article itself, from the publisher's own site only: a redirect
    // elsewhere leaves title and summary.
    let article = '';
    if (!entry.item.offHost)
      try {
        fetched += 1;
        const page = await fetchText(entry.item.url, {
          fetchImpl,
          maxBytes: MAX_SOURCE_BYTES,
          accept: 'text/html',
        });
        if (sameSite(page.url, source.url))
          article = articleText(page.text, MAX_ARTICLE_CHARS);
      } catch {
        // Title and summary only.
      }
    const notice = {
      title: entry.item.title,
      summary: entry.item.summary,
      offHost: entry.item.offHost,
      publishedAt: entry.item.publishedAt ?? null,
    };
    const named = cableMentions(
      [notice.title, notice.summary, article].join('\n'),
      names,
    );
    // Each named cable with all of its catalogue names, so a cable
    // mentioned by another of its names still counts as another cable.
    const cables = [...new Set(named.map((c) => c.cableId))].map((cableId) => ({
      cableId,
      name: named.find((c) => c.cableId === cableId).name,
      aliases: names.filter((n) => n.cableId === cableId).map((n) => n.name),
    }));
    if (!cables.length) {
      take();
      lines.push({ ...base, signal: 'llm-skipped', reason: 'no-cable-named' });
      continue;
    }
    const today = base.seenAt.slice(0, 10);
    let reply;
    try {
      next.modelChecks.push(now());
      checked += 1;
      reply = await llm.complete(
        buildCablePrompt({ notice, source, cables, today, article }),
        cableAssessmentSchema(cables.map((c) => c.cableId)),
      );
    } catch (error) {
      // Losing the race to another user of the model is not a failure.
      if (/busy/.test(String(error?.message ?? ''))) {
        next.modelChecks.pop();
        break;
      }
      entry.attempts += 1;
      if (entry.attempts >= MAX_ATTEMPTS) {
        take();
        lines.push({
          ...base,
          signal: 'llm-skipped',
          reason: `model-failed: ${String(error?.message ?? error).slice(0, 80)}`,
        });
      }
      break;
    }
    take();
    const verdict = validateCableAssessment(reply?.text ?? '', {
      notice,
      article,
      source,
      cables,
      now: now(),
      catalogue: names,
    });
    const line = {
      ...base,
      signal: verdict.signal,
      reason: verdict.reason ?? verdict.limitedBy ?? null,
      cables: verdict.cableId
        ? [verdict.cableId]
        : cables.map((c) => c.cableId),
      claim: verdict.claim ?? null,
      breakConfirmed: verdict.breakConfirmed ?? false,
      quote: verdict.quote ?? null,
      model: llm.status().model ?? null,
      promptVersion: CABLE_PROMPT_VERSION,
      latencyMs: reply?.latencyMs ?? null,
      change: null,
    };
    if (verdict.signal === 'llm-clear') {
      // The date the sentence states comes first, for a repair too: a
      // repair dated before the fault opened closes nothing. Otherwise a
      // fault dates from when it began, a repair from its notice (the
      // model's start date for a repair is the fault's).
      const started = verdict.statedOn
        ? Date.parse(`${verdict.statedOn}T00:00:00Z`)
        : verdict.claim !== 'restored' && verdict.startedOn
          ? Date.parse(`${verdict.startedOn}T00:00:00Z`)
          : entry.at;
      const applied = applySignal(next.incidents, {
        cableId: verdict.cableId,
        claim: verdict.claim,
        breakConfirmed: verdict.breakConfirmed,
        at: Math.min(started, now()),
        url: entry.item.url,
        sourceId: entry.sourceId,
      });
      next.incidents = applied.incidents;
      line.change = applied.change;
    }
    lines.push(line);
  }
  return { state: next, lines };
}

/**
 * What was sent to Autopilot per cable, or {} (a file that cannot be read
 * as that is moved aside: the events it sent then expire by themselves).
 */
function readPublished(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return {};
  }
  try {
    const value = JSON.parse(text);
    if (isObject(value) && Object.values(value).every(isObject)) return value;
  } catch {
    // Not JSON: handled below.
  }
  try {
    fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
  } catch {
    // Left in place: it is overwritten by the next send.
  }
  return {};
}

const IODA_EVERY_MS = 3 * 3600_000;
const IODA_MAX_HOURS = 7 * 24;

/**
 * Phase 4: IODA's country outages beside the open incidents, at most once
 * every three hours and only while one is open. Impact is kept per incident
 * and only grows while it lasts (IODA's window is shorter than an
 * incident); a new incident on the cable starts bare. Returns the new state
 * and log lines; a failing IODA keeps the last impact and is logged.
 */
export async function checkImpact({
  state,
  countriesOf,
  fetchImpl,
  now,
  poll = pollIoda,
}) {
  const next = structuredClone(state);
  const lines = [];
  const open = Object.entries(next.incidents ?? {}).filter(
    ([, incident]) =>
      incident?.status === 'open' &&
      Number.isFinite(Date.parse(incident.openedAt ?? '')),
  );
  // Only the open incidents' own impact is kept.
  const kept = {};
  for (const [cableId, incident] of open) {
    const held = next.impact?.[cableId];
    if (held?.incidentId === incidentIdOf(incident))
      kept[cableId] = {
        incidentId: held.incidentId,
        entries: mergeImpact([], held.entries),
      };
  }
  next.impact = kept;
  if (!open.length) {
    delete next.impact;
    return { state: next, lines };
  }
  // A check in the last three hours (a time in the future counts as none).
  const age = now() - Date.parse(next.iodaCheckedAt ?? '');
  if (Number.isFinite(age) && age >= 0 && age < IODA_EVERY_MS)
    return { state: next, lines };
  const earliest = Math.min(
    ...open.map(([, incident]) => Date.parse(incident.openedAt)),
  );
  const hours = Math.min(
    IODA_MAX_HOURS,
    Math.max(24, Math.ceil((now() - earliest) / 3600_000) + 24),
  );
  const seenAt = new Date(now()).toISOString();
  next.iodaCheckedAt = seenAt;
  let outages;
  try {
    ({ outages } = await poll({ fetchImpl, now, hours }));
  } catch (error) {
    lines.push({
      seenAt,
      change: 'ioda-failed',
      error: String(error?.message ?? error).slice(0, 120),
    });
    return { state: next, lines };
  }
  const before = JSON.stringify(next.impact);
  for (const [cableId, incident] of open) {
    const found = impactFor({
      incident,
      countries: countriesOf(cableId),
      outages,
      now: now(),
    });
    const entries = mergeImpact(next.impact[cableId]?.entries, found);
    if (entries.length)
      next.impact[cableId] = { incidentId: incidentIdOf(incident), entries };
  }
  if (JSON.stringify(next.impact) !== before)
    lines.push({
      seenAt,
      change: 'ioda-impact',
      cables: Object.keys(next.impact),
      countries: Object.fromEntries(
        Object.entries(next.impact).map(([id, held]) => [
          id,
          held.entries.map((entry) => entry.country),
        ]),
      ),
    });
  return { state: next, lines };
}

/** A source's name for a record: its publisher, else its first speaker. */
const publisherOf = (sources) => (id) => {
  const source = sources.find((s) => s.id === id);
  return source?.publisher ?? source?.speakers?.[0] ?? id ?? null;
};

/**
 * The Autopilot connector. In shadow mode poll() returns no records, so
 * nothing reaches the engine, the map or the camera. With `live`, it
 * returns a record each time a confirmed incident opens, changes or closes;
 * the runner calls commit() once they are stored, and only then is the
 * incident marked as sent (a failed store sends it again).
 */
export function cableConnector({
  dir,
  sources = CABLE_SOURCES,
  fetchImpl = (...args) => globalThis.fetch(...args),
  intervalMs = 60 * 60_000,
  // Phase 2: the shared local model, or null to judge by the rules alone.
  llm = null,
  foreground = () => false,
  // Phase 3: confirmed incidents go to the engine.
  live = false,
  // Phase 4: IODA country outages beside live incidents (off by default:
  // IODA's data-use terms are not settled).
  ioda = false,
} = {}) {
  if (!dir) throw new Error('cableConnector needs the intel folder');
  for (const source of sources)
    if (!canonicalUrl(source.url))
      throw new Error(`${source.id}: url must be HTTPS`);
  const stateFile = path.join(dir, 'cables-shadow-state.json');
  const logFile = path.join(dir, 'cables-shadow.jsonl');
  // What was sent to Autopilot, kept apart from the shadow state so a reset
  // of that state cannot lose it.
  const publishedFile = path.join(dir, 'cables-published.json');
  let names = null;
  let features = null;
  let countriesOf = null;
  return {
    id: 'submarine-cables',
    provider: 'cables',
    url: sources[0]?.url,
    intervalMs,
    // Operators post a few notices a month.
    staleAfterMs: 60 * 24 * 3600_000,
    license: "Each publisher's own terms",
    attribution: 'Cable operators and regulators (see the cable feed sources)',
    shadow: !live,
    async poll({ now }) {
      if (!names) {
        const catalogue = JSON.parse(fs.readFileSync(CATALOGUE, 'utf8'));
        names = catalogueNames(catalogue);
        features = mergedCableFeatures(catalogue);
        if (ioda) {
          const points = landingPoints(
            JSON.parse(fs.readFileSync(LANDING_POINTS, 'utf8')),
            countryCodes(JSON.parse(fs.readFileSync(COUNTRIES, 'utf8'))),
          );
          const cache = new Map();
          countriesOf = (cableId) => {
            if (!cache.has(cableId))
              cache.set(
                cableId,
                landingCountries(features.get(cableId), points),
              );
            return cache.get(cableId);
          };
        }
      }
      fs.mkdirSync(dir, { recursive: true });
      const result = await pollCableSources({
        sources,
        state: readShadowState(stateFile, now()),
        names,
        fetchImpl,
        now,
      });
      // Every source failing is a failed poll; some failing is logged.
      if (result.errors.length === sources.length)
        throw new Error(`all cable sources failed (${result.errors[0]})`);
      writeJson(stateFile, result.state);
      appendLines(
        logFile,
        result.errors.length
          ? [
              ...result.lines,
              { seenAt: new Date(now()).toISOString(), errors: result.errors },
            ]
          : result.lines,
      );
      // The saved state already holds this poll; the model's turn comes
      // after, so a slow or failing model never loses a poll.
      const checked = await checkWithModel({
        state: result.state,
        sources,
        names,
        llm,
        fetchImpl,
        now,
        foreground,
      });
      writeJson(stateFile, checked.state);
      appendLines(logFile, checked.lines);
      if (!live)
        return { records: [], latestObservationAt: result.latest || undefined };
      let { state } = checked;
      if (ioda) {
        const impact = await checkImpact({
          state,
          countriesOf,
          fetchImpl,
          now,
        });
        state = impact.state;
        writeJson(stateFile, state);
        appendLines(logFile, impact.lines);
      }
      const published = readPublished(publishedFile);
      const { records, keys } = liveRecords({
        incidents: state.incidents,
        published,
        features,
        publisherOf: publisherOf(sources),
        impact: ioda ? (state.impact ?? {}) : {},
      });
      return {
        records,
        notModified: records.length === 0,
        latestObservationAt: result.latest || undefined,
        // Marked as sent only once the runner has stored the records.
        commit: () => {
          if (!Object.keys(keys).length) return;
          writeJson(publishedFile, {
            ...readPublished(publishedFile),
            ...keys,
          });
          appendLines(
            logFile,
            records.map((record) => ({
              seenAt: new Date(now()).toISOString(),
              change: 'sent-to-autopilot',
              cables: record.entities.map((e) => e.replace(/^cable:/, '')),
              status: record.status_hint,
              title: record.title,
            })),
          );
        },
      };
    },
  };
}
