// Fork: the RESOURCES panel's presentation and its owner (resourcesMonitor).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia } from 'pinia';
import { setLocale } from '../i18n/index.js';
import { nextTick } from 'vue';
import {
  changeSummary,
  dependentLabels,
  fixedReasonLabel,
  formatBytes,
  formatDuration,
  groupJobs,
  jobFacts,
  sparkline,
  statusTone,
  switchErrorText,
} from './resourcesPresentation.js';
import { createResourcesMonitor, enabledLayers } from './resourcesMonitor.js';
import { useResourcesStore } from './stores/resources.js';

test('sizes, durations, tones and facts read as the panel shows them', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(987_398_144), '942 MB');
  assert.equal(formatBytes(3 * 1024 ** 3), '3 GB');
  assert.equal(formatDuration(340), '340 ms');
  assert.equal(formatDuration(15 * 60_000), '15 min');
  assert.equal(statusTone('healthy'), 'ok');
  assert.equal(statusTone('stale'), 'warn');
  assert.equal(statusTone('off'), 'off');
  assert.equal(statusTone('offline'), 'bad');
  assert.equal(statusTone('requires_credentials'), 'idle');
  const now = 10 * 60_000;
  assert.equal(
    jobFacts(
      {
        interval_ms: 300_000,
        last_run_at: now - 120_000,
        last_duration_ms: 340,
        last_items: 12,
      },
      now,
    ),
    'every 5 min · ran 2 minutes ago · took 340 ms · 12 items',
  );
  assert.equal(jobFacts({}, now), '');
});

test('jobs group in order, off-by-you first; reasons and effects in words', () => {
  const groups = groupJobs([
    {
      id: 'airsea-traffic:aisstream',
      group: 'air-sea',
      label: 'aisstream',
      fixed_reason: 'single-connection',
    },
    {
      id: 'intel:usgs',
      group: 'autopilot-feeds',
      label: 'usgs',
      off_by_you: false,
    },
    {
      id: 'intel:gdelt',
      group: 'autopilot-feeds',
      label: 'gdelt',
      off_by_you: true,
      dependents: ['autopilot-events'],
    },
    { id: 'x', group: 'other', label: 'x' },
  ]);
  assert.deepEqual(
    groups.map((g) => [g.id, g.jobs.map((j) => j.label)]),
    [
      ['autopilot-feeds', ['gdelt', 'usgs']],
      ['air-sea', ['aisstream']],
      ['other', ['x']],
    ],
  );
  assert.equal(
    fixedReasonLabel(groups[1].jobs[0]),
    'The one live AIS connection: no switch',
  );
  assert.deepEqual(dependentLabels(groups[0].jobs[0]), [
    'Autopilot events from this feed',
  ]);
});

test('a change reads before and after, or that it is still measuring', () => {
  const jobs = [{ id: 'intel:gdelt', label: 'gdelt' }];
  assert.equal(
    changeSummary({ id: 'intel:gdelt', on: false, before: null }, jobs),
    'gdelt turned off',
  );
  assert.equal(
    changeSummary(
      {
        id: 'intel:gdelt',
        on: false,
        before: { cpu_core_pct: 12, rss_mb: 1200 },
        after: null,
      },
      jobs,
    ),
    'gdelt turned off · measuring…',
  );
  assert.equal(
    changeSummary(
      {
        id: 'intel:gdelt',
        on: false,
        before: { cpu_core_pct: 12, rss_mb: 1200 },
        after: { cpu_core_pct: 9, rss_mb: 1100 },
      },
      jobs,
    ),
    'gdelt turned off · CPU 12% → 9% · memory 1.2 GB → 1.1 GB',
  );
  // In a right-to-left language t() isolates each value, so a unit stays
  // with its number.
  setLocale('ar');
  try {
    const arabic = changeSummary(
      {
        id: 'intel:gdelt',
        on: false,
        before: { cpu_core_pct: 12, rss_mb: 1200 },
        after: { cpu_core_pct: 9, rss_mb: 1100 },
      },
      jobs,
    );
    assert.ok(arabic.includes('⁨1.2 GB⁩'), arabic);
    assert.ok(arabic.includes('⁨1.1 GB⁩'), arabic);
  } finally {
    setLocale('en');
  }
  assert.equal(
    changeSummary(
      {
        id: 'intel:gdelt',
        on: false,
        before: { cpu_core_pct: 12, rss_mb: 1200 },
        after: null,
        measured: false,
      },
      jobs,
    ),
    'gdelt turned off',
    'too short to measure: no figures, not "measuring"',
  );
});

