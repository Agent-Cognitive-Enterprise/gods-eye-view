// Rules for the merge conflicts the daily upstream sync meets again and again
// (fork tooling, used by scripts/upstream-check.mjs).
//
// Both sides keep adding to the same few lists: translations at the end of each
// locale catalog, icon names on index.html's one Material Symbols line, module
// paths in scripts/package-boundaries.json. Git sees two additions in the same
// place and stops, though nothing needs deciding. Each rule here merges one of
// those files three ways (merge base, ours, upstream) and returns the text, or
// refuses with a reason, and the conflict is then left for a person as before.
//
// Every rule refuses rather than guess: when an input is not laid out exactly
// as the rule would write it (so the result could not keep its form), when a
// value both sides changed cannot be settled by the rule, or when anything
// else in the file conflicts. Uses only Node built-ins and git: no upstream code
// runs here.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const MISSING = Symbol('missing');
const same = (a, b) => isDeepStrictEqual(a, b);
const refuse = (why) => ({ refused: why });

/**
 * Parse JSON, refused unless `format` writes the value back as exactly the
 * same text (so the merged file keeps the form, and no duplicate key, which
 * JSON.parse silently drops, goes missing).
 */
function parseExact(text, format, label) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { why: `the ${label} side is not valid JSON (${error.message})` };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return { why: `the ${label} side is not a JSON object` };
  if (format(value) !== text)
    return { why: `the ${label} side is not laid out as this rule writes it` };
  return { value };
}

function parseAll(sides, format) {
  const out = {};
  for (const label of ['base', 'ours', 'upstream']) {
    const parsed = parseExact(sides[label], format, label);
    if (parsed.why) return { why: parsed.why };
    out[label] = parsed.value;
  }
  return { values: out };
}

const formatLocale = (value) => `${JSON.stringify(value, null, 2)}\n`;

/**
 * A locale catalog, key by key: what only one side changed (added, edited or
 * removed) is taken from that side. When both changed a key differently,
 * upstream's value is kept and the key is listed in `notes`, for a person to
 * check that upstream's wording also fits where the fork uses it. Upstream's
 * key order, then the keys only ours has, as earlier merges left them.
 */
export function mergeLocale(sides) {
  const parsed = parseAll(sides, formatLocale);
  if (parsed.why) return refuse(parsed.why);
  const { base, ours, upstream } = parsed.values;
  const out = {};
  const notes = [];
  const get = (object, key) =>
    Object.hasOwn(object, key) ? object[key] : MISSING;
  const keys = [
    ...Object.keys(upstream),
    ...Object.keys(ours).filter((key) => !Object.hasOwn(upstream, key)),
  ];
  for (const key of keys) {
    const b = get(base, key);
    const o = get(ours, key);
    const t = get(upstream, key);
    let value;
    if (same(o, t)) value = o;
    else if (same(o, b)) value = t;
    else if (same(t, b)) value = o;
    else {
      value = t;
      const show = (v) => (v === MISSING ? '(removed)' : JSON.stringify(v));
      notes.push(
        `${JSON.stringify(key)}: both sides ${b === MISSING ? 'added' : 'changed'} it; kept upstream's ${show(t)} over ours ${show(o)}`,
      );
    }
    if (value !== MISSING) out[key] = value;
  }
  return { text: formatLocale(out), notes };
}

const ICON_LIST = /(icon_names=)([a-z0-9_]+(?:,[a-z0-9_]+)*)/g;

/** The one icon_names list in `text`, or a reason it cannot be used. */
function iconList(text, label) {
  const found = [...text.matchAll(ICON_LIST)];
  if (found.length !== 1)
    return {
      why: `the ${label} side has ${found.length} icon_names lists, not one`,
    };
  const names = found[0][2].split(',');
  const sorted = [...new Set(names)].sort();
  // Google Fonts wants the list sorted; a list that is not cannot be rebuilt.
  if (!same(names, sorted))
    return {
      why: `the ${label} side's icon_names list is not sorted and unique`,
    };
  return { names };
}

