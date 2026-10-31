#!/usr/bin/env node
// Records a staging run for the readiness report, one line a minute, and asks for
// events the way the console does, so the time to the map is measured. Reads the
// live instance's public status only: it changes nothing there.
//
//   node scripts/gev-staging-monitor.mjs --state <folder> [--port 4178]
//        [--hours 24] [--live-port 4174]

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const option = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : fallback;
};
const stateDir = path.resolve(option('state', ''));
const port = Number(option('port', 4178));
const livePort = Number(option('live-port', 4174));
const hours = Number(option('hours', 24));
const logFile = path.join(stateDir, 'monitor.jsonl');
const started = Date.now();

const getJson = async (url, timeoutMs = 20_000) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  // A vessel answer can be 503 with a useful body.
  return response.json();
};

async function memoryMb(pid) {
  const { stdout } = await run(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$p=Get-Process -Id ${pid}; "$($p.WorkingSet64) $($p.CPU)"; (Get-PSDrive C).Free`,
    ],
    { windowsHide: true },
  );
  const [memory, free] = stdout.trim().split(/\r?\n/);
  const [workingSet, cpu] = memory.split(' ').map(Number);
  return {
    rss_mb: Math.round(workingSet / 1048576),
    cpu_seconds: Math.round(cpu),
    disk_free_gb: Math.round((Number(free) / 1073741824) * 10) / 10,
  };
}

const stateSizes = () =>
  Object.fromEntries(
    fs
      .readdirSync(stateDir)
      .filter((name) => name.includes('.sqlite'))
      .map((name) => [
        name,
        Math.round(fs.statSync(path.join(stateDir, name)).size / 1024),
      ]),
  );

async function sample() {
  const row = { at: new Date().toISOString() };
  try {
    const status = await getJson(
      `http://127.0.0.1:${port}/api/intel/fast/status`,
    );
    const [bluesky] = status.sources;
    Object.assign(row, {
      up: true,
      status: bluesky.status,
      connected: bluesky.connected,
      reconnects: bluesky.reconnects,
      last_error: bluesky.last_error,
      last_report_at: bluesky.last_report_at,
      cursor: bluesky.cursor,
      counters: bluesky.counters,
      latency: bluesky.latency,
      telegram: status.sources[1]?.status,
      queue: status.queue.pending,
      dead_letters: status.dead_letters.length,
      polled: status.polled.map((feed) => ({
        id: feed.id,
        status: feed.status,
        latency: feed.latency?.publish_to_receive ?? null,
      })),
    });
  } catch (error) {
    Object.assign(row, { up: false, error: error.message });
  }
  try {
    const pid = Number(
      fs.readFileSync(path.join(stateDir, 'server.pid'), 'utf8'),
    );
    Object.assign(row, await memoryMb(pid), { sizes_kb: stateSizes() });
  } catch (error) {
    row.process_error = error.message;
  }
  try {
    const live = await getJson(
      `http://127.0.0.1:${livePort}/api/vessels?lamin=-1&lamax=1&lomin=-1&lomax=1`,
    );
    row.live = {
      ais: live.status,
      reconnects: live.reconnectAttempt,
      silent_ms: Math.round(live.silentForMs ?? -1),
    };
  } catch (error) {
    row.live = { error: error.message };
  }
  fs.appendFileSync(logFile, `${JSON.stringify(row)}\n`);
}

// As the console does: a map client asking every ten seconds.
const asker = setInterval(() => {
  fetch(`http://127.0.0.1:${port}/api/intel/events`, {
    signal: AbortSignal.timeout(9_000),
  }).catch(() => {});
}, 10_000);

await sample();
const sampler = setInterval(() => {
  sample().catch(() => {});
  if (Date.now() - started >= hours * 3600_000) {
    clearInterval(sampler);
    clearInterval(asker);
    fs.writeFileSync(
      path.join(stateDir, 'MONITOR-COMPLETE.txt'),
      `${new Date().toISOString()}\n`,
    );
    process.exit(0);
  }
}, 60_000);
