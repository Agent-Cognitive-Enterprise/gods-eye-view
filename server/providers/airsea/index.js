// Air/sea density service and routes (fork feature). Reads the snapshots the
// existing OpenSky/adsb.lol proxies already fetched (bus.js) and the vessel
// store the AISStream socket already fills; serves H3 cell counts with the
// health of every feed behind them. Read-only routes, safe for LAN viewers.

import {
  aggregateCells,
  aircraftFromReadsb,
  aircraftFromStates,
  cellRing,
  createTrafficTracker,
  rejectReason,
  vesselsFromAisRows,
} from '../../../src/airsea/aggregate.js';
import { evaluateAnomalies } from '../../../src/airsea/anomaly.js';
import {
  TRAFFIC_DOMAIN,
  correlationWindow,
  evaluateCorrelation,
  warningZones,
} from '../../../src/airsea/correlation.js';
import {
  FOOTPRINT_RULES,
  createFootprintTracker,
} from '../../../src/airsea/trajectory.js';
import { cellArea, cellToLatLng } from 'h3-js';
import {
  TRAFFIC_SOURCES,
  domainCoverage,
  sourceStatus,
} from '../../../src/airsea/sources.js';
import { AISSTREAM_CACHE_MAX, aisStreamRows } from '../vessels/ais-store.js';
import path from 'node:path';
import { subscribeTrafficSnapshots, trafficSnapshotsSince } from './bus.js';
import { HOUR_MS, createTrafficHistory } from './history.js';
import { createWarningService } from './warnings.js';
import { simplifyGeometry } from '../../../src/airsea/warnings.js';

export const WINDOWS_MS = Object.freeze([
  15 * 60_000,
  3600_000,
  6 * 3600_000,
  24 * 3600_000,
]);
// Footprint windows: aircraft to a day, vessels (slower) to three days.
export const FOOTPRINT_WINDOWS_MS = Object.freeze({
  air: Object.freeze([
    15 * 60_000,
    3600_000,
    6 * 3600_000,
    12 * 3600_000,
    24 * 3600_000,
  ]),
  sea: Object.freeze([3600_000, 6 * 3600_000, 24 * 3600_000, 72 * 3600_000]),
});
// Anomalies are judged on the coarser footprint grid (steadier counts).
const ANOMALY_RESOLUTION = { air: 2, sea: 3 };
const WEEK_MS = 7 * 24 * HOUR_MS;
const AIS_READ_EVERY_MS = 30_000;
// The ticker fires every 30 s give or take a few ms: a read due "now" must
// not wait for the next tick, or half the expected snapshots go missing.
const AIS_READ_SLACK_MS = 2_000;
const RESOLUTIONS = new Set([1, 2, 3, 4]);
// A density answer is reused while nothing new arrived (and briefly, since
// ages move): several viewers and camera stops cost one aggregation.
const CACHE_MS = 30_000;
// Fine cells only for a bounded view.
const MAX_FINE_BOX_DEGREES = 60;

/**
 * @param {{now?: () => number, snapshots?: Function, subscribe?: Function,
 *   readAisRows?: Function, aisConfigured?: () => boolean,
 *   cadenceMs?: Record<string, number>}} [options]
 */
