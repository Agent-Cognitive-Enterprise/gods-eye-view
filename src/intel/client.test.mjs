import test from 'node:test';
import assert from 'node:assert/strict';
import { createIntelClient } from './client.js';

/** A server that never answers, but honours abort like fetch does. */
const silent = (url, { signal }) =>
  new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason));
  });

test('a request the server never answers gives up instead of hanging', async () => {
  const client = createIntelClient({ fetchImpl: silent, timeoutMs: 10 });
  await assert.rejects(client.events('live'), { name: 'TimeoutError' });
});

test('the caller can still cancel', async () => {
  const client = createIntelClient({ fetchImpl: silent, timeoutMs: 60_000 });
  const abort = new AbortController();
  const pending = client.events('live', abort.signal);
  abort.abort(new Error('page closed'));
  await assert.rejects(pending, /page closed/);
});

test('a slow answer inside the limit still arrives', async () => {
  const client = createIntelClient({
    timeoutMs: 1000,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ events: [1] }),
    }),
  });
  assert.deepEqual(await client.events('live'), { events: [1] });
});
