import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  indexSubmarineCables,
  replayCableIncidents,
} from './cableIncidents.js';

const feature = (id, name) => ({ properties: { id, name } });
const catalogue = {
  features: [
    feature('alpha', 'Alpha'),
    feature('alpha', 'Alpha'),
    feature('beta', 'Shared'),
    feature('gamma', 'Shared'),
  ],
};
const time = (day) => `2024-11-${day}T00:00:00Z`;
const row = (id, overrides = {}) => ({
  id,
  incidentId: 'first',
  cableName: 'Alpha',
  claim: 'fault',
  sourceKind: 'operator',
  sourceUrl: 'https://example.com/advisory',
  effectiveAt: time(18),
  knownAt: time(19),
  ...overrides,
});
const replay = (evidence, asOf = time(30)) =>
  replayCableIncidents({ catalogue, evidence, asOf });

test('resolves exact names and IDs without counting multipart geometry or guessing', () => {
  const { resolve } = indexSubmarineCables(catalogue);
  assert.deepEqual(resolve({ cableName: ' ALPHA ' }), { cableId: 'alpha' });
  assert.deepEqual(resolve({ cableName: 'Shared' }), {
    reason: 'ambiguous-cable-name',
  });
  assert.deepEqual(resolve({ cableName: 'Shared', cableId: 'gamma' }), {
    cableId: 'gamma',
  });
  assert.deepEqual(resolve({ cableName: 'Shared cable' }), {
    reason: 'unknown-cable-name',
  });
  assert.deepEqual(resolve({ cableName: 'Alpha', cableId: 'beta' }), {
    reason: 'cable-id-name-mismatch',
  });
  assert.deepEqual(resolve({ cableName: 'Alpha', cableId: 'missing' }), {
    reason: 'unknown-cable-id',
  });
});

test('an outage, social rumour and syndicated story never corroborate a physical break', () => {
  const result = replay([
    row('traffic', { sourceKind: 'telemetry', claim: 'outage' }),
    row('report', { sourceKind: 'news', claim: 'break' }),
    row('repost', { sourceKind: 'social', claim: 'break' }),
    row('unknown-name', { cableName: 'Shared', claim: 'break' }),
    row('missing-incident', { incidentId: null, claim: 'break' }),
  ]);
  assert.deepEqual(result.incidents, []);
  assert.deepEqual(
    result.outages.map(({ id }) => id),
    ['traffic'],
  );
  assert.deepEqual(
    result.leads.map(({ reason }) => reason),
    [
      'missing-incident-id',
      'non-primary-source',
      'non-primary-source',
      'ambiguous-cable-name',
    ],
  );
});

test('late break evidence changes classification only when known, without a traffic outage', () => {
  const fault = row('fault');
  const cut = row('cut', {
    claim: 'break',
    knownAt: time(22),
    sourceKind: 'authority',
  });
  assert.equal(replay([fault, cut], time(18)).incidents.length, 0);
  assert.equal(
    replay([fault, cut], time(21)).incidents[0].status,
    'fault-confirmed',
  );
  const result = replay([fault, cut], time(22));
  assert.deepEqual(result.outages, []);
  assert.equal(result.incidents[0].status, 'break-confirmed');
  assert.equal(result.incidents[0].breakConfirmed, true);
});

test('same-cable faults remain separate and unrelated restoration cannot close either', () => {
  const result = replay([
    row('fault'),
    row('second-fault', {
      incidentId: 'second',
      effectiveAt: time(25),
      knownAt: time(25),
    }),
    row('restore', {
      claim: 'restored',
      effectiveAt: time(23),
      knownAt: time(24),
    }),
    row('other-restore', {
      claim: 'restored',
      incidentId: 'third',
      cableName: 'Shared',
      cableId: 'beta',
    }),
  ]);
  assert.deepEqual(
    result.incidents.map(({ cableId, incidentId, status }) => [
      cableId,
      incidentId,
      status,
    ]),
    [
      ['alpha', 'first', 'reported-restored'],
      ['alpha', 'second', 'fault-confirmed'],
      ['beta', 'third', 'needs-review'],
    ],
  );
});

test('duplicate input is stable and out-of-order or contradictory lifecycle needs review', () => {
  const fault = row('fault', { claim: 'break' });
  const restore = row('restore', { claim: 'restored' });
  const forward = replay([fault, restore]);
  assert.deepEqual(replay([restore, fault, fault]), forward);
  assert.equal(forward.incidents[0].status, 'needs-review');
  assert.equal(forward.incidents[0].reason, 'conflicting-lifecycle');
  assert.equal(forward.incidents[0].breakConfirmed, false);
  assert.throws(
    () => replay([fault, { ...fault, claim: 'fault' }]),
    /Conflicting evidence ID/,
  );
});

test('rejects invalid calendar times, future-effective assertions and unsafe source URL schemes', () => {
  assert.throws(
    () => replay([row('bad', { effectiveAt: time(31) })]),
    /valid UTC ISO timestamp/,
  );
  assert.throws(
    () => replay([row('bad', { effectiveAt: time(20) })]),
    /cannot be after/,
  );
  assert.throws(
    () => replay([row('bad', { sourceUrl: 'javascript:alert(1)' })]),
    /HTTPS/,
  );
  assert.throws(
    () => replay([row('bad', { sourceUrl: 'https://user:pass@example.com' })]),
    /without credentials/,
  );
});

test('replays Cinia’s documented November 2024 fault and repair against the bundled map', () => {
  const data = (path) =>
    JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
  const input = {
    catalogue: data(
      '../data/local_data/telegeography_submarine_cables/cable-geo.json',
    ),
    ...data('../../tools/cable-incidents/c-lion1-2024-11.json'),
  };
  const [before] = replayCableIncidents({ ...input, asOf: time(20) }).incidents;
  const [after] = replayCableIncidents({ ...input, asOf: time(30) }).incidents;
  assert.equal(before.cableId, 'c-lion1');
  assert.equal(before.status, 'fault-confirmed');
  assert.equal(before.breakConfirmed, false);
  assert.equal(after.status, 'reported-restored');
  assert.equal(after.breakConfirmed, true);
});
