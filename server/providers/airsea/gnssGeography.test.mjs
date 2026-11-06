import test from 'node:test';
import assert from 'node:assert/strict';
import { loadNaturalEarthLandGrid } from './gnssGeographyLoader.js';
import { createLandGrid } from '../../../src/airsea/gnssGeography.js';
import {
  createRegionalGnssDetector,
  REGIONAL_GNSS_RULES,
} from '../../../src/airsea/gnssRegional.js';

const grid = loadNaturalEarthLandGrid({ log: {} });
const at = (lat, lon) => ({ lat, lon });

test('the Natural Earth grid knows the Gulf, Hormuz and their shores', () => {
  assert.ok(grid, 'grid built');
  assert.equal(grid.source, 'natural_earth_10m_admin0');
  for (const [name, p] of [
    ['Arabian Gulf', at(26.5, 52.5)],
    ['Strait of Hormuz', at(26.55, 56.45)],
    ['Gulf of Oman', at(25.0, 58.0)],
    ['Jebel Ali approach', at(25.05, 55.0)],
    ['Caspian Sea', at(42, 51)],
  ])
    assert.equal(grid.inlandKm(p.lat, p.lon), 0, name);
  for (const [name, p, km] of [
    ['Musandam', at(26.0, 56.2), 10],
    ['Qatar', at(25.3, 51.2), 25],
    ['Tehran', at(35.7, 51.4), 100],
  ])
    assert.ok(
      grid.inlandKm(p.lat, p.lon) >= km,
      `${name}: ${grid.inlandKm(p.lat, p.lon)}`,
    );
  assert.equal(grid.inlandKm(89, 0), null);
});

test('water routes go round Qatar and through the hand-opened canals', () => {
  const west = at(25.5, 50.65);
  const east = at(25.5, 51.9);
  assert.equal(grid.straightLineClear(west, east), false);
  const round = grid.routeKm(west, east, 800);
  assert.equal(round.status, 'route');
  assert.ok(round.km > 170 && round.km < 260, `${round.km}`);
  assert.equal(grid.routeKm(west, east, 120).status, 'longer');
  for (const [name, a, b, limit] of [
    ['Suez', at(31.6, 32.3), at(27.5, 34.0), 1500],
    ['Kiel', at(54.0, 8.3), at(54.5, 10.5), 600],
    ['Bosporus and Dardanelles', at(41.5, 29.5), at(39.5, 25.5), 900],
    ['Hormuz', at(26.0, 55.5), at(25.5, 57.0), 800],
  ])
    assert.equal(grid.routeKm(a, b, limit).status, 'route', name);
  assert.equal(grid.routeKm(at(25.3, 51.2), east, 500).status, 'unknown');
});

test('a toy ring rasterises as land with inland distance growing from its edge', () => {
  const square = [
    [10, 10],
    [12, 10],
    [12, 12],
    [10, 12],
  ];
  const toy = createLandGrid([square], { cellDeg: 0.1, channels: [] });
  assert.equal(toy.inlandKm(9.5, 11), 0);
  const edge = toy.inlandKm(10.15, 11);
  const centre = toy.inlandKm(11, 11);
  // Measured between cell centres, so quantised to about a cell.
  assert.ok(edge > 0 && edge < 30, `${edge}`);
  assert.ok(centre > 90 && centre < 125, `${centre}`);
});

const T = Date.parse('2026-11-06T00:00:00Z');
const fix = (i, ms, p) => ({
  mmsi: String(210000000 + i),
  lat: p.lat,
  lon: p.lon,
  observedAt: T + ms,
  receivedAt: T + ms,
  timeQuality: 'source',
});

test('Hormuz: ships in the strait pushed onto land inland of Bandar Abbas are implausible, land noted', () => {
  const d = createRegionalGnssDetector({ now: () => T, geography: grid });
  for (const i of [1, 2, 3])
    for (let m = 0; m <= 40; m++)
      d.observe(fix(i, m * 60_000, at(26.45 + i * 0.03, 56.0 + m * 0.003)));
  const answers = [1, 2, 3].map((i) =>
    d.observe(fix(i, 41 * 60_000 + i * 1000, at(27.45 + i * 0.002, 56.6))),
  );
  for (const a of answers) {
    assert.equal(a.assessment, 'implausible');
    assert.ok(a.evidence.includes('land'), a.evidence.join());
  }
  const s = d.snapshot({ at: T + 41 * 60_000 + 5000, feedStatus: 'healthy' });
  assert.equal(s.regions.length, 1);
  assert.equal(s.regions[0].evidence.landTargetVessels, 3);
  assert.equal(s.coverage.geography, 'natural_earth_10m_admin0');
});

test('Qatar: a tanker reappearing on the far side of the peninsula sooner than the sea route allows is suspicious', () => {
  const d = createRegionalGnssDetector({ now: () => T, geography: grid });
  d.observeStatic({ mmsi: '210000001', shipType: 80, receivedAt: T });
  for (let m = 0; m <= 40; m++)
    d.observe(fix(1, m * 60_000, at(25.5, 50.6 + m * 0.0001)));
  // 3.25 hours dark: 125 km straight (21 kn) but about 190 km by sea (32 kn).
  const back = d.observe(fix(1, 40 * 60_000 + 3.25 * 3600_000, at(25.5, 51.9)));
  assert.equal(back.assessment, 'unknown');
  assert.ok(back.evidence.includes('route'));
  // Without a land grid the same move is plausible.
  const flat = createRegionalGnssDetector({ now: () => T });
  flat.observeStatic({ mmsi: '210000001', shipType: 80, receivedAt: T });
  for (let m = 0; m <= 40; m++)
    flat.observe(fix(1, m * 60_000, at(25.5, 50.6 + m * 0.0001)));
  assert.equal(
    flat.observe(fix(1, 40 * 60_000 + 3.25 * 3600_000, at(25.5, 51.9)))
      .assessment,
    'plausible',
  );
});

test('ships in port up a river (Hamburg) are not land evidence', () => {
  const d = createRegionalGnssDetector({
    now: () => T,
    geography: grid,
    rules: REGIONAL_GNSS_RULES,
  });
  const answers = [];
  for (let m = 0; m <= 60; m++)
    answers.push(d.observe(fix(1, m * 60_000, at(53.54, 9.9 + m * 0.001))));
  assert.ok(answers.slice(1).every((a) => a.assessment === 'plausible'));
});
