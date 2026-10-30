import test from 'node:test';
import assert from 'node:assert/strict';
import { latLngToCell } from 'h3-js';
import { cellRing } from './aggregate.js';
import { createCellShare, ringsOverlap, sectorRing } from './cellShare.js';

const sydney = latLngToCell(-33.9, 151.2, 3);
const ring = cellRing(sydney);
const cell = { h3: sydney, ring };
const now = (fn) => fn();
const square = (lon, lat, half) => [
  [lon - half, lat - half],
  [lon + half, lat - half],
  [lon + half, lat + half],
  [lon - half, lat + half],
  [lon - half, lat - half],
];

test('a hexagon splits into halves and thirds that share its corners', () => {
  assert.equal(sectorRing(ring, 0, 1), ring);
  const halves = [0, 1].map((slot) => sectorRing(ring, slot, 2));
  // Centre, four corners (three edges), back to the centre.
  for (const half of halves) assert.equal(half.length, 6);
  assert.deepEqual(halves[0].at(-2), halves[1][1]);
  const thirds = [0, 1, 2].map((slot) => sectorRing(ring, slot, 3));
  for (const third of thirds) assert.equal(third.length, 5);
  assert.deepEqual(thirds[2].at(-2), ring[0]);
});

test('rings overlap by containment, by crossing edges, across the antimeridian', () => {
  const [lon, lat] = ring[0];
  assert.equal(ringsOverlap(ring, square(151.2, -33.9, 0.05)), true);
  assert.equal(ringsOverlap(ring, square(151.2, -33.9, 20)), true);
  assert.equal(ringsOverlap(ring, square(lon, lat, 0.01)), true);
  assert.equal(ringsOverlap(ring, square(10, 50, 1)), false);
  const pacific = cellRing(latLngToCell(0, 179.95, 3));
  assert.equal(ringsOverlap(pacific, square(-179.9, 0, 0.3)), true);
});

test('owners share a cell in the order air, sea, warning', () => {
  const share = createCellShare({ defer: now });
  let calls = 0;
  share.subscribe(() => calls++);
  share.publishTraffic('air', [cell], 3);
  assert.deepEqual(share.shares(sydney, ring).owners, ['air']);
  share.publishTraffic('sea', [cell], 3);
  assert.deepEqual(share.shares(sydney, ring).owners, ['air', 'sea']);
  assert.equal(share.resolutionOf('sea'), 3);
  share.publishWarnings([
    { ring: square(151.2, -33.9, 0.1), color: '#ff4d4d' },
  ]);
  const { owners, warningColor } = share.shares(sydney, ring);
  assert.deepEqual(owners, ['air', 'sea', 'warning']);
  assert.equal(warningColor, '#ff4d4d');
  const [slice] = share.warningSlices();
  assert.deepEqual(slice.ring, sectorRing(ring, 2, 3));
  // Republishing the same cells tells nobody.
  const before = calls;
  share.publishTraffic('air', [cell], 3);
  assert.equal(calls, before);
  share.publishTraffic('air', [], null);
  assert.equal(share.resolutionOf('air'), null);
  assert.deepEqual(share.shares(sydney, ring).owners, ['sea', 'warning']);
});

test('a warning area alone draws no hexagon slice', () => {
  const share = createCellShare({ defer: now });
  share.publishWarnings([
    { ring: square(151.2, -33.9, 0.1), color: '#ff4d4d' },
  ]);
  assert.deepEqual(share.warningSlices(), []);
  assert.deepEqual(share.shares(sydney, ring).owners, []);
});
