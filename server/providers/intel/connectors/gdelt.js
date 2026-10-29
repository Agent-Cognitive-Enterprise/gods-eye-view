// GDELT 2.0 event export (machine-coded from world news every 15 minutes;
// open, cite "The GDELT Project"). Opt-in (GEV_INTEL_GDELT=1): the coding is
// automatic and often wrong, so records are `aggregator` grade (they never
// corroborate anything), labelled "Machine-coded news", kept 14 days, and
// limited to protests (CAMEO root 14) and violence (18-20) reported by at
// least MIN_ARTICLES articles, geolocated to a city or landmark.

import { readZipEntry } from '../kmz.js';

export const GDELT_LAST_UPDATE =
  'https://data.gdeltproject.org/gdeltv2/lastupdate.txt';
const MIN_ARTICLES = 5;
const MAX_RECORDS = 150;
const COLUMNS = 61;
const ROOTS = Object.freeze({
  14: ['civil_unrest', 'protest', 'Protest'],
  18: ['armed_conflict', 'assault', 'Assault'],
  19: ['armed_conflict', 'armed_clash', 'Fighting'],
  20: ['armed_conflict', 'mass_violence', 'Mass violence'],
});
const C = Object.freeze({
  id: 0,
  day: 1,
  root: 28,
  goldstein: 30,
  mentions: 31,
  sources: 32,
  articles: 33,
  geoType: 51,
  place: 52,
  lat: 56,
  lon: 57,
  added: 59,
  url: 60,
});

/** "20261029083000" (UTC) to epoch ms, or null. */
const gdeltTime = (value) => {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?$/.exec(
    String(value ?? ''),
  );
  return m
    ? Date.UTC(
        +m[1],
        +m[2] - 1,
        +m[3],
        +(m[4] ?? 0),
        +(m[5] ?? 0),
        +(m[6] ?? 0),
      )
    : null;
};

/** Tab-separated export rows to raw observations (pure). */
export function gdeltCsvToRecords(csv) {
  const out = [];
  for (const line of String(csv).split('\n')) {
    const row = line.split('\t');
    if (row.length < COLUMNS) continue;
    const kind = ROOTS[Number(row[C.root])];
    const articles = Number(row[C.articles]);
    const geoType = Number(row[C.geoType]);
    if (!kind || !(articles >= MIN_ARTICLES)) continue;
    if (geoType !== 3 && geoType !== 4) continue; // US or world city/landmark
    const lat = Number(row[C.lat]);
    const lon = Number(row[C.lon]);
    const added = gdeltTime(row[C.added]);
    const day = gdeltTime(row[C.day]);
    // Old stories resurface in today's news; GDELT's "event day" is the
    // day mentioned, which is often weeks back. Only recent events count.
    if (!added || !day || added - day > 3 * 24 * 3600_000) continue;
    const url = /^https?:\/\//.test(row[C.url] ?? '')
      ? row[C.url].trim()
      : null;
    if (!url) continue;
    const [category, subtype, label] = kind;
    out.push({
      articles,
      record: {
        provider: 'gdelt',
        source_item_id: row[C.id],
        publisher: 'GDELT Project (machine-coded)',
        source_type: 'aggregator',
        url,
        lineage_key: url,
        license: 'GDELT open data (citation required)',
        attribution: 'The GDELT Project (gdeltproject.org)',
        language: 'en',
        category,
        subtype,
        title: `Machine-coded news: ${label.toLowerCase()} reported near ${row[C.place]}`,
        summary: `Automatically coded from ${articles} news articles (${row[C.sources]} sources); CAMEO root ${row[C.root]}; not verified.`,
        occurred_at: day,
        published_at: added,
        location: {
          lat,
          lon,
          precision: 'city',
          geolocation_status: 'needs_verification',
          place: row[C.place],
        },
        metrics: {
          articles,
          mentions: Number(row[C.mentions]) || undefined,
          goldstein: Number(row[C.goldstein]),
        },
      },
    });
  }
  return out
    .sort((a, b) => b.articles - a.articles)
    .slice(0, MAX_RECORDS)
    .map((x) => x.record);
}

export function gdeltConnector({ url = GDELT_LAST_UPDATE } = {}) {
  let lastExport = null;
  return {
    id: 'gdelt-events',
    provider: 'gdelt',
    url,
    intervalMs: 15 * 60_000,
    staleAfterMs: 2 * 3600_000,
    license: 'GDELT open data (citation required)',
    attribution: 'The GDELT Project',
    async poll({ fetchText, fetchBytes }) {
      const { body: listing, notModified } = await fetchText(url, {
        maxBytes: 4096,
      });
      if (notModified) return { records: [], notModified: true };
      const exportUrl = String(listing)
        .split('\n')
        .map((line) => line.trim().split(/\s+/)[2])
        .find((u) => /\/gdeltv2\/\d{14}\.export\.CSV\.zip$/.test(u ?? ''));
      if (!exportUrl) throw new Error('no GDELT export listed');
      if (exportUrl === lastExport) return { records: [], notModified: true };
      const { body: zip } = await fetchBytes(
        exportUrl.replace(/^http:/, 'https:'),
        {
          maxBytes: 5 * 1024 * 1024,
          conditional: false,
        },
      );
      const csv = readZipEntry(zip, (names) =>
        names.find((n) => /\.export\.CSV$/i.test(n)),
      );
      lastExport = exportUrl;
      const records = gdeltCsvToRecords(csv);
      return {
        records,
        latestObservationAt:
          gdeltTime(/(\d{14})\.export/.exec(exportUrl)?.[1]) ?? 0,
      };
    },
  };
}
