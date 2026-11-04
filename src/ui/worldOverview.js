// Owner of the Autopilot world overview (fork feature). A read-only observer: the
// console hands it the scheduler's state after each of its own renders, and it follows
// the camera from Cesium's postRender, which fires only when the scene renders anyway.
// So it adds no poll, no render request and no continuous-render hold. Camera updates
// are throttled and stop while the map is hidden, off screen or the tab is hidden.

import {
  overviewModel,
  recordVisit,
  sameModel,
} from '../intel/overviewModel.js';
import { headingDegrees, project } from '../intel/mercator.js';
import { watch } from 'vue';
import { useWorldOverviewStore } from './stores/worldOverview.js';
import { applicationPinia } from './vueRuntime.js';

const CAMERA_INTERVAL_MS = 150; // at most about 7 camera updates a second
const toDeg = (rad) => (rad * 180) / Math.PI;

/**
 * @param {{viewer: object, onSelect: (id: string) => void,
 *   documentRef?: Document, store?: object, now?: () => number}} options
 */
export function createWorldOverview({
  viewer,
  onSelect,
  documentRef = globalThis.document,
  store = useWorldOverviewStore(applicationPinia()),
  now = () => Date.now(),
}) {
  let visited = [];
  let lastInput = null;
  let lastModel = null;
  let lastCameraAt = 0;
  let lastCamera = null;
  let destroyed = false;
  let dirty = false;
  const perf = () => globalThis.__perfCounters;

  const following = () => store.open && store.visible && !documentRef?.hidden;

  function readCamera() {
    const carto = viewer?.camera?.positionCartographic;
    if (
      !carto ||
      !Number.isFinite(carto.latitude) ||
      !Number.isFinite(carto.longitude)
    )
      return null;
    const point = project(toDeg(carto.latitude), toDeg(carto.longitude));
    if (!point) return null;
    return {
      x: point.x,
      y: point.y,
      heading: Math.round(headingDegrees(viewer.camera.heading)),
      heightM: Math.round(carto.height),
    };
  }

  function updateCamera(force = false) {
    if (destroyed || (!force && !following())) return;
    const at = now();
    if (!force && at - lastCameraAt < CAMERA_INTERVAL_MS) return;
    lastCameraAt = at;
    const camera = readCamera();
    const same =
      camera &&
      lastCamera &&
      Math.abs(camera.x - lastCamera.x) < 0.0005 &&
      Math.abs(camera.y - lastCamera.y) < 0.0005 &&
      camera.heading === lastCamera.heading;
    if (same) return;
    lastCamera = camera;
    store.publishCamera(camera);
  }

  function rebuild() {
    if (destroyed || !lastInput) return;
    // Nobody can see it (collapsed, scrolled away, background tab): remember to
    // catch up, and do nothing now.
    if (!store.open || !store.visible || documentRef?.hidden) {
      dirty = true;
      return;
    }
    dirty = false;
    const started = performance.now();
    const likely =
      typeof lastInput.likely === 'function'
        ? lastInput.likely()
        : lastInput.likely;
    const next = overviewModel({
      ...lastInput,
      likely,
      visited,
      cameraKnown: Boolean(readCamera()),
    });
    if (!sameModel(next, lastModel)) {
      lastModel = next;
      store.publish(next);
      const counters = perf();
      if (counters) counters.overviewUpdates += 1;
    }
    perf()?.overviewMs?.push(performance.now() - started);
  }

  const removePostRender = viewer?.scene?.postRender?.addEventListener?.(() =>
    updateCamera(),
  );
  const removeMoveEnd = viewer?.camera?.moveEnd?.addEventListener?.(() =>
    updateCamera(true),
  );
  const owner = store.connect({
    select: (id) => onSelect?.(id),
    toggle: () => {
      store.setOpen(!store.open);
      if (store.open) updateCamera(true);
    },
  });
  const catchUp = () => {
    if (dirty && store.open && store.visible && !documentRef?.hidden) rebuild();
    if (store.open && store.visible) updateCamera(true);
  };
  const stopWatch = watch(() => [store.visible, store.open], catchUp);
  documentRef?.addEventListener?.('visibilitychange', catchUp);
  updateCamera(true);

  return {
    /**
     * The console's state after each of its renders. Unchanged state draws nothing.
     * @param {{mode: string, world: string, schedulerCurrent: object|null,
     *   clusters: object[], events: object[], likely: object[]}} input
     */
    update(input) {
      // Arrivals belong to the world they happened in: a switch between the drill
      // and live events must not carry one's stops into the other.
      if (lastInput && lastInput.world !== input.world) visited = [];
      lastInput = input;
      rebuild();
    },
    /** A flight arrived and its shot is on screen: remember it as visited. */
    visit(entry) {
      visited = recordVisit(visited, { ...entry, shownAt: now() });
      rebuild();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      removePostRender?.();
      removeMoveEnd?.();
      stopWatch();
      documentRef?.removeEventListener?.('visibilitychange', catchUp);
      store.detach(owner);
      store.publish(null);
      store.publishCamera(null);
    },
  };
}
