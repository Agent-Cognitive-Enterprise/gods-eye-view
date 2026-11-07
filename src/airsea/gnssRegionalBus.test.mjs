import test from 'node:test';
import assert from 'node:assert/strict';
import {
  publishRegionalAisPosition,
  subscribeRegionalAisPosition,
} from '../../server/providers/airsea/gnssRegionalBus.js';

test('subscription is passive, detachable and isolated from subscriber exceptions', () => {
  let received = 0;
  const remove = subscribeRegionalAisPosition(() => {
    received++;
  });
  const removeBad = subscribeRegionalAisPosition(() => {
    throw Error('test-only observer failure');
  });
  const warn = console.warn;
  console.warn = () => {};
  try {
    publishRegionalAisPosition({}, 42);
  } finally {
    console.warn = warn;
  }
  assert.equal(received, 1);
  remove();
  removeBad();
  publishRegionalAisPosition({}, 43);
  assert.equal(received, 1);
});
