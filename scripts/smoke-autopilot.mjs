#!/usr/bin/env node
// Smoke test for a running Autopilot instance (dev or production preview),
// run on the host after a start or deployment:
//
//   node scripts/smoke-autopilot.mjs [--url http://127.0.0.1:4174] [--json]
//     [--require-ai] [--require-voice] [--no-drill]
//
// Fails on what this build controls: the page, the /api/intel routes and a
// short demo drill. Feed outages, a stopped local model or voice sidecar are
// reported as warnings (they are environment), unless --require-ai or
// --require-voice says the deployment needs them. The drill is skipped when
// one is already running so an operator's session is never interrupted.

import { pathToFileURL } from 'node:url';
import path from 'node:path';

const TIMEOUT_MS = 15_000;

function parseArgs(argv) {
  const options = {
    url: 'http://127.0.0.1:4174',
    json: false,
    requireAi: false,
    requireVoice: false,
    drill: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--url') options.url = String(argv[++i] ?? '');
    else if (arg === '--json') options.json = true;
    else if (arg === '--require-ai') options.requireAi = true;
    else if (arg === '--require-voice') options.requireVoice = true;
    else if (arg === '--no-drill') options.drill = false;
    else throw new Error(`unknown argument ${arg}`);
  }
  options.url = options.url.replace(/\/+$/, '');
  if (!/^https?:\/\/[^/]+$/.test(options.url))
    throw new Error('--url must be an origin such as http://127.0.0.1:4174');
  return options;
}

/** Run the checks against `base`; `fetchImpl` is injectable for tests. */
export async function smoke(
  { url, requireAi = false, requireVoice = false, drill = true },
  fetchImpl = globalThis.fetch,
) {
  const checks = [];
  const record = (name, level, detail = '') =>
    checks.push({ name, level, detail });
  const request = async (route, init = {}) => {
    const response = await fetchImpl(`${url}${route}`, {
      ...init,
      headers: { Accept: 'application/json', ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await response.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: response.status, body };
  };
  const step = async (name, fn) => {
    try {
      await fn();
    } catch (error) {
      record(name, 'fail', String(error?.message ?? error).slice(0, 200));
    }
  };

  await step('page loads', async () => {
    const { status, body } = await request('/', {
      headers: { Accept: 'text/html' },
    });
    const ok = status === 200 && /<title>/i.test(String(body));
    record('page loads', ok ? 'pass' : 'fail', `HTTP ${status}`);
  });

  let enabled = false;
  await step('early-warning engine enabled', async () => {
    const { status, body } = await request('/api/intel/status');
    enabled = status === 200 && body?.enabled === true;
    record(
      'early-warning engine enabled',
      enabled ? 'pass' : 'fail',
      enabled
        ? `${body.store?.events ?? '?'} stored events`
        : `HTTP ${status}, enabled ${body?.enabled}`,
    );
  });
  if (!enabled) return summarize(checks);

  await step('feeds', async () => {
    const { status, body } = await request('/api/intel/feeds');
    if (status !== 200 || !Array.isArray(body?.feeds))
      return record('feeds', 'fail', `HTTP ${status}`);
    const by = {};
    for (const feed of body.feeds) (by[feed.status] ??= []).push(feed.id);
    const down = [...(by.offline ?? []), ...(by.degraded ?? [])];
    record(
      'feeds',
      down.length ? 'warn' : 'pass',
      body.feeds.length
        ? Object.entries(by)
            .map(([s, ids]) => `${s}: ${ids.length}`)
            .join(', ') + (down.length ? ` (check ${down.join(', ')})` : '')
        : 'none configured (offline mode)',
    );
  });

  await step('live events and archive', async () => {
    const live = await request('/api/intel/events');
    const archive = await request('/api/intel/archive?limit=5');
    const ok =
      live.status === 200 &&
      archive.status === 200 &&
      Array.isArray(archive.body?.events);
    record(
      'live events and archive',
      ok ? 'pass' : 'fail',
      ok
        ? `${live.body?.events?.length ?? 0} active, archive answers`
        : `HTTP ${live.status}/${archive.status}`,
    );
  });

  if (drill)
    await step('demo drill', async () => {
      const current = await request('/api/intel/replay');
      if (current.body?.replay)
        return record(
          'demo drill',
          'warn',
          'a drill is already running; not interrupted',
        );
      const started = await request('/api/intel/replay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenario: 'demo', speed: 600 }),
      });
      if (started.status !== 200)
        return record(
          'demo drill',
          'fail',
          `start: HTTP ${started.status} ${started.body?.error ?? ''}`,
        );
      try {
        await new Promise((resolve) => setTimeout(resolve, 2500));
        const events = await request('/api/intel/events?world=replay');
        const count = events.body?.events?.length ?? 0;
        const synthetic = (events.body?.events ?? []).every((e) => e.synthetic);
        record(
          'demo drill',
          count > 0 && synthetic ? 'pass' : 'fail',
          `${count} drill events, ${events.body?.clusters?.length ?? 0} clusters${synthetic ? '' : ', non-synthetic event in drill world'}`,
        );
      } finally {
        await request('/api/intel/replay', { method: 'DELETE' });
      }
    });

  await step('local model', async () => {
    const { status, body } = await request('/api/intel/ai');
    const online = status === 200 && body?.state === 'online';
    record(
      'local model',
      online ? 'pass' : requireAi ? 'fail' : 'warn',
      status === 200
        ? `${body.state}${body.model ? ` · ${body.model}` : ''}${body.last_error ? ` · ${body.last_error}` : ''}`
        : `HTTP ${status}`,
    );
  });

  await step('local voice', async () => {
    const { status, body } = await request('/api/voice-local/status');
    if (status !== 200 || body?.enabled !== true)
      return record(
        'local voice',
        requireVoice ? 'fail' : 'warn',
        'not enabled',
      );
    const ready =
      body.stt?.available &&
      body.tts?.available &&
      body.llm?.state === 'online';
    record(
      'local voice',
      ready ? 'pass' : requireVoice ? 'fail' : 'warn',
      `speech-to-text ${body.stt?.available ? 'up' : 'down'}, text-to-speech ${body.tts?.available ? (body.tts.languages ?? []).join('/') : 'down'}, model ${body.llm?.state}`,
    );
  });
  return summarize(checks);
}

function summarize(checks) {
  return {
    ok: checks.every((c) => c.level !== 'fail'),
    checks,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = await smoke(options);
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else {
      for (const c of result.checks)
        console.log(
          `${c.level.toUpperCase().padEnd(5)} ${c.name}${c.detail ? `  (${c.detail})` : ''}`,
        );
      console.log(result.ok ? 'Smoke test passed.' : 'Smoke test FAILED.');
    }
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    console.error(`smoke-autopilot: ${error.message}`);
    process.exitCode = 2;
  }
}
