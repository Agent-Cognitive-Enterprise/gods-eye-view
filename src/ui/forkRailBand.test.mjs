// Fork: the panel rails sit as a row above their columns (intel.css,
// --panel-rail-band), so the left rail's computed `top` is one band above its
// stack's offset. The right column must still line up with the left one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutLeftPanelRail, layoutRightPanelRail } from './panelRails.js';

const BAND = 46;

function element(
  id,
  { height = 42, top = 234, left = 20, width = 272, collapsed = false } = {},
) {
  const classes = new Set(collapsed ? ['collapsed'] : []);
  const properties = new Map();
  const attributes = new Map();
  return {
    id,
    children: [],
    dataset: {},
    parentElement: null,
    scrollHeight: height,
    clientHeight: height,
    scrollTop: 0,
    computed: {
      display: 'block',
      visibility: 'visible',
      opacity: '1',
      rowGap: '12px',
      getPropertyValue: (name) =>
        name === '--panel-rail-band' ? `${BAND}px` : '',
    },
    rect: {
      top,
      left,
      width,
      height,
      right: left + width,
      bottom: top + height,
    },
    classList: {
      contains: (n) => classes.has(n),
      add: (...n) => n.forEach((x) => classes.add(x)),
      remove: (...n) => n.forEach((x) => classes.delete(x)),
      toggle(n, v) {
        if (v) classes.add(n);
        else classes.delete(n);
      },
    },
    style: {
      setProperty: (n, v) => properties.set(n, v),
      getPropertyValue: (n) => properties.get(n) || '',
      removeProperty: (n) => properties.delete(n),
    },
    getBoundingClientRect() {
      return this.rect;
    },
    getAnimations: () => [],
    matches: (s) => s === '[data-panel-id]',
    contains(t) {
      return t === this || this.children.some((c) => c.contains(t));
    },
    querySelectorAll() {
      return this.children;
    },
    setAttribute: (n, v) => attributes.set(n, v),
    removeAttribute: (n) => attributes.delete(n),
    getAttribute: (n) => attributes.get(n),
  };
}

/** Lay the right column out beside a left stack at 146 px, with or without its rail. */
function layout({ leftRailTop, leftRailHidden = false }) {
  const first = element('first', { collapsed: true });
  const second = element('second', { collapsed: true });
  const stack = element('right', { height: 96, left: 1100, top: 146 });
  stack.children = [first, second];
  first.parentElement = second.parentElement = stack;
  const leftStack = element('left', { top: 146 });
  leftStack.style.setProperty('--panel-rail-offset', '0.0px');
  if (leftRailTop !== null) {
    const rail = element('left-rail');
    rail.computed.top = leftRailTop;
    if (leftRailHidden) rail.computed.display = 'none';
    leftStack.querySelector = () => rail;
  }
  stack.ownerDocument = { activeElement: null };
  layoutRightPanelRail({
    stack,
    hud: { visible: true, variant: 'tactical' },
    documentRef: stack.ownerDocument,
    obstacles: [],
    collapsedHeights: new Map(),
    windowRef: {
      innerHeight: 900,
      matchMedia: () => ({ matches: false }),
      getComputedStyle: (n) => n.computed,
    },
    onCollapse() {},
    onRetry() {},
    onAligned() {},
    displayPanel: null,
    readDisplayScrollTop: () => 0,
    leftStack,
  });
  const safeTop = Number(stack.dataset.safeTop);
  const offset = parseFloat(
    stack.style.getPropertyValue('--panel-rail-offset'),
  );
  return { panelsTop: safeTop, railRowTop: safeTop + offset - BAND };
}

test('the right column lines up with the left one when the rails are a row above them', () => {
  // The left rail's computed top: one band above its stack (offset 0).
  const withRail = layout({ leftRailTop: `-${BAND}px` });
  const withoutRail = layout({ leftRailTop: null });
  assert.equal(
    withRail.panelsTop,
    146,
    'panels start level with the left column',
  );
  assert.equal(
    withRail.railRowTop,
    146 - BAND,
    'rail row level with the left one',
  );
  assert.deepEqual(withRail, withoutRail);
});

test('a left rail lifted beyond its band is still followed', () => {
  // A layout that raises the left rail 20 px more than the band moved the column.
  const lifted = layout({ leftRailTop: `-${BAND + 20}px` });
  assert.equal(lifted.panelsTop, 126);
});

test('a hidden left rail still lines the columns up', () => {
  const hidden = layout({ leftRailTop: `-${BAND}px`, leftRailHidden: true });
  assert.equal(hidden.panelsTop, 146);
});

/** Lay the left column out with its rail row and one card in the lane. */
function leftLayout({ innerHeight, card }) {
  const first = element('first', { collapsed: false, height: 120 });
  const second = element('second', { collapsed: true });
  const stack = element('left', { height: 200, top: 146 });
  stack.children = [first, second];
  first.parentElement = second.parentElement = stack;
  const rail = element('left-rail');
  stack.querySelector = () => rail;
  stack.ownerDocument = {
    activeElement: null,
    body: { classList: { contains: () => false } },
  };
  layoutLeftPanelRail({
    stack,
    hud: { visible: true, variant: 'tactical' },
    documentRef: stack.ownerDocument,
    obstacles: [element('card', card)],
    collapsedHeights: new Map(),
    windowRef: {
      innerHeight,
      matchMedia: () => ({ matches: false }),
      getComputedStyle: (n) => n.computed,
    },
    onCollapse() {},
    onRetry() {},
    onAligned() {},
    displayPanel: null,
    readDisplayScrollTop: () => 0,
  });
  const panelsTop = (Number(stack.dataset.safeTopPct) / 100) * innerHeight;
  return { panelsTop, railRowTop: panelsTop - BAND };
}

test('beside an obstacle across the middle, the rail row keeps on screen and clear of it', () => {
  // More room above the card: the panels go up, the row stays on screen.
  const above = leftLayout({
    innerHeight: 700,
    card: { top: 300, height: 120, left: 20, width: 272 },
  });
  assert.ok(above.railRowTop >= 700 * 0.04 - 0.5, JSON.stringify(above));
  // More room below the card: the row starts under it, not over it.
  const below = leftLayout({
    innerHeight: 480,
    card: { top: 100, height: 200, left: 20, width: 272 },
  });
  assert.ok(below.railRowTop >= 300, JSON.stringify(below));
});
