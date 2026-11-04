import { defineStore } from 'pinia';
import { markRaw, ref, shallowRef } from 'vue';
import { createOwners } from './owners.js';

const OPEN_KEY = 'gev.worldOverview.open';

const readOpen = () => {
  try {
    return globalThis.localStorage?.getItem(OPEN_KEY) !== '0';
  } catch {
    return true;
  }
};

/**
 * The Autopilot world overview (fork feature). The console's overview owner
 * (src/ui/worldOverview.js) publishes the model and, separately and throttled, the
 * camera; the view renders them. Whether the map is shown is the person's choice and
 * is remembered here; whether it is on screen the view reports, so the owner can stop
 * following the camera when nobody can see it.
 */
export const useWorldOverviewStore = defineStore('gev-world-overview', () => {
  /** The overview model (src/intel/overviewModel.js); null while Autopilot is off. */
  const model = shallowRef(null);
  /** {x, y, heading} on the unit map, or null when the camera's place is unknown. */
  const camera = shallowRef(null);
  const open = ref(readOpen());
  const visible = ref(false);

  function publish(next) {
    model.value = next ? markRaw(next) : null;
  }
  function publishCamera(next) {
    camera.value = next ? markRaw(next) : null;
  }
  function setOpen(value) {
    open.value = Boolean(value);
    try {
      globalThis.localStorage?.setItem(OPEN_KEY, open.value ? '1' : '0');
    } catch {
      // Not remembered; the toggle still works.
    }
  }
  function setVisible(value) {
    visible.value = Boolean(value);
  }

  const { connect, detach, act } = createOwners();
  return {
    model,
    camera,
    open,
    visible,
    publish,
    publishCamera,
    setOpen,
    setVisible,
    connect,
    detach,
    act,
  };
});
