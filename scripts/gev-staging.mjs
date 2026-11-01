#!/usr/bin/env node
// Runs an isolated staging server on this machine, beside the live instance and
// out of its way. Refuses unsafe starts, loads no provider with a single shared
// connection, and watches the server's real sockets: if it ever reaches a
// forbidden host it is killed at once and a tripwire file blocks any restart
// until a person has read it. Bound to loopback only.
//
//   node scripts/gev-staging.mjs --state <folder> [--port 4178]
//        [--settings config/fast-feeds.starter.json]

import { execFile, spawn } from 'node:child_process';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  FORBIDDEN_HOSTS,
  isolatedEnvironment,
  machineTripwire,
  remoteAddresses,
  startRefusal,
} from '../server/providers/isolation.js';

const run = promisify(execFile);
const WATCH_MS = 20_000;
const RESOLVE_MS = 10 * 60_000;
const LIVE_ROOTS = [
  'C:/Users/user/gev-autopilot',
  'C:/Users/user/gods-eye-view',
];

const option = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : fallback;
};
if (!option('state')) {
  console.error('--state <folder> is required');
  process.exit(2);
}
// Real paths: a junction into a live checkout is that checkout.
const realPath = (target) => {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return path.resolve(target);
  }
};
const root = realPath(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
);
const stateDir = realPath(option('state'));
const port = Number(option('port', 4178));
const settings = option('settings', 'config/fast-feeds.starter.json');
// Machine-wide, so a new --state folder cannot step around it.
const tripwireFile = machineTripwire();

const envFiles = {};
for (const name of fs.readdirSync(root))
  if (name.startsWith('.env') && name !== '.env.example')
    envFiles[name] = fs.readFileSync(path.join(root, name), 'utf8');
const refusal = startRefusal({
  root,
  stateDir,
  port,
  tripwire: fs.existsSync(tripwireFile),
  envFiles,
  liveRoots: LIVE_ROOTS,
});
if (refusal) {
  console.error(`Refusing to start: ${refusal}.`);
  process.exit(3);
}

const forbidden = new Set();
async function resolveForbidden() {
  for (const host of FORBIDDEN_HOSTS)
    for (const lookup of [dns.resolve4, dns.resolve6])
      for (const address of await lookup(host).catch(() => []))
        forbidden.add(address.toLowerCase());
}
// No list means no tripwire, and that is not a state to run in. A later failure
// keeps the list already held.
await resolveForbidden();
if (!forbidden.size) {
  console.error(
    `Refusing to start: could not resolve ${FORBIDDEN_HOSTS.join(', ')}, so the tripwire would be disarmed.`,
  );
  process.exit(3);
}

fs.mkdirSync(stateDir, { recursive: true });
const settingsTarget = path.join(stateDir, 'fast-feeds.json');
if (!fs.existsSync(settingsTarget))
  fs.copyFileSync(path.resolve(root, settings), settingsTarget);
fs.writeFileSync(path.join(stateDir, 'launcher.pid'), String(process.pid));

const server = spawn(
  process.execPath,
  [
    path.join(root, 'node_modules/vite/bin/vite.js'),
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--strictPort',
  ],
  {
    cwd: root,
    env: isolatedEnvironment(process.env, { port, stateDir }),
    // The channel lets the server notice this launcher has gone, and stop.
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  },
);
fs.writeFileSync(path.join(stateDir, 'server.pid'), String(server.pid));
server.on('exit', (code) => {
  console.error(`Server exited with code ${code}.`);
  process.exit(code ?? 1);
});

function stop(reason) {
  console.error(`Stopping staging: ${reason}`);
  server.kill();
  process.exit(4);
}

async function watch() {
  const { stdout } = await run('netstat', ['-ano'], {
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  const hit = remoteAddresses(stdout, server.pid).find((address) =>
    forbidden.has(address.toLowerCase()),
  );
  if (!hit) return;
  fs.mkdirSync(path.dirname(tripwireFile), { recursive: true });
  fs.writeFileSync(
    tripwireFile,
    `${new Date().toISOString()} server ${server.pid} held a connection to ${hit}, ` +
      `a host in ${FORBIDDEN_HOSTS.join(', ')}. It was killed. Find out why before deleting this file.\n`,
  );
  stop(`forbidden connection to ${hit}`);
}

setInterval(() => resolveForbidden().catch(() => {}), RESOLVE_MS);
setInterval(
  () => watch().catch((error) => console.error(`watch: ${error.message}`)),
  WATCH_MS,
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => stop(signal));
console.log(`Staging on http://127.0.0.1:${port}/, state in ${stateDir}`);
