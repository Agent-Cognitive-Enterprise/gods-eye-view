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
  remoteAddresses,
  startRefusal,
} from '../server/providers/isolation.js';

const run = promisify(execFile);
const WATCH_MS = 20_000;
const RESOLVE_MS = 10 * 60_000;
const LIVE_ROOTS = ['C:/Users/user/gev-autopilot'];

const option = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : fallback;
};
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stateDir = path.resolve(option('state', ''));
const port = Number(option('port', 4178));
const settings = option('settings', 'config/fast-feeds.starter.json');
const tripwireFile = path.join(stateDir, 'TRIPWIRE.txt');

if (!option('state')) {
  console.error('--state <folder> is required');
  process.exit(2);
}
fs.mkdirSync(stateDir, { recursive: true });

const envFiles = {};
for (const name of fs.readdirSync(root))
  if (name.startsWith('.env') && name !== '.env.example')
    envFiles[name] = fs.readFileSync(path.join(root, name), 'utf8');
const refusal = startRefusal({
  root,
  port,
  tripwire: fs.existsSync(tripwireFile),
  envFiles,
  liveRoots: LIVE_ROOTS,
});
if (refusal) {
  console.error(`Refusing to start: ${refusal}.`);
  process.exit(3);
}

const settingsTarget = path.join(stateDir, 'fast-feeds.json');
if (!fs.existsSync(settingsTarget))
  fs.copyFileSync(path.resolve(root, settings), settingsTarget);

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
    stdio: 'inherit',
  },
);
fs.writeFileSync(path.join(stateDir, 'server.pid'), String(server.pid));

let forbidden = new Set();
async function resolveForbidden() {
  for (const host of FORBIDDEN_HOSTS) {
    const addresses = await dns.resolve4(host).catch(() => []);
    for (const address of addresses) forbidden.add(address);
  }
}

function stop(reason) {
  console.error(`Stopping staging: ${reason}`);
  server.kill();
  process.exit(4);
}

async function watch() {
  const { stdout } = await run('netstat', ['-ano', '-p', 'tcp'], {
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  const hit = remoteAddresses(stdout, server.pid).find((address) =>
    forbidden.has(address),
  );
  if (!hit) return;
  fs.writeFileSync(
    tripwireFile,
    `${new Date().toISOString()} server ${server.pid} held a connection to ${hit}, ` +
      `a host in ${FORBIDDEN_HOSTS.join(', ')}. It was killed. Find out why before deleting this file.\n`,
  );
  stop(`forbidden connection to ${hit}`);
}

await resolveForbidden();
setInterval(() => resolveForbidden().catch(() => {}), RESOLVE_MS);
setInterval(
  () => watch().catch((error) => console.error(`watch: ${error.message}`)),
  WATCH_MS,
);
server.on('exit', (code) => {
  console.error(`Server exited with code ${code}.`);
  process.exit(code ?? 1);
});
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => stop(signal));
console.log(`Staging on http://127.0.0.1:${port}/, state in ${stateDir}`);
