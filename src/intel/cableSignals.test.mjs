import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { catalogueNames } from './cableInbox.js';
import {
  FAULT_FADE_MS,
  applySignal,
  assessNotice,
  datedNotice,
  fadeIncidents,
  noticeTime,
  scoreLabelled,
  templateClaim,
} from './cableSignals.js';
import { CABLE_SOURCES } from '../../server/providers/intel/connectors/cables.js';

const feature = (id, name) => ({ properties: { id, name } });
const names = catalogueNames({
  features: [
    feature('c-lion1', 'C-Lion1'),
    feature('eassy', 'Eastern Africa Submarine System (EASSy)'),
    feature('fec-2', 'Finland Estonia Connection 2 (FEC-2)'),
    feature('echo', 'Echo'),
  ],
});
const operator = { id: 'op', sourceKind: 'operator', cables: ['c-lion1'] };
const DATED = { publishedAt: '2026-11-18T09:00:00.000Z' };
const judge = (title, source = operator, extra = {}) =>
  assessNotice({
    item: { title, summary: '', ...DATED, ...extra },
    source,
    names,
  });

test('strict templates make an operator notice on its own cable clear', () => {
  for (const [title, claim, broken] of [
    ['A fault in the C-Lion1 submarine cable', 'fault', false],
    ['Fault detected in Cinia C-Lion1 submarine cable', 'fault', false],
    ['Some disturbance has been detected on the C-Lion1 cable', 'fault', false],
    ['C-Lion1 submarine cable cut near Gotland', 'fault', true],
    ['C-Lion1 cable damaged', 'fault', false],
    ['C-Lion1 cable outage', 'fault', false],
    ["Cinia's C-Lion1 submarine cable has been repaired", 'restored', false],
    ["Cinia's C-Lion1 submarine cable has fully restored", 'restored', false],
    [
      'C-Lion1 submarine cable is back online after the break',
      'restored',
      true,
    ],
  ]) {
    const got = judge(title);
    assert.equal(got.signal, 'clear', title);
    assert.equal(got.claim, claim, title);
    assert.equal(got.breakConfirmed, broken, title);
    assert.deepEqual(got.cableIds, ['c-lion1']);
  }
});

test('negation, plans, maintenance, history, business and questions are doubt', () => {
  for (const title of [
    'No fault found on the C-Lion1 submarine cable',
    'C-Lion1 submarine cable has been fault-free for ten years',
    'C-Lion1 operating normally; no faults detected',
    'Planned maintenance on the C-Lion1 submarine cable: short service interruptions expected',
    'C-Lion1 submarine cable maintenance break on 12 December',
    'Cinia and the Finnish Navy hold cable fault drill on C-Lion1',
    'What happens in case of a fault in the C-Lion1 submarine cable?',
    'One year since the C-Lion1 cable cut: lessons learned',
    'C-Lion1, which was damaged in 2024, gets a capacity upgrade',
    'Cinia: reports of C-Lion1 cable cut are false',
    'Cinia denies C-Lion1 cable damage',
    'Suspected fault on C-Lion1 submarine cable under investigation',
    'Cinia cuts latency on the C-Lion1 submarine cable',
    'Cinia Q3 results: revenue down; C-Lion1 cable demand grows',
    'Damage to the Estlink 2 power cable: C-Lion1 operating normally',
    'C-Lion1 cable will be repaired next week',
    'C-Lion1 to be restored on Monday',
    'C-Lion1 repair work completed, but a second fault was found',
    'Service on the C-Lion1 cable hasn’t been restored',
  ])
    assert.equal(judge(title).signal, 'doubt', title);
  // Both fault and repair wording: the reason says so.
  assert.equal(
    judge('Disturbance in the C-Lion1 cable has been repaired').reason,
    'fault-and-repair-wording',
  );
});

test('the source, its cables and the date decide before the wording', () => {
  const reason = (title, source, extra) => judge(title, source, extra).reason;
  const fault = 'A fault in the C-Lion1 submarine cable';
  assert.equal(
    reason(fault, { ...operator, sourceKind: 'news' }),
    'not-a-primary-source',
  );
  assert.equal(
    reason(fault, operator, { offHost: true }),
    'not-a-primary-source',
  );
  assert.equal(
    reason(fault, { ...operator, cables: [] }),
    'cable-outside-source-remit',
  );
  assert.equal(
    reason('C-Lion1 cable fault; FEC-2 cable fault continues', {
      ...operator,
      cables: ['c-lion1', 'fec-2'],
    }),
    'several-cables-named',
  );
  assert.equal(reason(fault, operator, { publishedAt: null }), 'undated');
  assert.equal(
    reason('Fault on a submarine cable in the Baltic'),
    'no-catalogue-cable-named',
  );
  assert.equal(
    reason('Vessel anchoring near the C-Lion1 cable route'),
    'threat-wording-only',
  );
});

test('red flags: any notice about submarine cables; priority by wording', () => {
  assert.equal(judge('New CEO appointed').redFlag, false);
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
});

test('a listing date in front of the title becomes the notice date', () => {
  assert.deepEqual(
    datedNotice({ title: '18.11.2024 A fault in the C-Lion1 cable' }),
    {
      title: 'A fault in the C-Lion1 cable',
      publishedAt: '2024-11-18T00:00:00.000Z',
    },
  );
  assert.equal(
    datedNotice({ title: 'August 14, 2024 WIOCC restores ISPs' }).publishedAt,
    '2024-08-14T00:00:00.000Z',
  );
  assert.equal(
    datedNotice({ title: '31.02.2024 Not a date' }).publishedAt,
    undefined,
  );
  // A feed's own date wins; the title still loses the prefix.
  assert.deepEqual(
    datedNotice({ title: '2024-11-18 Fault', publishedAt: 'x' }),
    { title: 'Fault', publishedAt: 'x' },
  );
});

test('a year other than the notice year, or the one before, is history', () => {
  assert.equal(
    templateClaim('A fault was detected on 25 December 2024', 2025).claim,
    'fault',
  );
  assert.equal(
    templateClaim('A fault was detected on 25 December 2022', 2025).reason,
    'doubtful-wording',
  );
  // "May" the month is not "may" the verb.
  assert.equal(
    templateClaim('A fault was detected on 12 May', 2025).claim,
    'fault',
  );
});

test('the labelled notices give no wrong clear signal and catch every real one', () => {
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
  assert.ok(notices.filter((n) => n.adversarial).length >= 100);
  const score = scoreLabelled({ notices, sources: CABLE_SOURCES, names: real });
  assert.deepEqual(score.wrongClear, []);
  assert.deepEqual(
    score.missed.filter((m) => !m.synthetic),
    [],
  );
  assert.ok(score.rightClear >= 13);
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

test('a shadow incident opens, updates, confirms a break and closes, in time order', () => {
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
  assert.equal(
    step(signal('restored', '2024-11-17T00:00:00Z')),
    'restore-before-incident',
  );
  assert.equal(step(signal('fault', '2024-11-19T00:00:00Z')), 'would-update');
  assert.equal(
    step(signal('fault', '2024-11-20T00:00:00Z', { breakConfirmed: true })),
    'would-confirm-break',
  );
  assert.equal(step(signal('restored', '2024-11-28T19:00:00Z')), 'would-close');
  assert.equal(incidents['c-lion1'].status, 'closed');
  assert.equal(incidents['c-lion1'].breakConfirmed, true);
  // A late report of the closed incident changes nothing.
  assert.equal(
    step(signal('fault', '2024-11-19T12:00:00Z')),
    'late-report-of-ended-incident',
  );
  assert.equal(incidents['c-lion1'].status, 'closed');
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
