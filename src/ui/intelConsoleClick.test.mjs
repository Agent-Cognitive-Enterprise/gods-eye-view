// Fork: the Autopilot console's scene click follows upstream's rule that the
// card or label painted on top takes the click (src/data/pickRegistry.js
// clickCard). createIntelConsole needs a live viewer and has no harness, so
// this reads the handler's source: it must ask for the card on top before it
// reads the marker under it, and act on its own card.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(
  new URL('./intelConsole.js', import.meta.url),
  'utf8',
);

test('the Autopilot click asks for the card on top before the marker under it', () => {
  const start = source.indexOf('inputFor(sceneHost).onClick(');
  assert.ok(start > 0, 'the console clicks through the input dispatcher');
  const handler = source.slice(start, source.indexOf('\n    });', start));
  const card = handler.indexOf('picking?.clickCard?.(event)');
  const marker = handler.indexOf('event.topHit');
  assert.ok(card > 0, 'reads the card on top');
  assert.ok(marker > card, 'before the marker under it');
  // Any card on top returns; only our own card acts (opens its source), and
  // only on a short, still press: a pan that ends on the card opens nothing.
  const onCard = handler.slice(card, marker);
  assert.match(
    onCard,
    /card\.sourceId === CARD_SOURCE &&\s*isTrackingClickGesture\(event\.gesture\)\s*\)\s*card\.entry\?\.activate\?\.\(\);\s*return;/,
  );
});

test('the AUTOPILOT tab is the one Autopilot icon, and shows when it runs', () => {
  assert.doesNotMatch(source, /top-center-actions|intel-autopilot-btn/);
  assert.match(source, /panel\.dataset\.autopilot = mode;/);
  // It goes when the console does, and is spoken on the tab.
  assert.match(source, /delete panel\?\.dataset\?\.autopilot;/);
  assert.match(source, /setAttribute\('aria-description', text\)/);
  const css = readFileSync(
    new URL('./styles/intel.css', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(css, /#intel-autopilot-btn/);
  // A dot on the tab while it flies the camera, an amber ring while paused.
  assert.match(
    css,
    /body:has\(#intel-panel:is\(\[data-autopilot='auto'\], \[data-autopilot='paused'\]\)\)\s*\.ui-rail__item\[data-rail-item='intel-panel'\]::after \{[^}]*content: '';/,
  );
  assert.match(
    css,
    /body:has\(#intel-panel\[data-autopilot='paused'\]\)\s*\.ui-rail__item\[data-rail-item='intel-panel'\]::after \{[^}]*border: 2px solid #ffcf6e;/,
  );
});
