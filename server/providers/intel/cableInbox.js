// Observe-only submarine cable inbox: polls a short, configured list of
// operator, regulator and news sources and, only when asked, IODA. New
// notices become proposals for a reviewer. Nothing here writes reviewed
// evidence by itself, serves a route, touches the globe or reaches Autopilot.
// The command line in tools/cable-incidents/inbox.mjs drives it.

import { createHash } from 'node:crypto';
import { readResponseTextCapped } from '../common/http.js';
import { elements } from './connectors/xml.js';
import {
  catalogueNames,
  dayBefore,
  diffSnapshots,
  iodaOutages,
  printable,
  proposalFor,
} from '../../../src/intel/cableInbox.js';
import { replayCableIncidents } from '../../../src/intel/cableIncidents.js';

export const IODA_EVENTS_URL =
  'https://api.ioda.inetintel.cc.gatech.edu/v2/outages/events';
const USER_AGENT = 'gods-eye-view-cable-inbox/0.1 (local, observe-only)';
const TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_IODA_BYTES = 4 * 1024 * 1024;
const MAX_ITEMS_PER_SOURCE = 100;
const MAX_FIELD = 20_000;
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
      publisher:
        typeof source.publisher === 'string'
          ? printable(source.publisher)
          : null,
      remit: typeof source.remit === 'string' ? printable(source.remit) : null,
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

// The same site with or without "www.".
const siteOf = (url) => new URL(url).hostname.replace(/^www\./, '');

// Linear text helpers. A hostile feed cannot make them rescan: every loop
// moves forward with indexOf, and no regex can backtrack across the input.

/** Everything between `open` and `close` removed (or kept with `keep`). */
function sections(value, open, close, keep) {
  let out = '';
  let at = 0;
  for (;;) {
    const start = value.indexOf(open, at);
    if (start < 0) return out + value.slice(at);
    out += value.slice(at, start);
    const end = value.indexOf(close, start + open.length);
    if (end < 0) return out + (keep ? value.slice(start + open.length) : '');
    if (keep) out += value.slice(start + open.length, end);
    at = end + close.length;
  }
}

function stripTags(value) {
  let out = '';
  let at = 0;
  for (;;) {
    const start = value.indexOf('<', at);
    if (start < 0) return out + value.slice(at);
    out += `${value.slice(at, start)} `;
    const end = value.indexOf('>', start + 1);
    if (end < 0) return out;
    at = end + 1;
  }
}