export function createAirSeaService({
  now = () => Date.now(),
  snapshots = trafficSnapshotsSince,
  subscribe = subscribeTrafficSnapshots,
  readAisRows = () => aisStreamRows(AISSTREAM_CACHE_MAX),
  aisConfigured = () => Boolean(process.env.AISSTREAM_API_KEY),
  cadenceMs = {},
  history = null,
} = {}) {
  const tracker = createTrafficTracker();
  const footprint = createFootprintTracker();
  const startedAt = now();
  const cache = new Map(); // query key -> {version, at, result}
  // Every snapshot is taken in as it is published (off the publishing
  // request), so the windows keep filling while no layer is shown.
  let pending = false;
  const unsubscribe = subscribe?.(() => {
    if (pending) return;
    pending = true;
    setImmediate(() => {
      pending = false;
      sync();
    });
  });
  const last = {}; // source id -> {receivedAt, newestFixAt, objects, configured}
  const parseErrors = {};
  let lastSeq = 0;
  let lastAisAt = -Infinity;

  function note(source, fixes, receivedAt) {
    tracker.ingest(fixes, receivedAt);
    const valid = fixes.filter(
      (f) => f.lat !== null && f.lon !== null && Number.isFinite(f.observedAt),
    );
    // History and coverage come from each domain's main feed only: the
    // regional and military feeds run where someone looks, and would make
    // traffic seem to rise wherever the map is watched.
    const domain =
      source === 'opensky' ? 'air' : source === 'aisstream' ? 'sea' : null;
    if (history && domain) {
      // Where each object went since its last fix: passages and minutes.
      // Coverage counts only objects with a newer position than before:
      // the AIS store keeps rows for 30 minutes and stale snapshots get
      // republished, so a stalled feed reads as missing data, not as fewer
      // passages.
      let fresh = 0;
      for (const fix of fixes) {
        if (rejectReason(fix, receivedAt)) continue;
        const step = footprint.observe(fix);
        history.add(fix.domain, step);
        if (step.fresh) fresh += 1;
      }
      if (fresh) history.noteSnapshot(domain, receivedAt, fresh);
    }
    last[source] = {
      receivedAt,
      newestFixAt: valid.length
        ? Math.max(...valid.map((f) => f.observedAt))
        : null,
      objects: new Set(valid.map((f) => f.id)).size,
      configured: true,
    };
  }

  function sync() {
    const t = now();
    for (const snap of snapshots(lastSeq)) {
      lastSeq = snap.seq;
      let payload = snap.payload;
      if (!payload && typeof snap.body === 'string') {
        try {
          payload = JSON.parse(snap.body);
        } catch {
          parseErrors[snap.provider] = (parseErrors[snap.provider] ?? 0) + 1;
          continue;
        }
      }
      const meta = { provider: snap.provider, receivedAt: snap.receivedAt };
      note(
        snap.provider,
        snap.provider === 'adsblol-mil'
          ? aircraftFromReadsb(payload, meta)
          : aircraftFromStates(payload, meta),
        snap.receivedAt,
      );
    }
    if (!aisConfigured()) last.aisstream = { configured: false };
    else if (t - lastAisAt >= AIS_READ_EVERY_MS - AIS_READ_SLACK_MS) {
      lastAisAt = t;
      const rows = readAisRows();
      if (rows.length)
        note(
          'aisstream',
          vesselsFromAisRows(rows, { provider: 'aisstream', receivedAt: t }),
          t,
        );
      else last.aisstream ??= { configured: true };
    }
    tracker.prune(t);
  }

  /** How often a domain's main feed is expected to deliver a snapshot. */
  const zoneCache = new Map(); // warning id -> {geometryKey, zones}
  let correlationCache = null; // {key, value}: one answer per hour
  const anomalyCache = new Map(); // domain -> {hour, value}
  const expectedEvery = (domain) =>
    domain === 'air' ? (cadenceMs.opensky ?? 5 * 60_000) : AIS_READ_EVERY_MS;

  // Vessels are read from the shared AIS store on a timer, so history keeps
  // filling between aircraft snapshots and while no one is watching.
  const ticker = history ? setInterval(() => sync(), AIS_READ_EVERY_MS) : null;
  ticker?.unref?.();

  function statuses() {
    const t = now();
    const out = {};
    for (const source of TRAFFIC_SOURCES) {
      const seen = last[source.id] ?? null;
      // A feed is stale only when it misses its collection cadence by half
      // again, not in the seconds a scheduled fetch takes.
      const staleAfterMs = Math.max(
        source.staleAfterMs,
        1.5 * (cadenceMs[source.id] ?? 0),
      );
      out[source.id] = {
        ...sourceStatus({ ...source, staleAfterMs }, seen, t),
        received_at: seen?.receivedAt ?? null,
        newest_fix_at: seen?.newestFixAt ?? null,
        objects: seen?.objects ?? 0,
      };
    }
    return out;
  }

  return {
    sources() {
      sync();
      const status = statuses();
      return TRAFFIC_SOURCES.map((s) => ({
        id: s.id,
        domain: s.domain,
        title: s.title,
        scope: s.scope,
        spatial_coverage: s.spatialCoverage,
        requires_key: s.requiresKey,
        licence_url: s.licenceUrl,
        attribution: s.attribution,
        limitations: s.limitations,
        ...status[s.id],
      }));
    },
    density({ domain, resolution = 2, windowMs = 3600_000, box = null }) {
      sync();
      const t = now();
      const key = `${domain}|${resolution}|${windowMs}|${box ?? ''}`;
      const hit = cache.get(key);
      if (hit && hit.version === tracker.version() && t - hit.at < CACHE_MS)
        return hit.result;
      const status = statuses();
      const fixes = tracker.current(domain, t, windowMs);
      const result = aggregateCells(fixes, { resolution, now: t, box });
      const answer = {
        domain,
        resolution,
        window_ms: windowMs,
        generated_at: t,
        // The tracker remembers only what it saw since the server started.
        observed_since: startedAt,
        coverage: domainCoverage(domain, status),
        sources: Object.fromEntries(
          TRAFFIC_SOURCES.filter(
            (s) =>
              s.domain === (domain === 'air' ? 'air_traffic' : 'sea_traffic'),
          ).map((s) => [s.id, status[s.id]]),
        ),
        total: result.total,
        drawn: result.drawn,
        truncated: result.truncated,
        // How often this server collects the domain's main feed.
        collection_ms:
          cadenceMs[domain === 'air' ? 'opensky' : 'aisstream'] ?? null,
        cells: result.cells,
        diagnostics: { ...tracker.diagnostics(), parse_errors: parseErrors },
      };
      if (cache.size > 32) cache.clear();
      cache.set(key, { version: tracker.version(), at: t, result: answer });
      return answer;
    },
    close() {
      unsubscribe?.();
      clearInterval(ticker);
    },
    /** Passages and object-minutes per cell over a rolling window. */
    footprint({ domain, resolution, windowMs, box = null }) {
      sync();
      const t = now();
      const windowMinutes = windowMs / 60_000;
      const cells = [];
      // A view box keeps fine grids to what the camera sees.
      const inView = (cell) => {
        if (!box) return true;
        const [lat, lon] = cellToLatLng(cell);
        const [west, south, east, north] = box;
        if (lat < south || lat > north) return false;
        return west <= east
          ? lon >= west && lon <= east
          : lon >= west || lon <= east;
      };
      for (const row of history?.footprint({ domain, resolution, windowMs }) ??
        []) {
        if (!inView(row.cell)) continue;
        const ring = cellRing(row.cell);
        if (!ring) continue;
        cells.push({
          h3: row.cell,
          ring,
          passages: row.passages,
          minutes: Math.round(row.minutes * 10) / 10,
          // Mean number present at any moment of the window.
          averagePresent: Math.round((row.minutes / windowMinutes) * 100) / 100,
          passagesPer10kKm2:
            Math.round(
              (row.passages / cellArea(row.cell, 'km2')) * 10_000 * 100,
            ) / 100,
        });
      }
      const since = history?.since(domain) ?? null;
      const covered = (
        history?.coverageSince(domain, t - windowMs) ?? []
      ).reduce((sum, row) => sum + row.snapshots, 0);
      return {
        domain,
        resolution,
        window_ms: windowMs,
        generated_at: t,
        history_since: since,
        // The window reaches back before history began.
        partial_window: since === null || since > t - windowMs,
        snapshots_in_window: covered,
        expected_snapshots: Math.round(windowMs / expectedEvery(domain)),
        coverage: domainCoverage(domain, statuses()),
        passages: cells.reduce((sum, c) => sum + c.passages, 0),
        cells,
      };
    },
    /**
     * Traffic inside each active, geolocated warning area against its
     * reference and the ring around it (correlation.js). TRIAL data and
     * warnings without an area are skipped.
     */
    correlations(warnings) {
      if (!history) return [];
      sync();
      const t = now();
      const cacheKey = `${Math.floor(t / HOUR_MS)}|${warnings
        .map((w) => `${w.id}:${w.contentHash ?? ''}:${w.status}`)
        .join(',')}`;
      if (correlationCache?.key === cacheKey) return correlationCache.value;
      const ranges = new Map(); // one history read per window and grid
      const range = (domain, resolution, from, to) => {
        const key = `${domain}|${resolution}|${from}|${to}`;
        if (!ranges.has(key))
          ranges.set(key, {
            cells: history.rangeCells({ domain, resolution, from, to }),
            coverage: history.rangeCoverage(domain, from, to),
          });
        return ranges.get(key);
      };
      const out = [];
      for (const warning of warnings) {
        const domain = TRAFFIC_DOMAIN[warning.domain];
        if (!domain || warning.trial || warning.status !== 'active') continue;
        const geometryKey =
          warning.contentHash ?? JSON.stringify(warning.geometry ?? null);
        let cached = zoneCache.get(warning.id);
        if (cached?.geometryKey !== geometryKey) {
          cached = {
            geometryKey,
            zones: (() => {
              try {
                return warningZones(warning.geometry, domain);
              } catch {
                return null; // geometry h3 cannot read: no area
              }
            })(),
          };
          zoneCache.set(warning.id, cached);
        }
        const zones = cached.zones;
        if (!zones) continue;
        const window = correlationWindow(warning, t, history.since(domain));
        if (!window) continue;
        const { from, to, pre } = window;
        const weeks = [];
        for (const k of window.weeks) {
          const past = range(
            domain,
            zones.resolution,
            from - k * WEEK_MS,
            to - k * WEEK_MS,
          );
          if (past.coverage.snapshots > 0) weeks.push(past);
        }
        out.push(
          evaluateCorrelation({
            warning,
            zones,
            domain,
            post: range(domain, zones.resolution, from, to),
            pre: pre ? range(domain, zones.resolution, pre.from, pre.to) : null,
            weeks,
            expectedSnapshots: Math.max(
              1,
              Math.round((to - from) / expectedEvery(domain)),
            ),
            from,
            to,
          }),
        );
      }
      // Forget areas no longer listed.
      const listed = new Set(warnings.map((w) => w.id));
      for (const id of zoneCache.keys())
        if (!listed.has(id)) zoneCache.delete(id);
      correlationCache = { key: cacheKey, value: out };
      return out;
    },
    /** The last complete hour against the same hour in earlier weeks. */
    anomalies({ domain }) {
      sync();
      const t = now();
      const hour = Math.floor(t / HOUR_MS) * HOUR_MS - HOUR_MS;
      const cached = anomalyCache.get(domain);
      if (cached?.hour === hour) return cached.value;
      const resolution = ANOMALY_RESOLUTION[domain];
      const weeks = [];
      for (let k = 1; k <= 4; k++) {
        const past = hour - k * WEEK_MS;
        const coverage = history?.coverage(domain, past);
        if (coverage)
          weeks.push({
            cells: history.hourCells({ domain, resolution, hour: past }),
            coverage,
          });
      }
      const result = evaluateAnomalies({
        current: history?.hourCells({ domain, resolution, hour }) ?? new Map(),
        currentCoverage: history?.coverage(domain, hour) ?? null,
        weeks,
        expectedSnapshots: Math.max(
          1,
          Math.round(HOUR_MS / expectedEvery(domain)),
        ),
      });
      const since = history?.since(domain) ?? null;
      const answer = {
        domain,
        resolution,
        hour_start: hour,
        history_since: since,
        // When two comparable weeks can exist at the earliest.
        baseline_possible_from:
          since === null ? null : since + 2 * WEEK_MS + HOUR_MS,
        ...result,
        cells: result.cells
          .map((c) => ({ ...c, h3: c.cell, ring: cellRing(c.cell) }))
          .filter((c) => c.ring),
      };
      anomalyCache.set(domain, { hour, value: answer });
      return answer;
    },
  };
}

