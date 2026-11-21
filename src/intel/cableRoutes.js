// Fork: which cable routes the Autopilot globe highlights, and their lines.
// Pure: the console draws them (src/ui/intelConsole.js). A route is drawn
// only for an event from the cable feed (src/intel/cableEvents.js), so only
// for an incident an operator or regulator confirmed about its own cable.

import { isCableSubtype } from './taxonomy.js';

const CABLE_ENTITY = /^cable:([a-z0-9][a-z0-9-]{0,119})$/;

/**
 * Cables to highlight now, by catalogue id: {opacity, resolved} for each
 * cable with a shown cable event. An archived or retracted event shows
 * nothing; a resolved one is shown dimmed until it archives.
 */
export function cableRouteTargets(events) {
  const out = new Map();
  for (const event of events ?? []) {
    if (!isCableSubtype(event?.subtype)) continue;
    if (!(event.providers ?? []).includes('cables')) continue;
    if (['archived', 'retracted'].includes(event.lifecycle)) continue;
    // In steps of 0.05: a fade redraws the route a few times, not every tick.
    const opacity =
      Math.round(Math.max(0, Math.min(1, event.opacity ?? 1)) * 20) / 20;
    if (opacity <= 0) continue;
    for (const entity of event.entities ?? []) {
      const id = CABLE_ENTITY.exec(String(entity))?.[1];
      if (!id) continue;
      const resolved = event.verification === 'resolved';
      const held = out.get(id);
      // Two events on one cable: an open one wins over a resolved one.
      if (
        !held ||
        (held.resolved && !resolved) ||
        (held.resolved === resolved && held.opacity < opacity)
      )
        out.set(id, { opacity, resolved });
    }
  }
  return out;
}

const isPoint = (p) =>
  Array.isArray(p) &&
  Number.isFinite(p[0]) &&
  Number.isFinite(p[1]) &&
  Math.abs(p[0]) <= 180 &&
  Math.abs(p[1]) <= 90;

/**
 * The catalogue route of one cable as lines of [lon, lat], split where a
 * line jumps across the antimeridian, so no line is drawn round the globe.
 */
export function routeLines(feature) {
  const geometry = feature?.geometry;
  const lines =
    geometry?.type === 'LineString'
      ? [geometry.coordinates]
      : geometry?.type === 'MultiLineString'
        ? geometry.coordinates
        : [];
  const out = [];
  for (const line of lines) {
    let current = [];
    for (const point of line ?? []) {
      if (!isPoint(point)) continue;
      const last = current.at(-1);
      if (last && Math.abs(point[0] - last[0]) > 180) {
        if (current.length > 1) out.push(current);
        current = [];
      }
      current.push([point[0], point[1]]);
    }
    if (current.length > 1) out.push(current);
  }
  return out;
}

/**
 * One feature per catalogue id: a few cables are listed as two features,
 * whose lines are joined into one MultiLineString.
 */
export function mergedCableFeatures(collection) {
  const out = new Map();
  for (const feature of collection?.features ?? []) {
    const id = feature?.properties?.id;
    if (typeof id !== 'string' || !id) continue;
    const geometry = feature.geometry;
    const lines =
      geometry?.type === 'LineString'
        ? [geometry.coordinates]
        : geometry?.type === 'MultiLineString'
          ? geometry.coordinates
          : [];
    const held = out.get(id);
    if (held) held.geometry.coordinates.push(...lines);
    else
      out.set(id, {
        type: 'Feature',
        properties: feature.properties,
        geometry: { type: 'MultiLineString', coordinates: [...lines] },
      });
  }
  return out;
}

/** Catalogue id → route lines, for the cables in a catalogue collection. */
export function cableRouteIndex(collection) {
  const out = new Map();
  for (const [id, feature] of mergedCableFeatures(collection)) {
    const lines = routeLines(feature);
    if (lines.length) out.set(id, lines);
  }
  return out;
}

// An entity is cut to 80 characters, so a cable id over 74 arrives cut.
const ENTITY_ID_MAX = 80 - 'cable:'.length;

/** The route for a cable id from an entity, also when the id was cut. */
export function routeFor(index, id) {
  if (index?.has(id)) return index.get(id);
  if (!index || String(id).length < ENTITY_ID_MAX) return null;
  const found = [...index.keys()].filter((key) => key.startsWith(id));
  return found.length === 1 ? index.get(found[0]) : null;
}
