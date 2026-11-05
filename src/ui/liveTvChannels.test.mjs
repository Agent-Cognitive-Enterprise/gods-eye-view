// LIVE TV channels: only parsed YouTube and https HLS sources are ever played,
// edits are checked before they are kept, and the defaults follow the app until
// someone edits the list.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CHANNELS,
  STORAGE_KEY,
  defaultChannels,
  loadLiveTv,
  parseSource,
  saveLiveTv,
  validateChannels,
  youtubeEmbedUrl,
} from './liveTvChannels.js';

const memory = (initial = {}) => {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = String(v);
    },
  };
};

test('YouTube videos parse from every common address form', () => {
  for (const text of [
    'GotlA1KKWoo',
    'https://www.youtube.com/watch?v=GotlA1KKWoo',
    'https://youtube.com/watch?v=GotlA1KKWoo&t=5',
    'https://m.youtube.com/watch?v=GotlA1KKWoo',
    'https://youtu.be/GotlA1KKWoo',
    'https://www.youtube.com/live/GotlA1KKWoo',
    'https://www.youtube.com/embed/GotlA1KKWoo',
    'https://www.youtube-nocookie.com/embed/GotlA1KKWoo',
  ])
    assert.deepEqual(parseSource(text), { kind: 'youtube-video', id: 'GotlA1KKWoo' }, text);
});

test('YouTube channels and https HLS streams parse', () => {
  assert.deepEqual(parseSource('https://www.youtube.com/channel/UCNye-wNBqNL5ZzHSJj3l8Bg'), {
    kind: 'youtube-channel',
    id: 'UCNye-wNBqNL5ZzHSJj3l8Bg',
  });
  assert.deepEqual(
    parseSource('https://www.youtube.com/embed/live_stream?channel=UCNye-wNBqNL5ZzHSJj3l8Bg'),
    { kind: 'youtube-channel', id: 'UCNye-wNBqNL5ZzHSJj3l8Bg' },
  );
  assert.deepEqual(parseSource(' https://example.org/live/index.m3u8?token=1 '), {
    kind: 'hls',
    url: 'https://example.org/live/index.m3u8?token=1',
  });
});

test('anything else is refused, so the player never loads an unparsed address', () => {
  for (const text of [
    '',
    'not a url',
    'http://example.org/live.m3u8',
    'javascript:alert(1)',
    'https://evil.example/watch?v=GotlA1KKWoo',
    'https://www.youtube.com/@CNN',
    'https://www.youtube.com/watch?v=short',
    'https://www.youtube.com/channel/notachannel',
    'https://user:pass@example.org/live.m3u8',
    'https://example.org/video.mp4',
    'data:application/vnd.apple.mpegurl,#EXTM3U',
  ])
    assert.equal(parseSource(text), null, text);
});

test('every default channel has a name and only valid sources', () => {
  assert.deepEqual(
    DEFAULT_CHANNELS.map((c) => c.name),
    ['Bloomberg', 'Sky News', 'Euronews', 'DW News', 'CNN', 'France 24', 'Al Jazeera', 'RT'],
  );
  for (const channel of DEFAULT_CHANNELS) {
    assert.ok(channel.sources.length, channel.id);
    for (const source of channel.sources) assert.ok(parseSource(source), source);
  }
  assert.deepEqual(validateChannels(defaultChannels()).errors, []);
});

test('the embed is privacy-mode, muted by default, and builds only from parsed ids', () => {
  const video = new URL(youtubeEmbedUrl({ kind: 'youtube-video', id: 'GotlA1KKWoo' }));
  assert.equal(video.origin, 'https://www.youtube-nocookie.com');
  assert.equal(video.pathname, '/embed/GotlA1KKWoo');
  assert.equal(video.searchParams.get('mute'), '1');
  assert.equal(video.searchParams.get('enablejsapi'), '1');
  const channel = new URL(
    youtubeEmbedUrl({ kind: 'youtube-channel', id: 'UCNye-wNBqNL5ZzHSJj3l8Bg' }, { muted: false, origin: 'http://localhost:4173' }),
  );
  assert.equal(channel.pathname, '/embed/live_stream');
  assert.equal(channel.searchParams.get('channel'), 'UCNye-wNBqNL5ZzHSJj3l8Bg');
  assert.equal(channel.searchParams.get('mute'), '0');
  assert.equal(channel.searchParams.get('origin'), 'http://localhost:4173');
});

test('validation names the channel and line of each problem', () => {
  const { errors } = validateChannels([
    { name: '', sources: 'GotlA1KKWoo' },
    { name: 'Mine', sources: 'GotlA1KKWoo\nnot a source\n' },
    { name: 'Empty', sources: '\n  \n' },
  ]);
  assert.deepEqual(errors, [
    { channel: 1, code: 'name' },
    { channel: 2, line: 2, code: 'source' },
    { channel: 3, code: 'no_source' },
  ]);
  assert.deepEqual(validateChannels([]).errors, [{ channel: 0, code: 'empty' }]);
});

test('validation keeps ids unique and accepts sources as lines or a list', () => {
  const { channels, errors } = validateChannels([
    { name: 'My News', sources: ['GotlA1KKWoo'] },
    { name: 'My News', sources: 'https://example.org/a.m3u8' },
  ]);
  assert.deepEqual(errors, []);
  assert.deepEqual(
    channels.map((c) => c.id),
    ['my-news', 'my-news-2'],
  );
  assert.deepEqual(channels[1].sources, ['https://example.org/a.m3u8']);
});

test('the defaults are used until someone edits; only then is the list stored', () => {
  const storage = memory();
  const fresh = loadLiveTv(storage);
  assert.equal(fresh.custom, false);
  assert.equal(fresh.selected, null);
  assert.equal(fresh.muted, true);
  assert.equal(fresh.channels.length, DEFAULT_CHANNELS.length);
  saveLiveTv({ ...fresh, selected: 'cnn', muted: false }, storage);
  assert.deepEqual(JSON.parse(storage.data[STORAGE_KEY]), { selected: 'cnn', muted: false });
  const again = loadLiveTv(storage);
  assert.equal(again.selected, 'cnn');
  assert.equal(again.muted, true, 'every load starts muted, whatever was saved');
  const custom = { channels: [{ id: 'x', name: 'X', sources: ['GotlA1KKWoo'] }], custom: true, selected: 'x', muted: true };
  saveLiveTv(custom, storage);
  const edited = loadLiveTv(storage);
  assert.equal(edited.custom, true);
  assert.deepEqual(edited.channels, [{ id: 'x', name: 'X', sources: ['GotlA1KKWoo'] }]);
  assert.equal(edited.selected, 'x');
});

test('unreadable or tampered storage falls back to the defaults', () => {
  for (const raw of ['{not json', JSON.stringify({ channels: [{ name: 'Bad', sources: ['javascript:alert(1)'] }], selected: 'bad' })]) {
    const state = loadLiveTv(memory({ [STORAGE_KEY]: raw }));
    assert.equal(state.custom, false);
    assert.equal(state.channels.length, DEFAULT_CHANNELS.length);
    assert.equal(state.selected, null);
  }
  const throwing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('full'); } };
  assert.equal(loadLiveTv(throwing).custom, false);
  assert.equal(saveLiveTv(loadLiveTv(throwing), throwing), false);
});
