// Same-origin early-warning routes under /api/intel. Off unless
// GEV_INTEL_ENABLED=1: when off, only /status answers (enabled: false) and no
// feed is contacted. Construction never fetches; feeds start with the server
// and stop when it closes. Reads are public-source data and may be served to
// the LAN like the rest of the app; every mutation (replay, settings, flags,
// history erase, manual poll) is accepted from this machine only.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRequestBody } from '../common/request.js';
import { acledConnector } from './connectors/acled.js';
import { eonetConnector } from './connectors/eonet.js';
import { gdacsConnector } from './connectors/gdacs.js';
import { gdeltConnector } from './connectors/gdelt.js';
import { ghostMapsConnector } from './connectors/ghostMaps.js';
import { nwsConnector } from './connectors/nws.js';
import { reliefWebConnector } from './connectors/reliefWeb.js';
import { tsunamiConnector } from './connectors/tsunami.js';
import { usgsConnector } from './connectors/usgs.js';
import { whoConnector } from './connectors/who.js';
import { worldBankConnector } from './connectors/worldBank.js';
import { createLocalLlm } from './localLlm.js';
import { createIntelService } from './service.js';

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
);
const MAX_BODY = 16 * 1024;

/**
 * The feed set for this environment. Public no-key feeds are on unless
 * GEV_INTEL_<NAME>=0; GDELT (machine-coded news) is opt-in with
 * GEV_INTEL_GDELT=1; ReliefWeb and ACLED are listed and wait for credentials.
 * GEV_INTEL_OFFLINE=1 contacts no feed at all: drills and the stored archive
 * only (CI, demonstrations, air-gapped use).
 */
export function intelConnectors({ env = process.env, ghostMapsWatcher } = {}) {
  if (env.GEV_INTEL_OFFLINE === '1') return [];
  const on = (name) => env[`GEV_INTEL_${name}`] !== '0';
  const connectors = [];
  if (on('USGS')) connectors.push(usgsConnector());
  if (on('GDACS')) connectors.push(gdacsConnector());
  if (on('TSUNAMI'))
    connectors.push(tsunamiConnector('ptwc'), tsunamiConnector('ntwc'));
  if (on('NWS')) connectors.push(nwsConnector());
  if (on('EONET')) connectors.push(eonetConnector());
  if (on('WHO')) connectors.push(whoConnector());
  if (on('WORLDBANK')) connectors.push(worldBankConnector());
  if (on('RELIEFWEB'))
    connectors.push(
      reliefWebConnector({ appname: env.GEV_RELIEFWEB_APPNAME ?? '' }),
    );
  if (on('ACLED'))
    connectors.push(
      acledConnector({
        email: env.GEV_ACLED_EMAIL ?? '',
        key: env.GEV_ACLED_KEY ?? '',
      }),
    );
  if (env.GEV_INTEL_GDELT === '1') connectors.push(gdeltConnector());
  if (ghostMapsWatcher && on('GHOSTMAPS'))
    connectors.push(ghostMapsConnector({ watcher: ghostMapsWatcher }));
  return connectors;
}

/** Whether the early-warning feature flag is on. */
export function intelEnabled(env = process.env) {
  return env.GEV_INTEL_ENABLED === '1';
}

