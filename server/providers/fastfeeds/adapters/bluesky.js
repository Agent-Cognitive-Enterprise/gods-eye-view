// Bluesky Jetstream v2: public posts as they are published, over one WebSocket.
// A plain JSON stream, so no SDK. Only the accounts on the operator's list are
// requested; an empty list opens no connection at all. The stored cursor
// resumes the stream after any outage, and because delivery is at-least-once
// the queue's (source, record, cid) key makes a replayed post a no-op.
//
// Times: `time` is when the stream saw the commit and cannot be forged by the
// author; a post's own `createdAt` can. It is believed only when it is older
// (an import of an old post stays old), never to make a post look newer.

const HOSTS = Object.freeze([
  'jetstream.us-west.bsky.network',
  'jetstream.us-east.bsky.network',
]);
const ROUTE = '/xrpc/network.bsky.jetstream.subscribeEvents';
const SUBPROTOCOL = 'xrpc.v1.json';
const POST_COLLECTION = 'app.bsky.feed.post';
// The documented limit is 10,000, but the public hosts refuse an address over
// about 8 KB (measured 2026-10-31: 150 accounts open, 200 refused). Beyond this
// the whole post stream is read and filtered here: about 30 posts a second.
const MAX_SERVER_FILTERED_DIDS = 150;
const MAX_FRAME_BYTES = 256 * 1024;
const MAX_TEXT = 3_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 5 * 60_000;
const FLUSH_MS = 100;
const FLUSH_SIZE = 200;
// Keeps the cursor moving when nothing listed is posting.
const CURSOR_SAVE_MS = 5_000;
// A healthy stream of a few accounts can be silent for hours, so silence is
// not an outage; the socket's own close and error events are what count.
const CONNECT_TIMEOUT_MS = 20_000;
// Seqs are per instance: after switching host, step back a little and let the
// queue's idempotent key absorb the overlap.
const HOST_SWITCH_REWIND = 2_000;
const DID = /^did:(?:plc|web):[a-zA-Z0-9._:%-]{1,256}$/;
const RKEY = /^[a-zA-Z0-9._~:-]{1,512}$/;

export const isDid = (value) => DID.test(String(value ?? ''));

export const atUri = (did, rkey) => `at://${did}/${POST_COLLECTION}/${rkey}`;

/** at://did/collection/rkey to a public post link, or null. */
export function postLink(did, rkey) {
  return RKEY.test(rkey)
    ? `https://bsky.app/profile/${did}/post/${rkey}`
    : null;
}

/** The stream address for a set of accounts, resuming after `cursor`. */
export function jetstreamUrl(host, dids, cursor) {
  const params = new URLSearchParams();
  params.append('collections', POST_COLLECTION);
  params.append('kinds', 'commit');
  if (dids.length <= MAX_SERVER_FILTERED_DIDS)
    for (const did of dids) params.append('dids', did);
  if (cursor !== null && cursor !== undefined && cursor !== '')
    params.append('cursor', String(cursor));
  return `wss://${host}${ROUTE}?${params}`;
}

const parseTime = (value) => {
  const ms = Date.parse(String(value ?? ''));
  return Number.isFinite(ms) ? ms : null;
};

/** Bounded delay before reconnect attempt `attempt`, with full jitter. */
export function backoffMs(attempt, random = Math.random) {
  const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** attempt);
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

/**
 * When a post was published, from what the stream saw and what it claims.
 * @returns {{published_at: number, suspect: boolean}}
 */
export function publicationTime(streamTime, createdAt) {
  const seen = parseTime(streamTime);
  const claimed = parseTime(createdAt);
  if (seen === null) return { published_at: claimed, suspect: true };
  if (claimed === null) return { published_at: seen, suspect: true };
  return claimed < seen
    ? { published_at: claimed, suspect: false }
    : { published_at: seen, suspect: claimed - seen > 5 * 60_000 };
}

/** The link a post shares, if any: what makes two posts one origin. */
function linkedArticle(record) {
  const embed = record?.embed;
  return embed?.external?.uri ?? embed?.media?.external?.uri ?? null;
}

/** The account a quote post quotes, if any: its source, not a new one. */
function quotedAccount(record) {
  const embed = record?.embed;
  const uri = embed?.record?.uri ?? embed?.record?.record?.uri ?? null;
  const did = /^at:\/\/(did:[^/]+)\//.exec(String(uri ?? ''))?.[1];
  return did && isDid(did) ? `bsky:${did}` : null;
}

/**
 * One Jetstream frame to a queue report, or a reason it is not one.
 * @returns {{report?: object, skip?: string, seq?: number}}
 */
