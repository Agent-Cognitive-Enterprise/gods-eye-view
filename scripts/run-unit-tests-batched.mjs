#!/usr/bin/env node
// The repository's unit-test plan (scripts/run-unit-tests.mjs), run in batches
// (fork tooling).
//
// `npm test` hands every test file to one `node --test` command. On Windows
// that command line passed the 32,767-character limit at about 1,200 files, and
// the spawn fails with ENAMETOOLONG before any test runs. This runs the same
// files, with the same Node flags and the same allocation probes, BATCH_SIZE at
// a time. When a batch fails, each of its files is run alone so the report
// names the failing tests by file, and anything the batch failed that no file
// failed alone is kept too.
//
// It reuses run-unit-tests.mjs's file list, flags and probe arguments, but
// repeats its order of phases (ordinary files, then each probe alone, probes
// only on a calibrated Node unless GEV_REQUIRE_ALLOCATION_GATE=1): when
// upstream changes that order, change it here as well.
//
//   node scripts/run-unit-tests-batched.mjs [--json] [--files a.test.mjs,b.test.mjs]
//
// --files runs only those files (allocation probes among them in their own
// isolated processes). --json prints the summary as JSON on the last line.
// Exit code: 0 when every test passed and at least one ran, 1 otherwise.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ALLOCATION_TEST_FILES,
  UNIT_TEST_NODE_FLAGS,
  allocationTestArgs,
  buildUnitTestPlan,
  discoverUnitTestFiles,
  isCalibratedAllocationRuntime,
} from './run-unit-tests.mjs';

export const BATCH_SIZE = 60;

/** Totals from node:test's closing summary (`ℹ tests 12` …). */
export function summaryCounts(output) {
  const count = (name) =>
    Number(new RegExp(`^ℹ ${name} (\\d+)`, 'm').exec(output)?.[1] ?? 0);
  return { tests: count('tests'), pass: count('pass'), fail: count('fail') };
}

/**
 * Failures the branch comparison must never excuse: a whole file that failed
 * (import error, uncaught error, exit code), a run that named nothing, or a
 * failure seen only when files ran together. Their text alone says too little
 * to know it is the same failure as on the branch.
 */
export const ALWAYS_NEW = Object.freeze([
  '(whole file) ',
  '(unattributed) ',
  '(only in a batch) ',
]);

/** Forward slashes, so Windows and POSIX report the same file key. */
const slashes = (text) => String(text).replaceAll('\\', '/');

/**
 * The failing tests in spec-reporter output, from its "failing tests:" recap
 * only (each failure once, a passing test never). Each is
 * `{ file, key }`: `file` from the recap's `test at` line, `key` the test's
 * name and the first line of its error, with durations and the tree's own path
 * removed, so the same failure reads the same in another worktree. `root` is
 * that tree's path.
 */
export function failingTests(output, root = process.cwd()) {
  const lines = String(output).split(/\r?\n/);
  const recap = lines.findIndex((line) => /^✖ failing tests:/.test(line));
  if (recap < 0) return [];
  const rootForms = [...new Set([root, slashes(root)])]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  const local = (text) => {
    let out = String(text);
    for (const form of rootForms) {
      out = out.split(`file:///${slashes(form)}`).join('');
      out = out.split(form).join('');
    }
    return out;
  };
  const found = [];
  for (let i = recap + 1; i < lines.length; i++) {
    const at = /^test at (.+):\d+:\d+$/.exec(lines[i]);
    if (!at) continue;
    const name = /^✖ (.+?)(?: \([\d.]+m?s\))?$/.exec(lines[i + 1] ?? '');
    if (!name) continue;
    const file = slashes(local(at[1])).replace(/^\/+/, '');
    let error = '';
    for (let j = i + 2; j < lines.length && /^\s/.test(lines[j]); j++)
      if (lines[j].trim()) {
        error = local(lines[j].trim());
        break;
      }
    const wholeFile =
      slashes(local(name[1])).replace(/^\/+/, '') === file &&
      /\.test\.mjs$/.test(file);
    found.push({
      file,
      key: `${wholeFile ? ALWAYS_NEW[0] : ''}${name[1]} — ${error}`,
    });
    i += 1;
  }
  return found;
}

/** The keys of the failing tests, by file. */
const byFile = (tests) => {
  const out = {};
  for (const { file, key } of tests)
    (out[file] ??= []).includes(key) || out[file].push(key);
  return out;
};

/**
 * Run the plan in batches. `run(args)` spawns one Node process with the unit
 * flags and returns { status, error, output }. Returns the totals and, per
 * failing file, the keys of its failing tests (see failingTests and
 * ALWAYS_NEW).
 */
