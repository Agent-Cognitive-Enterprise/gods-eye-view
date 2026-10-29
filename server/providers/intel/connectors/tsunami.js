// NOAA tsunami warning centres (official, public domain): the Pacific
// Tsunami Warning Center (PHEB, Honolulu) and the National Tsunami Warning
// Center (PAAQ, Palmer) publish one Atom feed each with their latest bulletin.
// Information statements (no threat) are skipped; warnings, watches,
// advisories and threat messages are kept, and a cancellation resolves the
// event. The two centres can issue for one earthquake under different ids, so
// each is its own provider and they corroborate rather than collide.

import { blocks, tag, text } from './xml.js';

export const TSUNAMI_FEEDS = Object.freeze({
  ptwc: {
    id: 'tsunami-ptwc',
    url: 'https://www.tsunami.gov/events/xml/PHEBAtom.xml',
    publisher: 'NOAA Pacific Tsunami Warning Center',
  },
  ntwc: {
    id: 'tsunami-ntwc',
    url: 'https://www.tsunami.gov/events/xml/PAAQAtom.xml',
    publisher: 'NOAA National Tsunami Warning Center',
  },
});

const LEVELS = [
  [/cancel/i, 'cancellation', 40],
  [/warning/i, 'warning', 95],
  [/threat/i, 'threat', 90],
  [/advisory/i, 'advisory', 75],
  [/watch/i, 'watch', 70],
];

/** One Atom entry to a raw observation, or null for information statements. */
export function tsunamiEntryToRecord(
  entry,
  { provider, publisher, feedTitle = '' },
) {
  const summary = text(tag(entry, 'summary'));
  const category =
    /Category:\s*([A-Za-z ]+?)\s+Bulletin/i.exec(summary)?.[1] ?? feedTitle;
  const level = LEVELS.find(([pattern]) => pattern.test(category));
  if (!level) return null; // information statement or unknown
  const [, kind, severity] = level;
  const bulletin = /href="([^"]+\.txt)"/i.exec(entry)?.[1] ?? null;
  // /events/PHEB/2026/10/24/26297050/1/WEGM42/ -> PHEB-26297050 (event), issue 1
  const path =
    /\/events\/([A-Z]{4})\/\d{4}\/\d{2}\/\d{2}\/([A-Za-z0-9]+)\/(\d+)\//.exec(
      entry,
    );
  if (!path) return null;
  const region = text(tag(entry, 'title')).replace(/\s+/g, ' ');
  const magnitude = Number(
    /Preliminary Magnitude:\s*([\d.]+)/i.exec(summary)?.[1],
  );
  const updated = tag(entry, 'updated');
  return {
    provider,
    source_item_id: `${path[1]}-${path[2]}-${path[3]}`,
    event_key: `${path[1]}-${path[2]}`,
    publisher,
    source_type: 'primary_official',
    url: bulletin,
    license: 'Public domain (U.S. Government)',
    attribution: `${publisher} (tsunami.gov)`,
    language: 'en',
    category: 'natural_disaster',
    subtype: 'tsunami_warning',
    title: `Tsunami ${kind}: ${region}`,
    summary,
    occurred_at: updated,
    published_at: updated,
    location: {
      lat: Number(tag(entry, 'geo:lat')),
      lon: Number(tag(entry, 'geo:long')),
      precision: 'region',
      geolocation_status: 'verified',
      place: region,
    },
    metrics: {
      tsunami: kind !== 'cancellation',
      magnitude: Number.isFinite(magnitude) ? magnitude : undefined,
      severity_hint: severity,
    },
    status_hint: kind === 'cancellation' ? 'resolved' : 'warning',
  };
}

export function tsunamiConnector(key) {
  const feed = TSUNAMI_FEEDS[key];
  return {
    id: feed.id,
    provider: key,
    url: feed.url,
    intervalMs: 2 * 60_000,
    // Bulletins are rare; the feed holds the last one indefinitely.
    staleAfterMs: 365 * 24 * 3600_000,
    license: 'Public domain (U.S. Government)',
    attribution: feed.publisher,
    async poll({ fetchText }) {
      const { body, notModified } = await fetchText(feed.url, {
        maxBytes: 512 * 1024,
        accept: 'application/atom+xml, application/xml',
      });
      if (notModified) return { records: [], notModified: true };
      const feedTitle = text(tag(body, 'title'));
      const records = blocks(body, 'entry', 50)
        .map((entry) =>
          tsunamiEntryToRecord(entry, {
            provider: key,
            publisher: feed.publisher,
            feedTitle,
          }),
        )
        .filter(Boolean);
      const updated = Date.parse(tag(body, 'updated') ?? '');
      return {
        records,
        latestObservationAt: Number.isFinite(updated) ? updated : 0,
      };
    },
  };
}
