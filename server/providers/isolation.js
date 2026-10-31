// Keeps a second instance on this machine away from the first one's single-use
// connections. AISStream allows one connection per key and its watchdog connects
// with no browser involved, so a test server started with the real key silently
// competes with the live instance. Written instructions did not prevent that, so
// these are checks in code: an isolated instance does not load those providers,
// any instance must hold a machine-wide lease to use the key, and the staging
// launcher refuses unsafe starts and kills the server if it ever sees the socket.

import fs from 'node:fs';
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

/** Ports of the instances people use; a staging server may not take them. */
export const RESERVED_PORTS = Object.freeze([4173, 4174]);

/** Marked by the staging launcher; such an instance loads no shared provider. */
export const isIsolatedInstance = (env = process.env) =>
  env.GEV_ISOLATED_INSTANCE === '1';

/** The environment of an isolated instance: empty, not unset, so .env cannot fill it. */
export function isolatedEnvironment(base, { port, stateDir }) {
  const env = { ...base };
  for (const name of SHARED_SECRETS) env[name] = '';
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
    // The GPU is the live instance's; an hour of staging load would show there.
    GEV_LLM_DISABLED: '1',
    GEV_LOCAL_VOICE: '0',
  };
}

const KEY_LINE = /^\s*(?:export\s+)?AISSTREAM_API_KEY\s*=\s*\S/m;

/**
 * Why this start must not go ahead, or null.
 * @param {{root: string, port: number, tripwire: boolean,
 *   envFiles: Record<string, string>, liveRoots?: string[]}} input
 */
export function startRefusal({
  root,
  port,
  tripwire,
  envFiles,
  liveRoots = [],
}) {
  if (tripwire)
    return 'a forbidden connection was seen on an earlier run; a person must read and clear the tripwire file';
  if (RESERVED_PORTS.includes(port))
    return `port ${port} belongs to a live instance`;
  const here = path.resolve(root).toLowerCase();
  if (liveRoots.some((live) => path.resolve(live).toLowerCase() === here))
    return `${root} is a live checkout`;
  for (const [name, text] of Object.entries(envFiles))
    if (KEY_LINE.test(text))
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
    out.push(cells[2].replace(/:\d+$/, '').replace(/^\[|\]$/g, ''));
  }
  return out;
}

const leaseFile = (fingerprint, dir) =>
  path.join(dir, `aisstream-${fingerprint}.lease`);

const defaultLeaseDir = (env = process.env) =>
  path.join(
    env.LOCALAPPDATA ?? path.join(os.homedir(), '.local', 'state'),
    'GodsEyeView',
  );

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};

/**
 * Take the machine-wide lease on one AIS key. Only a digest of the key is used
 * and only a process id is stored. A lease whose process has gone is taken over.
 * @returns {{held: boolean, owner?: number, file: string}}
 */
export function takeAisLease(
  fingerprint,
  { dir = defaultLeaseDir(), pid = process.pid, isAlive = alive } = {},
) {
  const file = leaseFile(fingerprint, dir);
  fs.mkdirSync(dir, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, String(pid), { flag: 'wx' });
      return { held: true, file };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const owner = Number(fs.readFileSync(file, 'utf8'));
    if (owner === pid) return { held: true, file };
    if (Number.isInteger(owner) && owner > 0 && isAlive(owner))
      return { held: false, owner, file };
    fs.rmSync(file, { force: true });
  }
  return { held: false, file };
}

let warned = false;

/** Whether this process may open the AIS stream for this key. */
export function aisConnectionAllowed(
  fingerprint,
  { env = process.env, log = (...args) => console.warn(...args) } = {},
) {
  if (isIsolatedInstance(env) || !fingerprint) return false;
  const lease = takeAisLease(fingerprint);
  if (!lease.held && !warned) {
    warned = true;
    log(
      `[ais] another process (${lease.owner}) holds this key's one connection; not connecting. Lease: ${lease.file}`,
    );
  }
  return lease.held;
}