/** Loopback, unproxied, same-origin: the only callers allowed to change state. */
export function isLocalMutation(req) {
  const address = String(req.socket?.remoteAddress ?? '');
  const loopback =
    address === '::1' ||
    /^127\./.test(address) ||
    /^::ffff:127\./.test(address);
  if (!loopback) return false;
  const headers = req.headers ?? {};
  if (headers['x-forwarded-for'] || headers.forwarded || headers['x-real-ip'])
    return false;
  if (headers.origin) {
    try {
      if (new URL(headers.origin).host !== headers.host) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function loadScenarios() {
  const scenarios = {};
  try {
    for (const name of fs.readdirSync(FIXTURES))
      if (/^[a-z0-9-]+-scenario\.json$/.test(name)) {
        const scenario = JSON.parse(
          fs.readFileSync(path.join(FIXTURES, name), 'utf8'),
        );
        scenarios[scenario.id] = scenario;
      }
  } catch {
    /* no fixtures */
  }
  return scenarios;
}

const parseBbox = (value) => {
  const parts = String(value ?? '')
    .split(',')
    .map(Number);
  if (parts.length !== 4 || !parts.every(Number.isFinite)) return null;
  const [west, south, east, north] = parts;
  return { west, south, east, north };
};

/**
 * @param {{ghostMapsWatcher?: object, service?: object, env?: object}} [options]
 */
export function intelProxy({
  ghostMapsWatcher,
  service: supplied,
  env = process.env,
} = {}) {
  const enabled = intelEnabled(env) || Boolean(supplied);
  let service = supplied ?? null;
  const ensure = () => {
    if (service || !enabled) return service;
    const root = process.cwd();
    // GEV_INTEL_DB moves the whole state (store and settings), so a second
    // instance, CI or a smoke run never shares an operator's settings.
    const dir = env.GEV_INTEL_DB
      ? path.dirname(path.resolve(env.GEV_INTEL_DB))
      : path.join(root, '.gev-cache', 'intel');
    const connectors = intelConnectors({ env, ghostMapsWatcher });
    service = createIntelService({
      storeFile: env.GEV_INTEL_DB || path.join(dir, 'intel.sqlite'),
      settingsFile: path.join(dir, 'settings.json'),
      connectors,
      scenarios: loadScenarios(),
      // Loopback-only local model; GEV_LLM_DISABLED=1 keeps scoring rule-based.
      llm:
        env.GEV_LLM_DISABLED === '1'
          ? null
          : createLocalLlm({ baseUrl: env.GEV_LLM_BASE_URL }),
    });
    return service;
  };

  const json = (res, status, value) => {
    if (res.destroyed) return;
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(value));
  };

  async function body(req) {
    if (
      !/^application\/json\b/i.test(String(req.headers['content-type'] ?? ''))
    )
      return {};
    try {
      return JSON.parse((await readRequestBody(req, MAX_BODY)) || '{}');
    } catch {
      return null;
    }
  }

  async function handler(req, res) {
    const url = new URL(req.url || '/', 'http://local');
    const route = url.pathname.replace(/\/+$/, '') || '/';
    if (route === '/status' && req.method === 'GET')
      return json(res, 200, enabled ? ensure().status() : { enabled: false });
    if (!enabled) return json(res, 404, { error: 'intel_disabled' });
    const svc = ensure();
    const worldName =
      url.searchParams.get('world') === 'replay' ? 'replay' : 'live';

    if (req.method === 'GET') {
      if (route === '/events') {
        const list = svc.listEvents(worldName, {
          minScore: Number(url.searchParams.get('min_score')) || 0,
        });
        return list
          ? json(res, 200, list)
          : json(res, 404, { error: 'no_replay' });
      }
      const detail = /^\/events\/(evt_[0-9a-f]{1,32})$/.exec(route);
      if (detail) {
        const found = svc.eventDetail(worldName, detail[1]);
        return found
          ? json(res, 200, found)
          : json(res, 404, { error: 'unknown_event' });
      }
      if (route === '/archive') {
        const since = Date.parse(url.searchParams.get('since') ?? '');
        const until = Date.parse(url.searchParams.get('until') ?? '');
        return json(res, 200, {
          events: svc.archive(
            {
              category: url.searchParams.get('category') || undefined,
              provider: url.searchParams.get('provider') || undefined,
              since: Number.isFinite(since) ? since : undefined,
              until: Number.isFinite(until) ? until : undefined,
              bbox: parseBbox(url.searchParams.get('bbox')),
            },
            Math.min(
              500,
              Math.max(1, Number(url.searchParams.get('limit')) || 100),
            ),
          ),
        });
      }
      if (route === '/feeds') return json(res, 200, { feeds: svc.feeds() });
      if (route === '/ai') return json(res, 200, svc.aiStatus());
      if (route === '/settings') return json(res, 200, svc.settings());
      if (route === '/replay')
        return json(res, 200, { replay: svc.replayStatus() });
      return json(res, 404, { error: 'unknown_route' });
    }

    if (!isLocalMutation(req)) return json(res, 403, { error: 'local_only' });
    const input = await body(req);
    if (input === null) return json(res, 400, { error: 'bad_json' });
    if (route === '/settings' && req.method === 'PUT')
      return json(res, 200, svc.updateSettings(input));
    if (route === '/settings' && req.method === 'DELETE')
      return json(res, 200, svc.resetSettings());
    if (route === '/replay' && req.method === 'POST') {
      const started = svc.startReplay(String(input.scenario ?? 'demo'), {
        speed: input.speed,
      });
      return started
        ? json(res, 200, started)
        : json(res, 404, { error: 'unknown_scenario' });
    }
    if (route === '/replay' && req.method === 'DELETE') {
      svc.stopReplay();
      return json(res, 200, { replay: null });
    }
    if (route === '/ai/assess' && req.method === 'POST') {
      const outcome = await svc.assessNow();
      return json(res, 200, { outcome, ai: svc.aiStatus() });
    }
    const poll = /^\/feeds\/([a-z0-9-]{1,40})\/poll$/.exec(route);
    if (poll && req.method === 'POST') {
      const pending = svc.pollFeed(poll[1]);
      if (!pending) return json(res, 404, { error: 'unknown_feed' });
      await pending;
      return json(res, 200, { feeds: svc.feeds() });
    }
    const flag = /^\/events\/(evt_[0-9a-f]{1,32})\/flag$/.exec(route);
    if (flag && req.method === 'POST') {
      svc.flagMerge(flag[1], input.observation_id, input.note);
      return json(res, 200, { flagged: true });
    }
    if (route === '/history' && req.method === 'DELETE') {
      svc.clearHistory();
      return json(res, 200, { cleared: true });
    }
    return json(res, 405, { error: 'method_not_allowed' });
  }

  const attach = (server) => {
    server.middlewares.use('/api/intel', handler);
    if (!enabled) return;
    ensure().start();
    server.httpServer?.once('close', () => service?.close());
  };

  return {
    name: 'intel',
    configureServer: attach,
    configurePreviewServer: attach,
  };
}
