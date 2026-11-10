/** In-process fanout; attaches to the EXISTING AISStream ingest callback. */
const listeners = new Set();
export function subscribeRegionalAisPosition(listener) {
  if (typeof listener !== 'function')
    throw new TypeError('listener must be a function');
  listeners.add(listener);
  return () => listeners.delete(listener);
}
/**
 * Wrap the AIS store's ingest so every envelope it accepts also reaches the
 * bus. The store's answer is returned unchanged; publishing cannot throw.
 */
export function tapRegionalAisIngest(
  ingest,
  publish = publishRegionalAisPosition,
) {
  return (envelope) => {
    const stored = ingest(envelope);
    if (stored) publish(envelope);
    return stored;
  };
}
// Fork: a failing listener is reported at most once a minute, with a count;
// AIS can deliver hundreds of envelopes a second.
const WARN_EVERY_MS = 60_000;
let lastWarnAt = -Infinity;
let unreported = 0;

export function publishRegionalAisPosition(envelope, receivedAt) {
  // Nobody listening (the screen is off): no work on the AIS hot path.
  if (!listeners.size) return;
  const at = receivedAt ?? Date.now();
  // Never allow monitoring/analytics to break the primary vessel cache.
  for (const listener of listeners) {
    try {
      listener(envelope, at);
    } catch (error) {
      unreported += 1;
      if (at - lastWarnAt < WARN_EVERY_MS) continue;
      console.warn(
        `[regional-gnss] passive observer failed (${unreported}x since last report): ${error?.message}`,
      );
      lastWarnAt = at;
      unreported = 0;
    }
  }
}
