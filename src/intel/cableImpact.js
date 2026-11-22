// Phase 4 of the automatic cable signals: IODA country outages beside a
// cable event, as impact only. Pure: no fetching, no clock.
//
// Traffic data measures impact in a country; it never names a cable. So an
// outage is only ever shown on the card of a cable incident that a primary
// source already confirmed, in a country where that cable lands, during the
// incident, and it is worded as a coincidence in time, never as a cause. It
// never opens, closes or changes an incident.

/** Landing-point country names the country table spells differently. */
const COUNTRY_ALIASES = Object.freeze({
  bahamas: 'BS',
  'virgin islands (u.s.)': 'VI',
  'virgin islands (u.k.)': 'VG',
  guadeloupe: 'GP',
  martinique: 'MQ',
  'french guiana': 'GF',
  réunion: 'RE',
  mayotte: 'YT',
  'saint barthélemy': 'BL',
  'sint eustatius and saba': 'BQ',
  tokelau: 'TK',
  'christmas island': 'CX',
  'cocos (keeling) islands': 'CC',
  'sao tome and principe': 'ST',
  'ascension and tristan da cunha': 'SH',
  'congo, dem. rep.': 'CD',
  'congo, rep.': 'CG',
});

/** Two letters, as IODA's `country/XX` entities use. */
const ISO2 = /^[A-Z]{2}$/;
// A landing point within this many degrees of a line's end is where it lands.
const LANDING_REACH_DEG = 0.1;
const HOUR_MS = 3600_000;
// An outage that began more than this before the incident is not "at the
// same time".
const LEAD_MS = 24 * HOUR_MS;

/** Country name (lower case) → ISO 3166-1 alpha-2, from Natural Earth. */
export function countryCodes(collection) {
  const out = new Map(Object.entries(COUNTRY_ALIASES));
  for (const feature of collection?.features ?? []) {
    const code = feature?.iso2;
    if (!ISO2.test(String(code))) continue;
    const alt = Array.isArray(feature.alt) ? feature.alt : [feature.alt];
    for (const name of [feature.name, feature.country, ...alt])
      if (typeof name === 'string' && name && !out.has(name.toLowerCase()))
        out.set(name.toLowerCase(), code);
  }
  return out;
}

/** The country part of a landing point's name: "Karachi, Pakistan". */
function countryOf(name) {
  const parts = String(name ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length) return '';
  const last = parts.at(-1);
  // "Muanda, Congo, Dem. Rep." keeps its two-part country name.
  return /^(?:dem\. )?rep\.$/i.test(last) && parts.length > 1
    ? `${parts.at(-2)}, ${last}`
    : last;
}

/** Landing points as {lon, lat, code}, those whose country is known. */
export function landingPoints(collection, codes) {
  const out = [];
  for (const feature of collection?.features ?? []) {
    const [lon, lat] = feature?.geometry?.coordinates ?? [];
    const code = codes.get(countryOf(feature?.properties?.name).toLowerCase());
    if (Number.isFinite(lon) && Number.isFinite(lat) && code)
      out.push({ lon, lat, code });
  }
  return out;
}

/**
 * The countries a cable lands in: each end of each of its catalogue lines,
 * matched to the nearest landing point within reach. Sorted codes.
 */
export function landingCountries(feature, points) {
  const geometry = feature?.geometry;
  const lines =
    geometry?.type === 'LineString'
      ? [geometry.coordinates]
      : geometry?.type === 'MultiLineString'
        ? geometry.coordinates
        : [];
  const out = new Set();
  for (const line of lines)
    for (const end of [line?.[0], line?.at?.(-1)]) {
      if (!Array.isArray(end)) continue;
      let best = null;
      let distance = LANDING_REACH_DEG;
      for (const point of points) {
        const d = Math.hypot(point.lon - end[0], point.lat - end[1]);
        if (d <= distance) {
          distance = d;
          best = point;
        }
      }
      if (best) out.add(best.code);
    }
  return [...out].sort();
}

