// The LIVE TV view: nothing loads until a channel is picked or while the panel is
// collapsed, a source that cannot play gives way to the next, YouTube plays
// muted in privacy mode, and the settings editor keeps only valid lists.
import '../../../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, nextTick } from 'vue';
import { createPinia } from 'pinia';
import { STORAGE_KEY } from '../../liveTvChannels.js';
import { usePanelChromeStore } from '../../stores/panelChrome.js';
import { useLiveTvStore } from '../../stores/liveTv.js';
import LiveTvPanel from './LiveTvPanel.vue';

// The test DOM must never fetch the embedded pages: these tests stay offline.
globalThis.happyDOM.settings.disableIframePageLoading = true;
globalThis.happyDOM.settings.disableJavaScriptFileLoading = true;
globalThis.happyDOM.settings.handleDisabledFileLoadingAsSuccess = true;

const settle = async () => {
  for (let i = 0; i < 6; i += 1) {
    await nextTick();
    await new Promise((r) => setTimeout(r, 0));
  }
};

function mount(t, { saved, open = true } = {}) {
  document.body.replaceChildren();
  localStorage.clear();
  if (saved) localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
  const pinia = createPinia();
  const chrome = usePanelChromeStore(pinia);
  const token = chrome.connect({ toggle: () => {} });
  chrome.publish(token, 'live-tv-panel', { collapsed: !open });
  const store = useLiveTvStore(pinia);
  const app = createApp(LiveTvPanel).use(pinia);
  app.mount(document.body.appendChild(document.createElement('div')));
  t.after(() => app.unmount());
  const root = () => document.getElementById('live-tv-panel');
  const chip = (name) => [...root().querySelectorAll('.live-tv-channels button')].find((b) => b.textContent.trim() === name);
  const button = (text) => [...root().querySelectorAll('button')].find((b) => b.textContent.trim() === text);
  return { store, chrome, token, root, chip, button };
}

test('eight default channels, and nothing loads until one is picked', async (t) => {
  const { root } = mount(t);
  await settle();
  assert.deepEqual(
    [...root().querySelectorAll('.live-tv-channels button')].map((b) => b.textContent.trim()),
    ['Bloomberg', 'Sky News', 'Euronews', 'DW News', 'CNN', 'France 24', 'Al Jazeera', 'RT'],
  );
  assert.equal(root().querySelector('iframe, video'), null);
  assert.match(root().textContent, /Pick a channel/);
});

test('a YouTube channel plays muted from the privacy-mode host', async (t) => {
  const { root, chip, store } = mount(t);
  chip('CNN').click();
  await settle();
  const frame = root().querySelector('iframe');
  assert.ok(frame);
  const src = new URL(frame.getAttribute('src'));
  assert.equal(src.origin, 'https://www.youtube-nocookie.com');
  assert.equal(src.pathname, '/embed/GotlA1KKWoo');
  assert.equal(src.searchParams.get('mute'), '1');
  assert.equal(frame.getAttribute('referrerpolicy'), 'strict-origin-when-cross-origin');
  assert.equal(store.selected, 'cnn');
  assert.equal(JSON.parse(localStorage.getItem(STORAGE_KEY)).selected, 'cnn');
});

test('a YouTube video plays first where it is listed first', async (t) => {
  const { root, chip } = mount(t);
  chip('Bloomberg').click();
  await settle();
  const frame = root().querySelector('iframe');
  assert.ok(frame, 'fell back to YouTube');
  assert.equal(new URL(frame.getAttribute('src')).pathname, '/embed/QB5BNdBFujE');
});

test('Sky News falls from its broadcaster stream to its YouTube channel live', async (t) => {
  const { root, chip } = mount(t);
  chip('Sky News').click();
  await settle();
  const src = new URL(root().querySelector('iframe').getAttribute('src'));
  assert.equal(src.pathname, '/embed/live_stream');
  assert.equal(src.searchParams.get('channel'), 'UCoMdktPbSTixAyNGwb-UYkQ');
});

