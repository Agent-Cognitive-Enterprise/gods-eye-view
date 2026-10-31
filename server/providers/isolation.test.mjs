import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import {
  SHARED_SECRETS,
  aisConnectionAllowed,
  aisLeaseRefusal,
  aisPipeName,
  exitWithLauncher,
  isIsolatedInstance,
  isolatedEnvironment,
  remoteAddresses,
  startRefusal,
} from './isolation.js';

const safe = { root: 'C:/stage', port: 4178, tripwire: false, envFiles: {} };

test('an isolated environment has no shared credential, and .env cannot fill one', () => {
  const env = isolatedEnvironment(
    { AISSTREAM_API_KEY: 'real', OPENSKY_CLIENT_SECRET: 'real', PATH: 'p' },
    { port: 4178, stateDir: 'C:/stage/state' },
  );
  for (const name of SHARED_SECRETS)
    assert.equal(env[name], '', `${name} is empty, not undefined`);
  assert.equal(env.PATH, 'p');
  assert.equal(
    isolatedEnvironment(
      { GEV_TELEGRAM_ALLOWED: '1' },
      { port: 4178, stateDir: 'C:/s' },
    ).GEV_TELEGRAM_ALLOWED,
    undefined,
  );
  assert.equal(env.HOST, '127.0.0.1');
  assert.equal(env.GEV_AIRSEA_ENABLED, '0');
  assert.equal(env.GEV_LLM_DISABLED, '1');
  assert.equal(isIsolatedInstance(env), true);
});

test('a start is refused near anything live', () => {
  const liveRoots = ['c:\\users\\x\\gev-autopilot'];
  assert.equal(startRefusal(safe), null);
  assert.match(startRefusal({ ...safe, port: 4174 }), /live instance/);
  assert.match(startRefusal({ ...safe, port: 4173 }), /live instance/);
  assert.match(
    startRefusal({ ...safe, root: 'C:/Users/x/gev-autopilot', liveRoots }),
    /live checkout/,
  );
  assert.match(
    startRefusal({ ...safe, root: 'C:/Users/x/gev-autopilot/', liveRoots }),
    /live checkout/,
  );
  assert.match(
    startRefusal({
      ...safe,
      stateDir: 'C:\\Users\\x\\gev-autopilot\\.gev-cache\\stage',
      liveRoots,
    }),
    /inside a live checkout/,
  );
  assert.equal(
    startRefusal({
      ...safe,
      stateDir: 'C:/Users/x/gev-autopilot-stage',
      liveRoots,
    }),
    null,
    'a similar name is not the same folder',
  );
  assert.match(
    startRefusal({
      ...safe,
      envFiles: { '.env': '# note\nAISSTREAM_API_KEY=abc\n' },
    }),
    /holds the AIS key/,
  );
  assert.equal(
    startRefusal({
      ...safe,
      envFiles: { '.env': '# AISSTREAM_API_KEY=abc\nAISSTREAM_API_KEY=\n' },
    }),
    null,
    'a comment or a blank value is no key',
  );
  assert.match(
    startRefusal({
      ...safe,
      envFiles: {
        '.env': Buffer.from('AISSTREAM_API_KEY=abc\n', 'utf16le').toString(
          'latin1',
        ),
      },
    }),
    /holds the AIS key/,
    'saved as UTF-16',
  );
  assert.match(startRefusal({ ...safe, port: 8790 }), /live instance/);
  assert.match(startRefusal({ ...safe, tripwire: true }), /tripwire/);
});

test('the tripwire reads a process’s real connections', () => {
  const netstat = [
    '  TCP    127.0.0.1:4178     0.0.0.0:0            LISTENING       500',
    '  TCP    192.168.0.59:5001  136.243.173.177:443  ESTABLISHED     500',
    '  TCP    192.168.0.59:5002  108.179.136.19:443   ESTABLISHED     500',
    '  TCP    192.168.0.59:5003  136.243.173.177:443  ESTABLISHED     999',
    '  TCP    [::1]:5004         [2600:1f18::1]:443   ESTABLISHED     500',
    '  TCP    [::1]:5005         [::ffff:1.2.3.4]:443 ESTABLISHED     500',
  ].join('\r\n');
  assert.deepEqual(remoteAddresses(netstat, 500), [
    '136.243.173.177',
    '108.179.136.19',
    '2600:1f18::1',
    '1.2.3.4',
  ]);
  assert.deepEqual(remoteAddresses(netstat, 7), []);
});

