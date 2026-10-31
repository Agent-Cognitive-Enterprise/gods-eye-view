// Event age for S2 GhostMaps placemarks (fork feature). S2's "Last 30 Days"
// export reaches back to 2013, so an edition's date says nothing about its
// events: each placemark is judged by its own Date field. Pure and portable;
// the Autopilot connector shares the parser.

const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;

/** Age windows, narrowest first. A month is 30 days and a year 365. */
export const GHOSTMAPS_WINDOWS = Object.freeze(
  [
    ['6h', 6 * HOUR_MS],
    ['12h', 12 * HOUR_MS],
    ['24h', 24 * HOUR_MS],
    ['1w', 7 * DAY_MS],
    ['1m', 30 * DAY_MS],
    ['6m', 182 * DAY_MS],
    ['1y', 365 * DAY_MS],
  ].map(([id, ms]) => Object.freeze({ id, ms })),
);
export const GHOSTMAPS_DEFAULT_WINDOW = GHOSTMAPS_WINDOWS[4];

/** `M/D/YYYY[ h:mm[:ss] AM]` (no zone in the data) → epoch ms as UTC, or null. */
export function parseGhostMapsDate(text) {
  const match =
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M)?)?$/i.exec(
      String(text ?? '').trim(),
    );
  if (!match) return null;
  const [, month, day, year, h = '0', m = '0', s = '0', meridiem] = match;
  let hour = Number(h);
  if (meridiem) hour = (hour % 12) + (/pm/i.test(meridiem) ? 12 : 0);
  const ms = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    hour,
    Number(m),
    Number(s),
  );
  return Number.isFinite(ms) ? ms : null;
}

// Fields only event records carry; sites and control areas have their own.
const EVENT_FIELDS = new Set(['attacktype', 'incidenttype', 'incidentname']);

/**
 * When a placemark's event happened at the latest, and whether it is an event
 * at all. Most dates have no time of day, so a bare date lasts until that day
 * ends: otherwise this morning's event would be gone from a 6 h window.
 * @param {Array<{label: string, value: string}>} fields
 * @returns {{at: ?number, event: boolean}}
 */
export function placemarkAge(fields) {
  let date = null;
  let event = false;
  for (const { label, value } of fields) {
    const key = String(label).toLowerCase().replace(/\s+/g, '');
    if (key === 'date') date = value;
    else if (EVENT_FIELDS.has(key)) event = true;
  }
  const parsed = parseGhostMapsDate(date);
  if (parsed === null) return { at: null, event };
  const dateOnly = !/\d:\d/.test(date);
  return { at: dateOnly ? parsed + DAY_MS - 1 : parsed, event: true };
}

/**
 * Whether a placemark belongs on the map for this window. An event with no
 * date cannot be shown to be recent, so it stays off; a site or area without
 * one is not an event and stays on.
 */
export function shownInWindow({ at, event }, windowMs, now = Date.now()) {
  if (at === null) return !event;
  return at >= now - windowMs;
}
