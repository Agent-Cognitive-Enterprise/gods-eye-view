import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRegionalGnssDetector,
  distanceKm,
  regionalCell,
  REGIONAL_GNSS_RULES,
} from './gnssRegional.js';

const T = Date.parse('2026-11-05T00:00:00Z');
const mmsi = (i) => String(210000000 + i);
const raw = (i, offsetMs, lat, lon, extra = {}) => ({
  mmsi: mmsi(i),
  lat,
  lon,
  observedAt: T + offsetMs,
  receivedAt: T + offsetMs,
  timeQuality: 'source',
  ...extra,
});
function warm(detector, i, lat = 22.1, lon = 31.1) {
  detector.observe(raw(i, 0, lat, lon));
  detector.observe(raw(i, 60_000, lat + 0.001, lon + 0.001));
}
function jump(detector, i, targetLat = 25.1, targetLon = 35.1) {
  return detector.observe(raw(i, 90_000, targetLat, targetLon));
}
// The package's unit tests check one rule at a time; the 30-minute track age
// (tested below with the real rules) is set aside for them.
const quick = (rules = {}) =>
  createRegionalGnssDetector({
    rules: { ...REGIONAL_GNSS_RULES, minTrackAgeMs: 0, ...rules },
  });
const snap = (d, offset = 90_000, feedStatus = 'healthy') =>
  d.snapshot({ at: T + offset, feedStatus });

test('haversine is dateline safe; region grid is stable at +/-180', () => {
  assert.ok(
    distanceKm({ lat: 0.1, lon: 179.9 }, { lat: 0.1, lon: -179.9 }) < 25,
  );
  assert.equal(regionalCell(2, 180), regionalCell(2, -180));
  assert.equal(regionalCell(90, 0), null);
});

test('three independent coherent jumps yield one coarse advisory with no targets or MMSIs', () => {
  const d = quick();
  for (let i = 1; i <= 3; i++) {
    warm(d, i, 22.1 + 0.01 * i, 31.1);
    assert.equal(jump(d, i).reason, 'kinematic_outlier');
  }
  const s = snap(d);
  assert.equal(s.status, 'candidate_regions');
  assert.equal(s.regions.length, 1);
  assert.equal(s.regions[0].evidence.uniqueVessels, 3);
  assert.equal(s.regions[0].evidence.coherentTargetVessels, 3);
  assert.equal(s.regions[0].confidence, 'low');
  assert.equal(s.regions[0].causeAssessment, 'unconfirmed');
  assert.equal(s.regions[0].eventPriority, 'advisory');
  assert.deepEqual(s.regions[0].area, {
    south: 22,
    west: 31,
    north: 23,
    east: 32,
  });
  assert.doesNotMatch(JSON.stringify(s), /210000001|targetLon|35\.1/);
});

test('one or two vessels, plus three jumps to unrelated targets, stay unreported', () => {
  const d = quick();
  for (let i = 1; i <= 2; i++) {
    warm(d, i);
    jump(d, i);
  }
  assert.equal(snap(d).regions.length, 0);
  const e = quick();
  for (let i = 1; i <= 3; i++) {
    warm(e, i);
    jump(e, i, 25.1, 35.1 + i);
  }
  assert.equal(snap(e).regions.length, 0);
});

test('single false jump cannot poison trusted baseline or trigger repeat votes', () => {
  const d = quick();
  warm(d, 1);
  assert.equal(jump(d, 1).candidate, true);
  assert.equal(
    d.observe(raw(1, 120_000, 25.3, 35.3)).reason,
    'kinematic_outlier',
  );
  assert.equal(
    d.observe(raw(1, 120_000, 25.3, 35.3)).reason,
    'duplicate_or_out_of_order',
  );
  assert.equal(d.observe(raw(1, 180_000, 22.103, 31.103)).reason, 'plausible');
  assert.equal(snap(d, 180_000).diagnostic.candidateReports, 1);
});

