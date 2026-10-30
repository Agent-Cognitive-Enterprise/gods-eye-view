// Air/sea density service and routes (fork feature). Reads the snapshots the
// existing OpenSky/adsb.lol proxies already fetched (bus.js) and the vessel
// store the AISStream socket already fills; serves H3 cell counts with the
// health of every feed behind them. Read-only routes, safe for LAN viewers.

import {
  aggregateCells,
  aircraftFromReadsb,
  aircraftFromStates,
  createTrafficTracker,
  vesselsFromAisRows,
} from '../../../src/airsea/aggregate.js';
import {
  TRAFFIC_SOURCES,
  domainCoverage,
  sourceStatus,
} from '../../../src/airsea/sources.js';
import { AISSTREAM_CACHE_MAX, aisStreamRows } from '../vessels/ais-store.js';
import path from 'node:path';
import { subscribeTrafficSnapshots, trafficSnapshotsSince } from './bus.js';
import { createWarningService } from './warnings.js';

export const WINDOWS_MS = Object.freeze([
  15 * 60_000,
  3600_000,
  6 * 3600_000,
  24 * 3600_000,
]);
const AIS_READ_EVERY_MS = 30_000;
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
} = {}) {
  const tracker = createTrafficTracker();
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
    else if (t - lastAisAt >= AIS_READ_EVERY_MS) {
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
          ? minutes * 60_000
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

/** @param {{service?: object, env?: object}} [options] */
export function airSeaProxy({
  service: supplied,
  warnings: suppliedWarnings,
  env = process.env,
} = {}) {
  const enabled = airSeaEnabled(env) || Boolean(supplied);
  let service = supplied ?? null;
  let warnings = suppliedWarnings ?? null;
  const warningsEnabled = env.GEV_AIRSEA_WARNINGS !== '0';
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
      if (route === '/warning-sources')
        return json(res, 200, { sources: ensureWarnings()?.sources() ?? [] });
      if (route === '/warnings') {
        const svc = ensureWarnings();
        if (!svc) return json(res, 404, { error: 'warnings_disabled' });
        const domains = url.searchParams.get('domain');
        return json(res, 200, {
          warnings: svc.list({
            domains: domains ? domains.split(',').slice(0, 3) : null,
            includeEnded: url.searchParams.get('include') === 'ended',
          }),
          sources: svc.sources(),
        });
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
      return json(res, 500, { error: String(error?.message ?? error) });
    }
  }

  const attach = (server) => {
    server.middlewares.use('/api/airsea', handler);
    if (!enabled || supplied) return;
    // Created now, not on the first request: it must take in every
    // collected snapshot from the start.
    service ??= createAirSeaService({ cadenceMs: cadence(env) });
    const stop = startCollector(server, collectionPlan(env));
    ensureWarnings()?.start();
    server.httpServer?.once('close', () => {
      stop();
      service?.close?.();
      warnings?.stop();
    });
  };
  return {
    name: 'airsea',
    configureServer: attach,
    configurePreviewServer: attach,
  };
}
