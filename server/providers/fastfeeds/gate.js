// The fast gate: a cheap, deterministic look at one report's text, independent
// of any model, that decides whether it is worth correlating. Source text is
// untrusted data here as everywhere: it is matched against, never interpreted.

import {
  DISPUTE_TERMS,
  NOT_AN_EVENT,
  RESOLVED_TERMS,
  RETRACTION_TERMS,
  RULES,
} from './rules.js';

const WORD = '[\\p{L}\\p{N}]';
const MAX_TEXT = 4000;
const TRACKING_PARAMS =
  /^(utm_\w+|fbclid|gclid|mc_cid|mc_eid|igshid|si|ref|ref_src|ref_url|s|t|cmpid|ocid)$/i;

const escapeTerm = (term) =>
  term
    .replace(/[.*+?^${}()|[\]\\]/g, (ch) => (ch === '*' ? '*' : `\\${ch}`))
    // `\?` from a literal question mark in a pack stays literal; `u?` in our
    // own lists means an optional letter.
    .replace(/\\\?/g, '?')
    .replace(/\s+/g, '\\s+')
    .replace(/\*/g, '\\p{L}*');

/** One alternation of terms, on word boundaries in any script. */
export function compileTerms(terms) {
  if (!terms.length) return null;
  return new RegExp(
    `(?<!${WORD})(?:${terms.map(escapeTerm).join('|')})(?!${WORD})`,
    'iu',
  );
}

/** Rules compiled once; operator packs come after the built-in ones. */
export function compileRules(packs = []) {
  const usable = packs.filter(
    (pack) =>
      typeof pack?.category === 'string' &&
      Array.isArray(pack.terms) &&
      pack.terms.length,
  );
  return [...RULES, ...usable].map((rule) => ({
    ...rule,
    severity: Math.min(100, Math.max(0, Number(rule.severity) || 40)),
    pattern: compileTerms(rule.terms.map(String).slice(0, 200)),
  }));
}

const NOT_AN_EVENT_PATTERN = compileTerms(NOT_AN_EVENT);
const DISPUTE_PATTERN = compileTerms(DISPUTE_TERMS);
const RETRACTION_PATTERN = compileTerms(RETRACTION_TERMS);
const RESOLVED_PATTERN = compileTerms(RESOLVED_TERMS);
const DEFAULT_RULES = compileRules();

/** The language a post states, else a guess from its script. */
export function languageOf(text, stated) {
  const language = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/.test(stated ?? '')
    ? stated
    : null;
  if (language) return language;
  if (/[іїєґІЇЄҐ]/.test(text)) return 'uk';
  if (/\p{Script=Cyrillic}/u.test(text)) return 'ru';
  if (/\p{Script=Latin}/u.test(text)) return 'en';
  return 'und';
}

/**
 * @param {string} rawText Report text.
 * @param {{language?: string, rules?: object[]}} [options]
 * @returns {{pass: boolean, reason?: string, category?: string,
 *   subtype?: string, severity?: number, status_hint?: ?string,
 *   language: string, matched?: string}}
 */
export function gateReport(rawText, { language, rules = DEFAULT_RULES } = {}) {
  const text = String(rawText ?? '').slice(0, MAX_TEXT);
  const lang = languageOf(text, language);
  if (text.trim().length < 12)
    return { pass: false, reason: 'too_short', language: lang };
  if (NOT_AN_EVENT_PATTERN.test(text))
    return { pass: false, reason: 'not_an_event', language: lang };
  let best = null;
  for (const rule of rules) {
    const found = rule.pattern?.exec(text);
    if (found && (!best || rule.severity > best.rule.severity))
      best = { rule, matched: found[0] };
  }
  if (!best) return { pass: false, reason: 'no_topic', language: lang };
  return {
    pass: true,
    category: best.rule.category,
    subtype: best.rule.subtype ?? null,
    severity: best.rule.severity,
    matched: best.matched,
    status_hint: RETRACTION_PATTERN.test(text)
      ? 'retracted'
      : DISPUTE_PATTERN.test(text)
        ? 'disputed'
        : RESOLVED_PATTERN.test(text)
          ? 'resolved'
          : null,
    language: lang,
  };
}

/**
 * The same article from anywhere: scheme, host case, `www.`, fragments, tracking
 * parameters and trailing slashes do not make a second origin.
 * @returns {?string}
 */
export function canonicalLink(value) {
  let url;
  try {
    url = new URL(String(value ?? '').trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password) return null;
  url.protocol = 'https:';
  url.hash = '';
  url.hostname = url.hostname.toLowerCase().replace(/^(www|m|amp)\./, '');
  for (const key of [...url.searchParams.keys()])
    if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key);
  url.searchParams.sort();
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.href.replace(/\/$/, '');
}
