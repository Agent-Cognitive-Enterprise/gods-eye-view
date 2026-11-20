// Submarine cable notices (fork), phase 1: shadow mode. Off unless
// GEV_INTEL_CABLES=1. Polls operator, regulator and news sources and judges
// every new notice automatically (src/intel/cableSignals.js), but sends
// nothing to the engine: what would have been shown, updated, closed or
// faded goes to cables-shadow.jsonl in the intel folder, beside the state it
// needs (cables-shadow-state.json). Reuse: each publisher's own terms; only
// titles, summaries and links are kept.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  articleText,
  canonicalUrl,
  fetchText,
  itemsFromFeed,
  itemsFromPage,
} from '../cableInbox.js';
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
  STALE_NOTICE_MS,
  applySignal,
  assessNotice,
  datedNotice,
  fadeIncidents,
  noticeTime,
  shadowLine,
} from '../../../../src/intel/cableSignals.js';

const CATALOGUE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../src/data/local_data/telegeography_submarine_cables/cable-geo.json',
);
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_SEEN = 20_000;
const MAX_LOG_BYTES = 5 * 1024 * 1024;

/**
 * The checked sources (2026-11-20; see tools/cable-incidents/README.md).
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
        // Doubt that names a cable waits for the local model (phase 2).
        if (assessment.signal === 'doubt' && assessment.cables.length)
          queueForModel(next, { item, sourceId: source.id, seenAt, at });
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

const MAX_PENDING = 200;
const MAX_ATTEMPTS = 3;
const MAX_MODEL_CHECKS_PER_POLL = 3;
const MAX_MODEL_CHECKS_PER_HOUR = 12;
const HOUR_MS = 3600_000;

/** Keep a doubtful notice for the model; the oldest go first when full. */
function queueForModel(state, { item, sourceId, seenAt, at }) {
  state.pending ??= [];
  if (state.pending.some((p) => p.item.url === item.url)) return;
  state.pending.push({ item, sourceId, seenAt, at, attempts: 0 });
  if (state.pending.length > MAX_PENDING)
    state.pending.splice(0, state.pending.length - MAX_PENDING);
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
  while (next.pending.length && checked < MAX_MODEL_CHECKS_PER_POLL) {
    if (next.modelChecks.length >= MAX_MODEL_CHECKS_PER_HOUR) break;
    if (foreground()) break;
    if (llm.status().status !== 'online') await llm.probe();
    if (llm.status().status !== 'online') break;
    if (await llm.busy()) break;
    const entry = next.pending[0];
    const source = byId.get(entry.sourceId);
    const base = {
      seenAt: new Date(now()).toISOString(),
      source: entry.sourceId,
      url: entry.item.url,
      title: printable(entry.item.title).slice(0, 300),
    };
    // Old news is not a new signal, model or not.
    if (!source || now() - entry.at > STALE_NOTICE_MS) {
      next.pending.shift();
      lines.push({ ...base, signal: 'llm-skipped', reason: 'stale-notice' });
      continue;
    }
    // The article itself, from the publisher's own site only.
    let article = '';
    if (!entry.item.offHost)
      try {
        const page = await fetchText(entry.item.url, {
          fetchImpl,
          maxBytes: MAX_SOURCE_BYTES,
          accept: 'text/html',
        });
        article = articleText(page.text, MAX_ARTICLE_CHARS);
      } catch {
        // Title and summary only.
      }
    const notice = {
      title: entry.item.title,
      summary: entry.item.summary,
      offHost: entry.item.offHost,
    };
    const named = cableMentions(
      [notice.title, notice.summary, article].join('\n'),
      names,
    );
    const cables = [
      ...new Map(
        named.map((c) => [c.cableId, { cableId: c.cableId, name: c.name }]),
      ).values(),
    ];
    if (!cables.length) {
      next.pending.shift();
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
      entry.attempts += 1;
      if (entry.attempts >= MAX_ATTEMPTS) {
        next.pending.shift();
        lines.push({
          ...base,
          signal: 'llm-skipped',
          reason: `model-failed: ${String(error?.message ?? error).slice(0, 80)}`,
        });
      }
      break;
    }
    next.pending.shift();
    const verdict = validateCableAssessment(reply.text, {
      notice,
      article,
      source,
      cables,
      now: now(),
    });
    const line = {
      ...base,
      signal: verdict.signal,
      reason: verdict.reason ?? null,
      cables: verdict.cableId
        ? [verdict.cableId]
        : cables.map((c) => c.cableId),
      claim: verdict.claim ?? null,
      breakConfirmed: verdict.breakConfirmed ?? false,
      quote: verdict.quote ?? null,
      model: llm.status().model ?? null,
      promptVersion: CABLE_PROMPT_VERSION,
      latencyMs: reply.latencyMs ?? null,
      change: null,
    };
    if (verdict.signal === 'llm-clear') {
      const started = verdict.startedOn
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
 * The Autopilot connector. Shadow mode only in phase 1: poll() always
 * returns no records, so nothing reaches the engine, the map or the camera.
 */
export function cableConnector({
  dir,
  sources = CABLE_SOURCES,
  fetchImpl = (...args) => globalThis.fetch(...args),
  intervalMs = 60 * 60_000,
  // Phase 2: the shared local model, or null to judge by the rules alone.
  llm = null,
  foreground = () => false,
} = {}) {
  if (!dir) throw new Error('cableConnector needs the intel folder');
  for (const source of sources)
    if (!canonicalUrl(source.url))
      throw new Error(`${source.id}: url must be HTTPS`);
  const stateFile = path.join(dir, 'cables-shadow-state.json');
  const logFile = path.join(dir, 'cables-shadow.jsonl');
  let names = null;
  return {
    id: 'submarine-cables',
    provider: 'cables',
    url: sources[0]?.url,
    intervalMs,
    // Operators post a few notices a month.
    staleAfterMs: 60 * 24 * 3600_000,
    license: "Each publisher's own terms",
    attribution: 'Cable operators and regulators (see the cable feed sources)',
    shadow: true,
    async poll({ now }) {
      names ??= catalogueNames(JSON.parse(fs.readFileSync(CATALOGUE, 'utf8')));
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
      return { records: [], latestObservationAt: result.latest || undefined };
    },
  };
}
