// Telegram public channels over MTProto with the operator's own login. Optional:
// without a login it reports `requires_credentials`, opens nothing, and every
// other feed carries on. Only channels the operator listed are read, and only
// public ones; there is no Bot API here, because a bot cannot read arbitrary
// public channels. Text only, no media, and no history beyond the bounded gap
// after an outage.

const FLUSH_MS = 100;
const MAX_TEXT = 3_000;
const BACKOFF_MIN_MS = 5_000;
const BACKOFF_MAX_MS = 15 * 60_000;
const GAP_FILL_LIMIT = 100;

/** One Telegram message to a queue report. */
export function messageToReport(message, { receivedAt, channel, canonical }) {
  const text = String(message.text ?? '').slice(0, MAX_TEXT);
  if (!text.trim()) return null;
  const nativeId = `tg:${message.channelId}:${message.id}`;
  const firstLink = /https?:\/\/[^\s<>"')\]]+/.exec(text)?.[0] ?? null;
  const edited = Boolean(message.editDate);
  return {
    native_id: nativeId,
    provider: 'telegram',
    publisher: `tg:${message.channelId}`,
    priority: channel.tag === 'official' ? 2 : 1,
    kind: edited ? 'edit' : 'post',
    revision: String(message.editDate ?? 0),
    // A forward's own time is when it was forwarded; the story is older.
    published_at: (message.forwardedDate ?? message.date) * 1000,
    received_at: receivedAt,
    text,
    url: `https://t.me/${channel.username}/${message.id}`,
    source_type: channel.source_type,
    origin: canonical(firstLink),
    // A forward names its origin, so a chain of channels is one source.
    derived_from: message.forwardedFrom ? `tg:${message.forwardedFrom}` : null,
    license: 'Public channel post; Telegram terms apply',
    attribution: `${channel.label || channel.username} on Telegram`,
  };
}

/**
 * @param {{id?: string, channels: () => object[], loadLogin: () => Promise<?object>,
 *   connect: Function, intake: object, canonical: Function, now?: () => number,
 *   log?: Function, setTimer?: Function, clearTimer?: Function}} options
 */
export function createTelegramAdapter({
  id = 'telegram',
  channels,
  loadLogin,
  connect,
  intake,
  canonical,
  now = () => Date.now(),
  log = (...args) => console.warn(...args),
  setTimer = (fn, ms) => {
    // Never what keeps the server process alive.
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return timer;
  },
  clearTimer = (timer) => clearTimeout(timer),
}) {
  const state = {
    connected: false,
    connected_at: null,
    last_report_at: null,
    last_published_at: null,
    last_error: null,
    last_error_at: null,
    reconnects: 0,
    attempt: 0,
    has_login: false,
    auth_expired: false,
    library_missing: false,
    disabled: false,
  };
  let client = null;
  let running = false;
  let retryTimer = null;
  let flushTimer = null;
  let buffer = [];
  // Highest message id stored per channel, kept with the reports.
  let lastIds = {};
  const byChannelId = new Map();

  const saveable = () => JSON.stringify(lastIds);

  function fail(reason) {
    state.last_error = String(reason).slice(0, 200);
    state.last_error_at = now();
  }

  /** Library callbacks run outside any request: nothing may escape them. */
  const guarded =
    (work) =>
    (...args) => {
      try {
        return work(...args);
      } catch (error) {
        fail(error.message);
        log(`[fast-feeds] telegram: ${error.message}`);
        return undefined;
      }
    };

  const flush = guarded(() => {
    clearTimer(flushTimer);
    flushTimer = null;
    if (!buffer.length) return;
    // Cleared only once stored: a failed write is tried again on the next flush.
    intake.enqueue(id, buffer, { cursor: saveable() });
    buffer = [];
  });

  function hold(report, message) {
    if (!report || !running) return;
    state.last_report_at = report.received_at;
    state.last_published_at = report.published_at;
    lastIds[message.channelId] = Math.max(
      lastIds[message.channelId] ?? 0,
      message.id,
    );
    buffer.push(report);
    flushTimer ??= setTimer(flush, FLUSH_MS);
  }

  const toReport = (message) => {
    const channel = byChannelId.get(message.channelId);
    return channel
      ? messageToReport(message, { receivedAt: now(), channel, canonical })
      : null;
  };

  function schedule() {
    if (!running) return;
    state.attempt += 1;
    state.reconnects += 1;
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** state.attempt);
    retryTimer = setTimer(open, delay);
  }

  async function open() {
    retryTimer = null;
    if (!running) return;
    let login;
    try {
      login = await loadLogin();
    } catch (error) {
      fail(`login unreadable: ${error.message}`);
      return;
    }
    state.has_login = Boolean(login);
    const list = channels();
    if (!login || !list.length) return;
    try {
      client = await connect(login, { log });
      byChannelId.clear();
      for (const channel of list) {
        const { channelId, username } = await client.resolve(channel.username);
        byChannelId.set(channelId, { ...channel, username });
      }
      client.watch({
        chats: [...byChannelId.values()].map((c) => c.username),
        onMessage: guarded((message) => hold(toReport(message), message)),
        onEdit: guarded((message) => hold(toReport(message), message)),
        onDelete: guarded(({ channelId, ids }) => {
          if (!running || !byChannelId.has(channelId)) return;
          for (const messageId of ids)
            buffer.push({
              native_id: `tg:${channelId}:${messageId}`,
              provider: 'telegram',
              kind: 'delete',
              revision: 'delete',
              priority: 1,
              received_at: now(),
              published_at: now(),
            });
          flushTimer ??= setTimer(flush, FLUSH_MS);
        }),
      });
      // What arrived while disconnected, without walking a channel's history.
      for (const [channelId, channel] of byChannelId) {
        const after = lastIds[channelId];
        if (!after) continue;
        const missed = await client.history(
          channel.username,
          after,
          GAP_FILL_LIMIT,
        );
        for (const message of missed) hold(toReport(message), message);
        if (missed.length >= GAP_FILL_LIMIT) intake.count(id, 'gap_truncated');
      }
      state.connected = true;
      state.connected_at = now();
      state.attempt = 0;
      state.last_error = null;
      state.auth_expired = false;
    } catch (error) {
      state.connected = false;
      await client?.disconnect().catch(() => {});
      client = null;
      if (error.code === 'ERR_MODULE_NOT_FOUND') {
        state.library_missing = true;
        fail('the teleproto package is not installed');
        return;
      }
      if (error.code === 'auth_expired') {
        // Trying again cannot help; only a new login can.
        state.auth_expired = true;
        fail('login expired; sign in again');
        return;
      }
      fail(error.message);
      log(`[fast-feeds] telegram: ${state.last_error}`);
      schedule();
    }
  }

  return {
    id,
    kind: 'push',
    provider: 'telegram',
    async start() {
      if (running || state.disabled) return;
      running = true;
      try {
        lastIds = JSON.parse(intake.cursor(id) ?? '{}') ?? {};
      } catch {
        lastIds = {};
      }
      await open();
    },
    async stop() {
      running = false;
      clearTimer(retryTimer);
      flush();
      await client?.disconnect();
      client = null;
      state.connected = false;
    },
    async restart() {
      await this.stop();
      await this.start();
    },
    setEnabled(value) {
      state.disabled = !value;
      return value ? this.start() : this.stop();
    },
    health(at = now()) {
      const followed = channels().length;
      const status = state.disabled
        ? 'disabled'
        : state.library_missing
          ? 'offline'
          : !state.has_login || state.auth_expired
            ? 'requires_credentials'
            : !followed
              ? 'needs_sources'
              : state.connected
                ? 'healthy'
                : state.attempt >= 3
                  ? 'offline'
                  : 'degraded';
      return {
        id,
        provider: 'telegram',
        kind: 'push',
        status,
        followed,
        ...state,
        connected_for_ms: state.connected ? at - state.connected_at : null,
      };
    },
  };
}