test('first contact, missing timestamps and bad coordinates never imply spoofing', () => {
  const d = quick();
  assert.equal(d.observe(raw(1, 0, 22, 31)).reason, 'warming');
  assert.equal(d.observe(raw(1, 60_000, 25, 35)).reason, 'kinematic_outlier');
  assert.equal(
    d.snapshot({ at: T + 60_000, feedStatus: 'healthy' }).regions.length,
    0,
  );
  assert.equal(
    d.observe(raw(2, 0, 22, 31, { timeQuality: 'fallback' })).reason,
    'untrusted_time',
  );
  assert.equal(d.observe(raw(2, 0, 0, 0)).reason, 'invalid_position');
  assert.equal(
    d.observe(raw(2, -10 * 60_000, 22, 31, { receivedAt: T })).reason,
    'stale_or_future',
  );
  assert.equal(
    d.observe(raw(2, 10 * 60_000, 22, 31, { receivedAt: T })).reason,
    'stale_or_future',
  );
});

test('long gaps reset warmup, not count as incredible speeds', () => {
  const d = quick();
  warm(d, 1);
  assert.equal(d.observe(raw(1, 25 * 60_000, 30, 40)).reason, 'warming');
  assert.equal(snap(d, 25 * 60_000).diagnostic.candidateReports, 0);
});

test('feed degraded, unconfigured or stale suppresses regions, never raises alerts', () => {
  const d = quick();
  for (let i = 1; i <= 3; i++) {
    warm(d, i);
    jump(d, i);
  }
  assert.equal(snap(d, 90_000, 'degraded').status, 'coverage_uncertain');
  assert.equal(snap(d, 90_000, 'degraded').regions.length, 0);
  assert.equal(snap(d, 90_000, 'unconfigured').status, 'unconfigured');
  assert.equal(snap(d, 90_000, 'unconfigured').regions.length, 0);
  assert.equal(snap(d, 8 * 60_000).status, 'coverage_uncertain');
  assert.equal(snap(d, 8 * 60_000).regions.length, 0);
});

test('expired candidates removed, stable IDs and no event when clock is moved backwards', () => {
  const d = quick();
  for (let i = 1; i <= 3; i++) {
    warm(d, i);
    jump(d, i);
  }
  const id = snap(d).regions[0].id;
  assert.equal(snap(d, 2 * 60_000).regions[0].id, id);
  assert.equal(snap(d, 32 * 60_000).regions.length, 0);
  assert.equal(snap(d, 32 * 60_000).diagnostic.candidateReports, 0);
});

test('strict memory limits bound quiet objects and candidates', () => {
  const rules = {
    ...REGIONAL_GNSS_RULES,
    maxTrackedVessels: 3,
    maxCandidates: 2,
  };
  const d = createRegionalGnssDetector({ rules });
  for (let i = 1; i <= 8; i++) d.observe(raw(i, 0, 22, 31));
  assert.ok(snap(d, 0).diagnostic.tracked <= 3);
  assert.ok(snap(d, 0).diagnostic.evicted >= 5);
});

test('reasonable vessel motion stays plausible', () => {
  const d = quick();
  warm(d, 1);
  assert.equal(d.observe(raw(1, 90_000, 22.103, 31.103)).reason, 'plausible');
  assert.equal(snap(d).diagnostic.impossible, 0);
});

// ---- Fork scenarios, with the real rules (30-minute track age) ----------

const MIN = 60_000;
/** A ship sailing north-east at `kn` knots from (lat, lon), at minute `m`. */
const sailing =
  (lat, lon, kn = 12) =>
  (m) => {
    const deg = (kn * 1.852 * (m / 60)) / 111.2 / Math.SQRT2;
    return [lat + deg, lon + deg / Math.cos((lat * Math.PI) / 180)];
  };
/**
 * Three ships near 54.5N 10.5E reporting every minute from minute 0 to `end`;
 * `spoofed(m)` says whether minute m reports the fake position.
 */
