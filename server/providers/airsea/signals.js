// Air/sea signals for the early-warning Autopilot (fork feature). Turns the
// Air & Sea results into intel records, and only the qualified ones:
//
//  - a warning area whose traffic changed more than around it
//    (WARNING_TRAFFIC_CORRELATION): one event per warning, made of the
//    official warning and the traffic measurement, so the card carries both
//    receipts and the official source;
//  - a severe aviation or maritime warning (danger / restricted) on its own
//    (AIRSPACE_WARNING / MARITIME_WARNING), never TRIAL data, never marine
//    weather (those come in only with a measured traffic change);
//  - clusters of traffic anomalies (AIR/SEA_TRAFFIC_ANOMALY) once a matched
//    baseline exists.
//
// Records keep a stable content (changes rounded to tens of percent, no
// clock times in the text), so a repeat poll is a duplicate, not a new
// revision, and one situation stays one event (stable event keys).

import { cellToParent, gridDisk } from 'h3-js';
import { WARNING_SOURCES } from './warnings.js';
import { cellRing } from '../../../src/airsea/aggregate.js';

const HOUR = 3600_000;
const PROVIDER = 'airsea';
const ANALYSIS = "God's Eye View traffic analysis";
const TRAFFIC_ATTRIBUTION = Object.freeze({
  air: 'Aircraft positions: OpenSky Network; adsb.lol (ODbL)',
  sea: 'Vessel positions: AISStream.io',
});
const WARNING_SEVERITY_HINT = Object.freeze({
  danger: 55,
  restricted: 45,
  caution: 35,
  advisory: 25,
});
// A pre-warning reference has no seasonal control: only large changes.
const MIN_PRE_WARNING_CHANGE = 60;
const tens = (pct) => Math.round(pct / 10) * 10;
const signed = (pct) => `${pct > 0 ? '+' : ''}${pct}%`;

/** Centre of [west, south, east, north]; west > east crosses the antimeridian. */
export function boxCentre([west, south, east, north]) {
  const span = west <= east ? east - west : east + 360 - west;
  let lon = west + span / 2;
  if (lon > 180) lon -= 360;
  return { lat: (south + north) / 2, lon };
}

/**
 * Location precision from the size of the area: the Autopilot frames a lone
 * event from a height set by its precision, so this keeps the whole area in
 * view without showing a small zone from orbit.
 */
export function precisionForBox([west, south, east, north]) {
  const midLat = ((south + north) / 2) * (Math.PI / 180);
  const width = (west <= east ? east - west : east + 360 - west) * 111.32;
  const km = Math.hypot(width * Math.cos(midLat), (north - south) * 110.57);
  return km < 120 ? 'city' : km < 900 ? 'region' : 'country';
}

const boundsObject = (b) =>
  b ? { west: b[0], south: b[1], east: b[2], north: b[3] } : undefined;

function warningLocation(warning) {
  if (!Array.isArray(warning.bounds)) return null;
  return {
    ...boxCentre(warning.bounds),
    precision: precisionForBox(warning.bounds),
    geolocation_status: 'verified',
    place: String(warning.title ?? '').slice(0, 120),
    bounds: boundsObject(warning.bounds),
  };
}

/**
 * The official warning as an observation (relayed, not re-authored). With
 * `paired`, it is filed beside a traffic measurement: the measurement then
 * supplies the summary and the severity (engine report families).
 */
