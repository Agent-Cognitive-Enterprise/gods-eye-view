// LIVE TV playback: one decoder per stream, a fatal error or a silent start is
// reported once so the next source can be tried, and stopping releases it all.
import test from 'node:test';
import assert from 'node:assert/strict';
import { attachLiveStream } from './liveTvPlayer.js';

function fakeVideo({ native = false } = {}) {
  const listeners = {};
  return {
    listeners,
    muted: true,
    paused: true,
    src: '',
    played: 0,
    addEventListener: (name, fn) => (listeners[name] = fn),
    removeEventListener: (name) => delete listeners[name],
    play() {
      this.played += 1;
      return Promise.resolve();
    },
    pause() {
      this.paused = true;
    },
    load() {},
    removeAttribute(name) {
      this[name] = '';
    },
    canPlayType: (type) => (native && type === 'application/vnd.apple.mpegurl' ? 'maybe' : ''),
  };
}

function fakeHls({ supported = true } = {}) {
  const made = [];
  class Hls {
    static isSupported = () => supported;
    static Events = { ERROR: 'error', MANIFEST_PARSED: 'parsed' };
    constructor() {
      this.handlers = {};
      this.destroyed = false;
      made.push(this);
    }
    on(name, fn) {
      this.handlers[name] = fn;
    }
    loadSource(url) {
      this.url = url;
    }
    attachMedia(video) {
      this.video = video;
    }
    destroy() {
      this.destroyed = true;
    }
  }
  return { made, load: async () => ({ default: Hls }) };
}

const timers = () => {
  const pending = [];
  return {
    pending,
    setTimer: (fn, ms) => (pending.push({ fn, ms }), pending.length),
    clearTimer: (id) => pending[id - 1] && (pending[id - 1].fn = null),
    fire: () => pending.forEach((t) => t.fn?.()),
  };
};

const flush = () => new Promise((r) => setImmediate(r));

test('hls.js loads the stream and plays once the manifest is parsed', async () => {
  const video = fakeVideo();
  const hls = fakeHls();
  const clock = timers();
  let live = 0;
  attachLiveStream(video, 'https://example.org/a.m3u8', { loadHls: hls.load, onPlaying: () => live++, ...clock });
  await flush();
  assert.equal(hls.made.length, 1);
  assert.equal(hls.made[0].url, 'https://example.org/a.m3u8');
  assert.equal(hls.made[0].video, video);
  hls.made[0].handlers.parsed();
  assert.equal(video.played, 1);
  video.listeners.playing();
  assert.equal(live, 1);
  clock.fire();
});

test('a fatal error is reported once; a recoverable one is not', async () => {
  const video = fakeVideo();
  const hls = fakeHls();
  const reasons = [];
  attachLiveStream(video, 'https://example.org/a.m3u8', { loadHls: hls.load, onFailure: (r) => reasons.push(r), ...timers() });
  await flush();
  hls.made[0].handlers.error(null, { fatal: false, type: 'networkError' });
  hls.made[0].handlers.error(null, { fatal: true, type: 'networkError' });
  hls.made[0].handlers.error(null, { fatal: true, type: 'mediaError' });
  assert.deepEqual(reasons, ['hls:networkError']);
});

test('no picture within the startup time counts as a failure', async () => {
  const clock = timers();
  const reasons = [];
  attachLiveStream(fakeVideo(), 'https://example.org/a.m3u8', { loadHls: fakeHls().load, onFailure: (r) => reasons.push(r), startupMs: 5000, ...clock });
  await flush();
  assert.equal(clock.pending[0].ms, 5000);
  clock.fire();
  assert.deepEqual(reasons, ['timeout']);
});

test('native HLS is used where Media Source Extensions are missing', async () => {
  const video = fakeVideo({ native: true });
  attachLiveStream(video, 'https://example.org/a.m3u8', { loadHls: fakeHls({ supported: false }).load, ...timers() });
  await flush();
  assert.equal(video.src, 'https://example.org/a.m3u8');
  assert.equal(video.played, 1);
});

test('with neither, the stream is reported unsupported', async () => {
  const reasons = [];
  attachLiveStream(fakeVideo(), 'https://example.org/a.m3u8', { loadHls: fakeHls({ supported: false }).load, onFailure: (r) => reasons.push(r), ...timers() });
  await flush();
  assert.deepEqual(reasons, ['unsupported']);
});

test('stopping destroys the decoder, clears the video and silences later events', async () => {
  const video = fakeVideo();
  const hls = fakeHls();
  const reasons = [];
  const stop = attachLiveStream(video, 'https://example.org/a.m3u8', { loadHls: hls.load, onFailure: (r) => reasons.push(r), ...timers() });
  await flush();
  video.src = 'blob:x';
  stop();
  stop();
  assert.equal(hls.made[0].destroyed, true);
  assert.equal(video.paused, true);
  assert.equal(video.src, '');
  assert.equal(video.listeners.playing, undefined);
  hls.made[0].handlers.error(null, { fatal: true, type: 'networkError' });
  assert.deepEqual(reasons, []);
});

test('stopping before hls.js has loaded never creates a decoder', async () => {
  const hls = fakeHls();
  const stop = attachLiveStream(fakeVideo(), 'https://example.org/a.m3u8', { loadHls: hls.load, ...timers() });
  stop();
  await flush();
  assert.equal(hls.made.length, 0);
});