function voyage(d, { end, spoofed = () => false, fake = [56.5, 12.5], kn }) {
  const ships = [1, 2, 3].map((i) => sailing(54.4 + i * 0.03, 10.4, kn));
  const regions = new Map(); // minute -> region boxes
  for (let m = 0; m <= end; m++) {
    ships.forEach((at, i) => {
      const [lat, lon] = spoofed(m) ? fake : at(m);
      d.observe(raw(i + 1, m * MIN + i, lat, lon));
    });
    regions.set(
      m,
      snap(d, m * MIN + 10).regions.map((r) => r.area),
    );
  }
  return regions;
}
const TRUE_CELL = { south: 54, west: 10, north: 55, east: 11 };

test('fork: a spoof is reported from where the ships really are, every minute it lasts', () => {
  // 40 minutes tracked, then a 25-minute spoof (longer than the 20-minute gap).
  const d = createRegionalGnssDetector({ now: () => T });
  const regions = voyage(d, { end: 70, spoofed: (m) => m >= 40 && m < 65 });
  for (const m of [41, 50, 64]) assert.deepEqual(regions.get(m), [TRUE_CELL]);
  for (const [, boxes] of regions)
    for (const box of boxes)
      assert.deepEqual(box, TRUE_CELL, 'never the fake cell');
  assert.equal(
    snap(d, 70 * MIN).diagnostic.gaps,
    0,
    'a spoof is not a feed gap',
  );
});

test('fork: after a spoof ends the ships are trusted again, and a second spoof is caught', () => {
  const d = createRegionalGnssDetector({ now: () => T });
  const regions = voyage(d, {
    end: 140,
    kn: 15,
    spoofed: (m) => (m >= 35 && m < 60) || (m >= 100 && m < 125),
  });
  assert.deepEqual(regions.get(59), [TRUE_CELL]);
  assert.deepEqual(regions.get(95), [], 'the first episode has aged out');
  assert.deepEqual(regions.get(110), [TRUE_CELL], 'the second is reported');
});

test('fork: a three-hour spoof stays reported until it ends', () => {
  const d = createRegionalGnssDetector({ now: () => T });
  const regions = voyage(d, {
    end: 240,
    kn: 8,
    fake: [55.9, 11.0], // about 160 km away
    spoofed: (m) => m >= 35 && m < 215,
  });
  for (let m = 40; m < 215; m += 15)
    assert.deepEqual(regions.get(m), [TRUE_CELL], `minute ${m}`);
});

test('fork: tracks younger than 30 minutes never vote (first seen mid-spoof)', () => {
  const d = createRegionalGnssDetector({ now: () => T });
  // Spoofed from minute 10 to 25: the ships were watched for under 30 minutes.
  const regions = voyage(d, { end: 26, spoofed: (m) => m >= 10 && m < 25 });
  for (const [, boxes] of regions) assert.deepEqual(boxes, []);
});

test('fork: a large coordinated jump into the next cell counts; small glitches never do', () => {
  const big = createRegionalGnssDetector({ now: () => T });
  // About 120 km north: the adjacent row of cells.
  const bigRegions = voyage(big, {
    end: 45,
    fake: [55.6, 10.5],
    spoofed: (m) => m >= 40,
  });
  assert.deepEqual(bigRegions.get(42), [TRUE_CELL]);
  const small = createRegionalGnssDetector({ now: () => T });
  // About 30 km east, across the 11E cell edge: implausible, but local.
  const smallRegions = voyage(small, {
    end: 45,
    fake: [54.52, 11.05],
    spoofed: (m) => m >= 40,
  });
  assert.deepEqual(smallRegions.get(42), []);
});

test('fork: an on-and-off spoof keeps reporting after the ships cross into a new cell', () => {
  // Starting just below 55N at 15 knots, the ships cross into the next row.
  const d = createRegionalGnssDetector({ now: () => T });
  const ships = [1, 2, 3].map((i) => sailing(54.93 + i * 0.002, 10.5, 15));
  let crossed = null;
  for (let m = 0; m <= 90; m++) {
    ships.forEach((at, i) => {
      const spoof = m >= 35 && m % 2 === 1;
      const [lat, lon] = spoof ? [57.5, 13.5] : at(m);
      d.observe(raw(i + 1, m * MIN + i, lat, lon));
    });
    if (crossed === null && ships[0](m)[0] >= 55) crossed = m;
  }
  assert.ok(crossed !== null && crossed < 80, 'the fixture crosses 55N');
  const { regions } = snap(d, 90 * MIN + 10);
  assert.deepEqual(
    regions.map((r) => r.area),
    [{ south: 55, west: 10, north: 56, east: 11 }],
  );
});

