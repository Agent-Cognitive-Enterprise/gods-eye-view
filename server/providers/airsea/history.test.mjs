import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTrafficHistory } from './history.js';
import { createAirSeaService } from './index.js';

const T = Date.UTC(2026, 9, 30, 12, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;

test('history: passages and minutes sum over a rolling window and survive a restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-history-'));
  const file = path.join(dir, 'traffic.sqlite');
  let clock = T;
  const history = createTrafficHistory({ file, now: () => clock });
  history.add('air', {
    passages: [
      { resolution: 2, cell: 'a', at: T - 30 * MIN },
      { resolution: 2, cell: 'a', at: T - 8 * HOUR },
      { resolution: 2, cell: 'b', at: T - 2 * MIN },
    ],
    minutes: [{ resolution: 2, cell: 'a', minutes: 12.5, at: T - 30 * MIN }],
  });
  history.noteSnapshot('air', T - 30 * MIN, 8000);
  const oneHour = Object.fromEntries(
    history
      .footprint({ domain: 'air', resolution: 2, windowMs: HOUR })
      .map((r) => [r.cell, r]),
  );
  assert.equal(oneHour.a.passages, 1);
  assert.equal(oneHour.a.minutes, 12.5);
  assert.equal(oneHour.b.passages, 1);
  const twelve = history.footprint({
    domain: 'air',
    resolution: 2,
    windowMs: 12 * HOUR,
  });
  assert.equal(
    twelve.find((r) => r.cell === 'a').passages,
    2,
    'hourly totals for long windows',
  );
  history.close();
  const reopened = createTrafficHistory({ file, now: () => clock });
  assert.equal(
    reopened.footprint({ domain: 'air', resolution: 2, windowMs: 12 * HOUR })
      .length,
    2,
    'kept across a restart',
  );
  assert.equal(
    reopened.coverage('air', Math.floor((T - 30 * MIN) / HOUR) * HOUR)
      .snapshots,
    1,
  );
  clock = T + 4 * 24 * HOUR;
  reopened.prune();
  assert.equal(
    reopened.footprint({ domain: 'air', resolution: 2, windowMs: HOUR }).length,
    0,
  );
  reopened.close();
});

const sec = (ms) => Math.floor(ms / 1000);
const snapshot = (at, aircraft) =>
  JSON.stringify({
    time: sec(at),
    states: aircraft.map(([hex, lat, lon]) => [
      hex,
      'CS',
      'X',
      sec(at),
      sec(at),
      lon,
      lat,
      10_000,
      false,
      240,
    ]),
  });

test('service: published snapshots become a footprint along each route', () => {
  let clock = T;
  const queue = [];
  const history = createTrafficHistory({ now: () => clock });
  const service = createAirSeaService({
    now: () => clock,
    snapshots: (after) => queue.filter((s) => s.seq > after),
    subscribe: null,
    readAisRows: () => [],
    aisConfigured: () => false,
    cadenceMs: { opensky: 5 * MIN },
    history,
  });
  // One aircraft flying west for an hour, one snapshot every 5 minutes.
  for (let i = 0; i <= 12; i++) {
    clock = T + i * 5 * MIN;
    queue.push({
      provider: 'opensky',
      body: snapshot(clock, [['abc001', -30, 150 - i * 0.8]]),
      receivedAt: clock,
      seq: i + 1,
    });
    service.density({ domain: 'air', windowMs: HOUR });
  }
  const footprint = service.footprint({
    domain: 'air',
    resolution: 3,
    windowMs: HOUR,
  });
  assert.ok(
    footprint.cells.length >= 6,
    `${footprint.cells.length} cells along the route`,
  );
  // One passage per cell entered; the first sighting's cell is no entry.
  assert.ok(
    footprint.cells.every((c) => c.passages <= 1),
    'one aircraft, at most one passage per cell',
  );
  assert.equal(
    footprint.cells.reduce((sum, c) => sum + c.passages, 0),
    footprint.cells.length - 1,
  );
  const minutes = footprint.cells.reduce((sum, c) => sum + c.minutes, 0);
  assert.ok(Math.abs(minutes - 60) < 0.5, `${minutes} minutes`);
  // The first snapshot only introduces the aircraft: 12 brought news.
  assert.equal(footprint.snapshots_in_window, 12);
  const anomalies = service.anomalies({ domain: 'air' });
  assert.equal(
    anomalies.status === 'coverage_degraded' ||
      anomalies.status === 'baseline_insufficient',
    true,
  );
  service.close();
  history.close();
});

test('a stalled AIS socket is missing coverage, not fewer vessels', () => {
  let clock = T;
  const history = createTrafficHistory({ now: () => clock });
  // The AIS store keeps rows after the socket stops: same rows, old times.
  let rows = [];
  const service = createAirSeaService({
    now: () => clock,
    snapshots: () => [],
    subscribe: null,
    readAisRows: () => rows,
    aisConfigured: () => true,
    cadenceMs: {},
    history,
  });
  const vessel = (mmsi, at) => ({
    mmsi,
    lat: -33.8,
    lon: 151.2 + mmsi / 1000,
    last_position_epoch: at / 1000,
  });
  for (let i = 0; i < 10; i++) {
    clock = T + i * 30_000;
    // Live for the first four reads, then the socket stalls. AIS times run
    // over a minute behind the clock: still news, vessel by vessel.
    if (i < 4) rows = [vessel(1, clock - 90_000), vessel(2, clock - 95_000)];
    service.density({ domain: 'sea', windowMs: HOUR });
  }
  const coverage = history.coverage('sea', T);
  // The first read only introduces the vessels; the stalled ones add nothing.
  assert.equal(coverage.snapshots, 3);
  assert.equal(coverage.objects, 6);
  service.close();
  history.close();
});

test('a corrupt history file is set aside; history starts again', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-history-'));
  const file = path.join(dir, 'traffic.sqlite');
  fs.writeFileSync(file, 'this is not a database'.repeat(100));
  const warnings = [];
  const history = createTrafficHistory({
    file,
    now: () => T,
    warn: (text) => warnings.push(text),
  });
  history.add('air', {
    passages: [{ resolution: 2, cell: 'a', at: T - MIN }],
    minutes: [],
  });
  assert.equal(
    history.footprint({ domain: 'air', resolution: 2, windowMs: HOUR })[0]
      .passages,
    1,
  );
  history.close();
  assert.ok(warnings.some((w) => /moved to/.test(w)));
  assert.ok(fs.readdirSync(dir).some((name) => name.includes('.corrupt-')));
});

test('a history file that cannot be opened is left alone; this run keeps it in memory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-history-'));
  // A directory stands in for a file another process holds: no corruption.
  const file = path.join(dir, 'traffic.sqlite');
  fs.mkdirSync(file);
  const warnings = [];
  const history = createTrafficHistory({
    file,
    now: () => T,
    warn: (text) => warnings.push(text),
  });
  history.add('sea', {
    passages: [{ resolution: 3, cell: 'a', at: T - MIN }],
    minutes: [],
  });
  assert.equal(
    history.footprint({ domain: 'sea', resolution: 3, windowMs: HOUR }).length,
    1,
  );
  history.close();
  assert.ok(warnings.some((w) => /kept in memory/.test(w)));
  assert.equal(fs.statSync(file).isDirectory(), true);
  assert.equal(
    fs.readdirSync(dir).some((name) => name.includes('.corrupt-')),
    false,
  );
});
