import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DECAY_MS,
  aggregateCountries,
  assessEvent,
  durationWeight,
  isSystemic,
  normalizeEvent,
  reachIntensity,
  scoreClass,
} from './model.js';

const HOUR = 3600_000;
const NOW = Date.UTC(2026, 10, 8, 12);
const raw = (over = {}) => ({
  id: 'x-1',
  country_code: 'LBN',
  country_name: 'Lebanon',
  event_type: 'withdrawal_limits',
  severity: 4,
  confidence: 'official',
  start_time: '2026-11-01T00:00:00Z',
  resolved_time: null,
  affected_people_est: 1_000_000,
  affected_population_pct: null,
  sources: [{ title: 'A', url: 'https://example.org/a' }],
  ...over,
});
const ok = (over) => {
  const { event, error } = normalizeEvent(raw(over));
  assert.equal(error, undefined);
  return event;
};

test('a well-formed event is kept with its fields', () => {
  const e = ok();
  assert.equal(e.iso3, 'LBN');
  assert.equal(e.type, 'withdrawal_limits');
  assert.equal(e.startedAt, Date.UTC(2026, 10, 1));
  assert.equal(e.resolvedAt, null);
  assert.equal(e.sources.length, 1);
});

test('bad entries are refused with a reason, never guessed', () => {
  for (const [over, why] of [
    [{ id: '' }, /id/],
    [{ id: 'a b' }, /id/],
    [{ country_code: 'LB' }, /alpha-3/],
    [{ event_type: 'riot' }, /event_type/],
    [{ severity: 6 }, /severity/],
    [{ severity: 2.5 }, /severity/],
    [{ confidence: 'sure' }, /confidence/],
    [{ start_time: 'soon' }, /start_time/],
    [{ resolved_time: '2026-10-01T00:00:00Z' }, /before start/],
    [{ affected_people_est: -1 }, /affected_people_est/],
    [{ affected_population_pct: 140 }, /0-100/],
    [{ sources: [] }, /source/],
    [{ sources: [{ url: 'javascript:alert(1)' }] }, /source/],
  ]) {
    const { event, error } = normalizeEvent(raw(over));
    assert.equal(event, undefined, JSON.stringify(over));
    assert.match(error, why);
  }
  assert.match(normalizeEvent(null).error, /object/);
});

test('duration weights follow the brief', () => {
  assert.equal(durationWeight(2), 0.25);
  assert.equal(durationWeight(6), 0.5);
  assert.equal(durationWeight(30), 0.75);
  assert.equal(durationWeight(72), 1);
});

test('the share is derived from the population when only people are known', () => {
  const a = assessEvent(ok(), { now: NOW, population: 5_000_000 });
  assert.equal(a.affectedPct, 20);
  // 20% x severity 4 (0.9) x 7.5 days (1) x official (1)
  assert.ok(Math.abs(a.scores.share - 0.18) < 1e-9);
  assert.equal(a.scores.people, 900_000);
  const b = assessEvent(
    ok({ affected_people_est: null, affected_population_pct: 10 }),
    { now: NOW, population: 5_000_000 },
  );
  assert.equal(b.affectedPeople, 500_000);
});

test('an unknown reach gives no score, not a guess', () => {
  const a = assessEvent(ok({ affected_people_est: null }), {
    now: NOW,
    population: 5_000_000,
  });
  assert.equal(a.scores.share, null);
  assert.equal(a.scores.people, null);
  const b = assessEvent(ok(), { now: NOW, population: null });
  assert.equal(b.affectedPct, null);
  assert.equal(b.scores.share, null);
  assert.equal(b.scores.people, 900_000);
});

test('a resolved event fades over five days, then is history', () => {
  const resolved = new Date(NOW - DECAY_MS / 2).toISOString();
  const half = assessEvent(ok({ resolved_time: resolved }), {
    now: NOW,
    population: 5_000_000,
  });
  assert.equal(half.active, false);
  assert.ok(Math.abs(half.decay - 0.5) < 1e-9);
  assert.equal(half.historical, false);
  const gone = assessEvent(
    ok({ resolved_time: new Date(NOW - DECAY_MS - 1).toISOString() }),
    { now: NOW, population: 5_000_000 },
  );
  assert.equal(gone.historical, true);
  assert.equal(gone.scores.share, 0);
});

test('a short social-media outage stays far below a confirmed freeze', () => {
  const outage = assessEvent(
    ok({
      event_type: 'technical_outage',
      severity: 1,
      confidence: 'social',
      start_time: new Date(NOW - 2 * HOUR).toISOString(),
      affected_population_pct: 40,
      affected_people_est: null,
    }),
    { now: NOW, population: 5_000_000 },
  );
  const freeze = assessEvent(
    ok({
      event_type: 'deposit_freeze',
      severity: 5,
      start_time: new Date(NOW - 5 * 24 * HOUR).toISOString(),
      affected_population_pct: 40,
      affected_people_est: null,
    }),
    { now: NOW, population: 5_000_000 },
  );
  assert.equal(scoreClass(outage.scores.share), 'low');
  assert.equal(scoreClass(freeze.scores.share), 'severe');
  assert.equal(isSystemic(freeze), true);
  assert.equal(isSystemic(outage), false);
});

