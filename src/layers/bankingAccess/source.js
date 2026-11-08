import { readResponseJsonCapped } from '../../sources/httpBody.js';

// Same-origin client for the banking-access route (fork feature). A portable
// export: no i18n here; the Layers panel translates failures.
const msg = (text) => text;

export function createBankingAccessSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    /** Countries and events as of now; `history` adds what has faded out. */
    async getSnapshot({ history = false, signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl(
        `/api/banking-access${history ? '?history=1' : ''}`,
        { signal },
      );
      if (!response.ok) {
        await response.body?.cancel?.();
        const error = new Error(
          response.status === 404
            ? msg('Banking access monitor is not available on this server')
            : msg('Banking access monitor unavailable'),
        );
        error.retryable = response.status !== 404;
        throw error;
      }
      const payload = await readResponseJsonCapped(
        response,
        8 * 1024 * 1024,
        signal,
      );
      if (!Array.isArray(payload?.countries) || !Array.isArray(payload?.events))
        throw new Error(msg('Banking access monitor unavailable'));
      return payload;
    },
  };
}
