// Fork: Autopilot waits out upstream's opening (src/intel/startupHold.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { STARTUP_HOLD_MAX_MS, createStartupHold } from './startupHold.js';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

function cover() {
  const classes = new Set();
  return {
    classes,
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
    },
    addEventListener() {},
    removeEventListener() {},
  };
}

test('held while the cover shows or an opening flies; then free for good', () => {
  const screen = cover();
  let playing = false;
  let clock = 0;
  const held = createStartupHold({
    loadingScreen: screen,
    openingPlaying: () => playing,
    now: () => clock,
  });
  assert.equal(held(), true, 'start-up has not decided yet');
  playing = true;
  assert.equal(held(), true, 'the opening flies under the cover');
  screen.classList.add('hidden');
  assert.equal(held(), true, 'the cover is gone; the camera is still flying');
  playing = false;
  assert.equal(held(), false, 'landed');
  screen.classList.remove('hidden');
  playing = true;
  assert.equal(held(), false, 'once free, stays free');
});

test('never held past the cap, nor by a cover nobody will lift', () => {
  let clock = 0;
  const stuck = createStartupHold({
    loadingScreen: cover(),
    now: () => clock,
  });
  assert.equal(stuck(), true);
  clock = STARTUP_HOLD_MAX_MS;
  assert.equal(stuck(), false);
  assert.equal(STARTUP_HOLD_MAX_MS, 60_000);

  let playing = true;
  const noChrome = createStartupHold({
    loadingScreen: cover(),
    coverDecides: false,
    openingPlaying: () => playing,
  });
  assert.equal(noChrome(), true, 'only the opening holds');
  playing = false;
  assert.equal(noChrome(), false);
  assert.equal(createStartupHold()(), false, 'no cover, no opening');
});

// Upstream's start-up chrome, run as in src/standalone/startupChrome.test.mjs.
function startup({ opening }) {
  const timers = [];
  const context = {
    console,
    setTimeout(fn, delay) {
      timers.push({ fn, delay });
      return timers.length;
    },
    clearTimeout() {},
  };
  vm.createContext(context);
  vm.runInContext(
    read('../app/startupChrome.js')
      .replace(/^import .*;\n/gm, '')
      .replace('export function', 'function'),
    context,
  );
  const screen = cover();
  let restored;
  context.startApplicationChrome({
    loadingScreen: screen,
    styleManager: {
      _navigationGeneration: 0,
      hasShareState: false,
      viewer: 'viewer',
      initialRestorePromise: new Promise((resolve) => {
        restored = resolve;
      }),
    },
    dataManager: {},
    signal: new AbortController().signal,
    initializeWelcome: () => ({ destroy() {} }),
    playOpening: opening,
  });
  const minimumDelay = () => {
    for (const task of timers.splice(0))
      if (task.delay === 1000) task.fn();
      else timers.push(task);
  };
  return { screen, restored, minimumDelay };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('with upstream start-up: free only once the opening has landed', async () => {
  let playing = false;
  let landed;
  const run = startup({
    opening: ({ loadingScreen }) => {
      playing = true;
      return {
        done: new Promise((resolve) => {
          landed = () => {
            loadingScreen.classList.add('hidden');
            playing = false;
            resolve();
          };
        }),
        cancel() {},
      };
    },
  });
  const held = createStartupHold({
    loadingScreen: run.screen,
    openingPlaying: () => playing,
  });
  assert.equal(held(), true, 'restoring');
  run.restored({ navigationToken: 0 });
  await settle();
  assert.equal(held(), true, 'the minimum delay has not passed');
  run.minimumDelay();
  await settle();
  assert.equal(playing, true, 'the opening started');
  assert.equal(held(), true);
  landed();
  await settle();
  assert.equal(held(), false);
});

test('with upstream start-up and no opening: free once the cover goes', async () => {
  const run = startup({ opening: () => null });
  const held = createStartupHold({ loadingScreen: run.screen });
  run.restored({ navigationToken: 0 });
  run.minimumDelay();
  await settle();
  assert.equal(run.screen.classList.contains('hidden'), true);
  assert.equal(held(), false);
});

test('Autopilot steps only when the camera is not held, and is wired so', () => {
  const console = read('../ui/intelConsole.js');
  const step = console.slice(console.indexOf('  function step() {'));
  const gate = step.indexOf('if (cameraHeld())');
  assert.ok(gate > 0, 'step() asks first');
  assert.ok(gate < step.indexOf('stepScheduler('), 'before any decision');
  assert.match(step, /startupTimer \?\?= setTimeout\(/);
  assert.match(console, /cameraHeld = \(\) => false,/);
  assert.match(console, /destroyed = true;\n\s+clearTimeout\(startupTimer\);/);
  const tools = read('../app/tools.js');
  assert.match(
    tools,
    /cameraHeld: createStartupHold\(\{\s*loadingScreen,\s*coverDecides: !!startChrome,\s*openingPlaying,\s*\}\)/,
  );
});

test("the fork's browser scripts open without the opening", () => {
  for (const script of [
    'qa-autopilot.mjs',
    'qa-gnss-regions.mjs',
    'qa-fast-intelligence.mjs',
    'perf-autopilot.mjs',
    'qa-local-voice.mjs',
  ]) {
    const source = read(`../../scripts/${script}`);
    const gotos = source.match(/\.goto\(`[^`]*`/g) ?? [];
    const app = gotos.filter((call) => !call.includes('about:blank'));
    assert.ok(app.length > 0, script);
    for (const call of app) assert.match(call, /intro=0/, `${script}: ${call}`);
  }
});
