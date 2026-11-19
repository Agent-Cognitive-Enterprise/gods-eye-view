import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDockAutoHide,
  DOCK_HIDDEN_CLASS,
  inRevealZone,
} from './dockAutoHide.js';

function fakeDom({ hovered = false, touch = false } = {}) {
  const classes = new Set();
  const listeners = {};
  const surface = {
    matches: (selector) => selector === ':hover' && dom.hovered,
    querySelector: (selector) =>
      selector.includes('aria-expanded') ? (dom.expanded[0] ?? null) : null,
    querySelectorAll: () => dom.expanded,
    contains: () => false,
  };
  const dom = {
    hovered,
    held: null,
    expanded: [],
    listeners,
    documentRef: {
      body: {
        classList: {
          add: (c) => classes.add(c),
          remove: (c) => classes.delete(c),
          contains: (c) => classes.has(c),
        },
      },
      activeElement: null,
      querySelector: (selector) =>
        selector.includes('.gev-guide') ? dom.held : surface,
      addEventListener: (type, fn) => (listeners[type] = fn),
      removeEventListener: (type) => delete listeners[type],
    },
    windowRef: {
      innerHeight: 900,
      matchMedia: () => ({ matches: touch }),
    },
    timers: [],
    setTimer(fn) {
      dom.timers.push(fn);
      return dom.timers.length;
    },
    clearTimer() {},
    runTimers() {
      const pending = dom.timers.splice(0);
      for (const fn of pending) fn();
    },
  };
  return dom;
}

const mount = (dom) =>
  createDockAutoHide({
    documentRef: dom.documentRef,
    windowRef: dom.windowRef,
    setTimer: (fn) => dom.setTimer(fn),
    clearTimer: () => {},
  });

test('dock auto-hide: hides when idle, returns on a key or the bottom edge', () => {
  const dom = fakeDom();
  const dock = mount(dom);
  assert.equal(dock.isHidden(), false, 'shown at start');
  dom.runTimers();
  assert.equal(dock.isHidden(), true);
  dom.listeners.keydown({ key: 'a' });
  assert.equal(dock.isHidden(), false, 'any key recalls it');
  dom.runTimers();
  dom.listeners.pointermove({ clientY: 300 });
  assert.equal(dock.isHidden(), true, 'pointer mid-screen does nothing');
  dom.listeners.pointermove({ clientY: 850 });
  assert.equal(dock.isHidden(), false, 'bottom edge recalls it');
  dock.destroy();
  assert.equal(dock.isHidden(), false);
  assert.equal(dom.listeners.keydown, undefined);
});

test('dock auto-hide: stays while hovered and on touch-only devices', () => {
  const hovered = fakeDom({ hovered: true });
  const dock = mount(hovered);
  hovered.runTimers();
  assert.equal(dock.isHidden(), false, 'hovered');
  hovered.hovered = false;
  hovered.runTimers();
  assert.equal(dock.isHidden(), true);
  const touch = fakeDom({ touch: true });
  const touchDock = mount(touch);
  touch.runTimers();
  assert.equal(touchDock.isHidden(), false, 'no keyboard to recall it');
  assert.equal(DOCK_HIDDEN_CLASS, 'gev-dock-hidden');
});

test('dock auto-hide: an open menu holds it, a closed popup does not', () => {
  const dom = fakeDom();
  const dock = mount(dom);
  dom.expanded = [{ closest: () => null }];
  dom.runTimers();
  assert.equal(dock.isHidden(), false, 'open menu');
  // The language search field always says aria-expanded="true", inside a
  // popup that is `hidden` while closed.
  dom.expanded = [
    { closest: (selector) => (selector === '[hidden]' ? {} : null) },
  ];
  dom.runTimers();
  assert.equal(dock.isHidden(), true, 'closed language popup');
});

test('dock auto-hide: the Omnibar hides with the dock and holds it while its results show', async () => {
  const dom = fakeDom();
  const omnibar = {
    resultsOpen: false,
    classList: {
      contains: (name) => name === 'has-results' && omnibar.resultsOpen,
    },
  };
  const asked = [];
  const surfaceFor = dom.documentRef.querySelector;
  dom.documentRef.querySelector = (selector) => {
    asked.push(selector);
    return selector === '#gev-omnibar' ? omnibar : surfaceFor(selector);
  };
  const dock = mount(dom);
  omnibar.resultsOpen = true;
  dom.runTimers();
  assert.ok(asked.includes('#gev-omnibar'), 'the Omnibar is a surface');
  assert.equal(dock.isHidden(), false, 'results on show');
  omnibar.resultsOpen = false;
  dom.runTimers();
  assert.equal(dock.isHidden(), true);

  const { readFile } = await import('node:fs/promises');
  const css = await readFile(new URL('./styles/intel.css', import.meta.url), 'utf8');
  const rule = css.match(/([^{}]*)\{\s*opacity: 0 !important;\s*visibility: hidden !important;/);
  assert.ok(rule, 'the hide rule is there');
  assert.match(rule[1], /body\.gev-dock-hidden #gev-omnibar\b/, 'the Omnibar fades out too');
});

test('dock auto-hide: Omnibar results that arrive while hidden bring the controls back', () => {
  const dom = fakeDom();
  const omnibar = {
    resultsOpen: false,
    classList: {
      contains: (name) => name === 'has-results' && omnibar.resultsOpen,
    },
  };
  const surfaceFor = dom.documentRef.querySelector;
  dom.documentRef.querySelector = (selector) =>
    selector === '#gev-omnibar' ? omnibar : surfaceFor(selector);
  const dock = mount(dom);
  dom.runTimers();
  assert.equal(dock.isHidden(), true);
  dom.runTimers();
  assert.equal(dock.isHidden(), true, 'nothing new: stays hidden');
  // A chip's action fails after the dock has gone: its error shows.
  omnibar.resultsOpen = true;
  dom.runTimers();
  assert.equal(dock.isHidden(), false, 'the error is on show again');
  dock.destroy();
  assert.equal(dom.timers.length > 0, true);
  dom.runTimers();
  assert.equal(dock.isHidden(), false, 'a destroyed dock never hides');
});

test('dock auto-hide: the guide and a voice session hold the controls', () => {
  const dom = fakeDom();
  const dock = mount(dom);
  dom.held = {};
  dom.runTimers();
  assert.equal(dock.isHidden(), false, 'guide or voice session up');
  dom.held = null;
  dom.runTimers();
  assert.equal(dock.isHidden(), true);
  dom.held = {};
  dom.runTimers();
  assert.equal(dock.isHidden(), false, 'the guide opening while hidden recalls them');
  const holds = [];
  const probe = fakeDom();
  probe.documentRef.querySelector = (selector) => (holds.push(selector), null);
  mount(probe);
  probe.runTimers();
  const held = holds.find((selector) => selector.includes('.gev-guide'));
  assert.match(held, /\.gev-guide\.visible/);
  assert.match(held, /#gev-voice-control\[data-assistant-mode='voice'\]/);
});

test('dock auto-hide: the Omnibar fades as the bar does', async () => {
  const { readFile } = await import('node:fs/promises');
  const css = await readFile(new URL('./styles/intel.css', import.meta.url), 'utf8');
  const rule = css.match(/([^{}]*)\{\s*transition:\s*opacity 0\.35s ease,/);
  assert.ok(rule);
  assert.match(rule[1], /#gev-omnibar\b/);
});

test('dock auto-hide: recall band is the bottom 120 px', () => {
  assert.equal(inRevealZone(779, 900), false);
  assert.equal(inRevealZone(780, 900), true);
  assert.equal(inRevealZone(undefined, 900), false);
});
