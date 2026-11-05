// The speech player announces when it starts and stops talking, so LIVE TV can
// step aside; a listener that throws never stops speech.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpeechPlayer } from './localAudio.js';

function fakeAudioClass() {
  const made = [];
  class FakeAudio {
    constructor(url) {
      this.url = url;
      this.listeners = {};
      made.push(this);
    }
    addEventListener(name, fn) {
      this.listeners[name] = fn;
    }
    play() {
      return Promise.resolve();
    }
    pause() {}
  }
  return { made, FakeAudio };
}

const urls = { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} };

test('speech start and end are announced once each', async () => {
  const { made, FakeAudio } = fakeAudioClass();
  const target = new EventTarget();
  const heard = [];
  target.addEventListener('gev:speech', (e) => heard.push(e.detail.speaking));
  const player = createSpeechPlayer({ AudioClass: FakeAudio, URLImpl: urls, eventTarget: target });
  const done = player.play(new Uint8Array([1]));
  assert.deepEqual(heard, [true]);
  made[0].listeners.ended();
  assert.equal(await done, true);
  assert.deepEqual(heard, [true, false]);
});

test('a new utterance replacing the old one ends the first before starting', async () => {
  const { FakeAudio } = fakeAudioClass();
  const target = new EventTarget();
  const heard = [];
  target.addEventListener('gev:speech', (e) => heard.push(e.detail.speaking));
  const player = createSpeechPlayer({ AudioClass: FakeAudio, URLImpl: urls, eventTarget: target });
  player.play(new Uint8Array([1]));
  player.play(new Uint8Array([2]));
  player.stop();
  assert.deepEqual(heard, [true, false, true, false]);
});

test('a listener that throws does not stop speech', async () => {
  const { made, FakeAudio } = fakeAudioClass();
  const target = { dispatchEvent: () => { throw new Error('boom'); } };
  const player = createSpeechPlayer({ AudioClass: FakeAudio, URLImpl: urls, eventTarget: target });
  const done = player.play(new Uint8Array([1]));
  made[0].listeners.ended();
  assert.equal(await done, true);
});
