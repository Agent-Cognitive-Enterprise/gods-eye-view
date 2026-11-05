import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyRegionalAisEnvelope,
  normalizeRegionalAisEnvelope,
} from './gnssAisAdapter.js';
import {
  createRegionalGnssService,
  createRegionalGnssHttpHandler,
} from '../../server/providers/airsea/gnssRegionalService.js';
import {
  REGIONAL_GNSS_RULES,
  createRegionalGnssDetector,
} from './gnssRegional.js';

const T = Date.parse('2026-11-05T00:00:00Z');
function envelope(id, minute, lat, lon) {
  return {
    MessageType: 'PositionReport',
    MetaData: {
      MMSI: 210000000 + id,
      time_utc: `2026-11-05 00:${String(minute).padStart(2, '0')}:00.000000 +0000 UTC`,
    },
    Message: {
      PositionReport: {
        UserID: 210000000 + id,
        Valid: true,
        Timestamp: 0,
        Latitude: lat,
        Longitude: lon,
      },
    },
  };
}

test('accepts source UTC microseconds and refuses static/undated envelopes', () => {
  const parsed = normalizeRegionalAisEnvelope(envelope(1, 0, 22.1, 31.1), T);
  assert.equal(parsed.observedAt, T);
  assert.equal(parsed.timeQuality, 'source');
  const staticOnly = {
    ...envelope(1, 0, 22.1, 31.1),
    MessageType: 'ShipStaticData',
  };
  assert.equal(normalizeRegionalAisEnvelope(staticOnly, T), null);
  const noTime = envelope(1, 0, 22.1, 31.1);
  delete noTime.MetaData.time_utc;
  assert.equal(normalizeRegionalAisEnvelope(noTime, T), null);
  const invalid = envelope(1, 0, 22.1, 31.1);
  invalid.Message.PositionReport.Valid = false;
  assert.equal(normalizeRegionalAisEnvelope(invalid, T), null);
});

test('service + HTTP wrapper return only low-confidence coarse regions', () => {
  const at = T + 2 * 60_000;
  // The 30-minute track age is set aside here (tested in gnssRegional.test).
  const service = createRegionalGnssService({
    now: () => at,
    detector: createRegionalGnssDetector({
      now: () => at,
      rules: { ...REGIONAL_GNSS_RULES, minTrackAgeMs: 0 },
    }),
  });
  for (let i = 1; i <= 3; i++) {
    for (const [min, lat, lon] of [
      [0, 22.1, 31.1],
      [1, 22.101, 31.101],
      [2, 25.1, 35.1],
    ]) {
      const e = envelope(i, min, lat + 0.001 * i, lon);
      assert.equal(service.ingestEnvelope(e, T + min * 60_000).accepted, true);
    }
  }
  let body = '';
  const headers = {};
  const res = {
    destroyed: false,
    statusCode: 200,
    setHeader(k, v) {
      headers[k] = v;
    },
    end(s) {
      body = s;
    },
  };
  const handler = createRegionalGnssHttpHandler(service, () => 'healthy');
  handler({ method: 'GET', url: '/' }, res);
  const result = JSON.parse(body);
  assert.equal(result.regions.length, 1);
  assert.equal(result.regions[0].confidence, 'low');
  assert.equal(result.regions[0].eventPriority, 'advisory');
  assert.ok(headers['Cache-Control'].includes('no-store'));
  handler({ method: 'POST', url: '/' }, res);
  assert.equal(res.statusCode, 405);
});

test('fork: the report must carry its own fix second, agreeing with time_utc', () => {
  const reason = (change) => {
    const e = envelope(1, 0, 22.1, 31.1);
    change(e.Message.PositionReport, e);
    return classifyRegionalAisEnvelope(e, T).reason ?? 'ok';
  };
  assert.equal(
    reason(() => {}),
    'ok',
  );
  assert.equal(
    reason((m) => (m.Timestamp = 14)),
    'ok',
    'within 15 s',
  );
  assert.equal(
    reason((m) => (m.Timestamp = 50)),
    'ok',
    'wraps the minute',
  );
  assert.equal(
    reason((m) => (m.Timestamp = 30)),
    'late_report',
  );
  for (const special of [60, 61, 62, 63])
    assert.equal(
      reason((m) => (m.Timestamp = special)),
      'no_fix_second',
    );
  assert.equal(
    reason((m) => delete m.Timestamp),
    'no_fix_second',
  );
  // Coordinates come from the message alone; blanks are not zero.
  assert.equal(
    reason((m) => (m.Longitude = ' ')),
    'no_position',
  );
  assert.equal(
    reason((m, e) => {
      delete m.Latitude;
      e.MetaData.latitude = 22.1;
    }),
    'no_position',
  );
  // Type 27 long-range broadcasts are coarse and may lag: not used.
  const long = envelope(1, 0, 22.1, 31.1);
  long.MessageType = 'LongRangeAisBroadcastMessage';
  long.Message = { LongRangeAisBroadcastMessage: long.Message.PositionReport };
  assert.equal(
    classifyRegionalAisEnvelope(long, T).reason,
    'not_a_position_report',
  );
});

test('fork: the service counts refused envelopes by reason, without content', () => {
  const service = createRegionalGnssService({ now: () => T });
  const late = envelope(1, 0, 22.1, 31.1);
  late.Message.PositionReport.Timestamp = 30;
  service.ingestEnvelope(late, T);
  service.ingestEnvelope({ MessageType: 'ShipStaticData' }, T);
  const { refusedEnvelopes } = service.snapshot('healthy').diagnostic;
  assert.deepEqual(refusedEnvelopes, {
    late_report: 1,
    not_a_position_report: 1,
  });
});

test('fork: only real numbers count as coordinates and fix seconds', () => {
  const reason = (change) => {
    const e = envelope(1, 0, 22.1, 31.1);
    change(e.Message.PositionReport);
    return classifyRegionalAisEnvelope(e, T).reason ?? 'ok';
  };
  assert.equal(
    reason((m) => (m.Latitude = '22.1')),
    'ok',
    'a numeric string',
  );
  assert.equal(
    reason((m) => (m.Latitude = [])),
    'no_position',
  );
  assert.equal(
    reason((m) => (m.Latitude = true)),
    'no_position',
  );
  assert.equal(
    reason((m) => (m.Timestamp = true)),
    'no_fix_second',
  );
  assert.equal(
    reason((m) => (m.Timestamp = [0])),
    'no_fix_second',
  );
});

test('fork: the service counts how report times compare, in buckets, without content', () => {
  const service = createRegionalGnssService({ now: () => T });
  const at = (second, receivedLagMs) => {
    const e = envelope(1, 0, 22.1, 31.1);
    e.Message.PositionReport.Timestamp = second;
    e.MetaData.MMSI = 219000000 + second;
    service.ingestEnvelope(e, T + receivedLagMs);
  };
  at(0, 1_000); // agrees; 1 s after time_utc
  at(4, 10_000); // 4 s apart; 10 s lag
  at(30, 200_000); // late; over two minutes
  const { timing } = service.snapshot('healthy').diagnostic;
  assert.deepEqual(timing.secondsApart, { '0-2s': 1, '3-5s': 1, '16-30s': 1 });
  assert.deepEqual(timing.receiptLag, { '0-5s': 1, '5-30s': 1, more: 1 });
});
