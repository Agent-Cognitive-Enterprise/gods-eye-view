import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  acceptProposal,
  buildReport,
  canonicalUrl,
  emptyInbox,
  formatReport,
  itemsFromFeed,
  itemsFromPage,
  pollIoda,
  pollSources,
  readSources,
  rejectProposal,
} from './cableInbox.js';

const feature = (id, name) => ({ properties: { id, name } });
const catalogue = {
  features: [
    feature('c-lion1', 'C-Lion1'),
    feature('estlink-2', 'Estlink 2'),
    feature('estlink-1', 'Estlink 1'),
  ],
};

const rss = (items) => `<?xml version="1.0"?><rss version="2.0"><channel>
<title>Operator news</title>${items
  .map(
    ([title, link, date, description = '']) =>
      `<item><title>${title}</title><link>${link}</link><description>${description}</description><pubDate>${date}</pubDate></item>`,
  )
  .join('')}</channel></rss>`;

const FAULT = [
  'A fault in the Cinia C-Lion1 submarine cable between Finland and Germany',
  'https://operator.example/en/news/c-lion1-fault?hsLang=en&amp;utm_source=rss',
  'Mon, 18 Nov 2024 09:00:00 GMT',
  '&lt;p&gt;The fault was detected at 04:04 &amp;#8211; cause unknown.&lt;/p&gt;',
];
const CEO = [
  'New CEO for the operator',
  'https://operator.example/en/news/new-ceo',
  'Fri, 01 Nov 2024 09:00:00 GMT',
];
const REPAIRED = [
  'The break in the C-Lion1 submarine cable has been repaired',
  'https://operator.example/en/news/c-lion1-repaired',
  'Fri, 29 Nov 2024 09:00:00 GMT',
];

function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const route =
      routes[url] ?? routes[new URL(url).origin + new URL(url).pathname];
    if (route instanceof Error) throw route;
    if (!route) return new Response('missing', { status: 404 });
    if (route.location)
      return new Response(null, {
        status: route.status ?? 302,
        headers: { location: route.location },
      });
    return new Response(route.body, { status: route.status ?? 200 });
  };
  return { fetchImpl, calls };
}

const operatorSource = {
  id: 'operator-news',
  format: 'rss',
  url: 'https://operator.example/en/news/rss.xml',
  sourceKind: 'operator',
  publisher: 'Operator',
};

test('sources are validated: HTTPS, known fields, a prefix for pages, unique ids', () => {
  const { sources, ioda } = readSources({ sources: [operatorSource] });
  assert.equal(sources[0].enabled, true);
  assert.equal(ioda.enabled, false);
  const bad = [
    { ...operatorSource, url: 'http://operator.example/rss' },
    { ...operatorSource, url: 'https://user:pw@operator.example/rss' },
    { ...operatorSource, sourceKind: 'blog' },
    { ...operatorSource, format: 'page' },
    { ...operatorSource, extra: true },
    { ...operatorSource, id: 'Has Spaces' },
  ];
  for (const source of bad)
    assert.throws(() => readSources({ sources: [source] }));
  assert.throws(() =>
    readSources({ sources: [operatorSource, operatorSource] }),
  );
  assert.equal(
    readSources({ sources: [operatorSource], ioda: { enabled: true } }).ioda
      .enabled,
    true,
  );
});

test('a notice is known by its URL without fragment or tracking parameters', () => {
  assert.equal(
    canonicalUrl('https://a.example/n?id=4&utm_source=x&hsLang=en#top'),
    'https://a.example/n?id=4',
  );
  assert.equal(
    canonicalUrl('/n/1', 'https://a.example/list'),
    'https://a.example/n/1',
  );
  assert.equal(canonicalUrl('http://a.example/n'), null);
  assert.equal(canonicalUrl('javascript:alert(1)'), null);
});

test('RSS and Atom items are read as plain text', () => {
  const [item] = itemsFromFeed(rss([FAULT]), operatorSource.url);
  assert.equal(item.url, 'https://operator.example/en/news/c-lion1-fault');
  assert.equal(
    item.summary,
    'The fault was detected at 04:04 – cause unknown.',
  );
  assert.equal(item.publishedAt, '2024-11-18T09:00:00.000Z');
  const atom = `<feed><entry><title>Estlink 2 fault</title><link rel="alternate" href="https://grid.example/n/1"/><updated>2023-12-25T12:00:00Z</updated><summary>Outage</summary></entry></feed>`;
  assert.deepEqual(itemsFromFeed(atom, 'https://grid.example/feed'), [
    {
      url: 'https://grid.example/n/1',
      title: 'Estlink 2 fault',
      summary: 'Outage',
      publishedAt: '2023-12-25T12:00:00.000Z',
    },
  ]);
  // Links that are not HTTPS are dropped.
  assert.deepEqual(
    itemsFromFeed(
      rss([['x', 'http://operator.example/x', '']]),
      operatorSource.url,
    ),
    [],
  );
});

