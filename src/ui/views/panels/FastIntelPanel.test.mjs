// The FAST INTELLIGENCE view renders what its owner publishes and asks the owner
// for every change. An empty map must never read as a quiet world.
import '../../../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, nextTick } from 'vue';
import { createPinia } from 'pinia';
import { readFastView } from '../../../intel/fastView.js';
import { useFastIntelStore } from '../../stores/fastIntel.js';
import FastIntelPanel from './FastIntelPanel.vue';

const NOW = 1_800_000_000_000;
const emptyStorage = { getItem: () => null };
const live = { provider: 'bluesky', status: 'healthy', followed: 7 };

const event = {
  event_id: 'a',
  title: 'Reported strike <b>near</b> the port',
  fast_status: 'provisional',
  providers: ['bluesky'],
  first_seen_at: NOW - 30_000,
  last_meaningful_update_at: NOW - 30_000,
  category: 'armed_conflict',
  location: { lat: 1, lon: 2, place: 'Odesa' },
};

function mount(t, state = {}) {
  document.body.replaceChildren();
  const pinia = createPinia();
  const store = useFastIntelStore(pinia);
  const calls = [];
  const answers = {};
  store.connect(
    new Proxy(
      {},
      {
        get:
          (_, name) =>
          (...args) => {
            calls.push([name, ...args]);
            return answers[name];
          },
      },
    ),
  );
  const app = createApp(FastIntelPanel).use(pinia);
  app.mount(document.body.appendChild(document.createElement('div')));
  t.after(() => app.unmount());
  const present = (change = {}) =>
    store.publish({
      at: NOW,
      status: { enabled: true, sources: [live] },
      settings: { bluesky: { accounts: [] } },
      events: [],
      view: readFastView(emptyStorage),
      openEvent: null,
      notice: '',
      ...change,
    });
  const body = () => document.getElementById('fast-intel-body');
  const button = (text) =>
    [...body().querySelectorAll('button')].find((item) =>
      item.textContent.includes(text),
    );
  if (state !== null) present(state);
  return { store, calls, answers, present, body, button };
}

test('hidden until the owner presents it', async (t) => {
  const { present } = mount(t, null);
  await nextTick();
  const panel = document.getElementById('fast-intel-panel');
  assert.equal(panel.hidden, true);
  present();
  await nextTick();
  assert.equal(panel.hidden, false);
});

test('the count and the coverage line say when no source is live', async (t) => {
  const { body, present } = mount(t);
  await nextTick();
  const count = document.getElementById('fast-intel-count');
  assert.equal(count.textContent, '1/1 up');
  assert.match(body().textContent, /No pin does not mean nothing happened/);
  present({
    status: {
      enabled: true,
      sources: [{ provider: 'bluesky', status: 'offline' }],
    },
  });
  await nextTick();
  assert.equal(count.textContent, '0/1 up');
  assert.ok(count.classList.contains('intel-feeds-down'));
  assert.ok(body().querySelector('.fast-coverage-down'));
  assert.match(body().textContent, /NO LIVE PUSH SOURCE/);
});

test('a chip shows its state and asks the owner to change it', async (t) => {
  const { button, calls } = mount(t);
  await nextTick();
  const onMap = button('ON MAP');
  assert.equal(onMap.getAttribute('aria-pressed'), 'true');
  assert.ok(onMap.classList.contains('active'));
  onMap.click();
  assert.deepEqual(calls, [['setView', { enabled: false }]]);
  button('15 MIN').click();
  assert.deepEqual(calls[1], ['setView', { windowMin: 15 }]);
});

test('a post is text: its markup never reaches the page', async (t) => {
  const { body } = mount(t, { events: [event] });
  await nextTick();
  assert.equal(body().querySelector('.fast-row-title b'), null);
  assert.match(
    body().querySelector('.fast-row-title').textContent,
    /<b>near<\/b>/,
  );
  assert.ok(body().querySelector('.fast-row.s-provisional'));
});

