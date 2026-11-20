import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  cableMentions,
  catalogueNames,
  claimCues,
  printable,
  dayBefore,
  diffSnapshots,
  iodaOutages,
  proposalFor,
} from './cableInbox.js';
import { replayCableIncidents } from './cableIncidents.js';

const feature = (id, name) => ({ properties: { id, name } });
const catalogue = {
  features: [
    feature('c-lion1', 'C-Lion1'),
    feature('c-lion1', 'C-Lion1'),
    feature('atlantis-2', 'Atlantis-2'),
    feature('atlantis', 'Atlantis'),
    feature('echo', 'Echo'),
    feature('safe', 'SAFE'),
  ],
};
const names = catalogueNames(catalogue);
const ids = (text) => cableMentions(text, names).map((m) => m.cableId);

test('names cables only by their exact catalogue name, as whole words', () => {
  assert.deepEqual(ids('A fault in the Cinia C-Lion1 submarine cable'), [
    'c-lion1',
  ]);
  assert.deepEqual(ids('c-lion1 cable is down'), ['c-lion1']);
  // Text that is not about a cable names no cable.
  assert.deepEqual(ids('Atlantis is down'), []);
  // No fuzzy or partial match.
  assert.deepEqual(ids('C-Lion 1 and C-Lion12 and xC-Lion1 cables'), []);
  // The longer name wins; the shorter one is reported only on its own.
  assert.deepEqual(ids('Atlantis-2 cable repaired'), ['atlantis-2']);
  assert.deepEqual(ids('Atlantis-2 and Atlantis cables'), [
    'atlantis',
    'atlantis-2',
  ]);
});

test('a one-word name needs its capitals and the word cable, and is marked weak', () => {
  assert.deepEqual(ids('Echo is safe to use'), []);
  assert.deepEqual(ids('the echo cable was cut'), []);
  assert.deepEqual(ids('The SAFE cable is safe'), ['safe']);
  assert.deepEqual(cableMentions('Echo cable fault', names), [
    { cableId: 'echo', name: 'Echo', weak: true },
  ]);
  assert.equal(names.find((n) => n.cableId === 'c-lion1').weak, false);
});

test('wording cues never suggest a physical break', () => {
  assert.deepEqual(
    claimCues('Fault detected in Cinia C-Lion1 submarine cable'),
    {
      suggestedClaim: 'fault',
      cues: { fault: ['fault'] },
    },
  );
  const cut = claimCues('Cable cut near Gotland, operator says it is damaged');
  assert.equal(cut.suggestedClaim, 'fault');
  assert.deepEqual(cut.cues.break, ['cut', 'damaged']);
  const repaired = claimCues(
    'The break in the C-Lion1 cable has been repaired and is back online',
  );
  assert.equal(repaired.suggestedClaim, 'restored');
  assert.deepEqual(repaired.cues.break, ['break']);
  assert.deepEqual(claimCues('New CEO for Cinia'), {
    suggestedClaim: null,
    cues: {},
  });
});

test('a proposal carries its source and suggestions, never a decision', () => {
  const proposal = proposalFor({
    id: 'p-1',
    source: { id: 'cinia', sourceKind: 'operator', publisher: 'Cinia' },
    item: {
      url: 'https://example.com/a',
      title: 'Disturbance in C-Lion1 submarine cable',
      summary: '',
      publishedAt: null,
    },
    seenAt: '2024-11-18T06:00:00.000Z',
    names,
  });
  assert.equal(proposal.status, 'new');
  assert.equal(proposal.suggestedClaim, 'fault');
  assert.deepEqual(proposal.cables, [
    { cableId: 'c-lion1', name: 'C-Lion1', weak: false },
  ]);
  assert.equal('claim' in proposal, false);
});

const row = (id, claim, effectiveAt, knownAt) => ({
  id,
  incidentId: 'nov',
  cableName: 'C-Lion1',
  claim,
  sourceKind: 'operator',
  sourceUrl: `https://example.com/${id}`,
  effectiveAt,
  knownAt,
});
const evidence = [
  row('fault', 'fault', '2024-11-18T02:04:00Z', '2024-11-18T06:00:00Z'),
  row('break', 'break', '2024-11-18T02:04:00Z', '2024-11-29T12:00:00Z'),
  row('restored', 'restored', '2024-11-28T19:00:00Z', '2024-11-29T12:00:00Z'),
];
const at = (asOf) => replayCableIncidents({ catalogue, evidence, asOf });