test('a page source lists same-host article links under its prefix', () => {
  const html = `<a href="/en/news/c-lion1-fault">A fault in C-Lion1</a>
    <a href="/en/news/c-lion1-fault#more"><img alt=""></a>
    <a href='https://operator.example/en/news/page/2'>2</a>
    <a href="/en/news/rss.xml">RSS</a>
    <a href="/en/news/">All news</a>
    <a href="https://elsewhere.example/en/news/x">Elsewhere</a>
    <a href="/en/about">About</a>`;
  assert.deepEqual(
    itemsFromPage(html, 'https://operator.example/en/news', '/en/news/'),
    [
      {
        url: 'https://operator.example/en/news/c-lion1-fault',
        title: 'A fault in C-Lion1',
        summary: '',
        publishedAt: null,
      },
    ],
  );
});

test('the first poll records a baseline; later notices become proposals', async () => {
  let clock = Date.parse('2024-11-01T00:00:00Z');
  const now = () => clock;
  const feed = { body: rss([CEO]) };
  const { fetchImpl, calls } = fakeFetch({ [operatorSource.url]: feed });
  const sources = readSources({ sources: [operatorSource] }).sources;
  const first = await pollSources({
    sources,
    inbox: emptyInbox(),
    catalogue,
    fetchImpl,
    now,
  });
  assert.deepEqual(first.summary, [
    { source: 'operator-news', items: 1, added: 0, baseline: true },
  ]);
  assert.equal(first.inbox.proposals.length, 0);
  assert.equal(
    calls[0].init.headers['User-Agent'].includes('observe-only'),
    true,
  );

  clock = Date.parse('2024-11-18T10:00:00Z');
  feed.body = rss([FAULT, CEO]);
  const second = await pollSources({
    sources,
    inbox: first.inbox,
    catalogue,
    fetchImpl,
    now,
  });
  assert.equal(second.summary[0].added, 1);
  const [proposal] = second.inbox.proposals;
  assert.match(proposal.id, /^p-[0-9a-f]{16}$/);
  assert.equal(proposal.sourceKind, 'operator');
  assert.equal(proposal.suggestedClaim, 'fault');
  assert.deepEqual(
    proposal.cables.map((c) => c.cableId),
    ['c-lion1'],
  );
  assert.equal(proposal.seenAt, '2024-11-18T10:00:00.000Z');
  // The input inbox is unchanged, and a repeat poll adds nothing.
  assert.equal(first.inbox.proposals.length, 0);
  const third = await pollSources({
    sources,
    inbox: second.inbox,
    catalogue,
    fetchImpl,
    now,
  });
  assert.equal(third.inbox.proposals.length, 1);
});

test('a failing or redirected source is recorded and never stops the others', async () => {
  const sources = readSources({
    sources: [
      { ...operatorSource, id: 'down', url: 'https://down.example/rss' },
      { ...operatorSource, id: 'moved', url: 'https://moved.example/rss' },
      { ...operatorSource, id: 'big', url: 'https://big.example/rss' },
      operatorSource,
      {
        ...operatorSource,
        id: 'off',
        url: 'https://off.example/rss',
        enabled: false,
      },
    ],
  }).sources;
  const { fetchImpl, calls } = fakeFetch({
    'https://down.example/rss': new Error('connect ECONNREFUSED'),
    // HTTPS at both ends, plain HTTP in the middle: refused at the hop.
    'https://moved.example/rss': { location: 'http://moved.example/hop' },
    'http://moved.example/hop': { location: 'https://moved.example/final' },
    'https://moved.example/final': { body: rss([FAULT]) },
    'https://big.example/rss': { body: 'x'.repeat(2 * 1024 * 1024 + 1) },
    [operatorSource.url]: { body: rss([FAULT]) },
  });
  const { inbox, summary } = await pollSources({
    sources,
    inbox: emptyInbox(),
    catalogue,
    fetchImpl,
    now: () => Date.parse('2024-11-18T10:00:00Z'),
    includeExisting: true,
  });
  assert.equal(summary.length, 4);
  assert.match(summary[0].error, /ECONNREFUSED/);
  assert.match(summary[1].error, /HTTPS/);
  assert.equal(
    calls.some((c) => c.url.startsWith('http:')),
    false,
  );
  assert.match(summary[2].error, /too large/i);
  assert.equal(summary[3].added, 1);
  assert.equal(inbox.sources.down.baselineAt, null);
  assert.equal(inbox.proposals.length, 1);
  assert.equal(
    calls.some((c) => c.url.includes('off.example')),
    false,
  );
});

