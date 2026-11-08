import { createHash } from 'node:crypto';
import { readResponseJsonCapped } from '../common/http.js';

// News candidates for the banking-access layer (fork feature): articles from
// the GDELT DOC 2.0 API (keyless, open; cite "The GDELT Project") whose words
// suggest people may be cut off from their money. They are leads for a
// reviewer, never events: nothing here is drawn on the map. Opt-in
// (GEV_BANKING_NEWS=1). Fetched at most once an hour, and only while someone
// is looking (a request starts a refresh in the background).

export const NEWS_QUERY =
  '("withdrawal limits" OR "withdrawal limit" OR "capital controls" OR ' +
  '"bank run" OR "frozen deposits" OR "deposits frozen" OR "deposit freeze" OR ' +
  '"banking outage" OR "bank outage" OR "ATM outage" OR "unable to withdraw")';
const API = 'https://api.gdeltproject.org/api/v2/doc/doc';
const REFRESH_MS = 3600_000;
const RETRY_MS = 15 * 60_000;
// A full query took about 15 s on 2026-11-08.
const TIMEOUT_MS = 45_000;
// GDELT allows one request every 5 s per address and answers more with 429;
// a transient network error or 429 is retried after these pauses.
const ATTEMPT_PAUSES_MS = Object.freeze([6_000, 15_000]);
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_CANDIDATES = 40;

export function newsUrl() {
  return `${API}?${new URLSearchParams({
    query: NEWS_QUERY,
    mode: 'artlist',
    format: 'json',
    timespan: '3d',
    maxrecords: '75',
    sort: 'datedesc',
  })}`;
}

/** GDELT's 20261108T093000Z, or null. */
function seenAt(value) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(
    String(value ?? ''),
  );
  return m ? Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
}

const clean = (value, max) =>
  typeof value === 'string'
    ? value
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max) || null
    : null;

/**
 * Articles as candidates: http(s) links only, one per (rough) headline,
 * newest first, without the URLs reviewed events already cite.
 */
export function candidatesFromArticles(
  payload,
  { knownUrls = new Set() } = {},
) {
  const out = [];
  const titles = new Set();
  for (const a of Array.isArray(payload?.articles) ? payload.articles : []) {
    let url;
    try {
      url = new URL(String(a?.url));
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
    if (knownUrls.has(url.href)) continue;
    const title = clean(a.title, 240);
    if (!title) continue;
    const key = title
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
    if (titles.has(key)) continue;
    titles.add(key);
    out.push({
      // Stable per article: a reviewer's decision follows its URL.
      id: `news:${url.hostname}:${createHash('sha256').update(url.href).digest('hex').slice(0, 16)}`,
      title,
      url: url.href,
      domain: clean(a.domain, 120) ?? url.hostname,
      language: clean(a.language, 40),
      sourceCountry: clean(a.sourcecountry, 80),
      seenAt: seenAt(a.seendate),
    });
  }
  out.sort((a, b) => (b.seenAt ?? 0) - (a.seenAt ?? 0));
  return out.slice(0, MAX_CANDIDATES);
}

/** The candidate store: `snapshot()` never waits on the network. */
export function createNewsCandidates({
  enabled = false,
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  warn = (...args) => console.warn(...args),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  let candidates = [];
  let fetchedAt = null;
  let error = null;
  let nextAt = 0;
  let running = null;

  // One request; a retryable failure is marked so refresh tries again.
  async function attempt() {
    let response;
    try {
      response = await fetchImpl(newsUrl(), {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'error',
        headers: {
          Accept: 'application/json',
          'User-Agent': 'gods-eye-view-banking-access/1.0',
        },
      });
    } catch (e) {
      // undici says only "fetch failed"; the reason is in the cause.
      const why = e?.cause?.code ?? e?.cause?.message ?? e?.name;
      throw Object.assign(
        new Error(`${e?.message ?? 'fetch failed'}${why ? ` (${why})` : ''}`),
        { retryable: true },
      );
    }
    if (!response.ok) {
      await response.body?.cancel?.();
      throw Object.assign(new Error(`GDELT answered ${response.status}`), {
        retryable: response.status === 429 || response.status >= 500,
      });
    }
    return response;
  }

  async function refresh(knownUrls) {
    let response;
    for (let i = 0; ; i++) {
      try {
        response = await attempt();
        break;
      } catch (e) {
        if (!e.retryable || i >= ATTEMPT_PAUSES_MS.length) throw e;
        warn(`[banking-access] news candidates: ${e.message}; retrying`);
        await sleep(ATTEMPT_PAUSES_MS[i]);
      }
    }
    const payload = await readResponseJsonCapped(response, MAX_BYTES);
    candidates = candidatesFromArticles(payload, { knownUrls });
    fetchedAt = now();
    error = null;
  }

  return {
    snapshot({ knownUrls } = {}) {
      if (enabled && !running && now() >= nextAt) {
        nextAt = now() + REFRESH_MS;
        running = refresh(knownUrls)
          .catch((e) => {
            // GDELT answers rate limits and outages with plain text.
            error = 'news_unavailable';
            nextAt = now() + RETRY_MS;
            warn('[banking-access] news candidates:', e?.message ?? e);
          })
          .finally(() => {
            running = null;
          });
      }
      return {
        enabled,
        fetchedAt,
        error,
        source: enabled ? 'GDELT DOC 2.0' : null,
        candidates: enabled ? candidates : [],
      };
    },
    /** Tests: wait for a refresh in flight. */
    settle: () => running ?? Promise.resolve(),
  };
}
