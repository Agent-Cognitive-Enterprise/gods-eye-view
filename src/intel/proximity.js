// Personal relevance: how close an event is to the places the operator cares
// about (Home, Family, Travel, Custom). Proximity raises attention only; it
// never changes confidence or verification (being near does not make a report
// more reliable), and it never lowers anything, so a major event on another
// continent keeps its own score. Pure and portable.

import { greatCircleKm } from '../geoDistance.js';

export const PLACE_LABELS = Object.freeze([
  'home',
  'family',
  'travel',
  'custom',
]);

// How far a location can be trusted for a distance: a country-level report
// "near" home says little about home.
const PRECISION_TRUST = Object.freeze({
  exact: 1,
  point: 1,
  city: 1,
  region: 0.75,
  country: 0.5,
  unresolved: 0,
});

/**
 * Boost weight at `distanceKm`: 1 at 0 km, exactly 0 at `radiusKm` and
 * beyond, decaying exponentially with length `decayKm` in between.
 *   W(d) = (e^(−d/L) − e^(−R/L)) / (1 − e^(−R/L)),  d < R
 */
export function proximityWeight(distanceKm, { radiusKm, decayKm }) {
  if (!(distanceKm >= 0) || !(radiusKm > 0) || !(decayKm > 0)) return 0;
  if (distanceKm >= radiusKm) return 0;
  const floor = Math.exp(-radiusKm / decayKm);
  return (Math.exp(-distanceKm / decayKm) - floor) / (1 - floor);
}

/** P_final = P + (1 − P) · W, on a 0–100 attention scale. */
export const boostAttention = (attention, weight) =>
  attention + (100 - attention) * Math.min(1, Math.max(0, weight));

// An area at most this big (half its diagonal) is measured to its nearest
// edge; a larger one (a whole US state, a country) to its centre, since the
// event is somewhere in it, not everywhere.
const SMALL_AREA_KM = 100;

/** The point of `bounds` nearest to `place` (home inside → the place itself). */
function nearestInBounds(place, b) {
  const lat = Math.min(b.north, Math.max(b.south, place.lat));
  const wraps = b.west > b.east; // crosses the antimeridian
  const inside = wraps
    ? place.lon >= b.west || place.lon <= b.east
    : place.lon >= b.west && place.lon <= b.east;
  if (inside) return { lat, lon: place.lon };
  const toWest = greatCircleKm(place, { lat, lon: b.west });
  const toEast = greatCircleKm(place, { lat, lon: b.east });
  return { lat, lon: toWest <= toEast ? b.west : b.east };
}

/**
 * Closest configured place to an event and the resulting boost weight.
 * @returns {{place: string, km: number, weight: number} | null}
 */
export function eventProximity(event, settings = {}) {
  const places = settings.homeLocations ?? [];
  if (settings.proximityEnabled === false || !places.length) return null;
  const location = event.location ?? {};
  const trust = PRECISION_TRUST[location.precision] ?? 1;
  if (!trust) return null;
  const point =
    Number.isFinite(location.lat) && Number.isFinite(location.lon)
      ? { lat: location.lat, lon: location.lon }
      : null;
  let best = null;
  const b = location.bounds;
  const small =
    b &&
    greatCircleKm(
      { lat: b.south, lon: b.west },
      { lat: b.north, lon: b.east },
    ) /
      2 <=
      SMALL_AREA_KM;
  const centre =
    point ??
    (b
      ? {
          lat: (b.south + b.north) / 2,
          lon:
            b.west <= b.east
              ? (b.west + b.east) / 2
              : (((b.west + b.east + 360) / 2 + 180) % 360) - 180,
        }
      : null);
  for (const place of places) {
    const target = small ? nearestInBounds(place, b) : centre;
    if (!target) continue;
    const km = greatCircleKm(place, target);
    if (!best || km < best.km) best = { place: place.label, km };
  }
  if (!best) return null;
  const weight =
    trust *
    proximityWeight(best.km, {
      radiusKm: settings.proximityRadiusKm ?? 1000,
      decayKm: settings.proximityDecayKm ?? 400,
    });
  return { place: best.place, km: Math.round(best.km), weight };
}
