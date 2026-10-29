import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createIntelEngine } from '../../../src/intel/engine.js';
import { createSqliteIntelStore } from './store.js';

const T0 = Date.parse('2026-10-29T00:00:00Z');
const DAY = 24 * 3600_000;

const report = (n, overrides = {}) => ({
  provider: 'fixture',
  source_item_id: `r-${n}`,
  publisher: `Outlet ${n}`,
  url: `https://outlet${n}.example/a`,
  category: 'civil_unrest',
  title: 'Crowds rally at parliament in Example City over fuel prices',
  summary: 'Protesters gathered outside parliament.',
  published_at: T0,
  location: { lat: 44.8, lon: 20.4, precision: 'city' },
  entities: ['parliament'],
  ...overrides,
});

test('the SQLite store runs the engine with the memory-store semantics', () => {
  const store = createSqliteIntelStore();
  const engine = createIntelEngine({ store, now: () => T0 });
  engine.ingest([report(1)]);
  const [dup] = engine.ingest([report(1, { source_item_id: 'repost' })]);
  assert.equal(dup.status, 'duplicate');
  const [second] = engine.ingest([
    report(2, {
      title: 'Police block parliament square as Example City protest grows',
      source_type: 'eyewitness',
    }),
  ]);
  assert.equal(second.status, 'material_update');
  const [event] = engine.activeEvents();
  assert.equal(event.verification, 'corroborated');
  assert.equal(event.duplicate_count, 1);
  assert.equal(store.evidenceFor(event.event_id).length, 2);
  assert.equal(store.revisions(event.event_id).length, 2);
  assert.deepEqual(store.stats(), {
    events: 1,
    observations: 2,
    duplicates_suppressed: 1,
  });
  store.close();
});

test('archive queries filter by category, provider, time and antimeridian bbox', () => {
  const store = createSqliteIntelStore();
  const engine = createIntelEngine({ store, now: () => T0 });
  engine.ingest([
    report(1),
    report(2, {
      category: 'natural_disaster',
      title: 'Flooding on Taveuni',
      entities: [],
      location: { lat: -16.8, lon: 179.9, precision: 'city' },
    }),
  ]);
  assert.equal(store.listEvents({ category: 'natural_disaster' }).length, 1);
  assert.equal(store.listEvents({ provider: 'nope' }).length, 0);
  assert.equal(
    store.listEvents({
      bbox: { west: 179, south: -20, east: -179, north: -10 },
    }).length,
    1,
  );
  assert.equal(store.listEvents({ since: T0 + 1 }).length, 0);
  store.close();
});

test('retention prunes old events with their evidence', () => {
  let now = T0;
  const store = createSqliteIntelStore({ retentionDays: 30, now: () => now });
  const engine = createIntelEngine({ store, now: () => now });
  engine.ingest([report(1)]);
  now = T0 + 31 * DAY;
  assert.equal(store.prune(), 1);
  assert.deepEqual(store.stats(), {
    events: 0,
    observations: 0,
    duplicates_suppressed: 0,
  });
  store.close();
});

test('a corrupt database file is set aside and replaced', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-intel-'));
  const file = path.join(dir, 'intel.sqlite');
  fs.writeFileSync(file, 'this is not a database');
  const warnings = [];
  const store = createSqliteIntelStore({ file, warn: (m) => warnings.push(m) });
  assert.equal(store.stats().events, 0);
  assert.equal(warnings.length, 1);
  assert.ok(fs.readdirSync(dir).some((name) => name.includes('.corrupt-')));
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('clear erases evidence and history', () => {
  const store = createSqliteIntelStore();
  const engine = createIntelEngine({ store, now: () => T0 });
  engine.ingest([report(1)]);
  store.clear();
  assert.equal(store.stats().events, 0);
  store.close();
});
