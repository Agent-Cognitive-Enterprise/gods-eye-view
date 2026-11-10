import { readFileSync } from 'node:fs';
import { decodeRing } from '../../../src/data/adminBoundaries.js';
import { createLandGrid } from '../../../src/airsea/gnssGeography.js';

const COUNTRIES = new URL(
  '../../../src/data/local_data/natural_earth/countries.json',
  import.meta.url,
);

/**
 * The land grid for the regional GNSS screen, from the bundled Natural Earth
 * admin-0 pack (outer rings only, so enclaves stay land). Built once, in
 * about a second; null when the pack cannot be read, and the screen then runs
 * on kinematics alone.
 */
export function loadNaturalEarthLandGrid({ log = console } = {}) {
  try {
    const started = Date.now();
    const pack = JSON.parse(readFileSync(COUNTRIES, 'utf8'));
    const decimals = pack.meta?.decimals ?? 3;
    const rings = [];
    for (const feature of pack.features ?? [])
      for (const polygon of feature.polygons ?? [])
        if (polygon?.[0]) rings.push(decodeRing(polygon[0], decimals));
    const grid = createLandGrid(rings);
    grid.source = 'natural_earth_10m_admin0';
    log.info?.(
      `[gnss] land grid from ${rings.length} rings in ${Date.now() - started} ms`,
    );
    return grid;
  } catch (error) {
    log.warn?.(`[gnss] no land grid, kinematics only: ${error.message}`);
    return null;
  }
}
