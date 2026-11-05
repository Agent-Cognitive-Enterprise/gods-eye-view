/**
 * LIVE TV channels (fork feature): the defaults, the sources a person may add,
 * and how the choice is kept in this browser. Pure apart from the storage it is
 * given.
 *
 * A source is one of:
 * - a YouTube video: a watch, live, embed, shorts or youtu.be address, or a bare
 *   11-character id;
 * - a YouTube channel: youtube.com/channel/UC…, which plays whatever that channel
 *   has live, so it survives a broadcaster restarting its stream under a new id;
 * - an HLS stream: an https address ending in .m3u8.
 * A channel's sources are tried in order until one plays. Nothing else is
 * accepted: the player never loads an address it has not parsed.
 */

/**
 * Defaults, each broadcaster's own stream first where one answers with an open
 * CORS header, then its own YouTube live. Checked 2026-11-05. Stream addresses
 * change without notice: edit them in the panel's settings, or here.
 */
export const DEFAULT_CHANNELS = Object.freeze([
  {
    id: 'bloomberg',
    name: 'Bloomberg',
    // Bloomberg's own stream did not play from Australia; its YouTube live does.
    sources: [
      'https://www.youtube.com/watch?v=QB5BNdBFujE',
      'https://bloomberg.com/media-manifest/streams/us.m3u8',
      'https://www.youtube.com/channel/UCIALMKvObZNtJ6AmdCLP7Lg',
    ],
  },
  {
    id: 'sky',
    name: 'Sky News',
    sources: [
      'https://linear901-oo-hls0-prd-gtm.delivery.skycdp.com/17501/sde-fast-skynews/master.m3u8',
      'https://www.youtube.com/channel/UCoMdktPbSTixAyNGwb-UYkQ',
    ],
  },
  {
    id: 'euronews',
    name: 'Euronews',
    sources: [
      'https://www.youtube.com/watch?v=pykpO5kQJ98',
      'https://www.youtube.com/channel/UCSrZ3UV4jOidv8ppoVuvW9Q',
    ],
  },
  {
    id: 'dw',
    name: 'DW News',
    sources: [
      'https://dwamdstream103.akamaized.net/hls/live/2015526/dwstream103/master.m3u8',
      'https://www.youtube.com/watch?v=LuKwFajn37U',
      'https://www.youtube.com/channel/UCknLrEdhRCp1aegoMqRaCZg',
    ],
  },
  {
    id: 'cnn',
    name: 'CNN',
    // CNN Headlines, CNN's own free 24/7 live; the full channel needs a TV login.
    // YouTube blocks it in some regions (Australia, 2026-11-05: "Video unavailable").
    sources: ['https://www.youtube.com/watch?v=GotlA1KKWoo'],
  },
  {
    id: 'france24',
    name: 'France 24',
    sources: [
      'https://www.youtube.com/watch?v=HvZt-nh9sGg',
      'https://www.youtube.com/channel/UCQfwfsi5VrQ8yKZ-UWmAEFg',
    ],
  },
  {
    id: 'aljazeera',
    name: 'Al Jazeera',
    sources: [
      'https://live-hls-apps-aje-fa.getaj.net/AJE/index.m3u8',
      'https://www.youtube.com/watch?v=gCNeDWCI0vo',
      'https://www.youtube.com/channel/UCNye-wNBqNL5ZzHSJj3l8Bg',
    ],
  },
  {
    id: 'rt',
    name: 'RT',
    // RT's own stream; RT has no YouTube channel since 2022.
    sources: ['https://rt-glb.rttv.com/dvr/rtnews/playlist.m3u8'],
  },
]);

export const STORAGE_KEY = 'gev:live-tv:v1';
export const MAX_CHANNELS = 40;
export const MAX_SOURCES = 6;
export const MAX_NAME = 40;

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
]);

/**
 * @param {string} text What a person typed, or a default.
 * @returns {{kind: 'youtube-video', id: string}|{kind: 'youtube-channel', id: string}|{kind: 'hls', url: string}|null}
 */
export function parseSource(text) {
  const value = String(text ?? '').trim();
  if (VIDEO_ID.test(value)) return { kind: 'youtube-video', id: value };
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  if (url.protocol === 'https:' && /\.m3u8$/i.test(url.pathname))
    return { kind: 'hls', url: url.href };
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (host === 'youtu.be') {
    const id = url.pathname.slice(1);
    return VIDEO_ID.test(id) ? { kind: 'youtube-video', id } : null;
  }
  if (!YOUTUBE_HOSTS.has(host)) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] === 'watch') {
    const id = url.searchParams.get('v') ?? '';
    return VIDEO_ID.test(id) ? { kind: 'youtube-video', id } : null;
  }
  if (['live', 'embed', 'shorts'].includes(parts[0]) && parts[1]) {
    if (parts[0] === 'embed' && parts[1] === 'live_stream') {
      const id = url.searchParams.get('channel') ?? '';
      return CHANNEL_ID.test(id) ? { kind: 'youtube-channel', id } : null;
    }
    return VIDEO_ID.test(parts[1])
      ? { kind: 'youtube-video', id: parts[1] }
      : null;
  }
  if (parts[0] === 'channel' && CHANNEL_ID.test(parts[1] ?? ''))
    return { kind: 'youtube-channel', id: parts[1] };
  return null;
}

