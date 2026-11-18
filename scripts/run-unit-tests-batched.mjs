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
 * only (each failure once, a passing test never), in recap order. Each is
 * `{ at, name, error, wholeFile }`: `at` the file of the recap's `test at`
 * line (where `test()` was called, which can be a helper module), `name` the
 * test's name without its duration, `error` the first line of its error for
 * reports, `wholeFile` when the failure is the file itself. Paths are made
 * relative to `root`, the tree that ran.
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
  const relative = (text) => slashes(local(text)).replace(/^\/+/, '');
  const found = [];
  for (let i = recap + 1; i < lines.length; i++) {
    const at = /^test at (.+):\d+:\d+$/.exec(lines[i]);
    if (!at) continue;
    const name = /^✖ (.+?)(?: \([\d.]+m?s\))?$/.exec(lines[i + 1] ?? '');
    if (!name) continue;
    let error = '';
    for (let j = i + 2; j < lines.length && /^\s/.test(lines[j]); j++)
      if (lines[j].trim()) {
        error = local(lines[j].trim());
        break;
      }
    const file = relative(at[1]);
    found.push({
      at: file,
      name: name[1],
      error,
      wholeFile: relative(name[1]) === file && /\.test\.mjs$/.test(file),
    });
    i += 1;
  }
  return found;
}

/**
 * The kind of an error, from its first line: what comes before the first `:`
 * or ` [` (AssertionError, TypeError, 'test timed out after …'), digits
 * dropped. Unlike the whole line it does not change with temp folders, ports
 * or timings, yet it tells an assertion from a crash or a timeout.
 */
export function errorKind(error) {
  return String(error ?? '')
    .split(/:| \[/)[0]
    .replace(/\d+/g, '#')
    .trim();
}

/**
 * What the comparison with the branch matches on: the test's name and the kind
 * of its error, marked when it must always count. The full error line varies
 * too much from run to run to decide anything; it is only reported.
 */
const keyOf = (test) =>
  `${test.wholeFile ? ALWAYS_NEW[0] : ''}${test.name} [${errorKind(test.error)}]`;

/**
 * Run the plan in batches. `run(args)` spawns one Node process with the unit
 * flags and returns { status, error, output }. Returns the totals and, per
 * failing file, the keys of its failing tests with repeats (see keyOf and
 * ALWAYS_NEW), plus each failure's first error line under `errors`.
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
  const errors = {};
  const add = (counts) => {
    for (const key of Object.keys(totals)) totals[key] += counts[key];
  };
  const record = (file, key, error = '') => {
    (failures[file] ??= []).push(key);
    (errors[file] ??= []).push(error ? `${key} — ${error}` : key);
  };
  const exitText = (result) =>
    `exited ${result.status ?? result.error ?? 'without a status'}`;
  /**
   * One finished run of `file` alone: everything it failed belongs to `file`,
   * even a test a helper module defined. Never rerun. Returns the keys, for
   * matching the batch's failures against.
   */
  const settle = (file, result) => {
    if (result.status === 0) return [];
    const named = failingTests(result.output, root);
    if (!named.length) {
      record(
        file,
        `${ALWAYS_NEW[1]}${exitText(result)} without naming a failing test`,
      );
      return [];
    }
    for (const test of named) record(file, keyOf(test), test.error);
    return named.map(keyOf);
  };
  for (let i = 0; i < ordinary.length; i += batchSize) {
    const batch = ordinary.slice(i, i + batchSize);
    const result = run(['--test', '--test-reporter=spec', ...batch]);
    add(summaryCounts(result.output));
    if (result.status === 0) continue;
    const label = `batch ${i / batchSize + 1} (${batch[0]} … ${batch.at(-1)})`;
    const together = failingTests(result.output, root);
    const solo = {};
    for (const file of batch)
      solo[file] = settle(file, run(['--test', '--test-reporter=spec', file]));
    // What failed together but not alone is still a failure, never dropped.
    // Matched by name: against the file it names when that file ran in this
    // batch, otherwise (a helper module's test) against the whole batch.
    let unmatched = 0;
    for (const test of together) {
      const owner = batch.includes(test.at) ? test.at : null;
      const key = keyOf(test);
      // Each solo failure answers for one batch failure at most.
      const keys = (owner ? [solo[owner]] : Object.values(solo)).find((list) =>
        list.includes(key),
      );
      if (keys) keys.splice(keys.indexOf(key), 1);
      else {
        unmatched++;
        record(owner ?? label, `${ALWAYS_NEW[2]}${key}`, test.error);
      }
    }
    // A batch that was killed, crashed, or listed nothing it failed has not
    // explained its exit, whatever its files did alone: always a failure.
    const unexplained =
      result.status === null || result.error || !together.length;
    if (unexplained)
      record(
        label,
        `${ALWAYS_NEW[1]}the batch ${exitText(result)} without a recap of what failed`,
      );
    else if (!unmatched && !batch.some((file) => failures[file]?.length))
      record(
        label,
        `${ALWAYS_NEW[1]}the batch ${exitText(result)}; every file passed alone`,
      );
  }
  // As in run-unit-tests.mjs: the probes run only where their budgets are
  // calibrated. Each runs once: a budget miss is not retried away.
  if (!calibrated && probes.length) {
    const why = `allocation microbenchmarks need Node 24 or 26; running ${process.versions.node}`;
    if (process.env.GEV_REQUIRE_ALLOCATION_GATE === '1')
      for (const file of probes) record(file, `${ALWAYS_NEW[1]}${why}`);
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
  return { files: files.length, ...totals, failures, errors };
}

/**
 * A run that hangs is stopped here, as a failure, rather than by whatever
 * stops the whole check (the daily task's one-hour limit), which would leave
 * its worktrees behind.
 */
export const RUN_TIMEOUT_MS = 8 * 60_000;

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
