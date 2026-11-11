// Build a spot-check pack for the operator: at least 20 live decisions across
// confirmed, rejected, duplicate, pending (uncertain), stale events
// re-verified, and other status re-verifications, each with its full
// rationale, the lead or source URL and the archived evidence (file, SHA-256,
// HTTP status, when it was saved). The operator marks each row agree or
// disagree.
// Usage: node build-spotcheck.mjs [minimum=20] [appRoot=C:\Users\user\gev-fast]
// Writes spotcheck/<today>.md and .json; takes every rarer kind and fills the
// rest evenly from rejected and duplicate, newest first.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const minimum = Number(process.argv[2] ?? 20);
const appRoot = process.argv[3] ?? 'C:\\Users\\user\\gev-fast';
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
const DAY = 86_400_000;

// Evidence by URL, every snapshot kept (to match a verification date).
const evidence = new Map();
const evDir = path.join(here, 'evidence');
for (const d of fs.existsSync(evDir) ? fs.readdirSync(evDir).sort() : []) {
  const f = path.join(evDir, d, 'index.json');
  if (!fs.existsSync(f)) continue;
  for (const e of read(f)) {
    const list = evidence.get(e.url) ?? [];
    list.push({ ...e, day: d });
    evidence.set(e.url, list);
  }
}
// The snapshot saved on or after `since` (else the latest), described.
function ev(url, since) {
  const list = (evidence.get(url) ?? []).filter((e) => e.ok);
  const onTime = list.find((e) => since && e.savedAt >= since);
  const pick = onTime ?? list.at(-1);
  if (!pick) {
    const failed = (evidence.get(url) ?? []).at(-1);
    return { evidence: failed ? `not available (${failed.status ?? ''} ${failed.error ?? ''})`.trim() : 'not archived' };
  }
  return {
    evidence: `evidence/${pick.day}/${pick.file}${since && !onTime ? ' (snapshot predates this verification)' : ''}`,
    sha256: pick.sha256,
    httpStatus: pick.status,
    savedAt: pick.savedAt,
  };
}

const leads = Object.entries(read(path.join(here, 'reviewed-leads.json')).leads ?? {}).map(([id, d]) => ({
  kind: d.decision,
  id,
  title: d.title,
  url: d.url,
  decidedAt: d.reviewedAt,
  rationale: d.reason,
  eventId: d.eventId ?? null,
  ...ev(d.url),
}));

// Each event's verification history: the bundled file and every backup.
// "Stale" is judged against the most recent earlier verification.
const history = new Map();
const note = (id, t) => {
  if (!t) return;
  const list = history.get(id) ?? [];
  list.push(t);
  history.set(id, list);
};
try {
  for (const e of read(path.join(appRoot, 'server', 'providers', 'bankingAccess', 'events.json')).events ?? [])
    note(e.id, e.last_verified_time ?? e.last_update_time ?? e.start_time);
} catch {}
const backups = fs.existsSync(path.join(here, 'backups')) ? fs.readdirSync(path.join(here, 'backups')).filter((f) => f.startsWith('events.local.')) : [];
for (const f of backups)
  for (const e of read(path.join(here, 'backups', f)).events ?? []) note(e.id, e.last_verified_time ?? e.last_update_time);
const previousVerification = (id, current) =>
  (history.get(id) ?? []).filter((t) => Date.parse(t) < current).sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
const events = (read(path.join(here, 'events.local.json')).events ?? []).map((e) => {
  const now = Date.parse(e.last_verified_time ?? '');
  const prior = Number.isFinite(now) ? previousVerification(e.id, now) : null;
  const before = Date.parse(prior ?? '');
  const wasStale = Number.isFinite(before) && now - before > 30 * DAY;
  const url = e.sources?.at(-1)?.url ?? null;
  return {
    kind: wasStale ? 'stale→re-verified' : 're-verification',
    id: e.id,
    title: `${e.country_name ?? e.country_code}: ${e.event_type}, ${e.resolved_time ? `resolved ${e.resolved_time}` : 'ongoing'}${wasStale ? ` (previously verified ${String(prior).slice(0, 10)})` : ''}`,
    url,
    decidedAt: e.last_verified_time,
    rationale: e.summary,
    eventId: e.id,
    ...ev(url, e.last_verified_time),
  };
});

const byKind = (list, k) => list.filter((l) => l.kind === k).sort((a, b) => String(b.decidedAt).localeCompare(String(a.decidedAt)));
const rare = [...byKind(leads, 'confirmed'), ...byKind(leads, 'pending'), ...byKind(events, 'stale→re-verified'), ...byKind(events, 're-verification')];
const common = [byKind(leads, 'rejected'), byKind(leads, 'duplicate')];
const picked = [...rare];
for (let i = 0; picked.length < minimum && common.some((c) => i < c.length); i++)
  for (const c of common) if (i < c.length && picked.length < minimum) picked.push(c[i]);

const kinds = ['confirmed', 'rejected', 'duplicate', 'pending', 'stale→re-verified', 're-verification'];
const counts = Object.fromEntries(kinds.map((k) => [k, picked.filter((p) => p.kind === k).length]));
const missing = kinds.filter((k) => !counts[k]);
const cell = (s, n) => String(s ?? '').replace(/\|/g, '/').replace(/\n/g, ' ').slice(0, n);
const md = [
  `## Banking Access spot-check pack: ${today}`,
  '',
  `${picked.length} live decisions for independent review. By kind: ${kinds.map((k) => `${k} ${counts[k]}`).join(', ')}.`,
  missing.length ? `No live example exists yet of: ${missing.join(', ')}.` : '',
  'Mark each row **agree** or **disagree**, with a note. The rationale is the reviewer\'s own, given in full below the table. The evidence is the page as archived on the host (`C:\\Users\\user\\gods-eye-view-runtime\\banking-review\\`), with its SHA-256 and the date it was saved.',
  '',
  '| # | Kind | Decided | Lead or event | Evidence | Verdict |',
  '| --- | --- | --- | --- | --- | --- |',
  ...picked.map((p, i) => `| ${i + 1} | ${p.kind}${p.eventId && !p.kind.includes('verif') ? ` → ${p.eventId}` : ''} | ${String(p.decidedAt ?? '').slice(0, 10)} | [${cell(p.title ?? p.id, 90).replace(/[[\]]/g, ' ')}](${p.url ?? ''}) | ${p.evidence}${p.sha256 ? ` (sha256 ${p.sha256.slice(0, 12)}…, HTTP ${p.httpStatus}, saved ${String(p.savedAt).slice(0, 10)})` : ''} | |`),
  '',
  '### Rationale in full',
  '',
  ...picked.map((p, i) => `${i + 1}. **${p.kind}** (${p.id}): ${String(p.rationale ?? '').replace(/\n/g, ' ')}`),
].join('\n');
fs.mkdirSync(path.join(here, 'spotcheck'), { recursive: true });
fs.writeFileSync(path.join(here, 'spotcheck', `${today}.md`), md + '\n');
fs.writeFileSync(path.join(here, 'spotcheck', `${today}.json`), JSON.stringify(picked, null, 2) + '\n');
console.log(JSON.stringify({ picked: picked.length, counts, missing }));
