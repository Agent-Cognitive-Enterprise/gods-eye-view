#!/usr/bin/env node
// Upstream merge check for the fork (docs/FORK-MAINTENANCE.md).
//
// Merges an upstream ref into a branch inside a temporary git worktree and
// reports: how far behind the branch is, which files both sides changed,
// conflicts (flagging Director, voice, camera and other fork-sensitive areas)
// and, with --gates, whether the merged tree passes the repository's gates.
// On Windows the full unit gate also reruns the merged tree's failing test
// files on the branch itself, in a second temporary worktree, to tell new
// failures from ones the branch already has.
// The current checkout, its working tree and any running server are never
// touched; the merge worktree is removed afterwards unless --keep is given,
// and the branch one always is.
//
//   node scripts/upstream-check.mjs [--upstream upstream/main] [--branch HEAD]
//     [--fetch] [--gates quick|full] [--json] [--keep] [--summary file.md]
//
// Exit codes: 0 clean (and gates passed), 2 merge conflicts, 3 gate failure,
// 1 usage or git error. Uses only Node built-ins and git, so it can run under
// a privileged CI token without installing or executing upstream code (gates
// are opt-in and belong in an unprivileged job).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Defined before anything runs: the command-line block below reads it.
export const SCRIPT_PATH = fileURLToPath(import.meta.url);

/** Fork-sensitive areas: overlap here needs a deliberate review. */
export const SENSITIVE_AREAS = Object.freeze([
  ['director', /(^|\/)director|Director/i],
  ['voice', /(^|\/)(voice|localVoice)\/|voice/i],
  ['camera', /camera|navigation|cockpit/i],
  [
    'autopilot-hooks',
    /^(src\/app\/tools\.js|context\.html|style\.css|src\/standalone\/tools\.js|server\/providers\/local\.js)$/,
  ],
  ['i18n', /^src\/i18n\/locales\//],
  ['dependencies', /^(package\.json|package-lock\.json)$/],
  ['ci', /^\.github\//],
]);

/** Areas a path belongs to. */
export function areasOf(file) {
  return SENSITIVE_AREAS.filter(([, pattern]) => pattern.test(file)).map(
    ([name]) => name,
  );
}

const QUICK_TESTS = [
  'src/intel',
  'server/providers/intel',
  'server/providers/localVoice',
  'src/voice/localVoice.test.mjs',
];

function parseArgs(argv) {
  const options = {
    upstream: 'upstream/main',
    branch: 'HEAD',
    fetch: false,
    gates: null,
    json: false,
    keep: false,
    summary: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--upstream') options.upstream = argv[++i];
    else if (arg === '--branch') options.branch = argv[++i];
    else if (arg === '--gates') options.gates = argv[++i];
    else if (arg === '--fetch') options.fetch = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--keep') options.keep = true;
    else if (arg === '--summary') options.summary = argv[++i];
    else throw new Error(`unknown argument ${arg}`);
  }
  if (options.gates && !['quick', 'full'].includes(options.gates))
    throw new Error('--gates must be quick or full');
  if (!options.upstream || !options.branch)
    throw new Error('--upstream and --branch need a value');
  return options;
}

function git(cwd, args, { allowFail = false } = {}) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0 && !allowFail)
    throw new Error(
      `git ${args.join(' ')} failed: ${(result.stderr || '').trim()}`,
    );
  return { ok: result.status === 0, out: (result.stdout || '').trim() };
}

const lines = (text) => (text ? text.split('\n').filter(Boolean) : []);

/** npm through this Node, without a shell, so arguments are never re-parsed. */
function npmCli() {
  const dir = path.dirname(process.execPath);
  const cli = [
    process.env.npm_execpath,
    path.join(dir, 'node_modules/npm/bin/npm-cli.js'),
    path.join(dir, '../lib/node_modules/npm/bin/npm-cli.js'),
  ].find((file) => file && /npm-cli\.js$/.test(file) && fs.existsSync(file));
  if (!cli) throw new Error('npm-cli.js not found next to this Node');
  return cli;
}

