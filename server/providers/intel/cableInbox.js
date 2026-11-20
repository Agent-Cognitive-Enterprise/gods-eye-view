// Observe-only submarine cable inbox: polls a short, configured list of
// operator, regulator and news sources and, only when asked, IODA. New
// notices become proposals for a reviewer. Nothing here writes reviewed
// evidence by itself, serves a route, touches the globe or reaches Autopilot.
// The command line in tools/cable-incidents/inbox.mjs drives it.

import { createHash } from 'node:crypto';
import { readResponseTextCapped } from '../common/http.js';
import { blocks, elements, attr, tag, text } from './connectors/xml.js';
import {
  catalogueNames,
  dayBefore,
  diffSnapshots,
  iodaOutages,
  proposalFor,
} from '../../../src/intel/cableInbox.js';
import { replayCableIncidents } from '../../../src/intel/cableIncidents.js';

export const IODA_EVENTS_URL =
  'https://api.ioda.inetintel.cc.gatech.edu/v2/outages/events';
const USER_AGENT = 'gods-eye-view-cable-inbox/0.1 (local, observe-only)';
const TIMEOUT_MS = 30_000;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_IODA_BYTES = 4 * 1024 * 1024;
const MAX_ITEMS_PER_SOURCE = 100;
const MAX_SOURCES = 50;
const MAX_KEPT_PROPOSALS = 5000;
const SOURCE_KINDS = new Set([
  'operator',
  'authority',
  'news',
  'telemetry',
  'social',
]);
const CLAIMS = new Set(['fault', 'break', 'restored']);
const SOURCE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TRACKING = /^(utm_[a-z]+|hslang|fbclid|gclid)$/i;

/** An empty inbox. */
export const emptyInbox = () => ({
  version: 1,
  sources: {},
  seen: {},
  proposals: [],
});

/** Validated source list. Unknown fields and non-HTTPS URLs are refused. */
export function readSources(config) {
  const list = config?.sources;
  if (!Array.isArray(list) || list.length > MAX_SOURCES)
    throw new Error(`Expected "sources": a list of at most ${MAX_SOURCES}`);
  const ids = new Set();
  const allowed = new Set([
    'id',
    'enabled',
    'format',
    'url',
    'sourceKind',
    'publisher',
    'remit',
    'pathPrefix',
  ]);
  const sources = list.map((source, index) => {
    const label = `sources[${index}]`;
    for (const key of Object.keys(source ?? {}))
      if (!allowed.has(key)) throw new Error(`${label}: unknown field ${key}`);
    const { id, format, url, sourceKind, pathPrefix } = source ?? {};
    if (typeof id !== 'string' || !SOURCE_ID.test(id) || ids.has(id))
      throw new Error(`${label}: id must be unique, lowercase, a-z 0-9 -`);
    ids.add(id);
    if (format !== 'rss' && format !== 'page')
      throw new Error(`${id}: format must be "rss" or "page"`);
    if (!SOURCE_KINDS.has(sourceKind))
      throw new Error(`${id}: unknown sourceKind`);
    const parsed = httpsUrl(url);
    if (!parsed) throw new Error(`${id}: url must be HTTPS`);
    if (
      format === 'page' &&
      (typeof pathPrefix !== 'string' || !pathPrefix.startsWith('/'))
    )
      throw new Error(`${id}: a page source needs a pathPrefix such as /news/`);
    return {
      id,
      enabled: source.enabled !== false,
      format,
      url: parsed.href,
      sourceKind,
      publisher: typeof source.publisher === 'string' ? source.publisher : null,
      remit: typeof source.remit === 'string' ? source.remit : null,
      pathPrefix: format === 'page' ? pathPrefix : null,
    };
  });
  return { sources, ioda: { enabled: config?.ioda?.enabled === true } };
}

function httpsUrl(value, base) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  const url = URL.parse(value.trim(), base);
  if (!url || url.protocol !== 'https:' || url.username || url.password)
    return null;
  return url;
}

/** The URL a notice is known by: no fragment, no tracking parameters. */
export function canonicalUrl(value, base) {
  const url = httpsUrl(value, base);
  if (!url) return null;
  url.hash = '';
  for (const key of [...url.searchParams.keys()])
    if (TRACKING.test(key)) url.searchParams.delete(key);
  url.search = url.searchParams.toString() ? `?${url.searchParams}` : '';
  return url.href;
}

export const proposalId = (url) =>
  `p-${createHash('sha256').update(url).digest('hex').slice(0, 16)}`;

