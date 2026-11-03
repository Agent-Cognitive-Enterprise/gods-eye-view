// Operator settings for the fast feeds: which public sources to follow and how
// much to trust them. Plain, non-secret JSON next to the evidence store, never
// in the repository. Telegram credentials are not here (see secretStore.js).

import fs from 'node:fs';
import path from 'node:path';
import { isDid } from './adapters/bluesky.js';
import { compileTerms } from './terms.js';

const MAX_ACCOUNTS = 2_000;
const MAX_CHANNELS = 200;
const MAX_PACKS = 200;
const MAX_LABEL = 80;

/**
 * What a trust tag means. `community` is the default on purpose: an operator
 * has to say so before a source counts as more than a claim, and only for a
 * source they have themselves checked.
 */
export const TRUST_TAGS = Object.freeze({
  community: 'social_claim',
  reporter: 'secondary_reporting',
  official: 'primary_official',
});

export const DEFAULT_SETTINGS = Object.freeze({
  bluesky: Object.freeze({ enabled: true, accounts: Object.freeze([]) }),
  telegram: Object.freeze({ enabled: false, channels: Object.freeze([]) }),
  languagePacks: Object.freeze([]),
  rawRetentionDays: 14,
  reportsPerAccountPerMinute: 30,
  placeEnrichment: true,
});

const label = (value) =>
  typeof value === 'string'
    ? value
        .replace(/[\p{C}<>]/gu, '')
        .trim()
        .slice(0, MAX_LABEL)
    : '';
const tagOf = (value) =>
  Object.hasOwn(TRUST_TAGS, value ?? '') ? value : 'community';

function sanitizeAccounts(input) {
  const seen = new Map();
  for (const account of Array.isArray(input)
    ? input.slice(0, MAX_ACCOUNTS)
    : [])
    if (isDid(account?.did))
      seen.set(account.did, {
        did: account.did,
        label: label(account.label),
        tag: tagOf(account.tag),
      });
  return [...seen.values()];
}

const CHANNEL = /^[a-zA-Z][a-zA-Z0-9_]{3,31}$/;

function sanitizeChannels(input) {
  const seen = new Map();
  for (const channel of Array.isArray(input)
    ? input.slice(0, MAX_CHANNELS)
    : []) {
    const username = String(channel?.username ?? '').replace(/^@/, '');
    if (CHANNEL.test(username))
      seen.set(username.toLowerCase(), {
        username,
        label: label(channel.label),
        tag: tagOf(channel.tag),
      });
  }
  return [...seen.values()];
}

const compiles = (term) => {
  try {
    return Boolean(compileTerms([term]));
  } catch {
    return false;
  }
};

function sanitizePacks(input) {
  return (Array.isArray(input) ? input.slice(0, MAX_PACKS) : [])
    .filter(
      (pack) =>
        typeof pack?.category === 'string' &&
        Array.isArray(pack.terms) &&
        pack.terms.length,
    )
    .map((pack) => ({
      category: pack.category,
      subtype: /^[a-z][a-z0-9_]{0,47}$/.test(pack.subtype ?? '')
        ? pack.subtype
        : null,
      severity: Math.min(100, Math.max(0, Number(pack.severity) || 40)),
      terms: pack.terms
        .slice(0, 200)
        .map((term) => String(term).slice(0, 80))
        .filter(compiles),
    }))
    .filter((pack) => pack.terms.length);
}

const bounded = (value, lo, hi, fallback) => {
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.min(hi, Math.max(lo, Math.round(number)))
    : fallback;
};

/** Validated settings: unknown keys are ignored, anything out of range bounded. */
export function sanitizeFastSettings(input = {}, base = DEFAULT_SETTINGS) {
  const has = (key) => input && Object.hasOwn(input, key);
  return {
    bluesky: {
      enabled:
        typeof input?.bluesky?.enabled === 'boolean'
          ? input.bluesky.enabled
          : base.bluesky.enabled,
      accounts: Array.isArray(input?.bluesky?.accounts)
        ? sanitizeAccounts(input.bluesky.accounts)
        : [...base.bluesky.accounts],
    },
    telegram: {
      enabled:
        typeof input?.telegram?.enabled === 'boolean'
          ? input.telegram.enabled
          : base.telegram.enabled,
      channels: Array.isArray(input?.telegram?.channels)
        ? sanitizeChannels(input.telegram.channels)
        : [...base.telegram.channels],
    },
    languagePacks: has('languagePacks')
      ? sanitizePacks(input.languagePacks)
      : [...base.languagePacks],
    rawRetentionDays: bounded(
      input?.rawRetentionDays,
      1,
      30,
      base.rawRetentionDays,
    ),
    reportsPerAccountPerMinute: bounded(
      input?.reportsPerAccountPerMinute,
      1,
      600,
      base.reportsPerAccountPerMinute,
    ),
    placeEnrichment:
      typeof input?.placeEnrichment === 'boolean'
        ? input.placeEnrichment
        : base.placeEnrichment,
  };
}

export function readFastSettings(file, log = () => {}) {
  try {
    return sanitizeFastSettings(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (error) {
    if (error.code !== 'ENOENT')
      log(
        `[fast-feeds] settings unreadable (${error.message}); using defaults`,
      );
    return sanitizeFastSettings();
  }
}

/** Replaced whole, so a crash mid-write cannot leave half a file. */
export function writeFastSettings(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(settings, null, 2));
  fs.renameSync(temporary, file);
}
