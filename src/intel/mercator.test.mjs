import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MERCATOR_MAX_LAT,
  headingDegrees,
  project,
  routeSegments,
  segmentsPath,
  wrapLon,
} from './mercator.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

test('the equator and prime meridian sit in the middle of the map', () => {
  const p = project(0, 0);
  close(p.x, 0.5);
  close(p.y, 0.5);
});

test('latitude is clamped to the Mercator limit, so the poles stay on the map', () => {
  close(project(MERCATOR_MAX_LAT, 0).y, 0, 1e-8);
  close(project(-MERCATOR_MAX_LAT, 0).y, 1, 1e-8);
  assert.deepEqual(project(90, 10), project(MERCATOR_MAX_LAT, 10));
  assert.deepEqual(project(-90, 10), project(-MERCATOR_MAX_LAT, 10));
});

test('the ±180° edges and out-of-range longitudes land where they should', () => {
  close(project(0, -180).x, 0);
  close(project(0, 180).x, 0, 1e-12); // 180 is the same meridian as -180
  close(project(0, 190).x, project(0, -170).x);
  close(wrapLon(-190), 170);
  close(wrapLon(540), -180);
});

test('missing or non-numeric coordinates give no point', () => {
  for (const [lat, lon] of [
    [null, 0],
    [0, undefined],
    [Number.NaN, 0],
    ['10', '20'],
  ])
    assert.equal(project(lat, lon), null);
});

test('a hop across the dateline is two short lines, not one across the map', () => {
  const segments = routeSegments([
    { lat: -17, lon: 178 }, // Fiji
    { lat: -14, lon: -171 }, // Samoa
  ]);
  assert.equal(segments.length, 2);
  const [west, east] = segments;
  close(west.at(-1).x, 1);
  close(east[0].x, 0);
  close(west.at(-1).y, east[0].y);
  for (const s of segments) {
    const span = Math.abs(s.at(-1).x - s[0].x);
    assert.ok(span < 0.05, `segment spans ${span} of the map`);
  }
});

test('a westward hop across the dateline splits the other way', () => {
  const [first, second] = routeSegments([
    { lat: 10, lon: -175 },
    { lat: 12, lon: 175 },
  ]);
  close(first.at(-1).x, 0);
  close(second[0].x, 1);
});

test('an ordinary route stays one line; a point without a place breaks it', () => {
  assert.equal(routeSegments([{ lat: 0, lon: 0 }, { lat: 10, lon: 10 }, { lat: 20, lon: 30 }]).length, 1);
  const broken = routeSegments([{ lat: 0, lon: 0 }, { lat: 5, lon: 5 }, { lat: null, lon: 0 }, { lat: 9, lon: 9 }, { lat: 10, lon: 10 }]);
  assert.equal(broken.length, 2);
  assert.equal(routeSegments([{ lat: 1, lon: 1 }]).length, 0);
});

test('segment paths are SVG move and line commands in pixels', () => {
  assert.equal(segmentsPath([[{ x: 0, y: 0 }, { x: 0.5, y: 0.25 }]], 200, 100), 'M0.0 0.0L100.0 25.0');
});

test('camera heading turns from radians, clockwise from north, into degrees', () => {
  close(headingDegrees(0), 0);
  close(headingDegrees(Math.PI / 2), 90);
  close(headingDegrees(-Math.PI / 2), 270);
  close(headingDegrees(5 * Math.PI), 180);
  assert.equal(headingDegrees(undefined), 0);
});
