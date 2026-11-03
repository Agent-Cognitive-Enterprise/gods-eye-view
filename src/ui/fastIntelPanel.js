// FAST INTELLIGENCE panel's owner (fork feature): holds what the server said, the
// map filters and the event open in the list, and publishes them to the
// `gev-fast-intel` store. The FastIntelPanel view renders the store and asks for
// every change here, so this stays the only code that talks to the server.
// Adding or removing a source works from this computer only.

import { nextTick } from 'vue';
import { t } from '../i18n/index.js';
import { readFastView, writeFastView } from '../intel/fastView.js';
import { useFastIntelStore } from './stores/fastIntel.js';
import { applicationPinia } from './vueRuntime.js';

const STATUS_POLL_MS = 10_000;

/**
 * @param {{documentRef?: Document, client: object, storage?: Storage,
 *   onViewChange: Function, onSelect: Function, now?: () => number,
 *   store?: object}} options
 */
export function createFastIntelPanel({
  documentRef = document,
  client,
  storage = globalThis.localStorage,
  onViewChange,
  onSelect,
  now = () => Date.now(),
  store = useFastIntelStore(applicationPinia()),
}) {
  let view = readFastView(storage);
  let status = null;
  let settings = null;
  let events = [];
  let openEvent = null; // {id, timeline}
  let notice = '';
  let timer = null;
  let shown = false;
  let destroyed = false;
  const abort = new AbortController();

  function publish() {
    if (destroyed || !shown) return;
    store.publish({
      at: now(),
      status,
      settings,
      events,
      view,
      openEvent: openEvent && { ...openEvent },
      notice,
    });
  }

  function setView(change) {
    view = { ...view, ...change };
    writeFastView(storage, view);
    onViewChange(view);
    publish();
  }

  async function toggleEvent(id) {
    if (openEvent?.id === id) {
      openEvent = null;
      publish();
      return;
    }
    const event = events.find((item) => item.event_id === id);
    if (!event) return;
    openEvent = { id, timeline: null };
    if (event.location?.lat !== null && event.location?.lat !== undefined)
      onSelect(id);
    publish();
    let timeline;
    try {
      timeline = await client.fastTimeline(id, abort.signal);
    } catch {
      timeline = false;
    }
    if (openEvent?.id === id) openEvent.timeline = timeline;
    publish();
  }

  async function saveSettings(change) {
    try {
      settings = await client.updateFastSettings(change);
      notice = '';
    } catch (error) {
      notice =
        error.status === 403
          ? t('Sources can be changed on this computer only')
          : t('Could not save');
    }
    publish();
    return !notice;
  }

  const accounts = () => settings?.bluesky?.accounts ?? [];

  function setAccountTag(did, tag) {
    return saveSettings({
      bluesky: {
        accounts: accounts().map((held) =>
          held.did === did ? { ...held, tag } : held,
        ),
      },
    });
  }

  function removeAccount(did) {
    return saveSettings({
      bluesky: { accounts: accounts().filter((held) => held.did !== did) },
    });
  }

  /** @returns {Promise<boolean>} Whether the account is now followed. */
  async function followAccount(handle) {
    try {
      const found = await client.resolveFastAccount(handle);
      return await saveSettings({
        bluesky: {
          accounts: [
            ...accounts(),
            { did: found.did, label: found.handle ?? '', tag: 'community' },
          ],
        },
      });
    } catch (error) {
      notice =
        error.status === 403
          ? t('Sources can be changed on this computer only')
          : t('No such account');
      publish();
      return false;
    }
  }

  async function poll() {
    timer = null;
    if (destroyed) return;
    try {
      status = await client.fastStatus(abort.signal);
    } catch {
      status = { sources: [] };
    }
    publish();
    if (!destroyed) timer = setTimeout(poll, STATUS_POLL_MS);
  }

  const owner = store.connect({
    setView,
    toggleEvent,
    setAccountTag,
    removeAccount,
    followAccount,
  });

  return {
    /** Shows the panel if the server has Fast Intelligence on. */
    async start() {
      if (!documentRef.getElementById('fast-intel-panel')) return false;
      try {
        status = await client.fastStatus(abort.signal);
      } catch {
        return false;
      }
      if (!status?.enabled) return false;
      settings = await client.fastSettings(abort.signal).catch(() => null);
      if (destroyed) return false;
      shown = true;
      publish();
      // The left rail measures its panels on resize; this one just appeared.
      await nextTick();
      documentRef.defaultView?.dispatchEvent(new Event('resize'));
      timer = setTimeout(poll, STATUS_POLL_MS);
      return true;
    },
    view: () => view,
    /** The newest events from the server, whether or not they are shown. */
    update(next) {
      events = next;
      publish();
    },
    destroy() {
      destroyed = true;
      abort.abort();
      clearTimeout(timer);
      store.detach(owner);
      store.publish(null);
    },
  };
}
