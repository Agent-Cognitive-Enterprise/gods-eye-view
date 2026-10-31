import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SHARED_SECRETS,
  aisConnectionAllowed,
  isIsolatedInstance,
  isolatedEnvironment,
  remoteAddresses,
  startRefusal,
  takeAisLease,
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
  assert.equal(env.HOST, '127.0.0.1');
  assert.equal(env.GEV_AIRSEA_ENABLED, '0');
  assert.equal(env.GEV_LLM_DISABLED, '1');
  assert.equal(isIsolatedInstance(env), true);
});

test('a start is refused near anything live', () => {
  assert.equal(startRefusal(safe), null);
  assert.match(startRefusal({ ...safe, port: 4174 }), /live instance/);
  assert.match(startRefusal({ ...safe, port: 4173 }), /live instance/);
  assert.match(
    startRefusal({
      ...safe,
      root: 'C:/Users/x/gev-autopilot',
      liveRoots: ['c:\\users\\x\\gev-autopilot'],
    }),
    /live checkout/,
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
  assert.match(startRefusal({ ...safe, tripwire: true }), /tripwire/);
});

test('the tripwire reads a process’s real connections', () => {
  const netstat = [
    '  TCP    127.0.0.1:4178     0.0.0.0:0            LISTENING       500',
    '  TCP    192.168.0.59:5001  136.243.173.177:443  ESTABLISHED     500',
    '  TCP    192.168.0.59:5002  108.179.136.19:443   ESTABLISHED     500',
    '  TCP    192.168.0.59:5003  136.243.173.177:443  ESTABLISHED     999',
    '  TCP    [::1]:5004         [2600:1f18::1]:443   ESTABLISHED     500',
  ].join('\r\n');
  assert.deepEqual(remoteAddresses(netstat, 500), [
    '136.243.173.177',
    '108.179.136.19',
    '2600:1f18::1',
  ]);
  assert.deepEqual(remoteAddresses(netstat, 7), []);
});

test('one AIS key has one connection on this machine', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-lease-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const first = takeAisLease('abc', { dir, pid: 100, isAlive: () => true });
  assert.equal(first.held, true);
  assert.equal(
    takeAisLease('abc', { dir, pid: 100 }).held,
    true,
    'a restart keeps it',
  );
  const second = takeAisLease('abc', { dir, pid: 200, isAlive: () => true });
  assert.equal(second.held, false);
  assert.equal(second.owner, 100);
  assert.equal(
    takeAisLease('other', { dir, pid: 200 }).held,
    true,
    'another key is free',
  );
  assert.equal(fs.readFileSync(first.file, 'utf8'), '100', 'no key on disk');
});

test('a lease whose process has gone is taken over', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-lease-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  takeAisLease('abc', { dir, pid: 100, isAlive: () => true });
  assert.equal(
    takeAisLease('abc', { dir, pid: 200, isAlive: () => false }).held,
    true,
  );
});

test('an isolated instance never gets the connection, whatever its key', () => {
  assert.equal(
    aisConnectionAllowed('abc', { env: { GEV_ISOLATED_INSTANCE: '1' } }),
    false,
  );
  assert.equal(aisConnectionAllowed(null, { env: {} }), false);
});
