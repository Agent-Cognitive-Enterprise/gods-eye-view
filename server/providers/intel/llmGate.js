// Foreground claim on the shared local model. A voice conversation keeps the
// model (and KoboldCpp's prompt cache) for itself while it is active; the
// background assessor checks this gate and waits. Process-scoped.

let foregroundUntil = 0;

/** Keep the model for interactive use for the next `ms` milliseconds. */
export function claimForeground(ms = 60_000, now = Date.now()) {
  foregroundUntil = Math.max(foregroundUntil, now + ms);
}

/** Release the claim immediately (voice stopped). */
export function releaseForeground() {
  foregroundUntil = 0;
}

/** Whether an interactive user currently has priority. */
export function foregroundActive(now = Date.now()) {
  return now < foregroundUntil;
}
