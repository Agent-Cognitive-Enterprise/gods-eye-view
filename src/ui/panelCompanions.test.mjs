// FEEDS and FAST INTELLIGENCE stay open together, and FAST INTELLIGENCE takes the
// height FEEDS leaves. Every other panel keeps the one-panel rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import { allocatePanelFillHeights } from '../panelStackLayout.js';
import { arePanelCompanions, settleSideAccordion } from './panelAccordion.js';

const panel = (id, collapsed = false) => ({
  id,
  classList: { contains: (name) => name === 'collapsed' && collapsed },
  contains: () => false,
});

function settle(panels, preferredPanelId) {
  const collapsed = [];
  settleSideAccordion({
    panels,
    enabled: true,
    preferredPanelId,
    onCollapse: (item) => collapsed.push(item.id),
  });
  return collapsed;
}

test('only the two fork panels are companions, in either order', () => {
  assert.ok(arePanelCompanions('intel-feeds-panel', 'fast-intel-panel'));
  assert.ok(arePanelCompanions('fast-intel-panel', 'intel-feeds-panel'));
  assert.ok(!arePanelCompanions('fast-intel-panel', 'data-panel'));
  assert.ok(!arePanelCompanions('data-panel', 'scene-panel'));
  assert.ok(!arePanelCompanions('fast-intel-panel', 'fast-intel-panel'));
});

test('companions both stay open, whichever opened last', () => {
  const pair = () => [panel('intel-feeds-panel'), panel('fast-intel-panel')];
  assert.deepEqual(settle(pair(), 'fast-intel-panel'), []);
  assert.deepEqual(settle(pair(), 'intel-feeds-panel'), []);
});

test('any other panel still closes them', () => {
  const panels = [
    panel('data-panel'),
    panel('intel-feeds-panel'),
    panel('fast-intel-panel'),
  ];
  assert.deepEqual(settle(panels, 'data-panel'), [
    'intel-feeds-panel',
    'fast-intel-panel',
  ]);
});

test('the filling panel takes all the height when alone', () => {
  assert.deepEqual(
    allocatePanelFillHeights({
      naturalHeights: [120],
      fillIndex: 0,
      availableHeight: 780,
    }),
    [780],
  );
});

test('FEEDS keeps its natural height; FAST INTELLIGENCE takes the rest', () => {
  assert.deepEqual(
    allocatePanelFillHeights({
      naturalHeights: [120, 300],
      fillIndex: 0,
      availableHeight: 780,
    }),
    [480, 300],
  );
});

test('it does not matter how little the filling panel holds', () => {
  const [fill, feeds] = allocatePanelFillHeights({
    naturalHeights: [40, 300],
    fillIndex: 0,
    availableHeight: 780,
  });
  assert.equal(feeds, 300);
  assert.equal(fill, 480);
});

test('on a short screen FEEDS gives way so the filling panel stays usable', () => {
  const [fill, feeds] = allocatePanelFillHeights({
    naturalHeights: [120, 300],
    fillIndex: 0,
    availableHeight: 400,
  });
  assert.equal(feeds, 240);
  assert.equal(fill, 160);
  assert.equal(fill + feeds, 400);
});

test('a corridor with no height gives no height', () => {
  assert.deepEqual(
    allocatePanelFillHeights({
      naturalHeights: [120, 300],
      fillIndex: 0,
      availableHeight: 0,
    }),
    [0, 0],
  );
});