test('IODA is asked for country events in the window and summarised', async () => {
  const body = JSON.stringify({
    copyright: 'This data is Copyright (c) Georgia Tech Research Corporation.',
    data: [
      {
        location: 'country/FI',
        location_name: 'Finland',
        start: 1731895200,
        duration: 3600,
        datasource: 'gtr',
        method: 'sarima',
        score: 1,
      },
    ],
  });
  const { fetchImpl, calls } = fakeFetch({
    'https://api.ioda.inetintel.cc.gatech.edu/v2/outages/events': { body },
  });
  const ioda = await pollIoda({
    fetchImpl,
    now: () => Date.parse('2024-11-18T12:00:00Z'),
  });
  const query = new URL(calls[0].url).searchParams;
  assert.equal(query.get('entityType'), 'country');
  assert.equal(Number(query.get('until')) - Number(query.get('from')), 86400);
  assert.equal(ioda.outages[0].country, 'FI');
  assert.match(ioda.copyright, /Georgia Tech/);
});

async function inboxWithFault() {
  const { fetchImpl } = fakeFetch({
    [operatorSource.url]: { body: rss([FAULT]) },
  });
  const { inbox } = await pollSources({
    sources: readSources({ sources: [operatorSource] }).sources,
    inbox: emptyInbox(),
    catalogue,
    fetchImpl,
    now: () => Date.parse('2024-11-18T10:00:00Z'),
    includeExisting: true,
  });
  return inbox;
}

test('accepting a proposal adds one validated evidence row; rejecting keeps it out', async () => {
  const inbox = await inboxWithFault();
  const id = inbox.proposals[0].id;
  const base = {
    inbox,
    evidence: [],
    catalogue,
    proposal: id,
    incidentId: '2024-11-18',
    now: () => Date.parse('2024-11-20T00:00:00Z'),
  };
  const accepted = acceptProposal({
    ...base,
    claim: 'fault',
    effectiveAt: '2024-11-18T02:04:00Z',
  });
  assert.deepEqual(accepted.row, {
    id: `${id}-fault`,
    incidentId: '2024-11-18',
    cableId: 'c-lion1',
    claim: 'fault',
    sourceKind: 'operator',
    sourceUrl: 'https://operator.example/en/news/c-lion1-fault',
    effectiveAt: '2024-11-18T02:04:00Z',
    knownAt: '2024-11-18T10:00:00.000Z',
  });
  assert.deepEqual(accepted.outcome, { incident: true });
  assert.equal(accepted.inbox.proposals[0].status, 'accepted');
  assert.equal(inbox.proposals[0].status, 'new');
  // The same claim twice, a time after the notice was seen, or a bad claim.
  assert.throws(
    () =>
      acceptProposal({
        ...base,
        inbox: accepted.inbox,
        evidence: accepted.evidence,
        claim: 'fault',
        effectiveAt: '2024-11-18T02:04:00Z',
      }),
    /already in the evidence/,
  );
  assert.throws(
    () =>
      acceptProposal({
        ...base,
        claim: 'fault',
        effectiveAt: '2024-11-19T00:00:00Z',
      }),
    /effectiveAt cannot be after knownAt/,
  );
  assert.throws(
    () =>
      acceptProposal({
        ...base,
        claim: 'outage',
        effectiveAt: '2024-11-18T02:04:00Z',
      }),
    /claim must be/,
  );
  // A news source stays a lead even when accepted.
  const asNews = acceptProposal({
    ...base,
    claim: 'break',
    sourceKind: 'news',
    effectiveAt: '2024-11-18T02:04:00Z',
  });
  assert.deepEqual(asNews.outcome, { lead: 'non-primary-source' });
  // Recording another source kind or URL means it was found now.
  assert.equal(asNews.row.knownAt, '2024-11-20T00:00:00.000Z');
  const elsewhere = acceptProposal({
    ...base,
    claim: 'fault',
    sourceUrl: 'https://operator.example/en/news/found-later',
    effectiveAt: '2024-11-18T02:04:00Z',
  });
  assert.equal(elsewhere.row.knownAt, '2024-11-20T00:00:00.000Z');
  const rejected = rejectProposal({ inbox, proposal: id, reason: 'duplicate' });
  assert.equal(rejected.proposals[0].status, 'rejected');
  assert.throws(
    () =>
      acceptProposal({
        ...base,
        inbox: rejected,
        claim: 'fault',
        effectiveAt: '2024-11-18T02:04:00Z',
      }),
    /was rejected/,
  );
  assert.throws(
    () => rejectProposal({ inbox: accepted.inbox, proposal: id }),
    /already accepted/,
  );
});

