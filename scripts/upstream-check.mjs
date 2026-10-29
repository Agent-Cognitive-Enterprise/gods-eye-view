#!/usr/bin/env node
// Upstream merge check for the fork (docs/FORK-MAINTENANCE.md).
//
// Merges an upstream ref into a branch inside a temporary git worktree and
// reports: how far behind the branch is, which files both sides changed,
// conflicts (flagging Director, voice, camera and other fork-sensitive areas)
// and, with --gates, whether the merged tree passes the repository's gates.
// The current checkout, its working tree and any running server are never
// touched; the worktree is removed afterwards unless --keep is given.
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

function runGates(dir, root, level, upstreamChanged) {
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
  if (level === 'full') gates.push(npm('test', 'test'));
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
      );
      if (report.gates.some((g) => !g.pass)) report.status = 'gates_failed';
    }
    return report;
  } finally {
    if (options.keep && added) report.worktree = dir;
    else {
      if (added)
        git(root, ['worktree', 'remove', '--force', dir], { allowFail: true });
      fs.rmSync(dir, { recursive: true, force: true });
      git(root, ['worktree', 'prune'], { allowFail: true });
    }
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
        `- ${g.pass ? 'PASS' : 'FAIL'} ${g.name}${g.tests === undefined ? '' : ` (${g.tests} tests)`} (${g.seconds}s)`,
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

export const SCRIPT_PATH = fileURLToPath(import.meta.url);
