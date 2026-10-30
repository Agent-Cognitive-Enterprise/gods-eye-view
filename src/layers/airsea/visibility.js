// Visibility bookkeeping for the Air & Sea layers (fork feature).
//
// The layer manager settles a layer's visibility only after its first
// update, which can take seconds; what was last *requested* is the better
// guide to whose layer it is. And only a person's own choice (panel, voice,
// tool) is remembered across reloads: not the Autopilot revealing a layer,
// not a restore, not teardown.

import {
  LAYER_RESTORE_ORIGINS,
  isExplicitLayerStateOrigin,
} from '../../data/layerState.js';

/** Origin for a layer this browser had left on, switched on after a reload. */
export const RESTORE_ORIGIN = LAYER_RESTORE_ORIGINS.local;

/**
 * @param {object} manager The layer data manager.
 * @param {{id?: string, remember?: (enabled: boolean) => void,
 *   onRequest?: (change: object) => void}} [options]
 *   `remember`: called with explicit requests for layer `id`.
 */
export function trackVisibility(
  manager,
  { id = null, remember, onRequest } = {},
) {
  const intent = new Map();
  const unsubscribe = manager?.subscribeVisibilityRequests?.((change) => {
    if (change?.type !== 'visibility-requested' || !change.layerId) return;
    intent.set(change.layerId, change.enabled === true);
    if (change.layerId === id && isExplicitLayerStateOrigin(change.origin))
      remember?.(change.enabled === true);
    onRequest?.(change);
  });
  return {
    /** The latest requested visibility, else the settled one. */
    wants(layerId) {
      return intent.has(layerId)
        ? intent.get(layerId)
        : manager?.isEnabled?.(layerId) === true;
    },
    stop() {
      unsubscribe?.();
    },
  };
}
