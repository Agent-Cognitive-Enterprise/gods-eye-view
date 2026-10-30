// Feed runner: one per connector. Owns polling, bounded HTTP, conditional
// requests, exponential backoff, a circuit breaker and the health status the
// operator sees. A failing feed never stops the others or the engine; "live"
// is only claimed while the newest observation is actually recent.

import {
  readResponseBytesCapped,
  readResponseJsonCapped,
  readResponseTextCapped,
} from '../common/http.js';
import { epochMs } from '../../../src/intel/evidence.js';

const TIMEOUT_MS = 20_000;
const MAX_BACKOFF_MS = 30 * 60_000;
const CIRCUIT_FAILURES = 5;
const CIRCUIT_OPEN_MS = 30 * 60_000;
const USER_AGENT = 'gods-eye-view-intel/0.1 (local early-warning console)';
const DAY = 24 * 3600_000;

/** The capped readers return the body, or {tooLarge, text|bytes}; normalise. */
async function readCapped(reader, response, maxBytes) {
  const out = await reader(response, maxBytes);
  if (out && typeof out === 'object' && 'tooLarge' in out) {
    if (out.tooLarge) throw new Error('response too large');
    return out.text ?? out.bytes ?? out.body;
  }
  return out;
}

/**
 * Health status from runner state (pure; unit-tested).
 * @returns {'healthy'|'degraded'|'stale'|'offline'|'disabled'|'requires_credentials'|'blocked_by_terms'}
 */
export function feedStatus(state, connector, now) {
  if (connector.blockedByTerms) return 'blocked_by_terms';
  if (state.disabled) return 'disabled';
  if (connector.requiresCredentials?.()) return 'requires_credentials';
  if (
    state.consecutive_failures >= 3 ||
    (!state.last_success_at && state.last_error)
  )
    return 'offline';
  if (state.consecutive_failures > 0) return 'degraded';
  if (!state.last_success_at) return 'degraded';
  if (now - state.last_success_at > 3 * connector.intervalMs + 60_000)
    return 'stale';
  if (
    connector.staleAfterMs &&
    state.latest_observation_at &&
    now - state.latest_observation_at > connector.staleAfterMs
  )
    return 'stale';
  return 'healthy';
}

/** Delay before the next poll: interval when healthy, exponential backoff when failing. */
export function nextDelayMs(state, connector) {
  if (state.consecutive_failures >= CIRCUIT_FAILURES) return CIRCUIT_OPEN_MS;
  if (!state.consecutive_failures) return connector.intervalMs;
  return Math.min(
    MAX_BACKOFF_MS,
    connector.intervalMs * 2 ** state.consecutive_failures,
  );
}

/**
 * @param {{connector: object, ingest: Function, now: () => number,
 *   fetchImpl?: Function, log?: Function, enabled?: boolean}} options
 */