export function warningRecord(warning, { paired = false } = {}) {
  const location = warningLocation(warning);
  if (!location || warning.trial) return null;
  const source = WARNING_SOURCES.find((s) => s.id === warning.sourceId);
  return {
    provider: PROVIDER,
    source_item_id: `warning:${warning.id}`,
    event_key: `warning:${warning.id}`,
    publisher: warning.authority || source?.title || 'Warning authority',
    source_type: 'primary_official',
    url: warning.sourceUrl,
    license: source?.licence ?? null,
    attribution: source?.title ?? null,
    language: 'en',
    category: 'infrastructure_disruption',
    subtype:
      warning.domain === 'aviation' ? 'airspace_warning' : 'maritime_warning',
    title: warning.title,
    summary: paired
      ? ''
      : [
          warning.warningType,
          `${warning.severity} warning`,
          warning.effectiveUntilUtc
            ? `effective ${warning.effectiveFromUtc ?? '?'} to ${warning.effectiveUntilUtc}`
            : null,
          'For situational awareness only; not for navigation.',
        ]
          .filter(Boolean)
          .join(' — '),
    occurred_at: warning.effectiveFromUtc ?? warning.publishedAtUtc,
    published_at: warning.publishedAtUtc,
    valid_until: warning.effectiveUntilUtc ?? undefined,
    location,
    metrics: {
      severity_hint: paired
        ? undefined
        : (WARNING_SEVERITY_HINT[warning.severity] ?? 25),
      warning_severity: warning.severity,
      warning_domain: warning.domain,
    },
    status_hint:
      warning.status === 'cancelled' || warning.status === 'expired'
        ? 'resolved'
        : 'warning',
  };
}

/** Is a correlation strong and clean enough for the Autopilot queue? */
export function qualifies(correlation) {
  if (
    correlation.observation !== 'possible_traffic_suppression' &&
    correlation.observation !== 'possible_traffic_increase'
  )
    return false;
  if (correlation.coverageQuality !== 'adequate') return false;
  if (
    correlation.reference === 'pre_warning' &&
    Math.abs(correlation.changePct) < MIN_PRE_WARNING_CHANGE
  )
    return false;
  return true;
}

/** Plain-language evidence for the card; template text, facts filled in. */
export function correlationSummary(c) {
  const what = c.domain === 'air' ? 'Aircraft' : 'Vessel';
  if (c.observation === 'inconclusive')
    return `${what} traffic through the area cannot be judged now (${
      c.coverageQuality === 'degraded'
        ? 'the feed delivered too little'
        : 'not enough comparable traffic'
    }). Association is not confirmed.`;
  if (c.observation === 'no_material_change')
    return `${what} traffic through the area is now within its usual range (${signed(
      tens(c.changePct ?? 0),
    )} against ${
      c.reference === 'matched_baseline'
        ? 'the same hours in earlier weeks'
        : 'the hours before the warning'
    }). Association is not confirmed.`;
  const change = tens(c.changePct);
  const parts = [
    `${what} passages through the area are ${Math.abs(change)}% ${
      change < 0 ? 'below' : 'above'
    } ${
      c.reference === 'matched_baseline'
        ? `the same hours in the past ${c.baselineWeeks} weeks`
        : 'the hours just before the warning (no seasonal baseline yet)'
    }.`,
  ];
  if (c.surroundingChangePct !== null)
    parts.push(
      `The surrounding ring changed ${signed(tens(c.surroundingChangePct))}.`,
    );
  if (c.corroboratingSignals.includes('adjacent_corridor_increase'))
    parts.push('Traffic nearby rose: possible rerouting.');
  parts.push('Feed coverage adequate.');
  parts.push(`Confidence ${c.confidence}. Association is not confirmed.`);
  return parts.join(' ');
}

