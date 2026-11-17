import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  failingTestNames,
  runBatched,
  summaryCounts,
} from '../../scripts/run-unit-tests-batched.mjs';
import {
  formatReport,
  newFailures,
  unitGate,
} from '../../scripts/upstream-check.mjs';

const recap = (names) =>
  [
    '✔ fine (1.2ms)',
    '✖ broken one (3.4ms)',
    '  AssertionError: details',
    'ℹ tests 3',
    'ℹ pass 1',
    `ℹ fail ${names.length}`,
    '',
    '✖ failing tests:',
    '',
    ...names.flatMap((n) => [
      `✖ ${n} (12.5ms)`,
      '  AssertionError [ERR_ASSERTION]: no',
    ]),
  ].join('\n');

test('summary counts and failing names come from the recap only, without durations', () => {
  const out = recap(['broken one', 'broken two']);
  assert.deepEqual(summaryCounts(out), { tests: 3, pass: 1, fail: 2 });
  assert.deepEqual(failingTestNames(out), ['broken one', 'broken two']);
  // A run with no recap names nothing, even with ✖ lines in its body.
  assert.deepEqual(failingTestNames('✖ broken one (3ms)\nℹ fail 1'), []);
  assert.deepEqual(failingTestNames(recap(['slow (2.1s)'])), ['slow (2.1s)']);
});

/** A fake node: `results` maps a file to its exit status and failing names. */
function fakeRun(results, calls = []) {
  return (args) => {
    calls.push(args);
    const files = args.filter((a) => a.endsWith('.test.mjs'));
    const bad = files.filter((f) => results[f]?.status);
    const together = files.length > 1 && results.together?.status;
    const names = bad.flatMap((f) => results[f].names ?? []);
    return {
      status: bad.length || together ? 1 : 0,
      output: `ℹ tests ${files.length * 2}\nℹ pass ${files.length * 2 - names.length}\nℹ fail ${names.length}\n${names.length ? `✖ failing tests:\n${names.map((n) => `✖ ${n} (1ms)`).join('\n')}` : ''}`,
    };
  };
}

test('batches the files and names each failing test by its file', () => {
  const files = Array.from({ length: 7 }, (_, i) => `src/t${i}.test.mjs`);
  const calls = [];
  const summary = runBatched({
    files,
    batchSize: 3,
    calibrated: false,
    run: fakeRun(
      {
        'src/t4.test.mjs': { status: 1, names: ['four breaks'] },
        'src/t6.test.mjs': { status: 1 },
      },
      calls,
    ),
  });
  // Three batches (3 + 3 + 1), then each file of the two failing batches alone.
  assert.equal(
    calls.filter((a) => a.filter((x) => x.endsWith('.test.mjs')).length > 1)
      .length,
    2,
  );
  assert.ok(
    calls.every((a) => a.filter((x) => x.endsWith('.test.mjs')).length <= 3),
  );
  assert.deepEqual(summary.failures, {
    'src/t4.test.mjs': ['four breaks'],
    'src/t6.test.mjs': ['exited 1 without naming a failing test'],
  });
  assert.equal(summary.files, 7);
  assert.ok(summary.tests > 0);
});

test('a batch that fails only together is still reported, never dropped', () => {
  const files = ['src/a.test.mjs', 'src/b.test.mjs'];
  const summary = runBatched({
    files,
    calibrated: false,
    run: fakeRun({ together: { status: 1 } }),
  });
  const keys = Object.keys(summary.failures);
  assert.equal(keys.length, 1);
  assert.match(keys[0], /^batch 1 \(src\/a\.test\.mjs … src\/b\.test\.mjs\)$/);
});

test('allocation probes run alone with --expose-gc, and only where calibrated', () => {
  const probe = 'src/data/focusAllocations.test.mjs';
  const calls = [];
  runBatched({
    files: ['src/a.test.mjs', probe],
    calibrated: true,
    run: fakeRun({}, calls),
  });
  const probeCall = calls.find((a) => a.includes(probe));
  assert.deepEqual(probeCall, [
    '--expose-gc',
    '--test',
    '--test-reporter=spec',
    '--test-concurrency=1',
    probe,
  ]);
  assert.ok(
    !calls.some((a) => a.includes(probe) && a.includes('src/a.test.mjs')),
  );
  const skipped = [];
  runBatched({ files: [probe], calibrated: false, run: fakeRun({}, skipped) });
  assert.equal(skipped.length, 0);
});

test('only failures the branch does not share count as new', () => {
  assert.deepEqual(
    newFailures(
      {
        'src/known.test.mjs': ['always fails on Windows'],
        'src/mixed.test.mjs': ['old failure', 'new failure'],
        'src/new.test.mjs': ['upstream test'],
      },
      {
        'src/known.test.mjs': ['always fails on Windows'],
        'src/mixed.test.mjs': ['old failure'],
      },
    ),
    {
      'src/mixed.test.mjs': ['new failure'],
      'src/new.test.mjs': ['upstream test'],
    },
  );
});

