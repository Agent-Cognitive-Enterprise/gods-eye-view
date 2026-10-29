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
const SURFACES = ['#command-dock', '#corner-actions'];
const IDLE_MS = 4_000;
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

  function inUse() {
    const active = documentRef.activeElement;
    return surfaces().some(
      (surface) =>
        surface.matches?.(':hover') ||
        surface.querySelector?.('[aria-expanded="true"]') ||
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
