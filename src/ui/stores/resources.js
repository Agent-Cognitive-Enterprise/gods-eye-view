import { defineStore } from 'pinia';
import { markRaw, ref, shallowRef } from 'vue';
import { createOwners } from './owners.js';

/**
 * The RESOURCES panel (fork feature). The monitor (src/ui/resourcesMonitor.js)
 * publishes the server's figures and jobs (/api/resources) and the layers on in
 * this browser; the view renders them, reports whether it is on screen (the
 * monitor polls only then), and asks the monitor to switch things.
 */
export const useResourcesStore = defineStore('gev-resources', () => {
  /** The last /api/resources answer, or null before the first. */
  const server = shallowRef(null);
  /** Layers on in this browser: [{id, name, count, objects}], largest first. */
  const layers = shallowRef([]);
  /** 'idle' | 'loading' | 'ok' | 'error' */
  const state = ref('idle');
  const error = ref(null);
  /** The job or layer id being switched, or null. */
  const pending = ref(null);
  /** Why the last switch failed (e.g. local_only), or null. */
  const switchError = ref(null);
  const visible = ref(false);

  function publish(next) {
    server.value = next ? markRaw(next) : null;
  }
  function publishLayers(next) {
    layers.value = markRaw(next ?? []);
  }
  function setState(next, message = null) {
    state.value = next;
    error.value = message;
  }
  function setPending(id) {
    pending.value = id ?? null;
  }
  function setSwitchError(message) {
    switchError.value = message ?? null;
  }
  function setVisible(value) {
    visible.value = Boolean(value);
  }

  const { connect, detach, act } = createOwners();
  return {
    server,
    layers,
    state,
    error,
    pending,
    switchError,
    visible,
    publish,
    publishLayers,
    setState,
    setPending,
    setSwitchError,
    setVisible,
    connect,
    detach,
    act,
  };
});