/**
 * The country outages beside one cable incident: in a country the cable
 * lands in, beginning no earlier than a day before the incident opened, and
 * begun by now. `outages` are iodaOutages() results. Returns [{country, name,
 * start, end, datasources}], sorted by country.
 */
export function impactFor({ incident, countries, outages, now }) {
  const opened = Date.parse(incident?.openedAt ?? '');
  if (!Number.isFinite(opened) || incident?.status !== 'open') return [];
  const wanted = new Set(countries ?? []);
  const out = [];
  for (const outage of outages ?? []) {
    if (!wanted.has(outage?.country)) continue;
    const start = Date.parse(outage.start ?? '');
    const end = Date.parse(outage.end ?? '');
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    // Around the time of the fault: begun at most a day before it opened,
    // still running when it opened, and begun by now. One already running
    // long before, or over before the fault, is not.
    if (start < opened - LEAD_MS || end < opened || start > now) continue;
    out.push({
      country: outage.country,
      name: String(outage.name ?? outage.country).slice(0, 80),
      start: outage.start,
      end: outage.end,
      datasources: [
        ...new Set((outage.signals ?? []).map((s) => String(s.datasource))),
      ].sort(),
    });
  }
  return mergeImpact([], out);
}

/** A well-formed impact entry, as stored in the shadow state. */
const isEntry = (entry) =>
  ISO2.test(String(entry?.country)) &&
  typeof entry?.name === 'string' &&
  Number.isFinite(Date.parse(entry?.start ?? '')) &&
  Number.isFinite(Date.parse(entry?.end ?? '')) &&
  Array.isArray(entry?.datasources);

/**
 * Impact for one incident only grows while it lasts: a country seen once
 * stays (IODA's query window is shorter than an incident), with its
 * earliest start and latest end. Malformed entries are dropped.
 */
export function mergeImpact(held, found) {
  const byCountry = new Map();
  for (const entry of [...(held ?? []), ...(found ?? [])]) {
    if (!isEntry(entry)) continue;
    const known = byCountry.get(entry.country);
    if (!known) {
      byCountry.set(entry.country, {
        ...entry,
        datasources: [...entry.datasources],
      });
      continue;
    }
    if (entry.start < known.start) known.start = entry.start;
    if (entry.end > known.end) known.end = entry.end;
    known.datasources = [
      ...new Set([...known.datasources, ...entry.datasources]),
    ].sort();
  }
  return [...byCountry.values()].sort((a, b) =>
    a.country < b.country ? -1 : 1,
  );
}

// The card shows about three short lines: the qualifier comes first, and
// only a few countries are named.
const MAX_LISTED = 4;

/**
 * The card's sentence for an incident's impact, or '' when there is none.
 * It leads the summary, qualifier first, so a cut card still says it.
 */
export function impactSentence(impact) {
  const entries = (impact ?? []).filter(isEntry);
  if (!entries.length) return '';
  // The earliest outages first; each with its days, so one that lasted two
  // hours weeks ago does not read as still going.
  const named = [...entries]
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))
    .slice(0, MAX_LISTED)
    .map((entry) => {
      const from = String(entry.start).slice(0, 10);
      const to = String(entry.end).slice(0, 10);
      return from === to
        ? `${entry.name} on ${from}`
        : `${entry.name} ${from} to ${to}`;
    })
    .join(', ');
  const more =
    entries.length > MAX_LISTED
      ? ` and ${entries.length - MAX_LISTED} more`
      : '';
  return `Impact only, cause unknown: around the time of this fault IODA (Georgia Tech) saw internet outages where this cable lands, in ${named}${more}. `;
}

/**
 * The card's sentence once the outages shown before are no longer shown
 * (IODA switched off, or its state lost), naming them so the card changes.
 */
export function impactClearedSentence(names) {
  const list = (names ?? []).slice(0, MAX_LISTED).join(', ');
  return `IODA outage signals${list ? ` for ${list}` : ''} are no longer shown here. `;
}
