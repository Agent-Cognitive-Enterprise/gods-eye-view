import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ALWAYS_NEW,
  errorKind,
  failingTests,
  runBatched,
  summaryCounts,
} from '../../scripts/run-unit-tests-batched.mjs';
import {
  ALWAYS_NEW_PREFIXES,
  formatReport,
  newFailures,
  unitGate,
} from '../../scripts/upstream-check.mjs';

/** Node 24's spec-reporter recap, as it prints it. */
function recap(entries) {
  return [
    '✔ fine (1.2ms)',
    '✖ works (3.4ms)',
    '  ✖ fake (1ms)',
    `ℹ tests ${entries.length + 1}`,
    'ℹ pass 1',
    `ℹ fail ${entries.length}`,
    '',
    '✖ failing tests:',
    ...entries.flatMap(({ at, name, error, more = [] }) => [
      '',
      `test at ${at}`,
      `✖ ${name} (12.5ms)`,
      `  ${error}`,
      ...more.map((line) => `    ${line}`),
    ]),
  ].join('\n');
}

const ROOT = 'C:\\tmp\\gev-upstream-check-abc';

test('summary counts come from the closing summary', () => {
  assert.deepEqual(
    summaryCounts(recap([{ at: 'src/a.test.mjs:1:1', name: 'x', error: 'E' }])),
    { tests: 2, pass: 1, fail: 1 },
  );
});

test('failing tests are read from the recap: file, name, first error line', () => {
  const out = recap([
    {
      at: 'src/a.test.mjs:3:29',
      name: 'works',
      error: 'AssertionError [ERR_ASSERTION]: A broke',
      more: ['  ✖ fake (1ms)'],
    },
    {
      at: 'src/a.test.mjs:4:29',
      name: 'works',
      error: `Error: path ${ROOT}\\src\\x is bad`,
    },
    {
      at: 'src\\b.test.mjs:9:1',
      name: 'slow (2.1s)',
      error: 'Error: timed out',
    },
  ]);
  assert.deepEqual(failingTests(out, ROOT), [
    {
      at: 'src/a.test.mjs',
      name: 'works',
      error: 'AssertionError [ERR_ASSERTION]: A broke',
      wholeFile: false,
    },
    // The tree's own path is removed from what is reported.
    {
      at: 'src/a.test.mjs',
      name: 'works',
      error: 'Error: path \\src\\x is bad',
      wholeFile: false,
    },
    {
      at: 'src/b.test.mjs',
      name: 'slow (2.1s)',
      error: 'Error: timed out',
      wholeFile: false,
    },
  ]);
  // Lines inside error text and the body above the recap name nothing.
  assert.ok(!failingTests(out, ROOT).some((t) => t.name === 'fake'));
  assert.deepEqual(failingTests('✖ works (3ms)\nℹ fail 1'), []);
});

test('a whole-file failure is recognised, by an absolute or a relative path', () => {
  const abs = recap([
    {
      at: `${ROOT}\\src\\b.test.mjs:1:1`,
      name: `${ROOT}\\src\\b.test.mjs`,
      error: "'test failed'",
    },
  ]);
  const [found] = failingTests(abs, ROOT);
  assert.equal(found.at, 'src/b.test.mjs');
  assert.equal(found.wholeFile, true);
  const rel = recap([
    {
      at: 'src/b.test.mjs:1:1',
      name: 'src/b.test.mjs',
      error: "'test failed'",
    },
  ]);
  assert.equal(failingTests(rel, ROOT)[0].wholeFile, true);
});

test('the checker and the runner agree on what always counts as new', () => {
  assert.deepEqual([...ALWAYS_NEW_PREFIXES], [...ALWAYS_NEW]);
});

/**
 * A fake node. `alone[file]` is the recap entries that file fails with when
 * run by itself (in a batch too); `together` adds entries only a multi-file
 * run shows; `probe` gives an allocation probe's statuses, run after run.
 */
function fakeRun({ alone = {}, together = [], probe = [] } = {}, calls = []) {
  let probeRun = 0;
  return (args) => {
    calls.push(args);
    const files = args.filter((a) => a.endsWith('.test.mjs'));
    if (args.includes('--expose-gc')) {
      const status = probe[probeRun++] ?? 0;
      return {
        status,
        output: status
          ? recap([
              {
                at: `${files[0]}:5:1`,
                name: 'budget',
                error: 'Error: 12 KB over',
              },
            ])
          : 'ℹ tests 1\nℹ pass 1\nℹ fail 0',
      };
    }
    const entries = files.flatMap((f) => alone[f] ?? []);
    if (files.length > 1) entries.push(...together);
    return {
      status: entries.length ? 1 : 0,
      output: entries.length
        ? recap(entries)
        : `ℹ tests ${files.length}\nℹ pass ${files.length}\nℹ fail 0`,
    };
  };
}

