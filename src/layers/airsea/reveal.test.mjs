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
    setEnabled(id, value) {
      for (const fn of listeners) fn({ layerId: id, enabled: value });
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
  providers: ['airsea'],
  metrics: { warning_domain: 'marine_weather' },
};
const anomaly = { providers: ['airsea'], subtype: 'air_traffic_anomaly' };
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
  manager.setEnabled('traffic-anomalies', false);
  manager.setEnabled('traffic-anomalies', true);
  reveal.show(quake);
  assert.deepEqual([...manager.enabled].sort(), [
    'sea-traffic',
    'traffic-anomalies',
  ]);
  reveal.destroy();
});