test('an open event shows its timeline; a link that is not a web link is dropped', async (t) => {
  const { body, button, calls, present } = mount(t, { events: [event] });
  await nextTick();
  body().querySelector('.fast-row-button').click();
  assert.deepEqual(calls, [['toggleEvent', 'a']]);
  present({ events: [event], openEvent: { id: 'a', timeline: null } });
  await nextTick();
  assert.match(body().querySelector('.fast-timeline').textContent, /Loading/);
  present({
    events: [event],
    openEvent: {
      id: 'a',
      timeline: {
        event_time_known: false,
        location: { place: 'Odesa' },
        evidence: [
          { excerpt: 'kept', url: 'https://bsky.app/x', attribution: 'BNO' },
          { excerpt: 'unsafe', url: 'javascript:alert(1)' },
          { withdrawn: true, excerpt: 'gone', url: 'https://bsky.app/y' },
        ],
      },
    },
  });
  await nextTick();
  const timeline = body().querySelector('.fast-timeline');
  assert.match(timeline.textContent, /not stated/);
  assert.match(timeline.textContent, /approximate, unverified/);
  assert.match(timeline.textContent, /Withdrawn by its source/);
  assert.doesNotMatch(timeline.textContent, /gone/);
  const links = [...timeline.querySelectorAll('a')];
  assert.equal(links.length, 1);
  assert.equal(links[0].getAttribute('href'), 'https://bsky.app/x');
  assert.equal(links[0].getAttribute('rel'), 'noopener noreferrer');
});

test('an event with no detail says so', async (t) => {
  const { body } = mount(t, {
    events: [event],
    openEvent: { id: 'a', timeline: false },
  });
  await nextTick();
  assert.match(
    body().querySelector('.fast-timeline').textContent,
    /No detail available/,
  );
});

test('sources unfold; following clears the box only when it worked', async (t) => {
  const { answers, body, button, calls, store } = mount(t, {
    settings: {
      bluesky: {
        accounts: [{ did: 'did:x', label: 'bno', tag: 'community' }],
      },
    },
  });
  await nextTick();
  assert.equal(body().querySelector('.fast-sources'), null);
  button('SOURCES').click();
  await nextTick();
  assert.equal(store.sourcesOpen, true);
  const input = body().querySelector('.fast-input');
  input.value = 'someone.example';
  input.dispatchEvent(new Event('input'));
  answers.followAccount = false;
  body().querySelector('.fast-add').dispatchEvent(new Event('submit'));
  await nextTick();
  await nextTick();
  assert.deepEqual(calls.at(-1), ['followAccount', 'someone.example']);
  assert.equal(input.value, 'someone.example', 'what was typed is kept');
  answers.followAccount = true;
  body().querySelector('.fast-add').dispatchEvent(new Event('submit'));
  await nextTick();
  await nextTick();
  assert.equal(input.value, '');
  const select = body().querySelector('.fast-select');
  select.value = 'reporter';
  select.dispatchEvent(new Event('change'));
  assert.deepEqual(calls.at(-1), ['setAccountTag', 'did:x', 'reporter']);
  button('REMOVE').click();
  assert.deepEqual(calls.at(-1), ['removeAccount', 'did:x']);
});

test('health shows queue, delay targets and a source that is failing', async (t) => {
  const { body, button } = mount(t, {
    status: {
      enabled: true,
      queue: { pending: 2, max_pending: 100 },
      slo: [
        {
          stage: 'receive_to_event',
          target_p95_ms: 5000,
          met: false,
          measured: { p95_ms: 9000 },
        },
      ],
      sources: [
        {
          provider: 'bluesky',
          status: 'degraded',
          last_error: 'stream closed',
          counters: { received: 10, filtered: 9, dropped: 0 },
          latency: {
            receive_to_event: { p50_ms: 100, p95_ms: 200, samples: 4 },
          },
        },
      ],
    },
  });
  await nextTick();
  button('HEALTH AND DELAY').click();
  await nextTick();
  const health = body().querySelector('.fast-health');
  assert.ok(health.querySelector('.fast-warn'));
  assert.match(health.textContent, /stream closed/);
  assert.match(health.textContent, /Queue 2 of 100/);
  assert.match(health.textContent, /received to event: p50/);
  assert.ok(health.querySelector('p.fast-notice'));
});
