// Same-origin client for /api/intel. Portable: the caller supplies fetch.
// Responses are data; nothing here interprets event text.

const BASE = '/api/intel';

/** @param {{fetchImpl: Function}} options */
export function createIntelClient({ fetchImpl }) {
  async function call(path, { method = 'GET', body, signal } = {}) {
    const response = await fetchImpl(`${BASE}${path}`, {
      method,
      signal,
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
    archive: (limit = 20, signal) =>
      call(`/archive?limit=${limit}`, { signal }),
    updateSettings: (settings) =>
      call('/settings', { method: 'PUT', body: settings }),
    resetSettings: () => call('/settings', { method: 'DELETE', body: {} }),
    startReplay: (scenario, speed) =>
      call('/replay', { method: 'POST', body: { scenario, speed } }),
    stopReplay: () => call('/replay', { method: 'DELETE', body: {} }),
    replay: (signal) => call('/replay', { signal }),
  };
}
