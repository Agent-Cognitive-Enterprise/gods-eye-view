// Fork: Autopilot keeps its hands off the camera while the page opens.
//
// Upstream's opening (src/app/openingIntro.js) flies the camera in from far
// out once the start-up restore settles. An Autopilot flight that starts
// before it would be overwritten by the opening's first frame; one that
// starts during it stops the opening and pans in from deep space.
//
// Start-up (src/app/startupChrome.js) hides the loading screen once it has
// decided about the opening: at once when none plays, or from the opening
// itself, which counts as playing (openingPlaying()) until the camera has
// landed. So the camera is held while the cover still shows or an opening
// flies. Once free it stays free; after `maxMs` it is free regardless, so a
// start-up that never ends cannot keep Autopilot grounded.

export const STARTUP_HOLD_MAX_MS = 60_000;

/**
 * @param {{loadingScreen?: Element | null, coverDecides?: boolean,
 *   openingPlaying?: () => boolean, now?: () => number, maxMs?: number}}
 *   options `coverDecides`: whether start-up chrome runs on this page and so
 *   will hide the loading screen (without it the cover says nothing).
 * @returns {() => boolean} true while Autopilot must not move the camera.
 */
export function createStartupHold({
  loadingScreen = null,
  coverDecides = true,
  openingPlaying = () => false,
  now = () => Date.now(),
  maxMs = STARTUP_HOLD_MAX_MS,
} = {}) {
  const startedAt = now();
  let free = false;
  return function held() {
    if (free) return false;
    if (now() - startedAt >= maxMs) {
      free = true;
      return false;
    }
    const covered =
      coverDecides &&
      !!loadingScreen &&
      loadingScreen.classList?.contains('hidden') === false;
    if (covered || openingPlaying()) return true;
    free = true;
    return false;
  };
}
