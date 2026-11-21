import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  CABLE_SOURCES,
  cableConnector,
  checkWithModel,
  pollCableSources,
  readShadowState,
} from './cables.js';
import { intelConnectors } from '../index.js';
import { catalogueNames } from '../../../../src/intel/cableInbox.js';

const names = catalogueNames({
  features: [{ properties: { id: 'c-lion1', name: 'C-Lion1' } }],
});
const source = {
  id: 'op',
  format: 'rss',
  url: 'https://op.example/rss',
  sourceKind: 'operator',
  cables: ['c-lion1'],
};
const rss = (items) =>
  `<rss><channel>${items
    .map(
      ([title, slug, date]) =>
        `<item><title>${title}</title><link>https://op.example/n/${slug}</link><pubDate>${date}</pubDate></item>`,
    )
    .join('')}</channel></rss>`;
const OLD = ['New CEO', 'ceo', 'Fri, 01 Nov 2024 09:00:00 GMT'];
const FAULT = [
  'A fault in the C-Lion1 submarine cable',
  'fault',
  'Mon, 18 Nov 2024 09:00:00 GMT',
];
const REPAIRED = [
  'C-Lion1 submarine cable has been repaired',
  'repaired',
  'Fri, 29 Nov 2024 09:00:00 GMT',
];

function feed(body) {
  const fetchImpl = async (url) =>
    url === source.url
      ? new Response(feed.body)
      : new Response('missing', { status: 404 });
  feed.body = body;
  return fetchImpl;
}

test('the first poll records a baseline; later notices are judged and logged', async () => {
  const fetchImpl = feed(rss([OLD]));
  const poll = (state, at) =>
    pollCableSources({
      sources: [source],
      state,
      names,
      fetchImpl,
      now: () => Date.parse(at),
    });
  const first = await poll(
    readShadowState('/nonexistent'),
    '2024-11-17T00:00:00Z',
  );
  assert.deepEqual(first.lines, []);
  assert.ok(first.state.baselines.op);
  feed.body = rss([FAULT, OLD]);
  const second = await poll(first.state, '2024-11-18T10:00:00Z');
  assert.deepEqual(
    second.lines.map((l) => [l.signal, l.change, l.cables]),
    [['clear', 'would-show', ['c-lion1']]],
  );
  assert.equal(second.state.incidents['c-lion1'].status, 'open');
  feed.body = rss([REPAIRED, FAULT, OLD]);
  const third = await poll(second.state, '2024-11-30T00:00:00Z');
  assert.deepEqual(
    third.lines.map((l) => [l.claim, l.change, l.breakConfirmed]),
    [['restored', 'would-close', false]],
  );
  assert.equal(third.state.incidents['c-lion1'].status, 'closed');
  // Nothing new: nothing logged.
  const fourth = await poll(third.state, '2024-12-01T00:00:00Z');
  assert.deepEqual(fourth.lines, []);
});

test('only red flags are logged, and doubt is logged with its reason', async () => {
  const fetchImpl = feed(rss([]));
  const base = {
    version: 1,
    seen: {},
    baselines: { op: 'x' },
    incidents: {},
  };
  feed.body = rss([
    OLD,
    [
      'Vessel seen near the C-Lion1 submarine cable',
      'vessel',
      'Tue, 19 Nov 2024 09:00:00 GMT',
    ],
  ]);
  const { lines } = await pollCableSources({
    sources: [source],
    state: base,
    names,
    fetchImpl,
    now: () => Date.parse('2024-11-20T00:00:00Z'),
  });
  assert.deepEqual(
    lines.map((l) => [l.priority, l.signal, l.reason]),
    [['threat', 'doubt', 'threat-wording-only']],
  );
});

test('the connector is shadow-only: no records, state and log in the intel folder', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-cables-'));
  try {
    const fetchImpl = feed(rss([OLD]));
    const connector = cableConnector({ dir, sources: [source], fetchImpl });
    assert.equal(connector.id, 'submarine-cables');
    assert.equal(connector.shadow, true);
    const first = await connector.poll({
      now: () => Date.parse('2024-11-17T00:00:00Z'),
    });
    assert.deepEqual(first.records, []);
    feed.body = rss([FAULT, OLD]);
    const second = await connector.poll({
      now: () => Date.parse('2024-11-18T10:00:00Z'),
    });
    assert.deepEqual(second.records, []);
    const log = fs
      .readFileSync(path.join(dir, 'cables-shadow.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(log.length, 1);
    assert.equal(log[0].change, 'would-show');
    const state = readShadowState(path.join(dir, 'cables-shadow-state.json'));
    assert.equal(state.incidents['c-lion1'].status, 'open');
    // Every source failing fails the poll, so the feed shows as failing.
    const down = cableConnector({
      dir,
      sources: [source],
      fetchImpl: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    });
    await assert.rejects(
      down.poll({ now: () => Date.now() }),
      /all cable sources failed/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the cable feed is listed only with GEV_INTEL_CABLES=1 and a folder', () => {
  const ids = (env, dir) =>
    intelConnectors({ env, dir }).map((connector) => connector.id);
  assert.equal(ids({}, '/tmp/x').includes('submarine-cables'), false);
  assert.equal(
    ids({ GEV_INTEL_CABLES: '1' }, null).includes('submarine-cables'),
    false,
  );
  assert.equal(
    ids({ GEV_INTEL_CABLES: '1' }, '/tmp/x').includes('submarine-cables'),
    true,
  );
  assert.deepEqual(
    ids({ GEV_INTEL_CABLES: '1', GEV_INTEL_OFFLINE: '1' }, '/tmp/x'),
    [],
  );
});

test('every source speaks only for cables in the bundled catalogue', () => {
  const catalogue = JSON.parse(
    fs.readFileSync(
      new URL(
        '../../../../src/data/local_data/telegeography_submarine_cables/cable-geo.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const known = new Set(catalogue.features.map((f) => f.properties.id));
  for (const s of CABLE_SOURCES)
    for (const cable of s.cables)
      assert.ok(known.has(cable), `${s.id}: ${cable}`);
  assert.deepEqual(
    CABLE_SOURCES.filter((s) => s.sourceKind === 'news').flatMap(
      (s) => s.cables,
    ),
    [],
  );
});

test('old news under a new address is not a new signal', async () => {
  const fetchImpl = feed(rss([]));
  const state = { version: 1, seen: {}, baselines: { op: 'x' }, incidents: {} };
  feed.body = rss([FAULT]);
  const { lines, state: next } = await pollCableSources({
    sources: [source],
    state,
    names,
    fetchImpl,
    now: () => Date.parse('2024-12-20T00:00:00Z'),
  });
  assert.deepEqual(
    lines.map((l) => [l.signal, l.reason]),
    [['doubt', 'stale-notice']],
  );
  assert.deepEqual(next.incidents, {});
});

test('a fault and its repair dated alike apply fault first', async () => {
  const fetchImpl = feed(rss([]));
  const state = { version: 1, seen: {}, baselines: { op: 'x' }, incidents: {} };
  const day = 'Mon, 18 Nov 2024 09:00:00 GMT';
  feed.body = rss([
    [REPAIRED[0], 'repaired', day],
    [FAULT[0], 'fault', day],
  ]);
  const { lines } = await pollCableSources({
    sources: [source],
    state,
    names,
    fetchImpl,
    now: () => Date.parse('2024-11-18T12:00:00Z'),
  });
  assert.deepEqual(
    lines.map((l) => l.change),
    ['would-show', 'would-close'],
  );
});

test('a corrupt state file is moved aside and the reset is logged', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-cables-'));
  try {
    const file = path.join(dir, 'cables-shadow-state.json');
    fs.writeFileSync(file, '{"version":1,"seen":{}}');
    const state = readShadowState(file, 42);
    assert.equal(state.reset, `${file}.corrupt-42`);
    assert.ok(fs.existsSync(`${file}.corrupt-42`));
    assert.equal(fs.existsSync(file), false);
    const { lines, state: next } = await pollCableSources({
      sources: [source],
      state,
      names,
      fetchImpl: feed(rss([OLD])),
      now: () => Date.parse('2024-11-17T00:00:00Z'),
    });
    assert.equal(lines[0].change, 'state-reset');
    assert.equal('reset' in next, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a listing page date dates the notice', async () => {
  const page = {
    ...source,
    id: 'page',
    format: 'page',
    url: 'https://op.example/news',
    pathPrefix: '/news/',
  };
  const html = `<a href="/news/fault"><span>18.11.2024</span><h3>A fault in the C-Lion1 submarine cable</h3><p>A fault has been detected.</p> Read full post</a>`;
  const fetchImpl = async () => new Response(html);
  const { lines } = await pollCableSources({
    sources: [page],
    state: { version: 1, seen: {}, baselines: { page: 'x' }, incidents: {} },
    names,
    fetchImpl,
    now: () => Date.parse('2024-11-19T00:00:00Z'),
  });
  assert.deepEqual(
    lines.map((l) => [l.signal, l.change, l.title]),
    [['clear', 'would-show', 'A fault in the C-Lion1 submarine cable']],
  );
});

function stubModel({ replies = [], status = 'online', busy = false } = {}) {
  const calls = [];
  return {
    calls,
    status: () => ({ status, model: 'stub' }),
    probe: async () => {},
    busy: async () => busy,
    async complete(messages, schema) {
      calls.push({ messages, schema });
      const next = replies.shift();
      if (next instanceof Error) throw next;
      return { text: JSON.stringify(next), latencyMs: 5 };
    },
  };
}

const ARTICLE_URL = 'https://op.example/n/update';
const pendingState = (extra = {}) => ({
  version: 1,
  seen: {},
  baselines: { op: 'x' },
  incidents: {},
  pending: [
    {
      item: {
        url: ARTICLE_URL,
        title: 'Update on the C-Lion1 situation',
        summary: '',
        publishedAt: '2024-11-18T09:00:00.000Z',
      },
      sourceId: 'op',
      seenAt: '2024-11-18T10:00:00.000Z',
      at: Date.parse('2024-11-18T09:00:00Z'),
      attempts: 0,
    },
  ],
  ...extra,
});
const articleFetch = async (url) =>
  url === ARTICLE_URL
    ? new Response(
        '<html><body><nav>menu</nav><article><p>A fault has been detected in the C-Lion1 submarine cable.</p></article></body></html>',
      )
    : new Response('missing', { status: 404 });
const FAULT_ANSWER = {
  about_incident: true,
  current: true,
  cable_id: 'c-lion1',
  claim: 'fault',
  started_on: '2024-11-18',
  quote: 'A fault has been detected in the C-Lion1 submarine cable',
};

test('a doubtful notice naming a cable is queued for the model', async () => {
  feed.body = rss([
    [
      'Update on the C-Lion1 submarine cable fault situation',
      'update',
      'Mon, 18 Nov 2024 09:00:00 GMT',
    ],
  ]);
  const { state } = await pollCableSources({
    sources: [source],
    state: { version: 1, seen: {}, baselines: { op: 'x' }, incidents: {} },
    names,
    fetchImpl: feed(feed.body),
    now: () => Date.parse('2024-11-18T10:00:00Z'),
  });
  assert.equal(state.pending.length, 1);
  assert.equal(state.pending[0].item.url, 'https://op.example/n/update');
});

test('incident wording that names no cable is queued too; other doubt is not', async () => {
  // The Nation, 2026-11-18: the headline names no cable, the article
  // names SEA-ME-WE 5.
  feed.body = rss([
    [
      'International submarine cable develops fault: PTA',
      'fault',
      'Wed, 18 Nov 2026 08:00:00 GMT',
    ],
    [
      'New submarine cable route planned',
      'route',
      'Wed, 18 Nov 2026 07:00:00 GMT',
    ],
  ]);
  const { state, lines } = await pollCableSources({
    sources: [source],
    state: { version: 1, seen: {}, baselines: { op: 'x' }, incidents: {} },
    names,
    fetchImpl: feed(feed.body),
    now: () => Date.parse('2026-11-18T10:00:00Z'),
  });
  assert.deepEqual(
    state.pending.map((p) => p.item.url),
    ['https://op.example/n/fault'],
  );
  assert.deepEqual(
    lines.map((l) => [l.priority, l.signal]),
    [
      ['mention', 'none'],
      ['incident', 'doubt'],
    ],
  );
});

test('news that names no cable is not queued, so power-cut stories cannot flood the model', async () => {
  const news = { ...source, sourceKind: 'news', cables: [] };
  feed.body = rss([
    [
      'K-Electric says cable faults behind power outages in Karachi',
      'power',
      'Wed, 18 Nov 2026 08:00:00 GMT',
    ],
  ]);
  const { state } = await pollCableSources({
    sources: [news],
    state: { version: 1, seen: {}, baselines: { op: 'x' }, incidents: {} },
    names,
    fetchImpl: feed(feed.body),
    now: () => Date.parse('2026-11-18T10:00:00Z'),
  });
  assert.deepEqual(state.pending ?? [], []);
});

test('a full queue drops the oldest news first, and one pass fetches at most five articles', async () => {
  const entry = (i, primary) => ({
    item: {
      url: `https://op.example/n/${primary ? 'p' : 'q'}${i}`,
      title: 'Cable fault',
      summary: '',
      publishedAt: '2026-11-18T09:00:00.000Z',
    },
    sourceId: primary ? 'op' : 'news',
    seenAt: '2026-11-18T10:00:00.000Z',
    at: Date.parse('2026-11-18T09:00:00Z'),
    primary,
    attempts: 0,
  });
  // 200 queued, the oldest an operator's; one more news item arrives.
  const pending = [entry(0, true)];
  for (let i = 1; i < 200; i += 1) pending.push(entry(i, false));
  feed.body = rss([
    [
      'Fault in the C-Lion1 cable expected to last',
      'new',
      'Wed, 18 Nov 2026 09:30:00 GMT',
    ],
  ]);
  const news = { ...source, id: 'news', sourceKind: 'news', cables: [] };
  const { state } = await pollCableSources({
    sources: [news],
    state: {
      version: 1,
      seen: {},
      baselines: { news: 'x' },
      incidents: {},
      pending,
    },
    names,
    fetchImpl: feed(feed.body),
    now: () => Date.parse('2026-11-18T10:00:00Z'),
  });
  assert.equal(state.pending.length, 200);
  assert.equal(state.pending[0].item.url, 'https://op.example/n/p0');
  assert.equal(
    state.pending.some((p) => p.item.url.endsWith('/q1')),
    false,
  );
  // Articles that name no cable use no model check, but still count.
  let fetches = 0;
  const llm = stubModel();
  await checkWithModel({
    state: { ...state, pending: state.pending.slice(1) },
    sources: [news],
    names,
    llm,
    fetchImpl: async () => {
      fetches += 1;
      return new Response('<article><p>Nothing here.</p></article>');
    },
    now: () => Date.parse('2026-11-18T10:00:00Z'),
  });
  assert.equal(fetches, 5);
  assert.equal(llm.calls.length, 0);
});

