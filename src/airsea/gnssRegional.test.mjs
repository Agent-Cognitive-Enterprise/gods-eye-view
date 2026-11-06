import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRegionalGnssDetector,
  distanceKm,
  encodingArtefact,
  regionalCell,
  speedClassForShipType,
  REGIONAL_GNSS_RULES,
} from './gnssRegional.js';

const T = Date.parse('2026-11-06T00:00:00Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const mmsi = (i) => String(210000000 + i);
const fix = (i, at, p, extra = {}) => ({
  mmsi: mmsi(i),
  lat: p.lat,
  lon: p.lon,
  observedAt: T + at,
  receivedAt: T + at,
  timeQuality: 'source',
  ...extra,
});
/** A point `km` from `p` on a bearing (degrees), flat-earth (fine below 100 km). */
function move(p, km, bearing) {
  const b = (bearing * Math.PI) / 180;
  return {
    lat: p.lat + (km * Math.cos(b)) / 110.574,
    lon:
      p.lon + (km * Math.sin(b)) / (111.32 * Math.cos((p.lat * Math.PI) / 180)),
  };
}
/**
 * Report a vessel sailing steadily: every `everyS` seconds from `start` for
 * `minutes`. Returns where and when it last reported, and every answer.
 */
function sail(
  d,
  i,
  from,
  {
    knots = 12,
    bearing = 90,
    start = 0,
    minutes = 40,
    everyS = 60,
    extra,
  } = {},
) {
  let p = { ...from };
  let at = start;
  const answers = [];
  for (let s = 0; s <= minutes * 60; s += everyS) {
    at = start + s * 1000;
    if (s) p = move(p, (knots * 1.852 * everyS) / 3600, bearing);
    answers.push(d.observe(fix(i, at, p, extra)));
  }
  return { p, at, answers };
}
const where = (lat, lon) => ({ lat, lon });
const GULF = where(26.6, 53.0);
const detector = (rules = {}, options = {}) =>
  createRegionalGnssDetector({
    rules: { ...REGIONAL_GNSS_RULES, ...rules },
    now: () => T,
    ...options,
  });
const snap = (d, at, feedStatus = 'healthy') =>
  d.snapshot({ at: T + at, feedStatus });
const count = (answers, key, value) =>
  answers.filter((a) => a[key] === value).length;
/** Three ships, side by side and watched for 40 minutes, then all spoofed to one point. */
function threeSpoofed(
  d,
  { target = where(27.9, 55.2), ids = [1, 2, 3], start = 0 } = {},
) {
  const ships = ids.map((i, k) => ({
    i,
    ...sail(d, i, move(GULF, 3 * k, 0), { start }),
  }));
  const jumpAt = ships[0].at + MIN;
  const answers = ships.map(({ i }, k) =>
    d.observe(fix(i, jumpAt + k * 1000, move(target, 0.2 * k, 90))),
  );
  return { ships, jumpAt, answers, target };
}

test('haversine is dateline safe; the degree grid is stable at +/-180', () => {
  assert.ok(
    distanceKm({ lat: 0.1, lon: 179.9 }, { lat: 0.1, lon: -179.9 }) < 25,
  );
  assert.equal(regionalCell(0, 180), regionalCell(0, -180));
  assert.equal(regionalCell(85, 0), null);
});

test('ship types map to speed classes; class B without a type is a small craft', () => {
  assert.equal(speedClassForShipType(70), 'merchant');
  assert.equal(speedClassForShipType(84), 'merchant');
  assert.equal(speedClassForShipType(60), 'passenger');
  assert.equal(speedClassForShipType(40), 'fast');
  assert.equal(speedClassForShipType(37), 'fast');
  assert.equal(speedClassForShipType(30), 'work');
  assert.equal(speedClassForShipType(52), 'work');
  assert.equal(speedClassForShipType(0), 'unknown');
  assert.equal(speedClassForShipType(undefined), 'unknown');
  assert.equal(speedClassForShipType(undefined, { classB: true }), 'fast');
  assert.equal(speedClassForShipType(90), 'unknown');
});

test('normal cruising: fifty ships for two hours are all plausible, no region', () => {
  const d = detector();
  const all = [];
  for (let i = 1; i <= 50; i++)
    all.push(
      ...sail(d, i, move(GULF, i, 45), {
        knots: 6 + (i % 15),
        bearing: (i * 37) % 360,
        minutes: 120,
        everyS: 30,
      }).answers,
    );
  assert.equal(count(all, 'assessment', 'implausible'), 0);
  assert.equal(count(all, 'assessment', 'unknown'), 50); // first sight only
  const s = snap(d, 120 * MIN);
  assert.equal(s.regions.length, 0);
  assert.equal(s.status, 'observing');
});

test('fast craft: a typed high-speed craft at 45 kn is plausible throughout', () => {
  const d = detector();
  d.observeStatic({ mmsi: mmsi(1), shipType: 40, receivedAt: T });
  const { answers } = sail(d, 1, GULF, { knots: 45, minutes: 30, everyS: 10 });
  assert.equal(count(answers, 'assessment', 'plausible'), answers.length - 1);
});

test('fast craft: an untyped boat at 55 kn is suspicious until it shows that pace, then plausible', () => {
  const d = detector();
  const { answers } = sail(d, 1, GULF, { knots: 55, minutes: 30, everyS: 10 });
  assert.equal(count(answers, 'assessment', 'implausible'), 0);
  const confirmed = answers.findIndex(
    (a) => a.reason === 'fast_vessel_confirmed',
  );
  assert.ok(
    confirmed > 0 && confirmed < 30,
    `confirmed at report ${confirmed}`,
  );
  assert.ok(
    answers.slice(confirmed).every((a) => a.assessment === 'plausible'),
  );
});

test('a cargo ship at 35 kn is suspicious, never confirmed and never implausible', () => {
  const d = detector();
  d.observeStatic({ mmsi: mmsi(1), shipType: 70, receivedAt: T });
  const { answers } = sail(d, 1, GULF, { knots: 35, minutes: 30, everyS: 10 });
  assert.equal(count(answers, 'assessment', 'implausible'), 0);
  assert.equal(count(answers, 'reason', 'fast_vessel_confirmed'), 0);
  assert.ok(count(answers, 'assessment', 'unknown') > answers.length / 2);
});

test('AIS gaps: a reappearance within reach of the whole gap is plausible, not suspicious', () => {
  const d = detector();
  d.observeStatic({ mmsi: mmsi(1), shipType: 80, receivedAt: T });
  const { p, at } = sail(d, 1, GULF, { knots: 14, minutes: 40 });
  // Two hours dark; it slowed to 12 kn and turned: 44 km away.
  const back = d.observe(fix(1, at + 2 * HOUR, move(p, 44, 120)));
  assert.equal(back.assessment, 'plausible');
  assert.equal(back.afterGap, true);
  // Even if it had made 25 kn in the dark, well above its earlier 14 kn.
  const d2 = detector();
  d2.observeStatic({ mmsi: mmsi(1), shipType: 80, receivedAt: T });
  const first = sail(d2, 1, GULF, { knots: 14, minutes: 40 });
  assert.equal(
    d2.observe(fix(1, first.at + 2 * HOUR, move(first.p, 92, 90))).assessment,
    'plausible',
  );
});

test('AIS gaps: a reappearance a cargo ship could not reach is suspicious or implausible, never a vote', () => {
  const d = detector({ minVessels: 1 });
  for (const i of [1, 2])
    d.observeStatic({ mmsi: mmsi(i), shipType: 70, receivedAt: T });
  const a = sail(d, 1, GULF, { knots: 14, minutes: 40 });
  const b = sail(d, 2, move(GULF, 5, 0), { knots: 14, minutes: 40 });
  // 2 hours, 130 km: 35 kn, over the 30 kn screen, under the 40 kn limit.
  const far = d.observe(fix(1, a.at + 2 * HOUR, move(a.p, 130, 90)));
  assert.equal(far.assessment, 'unknown');
  // 2 hours, 300 km: beyond any cargo ship; but a two-hour-old fix is no
  // basis for a regional vote.
  const farther = d.observe(fix(2, b.at + 2 * HOUR, move(b.p, 300, 90)));
  assert.equal(farther.assessment, 'implausible');
  assert.equal(farther.candidate, false);
  assert.equal(snap(d, b.at + 2 * HOUR).regions.length, 0);
});

test('AIS gaps: silence alone is never evidence; a dark ship is simply not tracked', () => {
  const d = detector();
  const ships = [1, 2, 3, 4].map((i) => sail(d, i, move(GULF, i, 0)));
  // All four go dark together for six hours.
  const s = snap(d, ships[0].at + 6 * HOUR);
  assert.equal(s.regions.length, 0);
  assert.equal(s.diagnostic.implausible, 0);
  assert.equal(s.coverage.stale, true);
  assert.equal(s.status, 'coverage_uncertain');
});

test('coordinated anomaly: three ships jumping to one point make one region where they really are', () => {
  const d = detector();
  const { answers, jumpAt, target } = threeSpoofed(d);
  assert.deepEqual(
    answers.map((a) => a.assessment),
    ['implausible', 'implausible', 'implausible'],
  );
  assert.ok(answers.every((a) => a.candidate));
  const s = snap(d, jumpAt + 5000);
  assert.equal(s.status, 'candidate_regions');
  assert.equal(s.regions.length, 1);
  const [region] = s.regions;
  assert.equal(region.evidence.coherentTargetVessels, 3);
  assert.equal(region.evidence.aggregation, 'h3-r4');
  assert.equal(region.eventPriority, 'advisory');
  const { south, north, west, east } = region.area;
  assert.ok(
    south <= GULF.lat &&
      north >= GULF.lat &&
      west <= GULF.lon + 0.5 &&
      east >= GULF.lon,
  );
  assert.ok(
    !(
      south <= target.lat &&
      north >= target.lat &&
      west <= target.lon &&
      east >= target.lon
    ),
  );
  // About 50 km cells: the area is under a degree, far smaller than the jump.
  assert.ok(north - south < 1, `${north - south}`);
  const text = JSON.stringify(s);
  assert.ok(![1, 2, 3].some((i) => text.includes(mmsi(i))));
  assert.ok(!text.includes(String(target.lat)));
});

test('coordinated anomaly: a cluster split by a cell edge still forms one region', () => {
  const d = detector();
  // Ships about 15 km apart: different H3 cells, neighbours of each other.
  const { jumpAt } = threeSpoofed(d, { ids: [1, 2, 3] });
  const ships = [4, 5].map((i, k) => sail(d, i, move(GULF, 15 + 12 * k, 90)));
  const at = Math.max(jumpAt, ships[1].at) + MIN;
  ships.forEach(({ p }, k) =>
    d.observe(fix(4 + k, at + k * 1000, move(where(27.9, 55.2), 1, 0))),
  );
  const s = snap(d, at + 5000);
  assert.equal(s.regions.length, 1);
  assert.ok(s.regions[0].evidence.uniqueVessels >= 3);
});

test('two ships, or three jumping to scattered places, or short jumps, make no region', () => {
  const two = detector();
  const { jumpAt } = threeSpoofed(two, { ids: [1, 2] });
  assert.equal(snap(two, jumpAt + 5000).regions.length, 0);

  const scattered = detector();
  const ships = [1, 2, 3].map((i) => sail(scattered, i, move(GULF, 3 * i, 0)));
  const at = ships[0].at + MIN;
  [where(28.5, 50.0), where(24.0, 57.5), where(29.5, 49.0)].forEach((p, k) =>
    scattered.observe(fix(k + 1, at + k * 1000, p)),
  );
  const s = snap(scattered, at + 5000);
  assert.equal(s.regions.length, 0);
  assert.equal(s.diagnostic.candidateReports, 3);

  // 30 km jumps: impossible in a minute, but too short to vote.
  const short = detector();
  const near = threeSpoofed(short, { target: move(GULF, 30, 90) });
  assert.ok(
    near.answers.every((a) => a.assessment === 'implausible' && !a.candidate),
  );
  assert.equal(snap(short, near.jumpAt + 5000).regions.length, 0);
});

test('tracks watched under 30 minutes, or with one report, never vote', () => {
  const d = detector();
  const ships = [1, 2, 3].map((i) =>
    sail(d, i, move(GULF, 3 * i, 0), { minutes: 20 }),
  );
  const at = ships[0].at + MIN;
  const answers = [1, 2, 3].map((i, k) =>
    d.observe(fix(i, at + k * 1000, where(27.9, 55.2))),
  );
  assert.ok(
    answers.every(
      (a) => a.assessment === 'implausible' && a.candidate === false,
    ),
  );
  assert.equal(snap(d, at + 5000).regions.length, 0);
});

test('sustained spoof: held for three hours, never adopted, the region stays where the ships were', () => {
  const d = detector();
  const { jumpAt, target } = threeSpoofed(d);
  const answers = [];
  for (let t = jumpAt + MIN; t <= jumpAt + 3 * HOUR; t += MIN) {
    for (const i of [1, 2, 3])
      answers.push(
        d.observe(fix(i, t + i * 1000, move(target, 0.2 * (i - 1), 90))),
      );
    if ((t - jumpAt) % HOUR) continue;
    const s = snap(d, t + 5000);
    assert.equal(s.regions.length, 1, `hour ${(t - jumpAt) / HOUR}`);
    assert.ok(s.regions[0].area.south < GULF.lat + 0.5);
    assert.equal(s.regions[0].firstSeenAt, T + jumpAt);
  }
  assert.ok(answers.every((a) => a.assessment === 'implausible'));
});

test('sustained spoof: a spoofed position drifting at 10 kn stays quarantined', () => {
  const d = detector();
  const { jumpAt, target } = threeSpoofed(d);
  let p = { ...target };
  const answers = [];
  for (let t = jumpAt + MIN; t <= jumpAt + 2 * HOUR; t += MIN) {
    p = move(p, (10 * 1.852) / 60, 200);
    answers.push(d.observe(fix(1, t, p)));
  }
  assert.ok(answers.every((a) => a.assessment === 'implausible'));
});

test('sustained spoof: a spoof held through a three-hour reception gap is still not adopted', () => {
  const d = detector({ minVessels: 1 });
  // 60 km away: reachable from the old fix after three hours at 11 kn.
  const ship = sail(d, 1, GULF, { knots: 12 });
  // Off its course: a spoof on the course at the right distance is the one
  // case the own-track check cannot tell from the ship.
  const spoof = move(ship.p, 60, 40);
  assert.equal(
    d.observe(fix(1, ship.at + MIN, spoof)).assessment,
    'implausible',
  );
  d.observe(fix(1, ship.at + 2 * MIN, spoof));
  const after = d.observe(fix(1, ship.at + 3 * HOUR, move(spoof, 0.3, 90)));
  assert.equal(after.assessment, 'implausible');
  assert.equal(after.reason, 'quarantined');
});

test('return to genuine positions: an explicit recovery, then the region ages out and stays gone', () => {
  const d = detector();
  const { ships, jumpAt, target } = threeSpoofed(d);
  for (let t = jumpAt + MIN; t <= jumpAt + HOUR; t += MIN)
    for (const i of [1, 2, 3]) d.observe(fix(i, t + i * 1000, target));
  // The ships sailed on at 12 kn the whole time; their true positions return.
  const backAt = jumpAt + HOUR + MIN;
  const answers = ships.map(({ i, p, at }) => {
    const out = [];
    for (let k = 0; k < 4; k++) {
      const t = backAt + k * 30_000;
      out.push(
        d.observe(
          fix(i, t + i * 1000, move(p, (12 * 1.852 * (t - at)) / HOUR, 90)),
        ),
      );
    }
    return out;
  });
  for (const out of answers) {
    assert.equal(out[0].reason, 'recovery_pending');
    assert.equal(out[0].assessment, 'unknown');
    assert.equal(out[2].reason, 'recovered');
    assert.equal(out[3].assessment, 'plausible');
  }
  assert.equal(snap(d, backAt + 4 * MIN).regions.length, 1); // still within 30 min
  const ended = snap(d, backAt + 40 * MIN);
  assert.equal(ended.regions.length, 0);
  assert.equal(ended.recentIncidents.length, 1);
  assert.equal(ended.recentIncidents[0].state, 'ended');
  // And a second, later spoof is caught again from the recovered tracks.
  const again = backAt + 3 * HOUR;
  for (const { i } of ships) {
    const s = sail(d, i, move(GULF, 3 * i, 0), { start: again - 40 * MIN });
    assert.equal(
      d.observe(fix(i, s.at + MIN, target)).assessment,
      'implausible',
    );
  }
});

test('recovery needs three consistent reports: a spoof hopping around is never trusted', () => {
  const d = detector({ minVessels: 1 });
  const ship = sail(d, 1, GULF);
  const answers = [];
  // Hops between points 15 km apart every report, three hours on: some are
  // reachable from the old fix, none continue one another.
  for (let k = 0; k < 180; k++) {
    const p = move(ship.p, 40 + (k % 3) * 15, (k * 77) % 360);
    answers.push(d.observe(fix(1, ship.at + (k + 1) * MIN, p)));
  }
  assert.equal(count(answers, 'reason', 'recovered'), 0);
  assert.equal(count(answers, 'assessment', 'plausible'), 0);
});

test('a single glitch: the ship is trusted again within three reports, never frozen', () => {
  const d = detector();
  const ship = sail(d, 1, GULF, { everyS: 10, minutes: 10 });
  assert.equal(
    d.observe(fix(1, ship.at + 10_000, move(ship.p, 30, 0))).assessment,
    'implausible',
  );
  const after = [];
  let p = ship.p;
  for (let k = 2; k <= 12; k++) {
    p = move(p, (12 * 1.852 * 10) / 3600, 90);
    after.push(d.observe(fix(1, ship.at + k * 10_000, p)));
  }
  // Three consistent reports over a minute or more: the seventh at 10 s.
  assert.equal(
    after.findIndex((a) => a.reason === 'recovered'),
    6,
  );
  assert.ok(after.slice(7).every((a) => a.assessment === 'plausible'));
});

test('a drag of half a kilometre every five seconds is caught, though each step looks small', () => {
  const d = detector();
  const ship = sail(d, 1, GULF, { everyS: 10, minutes: 10 });
  const answers = [];
  for (let k = 1; k <= 60; k++)
    answers.push(
      d.observe(fix(1, ship.at + k * 5000, move(ship.p, 0.6 * k, 0))),
    );
  assert.ok(count(answers, 'assessment', 'implausible') > 0);
  assert.equal(count(answers.slice(30), 'assessment', 'plausible'), 0);
});

test('gradual drift from the true track at ship speed is not caught (a known limit)', () => {
  const d = detector({ minVessels: 1 });
  const ship = sail(d, 1, GULF, { knots: 12 });
  // The reported track bends away at 12 kn: believable for any ship.
  const { answers } = sail(d, 1, ship.p, {
    knots: 12,
    bearing: 30,
    start: ship.at + MIN,
    minutes: 60,
  });
  assert.equal(count(answers, 'assessment', 'implausible'), 0);
});

test('stale receiver backlogs and replays are refused, never judged', () => {
  const d = detector();
  const ship = sail(d, 1, GULF);
  const late = {
    ...fix(1, ship.at - 30 * MIN, GULF),
    receivedAt: T + ship.at + MIN,
  };
  assert.deepEqual(d.observe(late), {
    accepted: false,
    reason: 'stale_or_future',
  });
  const replay = fix(1, ship.at, move(GULF, 100, 0));
  assert.equal(d.observe(replay).reason, 'duplicate_or_out_of_order');
  // A two-minute backlog in order is fine.
  const backlog = {
    ...fix(1, ship.at + 10_000, move(ship.p, 0.05, 90)),
    receivedAt: T + ship.at + 130_000,
  };
  assert.equal(d.observe(backlog).assessment, 'plausible');
});

test('land: a jump from the sea deep inland is implausible with land evidence', () => {
  // A toy geography: land north of 27.5 N.
  const geography = {
    source: 'toy',
    inlandKm: (lat) => Math.max(0, (lat - 27.5) * 110),
    straightLineClear: () => true,
    routeKm: () => ({ status: 'unknown', why: 'toy' }),
  };
  const d = detector({}, { geography });
  const { answers } = threeSpoofed(d, { target: where(28.0, 53.2) });
  assert.ok(
    answers.every(
      (a) => a.assessment === 'implausible' && a.evidence.includes('land'),
    ),
  );
  const s = snap(d, Date.parse('2026-11-06T00:45:00Z') - T);
  assert.equal(s.regions[0]?.evidence.landTargetVessels, 3);
  assert.equal(s.coverage.geography, 'toy');
});

test('land: onto land at a ship pace is suspicious only; river traffic is not land evidence', () => {
  const geography = {
    source: 'toy',
    inlandKm: (lat) => Math.max(0, (lat - 27.5) * 110),
    straightLineClear: () => true,
    routeKm: () => ({ status: 'unknown', why: 'toy' }),
  };
  const d = detector({}, { geography });
  const ship = sail(d, 1, where(27.4, 53), {
    knots: 10,
    bearing: 0,
    minutes: 30,
  });
  // Dark for two hours, back 25 km inland: a ship could have sailed up a river.
  const up = d.observe(fix(1, ship.at + 2 * HOUR, where(27.85, 53)));
  assert.equal(up.assessment, 'unknown');
  assert.ok(up.evidence.includes('land'));
  // A vessel first seen inland (a river or lake) moves about freely.
  const river = sail(d, 2, where(28.2, 53), { knots: 10, minutes: 30 });
  assert.equal(
    count(river.answers, 'assessment', 'plausible'),
    river.answers.length - 1,
  );
  const jump = d.observe(fix(2, river.at + HOUR, where(28.6, 53.3)));
  assert.ok(!jump.evidence.includes('land'));
});

test('route: a move a water route makes too long is suspicious, with route evidence', () => {
  const geography = {
    source: 'toy',
    inlandKm: () => 0,
    straightLineClear: () => false,
    routeKm: (a, b, limit) => ({ status: 'longer', limit }),
  };
  const d = detector({}, { geography });
  d.observeStatic({ mmsi: mmsi(1), shipType: 80, receivedAt: T });
  const ship = sail(d, 1, GULF);
  const answer = d.observe(fix(1, ship.at + 3 * HOUR, move(ship.p, 100, 90)));
  assert.equal(answer.assessment, 'unknown');
  assert.ok(answer.evidence.includes('route'));
});

test('per-vessel history: the last credible position is kept a day, then the track starts afresh', () => {
  const d = detector();
  const ship = sail(d, 1, GULF);
  assert.equal(
    d.observe(fix(1, ship.at + 20 * HOUR, move(ship.p, 200, 0))).assessment,
    'plausible',
  );
  const d2 = detector();
  const s2 = sail(d2, 1, GULF);
  assert.equal(
    d2.observe(fix(1, s2.at + 25 * HOUR, move(s2.p, 2000, 0))).reason,
    'first_seen',
  );
});

test('the 1-degree grid can be chosen for comparison', () => {
  const d = detector({ grid: 'degree' });
  const { jumpAt } = threeSpoofed(d);
  const s = snap(d, jumpAt + 5000);
  assert.equal(s.regions.length, 1);
  assert.equal(s.regions[0].evidence.aggregation, 'degree-1');
  assert.equal(s.regions[0].area.north - s.regions[0].area.south, 1);
  assert.throws(() => detector({ grid: 'degree', cellDeg: 7 }), /divide 360/);
});

test('feed degraded, unconfigured or stale suppresses regions', () => {
  const d = detector();
  const { jumpAt } = threeSpoofed(d);
  assert.equal(snap(d, jumpAt + 5000, 'degraded').regions.length, 0);
  assert.equal(snap(d, jumpAt + 5000, 'degraded').status, 'coverage_uncertain');
  assert.equal(snap(d, jumpAt + 5000, 'unconfigured').status, 'unconfigured');
  assert.equal(snap(d, jumpAt + 10 * MIN).status, 'coverage_uncertain');
});

test('warming_up for the first 30 minutes', () => {
  let clock = T;
  const d = createRegionalGnssDetector({ now: () => clock });
  d.observe(fix(1, 0, GULF));
  assert.equal(
    d.snapshot({ at: T + 1000, feedStatus: 'healthy' }).status,
    'warming_up',
  );
  clock = T + 31 * MIN;
  d.observe(fix(1, 31 * MIN, GULF));
  assert.equal(
    d.snapshot({ at: T + 31 * MIN, feedStatus: 'healthy' }).status,
    'observing',
  );
});

test('placeholder and non-ship MMSIs, bad positions and untrusted times are refused', () => {
  const d = detector();
  for (const id of [
    '111111111',
    '412000000',
    '123456789',
    '99',
    '970123456',
    '21000000x',
  ])
    assert.equal(
      d.observe({ ...fix(1, 0, GULF), mmsi: id }).reason,
      'invalid_id',
      id,
    );
  assert.equal(d.observe(fix(1, 0, where(0, 0))).reason, 'invalid_position');
  assert.equal(d.observe(fix(1, 0, where(86, 0))).reason, 'invalid_position');
  assert.equal(
    d.observe({ ...fix(1, 0, GULF), timeQuality: 'receipt' }).reason,
    'untrusted_time',
  );
  assert.equal(d.observeStatic({ mmsi: '111111111', shipType: 70 }), false);
  assert.equal(d.observeStatic({ mmsi: mmsi(1), shipType: 0 }), false);
  assert.equal(d.observeStatic({ mmsi: mmsi(1), shipType: 70 }), true);
});

test('memory stays bounded', () => {
  const d = detector({ maxTrackedVessels: 10, maxStatic: 5 });
  for (let i = 1; i <= 30; i++) {
    d.observe(fix(i, i * 1000, move(GULF, i, 0)));
    d.observeStatic({ mmsi: mmsi(i), shipType: 70, receivedAt: T });
  }
  const s = snap(d, 31_000);
  assert.equal(s.diagnostic.tracked, 10);
  assert.equal(s.diagnostic.staticTypes, 5);
  assert.ok(s.diagnostic.evicted >= 45);
});

test('corrupted position fields: one axis, sign flips and swaps are named', () => {
  const p = where(52.05, 4.88);
  assert.equal(encodingArtefact(p, where(52.05, 0.007)), 'zeroed');
  assert.equal(encodingArtefact(p, where(52.05, 0.1)), 'zeroed');
  assert.equal(encodingArtefact(p, where(52.05, 2.5)), 'one_axis');
  assert.equal(encodingArtefact(p, where(50.1, 4.88)), 'one_axis');
  assert.equal(encodingArtefact(p, where(52.05, -4.88)), 'sign_flip');
  assert.equal(encodingArtefact(p, where(4.88, 52.05)), 'swapped');
  assert.equal(encodingArtefact(p, where(52.9, 6.1)), null);
});

test('the live artefact: inland ships reporting their latitude with a longitude near 0 never make a region', () => {
  // As seen on 4173: several vessels near 52 N 4.9 E, within minutes, each
  // one report at the same latitude and a longitude of about 0.007.
  const d = detector();
  const ships = [1, 2, 3, 4, 5].map((i) =>
    sail(d, i, where(51.9 + 0.03 * i, 4.6 + 0.08 * i), { knots: 8 }),
  );
  const at = ships[4].at + MIN;
  const answers = ships.map(({ p }, k) =>
    d.observe(fix(k + 1, at + k * 20_000, where(p.lat, p.lon * 0.0015))),
  );
  for (const a of answers) {
    assert.equal(a.assessment, 'implausible');
    assert.ok(a.evidence.includes('encoding'));
    assert.equal(a.candidate, false);
  }
  assert.equal(snap(d, at + 2 * MIN).regions.length, 0);
});

test('a ship back elsewhere after a long gap is judged afresh, not as the spoof it left', () => {
  const d = detector({ minVessels: 1 });
  const ship = sail(d, 1, GULF, { knots: 12, bearing: 0 });
  const spoof = move(ship.p, 60, 0);
  d.observe(fix(1, ship.at + MIN, spoof));
  d.observe(fix(1, ship.at + 2 * MIN, spoof));
  // Three hours dark; it really sailed 40 km north: nearer the old spoof
  // point than its last credible fix, but not at it.
  const back = [0, 1, 2, 3].map((k) =>
    d.observe(
      fix(1, ship.at + 3 * HOUR + k * 30_000, move(ship.p, 40 + 0.2 * k, 0)),
    ),
  );
  assert.equal(back[0].reason, 'recovery_pending');
  assert.equal(back[2].reason, 'recovered');
});

test('one glitch inside the screening speed does not block the next honest report', () => {
  const d = detector();
  const ship = sail(d, 1, GULF, { everyS: 2, minutes: 5, bearing: 0 });
  // 0.85 km to one side for one report, then 0.1 km to the other.
  assert.equal(
    d.observe(fix(1, ship.at + 2000, move(ship.p, 0.85, 90))).assessment,
    'plausible',
  );
  assert.equal(
    d.observe(fix(1, ship.at + 4000, move(ship.p, 0.1, 270))).assessment,
    'plausible',
  );
});

test('recovery needs three reports even when they are minutes apart', () => {
  const d = detector({ minVessels: 1 });
  const ship = sail(d, 1, GULF, { bearing: 0 });
  d.observe(fix(1, ship.at + MIN, move(ship.p, 80, 0)));
  const back = [1, 2, 3].map((k) =>
    d.observe(
      fix(
        1,
        ship.at + MIN + k * 90_000,
        move(ship.p, (12 * 1.852 * (MIN + k * 90_000)) / HOUR, 0),
      ),
    ),
  );
  assert.deepEqual(
    back.map((a) => a.reason),
    ['recovery_pending', 'recovery_pending', 'recovered'],
  );
});

test('a boat that glitches while slow and then speeds up is confirmed, not frozen', () => {
  const d = detector();
  const ship = sail(d, 1, GULF, {
    knots: 10,
    everyS: 10,
    minutes: 10,
    bearing: 0,
  });
  assert.equal(
    d.observe(fix(1, ship.at + 10_000, move(ship.p, 40, 200))).assessment,
    'implausible',
  );
  // Straight to 70 kn, reported each minute: too fast to read as a return
  // to the old track, so the episode ends only when the pace is confirmed.
  const fast = sail(d, 1, move(ship.p, 0.1, 0), {
    knots: 70,
    everyS: 60,
    minutes: 15,
    start: ship.at + 20_000,
    bearing: 0,
  });
  assert.equal(count(fast.answers, 'reason', 'recovered'), 0);
  const confirmed = fast.answers.findIndex(
    (a) => a.reason === 'fast_vessel_confirmed',
  );
  assert.ok(confirmed > 0, 'confirmed');
  assert.ok(
    fast.answers.slice(confirmed).every((a) => a.assessment === 'plausible'),
  );
});

test('a suspicious reappearance that then sits still is not confirmed as a fast boat', () => {
  const d = detector();
  const ship = sail(d, 1, GULF, { bearing: 0 });
  // 30 minutes dark, back 56 km away (60 kn), then anchored.
  const far = move(ship.p, 56, 20);
  const answers = [0, 1, 2, 3, 4, 5].map((k) =>
    d.observe(fix(1, ship.at + 30 * MIN + k * MIN, far)),
  );
  assert.equal(answers[0].assessment, 'unknown');
  assert.equal(count(answers, 'reason', 'fast_vessel_confirmed'), 0);
});

test('votes need a credible fix at most 30 minutes old, a 50 km jump, and a target outside the neighbours', () => {
  // After a two-hour gap: implausible, but no vote.
  const gap = detector({ minVessels: 1 });
  const g = sail(gap, 1, GULF, { bearing: 0 });
  const late = gap.observe(fix(1, g.at + 2 * HOUR, move(g.p, 600, 20)));
  assert.equal(late.assessment, 'implausible');
  assert.equal(late.candidate, false);
  const prompt = detector({ minVessels: 1 });
  const q = sail(prompt, 1, GULF, { bearing: 0 });
  assert.equal(
    prompt.observe(fix(1, q.at + MIN, move(q.p, 600, 20))).candidate,
    true,
  );
  // 40 km: outside the neighbouring cells, but short of 50 km.
  const short = detector({ minVessels: 1 });
  const s = sail(short, 1, GULF, { bearing: 0 });
  const jump = short.observe(fix(1, s.at + MIN, move(s.p, 40, 20)));
  assert.equal(jump.assessment, 'implausible');
  assert.equal(jump.candidate, false);
});

const toyLand = {
  source: 'toy',
  inlandKm: (lat) => Math.max(0, (lat - 27.5) * 110),
  straightLineClear: () => true,
  routeKm: () => ({ status: 'unknown', why: 'toy' }),
};

test('land: a jump onto land votes from 10 km, but never inside the neighbouring cells', () => {
  const d = detector({ minVessels: 1 }, { geography: toyLand });
  const a = sail(d, 1, where(27.45, 53), { bearing: 0, knots: 1 });
  // 15 km inland: within the neighbouring cells.
  const near = d.observe(fix(1, a.at + MIN, move(a.p, 15, 10)));
  assert.equal(near.assessment, 'implausible');
  assert.ok(near.evidence.includes('land'));
  assert.equal(near.candidate, false);
  const d2 = detector({ minVessels: 1 }, { geography: toyLand });
  const b = sail(d2, 1, where(27.45, 53), { bearing: 0, knots: 1 });
  // 35 km inland: under 50 km, but onto land and outside the neighbours.
  const far = d2.observe(fix(1, b.at + MIN, move(b.p, 35, 10)));
  assert.equal(far.candidate, true);
});

test('land: onto land faster than a cargo ship should go, though under its limit, is implausible', () => {
  const d = detector({}, { geography: toyLand });
  d.observeStatic({ mmsi: mmsi(1), shipType: 70, receivedAt: T });
  const a = sail(d, 1, where(27.45, 53), { bearing: 0, knots: 10 });
  // 20 km in 18 minutes: 36 kn, between 30 and 40.
  const answer = d.observe(fix(1, a.at + 18 * MIN, move(a.p, 20, 5)));
  assert.equal(answer.assessment, 'implausible');
  assert.ok(answer.evidence.includes('land'));
});

test('land: a vessel once seen inland is not land evidence when it heads back inland', () => {
  const d = detector({}, { geography: toyLand });
  // Down a river to the coast, then dark, then back 25 km upriver.
  const down = sail(d, 1, where(27.75, 53), {
    bearing: 180,
    knots: 10,
    minutes: 60,
  });
  assert.ok(toyLand.inlandKm(down.p.lat) < 10);
  const up = d.observe(fix(1, down.at + 2 * HOUR, move(down.p, 25, 0)));
  assert.ok(!up.evidence.includes('land'));
  assert.equal(up.assessment, 'plausible');
});

test('one-digit placeholders are refused even with a ship country code', () => {
  const d = detector();
  assert.equal(
    d.observe({ ...fix(1, 0, GULF), mmsi: '222222222' }).reason,
    'invalid_id',
  );
  assert.equal(
    d.observe({ ...fix(1, 0, GULF), mmsi: '333333333' }).reason,
    'invalid_id',
  );
});

test('a latitude with its sign flipped is a sign flip, not a one-axis jump', () => {
  assert.equal(
    encodingArtefact(where(52.05, 4.88), where(-52.05, 4.88)),
    'sign_flip',
  );
});

// Red-team round 6 (6 November 2026): each of these was a confirmed defect.

/** A small deterministic random sequence. */
const random =
  (seed = 7) =>
  () =>
    (seed = (seed * 16807) % 2147483647) / 2147483647;

test('a spoof that jitters about its point for 12 hours is never adopted; the region stays where the ships are', () => {
  const d = detector();
  const rnd = random();
  const ships = [1, 2, 3].map((i, k) => ({
    i,
    ...sail(d, i, move(GULF, 3 * k, 90)),
  }));
  const X = move(GULF, 100, 0);
  const jumpAt = ships[0].at + MIN;
  const reasons = {};
  for (let t = jumpAt; t <= jumpAt + 12 * HOUR; t += 20_000) {
    for (const { i } of ships) {
      const a = d.observe(
        fix(i, t + i * 1000, move(X, 1.5 * rnd(), 360 * rnd())),
      );
      reasons[a.reason] = (reasons[a.reason] ?? 0) + 1;
    }
    if ((t - jumpAt) % (2 * HOUR) === 0) {
      const s = snap(d, t + 5000);
      assert.equal(s.regions.length, 1, `h+${(t - jumpAt) / HOUR}`);
      assert.ok(s.regions[0].area.north < 27.3);
    }
  }
  assert.equal(reasons.recovered, undefined);
  assert.equal(reasons.plausible, undefined);
});

test('a spoof circling 2 km at 10 kn for 8 hours is never adopted', () => {
  const d = detector({ minVessels: 1 });
  const ship = sail(d, 1, GULF);
  const X = move(GULF, 100, 0);
  const answers = [];
  for (let t = 0; t <= 8 * HOUR; t += 20_000) {
    const angle = ((t / HOUR) * 10 * 1.852 * 360) / (2 * Math.PI * 2);
    answers.push(d.observe(fix(1, ship.at + MIN + t, move(X, 2, angle))));
  }
  assert.ok(answers.every((a) => a.assessment === 'implausible'));
});

test('a held spoof that outlasts the 24-hour history never votes from the false position', () => {
  const d = detector({ minVessels: 1 });
  const ship = sail(d, 1, GULF, { bearing: 0 });
  // Not due north: a jump along a meridian reads as a corrupted field.
  const spoof = move(ship.p, 80, 25);
  const answers = [];
  // Reported every 5 minutes: the new track after the reset is continuous.
  for (let t = ship.at + MIN; t <= ship.at + 25 * HOUR; t += 5 * MIN)
    answers.push(d.observe(fix(1, t, spoof)));
  // Quarantined until its credible fix is a day old, then a new track...
  const reset = answers.findIndex((a) => a.reason === 'first_seen');
  assert.equal(reset, 288);
  assert.ok(
    answers.slice(0, reset).every((a) => a.assessment === 'implausible'),
  );
  assert.equal(snap(d, ship.at + 25 * HOUR).diagnostic.historyResets, 1);
  // ...which may sit on the spoof, so the return to the real track does not vote.
  const back = d.observe(fix(1, ship.at + 25 * HOUR + MIN, ship.p));
  assert.equal(back.assessment, 'implausible');
  assert.equal(back.candidate, false);
});

test('a track resumed after a gap votes only once it has been continuous for 30 minutes again', () => {
  const d = detector({ minVessels: 1 });
  const ship = sail(d, 1, GULF, { bearing: 0 });
  // Five hours dark, then 40 minutes of plausible reports from a new spot.
  const resumed = sail(d, 1, move(ship.p, 30, 0), {
    start: ship.at + 5 * HOUR,
    minutes: 20,
    bearing: 0,
  });
  assert.equal(resumed.answers[0].assessment, 'plausible');
  const early = d.observe(fix(1, resumed.at + MIN, move(resumed.p, 120, 30)));
  assert.equal(early.assessment, 'implausible');
  assert.equal(early.candidate, false);
  const d2 = detector({ minVessels: 1 });
  const s2 = sail(d2, 1, GULF, { bearing: 0 });
  const r2 = sail(d2, 1, move(s2.p, 30, 0), {
    start: s2.at + 5 * HOUR,
    minutes: 35,
    bearing: 0,
  });
  assert.equal(
    d2.observe(fix(1, r2.at + MIN, move(r2.p, 120, 30))).candidate,
    true,
  );
});

test('the live artefact is caught whatever the ships heading', () => {
  for (const bearing of [0, 45, 90, 200]) {
    const d = detector();
    const ships = [1, 2, 3, 4, 5].map((i) =>
      sail(d, i, where(51.9 + 0.03 * i, 4.6 + 0.08 * i), { knots: 8, bearing }),
    );
    const at = ships[4].at + MIN;
    const answers = ships.map(({ p }, k) =>
      d.observe(fix(k + 1, at + k * 20_000, where(p.lat, p.lon * 0.0015))),
    );
    assert.ok(
      answers.every((a) => a.evidence.includes('encoding') && !a.candidate),
      `bearing ${bearing}`,
    );
    assert.equal(snap(d, at + 2 * MIN).regions.length, 0);
  }
});

test('a report back where the ship was an hour ago is a stale repeat and never votes', () => {
  const d = detector({ minVessels: 1 });
  const ship = sail(d, 1, GULF, { knots: 30, minutes: 90, bearing: 25 });
  // The position it reported 60 minutes earlier, 56 km back: far enough to
  // vote, were it not a repeat.
  const earlier = move(GULF, (30 * 1.852 * 30) / 60, 25);
  const answer = d.observe(fix(1, ship.at + 10_000, earlier));
  assert.equal(answer.assessment, 'implausible');
  assert.ok(answer.evidence.includes('stale'));
  assert.equal(answer.candidate, false);
});

test('two ships sharing each of three MMSIs, 200 km apart, make no region', () => {
  const d = detector();
  const P = GULF;
  const Q = move(P, 200, 45);
  const pos = (base, i, t) =>
    move(move(base, 3 * i, 0), (12 * 1.852 * t) / HOUR, 90);
  for (let t = 0; t < 40 * MIN; t += 10_000)
    for (const i of [1, 2, 3]) d.observe(fix(i, t + i * 100, pos(P, i, t)));
  for (let t = 40 * MIN; t <= 3 * HOUR; t += 10_000)
    for (const i of [1, 2, 3])
      for (const [base, off] of [
        [P, 0],
        [Q, 5000],
      ])
        d.observe(fix(i, t + off + i * 100, pos(base, i, t)));
  for (const h of [1, 2, 3])
    assert.equal(snap(d, h * HOUR + 9000).regions.length, 0, `${h} h`);
  const diagnostic = snap(d, 3 * HOUR + 9000).diagnostic;
  assert.equal(diagnostic.identityConflicts, 3);
  // Interleaved reports never make three consecutive recovery reports.
  assert.equal(diagnostic.recoveries, 0);
});

test('a glitch just before a coverage gap does not freeze the ship', () => {
  const d = detector();
  const ship = sail(d, 1, GULF, { bearing: 0 });
  d.observe(fix(1, ship.at + 10_000, move(ship.p, 15, 0)));
  // Back two hours later, 7.7 km from the glitch point, sailing honestly.
  const back = sail(d, 1, move(ship.p, 22, 5), {
    start: ship.at + 2 * HOUR,
    minutes: 120,
    bearing: 0,
  });
  assert.ok(
    count(back.answers, 'assessment', 'plausible') >= back.answers.length - 3,
  );
});

test('a track whose very first report is corrupt is not condemned for it', () => {
  const d = detector();
  d.observe(fix(1, 0, where(GULF.lat, 0.007)));
  const { answers } = sail(d, 1, GULF, { start: MIN, minutes: 120 });
  assert.ok(count(answers, 'assessment', 'plausible') >= answers.length - 3);
});

test('a cargo ship after a 33 kn burst, then sailing on or moored, is trusted again', () => {
  for (const knots of [14, 0]) {
    const d = detector();
    d.observeStatic({ mmsi: mmsi(1), shipType: 70, receivedAt: T });
    const a = sail(d, 1, GULF, { knots: 14, bearing: 0 });
    const b = sail(d, 1, a.p, {
      knots: 33,
      start: a.at + MIN,
      minutes: 20,
      bearing: 0,
    });
    const c = sail(d, 1, b.p, {
      knots,
      start: b.at + MIN,
      minutes: 120,
      bearing: 0,
      everyS: knots ? 60 : 180,
    });
    assert.equal(
      count(c.answers, 'reason', 'suspect_resolved'),
      1,
      `${knots} kn`,
    );
    assert.ok(
      count(c.answers, 'assessment', 'plausible') >= c.answers.length - 4,
    );
    assert.equal(count(c.answers, 'reason', 'fast_vessel_confirmed'), 0);
  }
});

test('a ship back at a berth up a river after a gap is resolved, not held for the day', () => {
  const d = detector({}, { geography: toyLand });
  const sea = sail(d, 1, where(27.4, 53), {
    knots: 10,
    bearing: 0,
    minutes: 30,
  });
  const berth = where(27.9, 53);
  const answers = [];
  for (let k = 0; k < 60; k++)
    answers.push(d.observe(fix(1, sea.at + 3 * HOUR + k * 3 * MIN, berth)));
  assert.equal(answers[0].assessment, 'unknown');
  assert.ok(answers[0].evidence.includes('land'));
  assert.ok(count(answers, 'assessment', 'plausible') >= 55);
});

test('a move with no water route is resolved by calm sailing, never confirmed as fast', () => {
  const geography = {
    source: 'toy',
    inlandKm: () => 0,
    straightLineClear: () => false,
    routeKm: () => ({ status: 'longer' }),
  };
  const d = detector({}, { geography });
  const ship = sail(d, 1, GULF);
  d.observe(fix(1, ship.at + 3 * HOUR, move(ship.p, 100, 30)));
  const on = sail(d, 1, move(ship.p, 100, 30), {
    start: ship.at + 3 * HOUR + MIN,
    // As fast as the straight-line pace that opened it: only a speed
    // suspicion may be confirmed as a fast boat.
    knots: 30,
    minutes: 10,
    bearing: 30,
  });
  assert.equal(count(on.answers, 'reason', 'fast_vessel_confirmed'), 0);
  assert.equal(count(on.answers, 'reason', 'suspect_resolved'), 1);
});

test('a region keeps its id as more ships join the same incident', () => {
  const d = detector();
  const { jumpAt, target } = threeSpoofed(d);
  const first = snap(d, jumpAt + 5000).regions[0].id;
  const more = [4, 5].map((i) => sail(d, i, move(GULF, 8 + i, 0)));
  const at = Math.max(jumpAt, more[1].at) + MIN;
  for (const i of [1, 2, 3]) d.observe(fix(i, at + i * 1000, target));
  more.forEach((_, k) =>
    d.observe(fix(4 + k, at + (5 + k) * 1000, move(target, 0.3, 90))),
  );
  const s = snap(d, at + 9000);
  assert.equal(s.regions.length, 1);
  assert.equal(s.regions[0].id, first);
  assert.equal(s.regions[0].evidence.uniqueVessels, 5);
  assert.equal(s.recentIncidents.length, 0);
});

test('a snapshot stays fast with thousands of votes', () => {
  const d = detector({ minVessels: 1 });
  const target = where(27.9, 55.2);
  for (let i = 1; i <= 3000; i++) {
    const base = move(GULF, (i % 60) * 3, Math.floor(i / 60) * 7);
    for (let m = 0; m <= 31; m += 5)
      d.observe(fix(i, m * MIN, move(base, 0.01 * m, 0)));
    d.observe(fix(i, 32 * MIN, move(target, (i % 50) * 0.3, i)));
  }
  const started = performance.now();
  const s = snap(d, 32 * MIN + 5000);
  assert.ok(s.diagnostic.candidateReports > 2000);
  assert.ok(
    performance.now() - started < 500,
    `${performance.now() - started} ms`,
  );
});

test('water-route searches are cached per position and rate-limited', () => {
  let calls = 0;
  const geography = {
    source: 'toy',
    inlandKm: () => 0,
    straightLineClear: () => false,
    routeKm: () => (calls++, { status: 'route', km: 1 }),
  };
  const d = detector({ routeSearchesPerMinute: 10 }, { geography });
  const ships = [];
  for (let i = 1; i <= 50; i++)
    ships.push(sail(d, i, move(GULF, i, 0), { minutes: 5 }));
  // Fifty ships back after a gap, each reporting twice from the same place.
  for (const [k, s] of ships.entries())
    for (const extra of [0, 1000])
      d.observe(fix(k + 1, s.at + HOUR + extra, move(s.p, 30, 45)));
  assert.ok(calls <= 11, `${calls}`);
  const diag = snap(d, ships[0].at + HOUR + 2000).diagnostic;
  assert.ok(diag.routeSkipped > 0);
});

test('a class B report does not make an MMSI class B for good', () => {
  const d = detector();
  d.observe(fix(1, 0, GULF, { transponderClass: 'B' }));
  // Class A at 50 kn: over the unknown screening (40), so not a small craft.
  const { answers } = sail(d, 1, GULF, {
    knots: 50,
    everyS: 60,
    minutes: 5,
    start: MIN,
    extra: { transponderClass: 'A' },
  });
  assert.ok(answers.slice(2).some((a) => a.assessment === 'unknown'));
});

test('MMSIs outside the ship-station range are refused', () => {
  const d = detector();
  for (const id of ['776123456', '799123456', '200123456'])
    assert.equal(
      d.observe({ ...fix(1, 0, GULF), mmsi: id }).reason,
      'invalid_id',
      id,
    );
});

test('a spoof that hops 6 km to a second point and holds there is not adopted', () => {
  const d = detector({ minVessels: 1 });
  const ship = sail(d, 1, GULF);
  const X = move(GULF, 100, 0);
  const X2 = move(X, 6, 90);
  const answers = [];
  for (let t = ship.at + MIN; t <= ship.at + 2 * HOUR; t += 20_000)
    answers.push(d.observe(fix(1, t, X)));
  // Two hours on, the old fix could reach X2; the hop is too fast for the
  // spoof's own segment at first, but it is the spoof.
  for (
    let t = ship.at + 2 * HOUR + 20_000;
    t <= ship.at + 3 * HOUR;
    t += 20_000
  )
    answers.push(d.observe(fix(1, t, X2)));
  assert.ok(answers.every((a) => a.assessment === 'implausible'));
});

test('a calmed suspicious stretch votes only after 30 more minutes of history', () => {
  const run = (minutesAfter) => {
    const d = detector({ minVessels: 1 });
    d.observeStatic({ mmsi: mmsi(1), shipType: 70, receivedAt: T });
    const a = sail(d, 1, GULF, { knots: 14, bearing: 0 });
    const b = sail(d, 1, a.p, {
      knots: 33,
      start: a.at + MIN,
      minutes: 10,
      bearing: 0,
    });
    const c = sail(d, 1, b.p, {
      knots: 14,
      start: b.at + MIN,
      minutes: minutesAfter,
      bearing: 0,
    });
    assert.equal(count(c.answers, 'reason', 'suspect_resolved'), 1);
    return d.observe(fix(1, c.at + MIN, move(c.p, 120, 30)));
  };
  assert.equal(run(10).candidate, false);
  assert.equal(run(40).candidate, true);
});

test('one ship back after a gap costs one water-route search, however often it reports', () => {
  let calls = 0;
  const geography = {
    source: 'toy',
    inlandKm: () => 0,
    straightLineClear: () => false,
    // No route: the ship stays suspicious, judged again from the same fix.
    routeKm: () => (calls++, { status: 'longer' }),
  };
  const d = detector({}, { geography });
  const ship = sail(d, 1, GULF, { minutes: 5 });
  const back = move(ship.p, 30, 45);
  for (let k = 0; k < 5; k++)
    d.observe(fix(1, ship.at + HOUR + k * 1000, back));
  assert.equal(calls, 1);
});

test('a region keeps its id when its first ships drop out and others carry it on', () => {
  const d = detector();
  const target = where(27.9, 55.2);
  const ids = new Set();
  // Ships 1-3 spoofed at once; ships 4-6, beside them, twenty minutes later.
  const first = [1, 2, 3].map((i) =>
    sail(d, i, move(GULF, 2 * i, 0), { minutes: 60 }),
  );
  const second = [4, 5, 6].map((i) =>
    sail(d, i, move(GULF, 2 * i - 5, 90), { minutes: 80 }),
  );
  const t0 = first[0].at + MIN;
  for (let t = t0; t <= t0 + 90 * MIN; t += MIN) {
    if (t <= t0 + 5 * MIN)
      for (const i of [1, 2, 3]) d.observe(fix(i, t + i * 100, target));
    if (t >= t0 + 20 * MIN && t - t0 <= 90 * MIN)
      for (const i of [4, 5, 6])
        d.observe(fix(i, t + i * 100, move(target, 0.5, 90)));
    const s = snap(d, t + 5000);
    for (const r of s.regions) ids.add(r.id);
  }
  // At the end only ships 4-6 support it, and it is still the same region.
  assert.equal(ids.size, 1, [...ids].join(' '));
});

test('a jump is measured from the last fix, not forgiven by an older one', () => {
  const d = detector({ minVessels: 1 });
  // Reports every 20 minutes: the point before the last is 20 minutes older.
  const ship = sail(d, 1, GULF, { minutes: 60, everyS: 1200 });
  // 80 km in 20 minutes: 130 kn from the last fix, 65 kn from the one before.
  const jump = d.observe(fix(1, ship.at + 20 * MIN, move(ship.p, 80, 30)));
  assert.equal(jump.assessment, 'implausible');
});

test('ships first seen where spoofed positions land are no source for a region', () => {
  // As in the July 2025 Baltic replay: ships 1-3 are spoofed to X; ships
  // 4-6 come into coverage already spoofed and sit at X for 40 minutes, then
  // their real positions return, all in one area.
  const d = detector();
  const { jumpAt, target } = threeSpoofed(d);
  for (const i of [1, 2, 3])
    d.observe(fix(i, jumpAt + 10 * MIN + i * 1000, target));
  const late = [4, 5, 6].map((i) =>
    sail(d, i, move(target, 0.5 * (i - 3), 0), {
      start: jumpAt + MIN,
      knots: 0.5,
    }),
  );
  const at = late[2].at + MIN;
  const answers = late.map((_, k) =>
    d.observe(fix(4 + k, at + k * 1000, move(GULF, 2 * k, 45))),
  );
  assert.ok(
    answers.every(
      (a) => a.assessment === 'implausible' && a.candidate === false,
    ),
  );
  const s = snap(d, at + 5000);
  assert.ok(
    s.regions.every((r) => r.area.north < target.lat - 0.3),
    JSON.stringify(s.regions.map((r) => r.area)),
  );
  assert.ok(s.diagnostic.landingCells >= 1);
});

test('positions within a degree of 0 N 0 E are refused as placeholders', () => {
  const d = detector();
  for (const p of [where(0.983333, 0), where(0.316667, 0), where(-0.5, 0.9)])
    assert.equal(d.observe(fix(1, 0, p)).reason, 'invalid_position');
  assert.equal(d.observe(fix(1, 0, where(1.2, 0))).accepted, true);
});

test('with 50 km region cells, a 20 km neighbourhood still decides what is a local jump', () => {
  // 35 km onto land: outside the 20 km cells' neighbourhood, so it votes.
  const d = detector({ minVessels: 1 }, { geography: toyLand });
  const a = sail(d, 1, where(27.45, 53), { bearing: 0, knots: 1 });
  assert.equal(
    d.observe(fix(1, a.at + MIN, move(a.p, 35, 10))).candidate,
    true,
  );
  assert.equal(REGIONAL_GNSS_RULES.h3Resolution, 4);
  assert.equal(REGIONAL_GNSS_RULES.h3LocalResolution, 5);
});

test('a cluster split by a region-cell edge forms one region', async () => {
  const { latLngToCell } = await import('h3-js');
  const cellOf = (p) =>
    latLngToCell(p.lat, p.lon, REGIONAL_GNSS_RULES.h3Resolution);
  // Walk east from GULF to the first region-cell edge.
  let k = 1;
  while (cellOf(move(GULF, k, 90)) === cellOf(GULF)) k++;
  const west = move(GULF, k - 2, 90);
  const east = move(GULF, k + 2, 90);
  assert.notEqual(cellOf(west), cellOf(east));
  const d = detector();
  const ships = [
    sail(d, 1, move(west, 1, 0), { bearing: 0, knots: 1 }),
    sail(d, 2, move(west, 1, 180), { bearing: 0, knots: 1 }),
    sail(d, 3, east, { bearing: 0, knots: 1 }),
  ];
  const at = ships[2].at + MIN;
  ships.forEach((_, i) =>
    d.observe(fix(i + 1, at + i * 1000, move(where(27.9, 55.2), 0.3 * i, 90))),
  );
  const s = snap(d, at + 5000);
  assert.equal(s.regions.length, 1);
  assert.equal(s.regions[0].evidence.uniqueVessels, 3);
});

test('ships at a port before a spoof, or arriving long after it, still vote', () => {
  // Three glitches land at P; six hours later ships at anchor at P are
  // spoofed together. The glitches made P a zone, but the ships were not
  // first seen while false positions were landing there.
  const d = detector();
  const P = where(26.9, 54.0);
  const SEA = move(P, 90, 0);
  const g = [11, 12, 13].map((i, k) =>
    sail(d, i, move(SEA, 3 * k, 90), { knots: 1 }),
  );
  g.forEach((s, k) =>
    d.observe(fix(s.i ?? 11 + k, s.at + MIN, move(P, 2 * k, 90))),
  );
  const start = 6 * HOUR;
  const ships = [1, 2, 3, 4].map((i) =>
    sail(d, i, move(P, 2 * i, 0), { start, knots: 0.3 }),
  );
  const at = ships[3].at + MIN;
  const X = move(P, 90, 120);
  const answers = ships.map((_, k) =>
    d.observe(fix(k + 1, at + k * 1000, move(X, 0.3 * k, 90))),
  );
  assert.ok(
    answers.every((a) => a.candidate),
    JSON.stringify(answers),
  );
  assert.equal(snap(d, at + 9000).regions.length, 1);
});

test('ships returning from a spoof point do not make their real area a landing zone', () => {
  const d = detector();
  const { jumpAt, target: X } = threeSpoofed(d);
  for (const i of [1, 2, 3]) d.observe(fix(i, jumpAt + 10 * MIN + i * 1000, X));
  // Ships 4-6, first seen at X, go back to their real positions around Z.
  const Z = where(25.2, 57.6);
  const late = [4, 5, 6].map((i) =>
    sail(d, i, move(X, 0.5 * (i - 3), 0), { start: jumpAt + MIN, knots: 0.5 }),
  );
  const t1 = late[2].at + MIN;
  late.forEach((_, k) =>
    d.observe(fix(4 + k, t1 + k * 1000, move(Z, 2 * k, 45))),
  );
  // Later, ships 7-9 that really are at Z are spoofed to X: that counts.
  const zShips = [7, 8, 9].map((i) =>
    sail(d, i, move(Z, 3 * (i - 6), 200), { start: t1 + 2 * HOUR }),
  );
  const t2 = zShips[2].at + MIN;
  [7, 8, 9].forEach((i, k) =>
    d.observe(fix(i, t2 + k * 1000, move(X, 0.2 * k, 90))),
  );
  const s = snap(d, t2 + 5000);
  assert.equal(s.regions.length, 1);
  const { south, north } = s.regions[0].area;
  assert.ok(
    south < Z.lat && north > Z.lat - 0.2,
    JSON.stringify(s.regions[0].area),
  );
});

// Red-team round 7 (6 November 2026): each was a confirmed defect.

/** Ships near p for 40 minutes, `gapKm` apart, sailing east. */
const fleet = (
  d,
  ids,
  p,
  { start = 0, gapKm = 3, knots = 12, everyS = 60, minutes = 40 } = {},
) =>
  ids.map((i, k) => ({
    i,
    ...sail(d, i, move(p, gapKm * k, 0), { start, knots, everyS, minutes }),
  }));

test('a spoof flickering on and off at the edge of its reach is not taken for shared MMSIs', () => {
  const A = where(55.3, 16.0);
  const X = where(54.9, 20.3);
  const d = detector();
  const ships = fleet(d, [1, 2, 3, 4, 5], A, { everyS: 10 });
  let at = ships[4].at;
  const pos = ships.map((s) => ({ ...s.p }));
  let shown = 0;
  for (let k = 0; k < 120; k++) {
    at += 10_000;
    ships.forEach((s, j) => {
      pos[j] = move(pos[j], (12 * 1.852 * 10) / 3600, 90);
      d.observe(
        fix(s.i, at + j * 100, k % 2 === 0 ? move(X, 0.2 * j, 0) : pos[j]),
      );
    });
    if (snap(d, at + 1000).regions.length) shown++;
  }
  assert.ok(shown >= 110, `${shown}`);
  assert.equal(snap(d, at + 1000).diagnostic.identityConflicts, 0);
});

test('a spoof hopping among five points is never recovered', () => {
  const A = where(55.3, 16.0);
  const d = detector({ minVessels: 1 });
  const [s] = fleet(d, [1], A, { everyS: 10 });
  const points = [0, 1, 2, 3, 4].map((k) => move(A, 70, 60 + k * 25));
  let at = s.at;
  const answers = [];
  for (let cycle = 0; cycle < 20; cycle++)
    for (const p of points)
      for (let r = 0; r < 30; r++)
        answers.push(d.observe(fix(1, (at += 10_000), p)));
  assert.equal(count(answers, 'reason', 'recovered'), 0);
  assert.equal(count(answers, 'assessment', 'plausible'), 0);
});

test('a 3 km glitch does not freeze the ship sailing on past it', () => {
  const d = detector();
  const ship = sail(d, 1, GULF, { everyS: 10, minutes: 10 });
  // The glitch lands ahead of the ship, on its track.
  assert.equal(
    d.observe(fix(1, ship.at + 10_000, move(ship.p, 3, 90))).assessment,
    'implausible',
  );
  const on = sail(d, 1, move(ship.p, 0.07, 90), {
    start: ship.at + 20_000,
    everyS: 10,
    minutes: 60,
  });
  assert.equal(count(on.answers, 'reason', 'recovered'), 1);
  assert.ok(
    count(on.answers, 'assessment', 'plausible') >= on.answers.length - 10,
  );
});

test('a region across the dateline has a narrow box and a centre on the dateline', async () => {
  const { regionalGnssIntelRecords } =
    await import('../../server/providers/airsea/gnssRegionalIntel.js');
  const d = detector();
  const A = where(-17.0, 179.85);
  const starts = [-14, -5, 5, 14].map((km) =>
    move(A, Math.abs(km), km < 0 ? 270 : 90),
  );
  const ships = starts.map((p, k) => ({
    i: k + 1,
    ...sail(d, k + 1, p, { knots: 0.2 }),
  }));
  const at = ships[3].at + MIN;
  ships.forEach((s, k) =>
    d.observe(fix(s.i, at + k * 1000, move(where(-18.2, 178.4), 0.3 * k, 0))),
  );
  const s = snap(d, at + 5000);
  assert.equal(s.regions.length, 1);
  const { west, east } = s.regions[0].area;
  assert.ok(east - west < 2, `${west} ${east}`);
  const [record] = regionalGnssIntelRecords(s);
  assert.ok(
    Math.abs(Math.abs(record.location.lon) - 180) < 1,
    `${record.location.lon}`,
  );
});

test('independent jumps in random directions rarely look coherent', () => {
  let seed = 11;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  let regions = 0;
  for (let trial = 0; trial < 100; trial++) {
    const d = detector();
    const ships = fleet(d, [1, 2, 3], GULF, { gapKm: 4 });
    const at = ships[2].at + MIN;
    ships.forEach((s, k) =>
      d.observe(
        fix(s.i, at + k * 1000, move(s.p, 50 + 100 * rnd(), 360 * rnd())),
      ),
    );
    if (snap(d, at + 5000).regions.length) regions++;
  }
  assert.ok(regions <= 8, `${regions} of 100`);
});

test('the oldest landing zone still in use is not the one evicted', () => {
  const A = where(55.3, 16.0);
  const X = where(54.9, 20.3);
  const REAL = where(55.6, 17.6);
  const d = detector({ maxCandidates: 30 });
  const a = fleet(d, [1, 2, 3, 4], A, { gapKm: 4 });
  let at = a[3].at + MIN;
  const hold = () =>
    a.forEach((s, k) => d.observe(fix(s.i, at + k * 100, move(X, 0.3 * k, 0))));
  hold();
  // Ships enter coverage already spoofed at X while the spoof holds there,
  // and forty other vessels each land once elsewhere, past the cap.
  const late = [41, 42, 43, 44];
  const fillers = [];
  for (let v = 0; v < 40; v++) {
    const id = 100 + v;
    fillers.push(id);
    d.observe(fix(id, at - 40 * MIN, where(-40 + v, -170)));
  }
  for (let m = 1; m <= 45; m++) {
    at += MIN;
    late.forEach((i, k) =>
      d.observe(fix(i, at + 500 + k * 100, move(X, 0.3 * k + 0.1, 0))),
    );
    hold();
    if (m <= 40) {
      const v = m - 1;
      for (let r = 1; r <= 3; r++)
        d.observe(
          fix(
            100 + v,
            at - (40 - r * 10) * MIN + 700,
            where(-40 + v, -170 + 0.0001 * r),
          ),
        );
      d.observe(fix(100 + v, at + 900, where(-40 + v + 0.9, -169)));
    }
  }
  at += MIN;
  late.forEach((i, k) =>
    d.observe(fix(i, at + k * 1000, move(REAL, 4 * k, 45))),
  );
  const s = snap(d, at + 5000);
  assert.ok(
    s.regions.every((r) => r.area.south > 55),
    JSON.stringify(s.regions.map((r) => r.area)),
  );
});

test('a spoof dragged along a lane does not blind the lane', () => {
  const A = where(56.2, 15.5);
  const LANE = where(55.2, 13.0);
  const d = detector();
  const a = fleet(d, [1, 2, 3], A, { gapKm: 4, everyS: 30 });
  let at = a[2].at + MIN;
  for (let k = 0; k <= 250; k++) {
    const p = move(LANE, k, 90);
    a.forEach((s, j) =>
      d.observe(fix(s.i, at + j * 1000, move(p, 0.3 * j, 0))),
    );
    at += 60_000;
  }
  assert.ok(snap(d, at).diagnostic.landingCells <= 3);
  const S = move(LANE, 160, 90);
  const v = fleet(d, [31, 32, 33, 34], S, { start: 9 * HOUR });
  const t = v[3].at + MIN;
  const answers = v.map((s, k) =>
    d.observe(fix(s.i, t + k * 1000, move(S, 90 + k * 0.3, 0))),
  );
  assert.ok(answers.every((x) => x.candidate));
});

test('a zone that forms after a vote still removes votes from ships first seen in it', () => {
  const d = detector();
  const X = where(27.9, 55.2);
  const Y = where(25.2, 57.6);
  // Ships 4-6 are first seen at X; two others land at X 20 and 25 minutes
  // later (not yet a zone); 4-6 vote at 35 minutes; the third lands at 40.
  const late = [4, 5, 6].map((i) =>
    sail(d, i, move(X, 0.5 * (i - 3), 0), { start: 60 * MIN, knots: 0.5 }),
  );
  const landers = [1, 2, 3].map((i) =>
    sail(d, i, move(GULF, 3 * i, 0), { start: 40 * MIN, minutes: 40 }),
  );
  const t0 = 60 * MIN;
  for (const [k, minute] of [
    [0, 20],
    [1, 25],
  ].values())
    d.observe(
      fix(
        landers[k].i ?? k + 1,
        t0 + minute * MIN + 5000,
        move(X, 0.3 * k, 90),
      ),
    );
  late.forEach((_, k) =>
    d.observe(fix(4 + k, t0 + 41 * MIN + k * 1000, move(Y, 2 * k, 45))),
  );
  // Before the third landing the returns make a region at X, where those
  // ships were trusted...
  const atX = (r) => r.area.south < X.lat && r.area.north > X.lat;
  assert.ok(snap(d, t0 + 41 * MIN + 5000).regions.some(atX));
  d.observe(fix(3, t0 + 42 * MIN, move(X, 0.6, 90)));
  // ...and once it is a zone, that region goes.
  const s = snap(d, t0 + 43 * MIN);
  assert.ok(!s.regions.some(atX), JSON.stringify(s.regions.map((r) => r.area)));
});

test('a spoof hopping among points marks only where ships first landed', () => {
  const d = detector();
  const ships = [1, 2, 3].map((i) =>
    sail(d, i, move(GULF, 3 * i, 0), { everyS: 10 }),
  );
  const points = [0, 1, 2, 3, 4].map((k) => move(GULF, 90, 20 + k * 20));
  let at = ships[2].at;
  for (let cycle = 0; cycle < 6; cycle++)
    for (const p of points)
      for (let r = 0; r < 6; r++) {
        at += 10_000;
        ships.forEach((s, j) =>
          d.observe(fix(j + 1, at + j * 100, move(p, 0.3 * j, 0))),
        );
      }
  assert.ok(
    snap(d, at).diagnostic.landingCells <= 2,
    `${snap(d, at).diagnostic.landingCells}`,
  );
});

test('a landing zone spans neighbouring fine cells', () => {
  // Three ships land 8 km apart: across 20 km cell edges, one zone.
  const d = detector();
  const X = where(27.9, 55.2);
  const ships = [1, 2, 3].map((i) => sail(d, i, move(GULF, 3 * i, 0)));
  const at = ships[2].at + MIN;
  ships.forEach((_, k) =>
    d.observe(fix(k + 1, at + k * 1000, move(X, 8 * k, 90))),
  );
  // Ships first seen between those points, then back to their real places.
  const late = [4, 5, 6].map((i) =>
    sail(d, i, move(X, 7 + (i - 4), 90), { start: at + MIN, knots: 0.5 }),
  );
  const t = late[2].at + MIN;
  const answers = late.map((_, k) =>
    d.observe(fix(4 + k, t + k * 1000, move(where(25.2, 57.6), 2 * k, 45))),
  );
  assert.ok(
    answers.every((a) => !a.candidate),
    JSON.stringify(answers),
  );
});

test('ships that were at a place before spoofed positions landed there still vote', () => {
  const d = detector();
  const P = where(26.9, 54.4);
  const ships = [1, 2, 3, 4].map((i) =>
    sail(d, i, move(P, 2 * i, 0), { knots: 0.3, minutes: 120 }),
  );
  // Others are spoofed onto P while the ships are there...
  const others = [11, 12, 13].map((i) =>
    sail(d, i, move(GULF, 3 * (i - 10), 0), { start: 80 * MIN }),
  );
  const t1 = others[2].at + MIN;
  others.forEach((_, k) =>
    d.observe(fix(11 + k, t1 + k * 1000, move(P, 0.5 * k, 90))),
  );
  // ...then the ships at P are spoofed away together.
  const t2 = t1 + 2 * MIN;
  const X = move(P, 90, 120);
  const answers = ships.map((s, k) =>
    d.observe(fix(k + 1, t2 + k * 1000, move(X, 0.3 * k, 90))),
  );
  assert.ok(
    answers.every((a) => a.candidate),
    JSON.stringify(answers),
  );
});

test('the coherent count leaves out a vessel whose false position went elsewhere', () => {
  const d = detector();
  const ships = [1, 2, 3, 4].map((i) => sail(d, i, move(GULF, 3 * i, 0)));
  const at = ships[3].at + MIN;
  const X = where(27.9, 55.2);
  ships.forEach((_, k) =>
    d.observe(
      fix(
        k + 1,
        at + k * 1000,
        k < 3 ? move(X, 0.3 * k, 90) : where(24.2, 51.0),
      ),
    ),
  );
  const [region] = snap(d, at + 5000).regions;
  assert.equal(region.evidence.uniqueVessels, 4);
  assert.equal(region.evidence.coherentTargetVessels, 3);
});

test('an incident that splits in two gives two regions with different ids', async () => {
  const { latLngToCell, gridDisk, cellToLatLng } = await import('h3-js');
  const res = REGIONAL_GNSS_RULES.h3Resolution;
  // Three cells in a row: c1 and c3 both neighbour c2, not each other.
  const c2 = latLngToCell(GULF.lat, GULF.lon, res);
  const ring = gridDisk(c2, 1).filter((c) => c !== c2);
  const c1 = ring[0];
  const c3 = ring.find((c) => !gridDisk(c1, 1).includes(c));
  const centre = (c) => {
    const [lat, lon] = cellToLatLng(c);
    return where(lat, lon);
  };
  const d = detector();
  const X = where(28.4, 56.2);
  const groups = [c1, c2, c3].map((c, g) =>
    [1, 2, 3].map((k) => ({
      i: g * 10 + k,
      ...sail(d, g * 10 + k, move(centre(c), 1.5 * k, 0), { knots: 0.3 }),
    })),
  );
  let at = groups[2][2].at + MIN;
  const spoof = (g) =>
    groups[g].forEach((s, k) =>
      d.observe(fix(s.i, at + g * 300 + k * 50, move(X, 0.3 * k + g, 90))),
    );
  [0, 1, 2].forEach(spoof);
  assert.equal(snap(d, at + 5000).regions.length, 1);
  // Group 2 stops; groups 1 and 3 hold for 40 minutes.
  for (let m = 1; m <= 40; m++) {
    at += MIN;
    spoof(0);
    spoof(2);
    snap(d, at + 4000);
  }
  const s = snap(d, at + 5000);
  assert.equal(s.regions.length, 2);
  assert.notEqual(s.regions[0].id, s.regions[1].id);
});

// Red-team round 8 (6 November 2026): each was a confirmed defect.

test('a spoof held for two hours, then hopping 15 km and holding, is not adopted', () => {
  const A = where(55.3, 16.0);
  const d = detector();
  const ships = fleet(d, [1, 2, 3], A, { everyS: 20 });
  const X = move(A, 100, 0);
  const X2 = move(X, 15, 90);
  let at = ships[2].at;
  const answers = [];
  for (const [p, dur] of [
    [X, 2 * HOUR],
    [X2, HOUR],
  ])
    for (let e = 0; e < dur; e += 20_000) {
      at += 20_000;
      ships.forEach((s, j) =>
        answers.push(d.observe(fix(s.i, at + j * 100, move(p, 0.3 * j, 0)))),
      );
    }
  assert.equal(count(answers, 'reason', 'recovered'), 0);
  // The real positions return: no region at the spoof.
  at += 20_000;
  ships.forEach((s, j) =>
    d.observe(
      fix(
        s.i,
        at + j * 100,
        move(s.p, (12 * 1.852 * (at - ships[2].at)) / HOUR, 90),
      ),
    ),
  );
  const s = snap(d, at + 5000);
  assert.ok(
    s.regions.every((r) => r.area.north < X.lat - 0.3),
    JSON.stringify(s.regions.map((r) => r.area)),
  );
});

test('a spoof cycling seven points, each revisited after its 30 minutes, is not adopted', () => {
  const A = where(55.3, 16.0);
  const d = detector();
  const ships = fleet(d, [1, 2, 3], A, { everyS: 20 });
  const points = [0, 1, 2, 3, 4, 5, 6].map((k) => move(A, 70, 40 + k * 20));
  let at = ships[2].at;
  const answers = [];
  for (let c = 0; c < 6; c++)
    for (const p of points)
      for (let e = 0; e < 300_000; e += 20_000) {
        at += 20_000;
        ships.forEach((s, j) =>
          answers.push(d.observe(fix(s.i, at + j * 100, move(p, 0.3 * j, 0)))),
        );
      }
  assert.equal(count(answers, 'reason', 'recovered'), 0);
  assert.equal(count(answers, 'reason', 'fast_vessel_confirmed'), 0);
});

test('an honest ship sailing on through where a spoof held it gets free, and votes stop', () => {
  const A = where(55.3, 16.0);
  const d = detector({ minVessels: 1 });
  const s = sail(d, 1, A, { everyS: 20, knots: 15 });
  // The spoof holds it 25 km ahead on its course for 40 minutes...
  const X = move(s.p, 25, 90);
  let at = s.at;
  let p = s.p;
  for (let e = 0; e < 40 * MIN; e += 20_000) {
    at += 20_000;
    p = move(p, (15 * 1.852 * 20) / 3600, 90);
    d.observe(fix(1, at, X));
  }
  // ...and ends with the ship 6.5 km short of X.
  const after = sail(d, 1, p, {
    start: at + 20_000,
    everyS: 20,
    knots: 15,
    minutes: 6 * 60,
  });
  assert.equal(count(after.answers, 'reason', 'recovered'), 1);
  assert.ok(
    count(after.answers, 'assessment', 'plausible') >
      after.answers.length * 0.85,
  );
  // Nothing keeps a vote alive hours later.
  assert.equal(snap(d, after.at + 5000).diagnostic.candidateReports, 0);
});

test('a glitch ahead of a ship reporting every three minutes does not freeze it', () => {
  const d = detector();
  const s = sail(d, 1, where(55.3, 16.0), {
    everyS: 180,
    knots: 20,
    bearing: 80,
  });
  d.observe(fix(1, s.at + 90_000, move(s.p, 8, 80)));
  const on = sail(d, 1, move(s.p, (20 * 1.852 * 180) / 3600, 80), {
    start: s.at + 180_000,
    everyS: 180,
    knots: 20,
    bearing: 80,
    minutes: 6 * 60,
  });
  assert.equal(count(on.answers, 'reason', 'recovered'), 1);
  assert.ok(
    count(on.answers, 'assessment', 'plausible') >= on.answers.length - 10,
  );
});

test('a spoof that captures ships one by one still marks its landing point', () => {
  const X = where(54.9, 20.3);
  const Y = where(54.6, 18.9);
  const A = where(55.6, 17.2);
  const d = detector();
  const tLand = 3 * HOUR;
  // E ships come into coverage already spoofed to X; A ships are captured
  // to X one every 20 minutes; then the E ships' real positions return.
  const e = [4, 5, 6].map((i, k) =>
    sail(d, i, move(X, 0.5 * k, 0), {
      knots: 0.2,
      start: tLand - 20 * MIN,
      minutes: 20 + 70,
      bearing: 30,
    }),
  );
  const a = [1, 2, 3].map((i, k) => ({
    i,
    ...sail(d, i, move(A, 3 * k, 0), {
      start: tLand - 40 * MIN + k * 20 * MIN,
      minutes: 40,
      bearing: 30,
    }),
  }));
  a.forEach((s, k) => {
    for (let t = s.at + MIN; t < e[0].at; t += MIN)
      d.observe(fix(s.i, t, move(X, 0.4 * k, 120)));
  });
  const tr = e[2].at + MIN;
  const answers = e.map((_, k) =>
    d.observe(fix(4 + k, tr + k * 1000, move(Y, 2 * k, 45))),
  );
  assert.ok(
    answers.every((x) => !x.candidate),
    JSON.stringify(answers),
  );
});

test('a region from ships trusted where spoofed positions landed is marked, and kept from the Autopilot', async () => {
  const { regionalGnssIntelRecords } =
    await import('../../server/providers/airsea/gnssRegionalIntel.js');
  const X = where(54.9, 20.3);
  const Y = where(54.6, 18.9);
  const A = where(55.6, 17.2);
  const d = detector();
  const tLand = 3 * HOUR;
  // E ships first seen at X an hour before others land there: they may be
  // real ships at X, or ships trusted at the spoof point. AIS cannot tell.
  const e = [4, 5, 6].map((i, k) =>
    sail(d, i, move(X, 0.5 * k, 0), {
      knots: 0.2,
      start: tLand - 60 * MIN,
      minutes: 60 + 25,
      bearing: 30,
    }),
  );
  const a = [1, 2, 3].map((i, k) => ({
    i,
    ...sail(d, i, move(A, 3 * k, 0), {
      start: tLand - 40 * MIN + k * 5 * MIN,
      minutes: 40,
      bearing: 30,
    }),
  }));
  a.forEach((s, k) => {
    for (let t = s.at + MIN; t < e[0].at; t += MIN)
      d.observe(fix(s.i, t, move(X, 0.4 * k, 120)));
  });
  const tr = e[2].at + MIN;
  e.forEach((_, k) => d.observe(fix(4 + k, tr + k * 1000, move(Y, 2 * k, 45))));
  const s = snap(d, tr + 5000);
  const atX = s.regions.find(
    (r) => r.area.south < X.lat && r.area.north > X.lat,
  );
  assert.ok(atX, 'a region at X');
  assert.equal(atX.evidence.sourceInLandingZone, true);
  const records = regionalGnssIntelRecords(s);
  assert.ok(records.every((r) => !r.event_key.includes(atX.id)));
});

test('a closed episode forgets where its spoof went', () => {
  const d = detector({ minVessels: 1 });
  const ship = sail(d, 1, GULF, { everyS: 10, minutes: 10, bearing: 0 });
  // A glitch, then recovery...
  d.observe(fix(1, ship.at + 10_000, move(ship.p, 30, 60)));
  const on = sail(d, 1, move(ship.p, 0.05, 0), {
    start: ship.at + 20_000,
    everyS: 10,
    minutes: 5,
    bearing: 0,
  });
  assert.equal(count(on.answers, 'reason', 'recovered'), 1);
  // ...then, later, the ship really sails to where the glitch was.
  const later = sail(d, 1, move(ship.p, 28, 60), {
    start: on.at + 3 * HOUR,
    everyS: 10,
    minutes: 10,
    bearing: 0,
  });
  assert.ok(
    count(later.answers, 'assessment', 'plausible') >= later.answers.length - 1,
  );
});

test('a held ship far from where the spoof landed keeps no vote alive, and makes none', () => {
  const run = (young) => {
    const d = detector({ minVessels: 1 });
    const A = where(55.3, 16.0);
    const ship = sail(d, 1, A, {
      knots: 12,
      minutes: young ? 20 : 40,
      everyS: 60,
    });
    const X = move(ship.p, 100, 20);
    let at = ship.at;
    const first = d.observe(fix(1, (at += MIN), X));
    // Held for 90 minutes, so the real positions are plausible from the old fix.
    for (let k = 0; k < 90; k++) d.observe(fix(1, (at += MIN), X));
    // The ship really turned north: now plausible from its old fix, nearer
    // the spoof than its course east, but 40 km from where the spoof landed.
    const answers = [];
    let p = move(ship.p, 60, 10);
    for (let k = 0; k < 60; k++) {
      p = move(p, (12 * 1.852) / 60, 270);
      answers.push(d.observe(fix(1, (at += MIN), p)));
    }
    return { first, answers, d, at };
  };
  const old = run(false);
  assert.equal(old.first.candidate, true);
  // Its vote stops renewing and lapses...
  assert.equal(snap(old.d, old.at + 5000).diagnostic.candidateReports, 0);
  // ...and a ship too young to vote at the jump gets no vote later from it.
  const young = run(true);
  assert.equal(young.first.candidate, false);
  assert.ok(
    young.answers.every((a) => !a.candidate),
    JSON.stringify(young.answers.find((a) => a.candidate)),
  );
});

test('ships first seen at a spoof point before it was seen, going back, are kept but marked', () => {
  const X = where(54.9, 20.3);
  const A = where(55.6, 17.2);
  const d = detector();
  const tLand = 3 * HOUR;
  // E ships first seen at X an hour before ships from A land there.
  const e = [4, 5, 6].map((i, k) =>
    sail(d, i, move(X, 0.5 * k, 0), {
      knots: 0.2,
      start: tLand - 60 * MIN,
      minutes: 60 + 25,
      bearing: 30,
    }),
  );
  const a = [1, 2, 3].map((i, k) => ({
    i,
    ...sail(d, i, move(A, 3 * k, 0), {
      start: tLand - 40 * MIN + k * 5 * MIN,
      minutes: 40,
      bearing: 30,
    }),
  }));
  a.forEach((s, k) => {
    for (let t = s.at + MIN; t < e[0].at; t += MIN)
      d.observe(fix(s.i, t, move(X, 0.4 * k, 120)));
  });
  // The E ships' real positions return: near A, where the others came from.
  // They were at X before the spoof was seen there, so they may really have
  // been at X: they vote, but their region at X is marked and kept from the
  // Autopilot. (Ships first seen after the jumps began are returns: below.)
  const tr = e[2].at + MIN;
  e.forEach((_, k) =>
    d.observe(fix(4 + k, tr + k * 1000, move(A, 8 + 3 * k, 200))),
  );
  const s = snap(d, tr + 5000);
  const atX = s.regions.filter(
    (r) => r.area.south < X.lat && r.area.north > X.lat,
  );
  assert.ok(
    atX.every((r) => r.evidence.sourceInLandingZone),
    JSON.stringify(atX),
  );
});

test('ships first seen after jumps to their spoof point began, going back, are returns', () => {
  const X = where(54.9, 20.3);
  const A = where(55.6, 17.2);
  const d = detector();
  const a = [1, 2, 3].map((i, k) => ({ i, ...sail(d, i, move(A, 3 * k, 0)) }));
  let at = a[2].at;
  for (let m = 1; m <= 60; m++) {
    at += MIN;
    a.forEach((s, k) =>
      d.observe(fix(s.i, at + k * 100, move(X, 0.4 * k, 120))),
    );
  }
  // E ships first seen at X an hour into the spoof, held there for 40 minutes...
  const e = [4, 5, 6];
  for (let m = 1; m <= 40; m++) {
    at += MIN;
    a.forEach((s, k) =>
      d.observe(fix(s.i, at + k * 100, move(X, 0.4 * k, 120))),
    );
    e.forEach((i, k) =>
      d.observe(fix(i, at + 500 + k * 100, move(X, 0.5 * k + 0.2, 0))),
    );
  }
  // ...then their real positions return, near A.
  const answers = e.map((i, k) =>
    d.observe(fix(i, at + MIN + k * 1000, move(A, 8 + 3 * k, 200))),
  );
  assert.ok(
    answers.every((x) => x.candidate === false),
    JSON.stringify(answers),
  );
});

test('a spoof still holding keeps its landing zone active for ships first seen there later', () => {
  const X = where(54.9, 20.3);
  const A = where(55.6, 17.2);
  const Y = where(56.4, 15.0);
  const d = detector();
  const a = [1, 2, 3].map((i, k) => ({ i, ...sail(d, i, move(A, 3 * k, 0)) }));
  let at = a[2].at;
  // Ships from A are spoofed to X and held there for three hours; two hours
  // in, ships E come into coverage at X, already spoofed.
  const e = [4, 5, 6];
  for (let m = 1; m <= 180; m++) {
    at += MIN;
    a.forEach((s, k) =>
      d.observe(fix(s.i, at + k * 100, move(X, 0.4 * k, 120))),
    );
    if (m >= 120)
      e.forEach((i, k) =>
        d.observe(fix(i, at + 500 + k * 100, move(X, 0.5 * k + 0.2, 0))),
      );
  }
  // The E ships' real positions return, to Y, nowhere near A.
  const answers = e.map((i, k) =>
    d.observe(fix(i, at + MIN + k * 1000, move(Y, 2 * k, 45))),
  );
  assert.ok(
    answers.every((x) => !x.candidate),
    JSON.stringify(answers),
  );
});

// Red-team round 9 (6 November 2026): each was a confirmed defect.

test('ships that anchor near where a spoof held them keep no region alive', () => {
  const A = where(55.3, 16.0);
  const d = detector();
  const ships = fleet(d, [1, 2, 3], A, { everyS: 20 });
  const t0 = ships[2].at;
  const X = move(A, 60, 0);
  let at = t0;
  for (let e = 0; e < 2 * HOUR; e += 20_000) {
    at += 20_000;
    ships.forEach((s, j) =>
      d.observe(fix(s.i, at + j * 100, move(X, 0.3 * j, 90))),
    );
  }
  // They really turned towards it and anchored 15 km short of it.
  const real = (s, t) =>
    move(s.p, Math.min((12 * 1.852 * (t - t0)) / HOUR, 45), 0);
  const seen = [];
  for (let h = 1; h <= 4; h++) {
    for (let e = 0; e < HOUR; e += 20_000) {
      at += 20_000;
      ships.forEach((s, j) => d.observe(fix(s.i, at + j * 100, real(s, at))));
    }
    seen.push(snap(d, at + 1000).regions.length);
  }
  assert.deepEqual(seen, [0, 0, 0, 0]);
});

test('a second spoof the other way, of ships that sailed in, is not taken for a return', () => {
  const A = where(55.5, 17.0);
  const B = where(55.0, 19.5);
  const d = detector();
  // Phase 1: ships at B spoofed to A, then they recover.
  const b = fleet(d, [1, 2, 3, 4], B, { knots: 10 });
  let at = b[3].at;
  for (let t = 0; t < 30; t++) {
    at += MIN;
    b.forEach((s, k) =>
      d.observe(fix(s.i, at + k * 1000, move(A, 0.3 * k, 0))),
    );
  }
  for (let t = 0; t < 5; t++) {
    at += MIN;
    b.forEach((s, k) =>
      d.observe(
        fix(
          s.i,
          at + k * 1000,
          move(s.p, (10 * 1.852 * (at - b[3].at)) / HOUR, 0),
        ),
      ),
    );
  }
  // Phase 2, four hours on: ships that sailed in to A over three hours are spoofed to B.
  const v = fleet(d, [21, 22, 23, 24], move(A, 40, 270), {
    knots: 7,
    start: 4 * HOUR,
    minutes: 180,
  });
  at = v[3].at;
  const answers = [];
  for (let t = 0; t < 20; t++) {
    at += MIN;
    v.forEach((s, k) =>
      answers.push(d.observe(fix(s.i, at + k * 1000, move(B, 0.3 * k, 90)))),
    );
  }
  assert.ok(answers.some((a) => a.candidate));
  assert.equal(snap(d, at + 5000).regions.length, 1);
});

test('a spoof flickering 25 minutes false, 2 minutes true, keeps its region', () => {
  const A = where(55.3, 16.0);
  const X = move(A, 100, 20);
  const d = detector();
  const ships = fleet(d, [1, 2, 3, 4], A, { everyS: 20 });
  const t0 = ships[2].at;
  let at = t0;
  const seen = [];
  for (let e = 0; e < 4 * HOUR; e += 20_000) {
    at += 20_000;
    const spoofed = (at - t0) % (27 * MIN) < 25 * MIN;
    ships.forEach((s, j) =>
      d.observe(
        fix(
          s.i,
          at + j * 100,
          spoofed
            ? move(X, 0.3 * j, 90)
            : move(s.p, (12 * 1.852 * (at - t0)) / HOUR, 90),
        ),
      ),
    );
    if ((at - t0) % (15 * MIN) < 20_000)
      seen.push(snap(d, at + 1000).regions.length);
  }
  assert.ok(
    seen.every((n) => n === 1),
    seen.join(''),
  );
});

test('a spoof landing off course, then dragged onto the ship’s line, is not adopted', () => {
  const A = where(55.3, 16.0);
  const d = detector();
  const ships = fleet(d, [1, 2, 3], A, { everyS: 20 });
  const t0 = ships[2].at;
  const dr = (s, t) => move(s.p, (12 * 1.852 * (t - t0)) / HOUR, 90);
  const spoof = ships.map((s) => move(s.p, 60, 0));
  let at = t0;
  const answers = [];
  for (let e = 0; e < 4 * HOUR; e += 20_000) {
    at += 20_000;
    ships.forEach((s, j) => {
      // Drag towards the dead-reckoned point at 25 kn, then ride the line.
      const target = dr(s, at);
      const km = distanceKm(spoof[j], target);
      const step = (25 * 1.852 * 20) / 3600;
      if (km > step) {
        const f = step / km;
        spoof[j] = {
          lat: spoof[j].lat + (target.lat - spoof[j].lat) * f,
          lon: spoof[j].lon + (target.lon - spoof[j].lon) * f,
        };
      } else spoof[j] = target;
      answers.push(d.observe(fix(s.i, at + j * 100, spoof[j])));
    });
  }
  assert.equal(count(answers, 'reason', 'recovered'), 0);
});

test('ships that sailed honestly into an old landing zone are not marked', async () => {
  const { regionalGnssIntelRecords } =
    await import('../../server/providers/airsea/gnssRegionalIntel.js');
  const S = where(55.6, 15.6);
  const Z = where(55.2, 17.8);
  const Q = where(56.3, 19.4);
  const d = detector();
  const a = fleet(d, [1, 2, 3, 4], S, { knots: 10 });
  let at = a[3].at;
  for (let t = 0; t < 30; t++) {
    at += MIN;
    a.forEach((s, k) =>
      d.observe(fix(s.i, at + k * 1000, move(Z, 0.4 * k, 0))),
    );
  }
  for (let t = 0; t < 5; t++) {
    at += MIN;
    a.forEach((s, k) =>
      d.observe(
        fix(
          s.i,
          at + k * 1000,
          move(s.p, (10 * 1.852 * (at - a[3].at)) / HOUR, 90),
        ),
      ),
    );
  }
  const v = fleet(d, [21, 22, 23, 24], move(Z, 50, 270), {
    knots: 8,
    start: 4 * HOUR,
    minutes: 180,
  });
  at = v[3].at;
  for (let t = 0; t < 15; t++) {
    at += MIN;
    v.forEach((s, k) =>
      d.observe(fix(s.i, at + k * 1000, move(Q, 0.4 * k, 0))),
    );
  }
  const s = snap(d, at + 5000);
  assert.equal(s.regions.length, 1);
  assert.equal(s.regions[0].evidence.sourceInLandingZone, false);
  assert.equal(regionalGnssIntelRecords(s).length, 1);
});

test('a ship reporting every 11 minutes, with no recent course, still gets free of a spoof', () => {
  const d = detector();
  const A = where(55.3, 16.0);
  const s = sail(d, 1, A, { everyS: 660, knots: 12, minutes: 66 });
  const X = move(s.p, 40, 90);
  let at = s.at;
  for (let e = 0; e < 3 * HOUR; e += 660_000)
    d.observe(fix(1, (at += 660_000), X));
  const real = move(s.p, (12 * 1.852 * (at - s.at)) / HOUR, 90);
  const on = sail(d, 1, real, {
    start: at + 660_000,
    everyS: 660,
    knots: 12,
    minutes: 120,
  });
  assert.equal(count(on.answers, 'reason', 'recovered'), 1);
});

test('the vote log stays cheap with thousands of entries', () => {
  const d = detector({ minVessels: 1 });
  for (let i = 1; i <= 2000; i++) {
    const base = move(GULF, (i % 50) * 4, Math.floor(i / 50) * 9);
    for (let m = 0; m <= 31; m += 5)
      d.observe(fix(i, m * MIN, move(base, 0.01 * m, 0)));
  }
  const started = performance.now();
  for (let i = 1; i <= 2000; i++)
    d.observe(fix(i, 32 * MIN + i, move(where(28.4, 56.2), (i % 40) * 0.5, i)));
  assert.ok(
    performance.now() - started < 2000,
    `${performance.now() - started} ms`,
  );
});

test('a spoof held far ahead on the ship’s course, beyond where it could have sailed, is not adopted', () => {
  const A = where(55.3, 16.0);
  const d = detector();
  const ships = fleet(d, [1, 2, 3], A, { everyS: 20 });
  // 200 km ahead on its course, held for two hours: the ship could have
  // sailed 44 km of it.
  const X = move(A, 200, 90);
  let at = ships[2].at;
  const answers = [];
  for (let e = 0; e < 2 * HOUR; e += 20_000) {
    at += 20_000;
    ships.forEach((s, j) =>
      answers.push(d.observe(fix(s.i, at + j * 100, move(X, 0.3 * j, 0)))),
    );
  }
  assert.equal(count(answers, 'reason', 'recovered'), 0);
});

// Red-team round 10 (6 November 2026): each was a confirmed defect.

test('a course measured before a turn is not used once reports thin out', () => {
  const A = where(55.3, 16.0);
  const kmh = 12 * 1.852;
  const d = detector();
  const ids = [1, 2, 3, 4];
  const p = ids.map((_, k) => move(A, 3 * k, 90));
  let at = 0;
  // North on dense reports...
  for (; at <= 40 * MIN; at += 20_000)
    ids.forEach((i, k) => {
      if (at) p[k] = move(p[k], (kmh * 20) / 3600, 0);
      d.observe(fix(i, at + k * 100, p[k]));
    });
  // ...then east, reporting every 12 minutes for two hours.
  at += 700_000;
  for (const end = at + 2 * HOUR; at <= end; at += 720_000)
    ids.forEach((i, k) => {
      p[k] = move(p[k], (kmh * 720) / 3600, 80);
      d.observe(fix(i, at + k * 100, p[k]));
    });
  // A spoof lands 60 km north (the old course, not the real one) and drags back.
  const tail = p.map((q) => ({ ...q }));
  const spoof = p.map((q) => move(q, 60, 5));
  const answers = [];
  for (let e = 0; e < 5 * HOUR; e += 20_000) {
    at += 20_000;
    ids.forEach((i, k) => {
      if (distanceKm(spoof[k], tail[k]) > (15 * 1.852 * 20) / 3600)
        Object.assign(spoof[k], move(spoof[k], (15 * 1.852 * 20) / 3600, 185));
      answers.push(d.observe(fix(i, at + k * 100, spoof[k])));
    });
  }
  assert.equal(count(answers, 'reason', 'recovered'), 0);
});

test('ships whose real reports after a spoof are only suspicious keep no region alive', () => {
  const A = where(55.3, 16.0);
  const kmh = 10 * 1.852;
  const ids = [1, 2, 3, 4];
  // Their real port, north of 55.55 N, reads as inland on the coarse coast.
  const geography = {
    inlandKm: (lat) => (lat > 55.55 ? 20 : 0),
    source: 'stub',
  };
  const d = detector({}, { geography });
  const pos = (k, t) => move(move(A, 2 * k, 0), (kmh * t) / HOUR, 90);
  let at = 0;
  for (; at <= 40 * MIN; at += 20_000)
    ids.forEach((i, k) => d.observe(fix(i, at + k * 100, pos(k, at))));
  const t1 = at;
  const tail = ids.map((_, k) => pos(k, t1));
  const X = move(A, 120, 300);
  for (; at <= t1 + 4 * HOUR; at += 20_000)
    ids.forEach((i, k) => d.observe(fix(i, at + k * 100, move(X, 0.3 * k, 0))));
  // They really turned north to that port, 35 km off their line.
  const real = (k, t) =>
    move(tail[k], Math.min(36, (kmh * (t - t1)) / HOUR), 15);
  const seen = [];
  const t2 = at;
  for (; at <= t1 + 10 * HOUR; at += 20_000) {
    ids.forEach((i, k) => d.observe(fix(i, at + k * 100, real(k, at))));
    if ((at - t2) % HOUR < 20_000) seen.push(snap(d, at + 1000).regions.length);
  }
  assert.ok(
    seen.slice(2).every((n) => n === 0),
    seen.join(''),
  );
});
