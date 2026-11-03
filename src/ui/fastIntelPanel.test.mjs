// The FAST INTELLIGENCE owner: what it asks the server, what it publishes, and
// that it keeps the view's filters. The view has its own test.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia } from 'pinia';
import { createFastIntelPanel } from './fastIntelPanel.js';
import { useFastIntelStore } from './stores/fastIntel.js';

const memoryStorage = () => {
  const held = new Map();
  return {
    getItem: (key) => held.get(key) ?? null,
    setItem: (key, value) => held.set(key, value),
    removeItem: (key) => held.delete(key),
  };
};

const documentWith = (panel = {}) => ({
  getElementById: () => panel,
  defaultView: { dispatchEvent() {} },
});

const located = {
  event_id: 'a',
  title: 'Reported strike',
  location: { lat: 1, lon: 2 },
};
const unplaced = { event_id: 'b', title: 'No place', location: { lat: null } };

function setup({ client = {}, documentRef = documentWith() } = {}) {
  const store = useFastIntelStore(createPinia());
  const selected = [];
  const views = [];
  const panel = createFastIntelPanel({
    documentRef,
    store,
    storage: memoryStorage(),
    now: () => 1000,
    onSelect: (id) => selected.push(id),
    onViewChange: (view) => views.push(view),
    client: {
      fastStatus: async () => ({ enabled: true, sources: [] }),
      fastSettings: async () => ({ bluesky: { accounts: [] } }),
      fastTimeline: async () => ({ evidence: [] }),
      ...client,
    },
  });
  return { panel, store, selected, views };
}

test('nothing is presented while the server has it off, or the page has no panel', async () => {
  const off = setup({
    client: { fastStatus: async () => ({ enabled: false }) },
  });
  assert.equal(await off.panel.start(), false);
  assert.equal(off.store.state, null);
  const down = setup({
    client: {
      fastStatus: async () => {
        throw new Error('offline');
      },
    },
  });
  assert.equal(await down.panel.start(), false);
  const noView = setup({
    documentRef: { getElementById: () => null, defaultView: null },
  });
  assert.equal(await noView.panel.start(), false);
  for (const { panel } of [off, down, noView]) panel.destroy();
});

test('start presents the panel; destroy takes it away and stops answering', async () => {
  const { panel, store } = setup();
  assert.equal(await panel.start(), true);
  assert.equal(store.state.status.enabled, true);
  panel.update([located]);
  assert.deepEqual(store.state.events, [located]);
  panel.destroy();
  assert.equal(store.state, null);
  assert.equal(store.act('setView', { enabled: false }), undefined);
});

test('a filter is kept, reaches the map and is published', async () => {
  const { panel, store, views } = setup();
  await panel.start();
  store.act('setView', { windowMin: 30 });
  assert.equal(views.at(-1).windowMin, 30);
  assert.equal(panel.view().windowMin, 30);
  assert.equal(store.state.view.windowMin, 30);
  panel.destroy();
});

test('opening an event flies there only if it has a place, and loads its timeline', async () => {
  const { panel, store, selected } = setup({
    client: { fastTimeline: async (id) => ({ id, evidence: [] }) },
  });
  await panel.start();
  panel.update([located, unplaced]);
  const opening = store.act('toggleEvent', 'a');
  assert.deepEqual(store.state.openEvent, { id: 'a', timeline: null });
  await opening;
  assert.equal(store.state.openEvent.timeline.id, 'a');
  assert.deepEqual(selected, ['a']);
  await store.act('toggleEvent', 'b');
  assert.deepEqual(selected, ['a'], 'no flight to an event with no place');
  await store.act('toggleEvent', 'b');
  assert.equal(store.state.openEvent, null);
  panel.destroy();
});

test('a timeline that cannot load says so, and a late one cannot reopen a row', async () => {
  let finish;
  const { panel, store } = setup({
    client: {
      fastTimeline: () =>
        new Promise((resolve, reject) => {
          finish = { resolve, reject };
        }),
    },
  });
  await panel.start();
  panel.update([located, unplaced]);
  const first = store.act('toggleEvent', 'a');
  finish.reject(new Error('gone'));
  await first;
  assert.equal(store.state.openEvent.timeline, false);
  await store.act('toggleEvent', 'a');
  const second = store.act('toggleEvent', 'b');
  await store.act('toggleEvent', 'b');
  finish.resolve({ evidence: [] });
  await second;
  assert.equal(store.state.openEvent, null);
  panel.destroy();
});

test('sources: follow, change trust, remove; a refusal is said in words', async () => {
  const saved = [];
  let refuse = null;
  const { panel, store } = setup({
    client: {
      resolveFastAccount: async (handle) => ({ did: 'did:x', handle }),
      updateFastSettings: async (change) => {
        if (refuse) throw refuse;
        saved.push(change);
        return change;
      },
    },
  });
  await panel.start();
  assert.equal(await store.act('followAccount', 'bno.example'), true);
  assert.deepEqual(store.state.settings.bluesky.accounts, [
    { did: 'did:x', label: 'bno.example', tag: 'community' },
  ]);
  await store.act('setAccountTag', 'did:x', 'reporter');
  assert.equal(store.state.settings.bluesky.accounts[0].tag, 'reporter');
  refuse = Object.assign(new Error('no'), { status: 403 });
  assert.equal(await store.act('removeAccount', 'did:x'), false);
  assert.match(store.state.notice, /this computer only/);
  assert.equal(store.state.settings.bluesky.accounts.length, 1);
  refuse = null;
  await store.act('removeAccount', 'did:x');
  assert.equal(store.state.notice, '');
  assert.deepEqual(store.state.settings.bluesky.accounts, []);
  panel.destroy();
});

test('an unknown account is reported', async () => {
  const { panel, store } = setup({
    client: {
      resolveFastAccount: async () => {
        throw new Error('not found');
      },
    },
  });
  await panel.start();
  assert.equal(await store.act('followAccount', 'nobody'), false);
  assert.match(store.state.notice, /No such account/);
  panel.destroy();
});