const json = (res, status, body) => {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
};

/** `w,s,e,n` in degrees, or null. */
export function parseBox(value) {
  const parts = String(value ?? '')
    .split(',')
    .map(Number);
  if (parts.length !== 4 || !parts.every(Number.isFinite)) return null;
  const [west, south, east, north] = parts;
  if (Math.abs(south) > 90 || Math.abs(north) > 90 || south > north)
    return null;
  if (Math.abs(west) > 180 || Math.abs(east) > 180) return null;
  return [west, south, east, north];
}

/**
 * Background collection: keep the existing shared proxies warm while no map
 * layer is showing them, so history and baselines continue when layers are
 * hidden. Requests go to this server's own routes, so the proxies' caches,
 * credit governor and cooldowns apply; nothing new reaches a provider.
 * Anonymous OpenSky allows ~100 global snapshots a day (15 min); with OAuth
 * credentials, 2 min. GEV_AIRSEA_COLLECT=0 turns collection off.
 */
export function collectionPlan(env = process.env) {
  if (env.GEV_AIRSEA_COLLECT === '0') return [];
  // Credentials count only when the proxy will use them (OPENSKY_AUTH_MODE
  // anon/basic runs anonymously whatever is configured).
  const mode = String(env.OPENSKY_AUTH_MODE ?? 'oauth').toLowerCase();
  const oauth =
    mode !== 'anon' &&
    mode !== 'basic' &&
    Boolean(
      (env.OPENSKY_CLIENT_ID && env.OPENSKY_CLIENT_SECRET) ||
      env.OPENSKY_CREDENTIALS_FILE,
    );
  const minutes = Number(env.GEV_AIRSEA_AIR_MINUTES);
  return [
    {
      path: '/api/flights',
      everyMs:
        Number.isFinite(minutes) && minutes >= 1
          ? Math.min(minutes, 24 * 60) * 60_000
          : // ~29% of OAuth's 4,000 daily credits; ~48% of the anonymous
            // 400, leaving the rest to the flights layer.
            oauth
            ? 5 * 60_000
            : 30 * 60_000,
    },
    { path: '/api/military', everyMs: 5 * 60_000 },
    // Opens (or keeps) the one AISStream socket the vessel layer also uses.
    ...(env.AISSTREAM_API_KEY
      ? [{ path: '/api/vessels?maxRows=1', everyMs: 5 * 60_000 }]
      : []),
  ];
}

