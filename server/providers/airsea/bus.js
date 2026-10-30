// Hand-off from the app's existing traffic proxies to the air/sea density
// service (fork feature). The proxies call publishTrafficSnapshot() with a
// body they already fetched and cached; nothing here contacts a provider, so
// density adds no upstream request and no second poller.

const latest = new Map(); // provider id -> {body|payload, receivedAt, seq}
const listeners = new Set();
let seq = 0;

/**
 * @param {string} provider Source id from src/airsea/sources.js.
 * @param {{body?: string, payload?: object, receivedAt?: number}} snapshot
 */
export function publishTrafficSnapshot(provider, snapshot) {
  seq += 1;
  latest.set(provider, {
    ...snapshot,
    receivedAt: snapshot.receivedAt ?? Date.now(),
    seq,
  });
  for (const listener of listeners) listener(provider);
}

/** Called after every snapshot; returns an unsubscribe function. */
export function subscribeTrafficSnapshots(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Snapshots newer than `afterSeq`, oldest first. */
export function trafficSnapshotsSince(afterSeq = 0) {
  return [...latest.entries()]
    .filter(([, s]) => s.seq > afterSeq)
    .sort((a, b) => a[1].seq - b[1].seq)
    .map(([provider, s]) => ({ provider, ...s }));
}

export function resetTrafficSnapshots() {
  latest.clear();
  seq = 0;
}
