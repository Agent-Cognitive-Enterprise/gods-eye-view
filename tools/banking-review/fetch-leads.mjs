// Fetch today's Banking Access news leads from the live instance, waiting for
// a COMPLETED GDELT refresh: the first request after an hour (or a restart)
// only starts a refresh in the background and answers with the old list.
// Bounded: at most 20 min, and it stops early when the server's circuit
// breaker reports the next attempt beyond that. A run without a completed
// fetch is DEGRADED: its empty list is not a quiet day.
// Writes leads/<date>.json with the candidates, the ones not yet decided
// ("fresh"; pending ones come back), the news status and the current events.
// Usage: node fetch-leads.mjs [date] [baseUrl]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const date =
  process.argv[2] || new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
const base = process.argv[3] || 'http://127.0.0.1:4173';
const FRESH_MS = 60 * 60_000; // a refresh happens at most hourly
const WAIT_MS = 20 * 60_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fresh = (n) => Boolean(n?.fetchedAt && Date.now() - n.fetchedAt < FRESH_MS);

async function get() {
  const res = await fetch(`${base}/api/banking-access`, {
    headers: { 'Sec-Fetch-Site': 'same-origin', Accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`banking-access answered ${res.status}`);
  return res.json();
}

const problems = [];
const start = Date.now();
let answer = null;
let waited = 0;
try {
  answer = await get();
  if (!answer.news?.enabled) problems.push('news leads are not enabled on the instance (GEV_BANKING_NEWS)');
  let pollErrors = 0;
  const deadline = start + WAIT_MS;
  // Waiting is pointless once the breaker's next attempt lies past the
  // deadline and nothing is in flight.
  const hopeless = (n) =>
    (n?.status === 'degraded' || n?.status === 'circuit_open') &&
    !n.refreshing &&
    n.nextAttemptAt &&
    n.nextAttemptAt > deadline;
  while (answer.news?.enabled && !fresh(answer.news) && !hopeless(answer.news) && Date.now() < deadline) {
    await sleep(30_000);
    waited += 30;
    // A single failed poll (a restart, a slow answer) does not end the wait.
    try {
      answer = await get();
    } catch {
      pollErrors++;
    }
  }
  if (pollErrors) problems.push(`${pollErrors} poll(s) of the instance failed while waiting`);
  const n = answer.news ?? {};
  if (n.enabled && !fresh(n))
    problems.push(
      `DEGRADED: no completed news fetch (feed ${n.status ?? 'unknown'}, ${n.consecutiveFailures ?? 0} failed refreshes in a row, last error: ${
        n.lastError ?? 'none'
      }; last good list ${n.fetchedAt ? new Date(n.fetchedAt).toISOString() : 'never'}; next attempt ${
        n.nextAttemptAt ? new Date(n.nextAttemptAt).toISOString() : 'unknown'
      })`,
    );
} catch (error) {
  problems.push(`instance unreachable: ${error.message}`);
}

const reviewedFile = path.join(here, 'reviewed-leads.json');
const reviewed = JSON.parse(fs.readFileSync(reviewedFile, 'utf8')).leads;
if (!reviewed || typeof reviewed !== 'object') throw new Error('reviewed-leads.json has no "leads" object');
const candidates = fresh(answer?.news) ? answer.news.candidates ?? [] : [];
const undecided = candidates.filter((c) => !reviewed[c.id] || reviewed[c.id].decision === 'pending');
const news = answer?.news ?? {};
const out = {
  date,
  newsComplete: Boolean(news.enabled && fresh(news)),
  newsStatus: news.status ?? (news.enabled ? 'unknown' : 'disabled'),
  newsFailures: news.consecutiveFailures ?? null,
  newsLastError: news.lastError ?? null,
  fetchedFrom: base,
  newsFetchedAt: answer?.news?.fetchedAt ? new Date(answer.news.fetchedAt).toISOString() : null,
  waitedSeconds: waited,
  problems,
  candidates: candidates.length,
  fresh: undecided,
  alreadyDecided: candidates.length - undecided.length,
  routeProblems: answer?.problems ?? [],
  events: (answer?.events ?? []).map((e) => ({
    id: e.id,
    iso3: e.iso3,
    type: e.type,
    severity: e.severity,
    confidence: e.confidence,
    active: e.active,
    stale: e.stale,
    resolvedAt: e.resolvedAt ? new Date(e.resolvedAt).toISOString() : null,
    verifiedAt: e.verifiedAt ? new Date(e.verifiedAt).toISOString() : null,
    origin: e.origin,
  })),
};
fs.mkdirSync(path.join(here, 'leads'), { recursive: true });
const file = path.join(here, 'leads', `${date}.json`);
fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify({ file, candidates: out.candidates, fresh: undecided.length, problems }));
process.exit(answer ? 0 : 2);