test('fork: placeholder and non-ship MMSIs are refused', () => {
  const d = quick();
  for (const id of [
    '000000000',
    '222222222',
    '777777777',
    '123456789',
    '970123456',
    '99',
  ])
    assert.equal(
      d.observe({ ...raw(1, 0, 22, 31), mmsi: id }).reason,
      'invalid_id',
      id,
    );
  assert.equal(d.observe(raw(1, 0, 22, 31)).reason, 'warming');
});

test('fork: warming_up for the first 30 minutes, then observing; quiet is uncertain', () => {
  const d = createRegionalGnssDetector({ now: () => T });
  d.observe(raw(1, 0, 22, 31));
  assert.equal(
    d.snapshot({ at: T, feedStatus: 'healthy' }).status,
    'warming_up',
  );
  for (let m = 1; m <= 31; m++) d.observe(raw(1, m * MIN, 22 + m * 0.002, 31));
  assert.equal(
    d.snapshot({ at: T + 31 * MIN, feedStatus: 'healthy' }).status,
    'observing',
  );
  assert.equal(
    d.snapshot({ at: T + 40 * MIN, feedStatus: 'healthy' }).status,
    'coverage_uncertain',
    'quiet for over five minutes is uncertain, not clear',
  );
});

test('fork: a cell size that does not divide 360 is refused', () => {
  assert.throws(
    () =>
      createRegionalGnssDetector({
        rules: { ...REGIONAL_GNSS_RULES, cellDeg: 7 },
      }),
    RangeError,
  );
});

test('fork: a long jump that stays inside the same cell is not a vote', () => {
  const d = createRegionalGnssDetector({ now: () => T });
  // From about 54.5N 10.55E to 54.02N 10.02E: 66-72 km, still cell 54N 10E.
  const regions = voyage(d, {
    end: 45,
    fake: [54.02, 10.02],
    spoofed: (m) => m >= 40,
  });
  assert.deepEqual(regions.get(42), []);
});

test('fork: a region ages out half an hour after the spoof ends, and does not return', () => {
  // A 60-minute spoof to a fixed point about 100 km away, in the next row.
  const d = createRegionalGnssDetector({ now: () => T });
  const regions = voyage(d, {
    end: 360,
    fake: [55.45, 10.9],
    spoofed: (m) => m >= 40 && m < 100,
  });
  assert.deepEqual(regions.get(99), [TRUE_CELL]);
  assert.deepEqual(regions.get(135), [], 'gone 35 minutes after it ended');
  for (let m = 135; m <= 360; m++)
    assert.deepEqual(regions.get(m), [], `minute ${m}`);
});

test('fork: an honest ship after one glitch and a reception gap is trusted again', () => {
  const d = createRegionalGnssDetector({ now: () => T });
  const at = sailing(54.5, 10.4, 25);
  for (let m = 0; m <= 40; m++) d.observe(raw(1, m * MIN, ...at(m)));
  // One glitch 90 km ahead, then 13 minutes without reports.
  assert.equal(
    d.observe(raw(1, 41 * MIN, ...sailing(54.5, 10.4, 25)(41 + 116))).reason,
    'kinematic_outlier',
  );
  const after = [];
  for (let m = 54; m <= 120; m++)
    after.push(d.observe(raw(1, m * MIN, ...at(m))).reason);
  assert.deepEqual([...new Set(after)], ['plausible']);
});