/**
 * The privacy-mode embed for a parsed YouTube source. `enablejsapi` lets the
 * panel mute, set the volume and hear about errors through postMessage.
 * @param {{kind: string, id: string}} source
 * @param {{muted?: boolean, origin?: string}} [options]
 */
export function youtubeEmbedUrl(source, { muted = true, origin = '' } = {}) {
  const base =
    source.kind === 'youtube-channel'
      ? `https://www.youtube-nocookie.com/embed/live_stream?channel=${encodeURIComponent(source.id)}&`
      : `https://www.youtube-nocookie.com/embed/${encodeURIComponent(source.id)}?`;
  const params = new URLSearchParams({
    autoplay: '1',
    mute: muted ? '1' : '0',
    playsinline: '1',
    rel: '0',
    enablejsapi: '1',
  });
  if (origin) params.set('origin', origin);
  return base + params.toString();
}

const slug = (name) =>
  String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 24) || 'channel';

/**
 * Checks an edited list. Errors name the channel (1-based) and, for a source,
 * its line, so the editor can show them where they belong.
 * @param {{id?: string, name: string, sources: string[]|string}[]} list
 * @returns {{channels: {id: string, name: string, sources: string[]}[], errors: {channel: number, line?: number, code: string}[]}}
 */
export function validateChannels(list) {
  const errors = [];
  const channels = [];
  const ids = new Set();
  if (!Array.isArray(list) || !list.length)
    return { channels, errors: [{ channel: 0, code: 'empty' }] };
  if (list.length > MAX_CHANNELS) errors.push({ channel: 0, code: 'too_many' });
  list.slice(0, MAX_CHANNELS).forEach((item, index) => {
    const channel = index + 1;
    const name = String(item?.name ?? '')
      .trim()
      .slice(0, MAX_NAME);
    if (!name) errors.push({ channel, code: 'name' });
    const lines = Array.isArray(item?.sources)
      ? item.sources
      : String(item?.sources ?? '').split('\n');
    const sources = [];
    lines.forEach((raw, i) => {
      const text = String(raw).trim();
      if (!text) return;
      if (!parseSource(text))
        errors.push({ channel, line: i + 1, code: 'source' });
      else sources.push(text);
    });
    if (!sources.length && !errors.some((e) => e.channel === channel && e.line))
      errors.push({ channel, code: 'no_source' });
    if (sources.length > MAX_SOURCES)
      errors.push({ channel, code: 'too_many_sources' });
    let id = typeof item?.id === 'string' && item.id ? item.id : slug(name);
    for (let n = 2; ids.has(id); n += 1) id = `${slug(name)}-${n}`;
    ids.add(id);
    channels.push({ id, name, sources: sources.slice(0, MAX_SOURCES) });
  });
  return { channels, errors };
}

const copy = (channels) =>
  channels.map((c) => ({ id: c.id, name: c.name, sources: [...c.sources] }));

/**
 * What this browser keeps: the channel list only once someone edits it (so the
 * defaults can improve with the app), the last channel and whether it was muted.
 * Anything unreadable falls back to the defaults.
 */
export function loadLiveTv(storage = globalThis.localStorage) {
  let saved = null;
  try {
    saved = JSON.parse(storage?.getItem(STORAGE_KEY) ?? 'null');
  } catch {
    saved = null;
  }
  let custom = null;
  if (Array.isArray(saved?.channels)) {
    const { channels, errors } = validateChannels(saved.channels);
    if (!errors.length) custom = channels;
  }
  const channels = custom ?? copy(DEFAULT_CHANNELS);
  const selected = channels.some((c) => c.id === saved?.selected)
    ? saved.selected
    : null;
  return {
    channels,
    custom: !!custom,
    selected,
    muted: saved?.muted !== false,
  };
}

/** @returns {boolean} Whether it was written. */
export function saveLiveTv(state, storage = globalThis.localStorage) {
  try {
    storage?.setItem(
      STORAGE_KEY,
      JSON.stringify({
        ...(state.custom ? { channels: copy(state.channels) } : {}),
        selected: state.selected ?? null,
        muted: state.muted !== false,
      }),
    );
    return true;
  } catch {
    return false;
  }
}

/** Fresh copies of the defaults, for "Reset to defaults". */
export function defaultChannels() {
  return copy(DEFAULT_CHANNELS);
}
