import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

test('the loader judges future dates by the clock it is given', () => {
  const local = tempFile({
    events: [
      {
        id: 'ahead',
        country_code: 'PSE',
        event_type: 'technical_outage',
        severity: 2,
        confidence: 'social',
        start_time: '2026-11-01T00:00:00Z',
        last_update_time: '2026-11-25T00:00:00Z',
        sources: [{ url: 'https://example.org/ahead' }],
      },
    ],
  });
  const early = loadEvents({ local, now: NOW });
  assert.equal(
    early.events.find((e) => e.id === 'ahead'),
    undefined,
  );
  assert.match(early.problems.join(' '), /last_update_time in the future/);
  const later = loadEvents({ local, now: Date.UTC(2026, 11, 1) });
  assert.ok(later.events.find((e) => e.id === 'ahead'));
  assert.equal(later.problems.length, 0);
});

test('a half-written operator file keeps its last good events, labelled degraded', () => {
  const entry = {
    id: 'kept-1',
    country_code: 'PSE',
    event_type: 'technical_outage',
    severity: 2,
    confidence: 'social',
    start_time: '2026-11-01T00:00:00Z',
    sources: [{ url: 'https://example.org/kept' }],
  };
  const local = tempFile({ events: [entry] });
  const first = loadEvents({ local, now: NOW });
  assert.ok(first.events.find((e) => e.id === 'kept-1'));
  assert.deepEqual(first.degraded, []);
  // A partial write: the reviewed incident stays, said to be from the last
  // good read, and the problem is listed.
  writeFileSync(local, '{"events": [{"id": "kept-1", "country');
  const torn = loadEvents({ local, now: NOW + 30_000, lastGood: first.good });
  assert.ok(torn.events.find((e) => e.id === 'kept-1'));
  assert.deepEqual(torn.degraded, [
    { origin: 'local', reason: 'not valid JSON', lastGoodAt: NOW },
  ]);
  assert.ok(
    torn.problems.some((p) =>
      /not valid JSON; showing its last good copy/.test(p),
    ),
  );
  // The last good copy is kept through repeated failures, with its own time.
  const again = loadEvents({ local, now: NOW + 60_000, lastGood: torn.good });
  assert.equal(again.degraded[0].lastGoodAt, NOW);
  // The snapshot carries the label to the browser.
  const snap = bankingAccessSnapshot({
    events: torn.events,
    problems: torn.problems,
    degraded: torn.degraded,
    population: loadPopulation(),
    news: createNewsCandidates({ enabled: false, now: () => NOW }),
    now: NOW,
  });
  assert.deepEqual(snap.degraded, torn.degraded);
  // Fixed: back to the file itself, no longer degraded.
  writeFileSync(local, JSON.stringify({ events: [{ ...entry, severity: 3 }] }));
  const fixed = loadEvents({ local, now: NOW + 90_000, lastGood: again.good });
  assert.deepEqual(fixed.degraded, []);
  assert.equal(fixed.events.find((e) => e.id === 'kept-1').severity, 3);
  // Without an earlier good read, nothing is invented.
  writeFileSync(local, '{');
  const never = loadEvents({ local, now: NOW });
  assert.equal(
    never.events.find((e) => e.id === 'kept-1'),
    undefined,
  );
  assert.deepEqual(never.degraded, []);
  // An emptied list is a good read: the operator's way to remove events.
  writeFileSync(local, JSON.stringify({ events: [] }));
  const emptied = loadEvents({ local, now: NOW, lastGood: first.good });
  assert.equal(
    emptied.events.find((e) => e.id === 'kept-1'),
    undefined,
  );
  assert.deepEqual(emptied.degraded, []);
});

