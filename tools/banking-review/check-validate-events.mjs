// Regression check for validate-events.mjs: earlier decisions are immutable
// unless a dated correction with a reason and evidence records the change.
// Usage: node check-validate-events.mjs <appRoot>
// (named check-*, not *.test.mjs: it is a host check, not part of the app's
// unit suite). Exits 1 on the first failed case.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = process.argv[2] ?? 'C:\\Users\\user\\gev-fast';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-validate-'));
const DATE = '2026-11-11';
const write = (name, value) => {
  const f = path.join(dir, name);
  fs.writeFileSync(f, JSON.stringify(value, null, 2));
  return f;
};
const liveEvent = {
  id: 'live-1',
  country_code: 'PSE',
  country_name: 'Palestine',
  event_type: 'technical_outage',
  severity: 2,
  confidence: 'social',
  start_time: '2026-11-01T00:00:00Z',
  last_verified_time: '2026-11-10T00:00:00Z',
  affected_people_est: null,
  affected_population_pct: null,
  affected_basis: 'Not given by any source.',
  summary: 'A live event.',
  sources: [{ title: 'S', url: 'https://example.org/live-1' }],
};
const hostEvents = write('host-events.json', { events: [liveEvent] });
let events = write('events.json', { events: [liveEvent] });
const rejected = { decision: 'rejected', reason: 'Not a disruption.', url: 'https://example.org/a', title: 'A', reviewedAt: '2026-11-10', eventId: null };
const pending = { decision: 'pending', reason: 'Unconfirmed.', url: 'https://example.org/b', title: 'B', reviewedAt: '2026-11-10', eventId: null };
const host = write('host.json', { leads: { a: rejected, b: pending } });
const leadsToday = (fresh) => write('today.json', { date: DATE, fresh: fresh.map((id) => ({ id })) });

