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
  const d = createRegionalGnssDetector();
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
  const d = createRegionalGnssDetector();
  for (let i = 1; i <= 2; i++) {
    warm(d, i);
    jump(d, i);
  }
  assert.equal(snap(d).regions.length, 0);
  const e = createRegionalGnssDetector();
  for (let i = 1; i <= 3; i++) {
    warm(e, i);
    jump(e, i, 25.1, 35.1 + i);
  }
  assert.equal(snap(e).regions.length, 0);
});

test('single false jump cannot poison trusted baseline or trigger repeat votes', () => {
  const d = createRegionalGnssDetector();
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
  const d = createRegionalGnssDetector();
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
  const d = createRegionalGnssDetector();
  warm(d, 1);
  assert.equal(d.observe(raw(1, 25 * 60_000, 30, 40)).reason, 'warming');
  assert.equal(snap(d, 25 * 60_000).diagnostic.candidateReports, 0);
});

test('feed degraded, unconfigured or stale suppresses regions, never raises alerts', () => {
  const d = createRegionalGnssDetector();
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
  const d = createRegionalGnssDetector();
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
  const d = createRegionalGnssDetector();
  warm(d, 1);
  assert.equal(d.observe(raw(1, 90_000, 22.103, 31.103)).reason, 'plausible');
  assert.equal(snap(d).diagnostic.impossible, 0);
});

test('fork: a sustained spoof never makes the fake cell a region, nor a trusted fix', () => {
  const d = createRegionalGnssDetector();
  // Three ships at 54.5N 10.5E, then 25 minutes of reports at a fake 56.5N
  // 12.5E (longer than the 20-minute gap), then back to their real tracks.
  for (let i = 1; i <= 3; i++) {
    d.observe(raw(i, 0, 54.5 + i * 0.01, 10.5));
    d.observe(raw(i, 60_000, 54.501 + i * 0.01, 10.501));
  }
  const reasons = new Set();
  for (let m = 2; m <= 27; m++)
    for (let i = 1; i <= 3; i++)
      reasons.add(d.observe(raw(i, m * 60_000 + i, 56.5, 12.5)).reason);
  assert.deepEqual([...reasons], ['kinematic_outlier']);
  for (let i = 1; i <= 3; i++)
    d.observe(raw(i, 28 * 60_000 + i, 54.52 + i * 0.01, 10.52));
  const s = snap(d, 28 * 60_000);
  assert.deepEqual(
    s.regions.map((r) => r.area),
    [{ south: 54, west: 10, north: 55, east: 11 }],
  );
  assert.equal(s.diagnostic.gaps, 0, 'a spoof is not a feed gap');
});

test('fork: a spoof adopted as plausible taints the vessel; its return never votes', () => {
  const d = createRegionalGnssDetector();
  for (let i = 1; i <= 3; i++) {
    d.observe(raw(i, 0, 54.5 + i * 0.01, 10.5));
    d.observe(raw(i, 60_000, 54.501 + i * 0.01, 10.501));
    // One outlier 30 km away, then after 15 minutes the same place looks
    // reachable from the old fix: it is adopted, and the vessel tainted.
    d.observe(raw(i, 120_000, 54.78 + i * 0.01, 10.5));
    assert.equal(
      d.observe(raw(i, 18 * 60_000, 54.78 + i * 0.01, 10.5)).reason,
      'adopted_tainted',
    );
    // Back at the true position: an outlier from the adopted cell, no vote.
    const back = d.observe(raw(i, 18 * 60_000 + 30_000, 52.0, 8.0));
    assert.equal(back.candidate, false);
  }
  assert.equal(snap(d, 19 * 60_000).diagnostic.tainted, 3);
});

test('fork: jumps that stay in or next to their cell are not a coherent pattern', () => {
  const d = createRegionalGnssDetector();
  for (let i = 1; i <= 3; i++) {
    warm(d, i, 22.1 + 0.01 * i, 31.1);
    // About 13 km away: same cell, then the neighbouring one.
    jump(d, i, 22.2 + 0.01 * i, 31.2);
  }
  assert.equal(snap(d).regions.length, 0);
  const e = createRegionalGnssDetector();
  for (let i = 1; i <= 3; i++) {
    warm(e, i, 22.1 + 0.01 * i, 31.1);
    jump(e, i, 23.5, 32.5);
  }
  assert.equal(snap(e).regions.length, 0, 'an adjacent cell is still local');
});

test('fork: placeholder and non-ship MMSIs are refused', () => {
  const d = createRegionalGnssDetector();
  for (const id of ['000000000', '111111111', '123456789', '970123456', '99'])
    assert.equal(
      d.observe({ ...raw(1, 0, 22, 31), mmsi: id }).reason,
      'invalid_id',
    );
  assert.equal(d.observe(raw(1, 0, 22, 31)).reason, 'warming');
});

test('fork: a fresh screen says warming_up, not observing', () => {
  const d = createRegionalGnssDetector({ now: () => T });
  d.observe(raw(1, 0, 22, 31));
  assert.equal(
    d.snapshot({ at: T, feedStatus: 'healthy' }).status,
    'warming_up',
  );
  assert.equal(
    d.snapshot({ at: T + 11 * 60_000, feedStatus: 'healthy' }).status,
    'coverage_uncertain',
    'and quiet for over five minutes is uncertain, not clear',
  );
});
