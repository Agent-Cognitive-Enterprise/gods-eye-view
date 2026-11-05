<script setup>
import { storeToRefs } from 'pinia';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { t } from '../../../i18n/index.js';
import UiButton from '../../kit/UiButton.vue';
import RailPanel from '../../rail/RailPanel.vue';
import { MAX_CHANNELS, MAX_SOURCES, parseSource, youtubeEmbedUrl } from '../../liveTvChannels.js';
import { YOUTUBE_STARTUP_MS, attachLiveStream, startupGuard } from '../../liveTvPlayer.js';
import { usePanelChromeStore } from '../../stores/panelChrome.js';
import { useLiveTvStore } from '../../stores/liveTv.js';

// LIVE TV (fork feature): one live news channel at the foot of the left column.
// Nothing loads until a channel is picked; collapsing the panel, opening its
// editor, or a layout that hides the column (phones, embed, clean view) stops it.
// It starts muted on every load; while narration speaks (`gev:speech` from
// src/voice/localAudio.js) the sound drops, then returns to where it was.
const PANEL_ID = 'live-tv-panel';
const DUCKED = 0.2;
const store = useLiveTvStore();
const { channels, current, muted, editing, custom } = storeToRefs(store);
const { panels } = storeToRefs(usePanelChromeStore());
const collapsed = computed(() => panels.value[PANEL_ID]?.collapsed ?? true);

