import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fastStatus } from './fastStatus.js';
import { createReplay } from './replay.js';
import { AUTOPILOT_DEFAULTS } from './taxonomy.js';

const scenario = JSON.parse(
  fs.readFileSync(
    new URL(
      '../../server/providers/intel/fixtures/fast-feed-scenario.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
const BASE = Date.UTC(2026, 0, 1, 12, 0, 0);

function atMinute(minute) {
  const replay = createReplay({
    scenario,
    base: BASE,
    settings: AUTOPILOT_DEFAULTS,
  });
  replay.advanceTo(BASE + minute * 60_000);
  const events = replay.store
    .listEvents({}, { limit: 50 })
    .map((event) => replay.engine.evaluate(event, replay.now()));
  const find = (place) => events.find((e) => e.location.place === place);
  return { lyon: find('Lyon'), geneva: find('Geneva'), events };
}

test('drill: a first post walks from claim to official to resolved', () => {
  const expected = [
    [2, 'provisional', false],
    [6, 'corroborated', false],
    [14, 'official', true],
    [30, 'resolved', false],
  ];
  for (const [minute, status, critical] of expected) {
    const { lyon } = atMinute(minute);
    assert.equal(fastStatus(lyon), status, `minute ${minute}`);
    assert.equal(lyon.critical_qualified, critical, `minute ${minute}`);
  }
});

test('drill: an alarming rumour never gets near the camera, then falls', () => {
  const expected = [
    [8, 'provisional'],
    [16, 'contested'],
    [22, 'retracted'],
  ];
  for (const [minute, status] of expected) {
    const { geneva } = atMinute(minute);
    assert.equal(fastStatus(geneva), status, `minute ${minute}`);
    assert.equal(geneva.camera_eligible, false, `minute ${minute}`);
    assert.equal(geneva.critical_qualified, false, `minute ${minute}`);
  }
});

test('drill: a post with no place and little severity stays a candidate', () => {
  const candidate = atMinute(40).events.find(
    (event) => event.location.place === null,
  );
  assert.equal(fastStatus(candidate), 'candidate');
});

test('drill: every record says it is synthetic', () => {
  for (const record of scenario.records) {
    assert.match(record.title, /^\[DRILL\]/);
    assert.match(record.summary, /^Synthetic/);
  }
});
