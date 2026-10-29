import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SCRIPT_PATH,
  areasOf,
  formatReport,
} from '../../scripts/upstream-check.mjs';

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

/** A repo with `main`, an `upstream` branch and a `fork` branch. */
function fixtureRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-upstream-fixture-'));
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  };
  const commit = (message) => {
    git(dir, 'add', '-A');
    git(
      dir,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@localhost',
      'commit',
      '-qm',
      message,
    );
  };
  git(dir, 'init', '-q', '-b', 'main');
  write('src/voice/session.js', 'export const mode = "cloud";\n');
  write('src/director/camera.js', 'export const speed = 1;\n');
  write('README.md', 'base\n');
  commit('base');
  git(dir, 'switch', '-q', '-c', 'fork');
  write('src/voice/session.js', 'export const mode = "local";\n');
  write('src/intel/engine.js', 'export const engine = true;\n');
  commit('fork: local voice');
  git(dir, 'switch', '-q', '-c', 'upstream-clean', 'main');
  write('README.md', 'base\nupstream docs\n');
  write('src/director/camera.js', 'export const speed = 2;\n');
  commit('upstream: director speed');
  git(dir, 'switch', '-q', '-c', 'upstream-conflict', 'main');
  write('src/voice/session.js', 'export const mode = "realtime";\n');
  commit('upstream: voice mode');
  git(dir, 'switch', '-q', 'fork');
  return dir;
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

test('areas flag Director, voice and Autopilot integration hooks', () => {
  assert.deepEqual(areasOf('src/director/camera.js'), ['director', 'camera']);
  assert.ok(areasOf('src/voice/geminiSession.js').includes('voice'));
  assert.deepEqual(areasOf('src/app/tools.js'), ['autopilot-hooks']);
  assert.deepEqual(areasOf('package-lock.json'), ['dependencies']);
  assert.deepEqual(areasOf('src/layers/ships/index.js'), []);
});

test('A20: an upstream change to a voice file the fork changed is a reported conflict; the checkout is untouched', () => {
  const dir = fixtureRepo();
  try {
    const before = git(dir, 'status', '--porcelain');
    const head = git(dir, 'rev-parse', 'HEAD');
    const { code, report } = run(dir, '--upstream', 'upstream-conflict');
    assert.equal(code, 2);
    assert.equal(report.status, 'conflicts');
    assert.deepEqual(report.conflicts, [
      { file: 'src/voice/session.js', areas: ['voice'] },
    ]);
    assert.match(
      formatReport(report),
      /Merge conflicts[\s\S]*src\/voice\/session\.js` \(voice\)/,
    );
    assert.equal(git(dir, 'rev-parse', 'HEAD'), head, 'branch not moved');
    assert.equal(
      git(dir, 'status', '--porcelain'),
      before,
      'working tree untouched',
    );
    assert.equal(
      git(dir, 'worktree', 'list').split('\n').length,
      1,
      'temporary worktree removed',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a non-overlapping upstream update merges cleanly; an up-to-date branch says so', () => {
  const dir = fixtureRepo();
  try {
    const clean = run(dir, '--upstream', 'upstream-clean');
    assert.equal(clean.code, 0, clean.stderr);
    assert.equal(clean.report.status, 'clean');
    assert.equal(clean.report.behind, 1);
    assert.deepEqual(clean.report.overlap, []);
    assert.deepEqual(clean.report.upstream_changed.sort(), [
      'README.md',
      'src/director/camera.js',
    ]);
    const current = run(dir, '--upstream', 'main');
    assert.equal(current.report.status, 'up_to_date');
    assert.equal(run(dir, '--gates', 'sometimes').code, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
