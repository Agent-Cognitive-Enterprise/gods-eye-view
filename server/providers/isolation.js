// Keeps a second instance on this machine away from the first one's single-use
// connections. AISStream allows one connection per key and its watchdog connects
// with no browser involved, so a test server started with the real key silently
// competes with the live instance. Written instructions did not prevent that, so
// these are checks in code: an isolated instance does not load those providers,
// any instance needs a machine-wide lease to use the key, and the staging launcher
// refuses unsafe starts and kills the server if it ever sees the socket.

import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

/** Hosts a staging server must never hold a connection to. */
export const FORBIDDEN_HOSTS = Object.freeze(['stream.aisstream.io']);

/** Credentials shared with the live instance, blanked in an isolated one. */
export const SHARED_SECRETS = Object.freeze([
  'AISSTREAM_API_KEY',
  'OPENSKY_CLIENT_ID',
  'OPENSKY_CLIENT_SECRET',
  'OPENSKY_CREDENTIALS_FILE',
]);

/** Ports of the live instances and their model; a staging server may not take them. */
export const RESERVED_PORTS = Object.freeze([4173, 4174, 8790, 8791]);

const LEASE_RETRY_MS = 60_000;

/** Marked by the staging launcher; such an instance loads no shared provider. */
export const isIsolatedInstance = (env = process.env) =>
  env.GEV_ISOLATED_INSTANCE === '1';

/** The environment of an isolated instance: empty, not unset, so .env cannot fill it. */
export function isolatedEnvironment(base, { port, stateDir }) {
  const env = { ...base };
  for (const name of SHARED_SECRETS) env[name] = '';
  // Telegram is never reachable from here, whatever the shell had set.
  for (const name of Object.keys(env))
    if (name.startsWith('GEV_TELEGRAM_')) delete env[name];
  return {
    ...env,
    GEV_ISOLATED_INSTANCE: '1',
    HOST: '127.0.0.1',
    PORT: String(port),
    GEV_INTEL_ENABLED: '1',
    GEV_FAST_FEEDS: '1',
    GEV_INTEL_DB: path.join(stateDir, 'intel.sqlite'),
    GEV_AIRSEA_ENABLED: '0',
    GEV_INTEL_AIRSEA: '0',
    // The GPU is the live instance's; a day of staging load would show there.
    GEV_LLM_DISABLED: '1',
    GEV_LOCAL_VOICE: '0',
  };
}

const KEY_LINE = /^\s*(?:export\s+)?AISSTREAM_API_KEY\s*=\s*\S/m;

// Compared as text: these are Windows paths on any machine that checks them.
const folded = (value) =>
  String(value).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

const within = (child, parent) => {
  const [inner, outer] = [folded(child), folded(parent)];
  return inner === outer || inner.startsWith(`${outer}/`);
};

/**
 * Why this start must not go ahead, or null.
 * @param {{root: string, stateDir?: string, port: number, tripwire: boolean,
 *   envFiles: Record<string, string>, liveRoots?: string[]}} input
 */
export function startRefusal({
  root,
  stateDir = null,
  port,
  tripwire,
  envFiles,
  liveRoots = [],
}) {
  if (tripwire)
    return 'a forbidden connection was seen on an earlier run; a person must read and clear the tripwire file';
  if (RESERVED_PORTS.includes(port))
    return `port ${port} belongs to a live instance`;
  if (liveRoots.some((live) => within(root, live)))
    return `${root} is a live checkout`;
  if (stateDir && liveRoots.some((live) => within(stateDir, live)))
    return `${stateDir} is inside a live checkout`;
  for (const [name, text] of Object.entries(envFiles))
    // A file saved as UTF-16 still holds the key.
    if (KEY_LINE.test(String(text).replace(/\0|^[﻿�]+/g, '')))
      return `${name} holds the AIS key; staging must run from a tree without it`;
  return null;
}

/** Remote addresses of established connections owned by one process. */
export function remoteAddresses(netstatText, pid) {
  const out = [];
  for (const line of String(netstatText).split(/\r?\n/)) {
    const cells = line.trim().split(/\s+/);
    if (cells[0] !== 'TCP' || cells[3] !== 'ESTABLISHED') continue;
    if (Number(cells[4]) !== pid) continue;
    out.push(
      cells[2]
        .replace(/:\d+$/, '')
        .replace(/^\[|\]$/g, '')
        .replace(/^::ffff:/i, ''),
    );
  }
  return out;
}

/** Outlives a reload of this module: a dev server restarts in one process. */
const LEASES = Symbol.for('gev.isolation.aisLeases');
const sharedLeases = () => (globalThis[LEASES] ??= new Map());

export const aisPipeName = (fingerprint) =>
  `\\\\.\\pipe\\gev-ais-${fingerprint}`;

function takeLease(fingerprint, { table, createServer, now, log }) {
  const entry = { state: 'pending', at: now() };
  table.set(fingerprint, entry);
  const server = createServer();
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      entry.state = 'refused';
      log(
        "[ais] another process holds this key's one connection; not connecting",
      );
      return;
    }
    // Never cost the live instance its feed over a lease that could not be taken.
    entry.state = 'held';
    log(`[ais] lease unavailable (${error.code}); connecting without one`);
  });
  server.listen(aisPipeName(fingerprint), () => {
    entry.state = 'held';
  });
  server.unref?.();
  entry.server = server;
}

/**
 * Whether this process may open the AIS stream for this key. The lease is an
 * exclusive named pipe: machine-wide, and released by Windows when its owner
 * dies, so a crash, a reboot or a reused process id cannot leave it stuck. Only a
 * digest of the key is used. Taking it is asynchronous, so the first call answers
 * no and the watchdog's next tick connects. Elsewhere this check does not apply.
 */
export function aisConnectionAllowed(
  fingerprint,
  {
    env = process.env,
    log = (...args) => console.warn(...args),
    now = () => Date.now(),
    createServer = () => net.createServer(),
    platform = process.platform,
    table = sharedLeases(),
  } = {},
) {
  if (isIsolatedInstance(env) || !fingerprint) return false;
  if (platform !== 'win32') return true;
  const entry = table.get(fingerprint);
  if (
    !entry ||
    (entry.state === 'refused' && now() - entry.at >= LEASE_RETRY_MS)
  ) {
    takeLease(fingerprint, { table, createServer, now, log });
    return false;
  }
  return entry.state === 'held';
}

/** What to tell the operator when another process holds the key's connection. */
export function aisLeaseRefusal(fingerprint, { table = sharedLeases() } = {}) {
  return table.get(fingerprint)?.state === 'refused'
    ? 'Another God’s Eye View on this computer holds this AIS key’s one connection.'
    : null;
}

/** An isolated server stops with its launcher: nothing runs unsupervised. */
export function exitWithLauncher(proc = process) {
  const marker = Symbol.for('gev.isolation.exitWithLauncher');
  if (!proc.send || proc[marker]) return;
  proc[marker] = true;
  proc.on('disconnect', () => proc.exit(5));
}

/** The machine-wide tripwire: a new --state folder must not step around it. */
export const machineTripwire = (env = process.env) =>
  path.join(
    env.LOCALAPPDATA ?? path.join(os.homedir(), '.local', 'state'),
    'GodsEyeView',
    'staging-tripwire.txt',
  );
