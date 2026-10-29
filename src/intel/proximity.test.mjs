import test from 'node:test';
import assert from 'node:assert/strict';
import {
  boostAttention,
  eventProximity,
  proximityWeight,
} from './proximity.js';
import { scoreEvent } from './scoring.js';

const curve = { radiusKm: 1000, decayKm: 400 };
const near = (lat, lon, precision = 'city') => ({ lat, lon, precision });

test('proximity: the exponential boost matches the agreed table', () => {
  // P = 0.33 → 1.000, 0.661, 0.479, 0.382, 0.330 at 0/250/500/750/1000 km.
  const at = (km) => boostAttention(33, proximityWeight(km, curve)) / 100;
  assert.equal(at(0), 1);
  assert.equal(at(250).toFixed(3), '0.661');
  assert.equal(at(500).toFixed(3), '0.479');
  assert.equal(at(750).toFixed(3), '0.382');
  assert.equal(at(1000), 0.33);
  assert.equal(at(1500), 0.33, 'no change beyond the radius');
  // Continuous at the boundary: no sudden jump just inside it.
  assert.ok(at(999) - 0.33 < 0.001);
  assert.equal(proximityWeight(-5, curve), 0);
  assert.equal(proximityWeight(10, { radiusKm: 0, decayKm: 400 }), 0);
});

const home = { label: 'home', lat: -33.87, lon: 151.21 }; // Sydney
const family = { label: 'family', lat: 52.37, lon: 4.9 }; // Amsterdam
const settings = { homeLocations: [home, family] };

test('proximity: the nearest place wins; imprecise locations count for less', () => {
  const amsterdam = eventProximity({ location: near(52.1, 5.1) }, settings);
  assert.equal(amsterdam.place, 'family');
  assert.ok(amsterdam.km < 40 && amsterdam.weight > 0.9);
  const country = eventProximity(
    { location: near(52.1, 5.1, 'country') },
    settings,
  );
  assert.ok(Math.abs(country.weight - amsterdam.weight / 2) < 1e-9);
  assert.equal(
    eventProximity({ location: near(0, 0, 'unresolved') }, settings),
    null,
  );
  assert.equal(eventProximity({ location: near(52.1, 5.1) }, {}), null);
  assert.equal(
    eventProximity(
      { location: near(52.1, 5.1) },
      { ...settings, proximityEnabled: false },
    ),
    null,
  );
});

test('proximity: a small area containing a place is at distance 0; a large one counts from its centre', () => {
  const area = (bounds) => ({
    location: { lat: null, lon: null, precision: 'region', bounds },
  });
  const travel = { homeLocations: [{ label: 'travel', lat: -35, lon: 179.9 }] };
  // A storm-warning polygon around the place, across the antimeridian.
  const polygon = area({
    west: 179.5,
    east: -179.5,
    south: -35.4,
    north: -34.6,
  });
  const inside = eventProximity(polygon, travel);
  assert.equal(inside.km, 0);
  assert.equal(inside.weight, 0.75);
  // A statewide alert: "somewhere in this state", measured to the middle.
  const texas = area({
    west: -106.66,
    south: 25.84,
    east: -93.52,
    north: 36.5,
  });
  const houston = eventProximity(texas, {
    homeLocations: [{ label: 'home', lat: 29.76, lon: -95.37 }],
  });
  assert.ok(houston.km > 400 && houston.km < 700, String(houston.km));
  assert.ok(houston.weight < 0.3);
  // Centre of a box across the antimeridian is near 180°, not 0°.
  const pacific = eventProximity(
    area({ west: 170, east: -170, south: -40, north: -30 }),
    { homeLocations: [{ label: 'travel', lat: -35, lon: 180 }] },
  );
  assert.equal(pacific.km, 0);
});

const report = (lat, lon, extra = {}) => ({
  category: 'civil_unrest',
  revision: 1,
  status_hint: null,
  first_seen_at: Date.UTC(2026, 9, 30),
  last_meaningful_update_at: Date.UTC(2026, 9, 30),
  metrics: { severity_hint: 40 },
  location: near(lat, lon),
  lineages: [{ source_type: 'analyst', publisher: 'S2' }],
  official: false,
  time_zone_known: true,
  severity_history: [],
  ...extra,
});
const NOW = Date.UTC(2026, 9, 30, 0, 30);

test('proximity raises attention, never confidence, and never demotes a distant event', () => {
  const plain = scoreEvent(report(-33.9, 151.1), NOW, {});
  const boosted = scoreEvent(report(-33.9, 151.1), NOW, settings);
  assert.ok(boosted.attention_score > plain.attention_score + 30);
  assert.equal(boosted.base_attention_score, plain.attention_score);
  assert.equal(boosted.confidence, plain.confidence, 'nearby is not reliable');
  assert.equal(boosted.verification, plain.verification);
  assert.equal(boosted.proximity.place, 'home');
  const far = scoreEvent(report(40.7, -74), NOW, settings); // New York
  assert.equal(
    far.attention_score,
    scoreEvent(report(40.7, -74), NOW, {}).attention_score,
  );
  assert.equal(far.proximity.weight, 0);
});

test('proximity alone never reaches a critical interruption', () => {
  const official = report(-33.9, 151.1, {
    metrics: { severity_hint: 60 },
    lineages: [{ source_type: 'primary_official', publisher: 'NWS' }],
    official: true,
  });
  const boosted = scoreEvent(official, NOW, settings);
  assert.equal(boosted.attention_score, 94, 'held one below critical (95)');
  assert.ok(boosted.base_attention_score < 95);
});