function startCollector(server, plan, log = console.warn) {
  const timers = [];
  // The address the server really listens on: Vite's default `localhost`
  // is ::1 only on Windows, where 127.0.0.1 is refused.
  const origin = () => {
    const address = server.httpServer?.address?.();
    if (!address || typeof address !== 'object') return null;
    const host =
      address.family === 'IPv6' || address.family === 6
        ? `[${address.address === '::' ? '::1' : address.address}]`
        : address.address === '0.0.0.0'
          ? '127.0.0.1'
          : address.address;
    return `http://${host}:${address.port}`;
  };
  for (const job of plan) {
    const run = async () => {
      const base = origin();
      if (!base) return;
      try {
        const response = await fetch(`${base}${job.path}`, {
          signal: AbortSignal.timeout(60_000),
        });
        await response.arrayBuffer();
      } catch (error) {
        log(`[airsea] collection ${job.path} failed: ${error.message}`);
      }
    };
    // First run once the server listens, then on the job's cadence.
    const first = setTimeout(run, 20_000);
    const every = setInterval(run, job.everyMs);
    first.unref?.();
    every.unref?.();
    timers.push(first, every);
  }
  return () => timers.forEach((id) => clearTimeout(id));
}

/** Collection cadence per source id, for staleness and the client's note. */
function cadence(env) {
  const plan = collectionPlan(env);
  const every = (path) =>
    plan.find((job) => job.path.startsWith(path))?.everyMs;
  return {
    opensky: every('/api/flights'),
    'adsblol-mil': every('/api/military'),
  };
}

