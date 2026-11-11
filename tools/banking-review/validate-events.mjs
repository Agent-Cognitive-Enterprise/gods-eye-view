// Check the reviewer's working copies before they replace the live state.
// Usage: node validate-events.mjs <appRoot> <events.review.json> <reviewed-leads work copy> <reviewed-leads host copy> <leads/<date>.json>
// Fails (exit 1) on any problem; prints JSON.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [appRoot, eventsFile, leadsWork, leadsHost, todayFile] = process.argv.slice(2);
const { loadEvents } = await import(
  pathToFileURL(path.join(appRoot, 'server/providers/bankingAccess/index.js')).href
);
const problems = [];

// Events: the app's own loader, plus the review's own rules for local entries.
const { events, problems: loader } = loadEvents({ local: eventsFile });
problems.push(...loader.filter((p) => p.startsWith('local')));
let raw = [];
try {
  raw = JSON.parse(fs.readFileSync(eventsFile, 'utf8')).events ?? [];
} catch (e) {
  problems.push(`events file: ${e.message}`);
}
for (const e of raw) {
  const id = e?.id ?? '?';
  if (!e?.last_verified_time) problems.push(`${id}: last_verified_time is required`);
  if (!e?.summary) problems.push(`${id}: summary is required`);
  if (!e?.affected_basis) problems.push(`${id}: affected_basis is required`);
  if (!Array.isArray(e?.sources) || !e.sources.some((s) => /^https?:\/\//.test(s?.url ?? '')))
    problems.push(`${id}: at least one source URL is required`);
}

// Lead decisions: nothing earlier lost, every fresh lead of today decided.
const DECISIONS = new Set(['confirmed', 'rejected', 'duplicate', 'pending']);
let work = null;
try {
  work = JSON.parse(fs.readFileSync(leadsWork, 'utf8')).leads;
  if (!work || typeof work !== 'object') throw new Error('no "leads" object');
} catch (e) {
  problems.push(`reviewed-leads: ${e.message}`);
}
if (work) {
  const host = JSON.parse(fs.readFileSync(leadsHost, 'utf8')).leads ?? {};
  for (const id of Object.keys(host)) if (!work[id]) problems.push(`reviewed-leads: earlier decision ${id} was dropped`);
  for (const [id, d] of Object.entries(work))
    if (!DECISIONS.has(d?.decision)) problems.push(`reviewed-leads: ${id} has decision ${d?.decision}`);
  const today = JSON.parse(fs.readFileSync(todayFile, 'utf8'));
  // Every fresh lead needs a decision made today: a pending one carried over
  // from an earlier day without new work does not count.
  for (const c of today.fresh ?? []) {
    const d = work[c.id];
    if (!d) problems.push(`reviewed-leads: fresh lead ${c.id} was not decided`);
    else if (String(d.reviewedAt ?? '').slice(0, 10) !== today.date)
      problems.push(`reviewed-leads: fresh lead ${c.id} was not re-decided today (reviewedAt ${d.reviewedAt})`);
  }
}

console.log(
  JSON.stringify({ events: events.length, local: events.filter((e) => e.origin === 'local').length, problems }),
);
process.exit(problems.length ? 1 : 0);