export function runBatched({
  files,
  run,
  batchSize = BATCH_SIZE,
  calibrated = isCalibratedAllocationRuntime(),
  root = process.cwd(),
}) {
  const allocation = new Set(ALLOCATION_TEST_FILES);
  const ordinary = files.filter((file) => !allocation.has(file));
  const probes = files.filter((file) => allocation.has(file));
  const totals = { tests: 0, pass: 0, fail: 0 };
  const failures = {};
  const add = (counts) => {
    for (const key of Object.keys(totals)) totals[key] += counts[key];
  };
  const record = (file, keys) => {
    const list = (failures[file] ??= []);
    for (const key of keys) if (!list.includes(key)) list.push(key);
  };
  const exitText = (result) =>
    `exited ${result.status ?? result.error ?? 'without a status'}`;
  /** One finished run of `file` (or a batch): what it failed, never rerun. */
  const settle = (file, result) => {
    if (result.status === 0) return;
    const named = failingTests(result.output, root);
    if (named.length)
      for (const [f, keys] of Object.entries(byFile(named))) record(f, keys);
    else
      record(file, [
        `${ALWAYS_NEW[1]}${exitText(result)} without naming a failing test`,
      ]);
  };
  for (let i = 0; i < ordinary.length; i += batchSize) {
    const batch = ordinary.slice(i, i + batchSize);
    const result = run(['--test', '--test-reporter=spec', ...batch]);
    add(summaryCounts(result.output));
    if (result.status === 0) continue;
    const inBatch = byFile(failingTests(result.output, root));
    const before = JSON.stringify(failures);
    for (const file of batch)
      settle(file, run(['--test', '--test-reporter=spec', file]));
    // What failed together but not alone is still a failure, never dropped.
    for (const [file, keys] of Object.entries(inBatch)) {
      const alone = failures[file] ?? [];
      const missing = keys.filter((key) => !alone.includes(key));
      if (missing.length)
        record(
          file,
          missing.map((key) => `${ALWAYS_NEW[2]}${key}`),
        );
    }
    if (JSON.stringify(failures) === before)
      record(`batch ${i / batchSize + 1} (${batch[0]} … ${batch.at(-1)})`, [
        `${ALWAYS_NEW[1]}the batch ${exitText(result)}; every file passed alone`,
      ]);
  }
  // As in run-unit-tests.mjs: the probes run only where their budgets are
  // calibrated. Each runs once: a budget miss is not retried away.
  if (!calibrated && probes.length) {
    const why = `allocation microbenchmarks need Node 24 or 26; running ${process.versions.node}`;
    if (process.env.GEV_REQUIRE_ALLOCATION_GATE === '1')
      for (const file of probes) record(file, [`${ALWAYS_NEW[1]}${why}`]);
    else console.warn(`[unit] SKIPPED ${probes.length} ${why}`);
  }
  if (calibrated)
    for (const file of probes) {
      const args = [...allocationTestArgs(file)];
      args.splice(args.indexOf('--test') + 1, 0, '--test-reporter=spec');
      const result = run(args);
      add(summaryCounts(result.output));
      settle(file, result);
    }
  return { files: files.length, ...totals, failures };
}

/**
 * A run that hangs is stopped here, as a failure, rather than by whatever
 * stops the whole check (the daily task's one-hour limit), which would leave
 * its worktrees behind.
 */
export const RUN_TIMEOUT_MS = 15 * 60_000;

/** One Node process with the unit flags, in `cwd`. */
export function nodeRunner(cwd) {
  return (args) => {
    const result = spawnSync(
      process.execPath,
      [...UNIT_TEST_NODE_FLAGS, ...args],
      {
        cwd,
        encoding: 'utf8',
        env: process.env,
        maxBuffer: 256 * 1024 * 1024,
        timeout: RUN_TIMEOUT_MS,
        killSignal: 'SIGKILL',
      },
    );
    return {
      status: result.status,
      error: result.error?.code ?? result.error?.message,
      output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    };
  };
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : '';
if (import.meta.url === invokedPath) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--files');
  const all = discoverUnitTestFiles();
  const plan = buildUnitTestPlan(all);
  const files =
    at >= 0
      ? String(args[at + 1] ?? '')
          .split(',')
          .filter(Boolean)
      : [...plan.parallel, ...plan.serializedAllocations];
  const summary = runBatched({ files, run: nodeRunner(process.cwd()) });
  const failing = Object.keys(summary.failures);
  console.log(
    `files ${summary.files}; tests ${summary.tests}, pass ${summary.pass}, fail ${summary.fail}; failing files: ${failing.length ? failing.join(', ') : 'none'}`,
  );
  if (args.includes('--json')) console.log(JSON.stringify(summary));
  process.exitCode = summary.tests > 0 && failing.length === 0 ? 0 : 1;
}
