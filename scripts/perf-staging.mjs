#!/usr/bin/env node
/**
 * Starts an isolated staging server for performance runs (fork tooling).
 *
 *   node scripts/perf-staging.mjs --state <dir> [--port 4179]
 *
 * The state folder holds intel/intel.sqlite and airsea/ (copy them read-only from a
 * running instance first, for a realistic event queue and traffic history). The server
 * is a dev server like the operational one, bound to loopback, with:
 *   - GEV_ISOLATED_INSTANCE=1, which refuses AIS and OpenSky in code;
 *   - no .env read from the operator's instance (run it from a checkout without one);
 *   - the local model off, so it does not compete with the operational instance.
 * It then checks from outside that the process holds no AIS connection, and stops the
 * server if it does. Ctrl+C stops it.
 */
import { spawn, execFileSync } from 'node:child_process';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const state = path.resolve(option('--state', '.gev-perf-state'));
const port = Number(option('--port', '4179'));
if (fs.existsSync('.env')) {
  console.error(
    'Refusing: this checkout has a .env. Run staging from a checkout without operator keys.',
  );
  process.exit(1);
}

const env = {
  ...process.env,
  GEV_ISOLATED_INSTANCE: '1',
  HOST: '127.0.0.1',
  PORT: String(port),
  GEV_INTEL_ENABLED: '1',
  GEV_INTEL_GDELT: '1',
  GEV_AIRSEA_ENABLED: '1',
  GEV_AIRSEA_COLLECT: '0',
  GEV_FAST_FEEDS: '1',
  GEV_LLM_DISABLED: '1',
  GEV_INTEL_DB: path.join(state, 'intel', 'intel.sqlite'),
  GEV_AIRSEA_DIR: path.join(state, 'airsea'),
};
for (const key of [
  'AISSTREAM_API_KEY',
  'OPENSKY_CLIENT_ID',
  'OPENSKY_CLIENT_SECRET',
])
  delete env[key];

const server = spawn(
  process.execPath,
  [
    'node_modules/vite/bin/vite.js',
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--strictPort',
  ],
  { env, stdio: 'inherit' },
);
const stop = (code) => {
  server.kill();
  process.exit(code);
};
process.on('SIGINT', () => stop(0));

/** Remote addresses the server process holds open (Windows netstat, or ss elsewhere). */
function remoteAddresses(pid) {
  try {
    if (process.platform === 'win32') {
      const text = execFileSync('netstat', ['-ano', '-p', 'tcp'], {
        encoding: 'utf8',
      });
      return text
        .split('\n')
        .map((line) => line.trim().split(/\s+/))
        .filter((cols) => cols[4] === String(pid) && cols[3] === 'ESTABLISHED')
        .map((cols) => cols[2].replace(/:\d+$/, ''));
    }
    const text = execFileSync('ss', ['-tnp'], { encoding: 'utf8' });
    return text
      .split('\n')
      .filter((line) => line.includes(`pid=${pid},`))
      .map((line) => line.trim().split(/\s+/)[4]?.replace(/:\d+$/, ''));
  } catch {
    return [];
  }
}

const aisHosts = new Set(
  (await dns.resolve4('stream.aisstream.io').catch(() => [])).map(String),
);
for (let i = 0; i < 12; i += 1) {
  await new Promise((resolve) => setTimeout(resolve, 10_000));
  const open = remoteAddresses(server.pid).filter((ip) => aisHosts.has(ip));
  if (open.length) {
    console.error(
      `Isolation broken: an AIS connection is open (${open.join(', ')}). Stopping.`,
    );
    stop(2);
  }
}
console.log(
  `perf-staging: ${port} isolated; no AIS connection after two minutes.`,
);