test('fork: a spoof that moves to a second point is not adopted; no fake cell', () => {
  const d = createRegionalGnssDetector({ now: () => T });
  // Anchored ships; 60 minutes at one fake point, 30 at another 92 km off.
  const ships = [1, 2, 3].map((i) => [54.5 + i * 0.03, 10.4]);
  const boxes = new Set();
  for (let m = 0; m <= 200; m++) {
    ships.forEach(([lat, lon], i) => {
      const fix =
        m >= 40 && m < 100
          ? [55.5, 10.5]
          : m >= 100 && m < 130
            ? [56.33, 10.5]
            : [lat, lon];
      d.observe(raw(i + 1, m * MIN + i, ...fix));
    });
    for (const r of snap(d, m * MIN + 10).regions)
      boxes.add(JSON.stringify(r.area));
  }
  assert.deepEqual([...boxes], [JSON.stringify(TRUE_CELL)]);
});

test('fork: a country code with six zeros is a shared default, refused', () => {
  assert.equal(
    quick().observe({ ...raw(1, 0, 22, 31), mmsi: '412000000' }).reason,
    'invalid_id',
  );
  assert.equal(
    quick().observe({ ...raw(1, 0, 22, 31), mmsi: '412000001' }).reason,
    'warming',
  );
});

test('fork: a close spoof held for hours stays an outlier (the suspicion speed alone would adopt it)', () => {
  // Anchored ships; three hours at a fake point about 60 km away, then back.
  const d = createRegionalGnssDetector({ now: () => T });
  const ships = [1, 2, 3].map((i) => [54.5 + i * 0.03, 10.4]);
  const boxes = new Set();
  let reportedAt170 = null;
  for (let m = 0; m <= 260; m++) {
    ships.forEach(([lat, lon], i) => {
      const fix = m >= 40 && m < 220 ? [54.6, 11.35] : [lat, lon];
      d.observe(raw(i + 1, m * MIN + i, ...fix));
    });
    const { regions } = snap(d, m * MIN + 10);
    for (const r of regions) boxes.add(JSON.stringify(r.area));
    if (m === 170) reportedAt170 = regions.map((r) => r.area);
  }
  assert.deepEqual(reportedAt170, [TRUE_CELL], 'still reported mid-spoof');
  assert.deepEqual(
    [...boxes],
    [JSON.stringify(TRUE_CELL)],
    'never the fake cell',
  );
});

test('fork: an honest ship sailing on past a short glitch is not held', () => {
  const d = createRegionalGnssDetector({ now: () => T });
  const at = sailing(54.5, 10.4, 12);
  for (let m = 0; m <= 40; m++) d.observe(raw(1, m * MIN, ...at(m)));
  // One glitch 15 km ahead; the ship keeps reporting every minute.
  assert.equal(
    d.observe(raw(1, 41 * MIN, ...sailing(54.5, 10.4, 12)(41 + 40))).reason,
    'kinematic_outlier',
  );
  const after = [];
  for (let m = 42; m <= 100; m++)
    after.push(d.observe(raw(1, m * MIN, ...at(m))).reason);
  assert.deepEqual([...new Set(after)], ['plausible']);
});

test('fork: a ship held near a glitch point is released once it sails 20 km past it', () => {
  const d = createRegionalGnssDetector({ now: () => T });
  const at = sailing(54.5, 10.4, 25);
  for (let m = 0; m <= 40; m++) d.observe(raw(1, m * MIN, ...at(m)));
  // A glitch about 25 km ahead, then 13 minutes without reports: the ship
  // reappears inside the glitch area, so it is held for a while.
  d.observe(raw(1, 41 * MIN, ...at(41 + 32)));
  const reasons = [];
  for (let m = 54; m <= 180; m++)
    reasons.push(d.observe(raw(1, m * MIN, ...at(m))).reason);
  assert.equal(reasons[0], 'kinematic_outlier', 'held at first');
  assert.equal(reasons.at(-1), 'plausible', 'released after sailing on');
  assert.ok(reasons.lastIndexOf('kinematic_outlier') < 80, 'within ~1.5 h');
});

