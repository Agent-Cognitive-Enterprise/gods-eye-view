// USGS real-time earthquakes (official, public domain). M4.5+ past day, which
// keeps the early-warning queue free of routine micro-seismicity. Each USGS
// revision (`updated`) is a separate observation of one event key, so a
// magnitude revision or a new PAGER alert is a material update while an
// unchanged re-poll is a duplicate.

export const USGS_FEED_URL =
  'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson';
const MAX_FEATURES = 2000;

/** One GeoJSON feature to a raw observation, or null when unusable. */
export function usgsFeatureToRecord(feature) {
  const p = feature?.properties;
  const [lon, lat, depth] = feature?.geometry?.coordinates ?? [];
  if (!p || typeof feature.id !== 'string' || !Number.isFinite(p.time))
    return null;
  const alert = ['green', 'yellow', 'orange', 'red'].includes(p.alert)
    ? p.alert
    : null;
  const parts = [
    Number.isFinite(p.mag)
      ? `Magnitude ${p.mag} ${p.magType ?? ''}`.trim()
      : null,
    Number.isFinite(depth) ? `depth ${Math.round(depth)} km` : null,
    alert ? `PAGER alert ${alert}` : null,
    p.tsunami === 1 ? 'tsunami flag set (see official tsunami centres)' : null,
    p.status ? `status ${p.status}` : null,
  ].filter(Boolean);
  return {
    provider: 'usgs',
    source_item_id: `${feature.id}@${p.updated ?? p.time}`,
    event_key: feature.id,
    publisher: 'U.S. Geological Survey',
    source_type: 'primary_official',
    url: p.url,
    license: 'Public domain (U.S. Government)',
    attribution: 'U.S. Geological Survey Earthquake Hazards Program',
    language: 'en',
    category: 'natural_disaster',
    subtype: 'earthquake',
    title: p.title || p.place || feature.id,
    summary: parts.join('; '),
    occurred_at: p.time,
    published_at: p.updated ?? p.time,
    location: {
      lat,
      lon,
      precision: 'point',
      geolocation_status: 'verified',
      place: p.place,
    },
    metrics: {
      magnitude: p.mag,
      alert_level: alert ?? undefined,
      tsunami: p.tsunami === 1,
      felt: p.felt ?? undefined,
      significance: p.sig ?? undefined,
      depth_km: depth,
    },
    status_hint: p.status === 'deleted' ? 'retracted' : null,
  };
}

/** The USGS connector for the feed runner. */
export function usgsConnector({ url = USGS_FEED_URL } = {}) {
  return {
    id: 'usgs-earthquakes',
    provider: 'usgs',
    url,
    intervalMs: 60_000,
    // The feed regenerates every minute; nothing new in 6 h at M4.5+ is unusual.
    staleAfterMs: 6 * 3600_000,
    license: 'Public domain (U.S. Government)',
    attribution: 'U.S. Geological Survey',
    async poll({ fetchJson }) {
      const { body, notModified } = await fetchJson(url, {
        maxBytes: 8 * 1024 * 1024,
      });
      if (notModified) return { records: [], notModified: true };
      if (!Array.isArray(body?.features))
        throw new Error('malformed USGS GeoJSON');
      const records = body.features
        .slice(0, MAX_FEATURES)
        .map(usgsFeatureToRecord)
        .filter(Boolean);
      return {
        records,
        latestObservationAt: Math.max(0, ...records.map((r) => r.published_at)),
      };
    },
  };
}
