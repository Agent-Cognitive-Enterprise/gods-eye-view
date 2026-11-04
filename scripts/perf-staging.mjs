#!/usr/bin/env node
/**
 * Starts an isolated staging server for performance runs (fork tooling).
 *
 *   node scripts/perf-staging.mjs --state <dir> [--port 4179]
 *
 * The state folder holds intel/intel.sqlite and airsea/ (copy them read-only from a
 * running instance first, for a realistic event queue and traffic history).
 *
 * The same guards as scripts/gev-staging.mjs, from server/providers/isolation.js:
 * refuses reserved ports, live checkouts and state folders, any .env* file that holds
 * the AIS key, and a set tripwire; runs with the isolated environment (shared
 * secrets blank, never unset; no Telegram; no local model or voice); and watches the
 * server's sockets for as long as it runs, killing it and setting the machine-wide
 * tripwire if it ever reaches a forbidden host. The only difference: air/sea is on to
 * replay the copied history, with collection off. Ctrl+C stops it.
 */
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
  'C:/Users/user/gev-fast',
];

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
if (!option('--state')) {
  console.error('--state <dir> is required');
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
const state = realPath(option('--state'));
const port = Number(option('--port', '4179'));
const tripwireFile = machineTripwire();

const envFiles = {};
for (const name of fs.readdirSync(root))
  if (name.startsWith('.env') && name !== '.env.example')
    envFiles[name] = fs.readFileSync(path.join(root, name), 'utf8');
const refusal = startRefusal({
  root,
  stateDir: state,
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
await resolveForbidden();
if (!forbidden.size) {
  console.error(
    `Refusing to start: could not resolve ${FORBIDDEN_HOSTS.join(', ')}, so the tripwire would be disarmed.`,
  );
  process.exit(3);
}

const env = {
  ...isolatedEnvironment(process.env, { port, stateDir: state }),
  GEV_INTEL_DB: path.join(state, 'intel', 'intel.sqlite'),
  // Replay the copied traffic history; never collect.
  GEV_AIRSEA_ENABLED: '1',
  GEV_AIRSEA_COLLECT: '0',
  GEV_AIRSEA_DIR: path.join(state, 'airsea'),
};

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
  { cwd: root, env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] },
);
server.on('exit', (code) => {
  console.error(`Server exited with code ${code}.`);
  process.exit(code ?? 1);
});

function stop(reason) {
  console.error(`Stopping perf staging: ${reason}`);
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
    `${new Date().toISOString()} perf server ${server.pid} held a connection to ${hit}, ` +
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
console.log(`Perf staging on http://127.0.0.1:${port}/, state in ${state}`);
