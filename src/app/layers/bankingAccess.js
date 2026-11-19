import { createBankingAccessLayer } from '../../layers/bankingAccess/index.js';
import * as picking from '../../data/pickRegistry.js';
import * as overlays from '../../overlays/worldOverlay.js';
import { isPointerFree } from '../../data/inputOwnership.js';
import { inputFor } from '../../input/dispatcher.js';

/**
 * The banking layer's click contract (setInputAction/destroy) over the
 * scene's one input dispatcher: no handler of its own, and the dispatcher's
 * one pick of the click, as its topHit, instead of another scene.pick.
 */
export function dispatcherClickHandler(viewer) {
  let off = null;
  return {
    setInputAction(fn) {
      off?.();
      off = inputFor(viewer).onClick((event) =>
        fn({
          position: event.screenPosition,
          // The shared click itself: the pick registry reads the card on top
          // once per click object, so every layer agrees on it.
          event,
          get hit() {
            return event.topHit;
          },
        }),
      );
    },
    destroy() {
      off?.();
      off = null;
    },
  };
}

/** Wire the banking-access layer (fork feature) into the application catalog. */
export function createApplicationBankingAccess(options) {
  return createBankingAccessLayer({
    overlayHost: {
      setEntries: overlays.setOverlayEntries,
      setVisible: overlays.setOverlaySourceVisible,
      clearSource: overlays.clearOverlaySource,
      hitTest: overlays.hitTestWorldOverlay,
    },
    screenSpaceEventHandlerFactory: dispatcherClickHandler,
    picking,
    pointer: { isPointerFree },
    ...options,
  });
}
