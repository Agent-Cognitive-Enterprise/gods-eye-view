import { defineStore } from 'pinia';
import { computed, ref, shallowRef } from 'vue';
import {
  defaultChannels,
  loadLiveTv,
  saveLiveTv,
  validateChannels,
} from '../liveTvChannels.js';

/**
 * LIVE TV (fork feature): the channel list, the channel on screen and whether
 * it is muted, kept in this browser (src/ui/liveTvChannels.js). The panel owns
 * playback; nothing else reads this. Nothing plays until someone picks a channel.
 */
export const useLiveTvStore = defineStore('gev-live-tv', () => {
  const initial = loadLiveTv();
  const channels = shallowRef(initial.channels);
  /** Whether the list was edited here; until then the defaults follow the app. */
  const custom = ref(initial.custom);
  const selected = ref(initial.selected);
  const muted = ref(initial.muted);
  const editing = ref(false);

  const current = computed(
    () => channels.value.find((c) => c.id === selected.value) ?? null,
  );

  const persist = () =>
    saveLiveTv({
      channels: channels.value,
      custom: custom.value,
      selected: selected.value,
      muted: muted.value,
    });

  /** @param {string|null} id A channel, or null to stop. */
  function select(id) {
    selected.value = channels.value.some((c) => c.id === id) ? id : null;
    persist();
  }

  function setMuted(value) {
    muted.value = !!value;
    persist();
  }

  function setEditing(value) {
    editing.value = !!value;
  }

  /**
   * @param {{id?: string, name: string, sources: string[]|string}[]} list
   * @returns {{channel: number, line?: number, code: string}[]} Errors; empty when saved.
   */
  function saveChannels(list) {
    const { channels: next, errors } = validateChannels(list);
    if (errors.length) return errors;
    channels.value = next;
    custom.value = true;
    if (!next.some((c) => c.id === selected.value)) selected.value = null;
    editing.value = false;
    persist();
    return [];
  }

  function resetChannels() {
    channels.value = defaultChannels();
    custom.value = false;
    if (!channels.value.some((c) => c.id === selected.value))
      selected.value = null;
    editing.value = false;
    persist();
  }

  return {
    channels,
    custom,
    selected,
    muted,
    editing,
    current,
    select,
    setMuted,
    setEditing,
    saveChannels,
    resetChannels,
  };
});