export function frameToReport(frame, { receivedAt, accountsByDid, canonical }) {
  if (frame?.$type === 'error') return { error: frame.error ?? 'stream_error' };
  const event = frame?.payload;
  if (!event || !String(event.$type).endsWith('#commit'))
    return { skip: 'not_a_commit', seq: event?.seq };
  const { seq, did, rkey, operation, collection } = event;
  if (collection !== POST_COLLECTION) return { skip: 'other_collection', seq };
  if (!isDid(did) || !RKEY.test(String(rkey)))
    return { skip: 'malformed', seq };
  const account = accountsByDid.get(did);
  // The filter is the server's; a frame for anyone else is not ours to keep.
  if (!account) return { skip: 'unlisted_account', seq };
  const nativeId = atUri(did, rkey);
  const base = {
    native_id: nativeId,
    provider: 'bluesky',
    publisher: `bsky:${did}`,
    priority: account.tag === 'official' ? 2 : 1,
    received_at: receivedAt,
  };
  if (operation === 'delete')
    return {
      seq,
      report: {
        ...base,
        kind: 'delete',
        revision: `delete:${event.rev ?? seq}`,
        published_at: parseTime(event.time),
      },
    };
  if (operation !== 'create' && operation !== 'update')
    return { skip: 'unknown_operation', seq };
  const record = event.record;
  const text =
    typeof record?.text === 'string' ? record.text.slice(0, MAX_TEXT) : '';
  if (!text.trim()) return { skip: 'no_text', seq };
  // A reply continues somebody's conversation; it is not a report of its own.
  if (record.reply) return { skip: 'reply', seq };
  const { published_at: publishedAt, suspect } = publicationTime(
    event.time,
    record.createdAt,
  );
  return {
    seq,
    report: {
      ...base,
      kind: operation === 'update' ? 'edit' : 'post',
      revision: String(event.cid ?? event.rev ?? seq),
      published_at: publishedAt,
      time_suspect: suspect,
      text,
      language: Array.isArray(record.langs) ? record.langs[0] : undefined,
      url: postLink(did, rkey),
      source_type: account.source_type,
      origin: canonical(linkedArticle(record)),
      derived_from: quotedAccount(record),
      license: 'Public post; Bluesky terms apply',
      attribution: account.label ? `${account.label} on Bluesky` : 'Bluesky',
    },
  };
}

/**
 * @param {{id?: string, accounts: () => object[], intake: object,
 *   canonical: Function, WebSocketImpl?: Function, now?: () => number,
 *   hosts?: string[], log?: Function, setTimer?: Function, clearTimer?: Function,
 *   random?: () => number}} options
 */
