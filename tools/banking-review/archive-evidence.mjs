// Preserve the evidence behind today's decisions: a snapshot of each decided
// lead's page, of every event source not archived before, and again of the
// newest source of each event re-verified today, with its SHA-256, HTTP
// status and the decision and rationale, so a person can review a decision
// against what the reviewer saw (or as close as can be: the snapshot is
// taken right after the review).
// Safety: only public http(s) hosts (no loopback, private, link-local or
// local names, checked at every redirect hop, at most 3 hops); the body is
// read as a stream and cut at 3 MB; 20 s per URL.
// Usage: node archive-evidence.mjs <date>
// Writes evidence/<date>/<sha16>.html and evidence/<date>/index.json; never
// fails the run (errors are recorded per URL).
import { createHash } from 'node:crypto';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const date = process.argv[2];
const MAX_BYTES = 3 * 1024 * 1024;
const read = (f) => JSON.parse(fs.readFileSync(path.join(here, f), 'utf8'));
const sha = (b) => createHash('sha256').update(b).digest('hex');

// Blocked address ranges. IPv4 and IPv6 lists are kept apart (a BlockList
// checks IPv4 against IPv6 rules as IPv4-mapped, so one list would block all
// of IPv4). IPv6 forms that embed an IPv4 address (mapped ::ffff:0:0/96,
// compatible ::/96, NAT64 64:ff9b::/96) are judged by that IPv4 address.
const v4 = new net.BlockList();
for (const [a, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]])
  v4.addSubnet(a, p, 'ipv4');
const v6 = new net.BlockList();
for (const [a, p] of [['::1', 128], ['100::', 64], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]])
  v6.addSubnet(a, p, 'ipv6');

// The 16 bytes of an IPv6 address, or null.
function v6Bytes(ip) {
  let s = ip.toLowerCase();
  let tail = [];
  const dotted = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    tail = dotted[1].split('.').map(Number);
    s = s.slice(0, -dotted[1].length) + '0:0';
  }
  const [head, rest] = s.split('::');
  const h = head ? head.split(':').filter(Boolean) : [];
  const r = rest !== undefined && rest ? rest.split(':').filter(Boolean) : [];
  const groups = rest === undefined ? h : [...h, ...Array(8 - h.length - r.length).fill('0'), ...r];
  if (groups.length !== 8) return null;
  const bytes = groups.flatMap((g) => [parseInt(g, 16) >> 8, parseInt(g, 16) & 255]);
  if (tail.length) bytes.splice(12, 4, ...tail);
  return bytes;
}

export function privateAddress(ip) {
  const family = net.isIP(ip);
  if (family === 4) return v4.check(ip, 'ipv4');
  if (family !== 6) return true;
  const b = v6Bytes(ip);
  if (!b) return true;
  const zero = (from, to) => b.slice(from, to).every((x) => x === 0);
  const embedded = b.slice(12).join('.');
  const mapped = zero(0, 10) && b[10] === 255 && b[11] === 255;
  // IPv4-translated ::ffff:0:a.b.c.d (RFC 2765).
  const translated = zero(0, 8) && b[8] === 255 && b[9] === 255 && b[10] === 0 && b[11] === 0;
  const compatible = zero(0, 12);
  const nat64 = b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zero(4, 12);
  if (mapped || translated || compatible || nat64) return compatible && zero(12, 16) ? true : v4.check(embedded, 'ipv4');
  return v6.check(ip, 'ipv6');
}

// A DNS lookup for the request itself: every address it would connect to is
// checked at connect time, so a name cannot pass a check and then resolve
// elsewhere (rebinding).
function guardedLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: options.family }];
    if (!list.length || list.some((a) => privateAddress(a.address)))
      return callback(Object.assign(new Error('private or local address'), { code: 'EBLOCKED' }));
    if (options.all) return callback(null, list);
    return callback(null, list[0].address, list[0].family);
  });
}

function checkUrl(raw) {
  const url = new URL(raw);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('not http(s)');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.lan|.*\.home\.arpa)$/i.test(host)) throw new Error('local host name');
  if (net.isIP(host) && privateAddress(host)) throw new Error('private or local address');
  return url;
}

