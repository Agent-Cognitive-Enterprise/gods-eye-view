// teleproto (the maintained successor of GramJS, the library the GramJS authors
// point to) behind the small interface the Telegram adapter uses, so the adapter
// is testable without a network and the library loads only when a login exists.
// Public channels by username only. Text only: media is never requested.

const CONNECTION_RETRIES = 5;

/** A library message as the plain shape the adapter maps. */
function plain(message, username) {
  const forward = message.fwdFrom;
  const fromChannel = forward?.fromId?.channelId ?? null;
  return {
    id: message.id,
    channelId: String(message.peerId?.channelId ?? ''),
    username,
    date: message.date,
    editDate: message.editDate ?? null,
    text: message.message ?? '',
    forwardedFrom: fromChannel ? String(fromChannel) : null,
    forwardedDate: forward?.date ?? null,
  };
}

/**
 * @param {{apiId: number, apiHash: string, session: string}} login
 * @returns {Promise<object>} The adapter's client interface.
 */
export async function connectTeleproto(login, { log = () => {} } = {}) {
  const { TelegramClient } = await import('teleproto');
  const { StringSession } = await import('teleproto/sessions/index.js');
  const { NewMessage } = await import('teleproto/events/NewMessage.js');
  const { EditedMessage } = await import('teleproto/events/EditedMessage.js');
  const { DeletedMessage } = await import('teleproto/events/DeletedMessage.js');
  const client = new TelegramClient(
    new StringSession(login.session),
    Number(login.apiId),
    login.apiHash,
    { connectionRetries: CONNECTION_RETRIES, autoReconnect: true },
  );
  client.setLogLevel?.('none');
  await client.connect();
  if (!(await client.checkAuthorization()))
    throw Object.assign(new Error('login expired'), { code: 'auth_expired' });
  const channels = new Map(); // numeric id -> username
  return {
    /** Refuses anything that is not a public channel with a username. */
    async resolve(username) {
      const entity = await client.getEntity(username);
      if (!entity?.broadcast || !entity.username)
        throw new Error(`${username} is not a public channel`);
      channels.set(String(entity.id), entity.username);
      return { channelId: String(entity.id), username: entity.username };
    },
    watch({ onMessage, onEdit, onDelete, chats }) {
      const named = (event) =>
        channels.get(String(event.message?.peerId?.channelId ?? ''));
      client.addEventHandler((event) => {
        const username = named(event);
        if (username) onMessage(plain(event.message, username));
      }, new NewMessage({ chats }));
      client.addEventHandler((event) => {
        const username = named(event);
        if (username) onEdit(plain(event.message, username));
      }, new EditedMessage({ chats }));
      client.addEventHandler((event) => {
        const channelId = String(event.peer?.channelId ?? '');
        if (channels.has(channelId))
          onDelete({ channelId, ids: event.deletedIds ?? [] });
      }, new DeletedMessage({ chats }));
    },
    /** Messages after `minId`, oldest first, bounded: the gap after an outage. */
    async history(username, minId, limit) {
      const messages = await client.getMessages(username, { minId, limit });
      return [...messages].reverse().map((m) => plain(m, username));
    },
    async disconnect() {
      try {
        await client.disconnect();
        await client.destroy?.();
      } catch (error) {
        log(`[fast-feeds] telegram disconnect: ${error.message}`);
      }
    },
  };
}
