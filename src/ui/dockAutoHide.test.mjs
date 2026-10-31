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
      querySelector: () => surface,
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

test('dock auto-hide: recall band is the bottom 120 px', () => {
  assert.equal(inRevealZone(779, 900), false);
  assert.equal(inRevealZone(780, 900), true);
  assert.equal(inRevealZone(undefined, 900), false);
});
