import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GHOSTMAPS_DEFAULT_WINDOW,
  GHOSTMAPS_WINDOWS,
  parseGhostMapsDate,
  placemarkAge,
  shownInWindow,
} from './age.js';

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 31, 14);
const windowMs = (id) => GHOSTMAPS_WINDOWS.find((w) => w.id === id).ms;
const field = (label, value) => ({ label, value });

test('the windows are the seven asked for, narrowest first', () => {
  assert.deepEqual(
    GHOSTMAPS_WINDOWS.map(({ id }) => id),
    ['6h', '12h', '24h', '1w', '1m', '6m', '1y'],
  );
  const lengths = GHOSTMAPS_WINDOWS.map(({ ms }) => ms);
  assert.deepEqual(
    lengths,
    [...lengths].sort((a, b) => a - b),
  );
  assert.equal(GHOSTMAPS_DEFAULT_WINDOW.id, '1m');
});

test('a dated event is shown only inside the window', () => {
  const age = placemarkAge([
    field('AttackType', 'Bombing'),
    field('Date', '10/31/2026 8:30:00 AM'),
  ]);
  assert.equal(age.at, Date.UTC(2026, 9, 31, 8, 30));
  assert.equal(shownInWindow(age, windowMs('6h'), NOW), true);
  assert.equal(shownInWindow(age, windowMs('6h'), NOW + 3 * HOUR), false);
  assert.equal(shownInWindow(age, windowMs('12h'), NOW + 3 * HOUR), true);
});

test('a year-old event is off in every window but the widest', () => {
  const age = placemarkAge([field('Date', '11/5/2025')]);
  for (const { id, ms } of GHOSTMAPS_WINDOWS)
    assert.equal(shownInWindow(age, ms, NOW), id === '1y', id);
});

test('nothing older than a year is shown, however it is typed', () => {
  const age = placemarkAge([
    field('AttackType', 'Bombing'),
    field('Date', '4/13/2013'),
  ]);
  for (const { ms } of GHOSTMAPS_WINDOWS)
    assert.equal(shownInWindow(age, ms, NOW), false);
});

test('a date with no time of day lasts until that day ends', () => {
  const age = placemarkAge([field('Date', '10/31/2026')]);
  assert.equal(age.at, Date.UTC(2026, 9, 31) + DAY - 1);
  assert.equal(shownInWindow(age, windowMs('6h'), NOW), true);
  const yesterday = placemarkAge([field('Date', '10/30/2026')]);
  assert.equal(shownInWindow(yesterday, windowMs('6h'), NOW), false);
  assert.equal(shownInWindow(yesterday, windowMs('24h'), NOW), true);
});

test('an undated event stays off in every window', () => {
  for (const label of ['AttackType', 'IncidentType', 'Incident Name']) {
    const age = placemarkAge([field(label, 'Isfahan Strikes')]);
    assert.deepEqual(age, { at: null, event: true });
    for (const { ms } of GHOSTMAPS_WINDOWS)
      assert.equal(shownInWindow(age, ms, NOW), false, label);
  }
});

test('a site or area with no date is not an event and stays on', () => {
  for (const fields of [
    [field('InstallationType', 'Air Base')],
    [field('Support Site Type', 'Shelter')],
    [field('control', 'Ansarallah')],
    [],
  ]) {
    const age = placemarkAge(fields);
    assert.deepEqual(age, { at: null, event: false });
    assert.equal(shownInWindow(age, windowMs('6h'), NOW), true);
  }
});

test('a date that cannot be read counts as no date', () => {
  const age = placemarkAge([
    field('AttackType', 'Bombing'),
    field('Date', 'unknown'),
  ]);
  assert.deepEqual(age, { at: null, event: true });
});

test('any dated placemark counts as an event', () => {
  assert.equal(placemarkAge([field('Date', '6/1/2026')]).event, true);
});

test('parseGhostMapsDate reads the formats S2 writes', () => {
  assert.equal(parseGhostMapsDate('6/7/2025'), Date.UTC(2025, 5, 7));
  assert.equal(
    parseGhostMapsDate('10/27/2026 9:15:00 PM'),
    Date.UTC(2026, 9, 27, 21, 15),
  );
  assert.equal(parseGhostMapsDate('yesterday'), null);
  assert.equal(parseGhostMapsDate(null), null);
});