/** The traffic measurement for one warning (an analysis, not a report). */
export function correlationRecord(correlation, warning) {
  const location = warningLocation(warning);
  if (!location) return null;
  const change = tens(correlation.changePct ?? 0);
  const what = correlation.domain === 'air' ? 'Aircraft' : 'Vessel';
  let severity =
    35 +
    Math.min(25, Math.abs(change) / 4) +
    (correlation.corroboratingSignals.length ? 5 : 0);
  if (correlation.confidence === 'high') severity += 5;
  if (correlation.reference === 'pre_warning')
    severity = Math.min(45, severity);
  // A followed warning whose traffic is back to normal (or cannot be read).
  if (!qualifies(correlation)) severity = 25;
  return {
    provider: PROVIDER,
    source_item_id: `traffic:${warning.id}:${correlation.domain}`,
    event_key: `warning:${warning.id}`,
    publisher: ANALYSIS,
    source_type: 'analyst',
    url: null,
    license: 'Derived locally from public position feeds',
    attribution: TRAFFIC_ATTRIBUTION[correlation.domain],
    language: 'en',
    category: 'infrastructure_disruption',
    subtype: 'warning_traffic_correlation',
    title: qualifies(correlation)
      ? `${what} traffic ${signed(change)} in ${warning.title}`.slice(0, 200)
      : `${what} traffic in ${warning.title}`.slice(0, 200),
    summary: correlationSummary(correlation),
    occurred_at: warning.effectiveFromUtc ?? warning.publishedAtUtc,
    // News is the measurement, not the warning: dated by its window's end.
    published_at: correlation.observedThroughUtc ?? warning.publishedAtUtc,
    valid_until: warning.effectiveUntilUtc ?? undefined,
    location,
    metrics: {
      severity_hint: Math.round(severity),
      change_pct: correlation.changePct === null ? undefined : change,
      surrounding_change_pct:
        correlation.surroundingChangePct === null
          ? undefined
          : tens(correlation.surroundingChangePct),
      observation: correlation.observation,
      reference: correlation.reference,
      baseline_weeks: correlation.baselineWeeks,
      coverage_quality: correlation.coverageQuality,
      traffic_confidence: correlation.confidence,
      rerouting: correlation.corroboratingSignals.includes(
        'adjacent_corridor_increase',
      ),
      cause_assessment: 'unconfirmed',
    },
  };
}

/** Adjacent anomalous cells of one kind, as groups. */
export function anomalyClusters(cells) {
  const left = new Map(cells.map((c) => [c.cell ?? c.h3, c]));
  const groups = [];
  for (const [id, first] of left) {
    left.delete(id);
    const group = [first];
    const queue = [id];
    while (queue.length) {
      for (const n of gridDisk(queue.pop(), 1)) {
        const next = left.get(n);
        if (next && next.observation === first.observation) {
          left.delete(n);
          group.push(next);
          queue.push(n);
        }
      }
    }
    groups.push(group);
  }
  return groups;
}

function clusterBounds(group) {
  const points = group.flatMap((c) => cellRing(c.cell ?? c.h3) ?? []);
  if (!points.length) return null;
  const lats = points.map(([, lat]) => lat);
  // Rings near the antimeridian already use longitudes beyond 180.
  const lons = points.map(([lon]) => lon);
  const wrap = (lon) => (lon > 180 ? lon - 360 : lon);
  return [
    wrap(Math.min(...lons)),
    Math.min(...lats),
    wrap(Math.max(...lons)),
    Math.max(...lats),
  ];
}