test('the report names the files it did not count', () => {
  const text = formatReport({
    status: 'clean',
    branch: 'HEAD',
    head: 'a'.repeat(40),
    upstream: 'upstream/main',
    upstream_head: 'b'.repeat(40),
    behind: 1,
    ahead: 1,
    upstream_changed: ['x'],
    overlap: [],
    conflicts: [],
    gates: [
      {
        name: 'unit tests (batched)',
        pass: true,
        tests: 9,
        seconds: 1,
        also_failing_on_branch: ['src/known.test.mjs'],
        tail: '',
      },
    ],
  });
  assert.match(
    text,
    /PASS unit tests \(batched\) \(9 tests\).*failing on the branch too, so not counted: `src\/known\.test\.mjs`/,
  );
});

// The gate end to end against a throwaway repository whose batched runner is a
// stub: on Windows rules, a failure shared with the branch passes, a new one
// fails, and the second worktree is gone afterwards with the junction target intact.
function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

const STUB = `import fs from 'node:fs';
const failures = JSON.parse(fs.readFileSync('failures.json', 'utf8'));
const at = process.argv.indexOf('--files');
const only = at >= 0 ? process.argv[at + 1].split(',') : null;
const shown = Object.fromEntries(Object.entries(failures).filter(([f]) => !only || only.includes(f)));
console.log('stub');
console.log(JSON.stringify({ files: 3, tests: 6, pass: 5, fail: Object.keys(shown).length, failures: shown }));
`;

function gateRepo(branchFailures) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-unit-gate-'));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'scripts/run-unit-tests-batched.mjs'), STUB);
  for (const f of ['src/known.test.mjs', 'src/other.test.mjs'])
    fs.writeFileSync(path.join(root, f), '');
  fs.writeFileSync(
    path.join(root, 'failures.json'),
    JSON.stringify(branchFailures),
  );
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  git(
    root,
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@localhost',
    'commit',
    '-qm',
    'base',
  );
  // The real dependencies the junction points at; must survive the cleanup.
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.writeFileSync(path.join(root, 'node_modules/keep.txt'), 'keep');
  return { root, head: git(root, 'rev-parse', 'HEAD') };
}

function mergedTree(root, failures) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-unit-merged-'));
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.writeFileSync(path.join(dir, 'scripts/run-unit-tests-batched.mjs'), STUB);
  fs.writeFileSync(path.join(dir, 'failures.json'), JSON.stringify(failures));
  return dir;
}

const worktrees = (root) =>
  git(root, 'worktree', 'list', '--porcelain')
    .split('\n')
    .filter((l) => l.startsWith('worktree ')).length;

test('Windows rules: a failure shared with the branch passes and is named; the branch worktree is removed', () => {
  const { root, head } = gateRepo({ 'src/known.test.mjs': ['always'] });
  const dir = mergedTree(root, { 'src/known.test.mjs': ['always'] });
  const gate = unitGate(dir, root, head, 'win32');
  assert.equal(gate.pass, true, gate.tail);
  assert.deepEqual(gate.also_failing_on_branch, ['src/known.test.mjs']);
  assert.equal(worktrees(root), 1);
  assert.equal(
    fs.readFileSync(path.join(root, 'node_modules/keep.txt'), 'utf8'),
    'keep',
  );
});

test('Windows rules: a failure the branch does not have fails the gate', () => {
  const { root, head } = gateRepo({ 'src/known.test.mjs': ['always'] });
  const dir = mergedTree(root, {
    'src/known.test.mjs': ['always'],
    'src/other.test.mjs': ['broken by the merge'],
    'src/added.test.mjs': ['new upstream file'],
  });
  const gate = unitGate(dir, root, head, 'win32');
  assert.equal(gate.pass, false);
  assert.match(gate.tail, /broken by the merge/);
  assert.match(gate.tail, /new upstream file/);
  assert.doesNotMatch(gate.tail, /"always"/);
  assert.equal(worktrees(root), 1);
  assert.ok(fs.existsSync(path.join(root, 'node_modules/keep.txt')));
});

test('other platforms: any failure fails, with no branch rerun', () => {
  const { root, head } = gateRepo({ 'src/known.test.mjs': ['always'] });
  const dir = mergedTree(root, { 'src/known.test.mjs': ['always'] });
  const gate = unitGate(dir, root, head, 'linux');
  assert.equal(gate.pass, false);
  assert.equal(gate.also_failing_on_branch, undefined);
  const clean = unitGate(mergedTree(root, {}), root, head, 'linux');
  assert.equal(clean.pass, true);
  assert.equal(clean.tests, 6);
});
