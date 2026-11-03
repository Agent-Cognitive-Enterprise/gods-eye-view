import { defineStore } from 'pinia';
import { markRaw, ref, shallowRef } from 'vue';
import { createOwners } from './owners.js';

/**
 * The FAST INTELLIGENCE panel (fork feature). createFastIntelPanel owns the
 * server's data, the map filters and the event open in the list, and publishes
 * them here; the panel view renders them through presentFastIntel(), so its text
 * follows the language, and asks the owner for every change through act(). Only
 * which sections are unfolded lives here alone: nothing else reads it.
 */
export const useFastIntelStore = defineStore('gev-fast-intel', () => {
  /** What the owner presents; null while the panel is not shown. */
  const state = shallowRef(null);
  const sourcesOpen = ref(false);
  const healthOpen = ref(false);

  /** @param {object|null} next A fresh presentation; every publish re-renders. */
  function publish(next) {
    state.value = next ? markRaw(next) : null;
  }

  const { connect, detach, act } = createOwners();

  return {
    state,
    sourcesOpen,
    healthOpen,
    publish,
    connect,
    detach,
    act,
  };
});
