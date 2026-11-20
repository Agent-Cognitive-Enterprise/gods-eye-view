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
  canonicalUrl,
  fetchText,
  itemsFromFeed,
  itemsFromPage,
} from '../cableInbox.js';
import { catalogueNames } from '../../../../src/intel/cableInbox.js';
import {
  applySignal,
  assessNotice,
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
 * `cables` lists the catalogue cables a source speaks for: an operator's own
 * cables, a regulator's cables in its country. A notice about any other
 * cable is never a clear signal from that source. WIOCC holds capacity on
 * EASSy, Equiano and 2Africa but does not run them, so it speaks for none.
 */
export const CABLE_SOURCES = Object.freeze([
  {
    id: 'cinia-news',
    format: 'rss',
    url: 'https://www.cinia.fi/en/news/rss.xml',
    sourceKind: 'operator',
    cables: ['c-lion1'],
  },
  {
    id: 'wiocc-news',
    format: 'page',
    url: 'https://www.wiocc.net/news',
    pathPrefix: '/news/',
    sourceKind: 'operator',
    cables: [],
  },
  {
    id: 'space-norway',
    format: 'rss',
    url: 'https://spacenorway.com/feed/',
    sourceKind: 'operator',
    cables: ['svalbard-undersea-cable-system', 'arctic-way'],
  },
  {
    id: 'seaborn-news',
    format: 'rss',
    url: 'https://seabornnetworks.com/feed/',
    sourceKind: 'operator',
    cables: ['seabras-1'],
  },
  {
    id: 'tata-communications',
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
    format: 'page',
    url: 'https://nkom.no/aktuelt',
    pathPrefix: '/aktuelt/',
    sourceKind: 'authority',
    cables: ['svalbard-undersea-cable-system', 'arctic-way'],
  },
  {
    id: 'subtel-forum',
    format: 'rss',
    url: 'https://subtelforum.com/feed/',
    sourceKind: 'news',
    cables: [],
  },
]);

/** Saved state: notices seen, sources with a baseline, shadow incidents. */
export function readShadowState(file) {
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (state?.version === 1) return state;
  } catch {
    // Missing or unreadable: start over, recording a baseline again.
  }
  return { version: 1, seen: {}, baselines: {}, incidents: {} };
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
  const lines = [];
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
    const fresh = items.filter((item) => !Object.hasOwn(next.seen, item.url));
    for (const item of fresh) next.seen[item.url] = seenAt;
    // The first poll that lists notices only records them: old news is
    // not a new signal.
    if (!Object.hasOwn(next.baselines, source.id)) {
      if (items.length) next.baselines[source.id] = seenAt;
      continue;
    }
    // Oldest first, so a fault comes before its repair.
    fresh.sort((a, b) => noticeTime(a, seenAt) - noticeTime(b, seenAt));
    for (const item of fresh) {
      const at = noticeTime(item, seenAt);
      latest = Math.max(latest, at);
      const assessment = assessNotice({ item, source, names });
      if (!assessment.redFlag) continue;
      if (assessment.signal !== 'clear') {
        lines.push(shadowLine({ item, source, assessment, seenAt }));
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

/**
 * The Autopilot connector. Shadow mode only in phase 1: poll() always
 * returns no records, so nothing reaches the engine, the map or the camera.
 */
export function cableConnector({
  dir,
  sources = CABLE_SOURCES,
  fetchImpl = (...args) => globalThis.fetch(...args),
  intervalMs = 60 * 60_000,
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
        state: readShadowState(stateFile),
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
      return { records: [], latestObservationAt: result.latest || undefined };
    },
  };
}