test('a notice naming no single cable needs the reviewer to name it', async () => {
  const { fetchImpl } = fakeFetch({
    [operatorSource.url]: {
      body: rss([
        [
          'Estlink 1 and Estlink 2 damaged',
          'https://operator.example/en/news/two',
          'Wed, 11 Oct 2023 09:00:00 GMT',
        ],
      ]),
    },
  });
  const { inbox } = await pollSources({
    sources: readSources({ sources: [operatorSource] }).sources,
    inbox: emptyInbox(),
    catalogue,
    fetchImpl,
    now: () => Date.parse('2023-10-11T10:00:00Z'),
    includeExisting: true,
  });
  const base = {
    inbox,
    evidence: [],
    catalogue,
    proposal: inbox.proposals[0].id,
    claim: 'fault',
    incidentId: 'oct',
    effectiveAt: '2023-10-08T00:00:00Z',
    now: () => Date.parse('2023-10-12T00:00:00Z'),
  };
  assert.throws(() => acceptProposal(base), /Name the cable/);
  assert.equal(
    acceptProposal({ ...base, cableId: 'estlink-2' }).row.cableId,
    'estlink-2',
  );
});

test('the report shows yesterday-to-today changes, pending review and IODA apart', async () => {
  const inbox = await inboxWithFault();
  const { evidence, inbox: reviewed } = acceptProposal({
    inbox,
    evidence: [],
    catalogue,
    proposal: inbox.proposals[0].id,
    claim: 'fault',
    incidentId: '2024-11-18',
    effectiveAt: '2024-11-18T02:04:00Z',
    now: () => Date.parse('2024-11-18T11:00:00Z'),
  });
  const ioda = {
    from: '2024-11-17T12:00:00.000Z',
    until: '2024-11-18T12:00:00.000Z',
    copyright: 'Copyright notice',
    outages: [
      {
        country: 'FI',
        name: 'Finland',
        start: '2024-11-18T02:00:00.000Z',
        end: '2024-11-18T04:00:00.000Z',
        signals: [{ datasource: 'gtr' }],
      },
      {
        country: 'SE',
        name: 'Sweden',
        start: '2024-11-18T09:00:00.000Z',
        end: '2024-11-18T12:00:00.000Z',
        signals: [{ datasource: 'bgp' }],
      },
    ],
  };
  const today = buildReport({
    catalogue,
    evidence,
    inbox: reviewed,
    ioda,
    asOf: '2024-11-18T12:00:00Z',
  });
  assert.equal(today.since, '2024-11-17T12:00:00.000Z');
  assert.equal(today.changes.length, 1);
  assert.equal(today.changes[0].change, 'new');
  assert.equal(today.open.length, 1);
  assert.equal(today.pending.length, 0);
  const printed = formatReport(today);
  assert.match(printed, /c-lion1 \[2024-11-18\]: new, fault-confirmed/);
  assert.match(printed, /impact only, not cable attribution/);
  assert.match(
    printed,
    /FI Finland: 2024-11-18T02:00:00.000Z to 2024-11-18T04:00:00.000Z, gtr/,
  );
  assert.match(
    printed,
    /SE Sweden: 2024-11-18T09:00:00.000Z and still open at the end of the window, bgp/,
  );
  const tomorrow = buildReport({
    catalogue,
    evidence,
    inbox: reviewed,
    ioda: null,
    asOf: '2024-11-19T12:00:00Z',
  });
  assert.deepEqual(tomorrow.changes, []);
  assert.match(formatReport(tomorrow), /no change in the last 24 hours/);
  assert.match(formatReport(tomorrow), /not polled/);
  // A proposal waiting for review is listed with its cues.
  const waiting = formatReport(
    buildReport({
      catalogue,
      evidence: [],
      inbox,
      ioda: null,
      asOf: '2024-11-18T12:00:00Z',
    }),
  );
  assert.match(waiting, /Waiting for review: 1/);
  assert.match(waiting, /cables: c-lion1; suggested: fault/);
});

