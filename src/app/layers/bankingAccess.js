import { createBankingAccessLayer } from '../../layers/bankingAccess/index.js';
import * as picking from '../../data/pickRegistry.js';
import * as overlays from '../../overlays/worldOverlay.js';
import { isPointerFree } from '../../data/inputOwnership.js';
import { inputFor } from '../../input/dispatcher.js';

/** Wire the banking-access layer (fork feature) into the application catalog. */
export function createApplicationBankingAccess(options) {
  return createBankingAccessLayer({
    overlayHost: {
      setEntries: overlays.setOverlayEntries,
      setVisible: overlays.setOverlaySourceVisible,
      clearSource: overlays.clearOverlaySource,
      hitTest: overlays.hitTestWorldOverlay,
    },
    // The layer's click contract (setInputAction/destroy) over the scene's
    // one input dispatcher: no handler of its own, and the dispatcher's one
    // pick of the click instead of another scene.pick.
    screenSpaceEventHandlerFactory: (viewer) => {
      let off = null;
      return {
        setInputAction(fn) {
          off?.();
          off = inputFor(viewer).onClick((event) =>
            fn({
              position: event.screenPosition,
              get pick() {
                return event.pick;
              },
            }),
          );
        },
        destroy() {
          off?.();
          off = null;
        },
      };
    },
    picking,
    pointer: { isPointerFree },
    ...options,
  });
}
