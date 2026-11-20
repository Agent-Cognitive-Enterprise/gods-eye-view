import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { catalogueNames } from './cableInbox.js';
import {
  FAULT_FADE_MS,
  applySignal,
  assessNotice,
  fadeIncidents,
  noticeTime,
  scoreLabelled,
} from './cableSignals.js';
import { CABLE_SOURCES } from '../../server/providers/intel/connectors/cables.js';

const feature = (id, name) => ({ properties: { id, name } });
const names = catalogueNames({
  features: [
    feature('c-lion1', 'C-Lion1'),
    feature('eassy', 'Eastern Africa Submarine System (EASSy)'),
    feature('echo', 'Echo'),
  ],
});
const operator = { id: 'op', sourceKind: 'operator', cables: ['c-lion1'] };
const judge = (title, source = operator, extra = {}) =>
  assessNotice({ item: { title, summary: '', ...extra }, source, names });

test('an operator fault notice on its own cable is a clear signal', () => {
  const got = judge('A fault in the C-Lion1 submarine cable');
  assert.equal(got.signal, 'clear');
  assert.equal(got.claim, 'fault');
  assert.equal(got.breakConfirmed, false);
  assert.deepEqual(got.cableIds, ['c-lion1']);
  assert.equal(got.priority, 'incident');
  const cut = judge('C-Lion1 submarine cable cut near Gotland');
  assert.equal(cut.claim, 'fault');
  assert.equal(cut.breakConfirmed, true);
  // Damage is not a stated physical break.
  assert.equal(judge('C-Lion1 cable damaged').breakConfirmed, false);
  const repaired = judge('The break in the C-Lion1 cable has been repaired');
  assert.equal(repaired.claim, 'restored');
  assert.equal(repaired.breakConfirmed, true);
});

test('anything less than clear is doubt, with its reason', () => {
  const reasons = (title, source, extra) => judge(title, source, extra).reason;
  assert.equal(
    reasons('C-Lion1 cable fault', { ...operator, sourceKind: 'news' }),
    'not-a-primary-source',
  );
  assert.equal(
    reasons('C-Lion1 cable fault', operator, { offHost: true }),
    'not-a-primary-source',
  );
  assert.equal(
    reasons('C-Lion1 cable fault', { ...operator, cables: [] }),
    'cable-outside-source-remit',
  );
  assert.equal(
    reasons('Fault on a submarine cable in the Baltic'),
    'no-catalogue-cable-named',
  );
  assert.equal(
    reasons('C-Lion1 cable has not yet been restored'),
    'doubtful-wording',
  );
  assert.equal(
    reasons('Vessel anchoring near the C-Lion1 cable route'),
    'threat-wording-only',
  );
  for (const title of [
    'C-Lion1 cable fault',
    'Vessel anchoring near the C-Lion1 cable route',
  ])
    assert.equal(judge(title, operator).redFlag, true);
});

test('red flags: any notice about submarine cables; priority by wording', () => {
  assert.equal(judge('New CEO appointed').redFlag, false);
  assert.equal(judge('New CEO appointed').signal, 'none');
  const mention = judge('Operator lands new subsea cable in Durban');
  assert.equal(mention.redFlag, true);
  assert.equal(mention.priority, 'mention');
  assert.equal(mention.signal, 'none');
  assert.equal(
    judge('Windward reports vessel activity near Asia cable routes').priority,
    'threat',
  );
  assert.equal(judge('Skade på sjøkabel til Svalbard').redFlag, true);
});

test('a weak name counts only for a cable the source speaks for', () => {
  const eassy = { ...operator, cables: ['eassy'] };
  assert.equal(judge('EASSy cable outage', eassy).signal, 'clear');
  assert.equal(
    judge('EASSy cable outage', operator).reason,
    'cable-outside-source-remit',
  );
  assert.equal(
    judge('Eastern Africa Submarine System cable fault', eassy).signal,
    'clear',
  );
});

test('the labelled notices give no wrong clear signal and miss none', () => {
  const real = catalogueNames(
    JSON.parse(
      readFileSync(
        new URL(
          '../data/local_data/telegeography_submarine_cables/cable-geo.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  );
  const { notices } = JSON.parse(
    readFileSync(
      new URL(
        '../../tools/cable-incidents/labelled-notices.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const score = scoreLabelled({ notices, sources: CABLE_SOURCES, names: real });
  assert.deepEqual(score.wrongClear, []);
  assert.deepEqual(score.missed, []);
  assert.ok(score.expectedClear >= 9);
});

const signal = (claim, at, extra = {}) => ({
  cableId: 'c-lion1',
  claim,
  breakConfirmed: false,
  at: Date.parse(at),
  url: `https://op.example/${claim}/${at}`,
  sourceId: 'op',
  ...extra,
});

test('a shadow incident opens, updates, confirms a break and closes', () => {
  let incidents = {};
  const step = (s) => {
    const applied = applySignal(incidents, s);
    incidents = applied.incidents;
    return applied.change;
  };
  assert.equal(
    step(signal('restored', '2024-11-10T00:00:00Z')),
    'restore-without-open-incident',
  );
  assert.deepEqual(incidents, {});
  assert.equal(step(signal('fault', '2024-11-18T02:04:00Z')), 'would-show');
  assert.equal(step(signal('fault', '2024-11-19T00:00:00Z')), 'would-update');
  assert.equal(
    step(signal('fault', '2024-11-20T00:00:00Z', { breakConfirmed: true })),
    'would-confirm-break',
  );
  assert.equal(step(signal('restored', '2024-11-28T19:00:00Z')), 'would-close');
  assert.equal(incidents['c-lion1'].status, 'closed');
  assert.equal(incidents['c-lion1'].breakConfirmed, true);
  assert.equal(incidents['c-lion1'].sources.length, 4);
  // A later fault opens a new incident.
  assert.equal(step(signal('fault', '2024-12-25T16:44:00Z')), 'would-show');
});

test('an open incident with no report for 30 days fades', () => {
  const { incidents } = applySignal(
    {},
    signal('fault', '2024-11-18T00:00:00Z'),
  );
  const start = Date.parse('2024-11-18T00:00:00Z');
  assert.deepEqual(fadeIncidents(incidents, start + FAULT_FADE_MS).faded, []);
  const later = fadeIncidents(incidents, start + FAULT_FADE_MS + 1);
  assert.deepEqual(later.faded, ['c-lion1']);
  assert.equal(later.incidents['c-lion1'].status, 'faded');
});

test('a notice is dated by its publication time, never after it was seen', () => {
  const seenAt = '2024-11-19T00:00:00.000Z';
  assert.equal(
    noticeTime({ publishedAt: '2024-11-18T09:00:00.000Z' }, seenAt),
    Date.parse('2024-11-18T09:00:00Z'),
  );
  assert.equal(
    noticeTime({ publishedAt: '2030-01-01T00:00:00.000Z' }, seenAt),
    Date.parse(seenAt),
  );
  assert.equal(noticeTime({ publishedAt: null }, seenAt), Date.parse(seenAt));
});
