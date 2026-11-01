// Telegram login material, kept outside the repository and encrypted for this
// Windows user with DPAPI, so a copied file is unreadable and nothing secret
// sits in `.env`, logs or the browser. Elsewhere there is no OS keystore to rely
// on here, so saving refuses rather than writing a secret in the clear.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const POWERSHELL_TIMEOUT_MS = 20_000;

/** Where the login lives; GEV_TELEGRAM_SESSION_FILE moves it. */
export function secretFile(env = process.env) {
  if (env.GEV_TELEGRAM_SESSION_FILE) return env.GEV_TELEGRAM_SESSION_FILE;
  const base = env.LOCALAPPDATA ?? path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'GodsEyeView', 'telegram-login.dpapi');
}

const script = (body) => [
  '-NoProfile',
  '-NonInteractive',
  '-Command',
  `[Console]::OutputEncoding=[Text.Encoding]::UTF8; Add-Type -AssemblyName System.Security; $in=[Console]::In.ReadToEnd(); ${body}`,
];

/** Spawned with the text on stdin, so it never appears in a command line. */
async function dpapi(body, input) {
  const child = run('powershell.exe', script(body), {
    timeout: POWERSHELL_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  child.child.stdin.end(input);
  const { stdout } = await child;
  return stdout.trim();
}

const PROTECT =
  "$b=[Text.Encoding]::UTF8.GetBytes($in); $e=[Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser'); [Console]::Out.Write([Convert]::ToBase64String($e))";
const UNPROTECT =
  "$b=[Convert]::FromBase64String($in.Trim()); $d=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'); [Console]::Out.Write([Text.Encoding]::UTF8.GetString($d))";

export const secretsSupported = () => process.platform === 'win32';

export async function saveLogin(login, file = secretFile()) {
  if (!secretsSupported())
    throw new Error('no protected store on this platform; login not saved');
  const sealed = await dpapi(PROTECT, JSON.stringify(login));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, sealed, { mode: 0o600 });
}

/** @returns {Promise<?{apiId: number, apiHash: string, session: string}>} */
export async function loadLogin(file = secretFile()) {
  let sealed;
  try {
    sealed = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  if (!secretsSupported()) return null;
  return JSON.parse(await dpapi(UNPROTECT, sealed));
}

export const hasLogin = (file = secretFile()) => fs.existsSync(file);
