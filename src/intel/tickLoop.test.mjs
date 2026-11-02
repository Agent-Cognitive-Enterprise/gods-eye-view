import test from 'node:test';
import assert from 'node:assert/strict';
import { createTickLoop } from './tickLoop.js';

/** A hand-cranked timer: `fire()` runs what is booked. */
function clock() {
  const booked = [];
  return {
    booked,
    setTimer(fn) {
      booked.push(fn);
      return booked.length;
    },
    clearTimer() {
      booked.length = 0;
    },
    async fire() {
      await booked.shift()();
    },
  };
}

test('a pass that throws reports it and the next pass is still booked', async () => {
  const timers = clock();
  const errors = [];
  let passes = 0;
  const loop = createTickLoop({
    intervalMs: 5,
    ...timers,
    onError: (error) => errors.push(error.message),
    run() {
      passes += 1;
      if (passes === 1) throw new Error('bad pass');
    },
  });
  loop.schedule();
  await timers.fire();
  assert.deepEqual(errors, ['bad pass']);
  assert.equal(timers.booked.length, 1);
  await timers.fire();
  assert.equal(passes, 2);
});

test('coming back to the tab mid-pass does not start a second loop', async () => {
  const timers = clock();
  let release;
  let started = 0;
  const loop = createTickLoop({
    intervalMs: 5,
    ...timers,
    run() {
      started += 1;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  loop.start();
  loop.start();
  loop.schedule();
  assert.equal(started, 1);
  assert.equal(timers.booked.length, 0);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timers.booked.length, 1);
  loop.start();
  assert.equal(started, 1, 'a booked pass is not doubled');
});

test('stop ends it, even while a pass is running', async () => {
  const timers = clock();
  let release;
  const loop = createTickLoop({
    intervalMs: 5,
    ...timers,
    run: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  loop.start();
  loop.stop();
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timers.booked.length, 0);
  loop.start();
  loop.schedule();
  assert.equal(timers.booked.length, 0);
});