const fileCount = (args) => args.filter((x) => x.endsWith('.test.mjs')).length;

test('batches the files, then names each failure by its file', () => {
  const files = Array.from({ length: 7 }, (_, i) => `src/t${i}.test.mjs`);
  const calls = [];
  const summary = runBatched({
    files,
    batchSize: 3,
    calibrated: false,
    root: ROOT,
    run: fakeRun(
      {
        alone: {
          'src/t4.test.mjs': [
            { at: 'src/t4.test.mjs:2:1', name: 'four', error: 'Error: no' },
          ],
        },
      },
      calls,
    ),
  });
  // Batches of 3, 3 and 1; only the failing middle batch is rerun file by file.
  assert.equal(calls.filter((a) => fileCount(a) > 1).length, 2);
  assert.equal(calls.length, 3 + 3);
  assert.ok(calls.every((a) => fileCount(a) <= 3));
  assert.deepEqual(summary.failures, { 'src/t4.test.mjs': ['four [Error]'] });
  assert.deepEqual(summary.errors, {
    'src/t4.test.mjs': ['four [Error] — Error: no'],
  });
  assert.equal(summary.files, 7);
});

test('a test a helper module defines is filed under the test file that ran it', () => {
  const helper = {
    at: 'src/testSupport/latency.mjs:3:28',
    name: 'latency stays low',
    error: 'Error: 900 ms',
  };
  const summary = runBatched({
    files: ['src/flights.test.mjs', 'src/military.test.mjs'],
    calibrated: false,
    root: ROOT,
    run: fakeRun({
      alone: {
        'src/flights.test.mjs': [helper],
        'src/military.test.mjs': [helper],
      },
    }),
  });
  // Both files keep their own failure; the batch's two are matched, none is batch-only.
  assert.deepEqual(summary.failures, {
    'src/flights.test.mjs': ['latency stays low [Error]'],
    'src/military.test.mjs': ['latency stays low [Error]'],
  });
});

test('a failure seen only in the batch is kept, even when another file fails alone', () => {
  const summary = runBatched({
    files: ['src/known.test.mjs', 'src/racy.test.mjs'],
    calibrated: false,
    root: ROOT,
    run: fakeRun({
      alone: {
        'src/known.test.mjs': [
          {
            at: 'src/known.test.mjs:1:5',
            name: 'always',
            error: 'Error: windows',
          },
        ],
      },
      together: [
        {
          at: 'src/racy.test.mjs:7:3',
          name: 'racy',
          error: 'Error: port in use',
        },
        // A helper's test that failed only together has no file of its own.
        { at: 'src/testSupport/h.mjs:1:1', name: 'shared', error: 'Error: x' },
      ],
    }),
  });
  assert.deepEqual(summary.failures, {
    'src/known.test.mjs': ['always [Error]'],
    'src/racy.test.mjs': [`${ALWAYS_NEW[2]}racy [Error]`],
    'batch 1 (src/known.test.mjs … src/racy.test.mjs)': [
      `${ALWAYS_NEW[2]}shared [Error]`,
    ],
  });
});

test('a batch failure is matched by name, so a varying error line does not make it batch-only', () => {
  let call = 0;
  const run = (args) => {
    call++;
    const files = args.filter((a) => a.endsWith('.test.mjs'));
    if (!files.includes('src/known.test.mjs'))
      return { status: 0, output: 'ℹ tests 1' };
    return {
      status: 1,
      output: recap([
        {
          at: 'src/known.test.mjs:1:5',
          name: 'always',
          error: `Error: port ${50000 + call}`,
        },
      ]),
    };
  };
  const summary = runBatched({
    files: ['src/known.test.mjs', 'src/b.test.mjs'],
    calibrated: false,
    root: ROOT,
    run,
  });
  assert.deepEqual(summary.failures, {
    'src/known.test.mjs': ['always [Error]'],
  });
});

test('a batch that failed without naming anything, while every file passed alone, is still a failure', () => {
  const run = (args) =>
    fileCount(args) > 1
      ? { status: null, error: 'ETIMEDOUT', output: '' }
      : { status: 0, output: 'ℹ tests 1' };
  const summary = runBatched({
    files: ['src/a.test.mjs', 'src/b.test.mjs'],
    calibrated: false,
    root: ROOT,
    run,
  });
  const [[file, keys]] = Object.entries(summary.failures);
  assert.match(file, /^batch 1 \(src\/a\.test\.mjs … src\/b\.test\.mjs\)$/);
  assert.match(keys[0], /^\(unattributed\) the batch exited ETIMEDOUT/);
});

