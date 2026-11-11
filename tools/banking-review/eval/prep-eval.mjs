// Build the sandbox state for an evaluation run.
// Usage: node prep-eval.mjs <hostDir> <casesFile> <runDir> <date>
// - events: the live operator events plus the stale outage, with every source
//   whose URL is a case URL removed (so a case can't be answered by lookup);
// - reviewed-leads: the live decisions minus any whose URL is a case URL;
// - leads/<date>.json: the cases as fresh leads, in fetch-leads' format, with
//   the events list as production would show it.
import fs from 'node:fs';
import path from 'node:path';

const [hostDir, casesFile, runDir, date] = process.argv.slice(2);
const work = path.join(runDir, 'work');
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const write = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n');
const cases = read(casesFile);
const caseUrls = new Set(cases.leads.map((c) => c.lead.url));
// A decision on the same story under another URL answers a case too: match
// by the start of the normalised headline.
const headline = (t) => String(t ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().slice(0, 30);
const caseHeadlines = new Set(cases.leads.map((c) => headline(c.lead.title)));
const overrides = cases.sandboxOverrides ?? {};
const clean = (e) => ({
  ...e,
  ...(overrides[e.id] ?? {}),
  sources: (e.sources ?? []).filter((s) => !caseUrls.has(s.url)),
});

const live = read(path.join(hostDir, 'events.local.json'));
const events = [...live.events, cases.staleEvent.event].map(clean);
const sandboxEvents = { ...live, events };
write(path.join(work, 'events.review.json'), sandboxEvents);
write(path.join(runDir, 'events.before.json'), sandboxEvents);

// The bundled copy too: its sources must not answer a case either.
const bundledFile = path.join(work, 'bundled-events.json');
if (fs.existsSync(bundledFile)) {
  const bundled = read(bundledFile);
  bundled.events = (bundled.events ?? []).map(clean);
  write(bundledFile, bundled);
}

const decided = read(path.join(hostDir, 'reviewed-leads.json'));
const kept = Object.fromEntries(
  Object.entries(decided.leads ?? {}).filter(
    ([, d]) => !caseUrls.has(d.url) && !caseHeadlines.has(headline(d.title)),
  ),
);
write(path.join(work, 'reviewed-leads.json'), { ...decided, leads: kept });
write(path.join(runDir, 'reviewed-leads.before.json'), { ...decided, leads: kept });

// The events as the route reports them, from the latest live leads file.
const leadsDir = path.join(hostDir, 'leads');
const latest = fs.readdirSync(leadsDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().at(-1);
const liveEvents = latest ? read(path.join(leadsDir, latest)).events ?? [] : [];
const now = Date.now();
write(path.join(work, 'leads', `${date}.json`), {
  date,
  fetchedFrom: 'evaluation fixture',
  newsFetchedAt: new Date(now).toISOString(),
  waitedSeconds: 0,
  problems: [],
  candidates: cases.leads.length,
  fresh: cases.leads.map((c, i) => ({ ...c.lead, language: null, seenAt: now - i * 3_600_000 })),
  alreadyDecided: 0,
  routeProblems: [],
  events: [
    ...liveEvents,
    {
      id: cases.staleEvent.event.id,
      iso3: cases.staleEvent.event.country_code,
      type: cases.staleEvent.event.event_type,
      severity: cases.staleEvent.event.severity,
      confidence: cases.staleEvent.event.confidence,
      active: true,
      stale: true,
      resolvedAt: null,
      verifiedAt: new Date(cases.staleEvent.event.last_verified_time).toISOString(),
      origin: 'local',
    },
  ],
});
console.log(JSON.stringify({ events: events.length, keptDecisions: Object.keys(kept).length, cases: cases.leads.length }));