/** Anomaly clusters worth a queue entry: several cells, or one solid one. */
export function anomalyRecords(answer) {
  if (answer?.status !== 'ok') return [];
  const out = [];
  for (const group of anomalyClusters(answer.cells)) {
    const solid = group.some((c) => c.confidence !== 'low');
    if (group.length < 2 && !solid) continue;
    const bounds = clusterBounds(group);
    if (!bounds) continue;
    const kind = group[0].observation;
    const drop = kind === 'possible_traffic_suppression';
    const anchor = group.map((c) => c.cell ?? c.h3).sort()[0];
    const region = cellToParent(anchor, 0);
    const current = group.reduce((s, c) => s + c.current, 0);
    const baseline = group.reduce((s, c) => s + c.baseline, 0);
    const change = tens(((current - baseline) / baseline) * 100);
    const what = answer.domain === 'air' ? 'air' : 'sea';
    out.push({
      provider: PROVIDER,
      source_item_id: `anomaly:${answer.domain}:${kind}:${region}`,
      event_key: `anomaly:${answer.domain}:${kind}:${region}`,
      publisher: ANALYSIS,
      source_type: 'analyst',
      url: null,
      license: 'Derived locally from public position feeds',
      attribution: TRAFFIC_ATTRIBUTION[answer.domain],
      language: 'en',
      category: 'infrastructure_disruption',
      subtype: `${what}_traffic_anomaly`,
      title: `Possible ${drop ? 'drop' : 'rise'} in ${what} traffic (${group.length} cells, ${signed(change)})`,
      summary: `${current} passages in the last complete hour against a usual ${baseline} for this hour of the week (${answer.weeksUsed} comparable weeks; confidence ${answer.confidence}). Feed coverage adequate. Cause unknown.`,
      occurred_at: answer.hour_start,
      published_at: answer.hour_start + HOUR,
      // Gone unless the next hours repeat it.
      valid_until: answer.hour_start + 4 * HOUR,
      location: {
        ...boxCentre(bounds),
        precision: precisionForBox(bounds),
        geolocation_status: 'verified',
        bounds: boundsObject(bounds),
      },
      metrics: {
        severity_hint: Math.round(30 + Math.min(15, Math.abs(change) / 6)),
        change_pct: change,
        cells: group.length,
        baseline_weeks: answer.weeksUsed,
        traffic_confidence: answer.confidence,
        cause_assessment: 'unknown',
      },
    });
  }
  return out;
}

/**
 * Every qualified record now. `service`: the air/sea service (correlations,
 * anomalies); `warnings`: the warning service (list), or null; `followed`:
 * warnings already sent, whose measurement keeps being refreshed (back to
 * normal, inconclusive) while they stay active, so the card never goes stale.
 */
export function airSeaRecords({ service, warnings, followed = new Set() }) {
  const listed = warnings?.list() ?? [];
  const byId = new Map(listed.map((w) => [w.id, w]));
  const records = [];
  const sent = new Set();
  for (const correlation of service.correlations?.(listed) ?? []) {
    const id = correlation.warningId;
    if (!qualifies(correlation) && !followed.has(id)) continue;
    const warning = byId.get(id);
    const official = warningRecord(warning, { paired: true });
    const measured = correlationRecord(correlation, warning);
    if (!official || !measured) continue;
    records.push(measured, official);
    sent.add(id);
  }
  // Forget warnings no longer active.
  for (const id of followed) if (!sent.has(id)) followed.delete(id);
  for (const id of sent) followed.add(id);
  for (const warning of listed) {
    if (sent.has(warning.id) || warning.trial) continue;
    if (warning.domain === 'marine_weather' || warning.status !== 'active')
      continue;
    if (warning.severity !== 'danger' && warning.severity !== 'restricted')
      continue;
    const record = warningRecord(warning);
    if (record) records.push(record);
  }
  for (const domain of ['air', 'sea'])
    if (service.anomalies)
      records.push(...anomalyRecords(service.anomalies({ domain })));
  return records;
}

/**
 * The meeting point of the two server plugins: the air/sea plugin attaches
 * its services when it starts; the intel connector reads through it.
 */
export function createAirSeaHub() {
  let attached = null;
  const followed = new Set();
  const waiting = new Set();
  return {
    attach(services) {
      attached = services;
      for (const resolve of waiting) resolve(true);
      waiting.clear();
      return () => {
        if (attached === services) attached = null;
      };
    },
    ready: () => Boolean(attached?.service),
    /** Resolves true once attached, or false after `ms`. */
    whenReady(ms = 60_000) {
      if (attached?.service) return Promise.resolve(true);
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          waiting.delete(done);
          resolve(false);
        }, ms);
        timer.unref?.();
        const done = (value) => {
          clearTimeout(timer);
          resolve(value);
        };
        waiting.add(done);
      });
    },
    records() {
      return attached?.service ? airSeaRecords({ ...attached, followed }) : [];
    },
  };
}
