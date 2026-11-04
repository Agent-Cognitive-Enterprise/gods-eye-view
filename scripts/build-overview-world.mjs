#!/usr/bin/env node
/**
 * Builds the Autopilot world overview's base map (fork feature).
 *
 *   node scripts/build-overview-world.mjs
 *
 * Reads the bundled Natural Earth countries (public domain, about 1 MB), projects them
 * to Web Mercator on a 1000 × 1000 grid, simplifies each ring (Douglas-Peucker, about
 * one map pixel at the overview's size), drops slivers too small to see, and writes one
 * SVG path to src/intel/overviewWorld.json. The browser downloads only that file.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decodeRing } from '../src/data/adminBoundaries.js';
import { project } from '../src/intel/mercator.js';

const SRC = new URL(
  '../src/data/local_data/natural_earth/countries.json',
  import.meta.url,
);
const OUT = new URL('../src/intel/overviewWorld.json', import.meta.url);
const GRID = 1000;
const TOLERANCE = 2.2; // grid units: under 1 px at a 360 px wide map
const MIN_EXTENT = 5; // grid units: rings smaller than about 2 px are dropped

function simplify(points, tolerance) {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    const [ax, ay] = points[first];
    const [bx, by] = points[last];
    const dx = bx - ax;
    const dy = by - ay;
    const length = Math.hypot(dx, dy) || 1;
    let worst = -1;
    let index = -1;
    for (let i = first + 1; i < last; i += 1) {
      const [px, py] = points[i];
      const distance = Math.abs(dy * px - dx * py + bx * ay - by * ax) / length;
      if (distance > worst) {
        worst = distance;
        index = i;
      }
    }
    if (worst > tolerance) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/**
 * A ring that crosses ±180° (Russia, Fiji, Antarctica) would be drawn with an edge
 * straight across the map. Split it at every such jump: the points on each side
 * become their own ring, closed along the map border.
 */
function splitAtDateline(points) {
  const sides = [[], []];
  let side = 0;
  points.forEach((point, i) => {
    if (i > 0 && Math.abs(point[0] - points[i - 1][0]) > GRID / 2)
      side = 1 - side;
    sides[side].push(point);
  });
  return sides.filter((ring) => ring.length >= 3);
}

const data = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const decimals = data.meta.decimals;
const parts = [];
let rings = 0;
let kept = 0;
for (const feature of data.features) {
  for (const polygon of feature.polygons ?? []) {
    for (const encoded of polygon) {
      rings += 1;
      const ring = decodeRing(encoded, decimals);
      // A handful of source slivers decode outside the world; wrapping them would
      // place them somewhere arbitrary.
      if (ring.some(([lon, lat]) => Math.abs(lon) > 180 || Math.abs(lat) > 90))
        continue;
      const whole = ring
        .map(([lon, lat]) => project(lat, lon))
        .filter(Boolean)
        .map((p) => [
          Math.round(p.x * GRID * 10) / 10,
          Math.round(p.y * GRID * 10) / 10,
        ]);
      for (const projected of splitAtDateline(whole)) {
        const xs = projected.map((p) => p[0]);
        const ys = projected.map((p) => p[1]);
        if (
          Math.max(...xs) - Math.min(...xs) < MIN_EXTENT &&
          Math.max(...ys) - Math.min(...ys) < MIN_EXTENT
        )
          continue;
        const simple = simplify(projected, TOLERANCE).map(([x, y]) => [
          Math.round(x),
          Math.round(y),
        ]);
        const unique = simple.filter(
          (p, i) =>
            i === 0 || p[0] !== simple[i - 1][0] || p[1] !== simple[i - 1][1],
        );
        if (unique.length < 3) continue;
        kept += 1;
        parts.push(`M${unique.map(([x, y]) => `${x} ${y}`).join('L')}Z`);
      }
    }
  }
}
const out = {
  source:
    'Natural Earth countries (public domain), src/data/local_data/natural_earth/countries.json',
  projection: 'Web Mercator, latitude clamped to ±85.05112878°',
  grid: GRID,
  path: parts.join(''),
};
fs.writeFileSync(OUT, `${JSON.stringify(out)}\n`);
console.log(
  `${fileURLToPath(OUT)}: ${kept} of ${rings} rings, ${Math.round(fs.statSync(OUT).size / 1024)} KB`,
);
