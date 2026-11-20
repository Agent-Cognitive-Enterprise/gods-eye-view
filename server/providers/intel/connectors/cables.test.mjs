import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  CABLE_SOURCES,
  cableConnector,
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
  'The break in the C-Lion1 submarine cable has been repaired',
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
    [['restored', 'would-close', true]],
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