test('class bounds per mode', () => {
  assert.equal(scoreClass(null), 'unknown');
  assert.equal(scoreClass(0.001), 'minimal');
  assert.equal(scoreClass(0.02), 'low');
  assert.equal(scoreClass(0.05), 'moderate');
  assert.equal(scoreClass(0.2), 'high');
  assert.equal(scoreClass(0.3), 'severe');
  assert.equal(scoreClass(50_000, 'people'), 'low');
  assert.equal(scoreClass(500_000, 'people'), 'moderate');
  assert.equal(scoreClass(5_000_000, 'people'), 'high');
  assert.equal(scoreClass(50_000_000, 'people'), 'severe');
  assert.equal(scoreClass(0.001, 'share', true), 'systemic');
  assert.equal(scoreClass(null, 'people', true), 'unknown', 'no figure');
  assert.equal(reachIntensity(10_000), 0);
  assert.equal(reachIntensity(100_000_000), 1);
});

test('codes Natural Earth spells differently are accepted', () => {
  assert.equal(ok({ country_code: 'SSD' }).iso3, 'SDS');
  assert.equal(ok({ country_code: 'PSE' }).iso3, 'PSX');
  assert.equal(ok({ country_code: 'XKX' }).iso3, 'KOS');
});

test('a planned end does not inflate the duration; a future start is not drawn', () => {
  const planned = assessEvent(
    ok({
      start_time: new Date(NOW - HOUR).toISOString(),
      resolved_time: new Date(NOW + 5 * 24 * HOUR).toISOString(),
    }),
    { now: NOW, population: 5_000_000 },
  );
  assert.equal(planned.active, true);
  assert.equal(planned.durationHours, 1);
  const later = assessEvent(
    ok({ start_time: new Date(NOW + HOUR).toISOString() }),
    { now: NOW, population: 5_000_000 },
  );
  assert.equal(later.upcoming, true);
  assert.equal(later.active, false);
  assert.equal(later.scores.share, 0);
  assert.deepEqual(aggregateCountries([later], { history: true }), []);
});

test('the most serious live event leads, even with its reach unknown', () => {
  const pop = 5_000_000;
  const freeze = assessEvent(
    ok({
      id: 'freeze',
      event_type: 'deposit_freeze',
      severity: 5,
      affected_people_est: null,
    }),
    { now: NOW, population: pop },
  );
  const outage = assessEvent(
    ok({
      id: 'outage',
      event_type: 'technical_outage',
      severity: 1,
      affected_people_est: null,
      affected_population_pct: 0.2,
    }),
    { now: NOW, population: pop },
  );
  const past = assessEvent(
    ok({
      id: 'past',
      event_type: 'bank_failure',
      start_time: '2026-01-01T00:00:00Z',
      resolved_time: '2026-01-02T00:00:00Z',
    }),
    { now: NOW, population: pop },
  );
  const [c] = aggregateCountries([past, outage, freeze], { history: true });
  assert.equal(c.leadEventId, 'freeze');
  assert.equal(c.type, 'deposit_freeze');
  assert.equal(c.severity, 5);
  assert.equal(c.reachUnknown, true);
  assert.equal(c.classes.share, 'minimal');
});

test('countries combine their live events; history only when asked', () => {
  const pop = 5_000_000;
  const a = assessEvent(ok({ id: 'a', affected_people_est: 500_000 }), {
    now: NOW,
    population: pop,
  });
  const b = assessEvent(
    ok({
      id: 'b',
      event_type: 'technical_outage',
      severity: 2,
      affected_people_est: 500_000,
    }),
    { now: NOW, population: pop },
  );
  const old = assessEvent(
    ok({
      id: 'old',
      country_code: 'JPN',
      start_time: '2026-01-29T00:00:00Z',
      resolved_time: '2026-01-29T10:00:00Z',
    }),
    { now: NOW, population: 120_000_000 },
  );
  const [lbn] = aggregateCountries([a, b, old]);
  assert.equal(aggregateCountries([a, b, old]).length, 1);
  assert.equal(lbn.iso3, 'LBN');
  assert.equal(lbn.affectedPeople, 1_000_000);
  assert.equal(lbn.affectedPct, 20);
  assert.equal(lbn.type, 'withdrawal_limits', 'the strongest event leads');
  assert.ok(lbn.scores.share > a.scores.share);
  assert.ok(lbn.scores.share < a.scores.share + b.scores.share);
  assert.deepEqual(lbn.eventIds.sort(), ['a', 'b']);
  const all = aggregateCountries([a, b, old], { history: true });
  const jpn = all.find((c) => c.iso3 === 'JPN');
  assert.equal(jpn.historical, true);
  assert.deepEqual(jpn.classes, { share: 'history', people: 'history' });
});
