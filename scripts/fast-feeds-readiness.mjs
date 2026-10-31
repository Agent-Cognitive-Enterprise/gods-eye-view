#!/usr/bin/env node
// Summarises a staging run from its monitor log, for the deployment readiness
// report: availability, delay, memory and disk growth, and whether isolation held.
//
//   node scripts/fast-feeds-readiness.mjs --state <folder>

import fs from 'node:fs';
import path from 'node:path';

const at = process.argv.indexOf('--state');
const stateDir = path.resolve(process.argv[at + 1] ?? '.');
const rows = fs
  .readFileSync(path.join(stateDir, 'monitor.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line));

const first = rows[0];
const last = rows.at(-1);
const hours = (Date.parse(last.at) - Date.parse(first.at)) / 3600_000;
const up = rows.filter((row) => row.up);
const healthy = rows.filter((row) => row.status === 'healthy');
const largest = (name) =>
  Math.max(...rows.map((row) => row.sizes_kb?.[name] ?? 0));
const slope = (values) =>
  values.length > 1
    ? Math.round(((values.at(-1) - values[0]) / Math.max(hours, 0.01)) * 10) /
      10
    : null;
const rss = rows.map((row) => row.rss_mb).filter(Number.isFinite);
const liveRows = rows.filter((row) => row.live?.ais);

console.log(
  JSON.stringify(
    {
      window: {
        from: first.at,
        to: last.at,
        hours: Math.round(hours * 10) / 10,
      },
      samples: rows.length,
      server_answered_percent:
        Math.round((up.length / rows.length) * 1000) / 10,
      feed_healthy_percent:
        Math.round((healthy.length / rows.length) * 1000) / 10,
      reconnects: last.reconnects,
      last_error: last.last_error,
      counters: last.counters,
      latency: last.latency,
      polled: last.polled,
      queue_peak: Math.max(0, ...rows.map((row) => row.queue ?? 0)),
      dead_letters: last.dead_letters,
      telegram: last.telegram,
      memory_mb: {
        first: rss[0],
        peak: Math.max(...rss),
        last: rss.at(-1),
        per_hour: slope(rss),
      },
      cpu_seconds: last.cpu_seconds,
      disk: {
        free_gb_first: first.disk_free_gb,
        free_gb_last: last.disk_free_gb,
        intake_mb: Math.round(largest('fast-intake.sqlite') / 1024),
        intel_mb: Math.round(largest('intel.sqlite') / 1024),
      },
      live_instance: {
        samples: liveRows.length,
        ais_live_percent:
          Math.round(
            (liveRows.filter((row) => row.live.ais === 'live').length /
              Math.max(1, liveRows.length)) *
              1000,
          ) / 10,
        worst_reconnect_attempt: Math.max(
          0,
          ...liveRows.map((row) => row.live.reconnects ?? 0),
        ),
      },
      supervised_percent:
        Math.round(
          (rows.filter((row) => row.supervised).length / rows.length) * 1000,
        ) / 10,
      tripwire: fs.existsSync(path.join(stateDir, 'TRIPWIRE.txt')),
    },
    null,
    1,
  ),
);
