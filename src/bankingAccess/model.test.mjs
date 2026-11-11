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
  assert.equal(scoreClass(null, 'people'), 'unknown', 'no figure');
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

test('a large head-count marks systemic without reddening a small share', () => {
  const big = assessEvent(
    ok({
      country_code: 'IND',
      event_type: 'deposit_freeze',
      severity: 5,
      affected_people_est: 12_000_000,
    }),
    { now: NOW, population: 1_200_000_000 },
  );
  const [c] = aggregateCountries([big]);
  assert.equal(c.systemic, true);
  assert.equal(c.affectedPct, 1);
  assert.equal(c.classes.share, 'low', '1% stays light in % mode');
  assert.equal(c.classes.people, 'severe');
});

test('figures from different events are flagged, never merged', () => {
  const a = assessEvent(ok({ id: 'a', affected_people_est: 5_000_000 }), {
    now: NOW,
    population: null,
  });
  const b = assessEvent(
    ok({ id: 'b', affected_people_est: null, affected_population_pct: 2 }),
    { now: NOW, population: null },
  );
  const [c] = aggregateCountries([a, b]);
  assert.equal(c.mixedFigures, true);
  assert.equal(c.overlapPossible, false, 'no range is shown');
});

test('the reach range never exceeds the population', () => {
  const pop = 1_000_000;
  const e1 = assessEvent(ok({ id: 'e1', affected_people_est: 800_000 }), {
    now: NOW,
    population: pop,
  });
  const e2 = assessEvent(ok({ id: 'e2', affected_people_est: 700_000 }), {
    now: NOW,
    population: pop,
  });
  const [c] = aggregateCountries([e1, e2], { populationOf: () => pop });
  assert.equal(c.affectedPeople, 800_000);
  assert.equal(c.affectedPeopleHigh, 1_000_000);
  assert.equal(c.affectedPctHigh, 100);
});

test('an ongoing event not re-verified for 30 days counts half and says so', () => {
  const fresh = assessEvent(
    ok({ last_verified_time: '2026-11-05T00:00:00Z' }),
    {
      now: NOW,
      population: 5_000_000,
    },
  );
  const old = assessEvent(
    ok({
      start_time: '2026-02-01T00:00:00Z',
      last_verified_time: '2026-03-01T00:00:00Z',
    }),
    {
      now: NOW,
      population: 5_000_000,
    },
  );
  assert.equal(fresh.stale, false);
  assert.equal(old.stale, true);
  assert.ok(Math.abs(old.scores.share - fresh.scores.share / 2) < 1e-12);
  assert.equal(aggregateCountries([old])[0].stale, true);
  assert.match(
    normalizeEvent(raw({ last_verified_time: 'soon' })).error,
    /last_verified_time/,
  );
  assert.match(
    normalizeEvent(raw({ last_verified_time: '2026-10-01T00:00:00Z' })).error,
    /before start_time/,
  );
  assert.match(
    normalizeEvent(raw({ last_verified_time: '2026-11-20T00:00:00Z' }), {
      now: NOW,
    }).error,
    /future/,
  );
  // A stale severe event is no longer flagged systemic.
  const staleBig = assessEvent(
    ok({
      severity: 5,
      affected_people_est: 20_000_000,
      last_verified_time: '2026-03-01T00:00:00Z',
      start_time: '2026-02-01T00:00:00Z',
    }),
    { now: NOW, population: 50_000_000 },
  );
  assert.equal(isSystemic(staleBig), false);
});

test('a country whose events are all history keeps their figures', () => {
  const past = assessEvent(
    ok({
      start_time: '2026-01-01T00:00:00Z',
      resolved_time: '2026-01-02T00:00:00Z',
    }),
    { now: NOW, population: 5_000_000 },
  );
  const [c] = aggregateCountries([past], { history: true });
  assert.equal(c.historical, true);
  assert.equal(c.affectedPeople, 1_000_000);
  assert.equal(c.affectedPct, 20);
  assert.equal(c.scores.share, null, 'history is not scored');
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
  // Overlap unknown: a range from the largest event to the sum.
  assert.equal(lbn.affectedPeople, 500_000);
  assert.equal(lbn.affectedPeopleHigh, 1_000_000);
  assert.equal(lbn.affectedPct, 10);
  assert.equal(lbn.affectedPctHigh, 20);
  assert.equal(lbn.overlapPossible, true);
  assert.equal(lbn.type, 'withdrawal_limits', 'the strongest event leads');
  // Scored on the largest single event, never on the sum.
  assert.equal(lbn.scores.share, a.scores.share);
  assert.deepEqual(lbn.eventIds.sort(), ['a', 'b']);
  const all = aggregateCountries([a, b, old], { history: true });
  const jpn = all.find((c) => c.iso3 === 'JPN');
  assert.equal(jpn.historical, true);
  assert.deepEqual(jpn.classes, { share: 'history', people: 'history' });
});

test('a resolved event still fading never adds to an ongoing one', () => {
  // A resolved outage that reached half the country, and an ongoing one
  // reaching 1%: the country is cut off at 1% now, not up to 51%.
  const resolved = assessEvent(
    ok({
      id: 'old-1',
      event_type: 'technical_outage',
      affected_people_est: null,
      affected_population_pct: 50,
      resolved_time: new Date(NOW - DECAY_MS / 2).toISOString(),
    }),
    { now: NOW, population: 5_000_000 },
  );
  const ongoing = assessEvent(
    ok({
      id: 'new-1',
      affected_people_est: null,
      affected_population_pct: 1,
    }),
    { now: NOW, population: 5_000_000 },
  );
  assert.equal(resolved.historical, false);
  assert.ok(resolved.scores.share > ongoing.scores.share);
  const [both] = aggregateCountries([resolved, ongoing]);
  assert.equal(both.active, true);
  assert.equal(both.leadEventId, 'new-1');
  assert.equal(both.affectedPct, 1);
  assert.equal(both.affectedPctHigh, 1);
  assert.equal(both.affectedPeople, 50_000);
  assert.equal(both.affectedPeopleHigh, 50_000);
  assert.equal(both.overlapPossible, false);
  assert.equal(both.scores.share, ongoing.scores.share);
  // With nothing active, the fading event still shades its country, as
  // recent history.
  const [fading] = aggregateCountries([resolved]);
  assert.equal(fading.active, false);
  assert.equal(fading.historical, false);
  assert.equal(fading.affectedPct, 50);
  assert.equal(fading.scores.share, resolved.scores.share);
});

test('a future update date cannot stand in for a verification', () => {
  // No last_verified_time: the update date is used, so it must not lie ahead.
  assert.match(
    normalizeEvent(raw({ last_update_time: '2026-12-01T00:00:00Z' }), {
      now: NOW,
    }).error,
    /last_update_time in the future/,
  );
  // Within the day of slack, accepted.
  assert.equal(
    normalizeEvent(
      raw({ last_update_time: new Date(NOW + 12 * HOUR).toISOString() }),
      { now: NOW },
    ).error,
    undefined,
  );
  // A planned end still ahead confirms nothing: without a verification or
  // update date, the event is as old as its start and goes stale on time.
  const { event } = normalizeEvent(
    raw({
      start_time: '2026-02-01T00:00:00Z',
      resolved_time: '2027-01-01T00:00:00Z',
    }),
    { now: NOW },
  );
  assert.equal(event.verifiedAt, Date.parse('2026-02-01T00:00:00Z'));
  const planned = assessEvent(event, { now: NOW, population: 5_000_000 });
  assert.equal(planned.active, true);
  assert.equal(planned.stale, true);
});
