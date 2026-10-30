// Same-origin client for the air/sea density service (fork feature).
// A portable export: no i18n here; the Layers panel translates failures.
const msg = (text) => text;

export function createAirSeaSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  async function get(path, signal) {
    const response = await fetchImpl(path, { signal });
    if (!response.ok) {
      const error = new Error(
        response.status === 404
          ? msg('Air/sea monitoring is not enabled on this server')
          : msg('Air/sea density unavailable'),
      );
      error.retryable = response.status !== 404;
      throw error;
    }
    return response.json();
  }
  return {
    /**
     * @param {{domain: 'air'|'sea', resolution: number, windowMs: number,
     *   box?: number[]|null}} query
     */
    getDensity({ domain, resolution, windowMs, box = null }, { signal } = {}) {
      const params = new URLSearchParams({
        domain,
        res: String(resolution),
        window: String(windowMs),
      });
      if (box) params.set('box', box.map((v) => v.toFixed(3)).join(','));
      return get(`/api/airsea/density?${params}`, signal);
    },
    getSources({ signal } = {}) {
      return get('/api/airsea/sources', signal);
    },
    /** Active and scheduled warning areas, with the state of every source. */
    getWarnings({ signal } = {}) {
      return get('/api/airsea/warnings', signal);
    },
    getWarning(id, { signal } = {}) {
      return get(`/api/airsea/warnings/${encodeURIComponent(id)}`, signal);
    },
  };
}
