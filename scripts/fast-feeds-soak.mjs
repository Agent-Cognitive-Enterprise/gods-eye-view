#!/usr/bin/env node
// Accelerated soak of the Fast Intelligence path: simulated hours of synthetic
// traffic, with outages, cursor replays, floods and deletions, through the real
// adapter, queue, gate and engine on real SQLite files in a temporary folder.
// The clock is simulated and the traffic made up: this measures how the code
// behaves over a long run, not how a live service does, and is no substitute
// for 24 hours against the real stream. Contacts nothing.
//
//   node scripts/fast-feeds-soak.mjs [--hours 24] [--rate 5] [--seed 7]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBlueskyAdapter } from '../server/providers/fastfeeds/adapters/bluesky.js';
import { canonicalLink } from '../server/providers/fastfeeds/gate.js';
import { createIntake } from '../server/providers/fastfeeds/intake.js';
import { createLatencyBook } from '../server/providers/fastfeeds/latency.js';
import { createPipeline } from '../server/providers/fastfeeds/pipeline.js';
import {
  deleteFrame,
  fakeSockets,
  fakeTimers,
  postFrame,
} from '../server/providers/fastfeeds/testing.mjs';
import { createIntelEngine } from '../src/intel/engine.js';
import { createSqliteIntelStore } from '../server/providers/intel/store.js';
import { AUTOPILOT_DEFAULTS } from '../src/intel/taxonomy.js';

const option = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? Number(process.argv[at + 1]) : fallback;
};
const hours = option('hours', 24);
const ratePerSecond = option('rate', 5);
const seed = option('seed', 7);
const FLOOD_EVERY_HOURS = 6;
const FLOOD_SIZE = 10_000;
const OUTAGE_EVERY_HOURS = 1;
const REPLAY_FRAMES = 200;
const PRUNE_EVERY_HOURS = 6;

// A small seeded generator, so a run can be repeated exactly.
let state = seed;
const random = () => {
  state = Math.imul(state ^ (state >>> 15), 2654435761) >>> 0;
  state = (state + 0x9e3779b9) >>> 0;
  return state / 4294967296;
};
const pick = (list) => list[Math.floor(random() * list.length)];

const CITIES = [
  'Kharkiv',
  'Kyiv',
  'Beirut',
  'Lima',
  'Manila',
  'Jakarta',
  'Dhaka',
  'Lagos',
  'Bogota',
  'Tbilisi',
  'Yerevan',
  'Khartoum',
  'Tehran',
  'Baghdad',
  'Karachi',
  'Nairobi',
  'Hanoi',
  'Caracas',
  'Athens',
  'Sofia',
];
const TOPICS = [
  'Explosions heard in',
  'Protesters and tear gas in',
  'Blackout across',
  'Flash flooding reported in',
  'Evacuation order issued for',
  'Gunfire reported near',
];
const CHATTER = [
  'Lovely weather today, nothing much going on here',
  'New recipe tried this evening and it was fine',
  'Reading a good book on the train this morning',
];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-fast-soak-'));
let clock = Date.UTC(2026, 0, 1);
const now = () => clock;
const iso = (ms) => new Date(ms).toISOString();

const dids = Array.from(
  { length: 200 },
  (_, i) => `did:plc:soakaccount${String(i).padStart(6, '0')}`,
);
const accounts = dids.map((did) => ({
  did,
  source_type: 'social_claim',
  tag: 'community',
}));
const sockets = fakeSockets();
const timers = fakeTimers();
const store = createSqliteIntelStore({
  file: path.join(dir, 'intel.sqlite'),
  now,
  warn: () => {},
});
const engine = createIntelEngine({ store, now, settings: AUTOPILOT_DEFAULTS });
const intake = createIntake({
  file: path.join(dir, 'intake.sqlite'),
  now,
  warn: () => {},
});
const latency = createLatencyBook();
const pipeline = createPipeline({
  intake,
  engine,
  latency,
  now,
  log: () => {},
  accountPostsPerMinute: 600,
});
const adapter = createBlueskyAdapter({
  accounts: () => accounts,
  intake,
  canonical: canonicalLink,
  WebSocketImpl: sockets.FakeSocket,
  now,
  log: () => {},
  setTimer: timers.setTimer,
  clearTimer: timers.clearTimer,
  random,
});

adapter.start();
sockets.last().open();