test('every way a file can fail to read keeps the last good copy', () => {
  const entry = {
    id: 'kept-2',
    country_code: 'PSE',
    event_type: 'technical_outage',
    severity: 2,
    confidence: 'social',
    start_time: '2026-11-01T00:00:00Z',
    sources: [{ url: 'https://example.org/kept-2' }],
  };
  const local = tempFile({ events: [entry] });
  const { good } = loadEvents({ local, now: NOW });
  const cases = [
    ['{}', 'no "events" array'],
    ['{"events": null}', 'no "events" array'],
    ['', 'not valid JSON'],
    [' '.repeat(2 * 1024 * 1024 + 1), 'events file too large'],
  ];
  for (const [content, reason] of cases) {
    writeFileSync(local, content);
    const r = loadEvents({ local, now: NOW + 30_000, lastGood: good });
    assert.ok(
      r.events.find((e) => e.id === 'kept-2'),
      reason,
    );
    assert.deepEqual(r.degraded, [
      { origin: 'local', reason, lastGoodAt: NOW },
    ]);
  }
  const gone = path.join(path.dirname(local), 'moved-away.json');
  const r = loadEvents({ local: gone, now: NOW + 30_000, lastGood: good });
  assert.ok(r.events.find((e) => e.id === 'kept-2'));
  assert.equal(r.degraded[0].reason, 'not found');
  // The 2 MB file is not left behind.
  rmSync(path.dirname(local), { recursive: true, force: true });
});

test('an invalid entry in a readable file never replaces the last good copy', () => {
  const good = {
    id: 'valid-1',
    country_code: 'PSE',
    event_type: 'technical_outage',
    severity: 2,
    confidence: 'social',
    start_time: '2026-11-01T00:00:00Z',
    sources: [{ url: 'https://example.org/valid' }],
  };
  const local = tempFile({ events: [good] });
  const first = loadEvents({ local, now: NOW });
  assert.ok(first.events.find((e) => e.id === 'valid-1'));
  // Valid JSON, but the replacement entry lacks event_type and sources.
  const { event_type: _type, sources: _sources, ...broken } = good;
  writeFileSync(local, JSON.stringify({ events: [broken] }));
  const bad = loadEvents({ local, now: NOW + 30_000, lastGood: first.good });
  const kept = bad.events.find((e) => e.id === 'valid-1');
  assert.ok(kept, 'the reviewed incident stays on the map');
  assert.equal(kept.type, 'technical_outage');
  assert.deepEqual(bad.degraded, [
    { origin: 'local', reason: 'invalid entries', lastGoodAt: NOW },
  ]);
  // The invalid entry is listed once, and nothing else is counted.
  assert.deepEqual(bad.problems.filter((p) => p.startsWith('local')).length, 1);
  assert.ok(bad.problems.some((p) => /^local: valid-1: /.test(p)));
  // The bad edit did not become the copy: a torn write next still falls
  // back to the original, with its original time.
  writeFileSync(local, '{"events": [');
  const torn = loadEvents({ local, now: NOW + 60_000, lastGood: bad.good });
  assert.equal(
    torn.events.find((e) => e.id === 'valid-1').type,
    'technical_outage',
  );
  assert.deepEqual(torn.degraded, [
    { origin: 'local', reason: 'not valid JSON', lastGoodAt: NOW },
  ]);
  // Fixed: the new valid file is shown and becomes the copy.
  writeFileSync(local, JSON.stringify({ events: [{ ...good, severity: 4 }] }));
  const fixed = loadEvents({ local, now: NOW + 90_000, lastGood: torn.good });
  assert.deepEqual(fixed.degraded, []);
  assert.equal(fixed.events.find((e) => e.id === 'valid-1').severity, 4);
  assert.equal(fixed.good.get('local').at, NOW + 90_000);
  // An empty list still clears, as a valid file.
  writeFileSync(local, JSON.stringify({ events: [] }));
  const cleared = loadEvents({
    local,
    now: NOW + 120_000,
    lastGood: fixed.good,
  });
  assert.equal(
    cleared.events.find((e) => e.id === 'valid-1'),
    undefined,
  );
  assert.deepEqual(cleared.degraded, []);
});

