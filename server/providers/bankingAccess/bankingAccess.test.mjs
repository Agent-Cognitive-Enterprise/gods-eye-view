import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  bankingAccessProxy,
  bankingAccessSnapshot,
  loadEvents,
  loadPopulation,
} from './index.js';
import {
  candidatesFromArticles,
  createNewsCandidates,
  newsUrl,
} from './news.js';

const NOW = Date.UTC(2026, 10, 8, 12);

function tempFile(content) {
  const dir = mkdtempSync(path.join(tmpdir(), 'gev-banking-'));
  const file = path.join(dir, 'events.json');
  writeFileSync(file, JSON.stringify(content));
  return file;
}

function call(plugin, { method = 'GET', url = '/' } = {}) {
  let handler;
  plugin.configureServer({
    middlewares: { use: (_route, fn) => (handler = fn) },
  });
  return new Promise((resolve) => {
    const res = {
      destroyed: false,
      headers: {},
      statusCode: 200,
      writeHead(status, headers) {
        this.statusCode = status;
        Object.assign(this.headers, headers);
      },
      setHeader(name, value) {
        this.headers[name] = value;
      },
      end(body) {
        resolve({ status: this.statusCode, body: JSON.parse(body) });
      },
    };
    handler(
      {
        method,
        url,
        headers: { host: '127.0.0.1:4173', 'sec-fetch-site': 'same-origin' },
        socket: { remoteAddress: '127.0.0.1' },
      },
      res,
    );
  });
}

test('the bundled events are all valid and sourced', () => {
  const { events, problems } = loadEvents();
  assert.deepEqual(problems, []);
  assert.ok(events.length >= 1);
  for (const e of events) assert.ok(e.sources.length >= 1, e.id);
});

test('the population table covers the bundled countries', () => {
  const { table, meta } = loadPopulation();
  assert.ok(table.get('LBN').population > 1_000_000);
  assert.ok(table.get('JPN').population > 100_000_000);
  for (const iso3 of ['KOS', 'PSX', 'SDS'])
    assert.ok(table.get(iso3), `${iso3}: the World Bank's code is mapped`);
  assert.match(meta.license, /CC BY 4\.0/);
});

test("an operator's file adds and replaces events; bad entries are reported", () => {
  const local = tempFile({
    events: [
      {
        id: 'lbn-2019-withdrawal-limits',
        country_code: 'LBN',
        event_type: 'withdrawal_limits',
        severity: 3,
        confidence: 'official',
        start_time: '2019-10-17T00:00:00Z',
        sources: [{ url: 'https://example.org/lbn' }],
      },
      { id: 'broken', country_code: 'XX' },
      {
        id: 'twice',
        country_code: 'PSE',
        event_type: 'technical_outage',
        severity: 1,
        confidence: 'social',
        start_time: '2026-11-01T00:00:00Z',
        sources: [{ url: 'https://example.org/1' }],
      },
      {
        id: 'twice',
        country_code: 'PSE',
        event_type: 'technical_outage',
        severity: 2,
        confidence: 'social',
        start_time: '2026-11-01T00:00:00Z',
        sources: [{ url: 'https://example.org/2' }],
      },
    ],
  });
  const { events, problems } = loadEvents({ local });
  const lbn = events.find((e) => e.id === 'lbn-2019-withdrawal-limits');
  assert.equal(lbn.severity, 3);
  assert.equal(lbn.origin, 'local');
  assert.equal(problems.length, 2);
  assert.match(problems[0], /local: broken/);
  assert.match(problems[1], /twice: duplicate id/);
  assert.equal(events.find((e) => e.id === 'twice').severity, 2);
  assert.equal(events.find((e) => e.id === 'twice').iso3, 'PSX');
  const nope = path.join(tmpdir(), 'nope-banking.json');
  const missing = loadEvents({ local: nope });
  assert.deepEqual(missing.problems, ['local file: not found']);
  assert.ok(!missing.problems[0].includes(tmpdir()), 'no path to the browser');
});

test('the snapshot lists live countries; history adds past ones', () => {
  const { events } = loadEvents();
  const args = {
    events,
    population: loadPopulation(),
    news: createNewsCandidates(),
    now: NOW,
  };
  const live = bankingAccessSnapshot(args);
  assert.equal(live.schemaVersion, 1);
  assert.deepEqual(live.countries.map((c) => c.iso3).sort(), [
    'LBN',
    'PRY',
    'SRB',
  ]);
  const lbn = live.countries.find((c) => c.iso3 === 'LBN');
  assert.ok(lbn.population > 0);
  assert.equal(lbn.classes.share, 'unknown', 'no source counts it');
  assert.equal(lbn.stale, true, 'last verified in March');
  assert.equal(live.news.enabled, false);
  const soon = bankingAccessSnapshot({
    ...args,
    events: [
      ...events,
      { ...events[0], id: 'soon', startedAt: NOW + 86_400_000 },
    ],
  });
  assert.equal(soon.counts.upcoming, 1);
  assert.equal(soon.counts.fading, 0, 'not started is not fading');
  const past = bankingAccessSnapshot({
    ...args,
    events: [
      ...events,
      {
        ...events[0],
        id: 'old',
        iso3: 'JPN',
        startedAt: Date.UTC(2026, 0, 29),
        resolvedAt: Date.UTC(2026, 0, 30),
      },
    ],
    history: true,
  });
  assert.ok(past.countries.some((c) => c.iso3 === 'JPN' && c.historical));
});

