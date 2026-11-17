// Fork: the RESOURCES panel's server side (registry, sampler, disk, routes).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createResourceRegistry } from './registry.js';
import { createSampler } from './sampler.js';
import { createDiskSizes } from './disk.js';
import { resourcesProxy } from './index.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gev-resources-'));
const quiet = () => {};

function job(id, extra = {}) {
  const calls = [];
  return {
    calls,
    job: {
      id,
      group: 'autopilot-feeds',
      label: id,
      status: () => ({ status: 'healthy' }),
      setEnabled: (on) => calls.push(on),
      dependents: ['autopilot-events'],
      ...extra,
    },
  };
}

test('a job turned off stays off across a restart and is restored on demand', () => {
  const dir = tmp();
  const file = path.join(dir, 'resources', 'off.json');
  const first = createResourceRegistry({ file, log: quiet });
  const a = job('intel:gdelt');
  first.register(a.job);
  assert.equal(first.setEnabled('intel:gdelt', false), 'ok');
  assert.deepEqual(a.calls, [false]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).off, [
    'intel:gdelt',
  ]);
  assert.equal(first.list()[0].off_by_you, true);

  // A restart: the job registers again and is turned off at once.
  const second = createResourceRegistry({ file, log: quiet });
  const b = job('intel:gdelt');
  second.register(b.job);
  assert.deepEqual(b.calls, [false], 'applied on register');
  assert.deepEqual(second.restoreDefaults(), ['intel:gdelt']);
  assert.deepEqual(b.calls, [false, true]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).off, []);
  assert.equal(second.list()[0].off_by_you, false);
});

test('switch outcomes: unknown, fixed, failed and a no-op', () => {
  const registry = createResourceRegistry({ log: quiet });
  registry.register({
    id: 'airsea-traffic:aisstream',
    group: 'air-sea',
    label: 'aisstream',
    status: () => ({}),
    fixedReason: 'single-connection',
  });
  const broken = job('intel:bad', {
    setEnabled: () => {
      throw new Error('nope');
    },
  });
  registry.register(broken.job);
  const fine = job('intel:ok');
  registry.register(fine.job);
  assert.equal(registry.setEnabled('nothing', false), 'unknown');
  assert.equal(registry.setEnabled('airsea-traffic:aisstream', false), 'fixed');
  assert.equal(registry.setEnabled('intel:bad', false), 'failed');
  assert.equal(
    registry.list().find((j) => j.id === 'intel:bad').off_by_you,
    false,
    'a failed switch is not remembered',
  );
  assert.equal(registry.setEnabled('intel:ok', true), 'ok');
  assert.deepEqual(fine.calls, [], 'already on: nothing to do');
  const ais = registry.list().find((j) => j.id === 'airsea-traffic:aisstream');
  assert.equal(ais.switchable, false);
  assert.equal(ais.fixed_reason, 'single-connection');
});

test('a status that throws is reported, not raised', () => {
  const registry = createResourceRegistry({ log: quiet });
  registry.register({
    id: 'x',
    group: 'g',
    label: 'x',
    status: () => {
      throw new Error('broken status');
    },
  });
  assert.deepEqual(registry.list()[0].status, 'unknown');
  assert.match(registry.list()[0].error, /broken status/);
});

test('bad ids are refused, and an unreadable file falls back to defaults', () => {
  const registry = createResourceRegistry({ log: quiet });
  assert.throws(
    () => registry.register({ id: '../x', status: () => ({}) }),
    /Bad resource job id/,
  );
  const dir = tmp();
  const file = path.join(dir, 'off.json');
  fs.writeFileSync(file, '{not json');
  const warnings = [];
  const fresh = createResourceRegistry({ file, log: (m) => warnings.push(m) });
  assert.deepEqual(fresh.offIds(), []);
  assert.match(warnings[0], /unreadable/);
});

test('a change carries the figures before it, and after it once a minute is in', () => {
  let t = 1_000_000;
  const measured = [];
  const registry = createResourceRegistry({
    log: quiet,
    now: () => t,
    measure: (since, until) => {
      measured.push([since, until]);
      return { cpu_core_pct: until < 1_000_001 ? 20 : 10, rss_mb: 1000 };
    },
  });
  registry.register(job('intel:a').job);
  registry.setEnabled('intel:a', false);
  assert.equal(registry.changes()[0].before.cpu_core_pct, 20);
  assert.equal(registry.changes()[0].after, null, 'not yet a minute of after');
  t += 3 * 60_000;
  const [change] = registry.changes();
  assert.equal(change.on, false);
  assert.equal(change.after.cpu_core_pct, 10);
  assert.deepEqual(measured.at(-1), [1_000_000 + 60_000, t]);
});

