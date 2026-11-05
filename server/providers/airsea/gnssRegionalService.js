import { createRegionalGnssDetector } from '../../../src/airsea/gnssRegional.js';
import { classifyRegionalAisEnvelope } from '../../../src/airsea/gnssAisAdapter.js';

/** Sidecar sharing the EXISTING AISStream connection and receiving its envelopes. */
export function createRegionalGnssService({
  now = () => Date.now(),
  detector = createRegionalGnssDetector({ now }),
} = {}) {
  // Fork: why envelopes were not used, so a live run shows whether the time
  // rules (gnssAisAdapter.js) refuse real traffic. Counts only, no content.
  const refused = {};
  return {
    ingestEnvelope(envelope, receivedAt = now()) {
      const { fix, reason } = classifyRegionalAisEnvelope(envelope, receivedAt);
      if (!fix) {
        refused[reason] = (refused[reason] ?? 0) + 1;
        return { accepted: false, reason };
      }
      return detector.observe(fix);
    },
    snapshot(feedStatus) {
      const answer = detector.snapshot({ at: now(), feedStatus });
      answer.diagnostic.refusedEnvelopes = { ...refused };
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