test('when every source fails the panel says so and offers to try again', async (t) => {
  const { root, chip, button } = mount(t);
  chip('RT').click();
  await settle();
  assert.equal(root().querySelector('iframe, video'), null);
  assert.match(root().textContent, /Could not play this channel/);
  assert.match(root().textContent, /not be available in your region/);
  assert.equal(root().textContent.match(/Could not play this channel/g).length, 1, 'said once, on the screen');
  assert.ok(button('Try again'));
});

test('collapsing the panel stops playback; opening it resumes', async (t) => {
  const { root, chip, chrome, token } = mount(t);
  chip('CNN').click();
  await settle();
  assert.ok(root().querySelector('iframe'));
  chrome.publish(token, 'live-tv-panel', { collapsed: true });
  await settle();
  assert.equal(root().querySelector('iframe'), null);
  chrome.publish(token, 'live-tv-panel', { collapsed: false });
  await settle();
  assert.ok(root().querySelector('iframe'));
});

test('a collapsed panel loads nothing even with a remembered channel', async (t) => {
  const { root } = mount(t, { saved: { selected: 'cnn', muted: true }, open: false });
  await settle();
  assert.equal(root().querySelector('iframe, video'), null);
});

test('mute, stop and the remembered choice', async (t) => {
  const { root, chip, button, store } = mount(t);
  chip('CNN').click();
  await settle();
  button('Unmute').click();
  await settle();
  assert.equal(store.muted, false);
  assert.ok(button('Mute'));
  button('Stop').click();
  await settle();
  assert.equal(store.selected, null);
  assert.equal(root().querySelector('iframe'), null);
  assert.deepEqual(JSON.parse(localStorage.getItem(STORAGE_KEY)), { selected: null, muted: false });
});

test('settings: an invalid source is shown where it is and nothing is saved', async (t) => {
  const { root, store } = mount(t);
  root().querySelector('.live-tv-gear').click();
  await settle();
  assert.equal(store.editing, true);
  const area = root().querySelectorAll('.live-tv-row textarea')[0];
  area.value = 'https://example.org/not-a-stream';
  area.dispatchEvent(new Event('input'));
  root().querySelector('.live-tv-settings').dispatchEvent(new Event('submit', { cancelable: true }));
  await settle();
  assert.match(root().querySelector('.live-tv-error').textContent, /Line 1 is not a YouTube address/);
  assert.equal(store.custom, false);
  assert.equal(store.editing, true);
});

test('settings: add a channel, reorder and remove, save, then reset to defaults', async (t) => {
  const { root, store, button } = mount(t);
  root().querySelector('.live-tv-gear').click();
  await settle();
  button('Add channel').click();
  await settle();
  const rows = () => [...root().querySelectorAll('.live-tv-row')];
  const last = rows().at(-1);
  const name = last.querySelector('input');
  name.value = 'My stream';
  name.dispatchEvent(new Event('input'));
  const sources = last.querySelector('textarea');
  sources.value = 'https://example.org/live/index.m3u8';
  sources.dispatchEvent(new Event('input'));
  last.querySelector('[aria-label="Move up"]').click();
  await settle();
  rows()[0].querySelector('[aria-label="Remove"]').click();
  await settle();
  root().querySelector('.live-tv-settings').dispatchEvent(new Event('submit', { cancelable: true }));
  await settle();
  assert.equal(store.editing, false);
  assert.equal(store.custom, true);
  const names = store.channels.map((c) => c.name);
  assert.equal(names.length, 8);
  assert.equal(names[0], 'Sky News', 'Bloomberg removed');
  assert.equal(names.at(-2), 'My stream', 'moved above RT');
  assert.equal(JSON.parse(localStorage.getItem(STORAGE_KEY)).channels.length, 8);
  root().querySelector('.live-tv-gear').click();
  await settle();
  button('Reset to defaults').click();
  await settle();
  assert.equal(store.custom, false);
  assert.equal(store.channels[0].name, 'Bloomberg');
  assert.equal(JSON.parse(localStorage.getItem(STORAGE_KEY)).channels, undefined);
});