const decodeNumeric = (value) =>
  String(value ?? '').replace(/&#(x[0-9a-f]+|\d+);/gi, (whole, code) => {
    const point =
      code[0].toLowerCase() === 'x'
        ? parseInt(code.slice(1), 16)
        : parseInt(code, 10);
    return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : '';
  });
const plain = (value) =>
  text(decodeNumeric(value).replace(/&nbsp;/g, ' ')).slice(0, 2000);

function isoTime(value) {
  const time = Date.parse(String(value ?? ''));
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

/** RSS items or Atom entries, as {url, title, summary, publishedAt}. */
export function itemsFromFeed(xml, base) {
  const rss = blocks(xml, 'item', MAX_ITEMS_PER_SOURCE);
  const entries = rss.length ? rss : blocks(xml, 'entry', MAX_ITEMS_PER_SOURCE);
  const out = [];
  for (const block of entries) {
    const link =
      (rss.length ? tag(block, 'link') : null) ??
      attr(block, 'link', 'href') ??
      tag(block, 'guid');
    const url = canonicalUrl(decodeNumeric(link), base);
    if (!url) continue;
    out.push({
      url,
      title: plain(tag(block, 'title')),
      summary: plain(
        tag(block, 'description') ??
          tag(block, 'summary') ??
          tag(block, 'content') ??
          '',
      ),
      publishedAt: isoTime(
        tag(block, 'pubDate') ??
          tag(block, 'dc:date') ??
          tag(block, 'published') ??
          tag(block, 'updated'),
      ),
    });
  }
  return out;
}

const NOT_AN_ARTICLE = /(?:\/page\/\d+\/?|\.(?:xml|rss|atom|pdf|jpe?g|png))$/i;

/**
 * Links on a news listing page under `pathPrefix`, same host only, as
 * {url, title}. Listing pages and feeds under the prefix are skipped.
 */
export function itemsFromPage(html, pageUrl, pathPrefix) {
  const page = new URL(pageUrl);
  const byUrl = new Map();
  for (const anchor of elements(html, 'a', 5000)) {
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(
      anchor.attributes,
    );
    if (!href) continue;
    const url = canonicalUrl(decodeNumeric(href[1] ?? href[2]), page);
    if (!url) continue;
    const parsed = new URL(url);
    if (
      parsed.host !== page.host ||
      !parsed.pathname.startsWith(pathPrefix) ||
      parsed.pathname.length <= pathPrefix.length ||
      NOT_AN_ARTICLE.test(parsed.pathname)
    )
      continue;
    const title = plain(anchor.inner).slice(0, 300);
    const known = byUrl.get(url);
    if (!known || title.length > known.title.length)
      byUrl.set(url, { url, title, summary: '', publishedAt: null });
    if (byUrl.size >= MAX_ITEMS_PER_SOURCE) break;
  }
  return [...byUrl.values()];
}

/** Bounded HTTPS GET of text. Redirects must stay on HTTPS. */
export async function fetchText(url, { fetchImpl, accept = '*/*', maxBytes }) {
  const response = await fetchImpl(url, {
    headers: { Accept: accept, 'User-Agent': USER_AGENT },
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (response.url && !httpsUrl(response.url)) {
    await response.body?.cancel().catch(() => {});
    throw new Error('redirected away from HTTPS');
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`HTTP ${response.status}`);
  }
  return readResponseTextCapped(response, maxBytes);
}

/**
 * Poll every enabled source once. A source's first poll only records what
 * is already listed (its baseline), so old news does not flood the inbox;
 * `includeExisting` proposes those too. One failing source never stops the
 * others. Returns the new inbox and a summary; the input is not changed.
 */
export async function pollSources({
  sources,
  inbox,
  catalogue,
  fetchImpl,
  now,
  includeExisting = false,
}) {
  const next = structuredClone(inbox);
  const names = catalogueNames(catalogue);
  const seenAt = new Date(now()).toISOString();
  const summary = [];
  for (const source of sources) {
    if (!source.enabled) continue;
    const status = (next.sources[source.id] ??= {
      baselineAt: null,
      lastPollAt: null,
      lastOkAt: null,
      lastError: null,
    });
    status.lastPollAt = seenAt;
    try {
      const body = await fetchText(source.url, {
        fetchImpl,
        maxBytes: MAX_SOURCE_BYTES,
        accept:
          source.format === 'rss'
            ? 'application/rss+xml, application/atom+xml, application/xml, text/xml'
            : 'text/html',
      });
      const items =
        source.format === 'rss'
          ? itemsFromFeed(body, source.url)
          : itemsFromPage(body, source.url, source.pathPrefix);
      const baseline = !status.baselineAt && !includeExisting;
      let added = 0;
      for (const item of items) {
        if (next.seen[item.url]) continue;
        if (baseline) {
          next.seen[item.url] = 'baseline';
          continue;
        }
        const id = proposalId(item.url);
        next.seen[item.url] = id;
        next.proposals.push(proposalFor({ id, source, item, seenAt, names }));
        added += 1;
      }
      status.baselineAt ??= seenAt;
      status.lastOkAt = seenAt;
      status.lastError = null;
      summary.push({
        source: source.id,
        items: items.length,
        added,
        baseline,
      });
    } catch (error) {
      status.lastError = String(error?.message ?? error).slice(0, 200);
      summary.push({ source: source.id, error: status.lastError });
    }
  }
  // Decided proposals are dropped first, oldest first; new ones are kept.
  if (next.proposals.length > MAX_KEPT_PROPOSALS) {
    const excess = next.proposals.length - MAX_KEPT_PROPOSALS;
    let dropped = 0;
    next.proposals = next.proposals.filter(
      (p) => p.status === 'new' || dropped++ >= excess,
    );
  }
  return { inbox: next, summary };
}

/**
 * Country-level outage events from IODA for the last `hours`. Off unless the
 * caller asks: IODA states "All Rights Reserved" on its data and publishes
 * no data-use terms, so its terms need checking before regular use.
 */
export async function pollIoda({
  fetchImpl,
  now,
  hours = 24,
  url = IODA_EVENTS_URL,
}) {
  const until = Math.floor(now() / 1000);
  const from = until - Math.round(hours * 3600);
  const query = new URL(url);
  query.search = new URLSearchParams({
    from: String(from),
    until: String(until),
    entityType: 'country',
    limit: '2000',
  }).toString();
  const body = JSON.parse(
    await fetchText(query.href, {
      fetchImpl,
      accept: 'application/json',
      maxBytes: MAX_IODA_BYTES,
    }),
  );
  if (body?.error) throw new Error('IODA returned an error');
  return {
    fetchedAt: new Date(now()).toISOString(),
    from: new Date(from * 1000).toISOString(),
    until: new Date(until * 1000).toISOString(),
    copyright:
      typeof body?.copyright === 'string' ? body.copyright.slice(0, 300) : null,
    outages: iodaOutages(body),
  };
}

const UTC_SECONDS = (time) =>
  new Date(time).toISOString().replace('.000Z', 'Z');

/**
 * Turn a reviewed proposal into one evidence row, validated by replaying the
 * whole file with it. `knownAt` is when the inbox first saw the notice;
 * `effectiveAt` is when the condition began, from the notice itself. Returns
 * the new inbox and evidence plus the row's replay outcome; inputs are not
 * changed.
 */
export function acceptProposal({
  inbox,
  evidence,
  catalogue,
  proposal: wanted,
  claim,
  incidentId,
  effectiveAt,
  cableId = null,
  cableName = null,
  sourceKind = null,
  sourceUrl = null,
  now,
}) {
  const next = structuredClone(inbox);
  const proposal = next.proposals.find((p) => p.id === wanted);
  if (!proposal) throw new Error(`No proposal ${wanted}`);
  if (proposal.status === 'rejected') throw new Error(`${wanted} was rejected`);
  if (!CLAIMS.has(claim))
    throw new Error('claim must be fault, break or restored');
  let cable = { cableId, cableName };
  if (!cableId && !cableName) {
    const strong = proposal.cables.filter((c) => !c.weak);
    if (strong.length !== 1)
      throw new Error(
        'Name the cable with --cable or --cable-name: the notice does not name exactly one cable',
      );
    cable = { cableId: strong[0].cableId, cableName: null };
  }
  const row = {
    id: `${proposal.id}-${claim}`,
    incidentId,
    ...cable,
    claim,
    sourceKind: sourceKind ?? proposal.sourceKind,
    sourceUrl: sourceUrl ?? proposal.url,
    effectiveAt,
    knownAt: proposal.seenAt.replace('.000Z', 'Z'),
  };
  if (!row.cableId) delete row.cableId;
  if (!row.cableName) delete row.cableName;
  if (evidence.some((r) => r.id === row.id))
    throw new Error(`${row.id} is already in the evidence file`);
  const rows = [...evidence, row];
  // Throws on any invalid field, a conflict, or effectiveAt after knownAt.
  const snapshot = replayCableIncidents({
    catalogue,
    evidence: rows,
    asOf: UTC_SECONDS(Math.max(now(), Date.parse(row.knownAt))),
  });
  const lead = snapshot.leads.find((l) => l.evidence.id === row.id);
  proposal.status = 'accepted';
  proposal.evidenceIds = [
    ...new Set([...(proposal.evidenceIds ?? []), row.id]),
  ];
  return {
    inbox: next,
    evidence: rows,
    row,
    outcome: lead ? { lead: lead.reason } : { incident: true },
  };
}

/** Mark a proposal as not cable evidence. */
export function rejectProposal({ inbox, proposal: wanted, reason = '' }) {
  const next = structuredClone(inbox);
  const proposal = next.proposals.find((p) => p.id === wanted);
  if (!proposal) throw new Error(`No proposal ${wanted}`);
  if (proposal.status === 'accepted')
    throw new Error(`${wanted} is already accepted`);
  proposal.status = 'rejected';
  proposal.reason = String(reason).slice(0, 300) || null;
  return next;
}

/**
 * The daily view: what changed in the reviewed incidents since a day before
 * `asOf`, what is still open, the proposals waiting for review and, kept
 * apart, IODA's country outages.
 */
export function buildReport({ catalogue, evidence, inbox, ioda, asOf }) {
  const since = dayBefore(asOf).replace('.000Z', 'Z');
  const replay = (at) =>
    replayCableIncidents({ catalogue, evidence, asOf: at });
  const today = replay(asOf);
  return {
    asOf: today.asOf,
    since,
    changes: diffSnapshots(replay(since), today),
    open: today.incidents.filter((i) => i.status !== 'reported-restored'),
    leads: today.leads.length,
    pending: inbox.proposals.filter((p) => p.status === 'new'),
    sources: inbox.sources,
    ioda: ioda ?? null,
  };
}

const CHANGE_WORDS = {
  new: 'new',
  updated: 'changed',
  removed: 'removed from the reviewed file',
};

/** Plain-text report for the terminal. */
export function formatReport(report) {
  const lines = [
    `Submarine cable inbox, ${report.since} to ${report.asOf}`,
    '',
    'Reviewed cable incidents (operator or authority notices only):',
  ];
  if (!report.changes.length) lines.push('  no change in the last 24 hours');
  for (const c of report.changes) {
    const from = c.from
      ? ` (was ${c.from.status}${c.from.breakConfirmed ? ', break confirmed' : ''})`
      : '';
    lines.push(
      `  ${c.cableId} [${c.incidentId}]: ${CHANGE_WORDS[c.change]}, ${c.status}${c.breakConfirmed ? ', break confirmed' : ''}${c.reason ? ` (${c.reason})` : ''}${from}`,
    );
    for (const url of new Set(c.sources ?? [])) lines.push(`    ${url}`);
  }
  lines.push(
    `  open: ${report.open.length ? report.open.map((i) => `${i.cableId} ${i.status}`).join('; ') : 'none'}`,
    `  leads (not cable evidence): ${report.leads}`,
    '',
    `Waiting for review: ${report.pending.length}`,
  );
  for (const p of report.pending.slice(0, 50)) {
    const cables = p.cables.length
      ? p.cables
          .map((c) => `${c.cableId}${c.weak ? ' (weak match)' : ''}`)
          .join(', ')
      : 'no catalogue cable named';
    lines.push(
      `  ${p.id} ${p.sourceKind} ${p.sourceId}: ${p.title || p.url}`,
      `    ${p.url}`,
      `    cables: ${cables}; suggested: ${p.suggestedClaim ?? 'none'}${p.cues.break ? `; break wording to check: ${p.cues.break.join(', ')}` : ''}`,
    );
  }
  const failing = Object.entries(report.sources ?? {}).filter(
    ([, s]) => s.lastError,
  );
  for (const [id, s] of failing)
    lines.push(`  source ${id} failed at ${s.lastPollAt}: ${s.lastError}`);
  lines.push('', 'IODA country outages (impact only, not cable attribution):');
  if (!report.ioda) lines.push('  not polled (off unless --ioda is given)');
  else {
    lines.push(`  ${report.ioda.from} to ${report.ioda.until}`);
    if (!report.ioda.outages.length) lines.push('  none');
    // An event IODA has not closed ends at the end of the window asked for.
    const windowEnd = Date.parse(report.ioda.until);
    for (const o of report.ioda.outages) {
      const ongoing = Date.parse(o.end) >= windowEnd;
      lines.push(
        `  ${o.country} ${o.name}: ${o.start} ${ongoing ? 'and still open at the end of the window' : `to ${o.end}`}, ${[...new Set(o.signals.map((s) => s.datasource))].join(', ')}`,
      );
    }
    if (report.ioda.copyright) lines.push(`  ${report.ioda.copyright}`);
  }
  return `${lines.join('\n')}\n`;
}
