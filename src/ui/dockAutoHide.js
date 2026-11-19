/**
 * Auto-hiding bottom controls (fork feature): the command dock (locations,
 * voice, visual presets) and the bottom-right corner row (POWER UP, language)
 * fade out after a few idle seconds and return on any key press or when the
 * pointer nears the bottom edge. While they are hidden, the map attribution
 * drops to the bottom edge (styles in src/ui/styles/intel.css).
 *
 * They stay visible while hovered, while a tray or menu is open, while a form
 * field in them has focus, and on touch-only devices (no keyboard to recall
 * them). Only a body class changes; the controls themselves are untouched.
 */
export const DOCK_HIDDEN_CLASS = 'gev-dock-hidden';
// Upstream's Omnibar sits over the dock bar but outside #command-dock, so it
// hides and shows with it.
const SURFACES = ['#command-dock', '#corner-actions', '#gev-omnibar'];
const IDLE_MS = 4_000;
// Not a surface, but while any of these is up the controls stay: the guide
// may be pointing at one of them, and a voice session's stop button and
// waveform live in the dock.
const HOLDS =
  ".gev-guide.visible, #gev-voice-control[data-assistant-mode='voice']";
// While hidden, how often to check whether something now needs the controls
// (an Omnibar error arriving after its action, the guide opening).
const WATCH_MS = 1_000;
// Height of the bottom band that recalls the controls on pointer movement.
const REVEAL_ZONE_PX = 120;

/** True when a pointer at `clientY` is in the bottom recall band. */
export const inRevealZone = (
  clientY,
  viewportHeight,
  zonePx = REVEAL_ZONE_PX,
) => Number.isFinite(clientY) && clientY >= viewportHeight - zonePx;

/**
 * @param {{documentRef?: Document, windowRef?: Window, idleMs?: number,
 *   setTimer?: Function, clearTimer?: Function}} [options]
 * @returns {{reveal: Function, hide: Function, isHidden: () => boolean,
 *   destroy: Function}}
 */
export function createDockAutoHide({
  documentRef = document,
  windowRef = window,
  idleMs = IDLE_MS,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
} = {}) {
  const body = documentRef.body;
  let timer = null;
  let destroyed = false;

  const surfaces = () =>
    SURFACES.map((selector) => documentRef.querySelector(selector)).filter(
      Boolean,
    );

  // A keyboard is what brings the controls back; without a fine pointer
  // (phones, tablets) they are never hidden.
  const touchOnly = () =>
    body.classList.contains('mobile-shell') ||
    windowRef.matchMedia?.('(hover: none) and (pointer: coarse)')?.matches ===
      true;

  // The language search field always says aria-expanded="true", inside a popup
  // that is `hidden` while closed, so only controls on show count.
  const hasOpenMenu = (surface) =>
    Array.from(surface.querySelectorAll?.('[aria-expanded="true"]') ?? []).some(
      (control) => !control.closest('[hidden]'),
    );

  function inUse() {
    const active = documentRef.activeElement;
    if (documentRef.querySelector(HOLDS)) return true;
    return surfaces().some(
      (surface) =>
        surface.matches?.(':hover') ||
        hasOpenMenu(surface) ||
        // The Omnibar's results or feedback are on show.
        surface.classList?.contains?.('has-results') ||
        surface.querySelector?.(
          '.panel-collapsible:not(.collapsed), #location-bar:not(.collapsed)',
        ) ||
        (active &&
          surface.contains?.(active) &&
          /^(INPUT|SELECT|TEXTAREA)$/.test(active.tagName)),
    );
  }

  function schedule() {
    clearTimer(timer);
    timer = setTimer(hide, idleMs);
  }

  function hide() {
    timer = null;
    if (destroyed) return;
    if (touchOnly() || inUse()) {
      body.classList.remove(DOCK_HIDDEN_CLASS);
      schedule();
      return;
    }
    body.classList.add(DOCK_HIDDEN_CLASS);
    timer = setTimer(watch, WATCH_MS);
  }

  // Hidden controls can't be hovered or focused, so whatever holds them now
  // (Omnibar results, the guide, a voice session) came from elsewhere.
  function watch() {
    timer = null;
    if (destroyed || !body.classList.contains(DOCK_HIDDEN_CLASS)) return;
    if (inUse()) reveal();
    else timer = setTimer(watch, WATCH_MS);
  }

  function reveal() {
    if (destroyed) return;
    body.classList.remove(DOCK_HIDDEN_CLASS);
    schedule();
  }

  const onKey = () => reveal();
  const onPointer = (event) => {
    if (inRevealZone(event.clientY, windowRef.innerHeight)) reveal();
  };

  documentRef.addEventListener('keydown', onKey, true);
  documentRef.addEventListener('pointermove', onPointer, { passive: true });
  documentRef.addEventListener('pointerdown', onPointer, { passive: true });
  // Shown at start so first-time users see the controls, then hidden.
  schedule();

  return {
    reveal,
    hide,
    isHidden: () => body.classList.contains(DOCK_HIDDEN_CLASS),
    destroy() {
      destroyed = true;
      clearTimer(timer);
      documentRef.removeEventListener('keydown', onKey, true);
      documentRef.removeEventListener('pointermove', onPointer);
      documentRef.removeEventListener('pointerdown', onPointer);
      body.classList.remove(DOCK_HIDDEN_CLASS);
    },
  };
}