test('the daily diff reports a new fault, then the confirmed break and repair', () => {
  const day = (iso) => diffSnapshots(at(dayBefore(iso)), at(iso));
  assert.deepEqual(day('2024-11-17T12:00:00Z'), []);
  const [opened] = day('2024-11-18T12:00:00Z');
  assert.equal(opened.change, 'new');
  assert.equal(opened.cableId, 'c-lion1');
  assert.equal(opened.status, 'fault-confirmed');
  assert.deepEqual(opened.sources, ['https://example.com/fault']);
  assert.deepEqual(day('2024-11-25T12:00:00Z'), []);
  const [closed] = day('2024-11-29T12:00:00Z');
  assert.equal(closed.change, 'updated');
  assert.deepEqual(closed.from, {
    status: 'fault-confirmed',
    breakConfirmed: false,
    evidence: 1,
  });
  assert.equal(closed.status, 'reported-restored');
  assert.equal(closed.breakConfirmed, true);
});

test('outages and leads never appear as cable changes', () => {
  const noise = [
    {
      ...row(
        'traffic',
        'outage',
        '2024-11-18T02:00:00Z',
        '2024-11-18T03:00:00Z',
      ),
      sourceKind: 'telemetry',
    },
    {
      ...row('story', 'break', '2024-11-18T02:00:00Z', '2024-11-18T03:00:00Z'),
      sourceKind: 'news',
    },
  ];
  const replay = (asOf) =>
    replayCableIncidents({ catalogue, evidence: noise, asOf });
  assert.deepEqual(
    diffSnapshots(
      replay('2024-11-17T12:00:00Z'),
      replay('2024-11-18T12:00:00Z'),
    ),
    [],
  );
});

test('an incident missing from the later replay is reported as removed', () => {
  const later = { incidents: [] };
  assert.deepEqual(diffSnapshots(at('2024-11-20T00:00:00Z'), later), [
    {
      change: 'removed',
      cableId: 'c-lion1',
      incidentId: 'nov',
      status: 'fault-confirmed',
    },
  ]);
});

test('IODA events become per-country outages with each signal kept apart', () => {
  const outages = iodaOutages({
    data: [
      {
        location: 'country/FI',
        location_name: 'Finland',
        start: 1731895200,
        duration: 3600,
        datasource: 'gtr',
        method: 'sarima',
        score: 26093.7,
      },
      {
        location: 'country/FI',
        location_name: 'Finland',
        start: 1731891600,
        duration: 1800,
        datasource: 'bgp',
        method: 'median',
        score: 10,
      },
      {
        location: 'region/1234',
        start: 1731891600,
        duration: 60,
        datasource: 'bgp',
      },
      {
        location: 'country/DE',
        start: 'soon',
        duration: 60,
        datasource: 'bgp',
      },
      {
        location: 'country/DE',
        start: 1731891600,
        duration: 60,
        datasource: 'made-up',
      },
    ],
  });
  assert.equal(outages.length, 1);
  const [fi] = outages;
  assert.equal(fi.country, 'FI');
  assert.deepEqual(
    fi.signals.map((s) => s.datasource),
    ['bgp', 'gtr'],
  );
  assert.equal(fi.start, '2024-11-18T01:00:00.000Z');
  assert.equal(fi.end, '2024-11-18T03:00:00.000Z');
  assert.equal(fi.signals[1].score, 26094);
  assert.throws(() => iodaOutages({ data: null }), /malformed/);
});

