#!/usr/bin/env node
// The repository's unit-test plan (scripts/run-unit-tests.mjs), run in batches
// (fork tooling).
//
// `npm test` hands every test file to one `node --test` command. On Windows
// that command line passed the 32,767-character limit at about 1,200 files, and
// the spawn fails with ENAMETOOLONG before any test runs. This runs the same
// files, with the same Node flags and the same allocation probes, BATCH_SIZE at
// a time. When a batch fails, each of its files is run alone so the report
// names the failing tests by file.
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
 * Names of the failing tests in one file's spec-reporter output, without their
 * durations. Reads only the "failing tests:" recap, which lists each failure
 * once, so a passing test is never named.
 */
export function failingTestNames(output) {
  const lines = String(output).split(/\r?\n/);
  const recap = lines.findIndex((line) => /^✖ failing tests:/.test(line));
  const names = new Set();
  for (const line of lines.slice(recap >= 0 ? recap + 1 : lines.length)) {
    const match = /^\s*✖ (.+?)(?: \([\d.]+m?s\))?$/.exec(line);
    if (match) names.add(match[1]);
  }
  return [...names];
}

/**
 * Run the plan in batches. `run(args)` spawns one Node process with the unit
 * flags and returns { status, output }. Returns the totals and, per failing
 * file, the names of its failing tests (or a description when the file failed
 * without naming any).
 */
export function runBatched({
  files,
  run,
  batchSize = BATCH_SIZE,
  calibrated = isCalibratedAllocationRuntime(),
}) {
  const allocation = new Set(ALLOCATION_TEST_FILES);
  const ordinary = files.filter((file) => !allocation.has(file));
  const probes = files.filter((file) => allocation.has(file));
  const totals = { tests: 0, pass: 0, fail: 0 };
  const failures = {};
  const add = (counts) => {
    for (const key of Object.keys(totals)) totals[key] += counts[key];
  };
  const alone = (file, args) => {
    const one = run(args);
    if (one.status === 0) return;
    const names = failingTestNames(one.output);
    failures[file] = names.length
      ? names
      : [
          `exited ${one.status ?? one.error ?? 'without a status'} without naming a failing test`,
        ];
  };
  for (let i = 0; i < ordinary.length; i += batchSize) {
    const batch = ordinary.slice(i, i + batchSize);
    const result = run(['--test', '--test-reporter=spec', ...batch]);
    add(summaryCounts(result.output));
    if (result.status === 0) continue;
    const before = Object.keys(failures).length;
    for (const file of batch)
      alone(file, ['--test', '--test-reporter=spec', file]);
    // Failed together, passed alone: still a failure, never dropped.
    if (Object.keys(failures).length === before)
      failures[`batch ${i / batchSize + 1} (${batch[0]} … ${batch.at(-1)})`] = [
        `the batch exited ${result.status ?? result.error ?? 'without a status'}; every file passed alone`,
      ];
  }
  // As in run-unit-tests.mjs: the probes run only where their budgets are calibrated.
  if (calibrated)
    for (const file of probes) {
      const args = [...allocationTestArgs(file)];
      args.splice(args.indexOf('--test') + 1, 0, '--test-reporter=spec');
      const result = run(args);
      add(summaryCounts(result.output));
      if (result.status !== 0) alone(file, args);
    }
  return { files: files.length, ...totals, failures };
}

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