export function airSeaEnabled(env = process.env) {
  return env.GEV_AIRSEA_ENABLED === '1';
}

/**
 * @param {{service?: object, warnings?: object, hub?: object, env?: object}}
 *   [options] `hub`: shares the services with the Autopilot (signals.js).
 */
export function airSeaProxy({
  service: supplied,
  hub = null,
  warnings: suppliedWarnings,
  env = process.env,
} = {}) {
  const enabled = airSeaEnabled(env) || Boolean(supplied);
  let service = supplied ?? null;
  let warnings = suppliedWarnings ?? null;
  const warningsEnabled = env.GEV_AIRSEA_WARNINGS !== '0';
  let listCache = null; // {key, body} of the last /warnings answer
  const ensureWarnings = () =>
    (warnings ??= warningsEnabled
      ? createWarningService({
          dir: env.GEV_AIRSEA_DIR
            ? path.resolve(env.GEV_AIRSEA_DIR)
            : path.join(process.cwd(), '.gev-cache', 'airsea'),
          env,
        })
      : null);

  async function handler(req, res) {
    if (!enabled) return json(res, 404, { enabled: false });
    if (req.method !== 'GET')
      return json(res, 405, { error: 'method_not_allowed' });
    service ??= createAirSeaService({ cadenceMs: cadence(env) });
    const url = new URL(req.url || '/', 'http://localhost');
    const route = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (route === '/status' || route === '/')
        return json(res, 200, { enabled: true, windows_ms: WINDOWS_MS });
      if (route === '/sources')
        return json(res, 200, { sources: service.sources() });
      if (route === '/footprint' || route === '/anomalies') {
        const domain = url.searchParams.get('domain');
        if (domain !== 'air' && domain !== 'sea')
          return json(res, 400, { error: 'domain must be air or sea' });
        if (!service.footprint)
          return json(res, 404, { error: 'history_disabled' });
        if (route === '/anomalies')
          return json(res, 200, service.anomalies({ domain }));
        const windowMs = Number(
          url.searchParams.get('window') ?? 12 * 3600_000,
        );
        if (!FOOTPRINT_WINDOWS_MS[domain].includes(windowMs))
          return json(res, 400, { error: 'unsupported window' });
        const resolution = Number(
          url.searchParams.get('res') ?? FOOTPRINT_RULES[domain].resolutions[0],
        );
        if (!FOOTPRINT_RULES[domain].resolutions.includes(resolution))
          return json(res, 400, {
            error: `res must be one of ${FOOTPRINT_RULES[domain].resolutions.join(', ')}`,
          });
        return json(
          res,
          200,
          service.footprint({
            domain,
            resolution,
            windowMs,
            box: parseBox(url.searchParams.get('box')),
          }),
        );
      }
      if (route === '/correlations') {
        // Traffic in every active warning area against its reference.
        if (!service.correlations)
          return json(res, 404, { error: 'history_disabled' });
        return json(res, 200, {
          correlations: service.correlations(ensureWarnings()?.list() ?? []),
        });
      }
      if (route === '/warning-sources')
        return json(res, 200, { sources: ensureWarnings()?.sources() ?? [] });
      if (route === '/warnings') {
        const svc = ensureWarnings();
        if (!svc) return json(res, 404, { error: 'warnings_disabled' });
        const domains = url.searchParams.get('domain');
        const query = {
          domains: domains ? domains.split(',').slice(0, 3) : null,
          includeEnded: url.searchParams.get('include') === 'ended',
          trial: url.searchParams.get('trial') !== '0',
        };
        // One answer per delivery and minute (statuses move with time):
        // lighter outlines for drawing; /warnings/:id keeps the full one.
        const key = JSON.stringify([
          svc.version?.(),
          Math.floor(Date.now() / 60_000),
          query,
        ]);
        if (listCache?.key !== key)
          listCache = {
            key,
            body: JSON.stringify({
              warnings: svc.list(query).map((w) => ({
                ...w,
                geometry: simplifyGeometry(w.geometry),
              })),
              sources: svc.sources(),
            }),
          };
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        return res.end(listCache.body);
      }
      if (route.startsWith('/warnings/')) {
        const svc = ensureWarnings();
        let id;
        try {
          id = decodeURIComponent(route.slice('/warnings/'.length));
        } catch {
          return json(res, 400, { error: 'bad_id' });
        }
        const found = id.length <= 160 ? svc?.detail(id) : null;
        return found
          ? json(res, 200, found)
          : json(res, 404, { error: 'unknown_warning' });
      }
      if (route === '/density') {
        const domain = url.searchParams.get('domain');
        if (domain !== 'air' && domain !== 'sea')
          return json(res, 400, { error: 'domain must be air or sea' });
        const resolution = Number(url.searchParams.get('res') ?? 2);
        if (!RESOLUTIONS.has(resolution))
          return json(res, 400, { error: 'res must be 1-4' });
        const windowMs = Number(url.searchParams.get('window') ?? 3600_000);
        if (!WINDOWS_MS.includes(windowMs))
          return json(res, 400, { error: 'unsupported window' });
        const box = parseBox(url.searchParams.get('box'));
        // Fine cells only for a bounded view: the whole globe at res 4 is
        // hundreds of thousands of cells.
        if (resolution >= 4) {
          if (!box) return json(res, 400, { error: 'res 4 needs box' });
          const width = (box[2] - box[0] + 360) % 360 || 360;
          if (
            width > MAX_FINE_BOX_DEGREES ||
            box[3] - box[1] > MAX_FINE_BOX_DEGREES
          )
            return json(res, 400, { error: 'box too large for res 4' });
        }
        return json(
          res,
          200,
          service.density({ domain, resolution, windowMs, box }),
        );
      }
      return json(res, 404, { error: 'not_found' });
    } catch (error) {
      // The reason stays in the server log: LAN clients get no local paths.
      console.warn(`[airsea] ${route} failed: ${error?.message ?? error}`);
      return json(res, 500, { error: 'internal_error' });
    }
  }

  const attach = (server) => {
    server.middlewares.use('/api/airsea', handler);
    if (!enabled || supplied) return;
    // Created now, not on the first request: it must take in every
    // collected snapshot from the start. History lives beside the warnings.
    const dir = env.GEV_AIRSEA_DIR
      ? path.resolve(env.GEV_AIRSEA_DIR)
      : path.join(process.cwd(), '.gev-cache', 'airsea');
    const history = createTrafficHistory({
      file: path.join(dir, 'traffic.sqlite'),
    });
    service ??= createAirSeaService({ cadenceMs: cadence(env), history });
    const flush = setInterval(() => {
      try {
        history.flush();
      } catch (error) {
        console.warn(`[airsea] history write failed: ${error.message}`);
      }
    }, 60_000);
    const prune = setInterval(() => {
      try {
        history.prune();
      } catch (error) {
        console.warn(`[airsea] history prune failed: ${error.message}`);
      }
    }, HOUR_MS);
    flush.unref?.();
    prune.unref?.();
    const stop = startCollector(server, collectionPlan(env));
    ensureWarnings()?.start();
    const detach = hub?.attach({ service, warnings: ensureWarnings() });
    server.httpServer?.once('close', () => {
      detach?.();
      stop();
      clearInterval(flush);
      clearInterval(prune);
      service?.close?.();
      warnings?.stop();
      history.close();
    });
  };
  return {
    name: 'airsea',
    configureServer: attach,
    configurePreviewServer: attach,
  };
}