export function createBlueskyAdapter({
  id = 'bluesky',
  accounts,
  intake,
  canonical,
  WebSocketImpl = globalThis.WebSocket,
  now = () => Date.now(),
  hosts = HOSTS,
  log = (...args) => console.warn(...args),
  setTimer = (fn, ms) => {
    // Never what keeps the server process alive.
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return timer;
  },
  clearTimer = (timer) => clearTimeout(timer),
  random = Math.random,
}) {
  const state = {
    connected: false,
    connected_at: null,
    last_frame_at: null,
    last_report_at: null,
    last_published_at: null,
    last_error: null,
    last_error_at: null,
    reconnects: 0,
    attempt: 0,
    host: null,
    disabled: false,
  };
  let socket = null;
  let running = false;
  let retryTimer = null;
  let connectTimer = null;
  let flushTimer = null;
  // Separate: a report must never wait on the slow cursor save.
  let cursorTimer = null;
  let buffer = [];
  let cursor = null;
  // The cursor as stored, in step with the stored reports.
  let storedCursor = null;
  let hostIndex = 0;
  let accountIndex = new Map();

  function fail(reason) {
    state.last_error = String(reason).slice(0, 200);
    state.last_error_at = now();
  }

  /**
   * Socket and timer callbacks run outside any request: anything thrown there
   * would stop the whole server, every other feed with it.
   */
  const guarded =
    (work) =>
    (...args) => {
      try {
        return work(...args);
      } catch (error) {
        fail(error.message);
        log(`[fast-feeds] bluesky: ${error.message}`);
        return undefined;
      }
    };

  const flush = guarded(() => {
    clearTimer(flushTimer);
    clearTimer(cursorTimer);
    flushTimer = null;
    cursorTimer = null;
    if (!buffer.length && cursor === storedCursor) return;
    const reports = buffer;
    const reached = cursor;
    buffer = [];
    try {
      intake.enqueue(id, reports, { cursor: reached });
      storedCursor = reached;
    } catch (error) {
      // Nothing was stored. Go back to the stored cursor and reconnect, and the
      // stream delivers these again; carrying on would skip past them for good.
      cursor = storedCursor;
      const ws = socket;
      socket = null;
      ws?.close();
      throw error;
    }
  });

  function hold(report) {
    buffer.push(report);
    if (buffer.length >= FLUSH_SIZE) flush();
    else flushTimer ??= setTimer(flush, FLUSH_MS);
  }

  function schedule(reason) {
    if (!running) return;
    state.attempt += 1;
    state.reconnects += 1;
    const delay = backoffMs(state.attempt, random);
    log(`[fast-feeds] bluesky: ${reason}; retrying in ${delay} ms`);
    retryTimer = setTimer(connect, delay);
  }

  function onMessage(message) {
    const at = now();
    state.last_frame_at = at;
    const size =
      typeof message.data === 'string'
        ? message.data.length
        : (message.data?.byteLength ?? 0);
    if (size > MAX_FRAME_BYTES) {
      intake.deadLetter(id, 'oversized_frame', `${size} bytes`);
      return;
    }
    let frame;
    try {
      frame = JSON.parse(
        typeof message.data === 'string'
          ? message.data
          : new TextDecoder().decode(message.data),
      );
    } catch {
      intake.deadLetter(
        id,
        'malformed_json',
        String(message.data).slice(0, 200),
      );
      return;
    }
    const outcome = frameToReport(frame, {
      receivedAt: at,
      accountsByDid: accountIndex,
      canonical,
    });
    if (outcome.error) {
      fail(outcome.error);
      return;
    }
    if (Number.isFinite(outcome.seq)) cursor = String(outcome.seq);
    if (!outcome.report) {
      // Expected in volume when the stream is filtered here, so not counted.
      if (outcome.skip && outcome.skip !== 'unlisted_account')
        intake.count(id, `skip_${outcome.skip}`);
      cursorTimer ??= setTimer(flush, CURSOR_SAVE_MS);
      return;
    }
    state.last_report_at = at;
    if (outcome.report.published_at)
      state.last_published_at = outcome.report.published_at;
    hold(outcome.report);
  }

  function connect() {
    retryTimer = null;
    if (!running) return;
    const list = accounts().filter((account) => isDid(account.did));
    accountIndex = new Map(list.map((account) => [account.did, account]));
    // Nothing to follow is a valid state: no stream is opened.
    if (!list.length) {
      state.connected = false;
      return;
    }
    const host = hosts[hostIndex % hosts.length];
    state.host = host;
    let opened = false;
    let closed = false;
    const ws = new WebSocketImpl(
      jetstreamUrl(
        host,
        list.map((a) => a.did),
        cursor,
      ),
      [SUBPROTOCOL],
    );
    ws.binaryType = 'arraybuffer';
    socket = ws;
    connectTimer = setTimer(() => ws.close(), CONNECT_TIMEOUT_MS);
    ws.onopen = () => {
      opened = true;
      clearTimer(connectTimer);
      state.connected = true;
      state.connected_at = now();
      state.attempt = 0;
      state.last_error = null;
    };
    ws.onmessage = guarded((message) => {
      // A socket given up on after a failed write must not move the cursor.
      if (running && socket === ws) onMessage(message);
    });
    ws.onerror = (event) => fail(event?.message || 'connection failed');
    ws.onclose = guarded((event) => {
      if (closed) return;
      closed = true;
      clearTimer(connectTimer);
      state.connected = false;
      if (socket === ws) socket = null;
      // After stop() the queue may already be closed; stop() has flushed.
      if (!running) return;
      flush();
      if (!opened) {
        // A refused cursor (too old for the stream's replay window) would be
        // refused for ever: forget it and take the live tail, and say so.
        if (cursor && state.attempt >= 2) {
          intake.count(id, 'cursor_abandoned');
          fail(
            'stored cursor refused; resumed at the live tail, a gap is possible',
          );
          cursor = null;
        }
        hostIndex += 1;
        if (cursor) {
          const value = Number(cursor);
          if (Number.isFinite(value) && value > HOST_SWITCH_REWIND)
            cursor = String(value - HOST_SWITCH_REWIND);
        }
      }
      schedule(`stream closed (${event?.code ?? 'no code'})`);
    });
  }

  return {
    id,
    kind: 'push',
    provider: 'bluesky',
    start() {
      if (running || state.disabled) return;
      running = true;
      cursor = intake.cursor(id);
      storedCursor = cursor;
      connect();
    },
    stop() {
      if (!running) return;
      running = false;
      clearTimer(retryTimer);
      clearTimer(connectTimer);
      flush();
      socket?.close(1000);
      socket = null;
      state.connected = false;
    },
    /** The account list changed: reopen the stream with the new filter. */
    restart() {
      if (!running) return;
      clearTimer(retryTimer);
      const ws = socket;
      if (ws) ws.close(1000);
      else connect();
    },
    setEnabled(value) {
      state.disabled = !value;
      if (value) this.start();
      else this.stop();
    },
    health(at = now()) {
      const followed = accounts().length;
      const status = state.disabled
        ? 'disabled'
        : !followed
          ? 'needs_sources'
          : state.connected
            ? 'healthy'
            : state.attempt >= 3
              ? 'offline'
              : 'degraded';
      return {
        id,
        provider: 'bluesky',
        kind: 'push',
        status,
        followed,
        cursor,
        ...state,
        connected_for_ms: state.connected ? at - state.connected_at : null,
      };
    },
  };
}