export function createFeedRunner({
  connector,
  ingest,
  now,
  fetchImpl = (...args) => globalThis.fetch(...args),
  log = (...args) => console.warn(...args),
  enabled = true,
  // Records older than the store's retention would be archived on arrival and
  // pruned again, then re-ingested as "new" after every restart; skip them.
  maxRecordAgeMs = 90 * DAY,
}) {
  const state = {
    disabled: !enabled,
    last_attempt_at: null,
    last_success_at: null,
    last_error: null,
    consecutive_failures: 0,
    latest_observation_at: null,
    next_poll_at: null,
    last_batch: null,
  };
  const validators = new Map(); // url -> {etag, lastModified}
  let timer = null;
  let running = false;
  let inFlight = null;

  /**
   * Bounded GET with conditional-request validators remembered per URL.
   * `as`: 'json' | 'text' | 'bytes'.
   */
  async function fetchBody(
    url,
    {
      maxBytes = 4 * 1024 * 1024,
      as = 'json',
      accept = '*/*',
      timeoutMs = TIMEOUT_MS,
      conditional = true,
    } = {},
  ) {
    // Unconditional for URLs that change every poll (no validator to keep).
    const known = conditional ? validators.get(url) : null;
    const response = await fetchImpl(url, {
      headers: {
        Accept: accept,
        'User-Agent': USER_AGENT,
        ...(known?.etag ? { 'If-None-Match': known.etag } : {}),
        ...(known?.lastModified
          ? { 'If-Modified-Since': known.lastModified }
          : {}),
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 304) return { notModified: true, body: null };
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`HTTP ${response.status}`);
    }
    const body =
      as === 'text'
        ? await readCapped(readResponseTextCapped, response, maxBytes)
        : as === 'bytes'
          ? await readCapped(readResponseBytesCapped, response, maxBytes)
          : await readResponseJsonCapped(response, maxBytes);
    // Staged: kept only once the batch is ingested, so a failed ingest
    // is fetched again instead of being answered 304 next time.
    if (conditional)
      staged.set(url, {
        etag: response.headers.get('etag'),
        lastModified: response.headers.get('last-modified'),
      });
    return { notModified: false, body };
  }
  const fetchJson = (url, options = {}) =>
    fetchBody(url, { accept: 'application/json', ...options, as: 'json' });
  const fetchText = (url, options = {}) =>
    fetchBody(url, { ...options, as: 'text' });
  const fetchBytes = (url, options = {}) =>
    fetchBody(url, { ...options, as: 'bytes' });

  const staged = new Map(); // validators from the poll in progress

  async function pollOnce() {
    if (state.disabled) return null;
    // A feed waiting for a key, or barred by its terms, is reported, never polled.
    if (connector.blockedByTerms || connector.requiresCredentials?.())
      return null;
    if (inFlight) return inFlight;
    state.last_attempt_at = now();
    inFlight = (async () => {
      staged.clear();
      try {
        const result = await connector.poll({
          fetchJson,
          fetchText,
          fetchBytes,
          now,
        });
        const cutoff = now() - maxRecordAgeMs;
        const fresh = (result.records ?? []).filter(
          (r) =>
            (epochMs(r.occurred_at) ?? epochMs(r.published_at) ?? Infinity) >=
            cutoff,
        );
        const outcome = fresh.length
          ? ingest(fresh, { receivedAt: now() })
          : [];
        // The batch is stored: keep its validators and let the connector
        // mark what it consumed (product editions, export files).
        for (const [url, validator] of staged) validators.set(url, validator);
        result.commit?.();
        const counts = {};
        if (fresh.length < (result.records?.length ?? 0))
          counts.beyond_retention = result.records.length - fresh.length;
        for (const r of outcome) counts[r.status] = (counts[r.status] ?? 0) + 1;
        state.last_success_at = now();
        state.last_error = null;
        state.consecutive_failures = 0;
        if (
          Number.isFinite(result.latestObservationAt) &&
          result.latestObservationAt > 0
        )
          state.latest_observation_at = Math.max(
            state.latest_observation_at ?? 0,
            result.latestObservationAt,
          );
        state.last_batch = {
          records: result.records?.length ?? 0,
          not_modified: Boolean(result.notModified),
          outcomes: counts,
        };
        return state.last_batch;
      } catch (error) {
        state.consecutive_failures += 1;
        // Messages only; never response bodies, URLs with credentials or keys.
        state.last_error = String(error?.message || error).slice(0, 200);
        log(`[intel] ${connector.id} poll failed: ${state.last_error}`);
        return null;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  function schedule() {
    if (!running) return;
    const delay = nextDelayMs(state, connector);
    state.next_poll_at = now() + delay;
    timer = setTimeout(async () => {
      await pollOnce();
      schedule();
    }, delay);
    timer.unref?.();
  }

  return {
    id: connector.id,
    start() {
      if (running || state.disabled) return;
      running = true;
      pollOnce().then(schedule);
    },
    stop() {
      running = false;
      clearTimeout(timer);
      timer = null;
    },
    pollOnce,
    setEnabled(value) {
      state.disabled = !value;
      if (!value) this.stop();
    },
    health(at = now()) {
      return {
        id: connector.id,
        provider: connector.provider,
        url: connector.url,
        license: connector.license,
        attribution: connector.attribution,
        status: feedStatus(state, connector, at),
        interval_ms: connector.intervalMs,
        stale_after_ms: connector.staleAfterMs ?? null,
        ...state,
      };
    },
  };
}