let seq = 0;
const recent = [];
const posted = [];
const makeFrame = () => {
  seq += 1;
  const relevant = random() < 0.1;
  const frame = postFrame({
    did: pick(dids),
    rkey: `soak${seq}`,
    seq,
    time: iso(clock),
    createdAt: iso(clock - 1000),
    text: relevant
      ? `${pick(TOPICS)} ${pick(CITIES)} tonight, report ${seq % 50}`
      : pick(CHATTER),
  });
  recent.push(frame);
  if (recent.length > REPLAY_FRAMES) recent.shift();
  if (relevant) {
    posted.push(frame);
    if (posted.length > 2_000) posted.shift();
  }
  return frame;
};

const started = process.hrtime.bigint();
const cpuStart = process.cpuUsage();
const hourly = [];
let peakPending = 0;
let peakPassMs = 0;

function drain() {
  timers.run();
  for (;;) {
    const before = process.hrtime.bigint();
    const handled = pipeline.pass();
    const ms = Number(process.hrtime.bigint() - before) / 1e6;
    if (handled) peakPassMs = Math.max(peakPassMs, ms);
    if (!handled) return;
  }
}

for (let hour = 0; hour < hours; hour++) {
  const hourStart = process.hrtime.bigint();
  if (hour && hour % OUTAGE_EVERY_HOURS === 0) {
    // The stream drops; the reconnect replays what was already stored.
    sockets.last().drop(1006);
    timers.run();
    sockets.last().open();
    for (const frame of recent) sockets.last().frame(frame);
  }
  if (hour && hour % FLOOD_EVERY_HOURS === 0) {
    for (let i = 0; i < FLOOD_SIZE; i++) sockets.last().frame(makeFrame());
    peakPending = Math.max(peakPending, intake.stats().pending);
  }
  for (let second = 0; second < 3600; second++) {
    clock += 1000;
    const due = Math.floor(ratePerSecond + random());
    for (let i = 0; i < due; i++) sockets.last().frame(makeFrame());
    if (random() < 0.02 && posted.length) {
      const victim = pick(posted).payload;
      seq += 1;
      sockets
        .last()
        .frame(deleteFrame({ did: victim.did, rkey: victim.rkey, seq }));
    }
    if (second % 10 === 0) {
      peakPending = Math.max(peakPending, intake.stats().pending);
      drain();
    }
  }
  drain();
  if (hour % PRUNE_EVERY_HOURS === 0) {
    intake.prune();
    store.prune();
  }
  const memory = process.memoryUsage();
  hourly.push({
    hour: hour + 1,
    real_seconds:
      Math.round(Number(process.hrtime.bigint() - hourStart) / 1e8) / 10,
    rss_mb: Math.round(memory.rss / 1048576),
    heap_mb: Math.round(memory.heapUsed / 1048576),
    active_events: engine.activeEvents(clock).length,
    stored_events: store.stats().events,
    waiting: intake.stats().pending,
  });
  const last = hourly.at(-1);
  console.log(
    `hour ${last.hour}: ${last.real_seconds}s  rss ${last.rss_mb} MB  active ${last.active_events}  stored ${last.stored_events}  waiting ${last.waiting}`,
  );
}

adapter.stop();
drain();
const seconds = Number(process.hrtime.bigint() - started) / 1e9;
const cpu = process.cpuUsage(cpuStart);
const counters = intake.counters().bluesky ?? {};
const summary = latency.summary().bluesky ?? {};
const sizes = fs
  .readdirSync(dir)
  .map((name) => [
    name,
    Math.round(fs.statSync(path.join(dir, name)).size / 1024),
  ]);
console.log(
  JSON.stringify(
    {
      synthetic: true,
      simulated_hours: hours,
      frames: seq,
      real_seconds: Math.round(seconds),
      frames_per_real_second: Math.round(seq / seconds),
      cpu_seconds: Math.round((cpu.user + cpu.system) / 1e6),
      peak_pending: peakPending,
      slowest_pass_ms: Math.round(peakPassMs),
      counters,
      pipeline_ms: summary.pipeline ?? null,
      first_hour: hourly[0],
      last_hour: hourly.at(-1),
      reconnects: adapter.health().reconnects,
      file_sizes_kb: Object.fromEntries(sizes),
      still_waiting: intake.stats().pending,
    },
    null,
    1,
  ),
);
intake.close();
store.close();
fs.rmSync(dir, { recursive: true, force: true });
