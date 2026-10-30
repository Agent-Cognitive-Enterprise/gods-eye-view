// Regression tests for the adversarial review of 30 October 2026 (server).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFeedRunner } from './feeds.js';
import { intelProxy, withoutPrivate } from './index.js';

function fakeReq({ method = 'GET', url = '/settings', address = '127.0.0.1' }) {
  return {
    method,
    url,
    headers: { host: 'localhost:4174' },
    socket: { remoteAddress: address },
    on() {},
  };
}
function fakeRes() {
  const res = {
    statusCode: 0,
    body: '',
    headersSent: false,
    writeHead(status) {
      res.statusCode = status;
      res.headersSent = true;
    },
    end(text = '') {
      res.body += text;
    },
  };
  return res;
}
async function call(plugin, req) {
  let handler;
  plugin.configureServer({
    middlewares: { use: (_path, fn) => (handler = fn) },
    httpServer: null,
  });
  const res = fakeRes();
  await handler(req, res);
  return { status: res.statusCode, json: JSON.parse(res.body || 'null') };
}

const settings = {
  homeLocations: [{ label: 'home', lat: -33.87, lon: 151.21 }],
  autopilotEnabled: false,
};
const service = {
  start() {},
  status: () => ({ enabled: true, settings }),
  settings: () => settings,
  listEvents: () => ({
    events: [{ event_id: 'evt_1', proximity: { place: 'home', km: 3 } }],
  }),
};

test('the operator places reach this computer only, never LAN viewers', async () => {
  const plugin = intelProxy({ service });
  const local = await call(plugin, fakeReq({}));
  assert.deepEqual(local.json.homeLocations, settings.homeLocations);
  for (const url of ['/settings', '/status', '/events']) {
    const lan = await call(plugin, fakeReq({ url, address: '192.168.1.50' }));
    const text = JSON.stringify(lan.json);
    assert.ok(!text.includes('homeLocations'), url);
    assert.ok(!text.includes('proximity'), url);
    assert.ok(!text.includes('151.21'), url);
  }
  assert.deepEqual(withoutPrivate([{ a: 1, proximity: 2 }]), [{ a: 1 }]);
});

test('a failing service answers 500 with a fixed code, never an unhandled rejection', async () => {
  const plugin = intelProxy({
    service: {
      ...service,
      settings: () => {
        throw new Error('SQLITE_BUSY at C:\\secret\\path');
      },
    },
  });
  const warn = console.warn;
  console.warn = () => {};
  try {
    const out = await call(plugin, fakeReq({}));
    assert.equal(out.status, 500);
    assert.deepEqual(out.json, { error: 'internal_error' });
  } finally {
    console.warn = warn;
  }
});

test('a batch whose ingest failed is fetched again instead of answered 304', async () => {
  let ingestCalls = 0;
  const conditionalHeaders = [];
  const fetchImpl = async (_url, init) => {
    conditionalHeaders.push(init.headers['If-None-Match'] ?? null);
    return new Response(JSON.stringify({ items: [1] }), {
      status: 200,
      headers: { etag: '"v1"' },
    });
  };
  const runner = createFeedRunner({
    connector: {
      id: 'test-feed',
      intervalMs: 60_000,
      async poll({ fetchJson }) {
        await fetchJson('https://feed.example/data');
        return {
          records: [
            {
              provider: 'test',
              source_item_id: 'x',
              published_at: Date.now(),
            },
          ],
        };
      },
    },
    now: () => Date.now(),
    fetchImpl,
    ingest: () => {
      ingestCalls += 1;
      if (ingestCalls === 1) throw new Error('SQLITE_BUSY');
      return [{ status: 'new_event' }];
    },
    log: () => {},
  });
  await runner.pollOnce();
  await runner.pollOnce();
  await runner.pollOnce();
  assert.deepEqual(conditionalHeaders, [null, null, '"v1"']);
});