function run(work, fresh = []) {
  const workFile = write('work.json', work);
  try {
    const out = execFileSync(process.execPath, [path.join(here, 'validate-events.mjs'), appRoot, events, workFile, host, leadsToday(fresh), hostEvents], { encoding: 'utf8' });
    return { ok: true, ...JSON.parse(out) };
  } catch (e) {
    return { ok: false, ...JSON.parse(e.stdout) };
  }
}
const confirmed = { ...rejected, decision: 'confirmed', reason: 'Central bank notice.', reviewedAt: DATE };
const correction = (over = {}) => ({
  id: 'a',
  at: DATE,
  from: rejected,
  to: confirmed,
  reason: 'The central bank confirmed the freeze on 10 November.',
  evidence: ['https://example.org/central-bank-notice'],
  ...over,
});
const cases = [
  ['unchanged decisions pass', () => assert.equal(run({ leads: { a: rejected, b: pending } }).ok, true)],
  ['a key-order change only is not a change', () => {
    const reordered = Object.fromEntries(Object.entries(rejected).reverse());
    assert.equal(run({ leads: { a: reordered, b: pending } }).ok, true);
  }],
  ['an earlier decision changed silently fails', () => {
    const r = run({ leads: { a: confirmed, b: pending } });
    assert.equal(r.ok, false);
    assert.match(r.problems.join(' '), /earlier decision a was changed without a correction/);
  }],
  ['only metadata changed silently fails too', () => {
    const r = run({ leads: { a: { ...rejected, reason: 'Edited later.' }, b: pending } });
    assert.equal(r.ok, false);
  }],
  ['a documented correction passes and is reported', () => {
    const r = run({ leads: { a: confirmed, b: pending }, corrections: [correction()] });
    assert.equal(r.ok, true, r.problems.join(' '));
    assert.deepEqual(r.corrections, ['a']);
  }],
  ['a correction whose "from" is not the earlier decision fails', () => {
    const r = run({ leads: { a: confirmed, b: pending }, corrections: [correction({ from: { ...rejected, decision: 'duplicate' } })] });
    assert.equal(r.ok, false);
    assert.match(r.problems.join(' '), /"from" is not the earlier decision/);
  }],
  ['a correction without evidence fails', () => {
    const r = run({ leads: { a: confirmed, b: pending }, corrections: [correction({ evidence: [] })] });
    assert.equal(r.ok, false);
    assert.match(r.problems.join(' '), /needs evidence/);
  }],
  ['a correction without a reason fails', () => {
    const r = run({ leads: { a: confirmed, b: pending }, corrections: [correction({ reason: '' })] });
    assert.equal(r.ok, false);
    assert.match(r.problems.join(' '), /needs a reason/);
  }],
  ['a correction dated another day fails', () => {
    const r = run({ leads: { a: confirmed, b: pending }, corrections: [correction({ at: '2026-11-01' })] });
    assert.equal(r.ok, false);
    assert.match(r.problems.join(' '), /is not dated today/);
  }],
  ['a correction whose evidence includes something that is not a URL fails', () => {
    const r = run({ leads: { a: confirmed, b: pending }, corrections: [correction({ evidence: ['https://example.org/x', 'not a url'] })] });
    assert.equal(r.ok, false);
    assert.match(r.problems.join(' '), /http\(s\) URLs only/);
  }],
  ['a decision for a lead not offered today fails', () => {
    const r = run({ leads: { a: rejected, b: pending, stray: { ...rejected, reviewedAt: DATE } } });
    assert.equal(r.ok, false);
    assert.match(r.problems.join(' '), /stray was not offered today/);
  }],
  ['a new decision naming a missing event fails; naming an existing one passes', () => {
    const lead = { ...rejected, decision: 'duplicate', reviewedAt: DATE };
    const missing = run({ leads: { a: rejected, b: pending, n: { ...lead, eventId: 'no-such-event' } } }, ['n']);
    assert.equal(missing.ok, false);
    assert.match(missing.problems.join(' '), /names event no-such-event, which does not exist/);
    assert.equal(run({ leads: { a: rejected, b: pending, n: { ...lead, eventId: 'live-1' } } }, ['n']).ok, true);
  }],
  ['removing an event of the live operator file fails', () => {
    events = write('events.json', { events: [] });
    const r = run({ leads: { a: rejected, b: pending } });
    events = write('events.json', { events: [liveEvent] });
    assert.equal(r.ok, false);
    assert.match(r.problems.join(' '), /live-1 was removed from the operator file/);
  }],
  ['a correction for an unchanged decision fails', () => {
    const r = run({ leads: { a: rejected, b: pending }, corrections: [correction({ to: rejected })] });
    assert.equal(r.ok, false);
    assert.match(r.problems.join(' '), /matches no changed decision/);
  }],
  ['a pending lead offered again today may be decided without a correction', () => {
    const decided = { ...pending, decision: 'rejected', reason: 'Still nothing.', reviewedAt: DATE };
    assert.equal(run({ leads: { a: rejected, b: decided } }, ['b']).ok, true);
  }],
  ['a pending lead not offered today may not change silently', () => {
    const decided = { ...pending, decision: 'rejected', reviewedAt: DATE };
    assert.equal(run({ leads: { a: rejected, b: decided } }).ok, false);
  }],
  ['earlier corrections are append-only', () => {
    const past = { ...correction(), at: '2026-11-10' };
    fs.writeFileSync(host, JSON.stringify({ leads: { a: confirmed, b: pending }, corrections: [past] }));
    assert.equal(run({ leads: { a: confirmed, b: pending }, corrections: [past] }).ok, true);
    const r = run({ leads: { a: confirmed, b: pending }, corrections: [{ ...past, reason: 'Rewritten afterwards.' }] });
    assert.equal(r.ok, false);
    assert.match(r.problems.join(' '), /earlier correction 0 \(a\) was changed/);
    assert.equal(run({ leads: { a: confirmed, b: pending }, corrections: [] }).ok, false);
  }],
  ['a host corrections list that is not a list is reported, not a crash', () => {
    fs.writeFileSync(host, JSON.stringify({ leads: { a: rejected, b: pending }, corrections: {} }));
    const r = run({ leads: { a: rejected, b: pending } });
    assert.equal(r.ok, false);
    assert.match(r.problems.join(' '), /"corrections" is not a list; fix it by hand/);
  }],
];
let failed = 0;
for (const [name, fn] of cases) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}: ${e.message.split('\n')[0]}`);
  }
}
fs.rmSync(dir, { recursive: true, force: true });
console.log(`${cases.length - failed}/${cases.length} passed`);
process.exit(failed ? 1 : 0);
