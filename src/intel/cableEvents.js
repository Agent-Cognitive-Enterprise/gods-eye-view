// Phase 3 of the automatic cable signals: confirmed cable incidents become
// Autopilot records. Pure: no fetching, no clock, no files.
//
// Only an incident opened by a confirmed signal reaches the engine: a clear
// title from an operator or regulator about its own cable, or a local-model
// answer that passed every check (`llm-clear`). A news report never does,
// whatever the model says: news is logged as `llm-unverified` and stays in
// the shadow log. One record goes out each time what an operator would see
// changes: the incident opens, gets a new report, is confirmed broken, or
// closes on a repair notice. An incident with no report for 30 days fades
// by itself through `valid_until`, so nothing is sent for a fade.

import { impactSentence } from './cableImpact.js';
import { FAULT_FADE_MS } from './cableSignals.js';

export const CABLE_EVENT_PROVIDER = 'cables';

/** The catalogue route of one cable as [[lon, lat], …] lines. */
function linesOf(feature) {
  const geometry = feature?.geometry;
  if (geometry?.type === 'LineString') return [geometry.coordinates];
  if (geometry?.type === 'MultiLineString') return geometry.coordinates;
  return [];
}

const isPoint = (p) =>
  Array.isArray(p) &&
  Number.isFinite(p[0]) &&
  Number.isFinite(p[1]) &&
  Math.abs(p[0]) <= 180 &&
  Math.abs(p[1]) <= 90;

/**
 * Where the marker for a cable goes: the middle point of its catalogue line
 * with the most points, as {lat, lon}, or null when it has no route.
 */
export function representativePoint(feature) {
  let best = null;
  for (const line of linesOf(feature)) {
    const points = (line ?? []).filter(isPoint);
    if (points.length && (!best || points.length > best.length)) best = points;
  }
  if (!best) return null;
  const [lon, lat] = best[Math.floor(best.length / 2)];
  return { lat, lon };
}

/** What an operator would see of an incident; a change means a new record. */
export function publishKey(incident, impact = []) {
  return JSON.stringify([
    incident.status,
    incident.lastReportedAt ?? null,
    incident.closedAt ?? null,
    Boolean(incident.breakConfirmed),
    incident.sources?.length ?? 0,
    // Phase 4: the country outages beside it (an open incident only).
    ...(incident.status === 'open' && impact.length
      ? [impact.map((entry) => [entry.country, entry.start])]
      : []),
  ]);
}

const dayOf = (iso) => String(iso ?? '').slice(0, 10);

/**
 * One Autopilot record for one incident, or null when it cannot be placed
 * or is not one to show. `feature` is the cable's catalogue entry and
 * `publisher` the name of the source that opened it.
 */
export function cableRecord({
  cableId,
  incident,
  feature,
  publisher,
  impact = [],
}) {
  const point = representativePoint(feature);
  const name = String(feature?.properties?.name ?? cableId);
  const opened = Date.parse(incident.openedAt ?? '');
  const id = incidentIdOf(incident);
  if (!point || !Number.isFinite(opened)) return null;
  const open = incident.status === 'open';
  const closed = incident.status === 'closed';
  if (!open && !closed) return null;
  const lastReported = Date.parse(incident.lastReportedAt ?? '');
  const closedAt = Date.parse(incident.closedAt ?? '');
  const reportedAt = closed ? closedAt : lastReported;
  if (!Number.isFinite(reportedAt)) return null;
  const broken = Boolean(incident.breakConfirmed);
  const by = publisher || 'the operator';
  const title = closed
    ? `${name} submarine cable repaired, ${by} reports`
    : broken
      ? `${name} submarine cable cut, ${by} reports`
      : `${name} submarine cable fault, ${by} reports`;
  const summary = closed
    ? `Repair reported on ${dayOf(incident.closedAt)}. The fault was first reported on ${dayOf(incident.openedAt)}.`
    : `${impactSentence(impact)}First reported on ${dayOf(incident.openedAt)}, last reported on ${dayOf(incident.lastReportedAt)}.${broken ? ' The source confirms a physical break.' : ' A fault does not by itself mean the cable is cut.'}`;
  const url = incident.sources?.at(-1) ?? null;
  return {
    provider: CABLE_EVENT_PROVIDER,
    source_item_id: `${cableId}:${id}:${publishKey(incident, impact)}`,
    // One incident, one event: every update joins it.
    event_key: `submarine-cable:${cableId}:${id}`,
    lineage_key: `submarine-cable:${cableId}:${id}`,
    publisher: by,
    source_type: 'primary_official',
    url,
    license: "The publisher's own terms",
    attribution: by,
    language: 'en',
    category: 'infrastructure_disruption',
    subtype: broken ? 'submarine_cable_break' : 'submarine_cable_fault',
    title,
    summary,
    occurred_at: opened,
    published_at: reportedAt,
    // Notices give days, not times with a zone.
    time_zone_known: false,
    status_hint: closed ? 'resolved' : 'ongoing',
    // The marker stays while the incident is open, as the shadow incident
    // does: it fades 30 days after its last report.
    ...(open ? { valid_until: lastReported + FAULT_FADE_MS } : {}),
    location: {
      lat: point.lat,
      lon: point.lon,
      precision: 'region',
      geolocation_status: 'approximate',
      place: name,
    },
    entities: [`cable:${cableId}`],
  };
}

