// Fork: the RESOURCES panel's switches on the Autopilot feeds and the
// air/sea warning feeds, through the registry as the panel uses them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createIntelService } from '../intel/service.js';
import { registerFeedJobs } from '../intel/index.js';
import { createWarningService } from '../airsea/warnings.js';
import { registerAirSeaJobs } from '../airsea/index.js';
import { createResourceRegistry } from './registry.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gev-switch-'));
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

function countingConnector(id, polls) {
  return {
    id,
    provider: 'test',
    url: 'https://example.invalid',
    intervalMs: 60_000,
    async poll() {
      polls.push(id);
      return { records: [], notModified: true };
    },
  };
}

test('an Autopilot feed turned off stops polling; on, it polls again at once', async (t) => {
  const polls = [];
  const dir = tmp();
  const service = createIntelService({
    storeFile: path.join(dir, 'intel.sqlite'),
    settingsFile: path.join(dir, 'settings.json'),
    connectors: [
      countingConnector('feed-a', polls),
      countingConnector('feed-b', polls),
    ],
    scenarios: {},
    log: () => {},
  });
  t.after(() => service.close());
  const registry = createResourceRegistry({ log: () => {} });
  registerFeedJobs(service, registry);
  assert.deepEqual(
    registry.list().map((j) => j.id),
    ['intel:feed-a', 'intel:feed-b'],
  );

  assert.equal(registry.setEnabled('intel:feed-a', false), 'ok');
  service.start();
  await settle();
  assert.deepEqual(
    polls,
    ['feed-b'],
    'the switched-off feed is not polled at start',
  );
  const a = registry.list().find((j) => j.id === 'intel:feed-a');
  assert.equal(a.status, 'disabled');
  assert.equal(a.off_by_you, true);
  const b = registry.list().find((j) => j.id === 'intel:feed-b');
  assert.equal(b.interval_ms, 60_000);
  assert.ok(Number.isFinite(b.last_duration_ms), 'the poll time is reported');

  assert.equal(registry.setEnabled('intel:feed-a', true), 'ok');
  await settle();
  assert.deepEqual(polls, ['feed-b', 'feed-a'], 'turned on, it polls at once');
  assert.notEqual(
    registry.list().find((j) => j.id === 'intel:feed-a').status,
    'disabled',
  );
});

test('a feed turned on while the service is stopped waits for its start', async (t) => {
  const polls = [];
  const dir = tmp();
  const service = createIntelService({
    storeFile: path.join(dir, 'intel.sqlite'),
    settingsFile: path.join(dir, 'settings.json'),
    connectors: [countingConnector('feed-a', polls)],
    scenarios: {},
    log: () => {},
  });
  t.after(() => service.close());
  assert.equal(service.setFeedEnabled('feed-a', false), true);
  assert.equal(service.setFeedEnabled('feed-a', true), true);
  await settle();
  assert.deepEqual(polls, [], 'not started: nothing polls');
  assert.equal(service.setFeedEnabled('nothing', true), false);
});

test('a warning feed turned off is not polled and says so; on, it is scheduled again', async (t) => {
  const fetched = [];
  const svc = createWarningService({
    dir: tmp(),
    log: () => {},
    fetchImpl: async (url) => {
      fetched.push(String(url));
      return new Response(
        JSON.stringify({ type: 'FeatureCollection', features: [] }),
        {
          status: 200,
          headers: { 'content-type': 'application/geo+json' },
        },
      );
    },
  });
  t.after(() => svc.stop());
  const registry = createResourceRegistry({ log: () => {} });
  const unregister = registerAirSeaJobs({
    resources: registry,
    service: null,
    warnings: svc,
    gnssRegional: () => null,
    aisHealth: () => 'unconfigured',
  });
  const ids = registry.list().map((j) => j.id);
  assert.ok(ids.includes('airsea-warnings:nws-marine'));
  assert.ok(ids.includes('airsea-gnss-regional'));
  assert.equal(
    registry.list().find((j) => j.id === 'airsea-gnss-regional').switchable,
    false,
  );

  assert.equal(registry.setEnabled('airsea-warnings:nws-marine', false), 'ok');
  await svc.pollSource('nws-marine');
  assert.equal(
    fetched.filter((u) => u.includes('weather.gov')).length,
    0,
    'not fetched while off',
  );
  const off = svc.sources().find((s) => s.id === 'nws-marine');
  assert.equal(off.status, 'off');
  assert.equal(
    registry.list().find((j) => j.id === 'airsea-warnings:nws-marine').status,
    'off',
  );

  svc.start({ firstDelayMs: 5 });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(
    fetched.filter((u) => u.includes('weather.gov')).length,
    0,
    'start skips it too',
  );

  assert.equal(registry.setEnabled('airsea-warnings:nws-marine', true), 'ok');
  await svc.pollSource('nws-marine');
  assert.ok(
    fetched.some((u) => u.includes('weather.gov')),
    'polled once on',
  );
  assert.notEqual(
    svc.sources().find((s) => s.id === 'nws-marine').status,
    'off',
  );
  assert.ok(
    Number.isFinite(
      svc.sources().find((s) => s.id === 'nws-marine').last_duration_ms,
    ),
  );
  for (const off of unregister) off();
  assert.equal(registry.list().length, 0, 'unregistered on close');
  assert.equal(
    svc.setFeedEnabled('faa-notam', false),
    false,
    'an unpolled source has no switch',
  );
});