function runGate(cwd, name, args) {
  const started = Date.now();
  const result = spawnSync(process.execPath, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, PUPPETEER_SKIP_DOWNLOAD: '1' },
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  // A node --test run that matched no tests must not pass silently.
  const tests = Number(/^ℹ tests (\d+)/m.exec(output)?.[1]);
  const pass = result.status === 0 && tests !== 0;
  return {
    name,
    pass,
    seconds: Math.round((Date.now() - started) / 1000),
    ...(Number.isFinite(tests) ? { tests } : {}),
    tail: pass ? '' : output.split('\n').slice(-25).join('\n'),
  };
}

/** Remove a temporary worktree: its node_modules link first, so no delete follows it. */
function removeWorktree(root, dir, added) {
  const link = path.join(dir, 'node_modules');
  try {
    if (fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link);
  } catch {
    // no link
  }
  if (added)
    git(root, ['worktree', 'remove', '--force', dir], { allowFail: true });
  fs.rmSync(dir, { recursive: true, force: true });
  git(root, ['worktree', 'prune'], { allowFail: true });
}

/**
 * The batched unit run (scripts/run-unit-tests-batched.mjs) in `cwd`: the
 * tree's own runner, or this checker's copy when the tree predates it.
 */
function batchedUnitRun(cwd, files = null) {
  const own = path.join(cwd, 'scripts/run-unit-tests-batched.mjs');
  const result = spawnSync(
    process.execPath,
    [
      fs.existsSync(own)
        ? own
        : path.join(path.dirname(SCRIPT_PATH), 'run-unit-tests-batched.mjs'),
      '--json',
      ...(files ? ['--files', files.join(',')] : []),
    ],
    {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, PUPPETEER_SKIP_DOWNLOAD: '1' },
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const last = (result.stdout ?? '').trim().split('\n').at(-1) ?? '';
  try {
    return { summary: JSON.parse(last), output };
  } catch {
    return { summary: null, output };
  }
}

/**
 * The batched runner's prefixes for failures that never match the branch's
 * (ALWAYS_NEW in scripts/run-unit-tests-batched.mjs, kept equal by a test).
 * Copied, not imported: importing the runner would load the tree's
 * run-unit-tests.mjs into this process even without --gates.
 */
export const ALWAYS_NEW_PREFIXES = Object.freeze([
  '(whole file) ',
  '(unattributed) ',
  '(only in a batch) ',
]);

/**
 * Failing tests in `merged` that do not also fail in `base`, by file. A test
 * matches by its name, repeats counted: two failures named alike against one
 * on the branch leave one new. A whole-file failure, a run that named nothing,
 * a batch-only failure, or a file `base` does not have always counts.
 */
export function newFailures(merged, base) {
  const fresh = {};
  for (const [file, names] of Object.entries(merged)) {
    const known = [...(base[file] ?? [])];
    const added = names.filter((name) => {
      if (ALWAYS_NEW_PREFIXES.some((prefix) => name.startsWith(prefix)))
        return true;
      const at = known.indexOf(name);
      if (at < 0) return true;
      known.splice(at, 1);
      return false;
    });
    if (added.length) fresh[file] = added;
  }
  return fresh;
}

/** The new failures with their first error lines, for the report. */
function describeFailures(fresh, errors = {}) {
  const out = {};
  for (const [file, names] of Object.entries(fresh)) {
    const lines = [...(errors[file] ?? [])];
    out[file] = names.map((name) => {
      const at = lines.findIndex(
        (line) => line === name || line.startsWith(`${name} — `),
      );
      return at >= 0 ? lines.splice(at, 1)[0] : name;
    });
  }
  return out;
}

/**
 * The full unit gate. `npm test` passes every test file on one command line,
 * which Windows refuses (ENAMETOOLONG) at the suite's size, so the files run in
 * batches. On Windows a few upstream test files also always fail (path
 * separators; Linux CI runs them), so there a failure counts only when the same
 * test passes on the branch as it is: those files are rerun in a second
 * worktree at `head`. Everywhere else, any failure fails the gate.
 */
export function unitGate(dir, root, head, platform = process.platform) {
  const name = 'unit tests (batched)';
  const started = Date.now();
  const seconds = () => Math.round((Date.now() - started) / 1000);
  const merged = batchedUnitRun(dir);
  if (!merged.summary)
    return {
      name,
      pass: false,
      seconds: seconds(),
      tail: merged.output.split('\n').slice(-25).join('\n'),
    };
  const { tests, failures, errors } = merged.summary;
  const failing = Object.keys(failures);
  const gate = { name, tests, seconds: 0 };
  if (tests === 0 || !failing.length || platform !== 'win32') {
    const pass = tests > 0 && !failing.length;
    return {
      ...gate,
      pass,
      seconds: seconds(),
      tail: pass
        ? ''
        : JSON.stringify(describeFailures(failures, errors), null, 1).slice(
            0,
            4000,
          ),
    };
  }
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-upstream-base-'));
  let added = false;
  let base;
  try {
    git(root, ['worktree', 'add', '--quiet', '--detach', baseDir, head]);
    added = true;
    fs.symlinkSync(
      path.join(root, 'node_modules'),
      path.join(baseDir, 'node_modules'),
      'junction',
    );
    const present = failing.filter((file) =>
      fs.existsSync(path.join(baseDir, file)),
    );
    base = present.length ? batchedUnitRun(baseDir, present) : null;
  } finally {
    removeWorktree(root, baseDir, added);
  }
  if (base && !base.summary)
    return {
      ...gate,
      pass: false,
      seconds: seconds(),
      tail: `the branch rerun of ${failing.join(', ')} gave no summary:\n${base.output.split('\n').slice(-20).join('\n')}`,
    };
  const fresh = newFailures(failures, base?.summary.failures ?? {});
  const pass = !Object.keys(fresh).length;
  return {
    ...gate,
    pass,
    seconds: seconds(),
    // Named in the report either way, so a person sees what was tolerated.
    also_failing_on_branch: failing.filter((file) => !fresh[file]),
    tail: pass
      ? ''
      : `new failures (they pass on the branch):\n${JSON.stringify(describeFailures(fresh, errors), null, 1).slice(0, 4000)}`,
  };
}

function runGates(dir, root, level, upstreamChanged, head) {
  const cli = npmCli();
  const npm = (name, ...args) => runGate(dir, name, [cli, ...args]);
  const gates = [];
  // Reuse installed dependencies unless upstream changed them.
  if (upstreamChanged.some((f) => /^package(-lock)?\.json$/.test(f)))
    gates.push(npm('npm ci', 'ci'));
  else
    fs.symlinkSync(
      path.join(root, 'node_modules'),
      path.join(dir, 'node_modules'),
      'junction',
    );
  if (gates.some((g) => !g.pass)) return gates;
  gates.push(npm('format:check', 'run', 'format:check'));
  gates.push(npm('check:boundaries', 'run', 'check:boundaries'));
  if (level === 'full') gates.push(unitGate(dir, root, head));
  else
    gates.push(
      runGate(dir, 'autopilot and voice tests', [
        '--test',
        ...QUICK_TESTS.map((p) => (p.endsWith('.mjs') ? p : `${p}/*.test.mjs`)),
      ]),
    );
  gates.push(npm('build', 'run', 'build'));
  return gates;
}

/** Run the check; returns the report (never throws for merge conflicts). */
export function upstreamCheck(options, cwd = process.cwd()) {
  const root = git(cwd, ['rev-parse', '--show-toplevel']).out;
  if (options.fetch) {
    const remote = options.upstream.split('/')[0];
    git(root, ['fetch', '--quiet', remote]);
  }
  const head = git(root, [
    'rev-parse',
    '--verify',
    `${options.branch}^{commit}`,
  ]).out;
  const upstream = git(root, [
    'rev-parse',
    '--verify',
    `${options.upstream}^{commit}`,
  ]).out;
  const base = git(root, ['merge-base', head, upstream]).out;
  const behind = Number(
    git(root, ['rev-list', '--count', `${head}..${upstream}`]).out,
  );
  const ahead = Number(
    git(root, ['rev-list', '--count', `${upstream}..${head}`]).out,
  );
  const report = {
    branch: options.branch,
    upstream: options.upstream,
    head,
    upstream_head: upstream,
    merge_base: base,
    behind,
    ahead,
    upstream_changed: [],
    overlap: [],
    conflicts: [],
    gates: [],
    status: 'up_to_date',
  };
  if (behind === 0) return report;
  report.upstream_changed = lines(
    git(root, ['diff', '--name-only', base, upstream]).out,
  );
  const forkChanged = new Set(
    lines(git(root, ['diff', '--name-only', base, head]).out),
  );
  report.overlap = report.upstream_changed
    .filter((f) => forkChanged.has(f))
    .map((file) => ({ file, areas: areasOf(file) }));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-upstream-check-'));
  let added = false;
  // The worktree's node_modules may be a junction to the real one: remove
  // the link itself first, so no recursive delete can ever follow it.
  const cleanup = () => removeWorktree(root, dir, added);
  // Ctrl+C or a stop request still cleans up before exiting.
  const interrupted = (signal) => {
    cleanup();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  process.once('SIGINT', interrupted);
  process.once('SIGTERM', interrupted);
  try {
    git(root, ['worktree', 'add', '--quiet', '--detach', dir, head]);
    added = true;
    const identity = [
      '-c',
      'user.name=upstream-check',
      '-c',
      'user.email=upstream-check@localhost',
    ];
    const merge = git(
      dir,
      [...identity, 'merge', '--no-ff', '--no-commit', upstream],
      {
        allowFail: true,
      },
    );
    report.conflicts = lines(
      git(dir, ['diff', '--name-only', '--diff-filter=U']).out,
    ).map((file) => ({ file, areas: areasOf(file) }));
    if (report.conflicts.length || !merge.ok) {
      report.status = 'conflicts';
      if (!report.conflicts.length)
        report.conflicts = [{ file: '(merge failed)', areas: [] }];
      return report;
    }
    report.status = 'clean';
    if (options.gates) {
      git(dir, [
        ...identity,
        'commit',
        '--quiet',
        '--no-verify',
        '-m',
        'upstream-check merge',
      ]);
      report.gates = runGates(
        dir,
        root,
        options.gates,
        report.upstream_changed,
        head,
      );
      if (report.gates.some((g) => !g.pass)) report.status = 'gates_failed';
    }
    return report;
  } finally {
    process.off('SIGINT', interrupted);
    process.off('SIGTERM', interrupted);
    if (options.keep && added) report.worktree = dir;
    else cleanup();
  }
}

/** Markdown summary for a terminal, an issue or a job summary. */
export function formatReport(report) {
  const out = [
    `## Upstream check: ${report.status.replace('_', ' ')}`,
    '',
    `- \`${report.branch}\` (${report.head.slice(0, 8)}) is ${report.behind} commit(s) behind and ${report.ahead} ahead of \`${report.upstream}\` (${report.upstream_head.slice(0, 8)}).`,
  ];
  if (report.behind === 0) return out.join('\n');
  out.push(
    `- Upstream changed ${report.upstream_changed.length} file(s); ${report.overlap.length} also changed by the fork.`,
  );
  const list = (title, items) => {
    if (!items.length) return;
    out.push('', `### ${title}`, '');
    for (const { file, areas } of items)
      out.push(`- \`${file}\`${areas.length ? ` (${areas.join(', ')})` : ''}`);
  };
  list('Merge conflicts', report.conflicts);
  list('Changed on both sides', report.overlap);
  if (report.gates.length) {
    out.push('', '### Gates', '');
    for (const g of report.gates)
      out.push(
        `- ${g.pass ? 'PASS' : 'FAIL'} ${g.name}${g.tests === undefined ? '' : ` (${g.tests} tests)`} (${g.seconds}s)${g.also_failing_on_branch?.length ? `; failing on the branch too, so not counted: ${g.also_failing_on_branch.map((f) => `\`${f}\``).join(', ')}` : ''}`,
      );
    for (const g of report.gates.filter((x) => !x.pass))
      out.push(
        '',
        `<details><summary>${g.name} output</summary>`,
        '',
        '```',
        g.tail,
        '```',
        '',
        '</details>',
      );
  }
  if (report.worktree) out.push('', `Worktree kept at \`${report.worktree}\`.`);
  return out.join('\n');
}

const EXIT = { up_to_date: 0, clean: 0, conflicts: 2, gates_failed: 3 };

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    const report = upstreamCheck(options);
    // Markdown for a pull request, an issue or a job summary.
    if (options.summary)
      fs.writeFileSync(
        options.summary,
        `${formatReport(report)}
`,
      );
    console.log(
      options.json ? JSON.stringify(report, null, 2) : formatReport(report),
    );
    process.exitCode = EXIT[report.status] ?? 1;
  } catch (error) {
    console.error(`upstream-check: ${error.message}`);
    process.exitCode = 1;
  }
}