test('allocation probes run once each, alone, and only where calibrated', () => {
  const probe = 'src/data/focusAllocations.test.mjs';
  const calls = [];
  // Fails on the first run and would pass on a second: the miss is kept.
  const summary = runBatched({
    files: ['src/a.test.mjs', probe],
    calibrated: true,
    root: ROOT,
    run: fakeRun({ probe: [1, 0] }, calls),
  });
  const probeCalls = calls.filter((a) => a.includes(probe));
  assert.equal(probeCalls.length, 1);
  assert.deepEqual(probeCalls[0], [
    '--expose-gc',
    '--test',
    '--test-reporter=spec',
    '--test-concurrency=1',
    probe,
  ]);
  assert.deepEqual(summary.failures, { [probe]: ['budget [Error]'] });
  const skipped = [];
  runBatched({
    files: [probe],
    calibrated: false,
    root: ROOT,
    run: fakeRun({}, skipped),
  });
  assert.equal(skipped.length, 0);
});

test('only failures the branch does not share count as new, repeats counted; the marked kinds always count', () => {
  const whole = `${ALWAYS_NEW[0]}src/w.test.mjs`;
  const none = `${ALWAYS_NEW[1]}exited 1 without naming a failing test`;
  assert.deepEqual(
    newFailures(
      {
        'src/known.test.mjs': ['always'],
        'src/mixed.test.mjs': ['old', 'new'],
        'src/twice.test.mjs': ['works', 'works'],
        'src/new.test.mjs': ['upstream'],
        'src/w.test.mjs': [whole],
        'src/n.test.mjs': [none],
      },
      {
        'src/known.test.mjs': ['always'],
        'src/mixed.test.mjs': ['old'],
        'src/twice.test.mjs': ['works'],
        'src/w.test.mjs': [whole],
        'src/n.test.mjs': [none],
      },
    ),
    {
      'src/mixed.test.mjs': ['new'],
      'src/twice.test.mjs': ['works'],
      'src/new.test.mjs': ['upstream'],
      'src/w.test.mjs': [whole],
      'src/n.test.mjs': [none],
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

test('SCRIPT_PATH exists before the command-line block runs (the runner fallback reads it)', () => {
  // Importing evaluates the whole module first, so only the source order shows this.
  const source = fs.readFileSync(
    new URL('../../scripts/upstream-check.mjs', import.meta.url),
    'utf8',
  );
  const declared = source.indexOf('export const SCRIPT_PATH');
  const cli = source.indexOf('import.meta.url === pathToFileURL(');
  assert.ok(
    declared >= 0 && cli > declared,
    'declare SCRIPT_PATH above the command-line block',
  );
});

test('a batch killed or crashed without a recap is a failure even when a file of it failed alone', () => {
  const run = (args) => {
    const files = args.filter((a) => a.endsWith('.test.mjs'));
    if (files.length > 1)
      return { status: null, error: 'ETIMEDOUT', output: '' };
    return files[0] === 'src/known.test.mjs'
      ? {
          status: 1,
          output: recap([
            {
              at: 'src/known.test.mjs:1:5',
              name: 'always',
              error: 'Error: windows',
            },
          ]),
        }
      : { status: 0, output: 'ℹ tests 1' };
  };
  const summary = runBatched({
    files: ['src/known.test.mjs', 'src/hangs.test.mjs'],
    calibrated: false,
    root: ROOT,
    run,
  });
  const label = 'batch 1 (src/known.test.mjs … src/hangs.test.mjs)';
  assert.deepEqual(summary.failures['src/known.test.mjs'], ['always [Error]']);
  assert.match(
    summary.failures[label][0],
    /^\(unattributed\) the batch exited ETIMEDOUT without a recap/,
  );
  // And the branch cannot excuse it.
  assert.deepEqual(
    Object.keys(
      newFailures(summary.failures, {
        'src/known.test.mjs': ['always [Error]'],
      }),
    ),
    [label],
  );
});

test('the error kind is stable across runs and tells an assertion from a crash or a timeout', () => {
  assert.equal(
    errorKind('AssertionError [ERR_ASSERTION]: Expected values'),
    'AssertionError',
  );
  assert.equal(errorKind('Error: listen EADDRINUSE 127.0.0.1:53817'), 'Error');
  assert.equal(errorKind('TypeError: x is not a function'), 'TypeError');
  assert.equal(
    errorKind("'test timed out after 30000ms'"),
    "'test timed out after #ms'",
  );
  assert.equal(errorKind(''), '');
  // A known assertion failure that became a crash is a new failure.
  assert.deepEqual(
    newFailures(
      { 'src/k.test.mjs': ['works [TypeError]'] },
      { 'src/k.test.mjs': ['works [AssertionError]'] },
    ),
    { 'src/k.test.mjs': ['works [TypeError]'] },
  );
});