test('the sparkline spans its box; too few points draw nothing', () => {
  assert.equal(sparkline([{ v: 1 }], 'v'), '');
  const line = sparkline([{ v: 0 }, { v: 5 }, { v: 10 }], 'v', 100, 20);
  assert.equal(line, '0.0,19.0 50.0,10.0 100.0,1.0');
});

function fakeManager(layers) {
  const enabled = new Set(layers.filter((l) => l.on).map((l) => l.id));
  const calls = [];
  return {
    calls,
    // As DataLayerManager: getAll() rows with the layer list's flags and
    // normalised stats (a missing count filled with 0), and the modules.
    getAll: () =>
      layers.map((l) => ({
        id: l.id,
        name: l.name,
        showInTogglePanel: l.hidden !== true,
        enabled: enabled.has(l.id),
        stats: { count: 0, ...l.stats },
      })),
    layers: new Map(
      layers.map((l) => [l.id, { module: { getStats: () => l.stats } }]),
    ),
    async setEnabled(id, on, options) {
      calls.push([id, on, options]);
      if (on) enabled.add(id);
      else enabled.delete(id);
    },
  };
}

test('the layers on, largest first; layers without counts last', () => {
  const dm = fakeManager([
    { id: 'flights', name: 'Live Flights', on: true, stats: { count: 9000 } },
    {
      id: 'cctv',
      name: 'CCTV Mesh',
      on: true,
      stats: { count: 7350, objects: 70 },
    },
    { id: 'rail', name: 'Rail', on: true, stats: null },
    { id: 'news', name: 'News', on: false, stats: { count: 48 } },
    {
      id: 'controls',
      name: 'Controls',
      on: true,
      hidden: true,
      stats: { count: 99999 },
    },
  ]);
  const list = enabledLayers(dm);
  assert.deepEqual(
    list.map((l) => [l.id, l.count]),
    [
      ['flights', 9000],
      ['cctv', 7350],
      ['rail', null],
    ],
  );
  assert.equal(list[1].objects, 70);
});

test('the monitor polls only while the panel is open and the page visible', async () => {
  const store = useResourcesStore(createPinia());
  const requests = [];
  const timers = new Set();
  const doc = {
    hidden: false,
    listeners: new Map(),
    addEventListener(n, f) {
      this.listeners.set(n, f);
    },
    removeEventListener(n) {
      this.listeners.delete(n);
    },
  };
  const dataManager = fakeManager([
    { id: 'flights', name: 'Live Flights', on: true, stats: { count: 3 } },
  ]);
  const monitor = createResourcesMonitor({
    dataManager,
    store,
    documentRef: doc,
    fetchImpl: async (url, options = {}) => {
      requests.push([url, options.method ?? 'GET', options.body ?? null]);
      if (options.method === 'POST')
        return new Response(JSON.stringify({ outcome: 'ok' }), { status: 200 });
      return new Response(
        JSON.stringify({
          jobs: [],
          can_control: true,
          server: { latest: { rss_mb: 1 } },
        }),
        { status: 200 },
      );
    },
    setTimer: (fn) => {
      const timer = { fn };
      timers.add(timer);
      return timer;
    },
    clearTimer: (timer) => timers.delete(timer),
  });
  assert.equal(requests.length, 0, 'closed: no request');
  store.setVisible(true);
  await nextTick();
  await new Promise((r) => setImmediate(r));
  assert.equal(requests.length, 1, 'open: read at once');
  assert.equal(timers.size, 1);
  assert.equal(store.server.can_control, true);
  assert.deepEqual(
    store.layers.map((l) => l.id),
    ['flights'],
  );

  doc.hidden = true;
  doc.listeners.get('visibilitychange')();
  assert.equal(timers.size, 0, 'hidden page: no polling');
  doc.hidden = false;
  doc.listeners.get('visibilitychange')();
  assert.equal(timers.size, 1);

  await store.act('setJob', 'intel:gdelt', false);
  const post = requests.find(([, method]) => method === 'POST');
  assert.deepEqual(post, [
    '/api/resources/jobs/intel%3Agdelt',
    'POST',
    '{"enabled":false}',
  ]);
  assert.equal(store.pending, null);

  const manager = dataManager;
  await store.act('layerOff', 'flights');
  assert.deepEqual(store.layers, [], 'the layer is off and the list follows');
  assert.deepEqual(
    manager.calls.at(-1),
    ['flights', false, { origin: 'user' }],
    "as the layer list's toggle: a person's choice",
  );

  store.setVisible(false);
  await nextTick();
  assert.equal(timers.size, 0, 'closed again: no polling');
  monitor.destroy();
  assert.equal(store.act('refresh'), undefined, 'destroyed: no owner answers');
});