test('the new sources are checked feeds: Transworld speaks for SEA-ME-WE 5, the PTA is off', () => {
  const byId = new Map(CABLE_SOURCES.map((s) => [s.id, s]));
  assert.deepEqual(byId.get('transworld').cables, [
    'transworld-tw1',
    'seamewe-5',
  ]);
  for (const id of [
    'dawn-news',
    'propakistani',
    'telecom-review',
    'arab-news',
    'gulf-news',
  ])
    assert.equal(byId.get(id).sourceKind, 'news', id);
  // Its site timed out from here: listed in the example file, disabled.
  assert.equal(byId.has('pta-news'), false);
  for (const s of CABLE_SOURCES) assert.match(s.url, /^https:\/\//, s.id);
  assert.equal(
    new Set(CABLE_SOURCES.map((s) => s.id)).size,
    CABLE_SOURCES.length,
  );
});

test('the model confirms a queued operator notice from its summary, never from the article alone', async () => {
  // Quoted from the article body only: logged, never shown.
  const fromArticle = await checkWithModel({
    state: pendingState(),
    sources: [source],
    names,
    llm: stubModel({ replies: [FAULT_ANSWER] }),
    fetchImpl: articleFetch,
    now: () => Date.parse('2024-11-18T12:00:00Z'),
  });
  assert.equal(fromArticle.lines[0].signal, 'llm-unverified');
  assert.equal(fromArticle.lines[0].reason, 'quote-only-in-article');
  assert.deepEqual(fromArticle.state.incidents, {});
  const llm = stubModel({ replies: [FAULT_ANSWER] });
  const queued = pendingState();
  queued.pending[0].item.summary =
    'A fault has been detected in the C-Lion1 submarine cable.';
  const { state, lines } = await checkWithModel({
    state: queued,
    sources: [source],
    names,
    llm,
    fetchImpl: articleFetch,
    now: () => Date.parse('2024-11-18T12:00:00Z'),
  });
  assert.equal(lines[0].signal, 'llm-clear');
  assert.equal(lines[0].change, 'would-show');
  assert.equal(state.incidents['c-lion1'].status, 'open');
  assert.equal(state.pending.length, 0);
  // The article was read without its navigation, as data in the prompt.
  const user = llm.calls[0].messages[1].content;
  assert.match(user, /A fault has been detected in the C-Lion1/);
  assert.doesNotMatch(user, /menu/);
  assert.deepEqual(llm.calls[0].schema.properties.cable_id.enum, [
    'c-lion1',
    'none',
  ]);
});

test('a confirmed repair takes the date its sentence states, so an old repair closes nothing', async () => {
  const open = {
    'c-lion1': {
      cableId: 'c-lion1',
      status: 'open',
      openedAt: '2024-11-18T09:00:00.000Z',
      lastReportedAt: '2024-11-18T09:00:00.000Z',
      breakConfirmed: false,
      sourceId: 'op',
      sources: ['https://op.example/n/fault'],
    },
  };
  const queued = pendingState({ incidents: open });
  queued.pending[0].item.summary =
    'The C-Lion1 submarine cable has been repaired on 15 November.';
  queued.pending[0].item.publishedAt = '2024-11-19T09:00:00.000Z';
  queued.pending[0].at = Date.parse('2024-11-19T09:00:00Z');
  const { lines, state } = await checkWithModel({
    state: queued,
    sources: [source],
    names,
    llm: stubModel({
      replies: [
        {
          ...FAULT_ANSWER,
          claim: 'restored',
          started_on: '',
          quote: 'The C-Lion1 submarine cable has been repaired on 15 November',
        },
      ],
    }),
    fetchImpl: articleFetch,
    now: () => Date.parse('2024-11-19T12:00:00Z'),
  });
  assert.equal(lines[0].signal, 'llm-clear');
  assert.equal(lines[0].change, 'restore-before-incident');
  assert.equal(state.incidents['c-lion1'].status, 'open');
});

test('a made-up quote is rejected and changes nothing', async () => {
  const llm = stubModel({
    replies: [{ ...FAULT_ANSWER, quote: 'C-Lion1 was destroyed by sabotage' }],
  });
  const { state, lines } = await checkWithModel({
    state: pendingState(),
    sources: [source],
    names,
    llm,
    fetchImpl: articleFetch,
    now: () => Date.parse('2024-11-18T12:00:00Z'),
  });
  assert.deepEqual(
    lines.map((l) => [l.signal, l.reason]),
    [['llm-rejected', 'quote-not-in-notice']],
  );
  assert.deepEqual(state.incidents, {});
});

test('a busy, offline or foreground model leaves the queue as it is', async () => {
  for (const llm of [
    stubModel({ busy: true }),
    stubModel({ status: 'offline' }),
  ]) {
    const { state, lines } = await checkWithModel({
      state: pendingState(),
      sources: [source],
      names,
      llm,
      fetchImpl: articleFetch,
      now: () => Date.parse('2024-11-18T12:00:00Z'),
    });
    assert.deepEqual(lines, []);
    assert.equal(state.pending.length, 1);
    assert.equal(llm.calls.length, 0);
  }
  const llm = stubModel({ replies: [FAULT_ANSWER] });
  const { state } = await checkWithModel({
    state: pendingState(),
    sources: [source],
    names,
    llm,
    fetchImpl: articleFetch,
    now: () => Date.parse('2024-11-18T12:00:00Z'),
    foreground: () => true,
  });
  assert.equal(state.pending.length, 1);
  assert.equal(llm.calls.length, 0);
});

test('a failing model is retried, then the notice is dropped', async () => {
  let state = pendingState();
  const llm = stubModel({
    replies: [new Error('timeout'), new Error('timeout'), new Error('timeout')],
  });
  const run = () =>
    checkWithModel({
      state,
      sources: [source],
      names,
      llm,
      fetchImpl: articleFetch,
      now: () => Date.parse('2024-11-18T12:00:00Z'),
    });
  for (let i = 0; i < 2; i += 1) {
    const result = await run();
    state = result.state;
    assert.equal(state.pending.length, 1);
  }
  const last = await run();
  assert.equal(last.state.pending.length, 0);
  assert.match(last.lines[0].reason, /model-failed: timeout/);
});

test('stale notices are skipped and the hourly cap holds', async () => {
  const stale = await checkWithModel({
    state: pendingState(),
    sources: [source],
    names,
    llm: stubModel({ replies: [FAULT_ANSWER] }),
    fetchImpl: articleFetch,
    now: () => Date.parse('2024-12-20T12:00:00Z'),
  });
  assert.deepEqual(
    stale.lines.map((l) => [l.signal, l.reason]),
    [['llm-skipped', 'stale-notice']],
  );
  const at = Date.parse('2024-11-18T12:00:00Z');
  const capped = await checkWithModel({
    state: pendingState({
      modelChecks: Array.from({ length: 12 }, () => at - 1000),
    }),
    sources: [source],
    names,
    llm: stubModel({ replies: [FAULT_ANSWER] }),
    fetchImpl: articleFetch,
    now: () => at,
  });
  assert.deepEqual(capped.lines, []);
  assert.equal(capped.state.pending.length, 1);
});

test('an article redirected off the publisher site is not read', async () => {
  const llm = stubModel({ replies: [FAULT_ANSWER] });
  const offsite = async (url) =>
    url === ARTICLE_URL
      ? new Response(null, {
          status: 302,
          headers: { location: 'https://attacker.example/x' },
        })
      : new Response(
          '<article><p>A fault has been detected in the C-Lion1 submarine cable.</p></article>',
        );
  const { lines } = await checkWithModel({
    state: pendingState(),
    sources: [source],
    names,
    llm,
    fetchImpl: offsite,
    now: () => Date.parse('2024-11-18T12:00:00Z'),
  });
  assert.doesNotMatch(
    llm.calls[0].messages[1].content,
    /fault has been detected/,
  );
  assert.equal(lines[0].signal, 'llm-rejected');
});

test('related news inside the article cannot be quoted', async () => {
  const llm = stubModel({
    replies: [
      {
        ...FAULT_ANSWER,
        quote: 'Fault Detected in Cinia C-Lion1 Submarine Cable',
      },
    ],
  });
  const page = async () =>
    new Response(
      '<article><p>Cinia holds a preparedness exercise today.</p><div class="related-news"><h3>Fault Detected in Cinia C-Lion1 Submarine Cable</h3></div></article>',
    );
  const { lines, state } = await checkWithModel({
    state: pendingState(),
    sources: [source],
    names,
    llm,
    fetchImpl: page,
    now: () => Date.parse('2024-11-18T12:00:00Z'),
  });
  assert.equal(lines[0].reason, 'quote-not-in-notice');
  assert.deepEqual(state.incidents, {});
});

test('operator notices are checked before news, and a busy model is not a failure', async () => {
  const state = pendingState();
  state.pending.unshift({
    ...state.pending[0],
    sourceId: 'news',
    item: { ...state.pending[0].item, url: 'https://news.example/x' },
  });
  const llm = stubModel({ replies: [new Error('local model busy')] });
  const result = await checkWithModel({
    state,
    sources: [
      source,
      { ...source, id: 'news', sourceKind: 'news', cables: [] },
    ],
    names,
    llm,
    fetchImpl: articleFetch,
    now: () => Date.parse('2024-11-18T12:00:00Z'),
  });
  assert.equal(llm.calls.length, 1);
  assert.match(llm.calls[0].messages[1].content, /Update on the C-Lion1/);
  assert.equal(result.state.pending.length, 2);
  assert.equal(result.state.pending[1].attempts, 0);
  assert.deepEqual(result.state.modelChecks, []);
});
