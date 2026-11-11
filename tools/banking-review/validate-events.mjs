// Check the reviewer's working copies before they replace the live state.
// Usage: node validate-events.mjs <appRoot> <events.review.json> <reviewed-leads work copy> <reviewed-leads host copy> <leads/<date>.json> [<events.local.json host copy>]
// Fails (exit 1) on any problem; prints JSON, with the ids of any earlier
// decisions corrected today (`corrections`), which the wrapper flags for the
// operator.
//
// Earlier decisions are immutable. A lead may be decided again only when it
// is one of today's fresh leads and its earlier decision was "pending" (a
// pending lead comes back by design). Any other change to an earlier
// decision, in any field, needs a correction appended to the top-level
// "corrections" list of reviewed-leads.json:
//   { "id", "at": <today>, "from": <the earlier decision, exactly>,
//     "to": <the new decision, exactly>, "reason": <a sentence>,
//     "evidence": [<http(s) URL>, ...] }
// The list is append-only: earlier corrections may not change.
//
// A new decision is only for a lead offered today (in today's `fresh`). An
// event in the host's operator file may be updated but not removed. A
// decision new or changed today that names an `eventId` must name an event
// that exists (bundled or in the operator file).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [appRoot, eventsFile, leadsWork, leadsHost, todayFile, eventsHost] = process.argv.slice(2);
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
// No event of the live operator file is removed.
if (eventsHost && fs.existsSync(eventsHost)) {
  let before = [];
  try {
    before = JSON.parse(fs.readFileSync(eventsHost, 'utf8')).events ?? [];
  } catch (e) {
    problems.push(`host events file: ${e.message}`);
  }
  const kept = new Set(raw.map((e) => e?.id));
  for (const e of before) if (e?.id && !kept.has(e.id)) problems.push(`events: ${e.id} was removed from the operator file`);
}
const eventIds = new Set(events.map((e) => e.id));
for (const e of raw) {
  const id = e?.id ?? '?';
  if (!e?.last_verified_time) problems.push(`${id}: last_verified_time is required`);
  if (!e?.summary) problems.push(`${id}: summary is required`);
  if (!e?.affected_basis) problems.push(`${id}: affected_basis is required`);
  if (!Array.isArray(e?.sources) || !e.sources.some((s) => /^https?:\/\//.test(s?.url ?? '')))
    problems.push(`${id}: at least one source URL is required`);
}

// Lead decisions: nothing earlier lost or silently rewritten, every fresh
// lead of today decided.
const DECISIONS = new Set(['confirmed', 'rejected', 'duplicate', 'pending']);
// Compared by value, whatever the key order.
const canon = (v) =>
  Array.isArray(v)
    ? v.map(canon)
    : v && typeof v === 'object'
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]))
      : v;
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
const httpUrl = (u) => typeof u === 'string' && /^https?:\/\/[^\s/]+\S*$/.test(u);
let workDoc = null;
let work = null;
try {
  workDoc = JSON.parse(fs.readFileSync(leadsWork, 'utf8'));
  work = workDoc.leads;
  if (!work || typeof work !== 'object') throw new Error('no "leads" object');
} catch (e) {
  problems.push(`reviewed-leads: ${e.message}`);
}
const corrected = [];
if (work) {
  const hostDoc = JSON.parse(fs.readFileSync(leadsHost, 'utf8'));
  const host = hostDoc.leads ?? {};
  const today = JSON.parse(fs.readFileSync(todayFile, 'utf8'));
  for (const id of Object.keys(host)) if (!work[id]) problems.push(`reviewed-leads: earlier decision ${id} was dropped`);
  for (const [id, d] of Object.entries(work))
    if (!DECISIONS.has(d?.decision)) problems.push(`reviewed-leads: ${id} has decision ${d?.decision}`);
  // Corrections: append-only; each new one documents exactly one change.
  const hostCorrections = hostDoc.corrections ?? [];
  const workCorrections = workDoc.corrections ?? [];
  const fresh = new Set((today.fresh ?? []).map((c) => c.id));
  // New decisions: only for leads offered today.
  for (const id of Object.keys(work))
    if (!(id in host) && !fresh.has(id)) problems.push(`reviewed-leads: ${id} was not offered today`);
  // Decisions new or changed today name only events that exist.
  for (const [id, d] of Object.entries(work))
    if (d?.eventId && !(id in host && same(host[id], d)) && !eventIds.has(d.eventId))
      problems.push(`reviewed-leads: ${id} names event ${d.eventId}, which does not exist`);
  if (!Array.isArray(hostCorrections)) problems.push('reviewed-leads (host): "corrections" is not a list; fix it by hand');
  else if (!Array.isArray(workCorrections)) problems.push('reviewed-leads: "corrections" is not a list');
  else {
    if (workCorrections.length < hostCorrections.length) problems.push('reviewed-leads: earlier corrections were dropped');
    hostCorrections.forEach((c, i) => {
      if (!same(c, workCorrections[i])) problems.push(`reviewed-leads: earlier correction ${i} (${c?.id}) was changed`);
    });
    const added = workCorrections.slice(hostCorrections.length);
    const used = new Set();
    for (const [id, before] of Object.entries(host)) {
      const after = work[id];
      if (!after || same(before, after)) continue;
      // A pending lead offered again today may simply be decided.
      if (before.decision === 'pending' && fresh.has(id)) continue;
      const k = added.findIndex((c, i) => !used.has(i) && c?.id === id);
      if (k < 0) {
        problems.push(`reviewed-leads: earlier decision ${id} was changed without a correction`);
        continue;
      }
      used.add(k);
      const c = added[k];
      if (c.at !== today.date) problems.push(`reviewed-leads: correction of ${id} is not dated today (${c.at})`);
      if (!same(c.from, before)) problems.push(`reviewed-leads: correction of ${id}: "from" is not the earlier decision`);
      if (!same(c.to, after)) problems.push(`reviewed-leads: correction of ${id}: "to" is not the new decision`);
      if (typeof c.reason !== 'string' || c.reason.trim().length < 10)
        problems.push(`reviewed-leads: correction of ${id} needs a reason`);
      if (!Array.isArray(c.evidence) || !c.evidence.length || !c.evidence.every(httpUrl))
        problems.push(`reviewed-leads: correction of ${id} needs evidence: http(s) URLs only`);
      corrected.push(id);
    }
    added.forEach((c, i) => {
      if (!used.has(i)) problems.push(`reviewed-leads: correction ${c?.id ?? '?'} matches no changed decision`);
    });
  }
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
  JSON.stringify({
    events: events.length,
    local: events.filter((e) => e.origin === 'local').length,
    corrections: corrected,
    problems,
  }),
);
process.exit(problems.length ? 1 : 0);
