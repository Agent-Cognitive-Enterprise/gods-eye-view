/**
 * @module ui/resourcesMonitor
 * @description The RESOURCES panel's owner (fork feature). While the panel is
 * on screen and the page is visible it reads /api/resources every few seconds
 * and lists the layers on in this browser; it switches server jobs (this
 * computer only, the server checks) and turns layers off through the data
 * manager, as the layer list's own toggle does.
 */
import { watch } from 'vue';
import { shownLayerName } from './layerNames.js';
import { useResourcesStore } from './stores/resources.js';
import { applicationPinia } from './vueRuntime.js';

export const RESOURCES_POLL_MS = 5000;

/**
 * The layers on now, largest first by what they hold.
 * @param {object} dataManager
 * @returns {Array<{id: string, name: string, count: number|null, objects: number|null}>}
 */
export function enabledLayers(dataManager) {
  const out = [];
  for (const [id, layer] of dataManager?.layers ?? []) {
    if (!dataManager.isEnabled?.(id)) continue;
    let stats = null;
    try {
      stats = (layer?.module ?? layer)?.getStats?.() ?? null;
    } catch {
      stats = null;
    }
    const number = (value) => (Number.isFinite(value) ? value : null);
    out.push({
      id,
      name: shownLayerName(layer?.name ?? (layer?.module ?? layer)?.name, id),
      count: number(stats?.count),
      objects: number(stats?.objects),
    });
  }
  return out.sort((a, b) => (b.count ?? -1) - (a.count ?? -1));
}

/**
 * @param {{dataManager: object, fetchImpl?: Function, documentRef?: Document|null,
 *   store?: ReturnType<typeof useResourcesStore>, pollMs?: number,
 *   setTimer?: Function, clearTimer?: Function}} options
 */
export function createResourcesMonitor({
  dataManager,
  fetchImpl = (...args) => globalThis.fetch(...args),
  documentRef = globalThis.document ?? null,
  store = useResourcesStore(applicationPinia),
  pollMs = RESOURCES_POLL_MS,
  setTimer = (fn, ms) => setInterval(fn, ms),
  clearTimer = (timer) => clearInterval(timer),
} = {}) {
  let timer = null;
  let destroyed = false;
  let inFlight = null;

  const following = () => store.visible && !documentRef?.hidden && !destroyed;

  async function refresh() {
    if (destroyed) return;
    store.publishLayers(enabledLayers(dataManager));
    if (inFlight) return inFlight;
    if (!store.server) store.setState('loading');
    inFlight = (async () => {
      try {
        const response = await fetchImpl('/api/resources', {
          cache: 'no-store',
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.json();
        if (destroyed) return;
        store.publish(body);
        store.setState('ok');
      } catch (error) {
        if (!destroyed)
          store.setState('error', String(error?.message ?? error));
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  function follow() {
    if (following()) {
      if (!timer) {
        void refresh();
        timer = setTimer(() => void refresh(), pollMs);
      }
    } else if (timer) {
      clearTimer(timer);
      timer = null;
    }
  }

  async function post(path, body) {
    const response = await fetchImpl(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    const answer = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new Error(
        answer?.error || answer?.outcome || `HTTP ${response.status}`,
      );
    return answer;
  }

  async function switching(id, work) {
    store.setPending(id);
    store.setSwitchError(null);
    try {
      await work();
    } catch (error) {
      // Kept apart from the read state, which the refresh below sets.
      store.setSwitchError(String(error?.message ?? error));
    } finally {
      store.setPending(null);
    }
    await refresh();
  }

  const owner = store.connect({
    setJob: (id, enabled) =>
      switching(id, () =>
        post(`/api/resources/jobs/${encodeURIComponent(id)}`, { enabled }),
      ),
    restoreDefaults: () =>
      switching('restore', () => post('/api/resources/restore')),
    layerOff: (id) =>
      switching(`layer:${id}`, () => dataManager.setEnabled(id, false)),
    refresh: () => refresh(),
  });
  const stopWatch = watch(() => store.visible, follow);
  const onVisibility = () => follow();
  documentRef?.addEventListener?.('visibilitychange', onVisibility);
  follow();

  return {
    refresh,
    destroy() {
      destroyed = true;
      stopWatch();
      documentRef?.removeEventListener?.('visibilitychange', onVisibility);
      if (timer) clearTimer(timer);
      timer = null;
      store.detach(owner);
    },
  };
}
