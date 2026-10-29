// Country and US-state geometry for events that name a place but not a point:
// real bounds from the bundled Natural Earth packs (public domain), never an
// invented incident location. Loaded once, lazily; pure lookups afterwards.
//
// A country's extent is its home territory: the largest polygon of its main
// map unit and the polygons near it, so France is framed without French
// Guiana and the United States without Hawaii. Its representative point is
// the centre of that extent, a country-level marker position only.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decodeRing } from '../../../src/data/adminBoundaries.js';
import { greatCircleKm, isGeoPoint } from '../../../src/geoDistance.js';
import { boundsOf } from '../../../src/intel/clustering.js';

const PACK = (name) =>
  fileURLToPath(
    new URL(
      `../../../src/data/local_data/natural_earth/${name}.json`,
      import.meta.url,
    ),
  );
const HOME_RADIUS_KM = 3000;

let cache = null;

const r3 = (v) => Math.round(v * 1000) / 1000;
const rounded = (b) => ({
  west: r3(b.west),
  south: r3(b.south),
  east: r3(b.east),
  north: r3(b.north),
});

/** Midpoint of a box along its own (possibly antimeridian-crossing) span. */
const centerOf = (b) => {
  const span = b.west <= b.east ? b.east - b.west : b.east + 360 - b.west;
  let lon = b.west + span / 2;
  if (lon > 180) lon -= 360;
  return { lat: (b.south + b.north) / 2, lon };
};

/** Bounds of the polygon nearest-and-largest set of a feature. */
function homeBounds(feature, decimals) {
  const parts = (feature.polygons ?? [])
    .map((polygon) => {
      const points = decodeRing(polygon[0] ?? [], decimals).map(
        ([lon, lat]) => ({ lat, lon }),
      );
      const b = boundsOf(points);
      if (!b) return null;
      const area =
        b.lon_span_deg *
        (b.north - b.south) *
        Math.cos((((b.north + b.south) / 2) * Math.PI) / 180);
      return { points, center: centerOf(b), area };
    })
    // A few tiny map units decode to no valid ring; they have no extent.
    .filter((part) => part && isGeoPoint(part.center));
  if (!parts.length) return null;
  const main = parts.reduce((a, b) => (b.area > a.area ? b : a));
  const home = parts.filter(
    (part) => greatCircleKm(part.center, main.center) <= HOME_RADIUS_KM,
  );
  return rounded(boundsOf(home.flatMap((part) => part.points)));
}

const normalize = (text) =>
  String(text ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

function load() {
  if (cache) return cache;
  const countries = JSON.parse(fs.readFileSync(PACK('countries'), 'utf8'));
  const states = JSON.parse(fs.readFileSync(PACK('states_provinces'), 'utf8'));
  const decimals = countries.meta?.decimals ?? 3;
  // Map units share a code (England, Scotland... are GB): the sovereign
  // `Country` unit with the most parts is the country.
  const mainUnit = new Map();
  for (const feature of countries.features) {
    if (!/^[A-Z]{2}$/.test(feature.iso2 ?? '')) continue;
    const held = mainUnit.get(feature.iso2);
    const rank = (f) =>
      (f.type === 'Country' ? 1e6 : 0) + (f.polygons?.length ?? 0);
    if (!held || rank(feature) > rank(held))
      mainUnit.set(feature.iso2, feature);
  }
  const byIso2 = new Map();
  for (const [iso2, feature] of mainUnit) {
    const bounds = homeBounds(feature, decimals);
    if (bounds)
      byIso2.set(iso2, { name: feature.name, bounds, point: centerOf(bounds) });
  }
  const iso3To2 = new Map();
  const names = []; // [normalized name, iso2], longest first
  for (const feature of countries.features) {
    if (!byIso2.has(feature.iso2)) continue;
    if (feature.iso) iso3To2.set(feature.iso, feature.iso2);
    for (const name of [feature.name, feature.country, ...(feature.alt ?? [])])
      if (name && normalize(name).length >= 4)
        names.push([normalize(name), feature.iso2]);
  }
  names.sort((a, b) => b[0].length - a[0].length);
  const usStates = new Map();
  for (const feature of states.features)
    if (feature.iso2 === 'US' && feature.postal) {
      const bounds = homeBounds(feature, states.meta?.decimals ?? 3);
      if (bounds) usStates.set(feature.postal, bounds);
    }
  cache = { byIso2, iso3To2, names, usStates };
  return cache;
}

/** ISO 3166 alpha-2 for an alpha-2 or alpha-3 code, else null. */
export function iso2Of(code) {
  const value = String(code ?? '').toUpperCase();
  const { byIso2, iso3To2 } = load();
  if (byIso2.has(value)) return value;
  return iso3To2.get(value) ?? null;
}

/** Home-territory bounds of a country (alpha-2 or alpha-3), or null. */
export function countryBounds(code) {
  const iso2 = iso2Of(code);
  return iso2 ? (load().byIso2.get(iso2)?.bounds ?? null) : null;
}

/** Country-level marker position (centre of its home territory), or null. */
export function countryPoint(code) {
  const iso2 = iso2Of(code);
  const point = iso2 ? load().byIso2.get(iso2)?.point : null;
  return point ? { lat: r3(point.lat), lon: r3(point.lon) } : null;
}

/** English short name of a country, or null. */
export function countryName(code) {
  const iso2 = iso2Of(code);
  return iso2 ? (load().byIso2.get(iso2)?.name ?? null) : null;
}

/** Bounds of a US state by postal code, or null. */
export function usStateBounds(postal) {
  return load().usStates.get(String(postal ?? '').toUpperCase()) ?? null;
}

/** The smallest box covering several boxes (antimeridian-aware). */
export function unionBounds(boxes) {
  const corners = boxes.filter(Boolean).flatMap((b) => [
    { lat: b.south, lon: b.west },
    { lat: b.north, lon: b.east },
  ]);
  const b = boundsOf(corners);
  return b ? rounded(b) : null;
}

/** Centre of a box (antimeridian-aware), or null. */
export function boundsCenter(b) {
  const point = b ? centerOf(b) : null;
  return point ? { lat: r3(point.lat), lon: r3(point.lon) } : null;
}

/** Countries named in free text (whole words; longest names first). */
export function countriesInText(text) {
  let haystack = ` ${normalize(text)} `;
  const found = [];
  for (const [name, iso2] of load().names) {
    const needle = ` ${name} `;
    if (!haystack.includes(needle)) continue;
    if (!found.includes(iso2)) found.push(iso2);
    haystack = haystack.split(needle).join(' '); // "DR Congo" must not also count as "Congo"
  }
  return found;
}