test('a refused switch is reported, not thrown', async () => {
  const store = useResourcesStore(createPinia());
  const monitor = createResourcesMonitor({
    dataManager: fakeManager([]),
    store,
    documentRef: null,
    fetchImpl: async (url, options = {}) =>
      options.method === 'POST'
        ? new Response(JSON.stringify({ error: 'local_only' }), { status: 403 })
        : new Response(JSON.stringify({ jobs: [] }), { status: 200 }),
    setTimer: () => ({}),
    clearTimer: () => {},
  });
  await store.act('setJob', 'intel:gdelt', false);
  assert.equal(store.switchError, 'local_only', 'why it failed stays shown');
  assert.equal(
    switchErrorText('local_only'),
    'Switches work only on the computer that runs the server.',
  );
  assert.equal(switchErrorText('internal_error'), 'internal_error');
  assert.equal(store.state, 'ok', 'the read after it succeeded');
  assert.equal(store.pending, null);
  monitor.destroy();
});

test("the monitor uses the page's store when none is given", async () => {
  const { applicationPinia } = await import('./vueRuntime.js');
  const monitor = createResourcesMonitor({
    dataManager: fakeManager([]),
    documentRef: null,
    fetchImpl: async () => new Response('{}', { status: 200 }),
    setTimer: () => ({}),
    clearTimer: () => {},
  });
  assert.equal(
    typeof useResourcesStore(applicationPinia()).act,
    'function',
    'built without throwing, on the shared store',
  );
  monitor.destroy();
});

test('the panel sits in the left column and stays out of clean view and recordings', async () => {
  const fs = await import('node:fs');
  const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
  const left = read('./views/LayerPanelsView.vue');
  const right = read('./views/ContextView.vue');
  assert.ok(left.includes('<ResourcesPanel />'), 'mounted in the left column');
  assert.ok(!right.includes('ResourcesPanel'), 'off the right rail');
  assert.ok(
    left.indexOf('<FastIntelPanel />') < left.indexOf('<ResourcesPanel />') &&
      left.indexOf('<ResourcesPanel />') < left.indexOf('<LiveTvPanel />'),
    'between FAST INTELLIGENCE and LIVE TV',
  );
  const css = read('./styles/intel.css').replace(/\s+/g, ' ');
  assert.match(
    css,
    /body\.ui-clean-view #resources-panel, body\.recording-mode #resources-panel \{ opacity: 0 !important; visibility: hidden !important;/,
  );
});

test('a job that is off never wears the switched-on chip look', async () => {
  const fs = await import('node:fs');
  const vue = fs.readFileSync(
    new URL('./views/panels/ResourcesPanel.vue', import.meta.url),
    'utf8',
  );
  // `.data-toggle-chip.active` is how the app draws a toggle that is on; the
  // "Turn on" button of a job that is off once wore it, so the job read as on.
  // Whole tags, so a button split over several lines is still checked.
  const turnOn = (
    vue.match(/<UiButton\b[^>]*>[\s\S]*?<\/UiButton>/g) ?? []
  ).filter((tag) => tag.includes("t('Turn on')"));
  assert.ok(turnOn.length > 0, 'the panel has Turn on buttons');
  for (const tag of turnOn) {
    const open = tag.slice(0, tag.indexOf('>') + 1);
    assert.doesNotMatch(open, /\bactive\b/, open.replace(/\s+/g, ' '));
  }
});
