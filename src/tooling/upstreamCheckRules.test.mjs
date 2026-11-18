// scripts/upstream-check.mjs with the merge rules of scripts/merge-resolvers.mjs,
// end to end in throwaway repositories.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SCRIPT_PATH,
  formatReport,
  withResolved,
} from '../../scripts/upstream-check.mjs';
import { formatPrettierJson } from '../../scripts/merge-resolvers.mjs';

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

const run = (cwd, ...args) => {
  const result = spawnSync(process.execPath, [SCRIPT_PATH, '--json', ...args], {
    cwd,
    encoding: 'utf8',
  });
  return {
    code: result.status,
    report: result.stdout ? JSON.parse(result.stdout) : null,
    stderr: result.stderr,
  };
};

const json2 = (value) => `${JSON.stringify(value, null, 2)}\n`;
const html = (icons) =>
  `<!doctype html>\n<link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined&icon_names=${icons}" rel="stylesheet" />\n`;
const boundaries = (modules, strict = true) =>
  formatPrettierJson({ ui: { exports: ['./ui'], modules, strict } });

/**
 * Fork and upstream both add to a locale catalog, the icon list and the
 * package boundaries, so git conflicts in all three. Branches: `fork` (checked
 * out), `upstream-lists`, `upstream-mixed` (also a voice conflict no rule
 * covers) and `upstream-refused` (a boundaries field both sides changed; it
 * clashes with `fork-policy`).
 */
function listsRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-upstream-lists-'));
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  };
  const commit = (message) => {
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', message);
  };
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Fork Owner');
  git(dir, 'config', 'user.email', 'owner@localhost');
  git(dir, 'config', 'core.autocrlf', 'false');
  write(
    'src/i18n/locales/de.json',
    json2({ Ships: 'Schiffe', Camera: 'Kamera' }),
  );
  write('index.html', html('add,flight'));
  write('scripts/package-boundaries.json', boundaries(['a.js']));
  write('src/voice/session.js', 'export const mode = "cloud";\n');
  commit('base');
  git(dir, 'switch', '-q', '-c', 'fork');
  write(
    'src/i18n/locales/de.json',
    json2({
      Ships: 'Schiffe',
      Camera: 'Kamera',
      Banking: 'Bankwesen',
      'Move up': 'Nach oben',
    }),
  );
  write('index.html', html('add,flight,live_tv'));
  write('scripts/package-boundaries.json', boundaries(['a.js', 'fork.js']));
  write('src/voice/session.js', 'export const mode = "local";\n');
  commit('fork: lists');
  git(dir, 'switch', '-q', '-c', 'upstream-lists', 'main');
  write(
    'src/i18n/locales/de.json',
    json2({
      Ships: 'Schiffe',
      Camera: 'Kamera',
      Rail: 'Bahn',
      'Move up': 'Nach oben verschieben',
    }),
  );
  write('index.html', html('add,arrow_upward,flight'));
  write('scripts/package-boundaries.json', boundaries(['a.js', 'rail.js']));
  commit('upstream: lists');
  git(dir, 'switch', '-q', '-c', 'upstream-mixed', 'upstream-lists');
  write('src/voice/session.js', 'export const mode = "realtime";\n');
  commit('upstream: voice');
  git(dir, 'switch', '-q', '-c', 'upstream-refused', 'main');
  write(
    'scripts/package-boundaries.json',
    boundaries(['a.js', 'rail.js'], 'loose'),
  );
  commit('upstream: boundaries policy');
  git(dir, 'switch', '-q', '-c', 'fork-policy', 'fork');
  write(
    'scripts/package-boundaries.json',
    boundaries(['a.js', 'fork.js'], false),
  );
  commit('fork: boundaries policy');
  git(dir, 'switch', '-q', 'fork');
  return dir;
}

