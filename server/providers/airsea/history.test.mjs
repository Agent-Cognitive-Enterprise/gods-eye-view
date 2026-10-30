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
  assert.ok(
    footprint.cells.every((c) => c.passages === 1),
    'one aircraft, one passage per cell',
  );
  const minutes = footprint.cells.reduce((sum, c) => sum + c.minutes, 0);
  assert.ok(Math.abs(minutes - 60) < 0.5, `${minutes} minutes`);
  assert.equal(footprint.snapshots_in_window, 13);
  const anomalies = service.anomalies({ domain: 'air' });
  assert.equal(
    anomalies.status === 'coverage_degraded' ||
      anomalies.status === 'baseline_insufficient',
    true,
  );
  service.close();
  history.close();
});