const sourceIndex = ref(0);
const status = ref('idle'); // idle | loading | live | failed
/** Every source failed; cleared by picking a channel or Try again. */
const exhausted = ref(false);
/** Bumped by Try again, so a one-source channel starts over too. */
const attempt = ref(0);
/** Utterances speaking now, across every speech player. */
const speakers = ref(0);
const speaking = computed(() => speakers.value > 0);
/** Whether the panel is laid out at all (phones, embed and clean view hide the column). */
const onScreen = ref(true);
const video = ref(null);
const frame = ref(null);
const sources = computed(() => {
  if (!current.value) return [];
  const seen = new Set();
  return current.value.sources
    .map(parseSource)
    .filter(Boolean)
    .filter((source) => {
      const key = source.kind === 'hls' ? source.url : `${source.kind}:${source.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
});
const active = computed(() => sources.value[sourceIndex.value] ?? null);
const showing = computed(
  () => !collapsed.value && onScreen.value && !editing.value && !exhausted.value && !!active.value,
);
const origin = globalThis.location?.origin ?? '';
// The iframe is created once per source and attempt: mute and volume go through
// postMessage, so the src must not change underneath a playing stream.
const embedSrc = shallowRef(null);
const frameKey = computed(() => `${sourceIndex.value}:${attempt.value}:${embedSrc.value}`);

const STATUS = {
  loading: () => t('Loading…'),
  live: () => t('LIVE'),
  failed: () => t('Could not play this channel.'),
};
const statusText = computed(() => STATUS[status.value]?.() ?? '');
const host = computed(() => {
  if (!active.value) return '';
  if (active.value.kind !== 'hls') return 'YouTube';
  try {
    return new URL(active.value.url).hostname;
  } catch {
    return '';
  }
});

function pick(id) {
  if (current.value?.id === id && !exhausted.value) return;
  sourceIndex.value = 0;
  exhausted.value = false;
  store.select(id);
}

function retry() {
  sourceIndex.value = 0;
  exhausted.value = false;
  attempt.value += 1;
}

/** A source failed: try the next, or say the channel cannot play. */
function nextSource() {
  if (sourceIndex.value + 1 < sources.value.length) {
    sourceIndex.value += 1;
  } else {
    exhausted.value = true;
    status.value = 'failed';
  }
}

/** The Next source button cycles, so it never declares a playing channel failed. */
function switchSource() {
  if (sources.value.length < 2) return;
  sourceIndex.value = (sourceIndex.value + 1) % sources.value.length;
}

// One player at a time, released whenever the source, panel or choice changes.
let stopHls = null;
let stopGuard = null;
function stopStream() {
  stopHls?.();
  stopHls = null;
  stopGuard?.();
  stopGuard = null;
}

// Volume: the person's own level is kept and only lowered while narration speaks.
let hlsVolume = 1;
let youtubeVolume = 100;
function applyMute() {
  if (video.value) video.value.muted = muted.value;
  ytCommand(muted.value ? 'mute' : 'unMute');
}
function applyDuck() {
  if (video.value) video.value.volume = speaking.value ? hlsVolume * DUCKED : hlsVolume;
  ytCommand('setVolume', [Math.round(speaking.value ? youtubeVolume * DUCKED : youtubeVolume)]);
}
function onVolumeChange() {
  // A change made on the player while nothing is ducked is the person's level.
  if (video.value && !speaking.value) hlsVolume = video.value.volume;
}

watch(
  [showing, active, attempt],
  async () => {
    stopStream();
    if (!showing.value) {
      embedSrc.value = null;
      if (!exhausted.value) status.value = 'idle';
      return;
    }
    status.value = 'loading';
    const source = active.value;
    if (source.kind !== 'hls') {
      embedSrc.value = youtubeEmbedUrl(source, { muted: muted.value, origin });
      // The player reports its own errors; a page that never loads reports
      // nothing, so it is timed out too.
      stopGuard = startupGuard(YOUTUBE_STARTUP_MS, () => {
        if (active.value === source && status.value !== 'live') nextSource();
      });
      return;
    }
    embedSrc.value = null;
    await nextTick();
    if (!video.value || !showing.value || active.value !== source) return;
    video.value.muted = muted.value;
    video.value.volume = speaking.value ? hlsVolume * DUCKED : hlsVolume;
    stopHls = attachLiveStream(video.value, source.url, {
      onPlaying: () => {
        if (active.value === source) status.value = 'live';
      },
      onFailure: () => {
        if (active.value === source) nextSource();
      },
      // The browser refused sound without a click: show it muted, as it is.
      onMuted: () => store.setMuted(true),
    });
  },
  { immediate: true },
);
watch(muted, applyMute);
watch(speaking, applyDuck);
watch(status, (value) => {
  if (value !== 'live') return;
  stopGuard?.();
  stopGuard = null;
});
watch(current, () => {
  // A new channel, or the list was edited: start from its first source.
  sourceIndex.value = 0;
  exhausted.value = false;
  if (!current.value) status.value = 'idle';
});

// YouTube: the iframe API over postMessage, without loading YouTube's script.
function ytCommand(func, args = []) {
  frame.value?.contentWindow?.postMessage(JSON.stringify({ event: 'command', func, args }), '*');
}
function frameLoaded() {
  frame.value?.contentWindow?.postMessage(JSON.stringify({ event: 'listening', id: PANEL_ID, channel: 'widget' }), '*');
  applyMute();
  if (speaking.value) applyDuck();
}
function onMessage(event) {
  if (!frame.value || event.source !== frame.value.contentWindow) return;
  if (!/^https:\/\/www\.youtube(-nocookie)?\.com$/.test(event.origin)) return;
  let data;
  try {
    data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
  } catch {
    return;
  }
  if (data?.event === 'onError') nextSource();
  else if (data?.event === 'onStateChange' && data.info === 1) status.value = 'live';
  else if (data?.event === 'infoDelivery') {
    if (data.info?.playerState === 1) status.value = 'live';
    // The player's own volume, as the person set it, while nothing is ducked.
    if (!speaking.value && Number.isFinite(data.info?.volume)) youtubeVolume = data.info.volume;
  }
}
function onSpeech(event) {
  speakers.value = Math.max(0, speakers.value + (event.detail?.speaking ? 1 : -1));
}

// Phones, embed mode and clean view hide the column by layout; a stream nobody
// can see or stop must not keep playing.
let observer = null;
function measureOnScreen() {
  const doc = globalThis.document;
  const view = doc?.defaultView;
  let element = doc?.getElementById(PANEL_ID)?.parentElement ?? null;
  for (; element && element !== doc.body; element = element.parentElement) {
    if (view?.getComputedStyle?.(element).display === 'none') {
      onScreen.value = false;
      return;
    }
  }
  onScreen.value = true;
}
onMounted(() => {
  globalThis.addEventListener?.('message', onMessage);
  globalThis.addEventListener?.('gev:speech', onSpeech);
  globalThis.addEventListener?.('resize', measureOnScreen);
  const body = globalThis.document?.body;
  if (body && typeof globalThis.MutationObserver === 'function') {
    observer = new globalThis.MutationObserver(measureOnScreen);
    observer.observe(body, { attributes: true, attributeFilter: ['class'] });
  }
  measureOnScreen();
});
onBeforeUnmount(() => {
  stopStream();
  observer?.disconnect();
  globalThis.removeEventListener?.('message', onMessage);
  globalThis.removeEventListener?.('gev:speech', onSpeech);
  globalThis.removeEventListener?.('resize', measureOnScreen);
});

// Settings: an editable copy, saved only when every row checks out.
const draft = ref([]);
const errors = ref([]);
function openSettings() {
  draft.value = channels.value.map((c) => ({ id: c.id, name: c.name, sources: c.sources.join('\n') }));
  errors.value = [];
  store.setEditing(true);
}
function closeSettings() {
  errors.value = [];
  store.setEditing(false);
}
function toggleSettings() {
  if (editing.value) closeSettings();
  else openSettings();
}
// Errors name rows by position, so any change to the rows clears them.
function move(index, by) {
  const list = [...draft.value];
  const [row] = list.splice(index, 1);
  list.splice(index + by, 0, row);
  draft.value = list;
  errors.value = [];
}
function removeRow(index) {
  draft.value = draft.value.filter((_, i) => i !== index);
  errors.value = [];
}
function addRow() {
  draft.value = [...draft.value, { name: '', sources: '' }];
  errors.value = [];
}
function save() {
  errors.value = store.saveChannels(draft.value);
}
function reset() {
  store.resetChannels();
  errors.value = [];
}
const ERROR = {
  name: () => t('Give this channel a name.'),
  source: (e) => t('Line {line} is not a YouTube address or an https .m3u8 stream.', { line: e.line }),
  no_source: () => t('Add at least one source.'),
  too_many_sources: () => t('Use at most {count} sources.', { count: MAX_SOURCES }),
  empty: () => t('Keep at least one channel.'),
  too_many: () => t('Use at most {count} channels.', { count: MAX_CHANNELS }),
  storage: () => t('This browser would not save the list. Nothing was changed.'),
};
const rowErrors = (index) => errors.value.filter((e) => e.channel === index + 1).map((e) => ERROR[e.code]?.(e));
const listErrors = computed(() => errors.value.filter((e) => e.channel === 0).map((e) => ERROR[e.code]?.(e)));
</script>

<template>
  <RailPanel :id="PANEL_ID" start-collapsed :title="t('LIVE TV')">
    <template #actions>
      <button type="button" class="live-tv-gear" :class="{ active: editing }" :aria-pressed="String(editing)" :aria-label="t('Channel settings')" :title="t('Channel settings')" @click.stop="toggleSettings"><span class="material-symbols-outlined" aria-hidden="true">settings</span></button>
    </template>
    <div id="live-tv-body">
      <template v-if="!editing">
        <div class="live-tv-channels" role="group" :aria-label="t('Live TV channels')">
          <UiButton v-for="channel in channels" :key="channel.id" class="data-toggle-chip" pressed-class="active" :pressed="current?.id === channel.id" @click="pick(channel.id)">{{ channel.name }}</UiButton>
        </div>
        <div v-if="current" class="live-tv-screen">
          <video v-if="showing && active?.kind === 'hls'" ref="video" class="live-tv-media" playsinline :aria-label="current.name" @volumechange="onVolumeChange"></video>
          <iframe v-else-if="showing && embedSrc" :key="frameKey" ref="frame" class="live-tv-media" :src="embedSrc" :title="current.name" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen referrerpolicy="strict-origin-when-cross-origin" @load="frameLoaded"></iframe>
          <p v-else-if="status === 'failed'" class="live-tv-empty" role="alert">{{ statusText }}<br />{{ t('It may not be available in your region, or its address has changed.') }}</p>
        </div>
        <p v-else class="live-tv-empty intel-muted">{{ t('Pick a channel to start. Nothing plays until you do.') }}</p>
        <div v-if="current" class="live-tv-controls">
          <span class="live-tv-status" :class="`is-${status}`" role="status" aria-live="polite"><template v-if="status !== 'failed'">{{ statusText }}<template v-if="host"> · {{ host }}</template></template></span>
          <UiButton v-if="sources.length > 1 && status !== 'failed'" class="data-toggle-chip" @click="switchSource">{{ t('Next source') }}</UiButton>
          <UiButton v-if="status === 'failed'" class="data-toggle-chip" @click="retry">{{ t('Try again') }}</UiButton>
          <UiButton class="data-toggle-chip" :pressed="!muted" pressed-class="active" @click="store.setMuted(!muted)">{{ muted ? t('Unmute') : t('Mute') }}</UiButton>
          <UiButton class="data-toggle-chip" @click="store.select(null)">{{ t('Stop') }}</UiButton>
        </div>
      </template>
      <form v-else class="live-tv-settings" @submit.prevent="save">
        <p class="intel-muted">{{ t('Each source is a YouTube video or channel address, or an https .m3u8 stream. They are tried in order.') }}</p>
        <div v-for="(row, index) in draft" :key="index" class="live-tv-row">
          <div class="live-tv-row-head">
            <input v-model="row.name" class="gev-field" type="text" maxlength="40" :aria-label="t('Name')" :placeholder="t('Name')" />
            <button type="button" class="live-tv-icon" :disabled="index === 0" :aria-label="t('Move up')" :title="t('Move up')" @click="move(index, -1)">▲</button>
            <button type="button" class="live-tv-icon" :disabled="index === draft.length - 1" :aria-label="t('Move down')" :title="t('Move down')" @click="move(index, 1)">▼</button>
            <button type="button" class="live-tv-icon" :aria-label="t('Remove')" :title="t('Remove')" @click="removeRow(index)">✕</button>
          </div>
          <textarea v-model="row.sources" class="gev-field" rows="2" dir="ltr" spellcheck="false" :aria-label="t('Sources, one per line')" :placeholder="t('Sources, one per line')"></textarea>
          <p v-for="message in rowErrors(index)" :key="message" class="live-tv-error" role="alert">{{ message }}</p>
        </div>
        <p v-for="message in listErrors" :key="message" class="live-tv-error" role="alert">{{ message }}</p>
        <div class="live-tv-controls">
          <UiButton class="data-toggle-chip" :disabled="draft.length >= MAX_CHANNELS" @click="addRow">{{ t('Add channel') }}</UiButton>
          <UiButton class="data-toggle-chip" :disabled="!custom" @click="reset">{{ t('Reset to defaults') }}</UiButton>
          <UiButton class="data-toggle-chip" @click="closeSettings">{{ t('Cancel') }}</UiButton>
          <UiButton class="data-toggle-chip active" type="submit">{{ t('Save') }}</UiButton>
        </div>
      </form>
    </div>
  </RailPanel>
</template>
