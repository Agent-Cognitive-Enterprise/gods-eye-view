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
const operator = {
  id: 'op',
  sourceKind: 'operator',
  cables: ['c-lion1'],
  speakers: ['Cinia', 'Cinia Oy'],
  places: ['Finland', 'Germany'],
};
const DATED = { publishedAt: '2026-11-18T09:00:00.000Z' };
const NOW = Date.parse('2026-11-20T00:00:00Z');
const judge = (title, source = operator, extra = {}) =>
  assessNotice({
    item: { title, summary: '', ...DATED, ...extra },
    source,
    names,
    now: NOW,
  });

test('allowed title shapes make an operator notice on its own cable clear', () => {
  for (const [title, claim, broken] of [
    [
      'A fault in the Cinia C-Lion1 submarine cable between Finland and Germany',
      'fault',
      false,
    ],
    ['Fault Detected in Cinia C-Lion1 Submarine Cable', 'fault', false],
    ['Disturbance on the C-Lion1 cable', 'fault', false],
    ['C-Lion1 submarine cable cut near Gotland', 'fault', true],
    ['C-Lion1 cable damaged', 'fault', false],
    ['C-Lion1 cable outage', 'fault', false],
    ['\u{1F527} C-Lion1 cable fault', 'fault', false],
    ["Cinia's C-Lion1 submarine cable has been repaired", 'restored', false],
    ["Cinia's C-Lion1 Submarine Cable Has Fully Restored", 'restored', false],
    ['C-Lion1 cable back online', 'restored', false],
    ['Disturbance in the C-Lion1 cable has been repaired', 'restored', false],
  ]) {
    const got = judge(title);
    assert.equal(got.signal, 'clear', title);
    assert.equal(got.claim, claim, title);
    assert.equal(got.breakConfirmed, broken, title);
    assert.deepEqual(got.cableIds, ['c-lion1']);
  }
});

test('a break in the summary counts only when a sentence opens with it', () => {
  const repaired = "Cinia's C-Lion1 Submarine Cable Has Fully Restored";
  assert.equal(
    judge(repaired, operator, {
      summary:
        "The break in Cinia's C-Lion1 submarine cable has been repaired and the connection is back online.",
    }).breakConfirmed,
    true,
  );
  assert.equal(
    judge(repaired, operator, {
      summary: 'Unlike the cable cut last year, this repair was quick.',
    }).breakConfirmed,
    false,
  );
});

test('any other title is doubt: review attacks from both rounds', () => {
  for (const title of [
    // Round 1.
    'No fault found on the C-Lion1 submarine cable',
    'C-Lion1 submarine cable has been fault-free for ten years',
    'Planned maintenance on the C-Lion1 submarine cable: short service interruptions expected',
    'C-Lion1 submarine cable maintenance break on 12 December',
    'Cinia and the Finnish Navy hold cable fault drill on C-Lion1',
    'What happens in case of a fault in the C-Lion1 submarine cable?',
    'One year since the C-Lion1 cable cut: lessons learned',
    'Cinia denies C-Lion1 cable damage',
    'Cinia cuts latency on the C-Lion1 submarine cable',
    'Damage to the Estlink 2 power cable: C-Lion1 operating normally',
    'C-Lion1 cable will be repaired next week',
    'C-Lion1 repair work completed, but a second fault was found',
    'Is the C-Lion1 submarine cable down?',
    // Round 2.
    "Disturbance in Cinia's C-Lion1 cable resolved",
    'Fault on C-Lion1 fixed',
    'C-Lion1 connection partially restored',
    'Traffic rerouted and services restored while C-Lion1 cable remains damaged',
    'Repaired section of C-Lion1 fails',
    'C-Lion1 cable cut feared after anchor incident',
    'C-Lion1 cable cut isn´t confirmed',
    'Cinia files damages claim over C-Lion1 cable cut',
    'Cable outage on C-Lion1 lasted 12 hours',
    'Fault on the Balticconnector; C-Lion1 traffic flows as usual',
    'Fault found during routine inspection of decommissioned C-Lion1 spare cable',
    'C-Lion1 may have a cable fault',
    "Fault detected on the C-Lion1 cable in November '24",
    // Round 3: lead words, place clauses and labels.
    'Fault in the former C-Lion1 cable',
    'Unrelated C-Lion1 cable outage',
    'Preventing C-Lion1 cable faults',
    'Remembering the C-Lion1 cable cut',
    'Recent C-Lion1 cable outages',
    'C-Lion1 cable damaged in the film',
    'C-Lion1 cut in prices',
    'C-Lion1 cable outage in December',
    'Fault in the C-Lion1 cable between Russia and Ukraine',
    'Satire: C-Lion1 cable cut',
    'Opinion: C-Lion1 cable outage',
    'Gulf section C-Lion1 restored',
  ])
    assert.equal(judge(title).signal, 'doubt', title);
});

