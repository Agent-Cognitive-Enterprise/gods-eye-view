import test from 'node:test';
import assert from 'node:assert/strict';
import { createAirSeaReveal, layersForEvent } from './reveal.js';

function fakeManager(on = []) {
  const enabled = new Set(on);
  const listeners = new Set();
  return {
    layers: new Map(
      ['warning-areas', 'air-traffic', 'sea-traffic', 'traffic-anomalies'].map(
        (id) => [id, {}],
      ),
    ),
    enabled,
    isEnabled: (id) => enabled.has(id),
    setEnabled(id, value, { origin = 'programmatic' } = {}) {
      for (const fn of listeners)
        fn({
          type: 'visibility-requested',
          layerId: id,
          enabled: value,
          origin,
        });
      if (value) enabled.add(id);
      else enabled.delete(id);
      return Promise.resolve();
    },
    subscribeVisibilityRequests(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
const correlation = {
  event_id: 'evt_1',
  providers: ['airsea'],
  metrics: { warning_domain: 'marine_weather' },
};
const anomaly = {
  event_id: 'evt_2',
  providers: ['airsea'],
  subtype: 'air_traffic_anomaly',
};
const quake = { providers: ['usgs'], subtype: 'earthquake', metrics: {} };

test('the layers that explain an event', () => {
  assert.deepEqual(layersForEvent(correlation), [
    'warning-areas',
    'sea-traffic',
  ]);
  assert.deepEqual(layersForEvent(anomaly), [
    'traffic-anomalies',
    'air-traffic',
  ]);
  assert.deepEqual(layersForEvent(quake), []);
  assert.deepEqual(layersForEvent(null), []);
});

test('revealed layers are restored; the operator’s own layers are left alone', () => {
  const manager = fakeManager(['sea-traffic']);
  const reveal = createAirSeaReveal({ manager });
  reveal.show(correlation);
  assert.deepEqual([...manager.enabled].sort(), [
    'sea-traffic',
    'warning-areas',
  ]);
  reveal.show(anomaly);
  // Warning areas go again; sea traffic was the operator's and stays.
  assert.deepEqual([...manager.enabled].sort(), [
    'air-traffic',
    'sea-traffic',
    'traffic-anomalies',
  ]);
  // The operator switches anomalies off and on: now it is theirs.
  manager.setEnabled('traffic-anomalies', false, { origin: 'user' });
  manager.setEnabled('traffic-anomalies', true, { origin: 'user' });
  reveal.show(quake);
  assert.deepEqual([...manager.enabled].sort(), [
    'sea-traffic',
    'traffic-anomalies',
  ]);
  reveal.destroy();
});

test('a layer the operator switches off stays off while the event is shown', () => {
  const manager = fakeManager();
  const reveal = createAirSeaReveal({ manager });
  reveal.show(correlation);
  manager.setEnabled('warning-areas', false, { origin: 'user' });
  // The next Autopilot tick shows the same event again.
  reveal.show(correlation);
  reveal.show(correlation);
  assert.equal(manager.enabled.has('warning-areas'), false);
  assert.equal(manager.enabled.has('sea-traffic'), true);
  // A new event may reveal it again.
  reveal.show({ ...correlation, event_id: 'evt_3' });
  assert.equal(manager.enabled.has('warning-areas'), true);
});

test('a layer still loading at the operator request is not claimed', () => {
  const manager = fakeManager();
  // Requested but not settled yet: isEnabled() still says false.
  const settled = manager.isEnabled;
  manager.isEnabled = () => false;
  const reveal = createAirSeaReveal({ manager });
  manager.setEnabled('sea-traffic', true, { origin: 'user' });
  reveal.show(correlation);
  manager.isEnabled = settled;
  reveal.show(null);
  // The operator's layer is left on; the revealed one goes.
  assert.deepEqual([...manager.enabled], ['sea-traffic']);
});
