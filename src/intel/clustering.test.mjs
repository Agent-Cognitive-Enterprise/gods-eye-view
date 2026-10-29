import test from 'node:test';
import assert from 'node:assert/strict';
import { boundsOf, centroidOf, clusterEvents, wrapLon } from './clustering.js';

const ev = (id, lat, lon, score = 80, extra = {}) => ({
  event_id: id,
  attention_score: score,
  location: { lat, lon, region_code: null, ...extra },
});

test('A02: two events 300 km apart share one cluster with padded bounds', () => {
  // Belgrade and Sarajevo are ~200 km apart; Belgrade–Zagreb ~370 km.
  const [cluster, ...rest] = clusterEvents([
    ev('a', 44.81, 20.46, 85),
    ev('b', 43.86, 18.41, 80),
  ]);
  assert.equal(rest.length, 0);
  assert.equal(cluster.framing, 'bounds');
  assert.deepEqual(cluster.event_ids, ['a', 'b']);
  assert.ok(cluster.diameter_km > 150 && cluster.diameter_km < 300);
  assert.equal(cluster.bounds.crosses_antimeridian, false);
});

test('A03: continents apart become separate clusters, best first', () => {
  const clusters = clusterEvents([
    ev('tokyo', 35.68, 139.69, 70),
    ev('lima', -12.05, -77.04, 90),
  ]);
  assert.equal(clusters.length, 2);
  assert.deepEqual(clusters[0].event_ids, ['lima']);
});

test('A04: events at 179°E and 179°W cluster across the antimeridian', () => {
  const [cluster, ...rest] = clusterEvents([
    ev('e', -17, 179),
    ev('w', -17, -179),
  ]);
  assert.equal(rest.length, 0);
  assert.ok(cluster.diameter_km < 250, String(cluster.diameter_km));
  assert.equal(cluster.bounds.crosses_antimeridian, true);
  assert.equal(cluster.bounds.west, 179);
  assert.equal(cluster.bounds.east, -179);
  assert.equal(cluster.bounds.lon_span_deg, 2);
  assert.ok(Math.abs(Math.abs(cluster.center.lon) - 180) < 0.01);
});

test('complete-link: a chain of neighbours does not become one long cluster', () => {
  // Points every 500 km along the equator: neighbours fit 800 km, ends do not.
  const chain = [0, 4.5, 9, 13.5, 18].map((lon, i) =>
    ev(`p${i}`, 0, lon, 80 - i),
  );
  const clusters = clusterEvents(chain, { diameterKm: 800 });
  for (const cluster of clusters) assert.ok(cluster.diameter_km <= 800);
  assert.ok(clusters.length >= 3);
});

test('regional events are never given a point', () => {
  const [cluster] = clusterEvents([
    {
      event_id: 'r',
      attention_score: 75,
      location: { lat: null, lon: null, region_code: 'RS' },
    },
  ]);
  assert.equal(cluster.framing, 'region');
  assert.equal(cluster.center, null);
  assert.equal(cluster.region_code, 'RS');
});

test('polar groups are framed as a cap', () => {
  const [cluster] = clusterEvents([ev('n1', 87, 0), ev('n2', 87, 120)]);
  assert.equal(cluster.framing, 'cap');
});

test('bounds and centroid helpers', () => {
  assert.equal(wrapLon(190), -170);
  assert.equal(wrapLon(-180), 180);
  assert.equal(boundsOf([]), null);
  const b = boundsOf([
    { lat: 0, lon: 170 },
    { lat: 0, lon: -170 },
    { lat: 0, lon: 175 },
  ]);
  assert.equal(b.west, 170);
  assert.equal(b.east, -170);
  assert.equal(
    centroidOf([
      { lat: 0, lon: 0 },
      { lat: 0, lon: 180 },
    ]),
    null,
  );
});
