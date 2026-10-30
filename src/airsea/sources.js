// Air/sea source catalogue and health (fork feature). Every density answer
// carries the state of the feeds behind it, so an empty map can be read as
// "no reports" or "no coverage", never as "no traffic". Pure and portable.

// Portable module: titles are marked for translation, not translated here.
const msg = (text) => text;

export const FEED_STATUSES = Object.freeze([
  'healthy',
  'degraded',
  'stale',
  'down',
  'unconfigured',
  'permission_required',
  'trial',
]);

/** The traffic feeds this app already ingests; none is polled by this module. */
export const TRAFFIC_SOURCES = Object.freeze([
  Object.freeze({
    id: 'opensky',
    domain: 'air_traffic',
    title: msg('OpenSky Network (global state vectors)'),
    scope: 'global',
    spatialCoverage:
      'Worldwide where volunteer ADS-B/MLAT receivers hear aircraft; thin over oceans, Africa, Siberia and polar routes',
    // The proxy's adaptive cache TTL reaches 300 s on a thin credit budget.
    staleAfterMs: 15 * 60_000,
    requiresKey: false,
    licenceUrl: 'https://opensky-network.org/about/terms-of-use',
    attribution: 'The OpenSky Network, https://opensky-network.org',
    limitations: [
      'Anonymous use allows ~400 credits a day (a global snapshot costs 4); the proxy stretches its cache and may serve stale data',
      'Snapshots exist only while the flights layer or this density view requests them',
    ],
  }),
  Object.freeze({
    id: 'adsblol-regional',
    domain: 'air_traffic',
    title: msg('adsb.lol regional fallback (250 nm around the view)'),
    scope: 'regional',
    spatialCoverage: '250 nm around the camera when OpenSky is unavailable',
    staleAfterMs: 5 * 60_000,
    requiresKey: false,
    licenceUrl: 'https://www.adsb.lol/docs/open-data/api/',
    attribution: 'adsb.lol (ODbL)',
    limitations: ['Regional only; used by the flights layer as a fallback'],
  }),
  Object.freeze({
    id: 'adsblol-mil',
    domain: 'air_traffic',
    title: msg('adsb.lol military aircraft'),
    scope: 'military',
    spatialCoverage: 'Worldwide, military-flagged aircraft only',
    staleAfterMs: 5 * 60_000,
    requiresKey: false,
    licenceUrl: 'https://www.adsb.lol/docs/open-data/api/',
    attribution: 'adsb.lol (ODbL)',
    limitations: [
      'Military aircraft only; refreshed while the military layer is on',
    ],
  }),
  Object.freeze({
    id: 'aisstream',
    domain: 'sea_traffic',
    title: msg('AISStream (terrestrial AIS)'),
    scope: 'global',
    spatialCoverage:
      'Coastal and port waters within reach of AIS receivers; little open-ocean coverage',
    staleAfterMs: 10 * 60_000,
    requiresKey: true,
    licenceUrl: 'https://aisstream.io/',
    attribution: 'AISStream.io',
    limitations: [
      'Needs a free AISSTREAM_API_KEY; one connection per key, shared with the vessel layer',
      'AIS is event-driven: ships report at different rates and some switch AIS off',
    ],
  }),
]);

/**
 * Status of one traffic source.
 * @param {object} source From TRAFFIC_SOURCES.
 * @param {{receivedAt?: number, newestFixAt?: number, objects?: number,
 *   configured?: boolean}|null} last The latest snapshot seen, if any.
 */
export function sourceStatus(source, last, now) {
  if (source.requiresKey && last?.configured === false)
    return { status: 'unconfigured', reason: 'no_api_key' };
  if (!last?.receivedAt) return { status: 'stale', reason: 'no_snapshot_yet' };
  const age = now - last.receivedAt;
  if (age > source.staleAfterMs)
    return { status: 'stale', reason: 'no_recent_snapshot' };
  // A fresh delivery of old positions (a provider serving its own cache).
  if (last.newestFixAt && now - last.newestFixAt > source.staleAfterMs)
    return { status: 'degraded', reason: 'positions_old' };
  if (!last.objects) return { status: 'degraded', reason: 'empty_snapshot' };
  return { status: 'healthy', reason: null };
}

/**
 * What a density map for `domain` can be trusted to show.
 *  - global: a worldwide feed is healthy;
 *  - partial: only regional or military-only feeds are healthy;
 *  - none: nothing usable (an empty map then means no coverage).
 */
export function domainCoverage(domain, statuses) {
  const feedDomain = domain === 'air' ? 'air_traffic' : 'sea_traffic';
  const relevant = TRAFFIC_SOURCES.filter((s) => s.domain === feedDomain);
  const healthy = relevant.filter((s) => statuses[s.id]?.status === 'healthy');
  if (healthy.some((s) => s.scope === 'global'))
    return { level: 'global', reason: null };
  if (healthy.length)
    return { level: 'partial', reason: 'only_regional_or_military_feeds' };
  const unconfigured = relevant.every(
    (s) => statuses[s.id]?.status === 'unconfigured',
  );
  return {
    level: 'none',
    reason: unconfigured ? 'not_configured' : 'feeds_stale_or_down',
  };
}