test('without a last good copy, a file shows its valid entries and keeps only those', () => {
  const ok = {
    id: 'mixed-ok',
    country_code: 'PSE',
    event_type: 'technical_outage',
    severity: 2,
    confidence: 'social',
    start_time: '2026-11-01T00:00:00Z',
    sources: [{ url: 'https://example.org/mixed' }],
  };
  const local = tempFile({
    events: [ok, { id: 'mixed-bad', country_code: 'PSE' }],
  });
  const first = loadEvents({ local, now: NOW });
  assert.ok(first.events.find((e) => e.id === 'mixed-ok'));
  assert.ok(first.problems.some((p) => /^local: mixed-bad: /.test(p)));
  // DEGRADED from the first load, and the same on the next: the result does
  // not depend on whether a copy existed yet.
  const expected = [
    { origin: 'local', reason: 'invalid entries', lastGoodAt: NOW },
  ];
  assert.deepEqual(first.degraded, expected);
  const second = loadEvents({ local, now: NOW + 30_000, lastGood: first.good });
  assert.deepEqual(second.degraded, expected);
  assert.deepEqual(second.problems, first.problems);
  // Its copy holds the valid entry only: a torn write shows it and lists no
  // error for the invalid one again.
  assert.deepEqual(
    first.good.get('local').entries.map((e) => e.id),
    ['mixed-ok'],
  );
  writeFileSync(local, '{');
  const torn = loadEvents({ local, now: NOW + 30_000, lastGood: first.good });
  assert.ok(torn.events.find((e) => e.id === 'mixed-ok'));
  assert.ok(!torn.problems.some((p) => /mixed-bad/.test(p)));
});

test('the route keeps the last good operator events across reloads', async () => {
  const entry = {
    id: 'route-1',
    country_code: 'PSE',
    event_type: 'technical_outage',
    severity: 2,
    confidence: 'social',
    start_time: '2026-11-01T00:00:00Z',
    sources: [{ url: 'https://example.org/route' }],
  };
  const local = tempFile({ events: [entry] });
  let clock = NOW;
  const plugin = bankingAccessProxy({
    env: { GEV_BANKING_ACCESS_EVENTS: local },
    now: () => clock,
  });
  const before = await call(plugin);
  assert.deepEqual(before.body.degraded, []);
  writeFileSync(local, '{"events": [');
  clock += 31_000;
  const during = await call(plugin);
  assert.equal(during.body.degraded.length, 1);
  assert.equal(during.body.degraded[0].lastGoodAt, NOW);
  assert.ok(during.body.events.some((e) => e.id === 'route-1'));
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
  assert.match(out[0].id, /^news:d\.example:[0-9a-f]{16}$/);
  // The id follows the URL, not the headline.
  const again = candidatesFromArticles({
    articles: [{ url: 'https://d.example/5', title: 'Headline changed' }],
  });
  assert.equal(again[0].id, out[0].id);
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
    random: () => 0.5,
  });
  assert.equal(news.snapshot().status, 'starting');
  assert.equal(news.snapshot().candidates.length, 0, 'first call starts it');
  await news.settle();
  assert.equal(news.snapshot().candidates.length, 1);
  assert.equal(news.snapshot().status, 'ok');
  assert.equal(calls, 1);
  clock += 30 * 60_000;
  news.snapshot();
  assert.equal(calls, 1, 'not again within the hour');
  clock += 31 * 60_000;
  fail = true;
  news.snapshot();
  await news.settle();
  assert.equal(calls, 4, 'a 429 is tried three times');
  // Exponential with equal jitter (random 0.5): 30 s and 60 s bases.
  assert.deepEqual(pauses, [22_500, 45_000], 'spaced well past the 5 s limit');
  const after = news.snapshot();
  assert.equal(after.error, 'news_unavailable');
  assert.equal(
    after.status,
    'degraded',
    'a failed fetch is degraded, not a quiet day',
  );
  assert.equal(after.consecutiveFailures, 1);
  assert.match(after.lastError, /429/);
  assert.equal(after.candidates.length, 1, 'the last list stays');
  // 15 min with jitter 0.5: 11.25 min.
  assert.equal(after.nextAttemptAt, clock + 11.25 * 60_000);
  clock += 10 * 60_000;
  news.snapshot();
  assert.equal(calls, 4, 'backs off after a failure');
});

