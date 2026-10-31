// GDACS (Global Disaster Alert and Coordination System, UN/European
// Commission): automatic multi-hazard alerts with an alert level, exposure,
// bounds and country. RSS, conditional requests supported. Licence: CC BY 4.0
// (European Union), reuse with credit to GDACS.
//
// Kept: every Orange and Red alert, and Green earthquakes, cyclones, floods
// and volcanoes. Green wildfires and droughts (most of the feed) are routine.

import { iso2Of } from '../geography.js';
import { attr, blocks, tag, text } from './xml.js';

export const GDACS_RSS = 'https://www.gdacs.org/xml/rss.xml';
const ATTRIBUTION =
  'GDACS (Global Disaster Alert and Coordination System), European Union, CC BY 4.0';
const SUBTYPES = Object.freeze({
  EQ: 'earthquake',
  TC: 'tropical_cyclone',
  FL: 'flood',
  VO: 'volcano',
  DR: 'drought',
  WF: 'wildfire',
});
const GREEN_KEPT = new Set(['EQ', 'TC', 'FL', 'VO']);

const date = (value) => {
  const ms = Date.parse(value ?? '');
  return Number.isFinite(ms) ? ms : null;
};

/** One RSS item to a raw observation, or null when filtered out. */
export function gdacsItemToRecord(item) {
  const type = tag(item, 'gdacs:eventtype');
  const level = String(tag(item, 'gdacs:alertlevel') ?? '').toLowerCase();
  if (!SUBTYPES[type] || !['green', 'orange', 'red'].includes(level))
    return null;
  if (tag(item, 'gdacs:iscurrent') === 'false') return null;
  if (level === 'green' && !GREEN_KEPT.has(type)) return null;
  const eventId = tag(item, 'gdacs:eventid');
  const episodeId = tag(item, 'gdacs:episodeid');
  if (!/^\d+$/.test(eventId ?? '')) return null;
  const lat = Number(tag(item, 'geo:lat'));
  const lon = Number(tag(item, 'geo:long'));
  const [west, east, south, north] = String(tag(item, 'gdacs:bbox') ?? '')
    .split(/\s+/)
    .map(Number);
  const bounds = [west, east, south, north].every(Number.isFinite)
    ? { west, east, south, north }
    : undefined;
  const magnitude = Number(attr(item, 'gdacs:severity', 'value'));
  const population = Number(attr(item, 'gdacs:population', 'value'));
  const populationUnit = attr(item, 'gdacs:population', 'unit') ?? '';
  return {
    provider: 'gdacs',
    source_item_id: `${type}${eventId}-${episodeId}`,
    event_key: `${type}${eventId}`,
    publisher: 'GDACS',
    source_type: 'primary_official',
    url: String(tag(item, 'link') ?? '').replace(/^http:/, 'https:'),
    license: 'CC BY 4.0 (European Union)',
    attribution: ATTRIBUTION,
    language: 'en',
    category: 'natural_disaster',
    subtype: SUBTYPES[type],
    title: text(tag(item, 'title')),
    summary: text(tag(item, 'description')),
    occurred_at: date(tag(item, 'gdacs:fromdate')),
    published_at:
      date(tag(item, 'gdacs:datemodified')) ?? date(tag(item, 'pubDate')),
    location: {
      lat,
      lon,
      precision: type === 'EQ' ? 'point' : 'region',
      geolocation_status: type === 'EQ' ? 'verified' : 'approximate',
      region_code: iso2Of(tag(item, 'gdacs:iso3')) ?? undefined,
      place: tag(item, 'gdacs:country'),
      bounds,
    },
    metrics: {
      gdacs_alert: level,
      magnitude:
        type === 'EQ' && Number.isFinite(magnitude) ? magnitude : undefined,
      // GDACS reports exposure in people for most hazards; other units are not counts.
      affected:
        /people|pop/i.test(populationUnit) && population > 0
          ? population
          : undefined,
    },
  };
}

export function gdacsConnector({
  url = GDACS_RSS,
  intervalMs = 10 * 60_000,
} = {}) {
  return {
    id: 'gdacs-alerts',
    provider: 'gdacs',
    url,
    intervalMs,
    staleAfterMs: 24 * 3600_000,
    license: 'CC BY 4.0 (European Union)',
    attribution: ATTRIBUTION,
    async poll({ fetchText }) {
      const { body, notModified } = await fetchText(url, {
        maxBytes: 8 * 1024 * 1024,
        accept: 'application/rss+xml, application/xml',
      });
      if (notModified) return { records: [], notModified: true };
      const records = blocks(body, 'item')
        .map(gdacsItemToRecord)
        .filter(Boolean);
      return {
        records,
        latestObservationAt: Math.max(
          0,
          ...records.map((r) => r.published_at ?? 0),
        ),
      };
    },
  };
}
