// A stand-in for the headless reviewer, for check-promotion.ps1. Run in the
// wrapper's work\ folder (prompt on stdin, ignored): decides every fresh
// lead "rejected" today, adds one valid event to events.review.json (so both
// live files change), and writes the report.
import fs from 'node:fs';
import path from 'node:path';

process.stdin.resume();
process.stdin.on('end', () => {});
const leadsDir = path.join(process.cwd(), 'leads');
const leadsFile = fs.readdirSync(leadsDir).filter((f) => f.endsWith('.json')).sort().at(-1);
const today = JSON.parse(fs.readFileSync(path.join(leadsDir, leadsFile), 'utf8'));
const date = today.date;

const ledgerFile = path.join(process.cwd(), 'reviewed-leads.json');
const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
for (const lead of today.fresh ?? [])
  ledger.leads[lead.id] = { decision: 'rejected', reason: 'Check run: not a disruption.', url: lead.url, title: lead.title, reviewedAt: date, eventId: null };
fs.writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2) + '\n');

const eventsFile = path.join(process.cwd(), 'events.review.json');
const events = JSON.parse(fs.readFileSync(eventsFile, 'utf8'));
if (!events.events.some((e) => e.id === 'check-event-1'))
  events.events.push({
    id: 'check-event-1',
    country_code: 'PSE',
    country_name: 'Palestine',
    event_type: 'technical_outage',
    severity: 2,
    confidence: 'social',
    start_time: `${date}T00:00:00Z`,
    last_verified_time: `${date}T00:00:00Z`,
    affected_people_est: null,
    affected_population_pct: null,
    affected_basis: 'Not given by any source (check run).',
    summary: 'Check run event.',
    sources: [{ title: 'Check', url: 'https://example.invalid/check-event-1' }],
  });
fs.writeFileSync(eventsFile, JSON.stringify(events, null, 2) + '\n');

fs.mkdirSync(path.join(process.cwd(), 'reports'), { recursive: true });
fs.writeFileSync(path.join(process.cwd(), 'reports', `${date}.md`), `## Banking Access daily review: ${date}\n\nCheck run.\n`);
console.log('fake review done');