test('hostile markup is parsed in linear time and printed without escapes', () => {
  const started = performance.now();
  const lots = 2 * 1024 * 1024 - 200;
  itemsFromFeed(
    `<rss><item><title>${'&lt;'.repeat(lots / 4)}</title><link>https://operator.example/x</link></item></rss>`,
    operatorSource.url,
  );
  itemsFromFeed(
    `<rss><item><title>${'<![CDATA['.repeat(lots / 9)}</title></item></rss>`,
    operatorSource.url,
  );
  itemsFromPage(
    `<a href="/en/news/x">${'<'.repeat(lots)}</a>`,
    'https://operator.example/en/news',
    '/en/news/',
  );
  itemsFromPage(
    '<a href="/en/news/x">'.repeat(lots / 21),
    'https://operator.example/en/news',
    '/en/news/',
  );
  assert.ok(performance.now() - started < 5000);
  const [item] = itemsFromFeed(
    rss([
      [
        'All clear&#27;[2J&#x1b;[H &#8238;fake',
        'https://operator.example/en/news/a',
        '',
      ],
    ]),
    operatorSource.url,
  );
  assert.equal(item.title, 'All clear [2J [H fake');
});

test('feed links to other sites are proposed as news, whatever the source', async () => {
  const items = itemsFromFeed(
    rss([
      ['C-Lion1 cable fault', 'https://evil.example/x', ''],
      ['C-Lion1 cable fault', '//evil.example/protocol-relative', ''],
      ['C-Lion1 cable fault', 'https://www.operator.example/en/news/y', ''],
      ['No link at all', '', ''],
    ]),
    operatorSource.url,
  );
  assert.deepEqual(
    items.map((i) => [i.url, i.offHost ?? false]),
    [
      ['https://evil.example/x', true],
      ['https://www.operator.example/en/news/y', false],
    ],
  );
  const { fetchImpl } = fakeFetch({
    [operatorSource.url]: {
      body: rss([['C-Lion1 cable fault', 'https://evil.example/x', '']]),
    },
  });
  const { inbox } = await pollSources({
    sources: readSources({ sources: [operatorSource] }).sources,
    inbox: emptyInbox(),
    catalogue,
    fetchImpl,
    now: () => Date.parse('2024-11-18T10:00:00Z'),
    includeExisting: true,
  });
  assert.equal(inbox.proposals[0].sourceKind, 'news');
  assert.equal(inbox.proposals[0].offHost, true);
  const atom = `<feed><entry><title>t</title><link rel="replies" href="https://grid.example/c"/><link rel='alternate' href='https://grid.example/n/2'/></entry></feed>`;
  assert.equal(
    itemsFromFeed(atom, 'https://grid.example/feed')[0].url,
    'https://grid.example/n/2',
  );
});

test('page links follow the page’s own site, and skip comments, tags and feeds', () => {
  const html = `<!-- <a href="/en/news/hidden">hidden</a> -->
    <a data-href="/en/news/data" href="/en/news/real">Real</a>
    <a href="/en/news/tag/cables">Tag</a>
    <a href="/en/news/feed">Feed</a>`;
  assert.deepEqual(
    itemsFromPage(
      html,
      'https://www.operator.example/en/news',
      '/en/news/',
    ).map((i) => i.url),
    ['https://www.operator.example/en/news/real'],
  );
});

test('an empty first poll records no baseline; a source may be called constructor', async () => {
  const source = { ...operatorSource, id: 'constructor' };
  const feed = { body: rss([]) };
  const { fetchImpl } = fakeFetch({ [operatorSource.url]: feed });
  const poll = (inbox) =>
    pollSources({
      sources: readSources({ sources: [source] }).sources,
      inbox,
      catalogue,
      fetchImpl,
      now: () => Date.parse('2024-11-18T10:00:00Z'),
    });
  const empty = await poll(emptyInbox());
  assert.equal(empty.inbox.sources.constructor.baselineAt, null);
  assert.equal(Object.hasOwn(empty.inbox.sources, 'constructor'), true);
  feed.body = rss([FAULT, CEO]);
  const listed = await poll(JSON.parse(JSON.stringify(empty.inbox)));
  assert.deepEqual(listed.summary[0], {
    source: 'constructor',
    items: 2,
    added: 0,
    baseline: true,
  });
});

