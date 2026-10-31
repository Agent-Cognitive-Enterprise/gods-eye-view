// Shared test doubles for the fast-feed tests. Everything here is synthetic:
// the accounts below do not exist and nothing is contacted.

export const SYNTHETIC_DID = 'did:plc:syntheticreporter0000001';
export const SYNTHETIC_DID_2 = 'did:plc:syntheticreporter0000002';
export const SYNTHETIC_DID_3 = 'did:plc:syntheticreporter0000003';

/** A socket the test drives by hand. */
export function fakeSockets() {
  const sockets = [];
  class FakeSocket {
    constructor(url, protocols) {
      this.url = url;
      this.protocols = protocols;
      this.closedWith = null;
      sockets.push(this);
    }
    close(code) {
      this.closedWith = code ?? null;
      this.onclose?.({ code });
    }
    open() {
      this.onopen?.();
    }
    frame(value) {
      this.onmessage?.({
        data: typeof value === 'string' ? value : JSON.stringify(value),
      });
    }
    drop(code = 1006) {
      this.onclose?.({ code });
    }
  }
  return { FakeSocket, sockets, last: () => sockets.at(-1) };
}

/** Timers the test runs by hand. */
export function fakeTimers() {
  const pending = new Map();
  let serial = 0;
  return {
    setTimer(fn, ms) {
      serial += 1;
      pending.set(serial, { fn, ms });
      return serial;
    },
    clearTimer(id) {
      pending.delete(id);
    },
    delays: () => [...pending.values()].map((t) => t.ms),
    run() {
      const due = [...pending.values()];
      pending.clear();
      for (const { fn } of due) fn();
    },
  };
}

export const postFrame = ({
  did = SYNTHETIC_DID,
  rkey = '3mabc',
  seq = 1000,
  time = '2026-10-31T03:20:00.000Z',
  createdAt = '2026-10-31T03:19:59.000Z',
  text = 'Synthetic test report: explosions heard in Kharkiv',
  operation = 'create',
  cid = `bafy${rkey}${seq}`,
  ...record
} = {}) => ({
  $type: 'message',
  payload: {
    $type: 'network.bsky.jetstream.subscribeEvents#commit',
    collection: 'app.bsky.feed.post',
    did,
    rkey,
    seq,
    time,
    witnessedAt: time,
    operation,
    rev: `rev${seq}`,
    cid,
    record: {
      $type: 'app.bsky.feed.post',
      createdAt,
      text,
      langs: ['en'],
      ...record,
    },
  },
});

export const deleteFrame = ({
  did = SYNTHETIC_DID,
  rkey = '3mabc',
  seq = 2000,
} = {}) => ({
  $type: 'message',
  payload: {
    $type: 'network.bsky.jetstream.subscribeEvents#commit',
    collection: 'app.bsky.feed.post',
    did,
    rkey,
    seq,
    time: '2026-10-31T03:30:00.000Z',
    operation: 'delete',
    rev: `rev${seq}`,
  },
});
