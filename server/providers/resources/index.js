// Fork: /api/resources for the RESOURCES panel. GET reports the server's own
// figures, its background jobs, the cache on disk and recent changes; POSTs
// turn a switchable job off or on, or restore the defaults, and are accepted
// from this computer only (isLocalMutation: loopback, no proxy headers, a
// same-origin Origin), as the Autopilot's settings are.

import os from 'node:os';
import path from 'node:path';
import { readRequestBody } from '../common/request.js';
import { isLocalMutation } from '../intel/index.js';
import { createDiskSizes } from './disk.js';
import { createResourceRegistry } from './registry.js';
import { createSampler } from './sampler.js';

const MAX_BODY = 1024;

/**
 * The registry and sampler the plugins share (local.js creates one set).
 * @param {{dir?: string, env?: object}} [options]
 */
export function createResourceMonitor({ dir, env = process.env } = {}) {
  const cacheDir = dir ?? path.join(process.cwd(), '.gev-cache');
  const sampler = createSampler();
  const registry = createResourceRegistry({
    file: env.GEV_RESOURCES_FILE
      ? path.resolve(env.GEV_RESOURCES_FILE)
      : path.join(cacheDir, 'resources', 'off.json'),
    measure: (since, until) => sampler.average(since, until),
  });
  const disk = createDiskSizes({ dir: cacheDir });
  return { sampler, registry, disk };
}

function sendJson(res, status, value) {
  if (res.destroyed) return;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(value));
}

/**
 * @param {{monitor: ReturnType<typeof createResourceMonitor>}} options
 */
export function resourcesProxy({ monitor }) {
  const { sampler, registry, disk } = monitor;

  function snapshot(req) {
    sampler.start();
    return {
      server: {
        pid: process.pid,
        node: process.version,
        uptime_s: Math.round(process.uptime()),
        cores: sampler.cores,
        platform: os.platform(),
        latest: sampler.latest(),
        history: sampler.history(),
      },
      jobs: registry.list(),
      changes: registry.changes(),
      disk: disk.current(),
      // Only this computer may switch jobs; others see the figures.
      can_control: isLocalMutation(req),
    };
  }

  async function handler(req, res) {
    try {
      const url = new URL(req.url || '/', 'http://local');
      const route = url.pathname.replace(/\/+$/, '') || '/';
      if (req.method === 'GET') {
        if (route === '/') return sendJson(res, 200, snapshot(req));
        return sendJson(res, 404, { error: 'unknown_route' });
      }
      if (req.method !== 'POST')
        return sendJson(res, 405, { error: 'method_not_allowed' });
      if (!isLocalMutation(req))
        return sendJson(res, 403, { error: 'local_only' });
      let input;
      try {
        input = JSON.parse((await readRequestBody(req, MAX_BODY)) || '{}');
      } catch {
        return sendJson(res, 400, { error: 'bad_json' });
      }
      if (route === '/restore') {
        const restored = registry.restoreDefaults();
        return sendJson(res, 200, { restored, jobs: registry.list() });
      }
      // The panel sends the id encoded (intel%3Ausgs); decode it before
      // matching. A malformed escape is simply an unknown route.
      let decoded = null;
      try {
        decoded = decodeURIComponent(route);
      } catch {
        decoded = null;
      }
      const job = decoded
        ? /^\/jobs\/([a-z0-9][a-z0-9:._-]{0,79})$/.exec(decoded)
        : null;
      if (job) {
        if (typeof input?.enabled !== 'boolean')
          return sendJson(res, 400, { error: 'enabled_must_be_boolean' });
        const outcome = registry.setEnabled(job[1], input.enabled);
        const status = { ok: 200, unknown: 404, fixed: 409, failed: 500 }[
          outcome
        ];
        return sendJson(res, status, { outcome, jobs: registry.list() });
      }
      return sendJson(res, 404, { error: 'unknown_route' });
    } catch (error) {
      console.warn('[resources] request failed:', error?.message ?? error);
      if (!res.headersSent)
        return sendJson(res, 500, { error: 'internal_error' });
      res.end();
    }
  }

  const attach = (server) => {
    server.middlewares.use('/api/resources', handler);
    server.httpServer?.once('close', () => sampler.stop());
  };
  return {
    name: 'resources',
    configureServer: attach,
    configurePreviewServer: attach,
  };
}
