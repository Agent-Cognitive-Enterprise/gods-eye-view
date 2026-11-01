#!/usr/bin/env node
// Read-only measurement against the public Bluesky stream: what the fast gate
// would see if it read every post, not only listed accounts. It stores nothing
// and feeds no engine. Reports throughput, the gate's cost and pass rate, and
// the transport delay; with --samples it also writes what passed to a local
// file for a person to judge precision by hand. That file holds strangers'
// posts: keep it out of the repository and delete it afterwards.
//
//   node scripts/fast-feeds-live-probe.mjs [--minutes 5] [--samples file]

import fs from 'node:fs';
import { publicationTime } from '../server/providers/fastfeeds/adapters/bluesky.js';
import { gateReport } from '../server/providers/fastfeeds/gate.js';
import { percentile } from '../server/providers/fastfeeds/latency.js';
import { resolvePlace } from '../server/providers/fastfeeds/places.js';

const option = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : fallback;
};
const minutes = Number(option('minutes', 5));
const samplesFile = option('samples', null);
const host = option('host', 'jetstream.us-west.bsky.network');
const url = `wss://${host}/xrpc/network.bsky.jetstream.subscribeEvents?collections=app.bsky.feed.post&kinds=commit`;

const started = Date.now();
const cpuStart = process.cpuUsage();
const memory = [];
const lags = [];
const gateNs = [];
const reasons = {};
const categories = {};
const precisions = {};
let frames = 0;
let bytes = 0;
let posts = 0;
let passed = 0;
let located = 0;
const samples = samplesFile ? fs.createWriteStream(samplesFile) : null;

const ws = new WebSocket(url, ['xrpc.v1.json']);
ws.onerror = (event) => console.error('socket error', event.message ?? '');
ws.onmessage = ({ data }) => {
  frames += 1;
  bytes += data.length;
  const frame = JSON.parse(data);
  const event = frame.payload;
  if (event?.operation !== 'create' || !event.record?.text) return;
  posts += 1;
  if (event.record.reply) return;
  const lag = Date.now() - Date.parse(event.time);
  if (lags.length < 200_000) lags.push(lag);
  const begin = process.hrtime.bigint();
  const gate = gateReport(event.record.text, {
    language: event.record.langs?.[0],
  });
  const place = gate.pass ? resolvePlace(event.record.text) : null;
  gateNs.push(Number(process.hrtime.bigint() - begin));
  if (!gate.pass) {
    reasons[gate.reason] = (reasons[gate.reason] ?? 0) + 1;
    return;
  }
  passed += 1;
  const { suspect } = publicationTime(event.time, event.record.createdAt);
  categories[gate.subtype] = (categories[gate.subtype] ?? 0) + 1;
  const precision = place.location.precision;
  precisions[precision] = (precisions[precision] ?? 0) + 1;
  if (place.place_id) located += 1;
  samples?.write(
    `${JSON.stringify({
      subtype: gate.subtype,
      matched: gate.matched,
      place: place.location.place ?? null,
      precision,
      lang: gate.language,
      suspect_time: suspect,
      text: event.record.text.slice(0, 280),
    })}\n`,
  );
};

const sampler = setInterval(() => {
  memory.push(process.memoryUsage().rss / 1024 / 1024);
}, 5_000);

function report() {
  clearInterval(sampler);
  const seconds = (Date.now() - started) / 1000;
  const cpu = process.cpuUsage(cpuStart);
  const sorted = [...lags].sort((a, b) => a - b);
  const costs = [...gateNs].sort((a, b) => a - b);
  console.log(
    JSON.stringify(
      {
        seconds: Math.round(seconds),
        frames,
        frames_per_second: Math.round((frames / seconds) * 10) / 10,
        kilobytes_per_second: Math.round(bytes / 1024 / seconds),
        posts,
        top_level_posts: costs.length,
        gate_passed: passed,
        gate_pass_percent: Math.round((passed / costs.length) * 10000) / 100,
        passed_with_a_place: located,
        place_precision: precisions,
        filtered: reasons,
        subtypes: Object.fromEntries(
          Object.entries(categories).sort((a, b) => b[1] - a[1]),
        ),
        transport_delay_ms: {
          p50: percentile(sorted, 0.5),
          p95: percentile(sorted, 0.95),
          max: sorted.at(-1),
        },
        gate_cost_microseconds: {
          p50: Math.round(percentile(costs, 0.5) / 1000),
          p95: Math.round(percentile(costs, 0.95) / 1000),
          max: Math.round(costs.at(-1) / 1000),
        },
        process_cpu_percent_of_one_core:
          Math.round(((cpu.user + cpu.system) / 1e6 / seconds) * 1000) / 10,
        rss_mb: {
          max: Math.round(Math.max(...memory, 0)),
          last: Math.round(memory.at(-1) ?? 0),
        },
      },
      null,
      1,
    ),
  );
  samples?.end();
  process.exit(0);
}

setTimeout(() => {
  ws.close();
  report();
}, minutes * 60_000);