test('the bundled catalogue names C-Lion1 in Cinia’s own headline', () => {
  const bundled = JSON.parse(
    readFileSync(
      new URL(
        '../data/local_data/telegeography_submarine_cables/cable-geo.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const real = catalogueNames(bundled);
  assert.deepEqual(
    cableMentions(
      'A fault in the Cinia C-Lion1 submarine cable between Finland and Germany',
      real,
    ).map((m) => m.cableId),
    ['c-lion1'],
  );
  assert.ok(real.length > 600);
});

const bundledNames = () =>
  catalogueNames(
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

test('news that is not about a cable names no cable, even when a name fits', () => {
  const real = bundledNames();
  for (const headline of [
    'Northern Lights could be visible tonight across Scotland',
    'Italy-Albania migrant deal faces court challenge',
    'Ferries cancelled across Cook Strait after storm',
    'Heathrow T3 power outage delays flights',
    'Grace Hopper Celebration opens in Orlando',
  ])
    assert.deepEqual(cableMentions(headline, real), [], headline);
  assert.deepEqual(
    cableMentions('Grace Hopper subsea cable lands in Bilbao', real).map(
      (m) => m.cableId,
    ),
    ['grace-hopper'],
  );
});

test('indices stay aligned when lower-casing would lengthen the text', () => {
  const text = `${'İ'.repeat(36)} Thetis Express cable fault`;
  const local = catalogueNames({
    features: [
      feature('thetis', 'Thetis'),
      feature('thetis-express', 'Thetis Express'),
    ],
  });
  assert.deepEqual(
    cableMentions(text, local).map((m) => m.cableId),
    ['thetis-express'],
  );
});

test('repair wording next to doubtful wording never suggests restored', () => {
  for (const text of [
    'Traffic restored via alternative routes while the cable awaits repair',
    'The C-Lion1 cable has not yet been restored',
    'C-Lion1 fault: service has not yet been restored',
    'Service hasn’t been restored yet',
    "Services haven't been restored",
    'Service will not be restored until next week',
    'C-Lion1 submarine cable has fully restored. During the repair, traffic was rerouted via alternative routes.',
  ]) {
    const { suggestedClaim, cues } = claimCues(text);
    assert.equal(suggestedClaim, null, text);
    assert.ok(cues.doubt.length, text);
  }
  assert.equal(
    claimCues('The C-Lion1 cable has now been restored').suggestedClaim,
    'restored',
  );
  assert.equal(
    claimCues('C-Lion1 fault: repairs will start on Monday').suggestedClaim,
    'fault',
  );
});

test('a name with a space and a number is not taken from a score or a timetable', () => {
  const real = bundledNames();
  for (const text of [
    'Germany-Denmark 3-1: hosts through to the final',
    'Portsmouth-Ryde 10:15 hovercraft cancelled after fault',
    'Jeju-Mainland 2 ferries suspended',
  ])
    assert.deepEqual(cableMentions(text, real), [], text);
});

test('stored text loses terminal escapes and bidi overrides', () => {
  assert.equal(
    printable('\u001b[2J\u001b[HAll clear\u0007 ‮evil\u0085 '),
    '[2J [HAll clear evil',
  );
});

test('IODA events outside the window asked for are dropped', () => {
  const event = (start, duration) => ({
    location: 'country/FI',
    start,
    duration,
    datasource: 'bgp',
  });
  const outages = iodaOutages(
    { data: [event(1e12, 60), event(1000, 60), event(5000, 600)] },
    { from: 4000, until: 9000 },
  );
  assert.equal(outages[0].signals.length, 1);
  assert.equal(outages[0].start, new Date(5_000_000).toISOString());
});

test('a distinctive name with a digit needs no cable word', () => {
  const real = bundledNames();
  const found = (text) => cableMentions(text, real).map((m) => m.cableId);
  assert.deepEqual(found('C-Lion1 repair completed'), ['c-lion1']);
  assert.deepEqual(found('Update on the SeaMeWe-4 outage').length, 1);
  assert.deepEqual(found('Heathrow T3 power outage delays flights'), []);
  assert.deepEqual(
    claimCues('The C-Lion1 cable has been repaired and is back in service'),
    {
      suggestedClaim: 'restored',
      cues: { restored: ['back in service', 'repaired'] },
    },
  );
});

test('zero-width, Arabic letter mark and BOM characters are removed too', () => {
  assert.equal(printable('a​b؜c﻿d'), 'a b c d');
});
