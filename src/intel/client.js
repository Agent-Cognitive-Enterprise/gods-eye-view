// Same-origin client for /api/intel. Portable: the caller supplies fetch.
// Responses are data; nothing here interprets event text.

const BASE = '/api/intel';
// A response that never comes must not hold the Autopilot loop for ever.
const TIMEOUT_MS = 20_000;

/** @param {{fetchImpl: Function, timeoutMs?: number}} options */
export function createIntelClient({ fetchImpl, timeoutMs = TIMEOUT_MS }) {
  async function call(path, { method = 'GET', body, signal } = {}) {
    const limit = AbortSignal.timeout(timeoutMs);
    const response = await fetchImpl(`${BASE}${path}`, {
      method,
      signal: signal ? AbortSignal.any([signal, limit]) : limit,
      headers:
        body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(payload?.error || `HTTP ${response.status}`);
      error.status = response.status;
      error.code = payload?.error ?? null;
      throw error;
    }
    return payload;
  }
  const world = (name) => (name === 'replay' ? '?world=replay' : '');
  return {
    status: (signal) => call('/status', { signal }),
    events: (name, signal) => call(`/events${world(name)}`, { signal }),
    detail: (id, name, signal) =>
      call(`/events/${encodeURIComponent(id)}${world(name)}`, { signal }),
    feeds: (signal) => call('/feeds', { signal }),
    ai: (signal) => call('/ai', { signal }),
    archive: (limit = 20, signal) =>
      call(`/archive?limit=${limit}`, { signal }),
    updateSettings: (settings) =>
      call('/settings', { method: 'PUT', body: settings }),
    resetSettings: () => call('/settings', { method: 'DELETE', body: {} }),
    startReplay: (scenario, speed) =>
      call('/replay', { method: 'POST', body: { scenario, speed } }),
    stopReplay: () => call('/replay', { method: 'DELETE', body: {} }),
    replay: (signal) => call('/replay', { signal }),
    fastStatus: (signal) => call('/fast/status', { signal }),
    fastSettings: (signal) => call('/fast/settings', { signal }),
    fastTimeline: (id, signal) =>
      call(`/fast/events/${encodeURIComponent(id)}`, { signal }),
    updateFastSettings: (settings) =>
      call('/fast/settings', { method: 'PUT', body: settings }),
    resolveFastAccount: (handle) =>
      call('/fast/resolve', { method: 'POST', body: { handle } }),
  };
}