function get(url) {
  const mod = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(url, {
      method: 'GET',
      lookup: guardedLookup,
      agent: false,
      timeout: 20_000,
      headers: { 'User-Agent': 'Mozilla/5.0 (evidence archive)', Accept: 'text/html,*/*' },
    }, resolve);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

export async function snapshot(raw) {
  let url = checkUrl(raw);
  for (let hop = 0; ; hop++) {
    const res = await get(url);
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume();
      if (hop >= 3) throw new Error('too many redirects');
      url = checkUrl(new URL(res.headers.location, url).href);
      continue;
    }
    const chunks = [];
    let size = 0;
    let truncated = false;
    const deadline = setTimeout(() => res.destroy(new Error('body timeout')), 20_000);
    try {
      for await (const chunk of res) {
        size += chunk.length;
        if (size > MAX_BYTES) {
          chunks.push(chunk.subarray(0, chunk.length - (size - MAX_BYTES)));
          truncated = true;
          res.destroy();
          break;
        }
        chunks.push(chunk);
      }
    } catch (e) {
      return { status, finalUrl: url.href, bodyError: String(e?.code ?? e?.message ?? e).slice(0, 200) };
    } finally {
      clearTimeout(deadline);
    }
    return { status, finalUrl: url.href, body: Buffer.concat(chunks), truncated };
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await main();

async function main() {
const decided = read('reviewed-leads.json').leads ?? {};
const leadsFile = path.join(here, 'leads', `${date}.json`);
const today = fs.existsSync(leadsFile) ? JSON.parse(fs.readFileSync(leadsFile, 'utf8')) : { fresh: [] };
const dir = path.join(here, 'evidence', date);
fs.mkdirSync(dir, { recursive: true });

const archived = new Set();
const evRoot = path.join(here, 'evidence');
for (const d of fs.readdirSync(evRoot)) {
  const f = path.join(evRoot, d, 'index.json');
  if (fs.existsSync(f)) for (const e of JSON.parse(fs.readFileSync(f, 'utf8'))) if (e.ok) archived.add(e.url);
}

const items = [];
for (const lead of today.fresh ?? []) {
  const d = decided[lead.id];
  if (d) items.push({ kind: 'lead', id: lead.id, url: lead.url, title: lead.title, decision: d.decision, reason: d.reason, eventId: d.eventId ?? null, reviewedAt: d.reviewedAt });
}
for (const e of read('events.local.json').events ?? []) {
  const verifiedToday = String(e.last_verified_time ?? '').slice(0, 10) === date;
  const newest = e.sources?.at(-1)?.url;
  for (const s of e.sources ?? []) {
    if (!s?.url) continue;
    // A source never archived; and the newest source again on the day the
    // event is re-verified, so its evidence matches that verification.
    if (!archived.has(s.url) || (verifiedToday && s.url === newest))
      items.push({ kind: verifiedToday && s.url === newest ? 're-verification-source' : 'event-source', id: e.id, url: s.url, title: s.title ?? null, eventVerifiedAt: e.last_verified_time ?? null, summary: e.summary ?? null });
  }
}

const indexFile = path.join(dir, 'index.json');
const index = fs.existsSync(indexFile) ? JSON.parse(fs.readFileSync(indexFile, 'utf8')) : [];
const seen = new Set(index.map((e) => `${e.kind}|${e.id}|${e.url}`));
for (const item of items) {
  if (seen.has(`${item.kind}|${item.id}|${item.url}`)) continue;
  seen.add(`${item.kind}|${item.id}|${item.url}`);
  const entry = { ...item, savedAt: new Date().toISOString(), ok: false };
  try {
    const snap = await snapshot(item.url);
    entry.status = snap.status;
    entry.finalUrl = snap.finalUrl;
    if (snap.bodyError) entry.error = `body: ${snap.bodyError}`;
    else {
      entry.bytes = snap.body.length;
      entry.truncated = snap.truncated;
      entry.sha256 = sha(snap.body);
      entry.file = `${entry.sha256.slice(0, 16)}.html`;
      fs.writeFileSync(path.join(dir, entry.file), snap.body);
      entry.ok = snap.status >= 200 && snap.status < 300;
    }
  } catch (e) {
    entry.error = String(e?.cause?.code ?? e?.message ?? e).slice(0, 200);
  }
  index.push(entry);
  await new Promise((r) => setTimeout(r, 500));
}
fs.writeFileSync(indexFile, JSON.stringify(index, null, 2) + '\n');
console.log(JSON.stringify({ date, archived: index.filter((e) => e.ok).length, failed: index.filter((e) => !e.ok).length }));
}
