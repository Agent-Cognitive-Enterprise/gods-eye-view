import { createRegionalGnssDetector } from '../../../src/airsea/gnssRegional.js';
import { classifyRegionalAisEnvelope } from '../../../src/airsea/gnssAisAdapter.js';

/** Count one value into the first bucket whose upper bound holds it. */
function bucket(counts, value, bounds) {
  if (value === null || !Number.isFinite(value)) return;
  const found = bounds.find(([, top]) => value <= top);
  const label = found ? found[0] : 'more';
  counts[label] = (counts[label] ?? 0) + 1;
}
const SECONDS_APART = [
  ['0-2s', 2],
  ['3-5s', 5],
  ['6-15s', 15],
  ['16-30s', 30],
];
const RECEIPT_LAG = [
  ['negative', -1],
  ['0-5s', 5_000],
  ['5-30s', 30_000],
  ['30-120s', 120_000],
];

/** Sidecar sharing the EXISTING AISStream connection and receiving its envelopes. */
export function createRegionalGnssService({
  now = () => Date.now(),
  detector = createRegionalGnssDetector({ now }),
} = {}) {
  // Fork: why envelopes were not used, and how their times compare, so a live
  // run shows whether the time rules (gnssAisAdapter.js) fit real traffic.
  // Counts only, no content.
  const refused = {};
  const timing = { secondsApart: {}, receiptLag: {} };
  return {
    ingestEnvelope(envelope, receivedAt = now()) {
      const answer = classifyRegionalAisEnvelope(envelope, receivedAt);
      if (answer.timing) {
        bucket(timing.secondsApart, answer.timing.secondsApart, SECONDS_APART);
        bucket(timing.receiptLag, answer.timing.receiptLagMs, RECEIPT_LAG);
      }
      if (!answer.fix) {
        refused[answer.reason] = (refused[answer.reason] ?? 0) + 1;
        return { accepted: false, reason: answer.reason };
      }
      return detector.observe(answer.fix);
    },
    snapshot(feedStatus) {
      const answer = detector.snapshot({ at: now(), feedStatus });
      answer.diagnostic.refusedEnvelopes = { ...refused };
      answer.diagnostic.timing = {
        secondsApart: { ...timing.secondsApart },
        receiptLag: { ...timing.receiptLag },
      };
      return answer;
    },
  };
}

/** Mount at `/api/airsea/gnss-regions`; advisory areas only, no vessel locations. */
export function createRegionalGnssHttpHandler(
  service,
  getFeedStatus = () => 'unknown',
) {
  return (req, res) => {
    if (res.destroyed) return;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (req.method !== 'GET') {
      res.statusCode = 405;
      res.setHeader('Allow', 'GET');
      res.end(JSON.stringify({ error: 'method_not_allowed' }));
      return;
    }
    const path = (req.url ?? '/').split('?')[0];
    if (path !== '/' && path !== '') {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not_found' }));
      return;
    }
    res.statusCode = 200;
    res.end(JSON.stringify(service.snapshot(getFeedStatus())));
  };
}