test('narration lowers the TV and lets it back up', async (t) => {
  const { root, chip } = mount(t);
  chip('CNN').click();
  await settle();
  const frame = root().querySelector('iframe');
  const sent = [];
  Object.defineProperty(frame, 'contentWindow', { value: { postMessage: (m) => sent.push(JSON.parse(m)) } });
  globalThis.dispatchEvent(new CustomEvent('gev:speech', { detail: { speaking: true } }));
  await settle();
  assert.ok(sent.some((m) => m.func === 'setVolume' && m.args[0] === 20));
  globalThis.dispatchEvent(new CustomEvent('gev:speech', { detail: { speaking: false } }));
  await settle();
  assert.ok(sent.some((m) => m.func === 'setVolume' && m.args[0] === 100));
});

test('only the YouTube player itself can report an error', async (t) => {
  const { root, chip } = mount(t);
  chip('Al Jazeera').click();
  await settle();
  const frame = root().querySelector('iframe');
  assert.equal(new URL(frame.getAttribute('src')).pathname, '/embed/gCNeDWCI0vo');
  const forged = { event: 'onError', info: 150 };
  globalThis.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(forged), origin: 'https://evil.example' }));
  await settle();
  assert.equal(new URL(root().querySelector('iframe').getAttribute('src')).pathname, '/embed/gCNeDWCI0vo');
});

// A fake YouTube player window, and a message that really comes from it.
function fakePlayer(frame) {
  const sent = [];
  const win = { postMessage: (m) => sent.push(JSON.parse(m)) };
  Object.defineProperty(frame, 'contentWindow', { value: win, configurable: true });
  const say = (data, origin = 'https://www.youtube-nocookie.com') => {
    const event = new Event('message');
    Object.defineProperties(event, {
      data: { value: JSON.stringify(data) },
      origin: { value: origin },
      source: { value: win },
    });
    globalThis.dispatchEvent(event);
  };
  return { sent, say };
}
const embedPath = (root) => new URL(root().querySelector('iframe').getAttribute('src')).pathname;

test('a real error from the YouTube player moves to the next source', async (t) => {
  const { root, chip } = mount(t);
  chip('Euronews').click();
  await settle();
  assert.equal(embedPath(root), '/embed/pykpO5kQJ98');
  fakePlayer(root().querySelector('iframe')).say({ event: 'onError', info: 150 });
  await settle();
  assert.equal(embedPath(root), '/embed/live_stream');
  // The same message from another origin is ignored.
  fakePlayer(root().querySelector('iframe')).say({ event: 'onError', info: 150 }, 'https://evil.example');
  await settle();
  assert.equal(embedPath(root), '/embed/live_stream');
});

test('the player saying it plays marks the channel LIVE', async (t) => {
  const { root, chip } = mount(t);
  chip('CNN').click();
  await settle();
  fakePlayer(root().querySelector('iframe')).say({ event: 'infoDelivery', info: { playerState: 1, volume: 60 } });
  await settle();
  assert.match(root().querySelector('.live-tv-status').textContent, /^LIVE/);
});

test('narration ducks to a fifth of the person\'s own level and restores it', async (t) => {
  const { root, chip } = mount(t);
  chip('CNN').click();
  await settle();
  const player = fakePlayer(root().querySelector('iframe'));
  player.say({ event: 'infoDelivery', info: { playerState: 1, volume: 60 } });
  await settle();
  const speech = (speaking) => globalThis.dispatchEvent(new CustomEvent('gev:speech', { detail: { speaking } }));
  speech(true);
  speech(true); // a second voice starts
  speech(false); // the first ends: still ducked
  await settle();
  const volumes = () => player.sent.filter((m) => m.func === 'setVolume').map((m) => m.args[0]);
  assert.deepEqual(volumes(), [12]);
  speech(false);
  await settle();
  assert.deepEqual(volumes(), [12, 60]);
});