test('a notice reviewed days after it was seen is listed as reviewed that day', async () => {
  const inbox = await inboxWithFault();
  const { evidence, inbox: reviewed } = acceptProposal({
    inbox,
    evidence: [],
    catalogue,
    proposal: inbox.proposals[0].id,
    claim: 'fault',
    incidentId: '2024-11-18',
    effectiveAt: '2024-11-18T02:04:00Z',
    now: () => Date.parse('2024-11-21T09:00:00Z'),
  });
  const report = buildReport({
    catalogue,
    evidence,
    inbox: reviewed,
    ioda: null,
    asOf: '2024-11-21T12:00:00Z',
  });
  assert.deepEqual(report.changes, []);
  assert.equal(report.reviewed.length, 1);
  assert.equal(report.open.length, 1);
  assert.match(
    formatReport(report),
    /Reviewed in the last 24 hours: 1\n {2}p-[0-9a-f]{16} accepted as p-[0-9a-f]{16}-fault/,
  );
});

test('a weak match next to a strong one still needs the reviewer to name the cable', async () => {
  const local = {
    features: [feature('c-lion1', 'C-Lion1'), feature('echo', 'Echo')],
  };
  const { fetchImpl } = fakeFetch({
    [operatorSource.url]: {
      body: rss([
        [
          'Echo and C-Lion1 cable faults',
          'https://operator.example/en/news/z',
          '',
        ],
      ]),
    },
  });
  const { inbox } = await pollSources({
    sources: readSources({ sources: [operatorSource] }).sources,
    inbox: emptyInbox(),
    catalogue: local,
    fetchImpl,
    now: () => Date.parse('2024-11-18T10:00:00Z'),
    includeExisting: true,
  });
  assert.throws(
    () =>
      acceptProposal({
        inbox,
        evidence: [],
        catalogue: local,
        proposal: inbox.proposals[0].id,
        claim: 'fault',
        incidentId: 'x',
        effectiveAt: '2024-11-18T02:04:00Z',
        now: () => Date.parse('2024-11-19T00:00:00Z'),
      }),
    /Name the cable/,
  );
});

test('long attribute names cannot slow the Atom link reader', () => {
  const junk = `<entry><title>t</title>${`<link ${'a'.repeat(4090)}/>`.repeat(20)}</entry>`;
  const started = performance.now();
  const items = itemsFromFeed(
    `<feed>${junk.repeat(24)}<entry><link href="https://grid.example/n/3"/></entry></feed>`,
    'https://grid.example/feed',
  );
  assert.ok(performance.now() - started < 2000);
  assert.equal(items[0].url, 'https://grid.example/n/3');
  assert.equal(
    itemsFromFeed(
      `<feed><entry><link rel="ALTERNATE" href="https://grid.example/n/4"/></entry></feed>`,
      'https://grid.example/feed',
    )[0].url,
    'https://grid.example/n/4',
  );
  // An RSS link must be a full HTTPS URL, not text relative to the feed.
  assert.deepEqual(
    itemsFromFeed(rss([['t', 'not a url', '']]), operatorSource.url),
    [],
  );
});

test('a redirect without a Location fails at once', async () => {
  const { fetchImpl, calls } = fakeFetch({
    [operatorSource.url]: { location: ' ' },
  });
  const { summary } = await pollSources({
    sources: readSources({ sources: [operatorSource] }).sources,
    inbox: emptyInbox(),
    catalogue,
    fetchImpl,
    now: () => 0,
  });
  assert.match(summary[0].error, /without a Location/);
  assert.equal(calls.length, 1);
});

test('the report says when an accepted row stays a lead', async () => {
  const inbox = await inboxWithFault();
  const { evidence, inbox: reviewed } = acceptProposal({
    inbox,
    evidence: [],
    catalogue,
    proposal: inbox.proposals[0].id,
    claim: 'break',
    sourceKind: 'news',
    incidentId: 'x',
    effectiveAt: '2024-11-18T02:04:00Z',
    now: () => Date.parse('2024-11-18T11:00:00Z'),
  });
  assert.match(
    formatReport(
      buildReport({
        catalogue,
        evidence,
        inbox: reviewed,
        ioda: null,
        asOf: '2024-11-18T12:00:00Z',
      }),
    ),
    /accepted as p-[0-9a-f]{16}-break \(stays a lead: p-[0-9a-f]{16}-break non-primary-source\)/,
  );
});