test('fork: under suspicion a move faster than a ship is not adopted', () => {
  // Anchored ships; spoofed to one point for an hour, then to a second point
  // ~70 km from the truth: about 37 knots from the stale fix, under the 100-knot
  // rule, but not a ship's pace. Adopted, it would publish its own cell.
  const d = createRegionalGnssDetector({ now: () => T });
  const ships = [1, 2, 3].map((i) => [54.5 + i * 0.03, 10.4]);
  const boxes = new Set();
  for (let m = 0; m <= 200; m++) {
    ships.forEach(([lat, lon], i) => {
      const fix =
        m >= 40 && m < 100
          ? [55.5, 10.5]
          : m >= 100 && m < 130
            ? [55.15, 10.4]
            : [lat, lon];
      d.observe(raw(i + 1, m * MIN + i, ...fix));
    });
    for (const r of snap(d, m * MIN + 10).regions)
      boxes.add(JSON.stringify(r.area));
  }
  assert.deepEqual([...boxes], [JSON.stringify(TRUE_CELL)]);
});

test('fork: a track with a single trusted fix never votes', () => {
  // Each ship's first report is its only plausible one: spoofed from minute 1.
  const d = createRegionalGnssDetector({ now: () => T });
  const regions = voyage(d, { end: 45, spoofed: (m) => m >= 1 });
  for (const [, boxes] of regions) assert.deepEqual(boxes, []);
});

/** Position after `m` minutes on a north-east course with a speed profile. */
const profiled = (lat, lon, knotsAt) => (m) => {
  let km = 0;
  for (let s = 0; s < m; s++) km += (knotsAt(s) * 1.852) / 60;
  const deg = km / 111.2 / Math.SQRT2;
  return [lat + deg, lon + deg / Math.cos((lat * Math.PI) / 180)];
};

test('fork: fast ferries that glitch while still slow are never frozen into a region', () => {
  // Three ferries leave harbour at 8 kn, glitch at minute 10, cruise at 35 kn
  // with a 10-minute reception gap, and dock at minute 150.
  const d = createRegionalGnssDetector({ now: () => T });
  const ferries = [1, 2, 3].map((i) =>
    profiled(54.4 + i * 0.03, 10.4, (s) => (s < 10 ? 8 : s < 150 ? 35 : 0)),
  );
  const late = new Set();
  for (let m = 0; m <= 360; m++) {
    if (m >= 15 && m < 25) continue; // reception gap
    ferries.forEach((at, i) => {
      const fix = m === 10 ? at(10 + 150) : at(m); // the glitch: far ahead
      const { reason } = d.observe(raw(i + 1, m * MIN + i, ...fix));
      if (m > 70) late.add(reason);
    });
    assert.deepEqual(snap(d, m * MIN + 10).regions, [], `minute ${m}`);
  }
  assert.deepEqual([...late], ['plausible'], 'trusted again within the hour');
});

test('fork: a spoof moved to a second point after two hours is still not adopted', () => {
  // Anchored ships; two hours at a point ~155 km away, then an hour at a
  // second point ~80 km from the truth, in another cell; then back.
  const d = createRegionalGnssDetector({ now: () => T });
  const ships = [1, 2, 3].map((i) => [54.5 + i * 0.03, 10.4]);
  const boxes = new Set();
  let at220 = null;
  for (let m = 0; m <= 420; m++) {
    ships.forEach(([lat, lon], i) => {
      const fix =
        m >= 40 && m < 160
          ? [55.9, 10.4]
          : m >= 160 && m < 220
            ? [54.6, 11.65]
            : [lat, lon];
      d.observe(raw(i + 1, m * MIN + i, ...fix));
    });
    const { regions } = snap(d, m * MIN + 10);
    for (const r of regions) boxes.add(JSON.stringify(r.area));
    if (m === 255) at220 = regions;
  }
  assert.deepEqual([...boxes], [JSON.stringify(TRUE_CELL)]);
  assert.deepEqual(at220, [], 'aged out 35 minutes after it ended');
});