test('Next source cycles back instead of declaring a playing channel failed', async (t) => {
  const { root, chip, button } = mount(t);
  chip('Euronews').click();
  await settle();
  button('Next source').click();
  await settle();
  assert.equal(embedPath(root), '/embed/live_stream');
  button('Next source').click();
  await settle();
  assert.equal(embedPath(root), '/embed/pykpO5kQJ98');
  assert.doesNotMatch(root().textContent, /Could not play/);
});

test('saving the list starts the channel from its first source again', async (t) => {
  const { root, chip, button, store } = mount(t);
  chip('Euronews').click();
  await settle();
  button('Next source').click();
  await settle();
  root().querySelector('.live-tv-gear').click();
  await settle();
  const area = root().querySelectorAll('.live-tv-row textarea')[2];
  area.value = 'https://www.youtube.com/watch?v=pykpO5kQJ98';
  area.dispatchEvent(new Event('input'));
  root().querySelector('.live-tv-settings').dispatchEvent(new Event('submit', { cancelable: true }));
  await settle();
  assert.equal(store.editing, false);
  assert.equal(embedPath(root), '/embed/pykpO5kQJ98', 'not a blank screen');
});

test('duplicate source lines are tried once', async (t) => {
  const saved = { channels: [{ id: 'x', name: 'X', sources: ['GotlA1KKWoo', 'https://youtu.be/GotlA1KKWoo'] }], selected: null };
  const { root, chip } = mount(t, { saved });
  chip('X').click();
  await settle();
  fakePlayer(root().querySelector('iframe')).say({ event: 'onError', info: 150 });
  await settle();
  assert.match(root().textContent, /Could not play this channel/);
  assert.equal(root().querySelector('[role="alert"]').textContent.includes('Could not play'), true);
});

test('a layout that hides the column stops playback', async (t) => {
  const { root, chip } = mount(t);
  chip('CNN').click();
  await settle();
  assert.ok(root().querySelector('iframe'));
  const holder = root().parentElement;
  holder.style.display = 'none';
  globalThis.dispatchEvent(new Event('resize'));
  await settle();
  assert.equal(root().querySelector('iframe'), null);
  holder.style.display = '';
  globalThis.dispatchEvent(new Event('resize'));
  await settle();
  assert.ok(root().querySelector('iframe'));
});

test('saving an unchanged list keeps the defaults following the app', async (t) => {
  const { root, store } = mount(t);
  root().querySelector('.live-tv-gear').click();
  await settle();
  root().querySelector('.live-tv-settings').dispatchEvent(new Event('submit', { cancelable: true }));
  await settle();
  assert.equal(store.editing, false);
  assert.equal(store.custom, false);
});

test('when the browser will not store the list, nothing changes and it says so', async (t) => {
  const { root, store, button } = mount(t);
  root().querySelector('.live-tv-gear').click();
  await settle();
  button('Add channel').click();
  await settle();
  const last = [...root().querySelectorAll('.live-tv-row')].at(-1);
  const name = last.querySelector('input');
  name.value = 'Mine';
  name.dispatchEvent(new Event('input'));
  const area = last.querySelector('textarea');
  area.value = 'GotlA1KKWoo';
  area.dispatchEvent(new Event('input'));
  const real = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const full = {
    getItem: (key) => real.get ? real.get.call(globalThis).getItem(key) : null,
    setItem: () => {
      throw new Error('QuotaExceededError');
    },
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => full });
  t.after(() => Object.defineProperty(globalThis, 'localStorage', real));
  root().querySelector('.live-tv-settings').dispatchEvent(new Event('submit', { cancelable: true }));
  await settle();
  Object.defineProperty(globalThis, 'localStorage', real);
  assert.equal(store.editing, true);
  assert.equal(store.custom, false);
  assert.equal(store.channels.length, 8);
  assert.match(root().textContent, /would not save the list/);
});