function fakePipes() {
  const owners = new Map();
  return {
    close: (name) => owners.delete(name),
    createServer() {
      const server = new EventEmitter();
      server.unref = () => {};
      server.listen = (name, ready) => {
        if (owners.has(name))
          queueMicrotask(() =>
            server.emit(
              'error',
              Object.assign(new Error(), { code: 'EADDRINUSE' }),
            ),
          );
        else {
          owners.set(name, server);
          queueMicrotask(ready);
        }
      };
      return server;
    },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('one AIS key has one connection on this machine', async () => {
  const pipes = fakePipes();
  const common = { env: {}, log: () => {}, platform: 'win32', ...pipes };
  const first = { ...common, table: new Map() };
  const second = { ...common, table: new Map() };
  assert.equal(
    aisConnectionAllowed('abc', first),
    false,
    'taken asynchronously',
  );
  await settle();
  assert.equal(aisConnectionAllowed('abc', first), true);
  assert.equal(aisConnectionAllowed('abc', second), false);
  await settle();
  assert.equal(aisConnectionAllowed('abc', second), false, 'refused');
  assert.match(aisLeaseRefusal('abc', second), /holds this AIS key/);
  assert.equal(aisLeaseRefusal('abc', first), null);
  assert.equal(aisConnectionAllowed('other', second), false);
  await settle();
  assert.equal(
    aisConnectionAllowed('other', second),
    true,
    'another key is free',
  );
});

test('a lease comes free when its holder goes, with no file left behind', async () => {
  const pipes = fakePipes();
  let clock = 0;
  const common = {
    env: {},
    log: () => {},
    platform: 'win32',
    now: () => clock,
    ...pipes,
  };
  const first = { ...common, table: new Map() };
  const second = { ...common, table: new Map() };
  aisConnectionAllowed('abc', first);
  await settle();
  aisConnectionAllowed('abc', second);
  await settle();
  pipes.close(aisPipeName('abc'));
  clock = 60_000;
  aisConnectionAllowed('abc', second);
  await settle();
  assert.equal(aisConnectionAllowed('abc', second), true);
});

test('a lease that cannot be taken never costs the live instance its feed', async () => {
  const table = new Map();
  const options = {
    env: {},
    log: () => {},
    platform: 'win32',
    table,
    createServer() {
      const server = new EventEmitter();
      server.listen = () =>
        queueMicrotask(() =>
          server.emit('error', Object.assign(new Error(), { code: 'EACCES' })),
        );
      return server;
    },
  };
  aisConnectionAllowed('abc', options);
  await settle();
  assert.equal(aisConnectionAllowed('abc', options), true);
});

test(
  'a real named pipe is exclusive',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const name = aisPipeName(`test-${process.pid}`);
    const holder = net.createServer();
    await new Promise((resolve) => holder.listen(name, resolve));
    t.after(() => holder.close());
    const code = await new Promise((resolve) => {
      const second = net.createServer();
      second.on('error', (error) => resolve(error.code));
      second.listen(name, () => resolve('listening'));
    });
    assert.equal(code, 'EADDRINUSE');
  },
);

test('an isolated instance never gets the connection, whatever its key', () => {
  assert.equal(
    aisConnectionAllowed('abc', { env: { GEV_ISOLATED_INSTANCE: '1' } }),
    false,
  );
  assert.equal(aisConnectionAllowed(null, { env: {} }), false);
});

test('elsewhere the lease does not apply', () => {
  assert.equal(
    aisConnectionAllowed('abc', { env: {}, platform: 'linux' }),
    true,
  );
});

test('an isolated server stops with its launcher', () => {
  const child = new EventEmitter();
  child.send = () => {};
  const exits = [];
  child.exit = (code) => exits.push(code);
  exitWithLauncher(child);
  exitWithLauncher(child);
  child.emit('disconnect');
  assert.deepEqual(exits, [5], 'watched once');
  const orphan = new EventEmitter();
  exitWithLauncher(orphan);
  assert.equal(orphan.listenerCount('disconnect'), 0);
});