const NAMED = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' ' };
const ENTITY = /&(#x[0-9a-f]{1,6}|#\d{1,7}|lt|gt|amp|quot|apos|nbsp);/gi;
const decode = (value) =>
  value.replace(ENTITY, (whole, name) => {
    if (name[0] !== '#') return NAMED[name.toLowerCase()];
    const point =
      name[1].toLowerCase() === 'x'
        ? parseInt(name.slice(2), 16)
        : parseInt(name.slice(1), 10);
    return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : ' ';
  });

/** Feed or page markup to printable plain text. */
function plain(markup) {
  const raw = String(markup ?? '').slice(0, MAX_FIELD);
  const html = decode(sections(raw, '<![CDATA[', ']]>', true));
  return printable(
    decode(stripTags(sections(html, '<!--', '-->', false))),
  ).slice(0, 2000);
}

const inner = (block, name) => elements(block, name, 1)[0]?.inner ?? null;

// The lookbehind starts a name only at a name boundary, so a long run of
// letters with no "=" is not retried from every letter.
const ATTRIBUTE =
  /(?<![a-z0-9:-])([a-z][a-z0-9:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
function attributesOf(text) {
  const out = {};
  for (const m of String(text).slice(0, 4096).matchAll(ATTRIBUTE)) {
    const key = m[1].toLowerCase();
    if (!(key in out)) out[key] = decode(m[2] ?? m[3] ?? '');
  }
  return out;
}

/** Atom: the `alternate` link, or a link with no `rel`. */
function atomLink(block) {
  for (const link of elements(block, 'link', 20)) {
    const { rel, href } = attributesOf(link.attributes);
    if (href && (!rel || rel.toLowerCase() === 'alternate')) return href;
  }
  return null;
}

/**
 * RSS items or Atom entries, as {url, title, summary, publishedAt, offHost}.
 * An item with no link of its own is skipped, never given the feed's URL. An
 * item linking to another site than the feed's is marked `offHost`.
 */
export function itemsFromFeed(xml, feedUrl) {
  const source = String(xml ?? '');
  const rss = elements(source, 'item', MAX_ITEMS_PER_SOURCE);
  const entries = rss.length
    ? rss
    : elements(source, 'entry', MAX_ITEMS_PER_SOURCE);
  const site = siteOf(feedUrl);
  const out = [];
  for (const { inner: block } of entries) {
    const linkText = rss.length ? plain(inner(block, 'link')) : null;
    const guid = rss.length ? plain(inner(block, 'guid')) : null;
    // RSS links must be full HTTPS URLs; a bad link falls back to the guid.
    const url = rss.length
      ? ((linkText ? canonicalUrl(linkText) : null) ?? canonicalUrl(guid ?? ''))
      : (() => {
          const href = atomLink(block);
          return href ? canonicalUrl(href, feedUrl) : null;
        })();
    if (!url) continue;
    out.push({
      url,
      title: plain(inner(block, 'title')),
      summary: plain(
        inner(block, 'description') ??
          inner(block, 'summary') ??
          inner(block, 'content') ??
          '',
      ),
      publishedAt: isoTime(
        plain(
          inner(block, 'pubDate') ??
            inner(block, 'dc:date') ??
            inner(block, 'published') ??
            inner(block, 'updated'),
        ),
      ),
      ...(siteOf(url) !== site ? { offHost: true } : {}),
    });
  }
  return out;
}

function isoTime(value) {
  const time = Date.parse(String(value ?? ''));
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

const HEADING_CLASS = /(?:^|\s)class\s*=\s*(?:"([^"]*)"|'([^']*)')/i;

// A title class is a whole class token: "title", "card-title",
// "heading-style-h4". "series-title", "tag-title" and "eyebrow" are labels.
const TITLE_CLASS =
  /^(?:(?:card|post|entry|article|news|item|teaser|list)[-_])?(?:title|heading)$|^heading-style-h[1-6]$/;
// Link text that names no notice.
const GENERIC_LINK =
  /^(?:read (?:more|full (?:post|story|article))|more|continue reading|lue lisää|les mer|läs mer|weiterlesen|mehr)\s*[»›→>]?$/i;
// Classes that mark a label above a card, not its title.
const LABEL_CLASS =
  /^(?:eyebrow|kicker|overline|label|category|categories|tag|tags|topic|section|series|badge|pill)(?:[-_].*)?$/;
const MAX_HEADING_CANDIDATES = 50;

/**
 * The heading text of a news card, or null: the first heading element
 * (h1-h6) or element with a title class, in document order. A heading that
 * is empty or says only "Read more" is skipped.
 */
function cardHeading(markup) {
  const source = String(markup ?? '').slice(0, 20_000);
  const lower = source.toLowerCase();
  let at = 0;
  let gt = -1;
  let candidates = 0;
  for (;;) {
    const lt = lower.indexOf('<', at);
    if (lt < 0) return null;
    // One search for '>' serves every '<' before it: linear.
    if (gt < lt) gt = lower.indexOf('>', lt);
    if (gt < 0) return null;
    at = lt + 1;
    const tag = /^<(h[1-6]|div|span|p|strong)(?=[\s>/])/.exec(
      lower.slice(lt, lt + 8),
    );
    if (!tag) continue;
    const name = tag[1];
    const classes = HEADING_CLASS.exec(
      source.slice(lt + 1 + name.length, gt).slice(0, 2048),
    );
    const tokens = (classes?.[1] ?? classes?.[2] ?? '')
      .toLowerCase()
      .split(/\s+/);
    // A label above the card (eyebrow, category, tag) is never its title.
    if (tokens.some((token) => LABEL_CLASS.test(token))) continue;
    if (name[0] !== 'h' && !tokens.some((token) => TITLE_CLASS.test(token)))
      continue;
    if (++candidates > MAX_HEADING_CANDIDATES) return null;
    const [element] = elements(source.slice(lt), name, 1);
    const text = element ? plain(element.inner) : '';
    if (text && !GENERIC_LINK.test(text)) return text;
  }
}

const NOT_AN_ARTICLE =
  /(?:\/page\/\d+\/?|\/(?:feed|rss|tag|tags|category|categories|author)(?:\/[^/]*)*\/?|\.(?:xml|rss|atom|pdf|jpe?g|png))$/i;
const HREF = /(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)')/i;

/**
 * Links on a news listing page under `pathPrefix`, on the page's own site
 * (after any redirect), as {url, title}. Listing, tag and feed pages under
 * the prefix are skipped, and so are links inside HTML comments.
 */
export function itemsFromPage(html, pageUrl, pathPrefix) {
  const page = new URL(pageUrl);
  const site = siteOf(page.href);
  const visible = sections(String(html ?? ''), '<!--', '-->', false);
  const byUrl = new Map();
  for (const anchor of elements(visible, 'a', 5000)) {
    const href = HREF.exec(anchor.attributes.slice(0, 4096));
    if (!href) continue;
    const url = canonicalUrl(decode(href[1] ?? href[2]), page);
    if (!url) continue;
    const parsed = new URL(url);
    if (
      siteOf(url) !== site ||
      !parsed.pathname.startsWith(pathPrefix) ||
      parsed.pathname.length <= pathPrefix.length ||
      NOT_AN_ARTICLE.test(parsed.pathname)
    )
      continue;
    // A card's own heading is its title (Cinia: <h3>, WIOCC: a "heading"
    // class); the rest of the card is the summary. Without one the whole
    // card text is kept as the title and marked as not a known title.
    const card = plain(anchor.inner).slice(0, 2000);
    // A plain text link ("<a href>Title</a>") is its own title.
    const inline =
      !/<(?:p|div|section|article|header|footer|ul|ol|li|table|br|h[1-6])\b/i.test(
        anchor.inner.slice(0, 20_000),
      );
    const heading =
      cardHeading(anchor.inner) ??
      (inline && card && !GENERIC_LINK.test(card) ? card : null);
    const title = (heading ?? card).slice(0, 300);
    const item = heading
      ? {
          url,
          title,
          // The card text without its heading: date, then summary.
          summary: (heading === card ? '' : card)
            .replace(heading, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 600),
          publishedAt: null,
        }
      : {
          url,
          title,
          summary: '',
          publishedAt: null,
          titleKnown: false,
        };
    // Several links to one notice: a card with a heading wins, then the
    // longest card.
    const known = byUrl.get(url);
    if (
      !known ||
      (known.titleKnown === false &&
        (heading || card.length > known.title.length))
    )
      byUrl.set(url, item);
    if (byUrl.size >= MAX_ITEMS_PER_SOURCE) break;
  }
  return [...byUrl.values()];
}

/**
 * Bounded HTTPS GET of text. Redirects are followed by hand, at most five,
 * and every hop must be HTTPS. One timeout covers the whole chain and the
 * body. Returns {text, url} with the URL the text came from.
 */
export async function fetchText(url, { fetchImpl, accept = '*/*', maxBytes }) {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await fetchImpl(current, {
      headers: { Accept: accept, 'User-Agent': USER_AGENT },
      redirect: 'manual',
      signal,
    });
    if (REDIRECTS.has(response.status)) {
      await response.body?.cancel().catch(() => {});
      const location = response.headers.get('location');
      if (!location?.trim()) throw new Error('redirect without a Location');
      const next = httpsUrl(location, current);
      if (!next) throw new Error('redirected away from HTTPS');
      current = next.href;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`HTTP ${response.status}`);
    }
    return {
      text: await readResponseTextCapped(response, maxBytes, signal),
      url: current,
    };
  }
  throw new Error('too many redirects');
}

const own = (object, key) => Object.hasOwn(object, key);

/**
 * Poll every enabled source once. A source's first poll that lists notices
 * only records them (its baseline), so old news does not flood the inbox;
 * `includeExisting` proposes those too. A poll that lists nothing records
 * no baseline. One failing source never stops the others. Returns the new
 * inbox and a summary; the input is not changed.
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
    if (!own(next.sources, source.id))
      next.sources[source.id] = {
        baselineAt: null,
        lastPollAt: null,
        lastOkAt: null,
        lastError: null,
      };
    const status = next.sources[source.id];
    status.lastPollAt = seenAt;
    try {
      const fetched = await fetchText(source.url, {
        fetchImpl,
        maxBytes: MAX_SOURCE_BYTES,
        accept:
          source.format === 'rss'
            ? 'application/rss+xml, application/atom+xml, application/xml, text/xml'
            : 'text/html',
      });
      const items =
        source.format === 'rss'
          ? itemsFromFeed(fetched.text, fetched.url)
          : itemsFromPage(fetched.text, fetched.url, source.pathPrefix);
      const baseline = !status.baselineAt && !includeExisting;
      let added = 0;
      for (const item of items) {
        if (own(next.seen, item.url)) continue;
        if (baseline) {
          next.seen[item.url] = 'baseline';
          continue;
        }
        const id = proposalId(item.url);
        next.seen[item.url] = id;
        next.proposals.push(proposalFor({ id, source, item, seenAt, names }));
        added += 1;
      }
      if (items.length) status.baselineAt ??= seenAt;
      status.lastOkAt = seenAt;
      status.lastError = null;
      summary.push({
        source: source.id,
        items: items.length,
        added,
        baseline: baseline && items.length > 0,
      });
    } catch (error) {
      status.lastError = printable(error?.message ?? error).slice(0, 200);
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
  const { text } = await fetchText(query.href, {
    fetchImpl,
    accept: 'application/json',
    maxBytes: MAX_IODA_BYTES,
  });
  const body = JSON.parse(text);
  if (body?.error) throw new Error('IODA returned an error');
  return {
    fetchedAt: new Date(now()).toISOString(),
    from: new Date(from * 1000).toISOString(),
    until: new Date(until * 1000).toISOString(),
    copyright:
      typeof body?.copyright === 'string'
        ? printable(body.copyright).slice(0, 300)
        : null,
    outages: iodaOutages(body, { from, until }),
  };
}

const isoAt = (time) => new Date(time).toISOString();

/**
 * Turn a reviewed proposal into one evidence row, validated by replaying the
 * whole file with it. `effectiveAt` is when the condition began, from the
 * notice itself. `knownAt` is when the inbox first saw the notice, or the
 * time of this accept when the reviewer records another URL or source kind
 * (that notice was found now, not when the proposal arrived). The cable is
 * the one the reviewer names, or the notice's only cable match when it has
 * exactly one and no weak one. Returns the new inbox and evidence, the row
 * and its replay outcome; inputs are not changed.
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
  let cableFrom = 'given';
  if (!cableId && !cableName) {
    const strong = proposal.cables.filter((c) => !c.weak);
    if (strong.length !== 1 || strong.length !== proposal.cables.length)
      throw new Error(
        'Name the cable with --cable or --cable-name: the notice does not name exactly one cable',
      );
    cable = { cableId: strong[0].cableId, cableName: null };
    cableFrom = 'matched';
  }
  const overridden = sourceKind !== null || sourceUrl !== null;
  const row = {
    id: `${proposal.id}-${claim}`,
    incidentId,
    ...cable,
    claim,
    sourceKind: sourceKind ?? proposal.sourceKind,
    sourceUrl: sourceUrl ?? proposal.url,
    effectiveAt,
    knownAt: overridden ? isoAt(now()) : proposal.seenAt,
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
    asOf: isoAt(Math.max(now(), Date.parse(row.knownAt))),
  });
  const lead = snapshot.leads.find((l) => l.evidence.id === row.id);
  proposal.status = 'accepted';
  proposal.decidedAt = new Date(now()).toISOString();
  if (lead)
    proposal.leads = [
      ...(proposal.leads ?? []).filter((l) => l.id !== row.id),
      { id: row.id, reason: lead.reason },
    ];
  proposal.evidenceIds = [
    ...new Set([...(proposal.evidenceIds ?? []), row.id]),
  ];
  return {
    inbox: next,
    evidence: rows,
    row,
    cableFrom,
    outcome: lead ? { lead: lead.reason } : { incident: true },
  };
}

/** Mark a proposal as not cable evidence. */
export function rejectProposal({
  inbox,
  proposal: wanted,
  reason = '',
  now = () => Date.now(),
}) {
  const next = structuredClone(inbox);
  const proposal = next.proposals.find((p) => p.id === wanted);
  if (!proposal) throw new Error(`No proposal ${wanted}`);
  if (proposal.status === 'accepted')
    throw new Error(`${wanted} is already accepted`);
  proposal.status = 'rejected';
  proposal.decidedAt = new Date(now()).toISOString();
  proposal.reason = printable(reason).slice(0, 300) || null;
  return next;
}

/**
 * The daily view, a day before `asOf` to `asOf`:
 * - what changed in the reviewed incidents, going by when each notice was
 *   first seen, so a notice reviewed days later changes that earlier day;
 * - the proposals reviewed in the window, whenever they were first seen;
 * - what is still open, and the proposals waiting for review;
 * - kept apart, IODA's country outages.
 */
export function buildReport({ catalogue, evidence, inbox, ioda, asOf }) {
  const replay = (at) =>
    replayCableIncidents({ catalogue, evidence, asOf: at });
  const today = replay(asOf);
  const yesterday = replay(dayBefore(today.asOf));
  const start = Date.parse(yesterday.asOf);
  const end = Date.parse(today.asOf);
  const inWindow = (iso) => {
    const time = Date.parse(iso);
    return time > start && time <= end;
  };
  return {
    asOf: today.asOf,
    since: yesterday.asOf,
    changes: diffSnapshots(yesterday, today),
    reviewed: inbox.proposals.filter(
      (p) => p.status !== 'new' && p.decidedAt && inWindow(p.decidedAt),
    ),
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
const statusText = (status, breakConfirmed) =>
  `${status}${breakConfirmed && status !== 'break-confirmed' ? ', break confirmed' : ''}`;

/** Plain-text report for the terminal. Stored text is printed printable. */
export function formatReport(report) {
  const p = printable;
  const lines = [
    `Submarine cable inbox, ${report.since} to ${report.asOf}`,
    '',
    'Reviewed cable incidents (operator or authority notices only), by when each notice was first seen:',
  ];
  if (!report.changes.length) lines.push('  no change in the last 24 hours');
  for (const c of report.changes) {
    const from = c.from
      ? ` (was ${statusText(c.from.status, c.from.breakConfirmed)})`
      : '';
    lines.push(
      `  ${p(c.cableId)} [${p(c.incidentId)}]: ${CHANGE_WORDS[c.change]}, ${statusText(c.status, c.breakConfirmed)}${c.reason ? ` (${c.reason})` : ''}${from}`,
    );
    for (const url of new Set(c.sources ?? [])) lines.push(`    ${p(url)}`);
  }
  lines.push(
    `  open: ${report.open.length ? report.open.map((i) => `${p(i.cableId)} ${i.status}`).join('; ') : 'none'}`,
    `  leads (not cable evidence): ${report.leads}`,
    '',
    `Reviewed in the last 24 hours: ${report.reviewed.length}`,
  );
  for (const r of report.reviewed)
    lines.push(
      `  ${p(r.id)} ${r.status}${r.evidenceIds ? ` as ${r.evidenceIds.map(p).join(', ')}` : ''}${r.leads?.length ? ` (stays a lead: ${r.leads.map((l) => `${p(l.id)} ${p(l.reason)}`).join(', ')})` : ''}${r.reason ? ` (${p(r.reason)})` : ''}: ${p(r.title || r.url)}`,
    );
  lines.push('', `Waiting for review: ${report.pending.length}`);
  for (const r of report.pending.slice(0, 50)) {
    const cables = r.cables.length
      ? r.cables
          .map((c) => `${p(c.cableId)}${c.weak ? ' (weak match)' : ''}`)
          .join(', ')
      : 'no catalogue cable named';
    lines.push(
      `  ${p(r.id)} ${p(r.sourceKind)} ${p(r.sourceId)}${r.offHost ? ' (links to another site)' : ''}: ${p(r.title || r.url)}`,
      `    ${p(r.url)}`,
      `    cables: ${cables}; suggested: ${p(r.suggestedClaim ?? 'none')}${r.cues?.break ? `; break wording to check: ${r.cues.break.map(p).join(', ')}` : ''}${r.cues?.doubt ? `; doubtful wording: ${r.cues.doubt.map(p).join(', ')}` : ''}`,
    );
  }
  if (report.pending.length > 50)
    lines.push(`  … ${report.pending.length - 50} more: run list`);
  for (const [id, s] of Object.entries(report.sources ?? {}))
    if (s.lastError)
      lines.push(
        `  source ${p(id)} failed at ${p(s.lastPollAt)}: ${p(s.lastError)}`,
      );
  lines.push('', 'IODA country outages (impact only, not cable attribution):');
  if (!report.ioda) lines.push('  not polled (off unless --ioda is given)');
  else {
    lines.push(`  ${p(report.ioda.from)} to ${p(report.ioda.until)}`);
    if (!report.ioda.outages.length) lines.push('  none');
    // An event IODA has not closed ends at the end of the window asked for.
    const windowEnd = Date.parse(report.ioda.until);
    for (const o of report.ioda.outages) {
      const ongoing = Date.parse(o.end) >= windowEnd;
      lines.push(
        `  ${p(o.country)} ${p(o.name)}: ${p(o.start)} ${ongoing ? 'and still open at the end of the window' : `to ${p(o.end)}`}, ${[...new Set(o.signals.map((s) => p(s.datasource)))].join(', ')}`,
      );
    }
    if (report.ioda.copyright) lines.push(`  ${p(report.ioda.copyright)}`);
  }
  return `${lines.join('\n')}\n`;
}