const inRepo = (body) => () => {
  const dir = listsRepo();
  try {
    body(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

test(
  'conflicts in the lists both sides add to are merged by rule, and listed',
  inRepo((dir) => {
    const before = git(dir, 'status', '--porcelain');
    const head = git(dir, 'rev-parse', 'HEAD');
    const { code, report, stderr } = run(dir, '--upstream', 'upstream-lists');
    assert.equal(code, 0, stderr);
    assert.equal(report.status, 'clean');
    assert.deepEqual(report.conflicts, []);
    assert.deepEqual(
      report.resolved.map(({ file, rule }) => [file, rule]).sort(),
      [
        ['index.html', 'icon list'],
        ['scripts/package-boundaries.json', 'package boundaries'],
        ['src/i18n/locales/de.json', 'locale catalog'],
      ],
    );
    const de = report.resolved.find((r) => r.rule === 'locale catalog');
    assert.equal(de.notes.length, 1);
    assert.match(
      de.notes[0],
      /^"Move up": both sides added it; kept upstream's "Nach oben verschieben" over ours "Nach oben"$/,
    );
    assert.match(
      formatReport(report),
      /### Merged by rule[\s\S]*de\.json` \(locale catalog\)\n {2}- check: "Move up"/,
    );
    assert.equal(report.merge_commit, undefined, 'only a gated run commits');
    assert.equal(git(dir, 'rev-parse', 'HEAD'), head, 'branch not moved');
    assert.equal(git(dir, 'status', '--porcelain'), before, 'tree untouched');
    assert.equal(git(dir, 'worktree', 'list').split('\n').length, 1);
  }),
);

test(
  'a conflict no rule covers still stops the merge; the rest are reported as merged',
  inRepo((dir) => {
    const { code, report } = run(dir, '--upstream', 'upstream-mixed');
    assert.equal(code, 2);
    assert.equal(report.status, 'conflicts');
    assert.deepEqual(report.conflicts, [
      { file: 'src/voice/session.js', areas: ['voice'] },
    ]);
    assert.equal(report.resolved.length, 3);
  }),
);

test(
  'a rule that cannot settle its file leaves the conflict, with the reason',
  inRepo((dir) => {
    git(dir, 'switch', '-q', 'fork-policy');
    const { code, report } = run(dir, '--upstream', 'upstream-refused');
    assert.equal(code, 2);
    assert.deepEqual(report.conflicts, [
      {
        file: 'scripts/package-boundaries.json',
        areas: [],
        rule: 'package boundaries',
        refused: '"ui".strict was changed differently on both sides',
      },
    ]);
    assert.match(
      formatReport(report),
      /package-boundaries\.json`\n {2}- not merged by the package boundaries rule: "ui"\.strict/,
    );
  }),
);

test(
  'a gated run commits the merge with the given message, the repo identity and both parents',
  inRepo((dir) => {
    const head = git(dir, 'rev-parse', 'HEAD');
    const upstream = git(dir, 'rev-parse', 'upstream-lists');
    // The gates fail here (no package.json); the commit is made before them.
    fs.mkdirSync(path.join(dir, 'node_modules'));
    fs.writeFileSync(path.join(dir, 'node_modules', 'keep.txt'), 'x');
    const message = `${dir}-msg.txt`;
    fs.writeFileSync(
      message,
      'Merge upstream/main: daily sync\n\nCo-Authored-By: Someone <s@localhost>\n',
    );
    try {
      const { code, report } = run(
        dir,
        '--upstream',
        'upstream-lists',
        '--gates',
        'quick',
        '--message-file',
        message,
      );
      assert.equal(code, 3);
      assert.equal(report.status, 'gates_failed');
      assert.match(report.merge_commit, /^[0-9a-f]{40}$/);
      const c = report.merge_commit;
      assert.equal(git(dir, 'rev-parse', `${c}^1`), head);
      assert.equal(git(dir, 'rev-parse', `${c}^2`), upstream);
      assert.equal(
        git(dir, 'log', '-1', '--format=%an <%ae>|%cn <%ce>', c),
        'Fork Owner <owner@localhost>|Fork Owner <owner@localhost>',
      );
      assert.equal(
        git(dir, 'log', '-1', '--format=%B', c),
        [
          'Merge upstream/main: daily sync',
          '',
          'Conflicts merged by rule (scripts/merge-resolvers.mjs):',
          ...report.resolved.map(({ file, rule }) => `- ${file} (${rule})`),
          '',
          'Co-Authored-By: Someone <s@localhost>',
        ].join('\n'),
      );
      // The committed tree holds the merged files.
      assert.match(
        git(dir, 'show', `${c}:index.html`),
        /icon_names=add,arrow_upward,flight,live_tv"/,
      );
      assert.ok(report.gates.some((g) => g.name === 'i18n'));
      assert.equal(git(dir, 'rev-parse', 'HEAD'), head, 'branch not moved');
      assert.equal(git(dir, 'worktree', 'list').split('\n').length, 1);
      assert.ok(
        fs.existsSync(path.join(dir, 'node_modules', 'keep.txt')),
        'the node_modules link was removed, never followed',
      );
    } finally {
      fs.rmSync(message, { force: true });
    }
  }),
);

test(
  '--message-file is refused without --gates',
  inRepo((dir) => {
    const { code, stderr } = run(
      dir,
      '--upstream',
      'upstream-lists',
      '--message-file',
      'x.txt',
    );
    assert.equal(code, 1);
    assert.match(stderr, /--message-file needs --gates/);
  }),
);

test('withResolved names the rule-merged files before the trailers', () => {
  const files = [{ file: 'index.html', rule: 'icon list' }];
  const list =
    'Conflicts merged by rule (scripts/merge-resolvers.mjs):\n- index.html (icon list)';
  assert.equal(withResolved('Subject\n', []), 'Subject\n');
  assert.equal(
    withResolved('Subject\n\nBody.\n\nCo-Authored-By: A <a@x>\n', files),
    `Subject\n\nBody.\n\n${list}\n\nCo-Authored-By: A <a@x>\n`,
  );
  assert.equal(
    withResolved('Subject\n\nBody.', files),
    `Subject\n\nBody.\n\n${list}\n`,
  );
  // A one-paragraph message has no trailer block.
  assert.equal(withResolved('Fix: thing', files), `Fix: thing\n\n${list}\n`);
});