/** The incident's fixed id: set when it opened (older state: its start). */
export const incidentIdOf = (incident) =>
  incident?.incidentId ?? incident?.openedAt ?? null;

/**
 * The records the shadow incidents call for now, and what to remember once
 * they are stored. `published` maps a cable to what was last sent for it:
 * {key, incidentId, openedAt, lastReportedAt, status}. A repair is sent only
 * for the incident that was shown open: a repair notice for an incident no
 * one saw opens nothing. If the shadow state was lost (a corrupt file is
 * moved aside), a repair notice dated after the shown incident's last
 * report still closes it. `features` maps a cable to its catalogue entry,
 * `publisherOf` a source id to its name.
 */
export function liveRecords({
  incidents,
  published = {},
  features,
  publisherOf,
  // Phase 4: cable id → {incidentId, entries} (checkImpact), open only.
  impact = {},
}) {
  const records = [];
  const keys = {};
  const remember = (cableId, incident, status) => ({
    key: publishKey(incident),
    incidentId: incidentIdOf(incident),
    openedAt: incident.openedAt ?? null,
    lastReportedAt: incident.lastReportedAt ?? null,
    breakConfirmed: Boolean(incident.breakConfirmed),
    status,
  });
  // A repair counts only within the shown incident's life: by then an
  // incident with no report has faded, and so has its event.
  const inLife = (sent, closedAt) =>
    Date.parse(closedAt ?? '') <=
    Date.parse(sent.lastReportedAt ?? '') + FAULT_FADE_MS;
  for (const [cableId, incident] of Object.entries(incidents ?? {})) {
    const sent = published[cableId];
    // Only this incident's impact: a new incident on the cable starts bare.
    const held = impact[cableId];
    const seen =
      incident.status === 'open' &&
      held?.incidentId === incidentIdOf(incident) &&
      Array.isArray(held.entries)
        ? held.entries
        : [];
    if (sent?.key === publishKey(incident, seen)) continue;
    let shown = incident;
    if (incident.status === 'closed') {
      const own =
        sent?.status === 'open' &&
        incidentIdOf(incident) !== null &&
        sent.incidentId === incidentIdOf(incident) &&
        inLife(sent, incident.closedAt);
      // The state was lost: the repair is a marker with no incident.
      const recovered =
        sent?.status === 'open' &&
        !incident.openedAt &&
        Date.parse(incident.closedAt ?? '') >=
          Date.parse(sent.lastReportedAt ?? '') &&
        inLife(sent, incident.closedAt);
      if (!own && !recovered) {
        keys[cableId] = { ...sent, key: publishKey(incident) };
        continue;
      }
      if (recovered)
        shown = {
          ...incident,
          incidentId: sent.incidentId,
          openedAt: sent.openedAt,
          lastReportedAt: sent.lastReportedAt,
          breakConfirmed: Boolean(
            incident.breakConfirmed || sent.breakConfirmed,
          ),
        };
    } else if (incident.status !== 'open') {
      // Faded: its marker expires by itself through valid_until.
      keys[cableId] = remember(cableId, incident, incident.status);
      continue;
    }
    const record = cableRecord({
      cableId,
      incident: shown,
      feature: features.get(cableId),
      // A repair is the repairing source's word.
      publisher: publisherOf(
        incident.status === 'closed'
          ? (incident.closedBy ?? incident.sourceId)
          : incident.sourceId,
      ),
      impact: seen,
    });
    if (!record) continue;
    records.push(record);
    keys[cableId] = {
      ...remember(cableId, shown, incident.status),
      key: publishKey(incident, seen),
    };
  }
  return { records, keys };
}
