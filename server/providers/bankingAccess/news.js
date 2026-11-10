import { createHash } from 'node:crypto';
import https from 'node:https';
import { Readable } from 'node:stream';
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
// After a failed refresh the next one waits 15 min, doubling per consecutive
// failure up to 4 h, with jitter: a circuit breaker, so a feed that keeps
// failing is not hammered and its state is visible. From three failures in a
// row the circuit is reported open.
const BACKOFF_BASE_MS = 15 * 60_000;
const BACKOFF_MAX_MS = 4 * 3600_000;
const CIRCUIT_OPEN_AFTER = 3;
// A full query took about 15 s on 2026-11-08.
const TIMEOUT_MS = 45_000;
// GDELT allows one request every 5 s per address and answers more with 429
// (on 2026-11-08 even to retries 6 and 15 s apart). Within one refresh a
// transient network error, 429 or 5xx is retried at most twice, with
// exponential backoff and jitter: about 15-30 s, then 30-60 s.
const MAX_ATTEMPTS = 3;
const ATTEMPT_BASE_MS = 30_000;
const ATTEMPT_MAX_MS = 60_000;

/** Equal jitter: half the delay fixed, half random. */
export function jittered(ms, random = Math.random) {
  return Math.round(ms / 2 + random() * (ms / 2));
}
/** The pause before retry `i` (0-based) within one refresh. */
export function attemptPause(i, random = Math.random) {
  return jittered(Math.min(ATTEMPT_MAX_MS, ATTEMPT_BASE_MS * 2 ** i), random);
}
/** The wait after `failures` consecutive failed refreshes (1-based). */
export function refreshBackoff(failures, random = Math.random) {
  const ms = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (failures - 1));
  return jittered(ms, random);
}

/**
 * GET over IPv4 only, as server/providers/firms.js does (#68): Node's
 * address auto-selection gives each address a short connect timeout, and
 * connecting to GDELT from here took longer (UND_ERR_CONNECT_TIMEOUT).
 * Redirects are not followed. Resolves to a fetch-style Response.
 */
export function getIpv4(url, { signal, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const request = https.request(
      url,
      {
        method: 'GET',
        signal,
        headers,
        family: 4,
        autoSelectFamily: false,
        agent: false,
      },
      (response) => {
        try {
          const status = response.statusCode || 500;
          if (status < 200 || status > 599)
            throw new Error(`GDELT answered ${status}`);
          resolve(
            new Response(Readable.toWeb(response), {
              status,
              statusText: response.statusMessage || '',
            }),
          );
        } catch (error) {
          response.destroy();
          reject(error);
        }
      },
    );
    request.on('error', reject);
    request.end();
  });
}
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
  fetchImpl = getIpv4,
  now = () => Date.now(),
  warn = (...args) => console.warn(...args),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random = Math.random,
} = {}) {
  let candidates = [];
  let fetchedAt = null;
  let error = null;
  let lastError = null;
  let lastAttemptAt = null;
  let failures = 0;
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
        if (!e.retryable || i >= MAX_ATTEMPTS - 1) throw e;
        warn(`[banking-access] news candidates: ${e.message}; retrying`);
        await sleep(attemptPause(i, random));
      }
    }
    const payload = await readResponseJsonCapped(response, MAX_BYTES);
    // An answer without an articles list (an error object, a changed schema)
    // is a failure, never a quiet day with zero leads.
    if (!Array.isArray(payload?.articles))
      throw new Error('GDELT answer has no articles list');
    candidates = candidatesFromArticles(payload, { knownUrls });
    fetchedAt = now();
    error = null;
    failures = 0;
  }

  // ok: the list is from the last hour's refresh; starting: none yet and
  // none failed; degraded: the last refresh failed (an empty or old list is
  // NOT a quiet day); circuit_open: several failed in a row, backing off.
  // stale: the last good list is over two hours old (nobody asked for a
  // refresh since, or one is running now).
  function status() {
    if (!enabled) return 'disabled';
    if (failures >= CIRCUIT_OPEN_AFTER) return 'circuit_open';
    if (failures > 0) return 'degraded';
    if (fetchedAt == null) return 'starting';
    return now() - fetchedAt > 2 * REFRESH_MS ? 'stale' : 'ok';
  }

  return {
    snapshot({ knownUrls } = {}) {
      if (enabled && !running && now() >= nextAt) {
        nextAt = now() + REFRESH_MS;
        lastAttemptAt = now();
        running = refresh(knownUrls)
          .catch((e) => {
            // GDELT answers rate limits and outages with plain text.
            error = 'news_unavailable';
            failures += 1;
            lastError = String(e?.message ?? e).slice(0, 200);
            nextAt = now() + refreshBackoff(failures, random);
            warn('[banking-access] news candidates:', e?.message ?? e);
          })
          .finally(() => {
            running = null;
          });
      }
      return {
        enabled,
        status: status(),
        fetchedAt,
        error,
        lastError: enabled ? lastError : null,
        lastAttemptAt: enabled ? lastAttemptAt : null,
        consecutiveFailures: enabled ? failures : 0,
        // While a refresh is running, the next attempt is that one.
        nextAttemptAt: enabled && nextAt && !running ? nextAt : null,
        refreshing: Boolean(running),
        source: enabled ? 'GDELT DOC 2.0' : null,
        candidates: enabled ? candidates : [],
      };
    },
    /** Tests: wait for a refresh in flight. */
    settle: () => running ?? Promise.resolve(),
  };
}
