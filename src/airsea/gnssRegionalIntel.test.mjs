import test from 'node:test';
import assert from 'node:assert/strict';
import { regionalGnssIntelRecords } from '../../server/providers/airsea/gnssRegionalIntel.js';

test('candidate AIS region maps to analyst advisory, not verified spoofing', () => {
  const s = {
    schemaVersion: 1,
    status: 'candidate_regions',
    coverage: { feedStatus: 'healthy', stale: false },
    regions: [
      {
        id: 'regional-navigation:112:211',
        domain: 'sea',
        confidence: 'low',
        causeAssessment: 'unconfirmed',
        eventPriority: 'advisory',
        area: { south: 22, north: 23, west: 31, east: 32 },
        firstSeenAt: 100000,
        lastSeenAt: 200000,
        evidence: { uniqueVessels: 3 },
      },
    ],
  };
  const records = regionalGnssIntelRecords(s);
  assert.equal(records.length, 1);
  assert.equal(records[0].metrics.severity_hint, 25);
  assert.equal(records[0].metrics.cause_assessment, 'unconfirmed');
  assert.equal(records[0].location.precision, 'region');
  assert.equal(records[0].location.geolocation_status, 'approximate');
  assert.equal(
    regionalGnssIntelRecords({
      ...s,
      coverage: { feedStatus: 'down', stale: true },
    }).length,
    0,
  );
  assert.equal(
    regionalGnssIntelRecords({ ...s, schemaVersion: 999 }).length,
    0,
  );
});