test('fork: short steps at an impossible speed are held, never adopted', () => {
  const d = createRegionalGnssDetector({ now: () => T });
  for (let m = 0; m <= 40; m++) d.observe(raw(1, m * MIN, 54.5, 10.4));
  // 9 km in 10 seconds: about 1,750 knots, under the 10 km jump rule.
  assert.equal(
    d.observe(raw(1, 40 * MIN + 10_000, 54.58, 10.4)).reason,
    'too_fast_hold',
  );
  // Still trusted where it was: the next fix there is plausible.
  assert.equal(d.observe(raw(1, 41 * MIN, 54.5, 10.4)).reason, 'plausible');
});

test('fork: a drag of a few km per report never moves the trusted fix or the region', () => {
  // Anchored ships dragged 9 km every 10 s for 200 km, held, then released.
  const d = createRegionalGnssDetector({ now: () => T });
  const ships = [1, 2, 3].map((i) => [54.5 + i * 0.03, 10.4]);
  const boxes = new Set();
  const step = (t, i, fix) => d.observe(raw(i + 1, t + i, ...fix));
  for (let m = 0; m <= 40; m++)
    ships.forEach(([lat, lon], i) => step(m * MIN, i, [lat, lon]));
  for (let k = 1; k <= 22; k++)
    ships.forEach(([lat, lon], i) =>
      step(40 * MIN + k * 10_000, i, [lat + k * 0.081, lon]),
    );
  for (let m = 45; m <= 240; m++) {
    ships.forEach(([lat, lon], i) =>
      step(m * MIN, i, m < 60 ? [lat + 22 * 0.081, lon] : [lat, lon]),
    );
    for (const r of snap(d, m * MIN + 10).regions)
      boxes.add(JSON.stringify(r.area));
  }
  for (const box of boxes) assert.equal(box, JSON.stringify(TRUE_CELL));
  assert.deepEqual(snap(d, 240 * MIN).regions, [], 'and it ages out');
});

test('fork: a spoof drifting away from its first point is held, not adopted', () => {
  // Anchored ships; a fake point ~110 km away for 30 minutes, then the fake
  // drifts east at ~60 kn for 20 minutes and stays there, then back. From the
  // old trusted fix the drifted points look reachable under 100 kn; only the
  // suspicion speed keeps them from being trusted.
  const d = createRegionalGnssDetector({ now: () => T });
  const ships = [1, 2, 3].map((i) => [54.5 + i * 0.03, 10.4]);
  const fakeAt = (m) => {
    if (m < 70) return [55.5, 10.5];
    const drift = Math.min(m - 70, 20) * ((60 * 1.852) / 60); // km east
    return [55.5, 10.5 + drift / (111.2 * Math.cos((55.5 * Math.PI) / 180))];
  };
  const boxes = new Set();
  for (let m = 0; m <= 200; m++) {
    ships.forEach(([lat, lon], i) => {
      const fix = m >= 40 && m < 110 ? fakeAt(m) : [lat, lon];
      d.observe(raw(i + 1, m * MIN + i, ...fix));
    });
    for (const r of snap(d, m * MIN + 10).regions)
      boxes.add(JSON.stringify(r.area));
  }
  assert.deepEqual([...boxes], [JSON.stringify(TRUE_CELL)]);
});

test('fork: a ship measured at 40 kn sails on at 40 kn after a glitch and a gap, never held', () => {
  const d = createRegionalGnssDetector({ now: () => T });
  const at = sailing(54.5, 10.4, 40);
  for (let m = 0; m <= 40; m++) d.observe(raw(1, m * MIN, ...at(m)));
  assert.equal(
    d.observe(raw(1, 41 * MIN, ...at(41 + 120))).reason,
    'kinematic_outlier',
  );
  // 15 minutes without reports: it reappears ~20 km on, at its own 40 kn
  // (over the 30 kn floor, inside 1.5 times its measured speed).
  const after = [];
  for (let m = 56; m <= 100; m++)
    after.push(d.observe(raw(1, m * MIN, ...at(m))).reason);
  assert.deepEqual([...new Set(after)], ['plausible']);
});
