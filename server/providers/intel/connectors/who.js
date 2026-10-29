// WHO Disease Outbreak News (official). Items name their countries in the
// title; the location is country-level (the first named country's home
// territory, framed over all of them), never a city. Successive reports on
// one outbreak have different ids, so no event key: wording, place and time
// join them. Reuse: WHO website terms (non-commercial, attributed).

import {
  countriesInText,
  countryBounds,
  countryName,
  countryPoint,
  unionBounds,
} from '../geography.js';

export const WHO_DON_URL =
  'https://www.who.int/api/news/diseaseoutbreaknews?sf_culture=en&$orderby=PublicationDateAndTime%20desc&$top=25';
const ITEM_URL = 'https://www.who.int/emergencies/disease-outbreak-news/item/';
const MAX_AGE_MS = 45 * 24 * 3600_000;

/** One DON item to a raw observation, or null when unusable or too old. */
export function whoItemToRecord(item, { now = Date.now() } = {}) {
  const published = Date.parse(
    item?.PublicationDateAndTime ?? item?.PublicationDate ?? '',
  );
  if (
    !item?.Title ||
    !Number.isFinite(published) ||
    now - published > MAX_AGE_MS
  )
    return null;
  if (!/^[A-Za-z0-9-]{1,80}$/.test(String(item.UrlName ?? ''))) return null;
  const countries = countriesInText(item.Title);
  const point = countries.length ? countryPoint(countries[0]) : null;
  return {
    provider: 'who',
    source_item_id: String(item.Id ?? item.UrlName),
    publisher: 'World Health Organization',
    source_type: 'primary_official',
    url: `${ITEM_URL}${item.UrlName}`,
    license: 'WHO website terms (attribution, non-commercial)',
    attribution: 'World Health Organization, Disease Outbreak News',
    language: 'en',
    category: 'public_health',
    subtype: 'disease_outbreak',
    title: item.Title,
    summary: item.Summary || item.Overview || '',
    published_at: published,
    location: {
      lat: point?.lat ?? null,
      lon: point?.lon ?? null,
      precision: 'country',
      geolocation_status: point ? 'approximate' : undefined,
      region_code: countries[0],
      place: countries.length
        ? countries.map(countryName).join(', ')
        : undefined,
      bounds: unionBounds(countries.map(countryBounds)) ?? undefined,
    },
    metrics: { countries: countries.length || undefined },
    entities: countries,
  };
}

export function whoConnector({ url = WHO_DON_URL } = {}) {
  return {
    id: 'who-don',
    provider: 'who',
    url,
    intervalMs: 60 * 60_000,
    // A few reports a month is normal.
    staleAfterMs: 30 * 24 * 3600_000,
    license: 'WHO website terms',
    attribution: 'World Health Organization',
    async poll({ fetchJson, now }) {
      const { body, notModified } = await fetchJson(url, {
        maxBytes: 4 * 1024 * 1024,
        // who.int is usually fast but has been seen to stall past 20 s.
        timeoutMs: 45_000,
      });
      if (notModified) return { records: [], notModified: true };
      if (!Array.isArray(body?.value))
        throw new Error('malformed WHO DON JSON');
      const at = now();
      const records = body.value
        .slice(0, 50)
        .map((item) => whoItemToRecord(item, { now: at }))
        .filter(Boolean);
      return {
        records,
        latestObservationAt: Math.max(0, ...records.map((r) => r.published_at)),
      };
    },
  };
}
