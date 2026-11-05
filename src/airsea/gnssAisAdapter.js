/** Strict, read-only AISStream position-envelope adapter for navigation integrity. */
// Fork: long-range broadcasts (type 27) are left out: their positions are
// coarse (1/10 minute) and may be held back, so they fake jumps.
const POSITION_TYPES = new Set([
  'PositionReport',
  'StandardClassBPositionReport',
  'ExtendedClassBPositionReport',
]);

/**
 * Fork: how far apart the report's own UTC second (`Timestamp`) and the second
 * of AISStream's `time_utc` may be. `time_utc` is not documented as the fix
 * time; a report relayed late carries an old second, so most delays show here.
 * Agreement is modulo a minute, so a delay of whole minutes still passes.
 */
export const TIMESTAMP_TOLERANCE_S = 15;

function epochMs(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  // AISStream uses e.g. "2026-11-05 00:00:00.000000 +0000 UTC".
  const canonical = raw
    .trim()
    .replace(/\s+\+0000\s+UTC$/i, 'Z')
    .replace(/\s+UTC$/i, 'Z')
    .replace(' ', 'T')
    .replace(/(\.\d{3})\d+(?=Z$)/, '$1');
  if (!/(?:Z|[+-]\d\d:\d\d)$/.test(canonical)) return null;
  const parsed = Date.parse(canonical);
  return Number.isFinite(parsed) ? parsed : null;
}

const number = (value) => {
  if (value == null) return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/**
 * Why an envelope is or is not a trusted position fix.
 * @returns {{fix: object} | {reason: string}}
 */
export function classifyRegionalAisEnvelope(envelope, receivedAt) {
  if (!envelope || !POSITION_TYPES.has(envelope.MessageType))
    return { reason: 'not_a_position_report' };
  const msg = envelope.Message?.[envelope.MessageType];
  const meta = envelope.MetaData ?? envelope.Metadata;
  if (!msg || !meta) return { reason: 'not_a_position_report' };
  if (msg.Valid === false) return { reason: 'invalid_report' };
  const stamp = epochMs(meta.time_utc ?? meta.TimeUtc);
  if (stamp == null) return { reason: 'unparsed_time' };
  // The report's own second: 60-63 mean unavailable, manual, dead reckoning
  // or inoperative positioning (ITU-R M.1371), none of them a fix.
  const second = number(msg.Timestamp);
  if (second === null || !Number.isInteger(second) || second < 0 || second > 59)
    return { reason: 'no_fix_second' };
  const apart = Math.abs(new Date(stamp).getUTCSeconds() - second);
  if (Math.min(apart, 60 - apart) > TIMESTAMP_TOLERANCE_S)
    return { reason: 'late_report' };
  // The message's own coordinates only: MetaData repeats a last known position.
  const lat = number(msg.Latitude);
  const lon = number(msg.Longitude);
  if (lat === null || lon === null) return { reason: 'no_position' };
  const mmsi = String(meta.MMSI ?? msg.UserID ?? '').trim();
  return {
    fix: {
      mmsi,
      lat,
      lon,
      observedAt: stamp,
      receivedAt,
      provider: 'aisstream',
      timeQuality: 'source',
    },
  };
}

/** Return null unless we can prove this is an actual position report with source time. */
export function normalizeRegionalAisEnvelope(envelope, receivedAt) {
  return classifyRegionalAisEnvelope(envelope, receivedAt).fix ?? null;
}