test('consecutive failures double the back-off, open the circuit, and a success closes it', async () => {
  let clock = NOW;
  let fail = true;
  let calls = 0;
  const news = createNewsCandidates({
    enabled: true,
    fetchImpl: async () => {
      calls++;
      if (fail) return { ok: false, status: 429, body: { cancel() {} } };
      return new Response(JSON.stringify({ articles: [] }));
    },
    now: () => clock,
    warn() {},
    sleep: async () => {},
    random: () => 1, // no jitter reduction: full delays
  });
  const waits = [];
  for (let k = 1; k <= 5; k++) {
    news.snapshot();
    await news.settle();
    const s = news.snapshot();
    assert.equal(s.consecutiveFailures, k);
    assert.equal(s.status, k >= 3 ? 'circuit_open' : 'degraded');
    waits.push((s.nextAttemptAt - clock) / 60_000);
    clock = s.nextAttemptAt; // the next request after the back-off
  }
  assert.deepEqual(waits, [15, 30, 60, 120, 240], 'doubling up to 4 h');
  assert.equal(calls, 15, 'three attempts per refresh, never more');
  // Capped at 4 h.
  news.snapshot();
  await news.settle();
  assert.equal((news.snapshot().nextAttemptAt - clock) / 60_000, 240);
  // A success closes the circuit and resets the count.
  clock = news.snapshot().nextAttemptAt;
  fail = false;
  news.snapshot();
  await news.settle();
  const ok = news.snapshot();
  assert.equal(ok.status, 'ok');
  assert.equal(ok.consecutiveFailures, 0);
  assert.equal(ok.error, null);
});

test('backoff helpers stay within their bounds', async () => {
  const { attemptPause, refreshBackoff, jittered } = await import('./news.js');
  for (const r of [0, 0.25, 0.999]) {
    assert.ok(
      jittered(1000, () => r) >= 500 && jittered(1000, () => r) <= 1000,
    );
    assert.ok(attemptPause(5, () => r) <= 60_000);
    assert.ok(refreshBackoff(20, () => r) <= 4 * 3600_000);
    assert.ok(refreshBackoff(1, () => r) >= 7.5 * 60_000);
  }
});

test('a timeout is retried too', async () => {
  let calls = 0;
  const news = createNewsCandidates({
    enabled: true,
    fetchImpl: async () => {
      calls++;
      if (calls < 3)
        throw new DOMException(
          'The operation was aborted due to timeout',
          'TimeoutError',
        );
      return new Response(JSON.stringify({ articles: [] }));
    },
    now: () => NOW,
    warn() {},
    sleep: async () => {},
  });
  news.snapshot();
  await news.settle();
  assert.equal(calls, 3);
  assert.equal(news.snapshot().error, null);
  assert.ok(news.snapshot().fetchedAt);
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

test('an answer without an articles list, bad JSON or a 400 is a failure, not a quiet day', async () => {
  for (const [label, impl, attempts] of [
    [
      'no articles list',
      async () => new Response(JSON.stringify({ error: 'x' })),
      1,
    ],
    ['bad JSON', async () => new Response('Please limit requests'), 1],
    ['400', async () => ({ ok: false, status: 400, body: { cancel() {} } }), 1],
  ]) {
    let calls = 0;
    const news = createNewsCandidates({
      enabled: true,
      fetchImpl: async (...a) => (calls++, impl(...a)),
      now: () => NOW,
      warn() {},
      sleep: async () => {},
    });
    news.snapshot();
    await news.settle();
    const s = news.snapshot();
    assert.equal(s.status, 'degraded', label);
    assert.equal(s.fetchedAt, null, label);
    assert.equal(calls, attempts, `${label}: not retried within the refresh`);
  }
  // An empty articles list is a real (quiet) answer.
  const quiet = createNewsCandidates({
    enabled: true,
    fetchImpl: async () => new Response(JSON.stringify({ articles: [] })),
    now: () => NOW,
    warn() {},
  });
  quiet.snapshot();
  await quiet.settle();
  assert.equal(quiet.snapshot().status, 'ok');
});

test('an old list reads stale, and no next attempt is promised while one runs', async () => {
  let clock = NOW;
  let release;
  const gate = new Promise((r) => (release = r));
  let calls = 0;
  const news = createNewsCandidates({
    enabled: true,
    fetchImpl: async () => {
      calls++;
      if (calls === 2) await gate;
      return new Response(JSON.stringify({ articles: [] }));
    },
    now: () => clock,
    warn() {},
  });
  news.snapshot();
  await news.settle();
  clock += 3 * 3600_000;
  const during = news.snapshot(); // starts a refresh, which waits on the gate
  assert.equal(during.status, 'stale');
  assert.equal(during.refreshing, true);
  assert.equal(during.nextAttemptAt, null);
  release();
  await news.settle();
  assert.equal(news.snapshot().status, 'ok');
});