test('boilerplate in the summary never makes a clear signal', () => {
  const got = judge(
    "Interruption in Cinia's email services on Saturday",
    operator,
    {
      summary: 'Cinia is the owner of the C-Lion1 submarine cable.',
    },
  );
  assert.equal(got.redFlag, true);
  assert.equal(got.reason, 'no-catalogue-cable-in-title');
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
  assert.equal(reason(fault, operator, { titleKnown: false }), 'no-title');
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
    reason(fault, operator, { publishedAt: '2030-12-01T00:00:00.000Z' }),
    'dated-in-the-future',
  );
  assert.equal(
    reason('Fault on a submarine cable in the Baltic'),
    'no-catalogue-cable-in-title',
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

test('a listing date in front of the title or card text becomes the notice date', () => {
  assert.deepEqual(
    datedNotice({
      title: '18.11.2024 A fault in the C-Lion1 cable',
      summary: '',
    }),
    {
      title: 'A fault in the C-Lion1 cable',
      summary: '',
      publishedAt: '2024-11-18T00:00:00.000Z',
    },
  );
  assert.deepEqual(
    datedNotice({ title: 'A fault', summary: '18.11.2024 Card text' }),
    {
      title: 'A fault',
      summary: 'Card text',
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
  assert.equal(
    datedNotice({ title: '2024-11-18 Fault', publishedAt: 'x' }).publishedAt,
    'x',
  );
});

test('a year in the title other than the notice year is history', () => {
  assert.equal(
    templateClaim('C-Lion1 cable fault', 'C-Lion1', 2025).claim,
    'fault',
  );
  assert.equal(
    templateClaim('C-Lion1 cable cut 2024', 'C-Lion1', 2025).reason,
    'doubtful-wording',
  );
  // "May" the month is not "may" the verb.
  assert.equal(
    templateClaim(
      'A fault detected on 12 May in the C-Lion1 cable',
      'C-Lion1',
      2025,
    ).reason,
    'no-allowed-title-shape',
  );
});

test('the labelled notices give no wrong clear signal', () => {
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
  assert.ok(notices.filter((n) => n.adversarial).length >= 190);
  const score = scoreLabelled({ notices, sources: CABLE_SOURCES, names: real });
  assert.deepEqual(score.wrongClear, []);
  // Of the six real C-Lion1 notices, only the one whose title says
  // "C-Lion" instead of "C-Lion1" is missed; it goes to doubt.
  assert.deepEqual(
    score.missed.filter((m) => !m.synthetic).map((m) => m.title),
    ["Disturbance in Cinia's C-Lion Submarine Cable"],
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
  // The repair is remembered: an earlier fault reported later stays closed.
  assert.equal(incidents['c-lion1'].status, 'closed');
  assert.equal(
    step(signal('fault', '2024-11-09T00:00:00Z')),
    'late-report-of-ended-incident',
  );
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
  assert.equal(
    step(signal('fault', '2024-11-19T12:00:00Z')),
    'late-report-of-ended-incident',
  );
  assert.equal(incidents['c-lion1'].status, 'closed');
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

test('a summary confirms a break only in a whole, affirmative sentence (PR #8 review)', () => {
  const fault = 'C-Lion1 submarine cable fault';
  for (const summary of [
    'A cut in the C-Lion1 submarine cable has been ruled out.',
    'A cut in the C-Lion1 submarine cable and the Estlink cable has been ruled out.',
    'The C-Lion1 submarine cable was cut, according to unconfirmed reports.',
    'Was the C-Lion1 submarine cable cut?',
    'The C-Lion1 submarine cable was not cut.',
  ])
    assert.equal(
      judge(fault, operator, { summary }).breakConfirmed,
      false,
      summary,
    );
  for (const summary of [
    'The C-Lion1 submarine cable was cut.',
    'The C-Lion1 submarine cable was cut near Gotland.',
    'A break in the C-Lion1 submarine cable has been located.',
  ])
    assert.equal(
      judge(fault, operator, { summary }).breakConfirmed,
      true,
      summary,
    );
});

test('a repair dated before the latest fault report leaves the incident open (PR #8 review)', () => {
  let incidents = {};
  const step = (s) => {
    const applied = applySignal(incidents, s);
    incidents = applied.incidents;
    return applied.change;
  };
  assert.equal(step(signal('fault', '2026-11-18T08:00:00Z')), 'would-show');
  assert.equal(step(signal('fault', '2026-11-21T08:00:00Z')), 'would-update');
  // A delayed repair notice dated the 19th, read after the 21st's report.
  assert.equal(
    step(signal('restored', '2026-11-19T08:00:00Z')),
    'restore-before-last-report',
  );
  assert.equal(incidents['c-lion1'].status, 'open');
  // A repair after the latest report closes it.
  assert.equal(step(signal('restored', '2026-11-22T08:00:00Z')), 'would-close');
});

test('a retracted, old or denied break in the summary confirms nothing (fix review round 1)', () => {
  const fault = 'Fault detected in Cinia C-Lion1 submarine cable';
  for (const summary of [
    'The C-Lion1 submarine cable was cut and this was later retracted.',
    'The C-Lion1 submarine cable was cut and Cinia has withdrawn it.',
    'The C-Lion1 submarine cable was cut and this was incorrect.',
    'A break in the C-Lion1 submarine cable was detected and later ruled out.',
    'The C-Lion1 submarine cable was cut and repaired in 2019.',
    'Earlier media claimed this. The C-Lion1 submarine cable was cut. Cinia says it was misreported.',
  ])
    assert.equal(
      judge(fault, operator, { summary }).breakConfirmed,
      false,
      summary,
    );
  assert.equal(
    judge("Cinia's C-Lion1 Submarine Cable Has Fully Restored", operator, {
      summary:
        "The break in Cinia's C-Lion1 submarine cable has been repaired and the direct submarine cable connection between Finland and Germany is back online.",
    }).breakConfirmed,
    true,
  );
});

test('a repair dated by day only is compared by day (fix review round 1)', () => {
  let incidents = {};
  const step = (s) => {
    const applied = applySignal(incidents, s);
    incidents = applied.incidents;
    return applied.change;
  };
  step(signal('fault', '2024-11-18T09:00:00Z'));
  step(signal('fault', '2024-11-27T14:00:00Z'));
  // "Repaired on 27 November": the same day as the last report closes it.
  assert.equal(step(signal('restored', '2024-11-27T00:00:00Z')), 'would-close');
});

test('a retraction worded any way, or a back-online clause about anything else, confirms no break (fix review round 2)', () => {
  const fault = 'Fault detected in Cinia C-Lion1 submarine cable';
  for (const summary of [
    'The C-Lion1 submarine cable was cut. Cinia apologises for the inaccurate notice.',
    'The C-Lion1 submarine cable was cut. The earlier notice was wrong.',
    'The C-Lion1 submarine cable was cut. Cinia has rescinded the notice.',
    'The C-Lion1 submarine cable was cut. This turned out to be a sensor fault.',
    'The C-Lion1 submarine cable was cut. Update: it was a power fault at the landing station.',
    'The C-Lion1 submarine cable is broken and the tabloid stories saying so are back online.',
    'The C-Lion1 submarine cable was cut. Cinia corrects its earlier notice: the cable is damaged.',
  ])
    assert.equal(
      judge(fault, operator, { summary }).breakConfirmed,
      false,
      summary,
    );
});
