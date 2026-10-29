import test from 'node:test';
import assert from 'node:assert/strict';
import { smoke } from '../../scripts/smoke-autopilot.mjs';

/** A fake instance: route table of [status, body]. */
function server(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const { pathname, search } = new URL(url);
    const key = `${init.method ?? 'GET'} ${pathname}${search}`;
    calls.push(key);
    const [status, body] = routes[key] ?? [404, { error: 'unknown_route' }];
    return {
      status,
      text: async () =>
        typeof body === 'string' ? body : JSON.stringify(body),
    };
  };
  return { fetchImpl, calls };
}

const HEALTHY = {
  'GET /': [200, '<html><title>GEV</title></html>'],
  'GET /api/intel/status': [200, { enabled: true, store: { events: 3 } }],
  'GET /api/intel/feeds': [
    200,
    {
      feeds: [
        { id: 'usgs-earthquakes', status: 'healthy' },
        { id: 'who-don', status: 'offline' },
      ],
    },
  ],
  'GET /api/intel/events': [200, { events: [{}], clusters: [] }],
  'GET /api/intel/archive?limit=5': [200, { events: [] }],
  'GET /api/intel/replay': [200, { replay: null }],
  'POST /api/intel/replay': [200, { replay: {} }],
  'GET /api/intel/events?world=replay': [
    200,
    { events: [{ synthetic: true }], clusters: [{}] },
  ],
  'DELETE /api/intel/replay': [200, { replay: null }],
  'GET /api/intel/ai': [
    200,
    { state: 'offline', last_error: 'connection refused' },
  ],
  'GET /api/voice-local/status': [200, { enabled: false }],
};

test('smoke passes on a healthy build; environment problems are warnings', async () => {
  const { fetchImpl, calls } = server(HEALTHY);
  const result = await smoke({ url: 'http://127.0.0.1:4174' }, fetchImpl);
  assert.equal(result.ok, true);
  const level = Object.fromEntries(result.checks.map((c) => [c.name, c.level]));
  assert.equal(level['demo drill'], 'pass');
  assert.equal(level.feeds, 'warn', 'an offline feed is reported, not fatal');
  assert.equal(level['local model'], 'warn');
  assert.ok(calls.includes('DELETE /api/intel/replay'), 'the drill is stopped');
});

test('required services, a broken API or a running drill are handled', async () => {
  const strict = await smoke(
    { url: 'http://x', requireAi: true, requireVoice: true },
    server(HEALTHY).fetchImpl,
  );
  assert.equal(strict.ok, false);

  const disabled = await smoke(
    { url: 'http://x' },
    server({ ...HEALTHY, 'GET /api/intel/status': [200, { enabled: false }] })
      .fetchImpl,
  );
  assert.equal(disabled.ok, false);
  assert.equal(disabled.checks.length, 2, 'stops after the engine check');

  const busy = server({
    ...HEALTHY,
    'GET /api/intel/replay': [200, { replay: { scenario: 'demo' } }],
  });
  const result = await smoke({ url: 'http://x' }, busy.fetchImpl);
  assert.equal(result.ok, true);
  assert.ok(
    !busy.calls.some((c) => c.startsWith('POST /api/intel/replay')),
    'operator drill untouched',
  );
});

test('feeds still on their first poll are waited for, not reported degraded', async () => {
  let polls = 0;
  const routes = { ...HEALTHY };
  const { fetchImpl } = server(routes);
  const wrapped = async (url, init) => {
    if (new URL(url).pathname === '/api/intel/feeds') {
      polls += 1;
      const feeds =
        polls < 3
          ? [
              {
                id: 'gdacs-alerts',
                status: 'degraded',
                last_success_at: null,
                last_error: null,
              },
            ]
          : [{ id: 'gdacs-alerts', status: 'healthy', last_success_at: 1 }];
      return { status: 200, text: async () => JSON.stringify({ feeds }) };
    }
    return fetchImpl(url, init);
  };
  const result = await smoke(
    { url: 'http://x', feedWaitMs: 100, feedWaitStepMs: 1 },
    wrapped,
  );
  assert.equal(result.checks.find((c) => c.name === 'feeds').level, 'pass');
  assert.equal(polls, 3);
});
