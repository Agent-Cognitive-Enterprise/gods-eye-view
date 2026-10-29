// ReliefWeb (UN OCHA) disasters: humanitarian situations curated by OCHA
// editors. API v2 requires an approved application name; until the operator
// sets GEV_RELIEFWEB_APPNAME the feed reports "needs a key" and is never
// called. Only disasters in "alert" or "current" status are read.

import { countryBounds, countryPoint, iso2Of } from '../geography.js';

export const RELIEFWEB_URL = 'https://api.reliefweb.int/v2/disasters';
const FIELDS = [
  'name',
  'status',
  'date.created',
  'date.changed',
  'glide',
  'url',
  'primary_country.iso3',
  'primary_country.name',
  'primary_country.location',
  'primary_type.name',
  'country.iso3',
];
const TYPES = [
  [/epidemic|outbreak/i, 'public_health', 'disease_outbreak'],
  [/technological/i, 'infrastructure_disruption', 'technological_disaster'],
  [/complex emergency/i, 'breaking_news', 'complex_emergency'],
  [/flash flood|flood/i, 'natural_disaster', 'flood'],
  [/cyclone|storm surge/i, 'natural_disaster', 'tropical_cyclone'],
  [/earthquake/i, 'natural_disaster', 'earthquake'],
  [/tsunami/i, 'natural_disaster', 'tsunami_warning'],
  [/volcano/i, 'natural_disaster', 'volcano'],
  [/drought/i, 'natural_disaster', 'drought'],
  [/fire/i, 'natural_disaster', 'wildfire'],
  [/land ?slide|mud ?slide/i, 'natural_disaster', 'landslide'],
  [/cold wave/i, 'natural_disaster', 'extreme_cold'],
  [/heat wave/i, 'natural_disaster', 'extreme_heat'],
  [/storm/i, 'natural_disaster', 'severe_storm'],
  [/insect/i, 'natural_disaster', 'insect_infestation'],
];

/** The request URL (appname is the operator's approved name, not a secret). */
export function reliefWebUrl(appname) {
  const params = new URLSearchParams({
    appname,
    preset: 'latest',
    limit: '100',
    'filter[field]': 'status',
    'filter[value][]': 'alert',
  });
  params.append('filter[value][]', 'current');
  params.set('filter[operator]', 'OR');
  for (const field of FIELDS) params.append('fields[include][]', field);
  return `${RELIEFWEB_URL}?${params}`;
}

/** One disaster to a raw observation, or null when unusable. */
export function reliefWebDisasterToRecord(item) {
  const f = item?.fields;
  if (!f?.name || !item.id) return null;
  if (!['alert', 'current', 'ongoing'].includes(f.status)) return null;
  const typeName = f.primary_type?.name ?? '';
  const [, category, subtype] = TYPES.find(([pattern]) =>
    pattern.test(typeName),
  ) ?? [null, 'natural_disaster', null];
  const iso2 = iso2Of(f.primary_country?.iso3);
  const located = f.primary_country?.location;
  const point =
    Number.isFinite(located?.lat) && Number.isFinite(located?.lon)
      ? { lat: located.lat, lon: located.lon }
      : iso2
        ? countryPoint(iso2)
        : null;
  const changed = f.date?.changed ?? f.date?.created;
  return {
    provider: 'reliefweb',
    source_item_id: `${item.id}@${changed}`,
    event_key: String(item.id),
    publisher: 'ReliefWeb (UN OCHA)',
    source_type: 'secondary_reporting',
    url: f.url ?? `https://reliefweb.int/node/${item.id}`,
    license: 'ReliefWeb terms (attribution)',
    attribution:
      'ReliefWeb, UN Office for the Coordination of Humanitarian Affairs',
    language: 'en',
    category,
    subtype,
    title: f.name,
    summary: [typeName, f.status === 'alert' ? 'alert' : 'ongoing', f.glide]
      .filter(Boolean)
      .join('; '),
    occurred_at: f.date?.created,
    published_at: changed,
    location: {
      lat: point?.lat ?? null,
      lon: point?.lon ?? null,
      precision: 'country',
      geolocation_status: point ? 'approximate' : undefined,
      region_code: iso2 ?? undefined,
      place: f.primary_country?.name,
      bounds: iso2 ? (countryBounds(iso2) ?? undefined) : undefined,
    },
    metrics: { reliefweb_alert: f.status === 'alert' },
    status_hint: 'ongoing',
  };
}

export function reliefWebConnector({ appname = '' } = {}) {
  const name = String(appname).trim();
  return {
    id: 'reliefweb-disasters',
    provider: 'reliefweb',
    url: RELIEFWEB_URL,
    intervalMs: 60 * 60_000,
    staleAfterMs: 14 * 24 * 3600_000,
    license: 'ReliefWeb terms',
    attribution: 'ReliefWeb (UN OCHA)',
    requiresCredentials: () => !name,
    async poll({ fetchJson }) {
      const { body, notModified } = await fetchJson(reliefWebUrl(name), {
        maxBytes: 4 * 1024 * 1024,
      });
      if (notModified) return { records: [], notModified: true };
      if (!Array.isArray(body?.data))
        throw new Error('malformed ReliefWeb JSON');
      const records = body.data.map(reliefWebDisasterToRecord).filter(Boolean);
      return {
        records,
        latestObservationAt: Math.max(
          0,
          ...records.map((r) => Date.parse(r.published_at) || 0),
        ),
      };
    },
  };
}
