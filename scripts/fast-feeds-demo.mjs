#!/usr/bin/env node
// One-command dry run of Fast Intelligence: a synthetic scenario walks through
// the real engine with a simulated clock, printing what the operator would see
// at each step. Contacts nothing, writes nothing, alerts nobody.
//
//   node scripts/fast-feeds-demo.mjs

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fastStatus } from '../src/intel/fastStatus.js';
import { createReplay } from '../src/intel/replay.js';
import { AUTOPILOT_DEFAULTS } from '../src/intel/taxonomy.js';

const scenario = JSON.parse(
  fs.readFileSync(
    fileURLToPath(
      new URL(
        '../server/providers/intel/fixtures/fast-feed-scenario.json',
        import.meta.url,
      ),
    ),
    'utf8',
  ),
);

const base = Date.UTC(2026, 0, 1, 12, 0, 0);
const replay = createReplay({
  scenario,
  base,
  settings: AUTOPILOT_DEFAULTS,
});

console.log('SYNTHETIC DRILL. No real account, report or event.\n');
const state = (event) =>
  `${fastStatus(event).padEnd(12)} conf ${event.confidence.toFixed(2)}  attn ${String(
    event.attention_score,
  ).padStart(3)}  camera ${event.camera_eligible ? 'yes' : 'no '}  critical ${
    event.critical_qualified ? 'yes' : 'no '
  }`;
const seen = new Map();
for (let minute = 0; minute <= scenario.duration_min; minute++) {
  replay.advanceTo(base + minute * 60_000);
  const at = replay.now();
  for (const stored of replay.store.listEvents({}, { limit: 50 })) {
    const event = replay.engine.evaluate(stored, at);
    const line = state(event);
    const key = `${fastStatus(event)}|${event.camera_eligible}`;
    if (seen.get(event.event_id) === key) continue;
    seen.set(event.event_id, key);
    console.log(`+${String(minute).padStart(2)} min  ${line}  ${event.title}`);
  }
}
console.log('\nEvery event above ran through the same engine as live data.');