/** Three-way merge of whole texts with git merge-file; null when it conflicts. */
export function mergeText(base, ours, upstream) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-merge-text-'));
  try {
    const file = (name, text) => {
      const at = path.join(dir, name);
      fs.writeFileSync(at, text);
      return at;
    };
    const result = spawnSync(
      'git',
      [
        'merge-file',
        '-p',
        file('ours', ours),
        file('base', base),
        file('upstream', upstream),
      ],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    if (result.error) throw result.error;
    return result.status === 0 ? result.stdout : null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * index.html: the Material Symbols icon_names list as a set (what either side
 * added, minus what either removed), sorted. The same list is put in all three
 * texts, and the rest of the file must then merge without conflict.
 */
export function mergeIconList(sides) {
  const lists = {};
  for (const label of ['base', 'ours', 'upstream']) {
    const found = iconList(sides[label], label);
    if (found.why) return refuse(found.why);
    lists[label] = new Set(found.names);
  }
  const { base, ours, upstream } = lists;
  const names = [...new Set([...upstream, ...ours])]
    .filter(
      (name) => !(base.has(name) && (!ours.has(name) || !upstream.has(name))),
    )
    .sort();
  const withList = (text) =>
    text.replace(ICON_LIST, (_, key) => `${key}${names.join(',')}`);
  const text = mergeText(
    withList(sides.base),
    withList(sides.ours),
    withList(sides.upstream),
  );
  if (text === null)
    return refuse('the file also conflicts outside the icon_names list');
  return { text, notes: [] };
}

/**
 * JSON as Prettier writes it here (printWidth 80, two spaces): objects always
 * open, arrays of plain values on one line when that line fits, else one item
 * per line. Only needs to be right for scripts/package-boundaries.json, and
 * mergeBoundaries refuses any input it does not reproduce exactly.
 */
export function formatPrettierJson(value) {
  const WIDTH = 80;
  const write = (item, indent, lead, tail) => {
    const pad = ' '.repeat(indent);
    if (Array.isArray(item)) {
      if (!item.length) return `${lead}[]${tail}`;
      if (item.every((x) => x === null || typeof x !== 'object')) {
        // `lead` holds the indent already; the comma after it counts.
        const line = `${lead}[${item.map((x) => JSON.stringify(x)).join(', ')}]${tail}`;
        if (line.length <= WIDTH) return line;
      }
      const inner = item.map((x, i) =>
        write(x, indent + 2, `${pad}  `, i < item.length - 1 ? ',' : ''),
      );
      return `${lead}[\n${inner.join('\n')}\n${pad}]${tail}`;
    }
    if (item && typeof item === 'object') {
      const keys = Object.keys(item);
      if (!keys.length) return `${lead}{}${tail}`;
      const inner = keys.map((key, i) =>
        write(
          item[key],
          indent + 2,
          `${pad}  ${JSON.stringify(key)}: `,
          i < keys.length - 1 ? ',' : '',
        ),
      );
      return `${lead}{\n${inner.join('\n')}\n${pad}}${tail}`;
    }
    return `${lead}${JSON.stringify(item)}${tail}`;
  };
  return `${write(value, 0, '', '')}\n`;
}

/**
 * Two lists that each side may have added to or removed from: upstream's list
 * without what ours removed, then what only ours added.
 */
function mergeList(base = [], ours = [], upstream = []) {
  const removed = new Set(base.filter((x) => !ours.includes(x)));
  return [
    ...upstream.filter((x) => !removed.has(x)),
    ...ours.filter((x) => !base.includes(x) && !upstream.includes(x)),
  ];
}

/**
 * scripts/package-boundaries.json, package by package and field by field:
 * lists merge as sets (each side's additions and removals kept), anything else
 * is taken from the one side that changed it. A field or package both sides
 * changed differently, or one side deleted while the other changed it, is
 * refused.
 */
export function mergeBoundaries(sides) {
  const parsed = parseAll(sides, formatPrettierJson);
  if (parsed.why) return refuse(parsed.why);
  const { base, ours, upstream } = parsed.values;
  const get = (object, key) =>
    object && Object.hasOwn(object, key) ? object[key] : MISSING;
  const isList = (v) =>
    Array.isArray(v) && v.every((x) => typeof x === 'string');
  const out = {};
  const names = [
    ...Object.keys(upstream),
    ...Object.keys(ours).filter((name) => !Object.hasOwn(upstream, name)),
  ];
  for (const name of names) {
    const b = get(base, name);
    const o = get(ours, name);
    const t = get(upstream, name);
    if (same(o, t)) {
      if (o !== MISSING) out[name] = o;
      continue;
    }
    if (same(o, b)) {
      if (t !== MISSING) out[name] = t;
      continue;
    }
    if (same(t, b)) {
      if (o !== MISSING) out[name] = o;
      continue;
    }
    if (o === MISSING || t === MISSING)
      return refuse(
        `package ${JSON.stringify(name)} was deleted on one side and changed on the other`,
      );
    const objects = [o, t, b === MISSING ? {} : b];
    if (objects.some((v) => !v || typeof v !== 'object' || Array.isArray(v)))
      return refuse(
        `package ${JSON.stringify(name)} is not an object on every side`,
      );
    const baseGroup = b === MISSING ? {} : b;
    const group = {};
    const fields = [
      ...Object.keys(t),
      ...Object.keys(o).filter((field) => !Object.hasOwn(t, field)),
    ];
    for (const field of fields) {
      const bf = get(baseGroup, field);
      const of = get(o, field);
      const tf = get(t, field);
      let value;
      if (same(of, tf)) value = of;
      else if (same(of, bf)) value = tf;
      else if (same(tf, bf)) value = of;
      else if (isList(of) && isList(tf) && (bf === MISSING || isList(bf)))
        value = mergeList(bf === MISSING ? [] : bf, of, tf);
      else
        return refuse(
          `${JSON.stringify(name)}.${field} was changed differently on both sides`,
        );
      if (value !== MISSING) group[field] = value;
    }
    out[name] = group;
  }
  return { text: formatPrettierJson(out), notes: [] };
}

/** Which rule, if any, a conflicted path gets. */
export const RULES = Object.freeze([
  {
    name: 'locale catalog',
    match: (file) => /^src\/i18n\/locales\/[^/]+\.json$/.test(file),
    merge: mergeLocale,
  },
  {
    name: 'icon list',
    match: (file) => file === 'index.html',
    merge: mergeIconList,
  },
  {
    name: 'package boundaries',
    match: (file) => file === 'scripts/package-boundaries.json',
    merge: mergeBoundaries,
  },
]);

export const ruleFor = (file) => RULES.find((rule) => rule.match(file)) ?? null;

/**
 * Resolve one conflicted path in a merge in progress in `cwd`, from the three
 * stages git left in the index. Returns { rule, notes } once the file is
 * written and staged, or { rule, refused } (rule null: no rule for it), and
 * then leaves the file as git left it.
 */
export function resolveConflict(cwd, file) {
  const rule = ruleFor(file);
  if (!rule) return { rule: null, refused: 'no rule for this file' };
  const stage = (n) => {
    const result = spawnSync('git', ['show', `:${n}:${file}`], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    return result.status === 0 ? result.stdout : null;
  };
  const sides = { base: stage(1), ours: stage(2), upstream: stage(3) };
  if (Object.values(sides).some((text) => text === null))
    return {
      rule: rule.name,
      refused:
        'not a conflict between three versions of the file (added or deleted on one side)',
    };
  let outcome;
  try {
    outcome = rule.merge(sides);
  } catch (error) {
    return { rule: rule.name, refused: `the rule failed: ${error.message}` };
  }
  if (outcome.refused) return { rule: rule.name, refused: outcome.refused };
  fs.writeFileSync(path.join(cwd, file), outcome.text);
  const add = spawnSync('git', ['add', '--', file], { cwd, encoding: 'utf8' });
  if (add.status !== 0)
    return { rule: rule.name, refused: `git add failed: ${add.stderr.trim()}` };
  return { rule: rule.name, notes: outcome.notes };
}