test("a change's after is kept once the next change closes it, or marked unmeasured", () => {
  let t = 1_000_000;
  // Only figures still in the sampler's window can be measured.
  let oldest = 0;
  const registry = createResourceRegistry({
    log: quiet,
    now: () => t,
    measure: (since, until) =>
      until < oldest
        ? null
        : { cpu_core_pct: (until - since) / 60_000, rss_mb: 1 },
  });
  registry.register(job('intel:a').job);
  registry.register(job('intel:b').job);
  registry.setEnabled('intel:a', false);
  t += 5 * 60_000;
  registry.setEnabled('intel:b', false); // closes a's window: 4 min measured
  t += 30_000;
  registry.setEnabled('intel:b', true); // b's window was too short
  t += 20 * 60_000;
  oldest = t - 10 * 60_000; // a's and b's samples have aged out
  const [bOn, bOff, aOff] = registry.changes();
  assert.equal(aOff.after.cpu_core_pct, 4, 'kept from when it closed');
  assert.equal(aOff.measured, true);
  assert.equal(bOff.after, null);
  assert.equal(bOff.measured, false, 'too short to measure, not "measuring"');
  assert.equal(bOn.measured, true);
  assert.ok(bOn.after, 'the newest is measured live');
});

test('the sampler measures CPU of one core and of the machine, and averages', () => {
  let t = 0;
  let used = 0;
  const sampler = createSampler({
    now: () => t,
    cores: 4,
    cpuUsage: () => ({ user: used, system: 0 }),
    memoryUsage: () => ({
      rss: 512 * 1024 * 1024,
      heapUsed: 100 * 1024 * 1024,
      heapTotal: 200 * 1024 * 1024,
      external: 0,
    }),
    totalmem: () => 16 * 1024 ** 3,
    freemem: () => 8 * 1024 ** 3,
    // Two cores; between the samples one is 90% busy and one 30%, whatever
    // this server's own share.
    cpuTimes: () =>
      t === 0
        ? [
            { user: 0, nice: 0, sys: 0, irq: 0, idle: 0 },
            { user: 0, nice: 0, sys: 0, irq: 0, idle: 0 },
          ]
        : [
            { user: 800, nice: 0, sys: 100, irq: 0, idle: 100 },
            { user: 300, nice: 0, sys: 0, irq: 0, idle: 700 },
          ],
    eventLoopUtilization: () => ({ utilization: 0, idle: 0, active: 0 }),
  });
  sampler.sample();
  t += 5000;
  used += 2_500_000; // 2.5 s of CPU in 5 s: half a core
  const entry = sampler.sample();
  assert.equal(entry.cpu_core_pct, 50);
  assert.equal(entry.cpu_machine_pct, 60, 'the whole machine, from the OS');
  assert.equal(entry.rss_mb, 512);
  assert.equal(entry.system_total_mb, 16384);
  assert.equal(sampler.history().length, 2);
  assert.deepEqual(sampler.average(0, t), {
    samples: 1,
    cpu_core_pct: 50,
    rss_mb: 512,
    heap_used_mb: 100,
    loop_busy_pct: 0,
  });
  assert.equal(sampler.average(t + 1), null);
});

test("the event loop's busy share comes from its utilisation since the last sample", () => {
  // As performance.eventLoopUtilization: cumulative idle/active, and the
  // share between two readings.
  let reading = { idle: 0, active: 0 };
  const elu = (current, previous) => {
    if (!current) return { ...reading };
    const idle = current.idle - previous.idle;
    const active = current.active - previous.active;
    return { utilization: active / (idle + active) };
  };
  const sampler = createSampler({
    eventLoopUtilization: elu,
    cpuTimes: () => [],
  });
  assert.equal(sampler.sample().loop_busy_pct, null, 'no interval yet');
  reading = { idle: 1000, active: 4000 }; // saturated: 80% busy
  assert.equal(sampler.sample().loop_busy_pct, 80);
  reading = { idle: 5900, active: 4100 }; // then nearly idle
  assert.equal(sampler.sample().loop_busy_pct, 2);
});

test('disk sizes: the largest entries of the cache folder', async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'airsea'));
  fs.writeFileSync(path.join(dir, 'airsea', 'a.bin'), Buffer.alloc(3000));
  fs.writeFileSync(path.join(dir, 'small.json'), '{}');
  const disk = createDiskSizes({ dir });
  assert.equal(disk.current(), null, 'measured in the background');
  await disk.settled();
  const result = disk.current();
  assert.equal(result.entries[0].name, 'airsea');
  assert.equal(result.entries[0].bytes, 3000);
  assert.equal(result.total_bytes, 3002);
});

