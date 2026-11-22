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
// An outage that began this long before the incident is not "at the same time".
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
 * lands in, and overlapping the incident (from a day before it opened).
 * `outages` are iodaOutages() results. Returns [{country, name, start, end,
 * datasources}], sorted by country.
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
    if (end < opened - LEAD_MS || start > now) continue;
    out.push({
      country: outage.country,
      name: String(outage.name ?? outage.country).slice(0, 80),
      start: outage.start,
      end: outage.end,
      datasources: [
        ...new Set((outage.signals ?? []).map((s) => s.datasource)),
      ].sort(),
    });
  }
  return out.sort((a, b) => (a.country < b.country ? -1 : 1));
}

const SIGNAL_NAMES = Object.freeze({
  bgp: 'routing (BGP)',
  'ping-slash24': 'active probing',
  'merit-nt': 'network telescope',
  gtr: 'Google traffic',
});

/** The card's sentence for an incident's impact, or '' when there is none. */
export function impactSentence(impact) {
  if (!impact?.length) return '';
  const places = impact
    .map((entry) => {
      const signals = entry.datasources
        .map((id) => SIGNAL_NAMES[id] ?? id)
        .join(', ');
      return `${entry.name} from ${String(entry.start).slice(0, 10)} (${signals})`;
    })
    .join('; ');
  return ` At the same time IODA (Georgia Tech) saw internet outage signals in a country this cable lands in: ${places}. That shows impact in the country; it does not say this cable caused it.`;
}