test('the route answers GET only, on its own path', async () => {
  const plugin = bankingAccessProxy({ env: {}, now: () => NOW });
  const ok = await call(plugin);
  assert.equal(ok.status, 200);
  assert.ok(Array.isArray(ok.body.countries));
  assert.equal((await call(plugin, { method: 'POST' })).status, 405);
  assert.equal((await call(plugin, { url: '/x' })).status, 404);
  const history = await call(plugin, { url: '/?history=1' });
  assert.ok(Array.isArray(history.body.countries));
});

test('a relative operator path is refused and reported', async () => {
  const plugin = bankingAccessProxy({
    env: { GEV_BANKING_ACCESS_EVENTS: 'events.json' },
    now: () => NOW,
  });
  const { body } = await call(plugin);
  assert.ok(body.problems.some((p) => /absolute path/.test(p)));
});

test('news candidates: http links only, one per headline, known URLs dropped', () => {
  const out = candidatesFromArticles(
    {
      articles: [
        {
          url: 'https://a.example/1',
          title: 'Bank run in X',
          seendate: '20261108T093000Z',
          domain: 'a.example',
          sourcecountry: 'X',
        },
        { url: 'https://b.example/2', title: 'Bank run in X!' },
        { url: 'javascript:alert(1)', title: 'bad' },
        { url: 'https://c.example/3', title: '' },
        { url: 'https://known.example/4', title: 'Known one' },
        {
          url: 'https://d.example/5',
          title: 'Capital controls\u0007 imposed',
          seendate: '20261108T100000Z',
        },
      ],
    },
    { knownUrls: new Set(['https://known.example/4']) },
  );
  assert.deepEqual(
    out.map((c) => c.url),
    ['https://d.example/5', 'https://a.example/1'],
  );
  assert.equal(out[0].title, 'Capital controls imposed');
  assert.equal(out[1].seenAt, Date.UTC(2026, 10, 8, 9, 30));
  assert.match(newsUrl(), /api\.gdeltproject\.org\/api\/v2\/doc\/doc\?/);
});

test('news is fetched only when enabled, at most hourly, and failures back off', async () => {
  let calls = 0;
  let clock = NOW;
  let fail = false;
  const fetchImpl = async () => {
    calls++;
    if (fail) return { ok: false, status: 429, body: { cancel() {} } };
    return new Response(
      JSON.stringify({
        articles: [{ url: 'https://a.example/1', title: 'Bank run' }],
      }),
    );
  };
  const off = createNewsCandidates({ enabled: false, fetchImpl });
  assert.deepEqual(off.snapshot().candidates, []);
  assert.equal(calls, 0);
  const pauses = [];
  const news = createNewsCandidates({
    enabled: true,
    fetchImpl,
    now: () => clock,
    warn() {},
    sleep: async (ms) => pauses.push(ms),
  });
  assert.equal(news.snapshot().candidates.length, 0, 'first call starts it');
  await news.settle();
  assert.equal(news.snapshot().candidates.length, 1);
  assert.equal(calls, 1);
  clock += 30 * 60_000;
  news.snapshot();
  assert.equal(calls, 1, 'not again within the hour');
  clock += 31 * 60_000;
  fail = true;
  news.snapshot();
  await news.settle();
  assert.equal(calls, 4, 'a 429 is tried three times');
  assert.deepEqual(pauses, [6_000, 15_000], 'spaced past the 5 s limit');
  const after = news.snapshot();
  assert.equal(after.error, 'news_unavailable');
  assert.equal(after.candidates.length, 1, 'the last list stays');
  clock += 10 * 60_000;
  news.snapshot();
  assert.equal(calls, 4, 'backs off 15 minutes after a failure');
});

test('a transient failure is retried and recovers; a 404 is not retried', async () => {
  let calls = 0;
  const warnings = [];
  const flaky = async () => {
    calls++;
    if (calls === 1)
      throw Object.assign(new TypeError('fetch failed'), {
        cause: { code: 'UND_ERR_CONNECT_TIMEOUT' },
      });
    if (calls === 2) return { ok: false, status: 429, body: { cancel() {} } };
    return new Response(
      JSON.stringify({
        articles: [{ url: 'https://a.example/1', title: 'X' }],
      }),
    );
  };
  const news = createNewsCandidates({
    enabled: true,
    fetchImpl: flaky,
    now: () => NOW,
    warn: (m) => warnings.push(String(m)),
    sleep: async () => {},
  });
  news.snapshot();
  await news.settle();
  assert.equal(calls, 3);
  assert.equal(news.snapshot().candidates.length, 1);
  assert.equal(news.snapshot().error, null);
  assert.match(
    warnings[0],
    /fetch failed \(UND_ERR_CONNECT_TIMEOUT\); retrying/,
  );
  let gone = 0;
  const missing = createNewsCandidates({
    enabled: true,
    fetchImpl: async () => (gone++, { ok: false, status: 404, body: null }),
    now: () => NOW,
    warn() {},
    sleep: async () => {},
  });
  missing.snapshot();
  await missing.settle();
  assert.equal(gone, 1);
  assert.equal(missing.snapshot().error, 'news_unavailable');
});