function fakeServer() {
  const routes = new Map();
  return {
    routes,
    middlewares: { use: (prefix, fn) => routes.set(prefix, fn) },
    httpServer: { once() {} },
  };
}

async function call(
  handler,
  {
    method = 'GET',
    url = '/',
    body = null,
    address = '127.0.0.1',
    headers = {},
  },
) {
  const { Readable } = await import('node:stream');
  const req = Readable.from(
    body === null ? [] : [Buffer.from(JSON.stringify(body))],
  );
  Object.assign(req, {
    method,
    url,
    headers: { host: 'localhost:4173', ...headers },
    socket: { remoteAddress: address },
  });
  return new Promise((resolve) => {
    const res = {
      headersSent: false,
      destroyed: false,
      writeHead(status) {
        this.status = status;
        this.headersSent = true;
      },
      end(text) {
        resolve({ status: this.status, body: text ? JSON.parse(text) : null });
      },
    };
    handler(req, res);
  });
}

function monitor() {
  const registry = createResourceRegistry({ log: quiet });
  const sampler = createSampler();
  const disk = { current: () => null };
  return { registry, sampler, disk };
}

test('GET reports figures to anyone; switching is for this computer only', async (t) => {
  const m = monitor();
  t.after(() => m.sampler.stop());
  const a = job('intel:gdelt');
  m.registry.register(a.job);
  const server = fakeServer();
  resourcesProxy({ monitor: m }).configureServer(server);
  const handler = server.routes.get('/api/resources');

  const lan = await call(handler, { address: '192.168.0.20' });
  assert.equal(lan.status, 200);
  assert.equal(lan.body.can_control, false);
  assert.equal(lan.body.jobs[0].id, 'intel:gdelt');
  assert.ok(lan.body.server.latest, 'sampled on the first read');

  const refused = await call(handler, {
    method: 'POST',
    url: '/jobs/intel:gdelt',
    body: { enabled: false },
    address: '192.168.0.20',
  });
  assert.equal(refused.status, 403);
  const proxied = await call(handler, {
    method: 'POST',
    url: '/jobs/intel:gdelt',
    body: { enabled: false },
    headers: { 'x-forwarded-for': '1.2.3.4' },
  });
  assert.equal(proxied.status, 403);
  const crossSite = await call(handler, {
    method: 'POST',
    url: '/jobs/intel:gdelt',
    body: { enabled: false },
    headers: { origin: 'http://evil.example' },
  });
  assert.equal(crossSite.status, 403);
  assert.deepEqual(a.calls, [], 'nothing switched from elsewhere');

  const local = await call(handler, {
    method: 'POST',
    url: '/jobs/intel:gdelt',
    body: { enabled: false },
  });
  assert.equal(local.status, 200);
  assert.deepEqual(a.calls, [false]);
  // As the panel sends it: the id encoded.
  const encoded = await call(handler, {
    method: 'POST',
    url: `/jobs/${encodeURIComponent('intel:gdelt')}`,
    body: { enabled: false },
  });
  assert.equal(encoded.status, 200, 'the encoded id is the same job');
  assert.deepEqual(a.calls, [false], 'already off: no second call');
  const malformed = await call(handler, {
    method: 'POST',
    url: '/jobs/intel%E0%A4%A',
    body: { enabled: false },
  });
  assert.equal(malformed.status, 404);
  const rebound = await call(handler, {
    method: 'POST',
    url: '/jobs/intel:gdelt',
    body: { enabled: true },
    headers: {
      host: 'rebound.example:4173',
      origin: 'http://rebound.example:4173',
    },
  });
  assert.equal(rebound.status, 403, 'a foreign name pointed at 127.0.0.1');
  assert.equal(local.body.jobs[0].off_by_you, true);
  assert.equal((await call(handler, {})).body.can_control, true);

  const bad = await call(handler, {
    method: 'POST',
    url: '/jobs/intel:gdelt',
    body: { enabled: 'no' },
  });
  assert.equal(bad.status, 400);
  const missing = await call(handler, {
    method: 'POST',
    url: '/jobs/intel:nothing',
    body: { enabled: true },
  });
  assert.equal(missing.status, 404);
  const restored = await call(handler, {
    method: 'POST',
    url: '/restore',
    body: {},
  });
  assert.deepEqual(restored.body.restored, ['intel:gdelt']);
  assert.deepEqual(a.calls, [false, true]);
});
