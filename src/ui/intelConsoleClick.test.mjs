// Fork: the Autopilot console's scene click follows upstream's rule that the
// card or label painted on top takes the click (src/data/pickRegistry.js
// clickCard). createIntelConsole needs a live viewer and has no harness, so
// this reads the handler's source: it must ask for the card on top before it
// reads the marker under it, and act on its own card.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./intelConsole.js', import.meta.url), 'utf8');

test('the Autopilot click asks for the card on top before the marker under it', () => {
  const start = source.indexOf('inputFor(sceneHost).onClick(');
  assert.ok(start > 0, 'the console clicks through the input dispatcher');
  const handler = source.slice(start, source.indexOf('\n    });', start));
  const card = handler.indexOf('picking?.clickCard?.(event)');
  const marker = handler.indexOf('event.topHit');
  assert.ok(card > 0, 'reads the card on top');
  assert.ok(marker > card, 'before the marker under it');
  // Any card on top returns; only our own card acts (opens its source).
  assert.match(
    handler.slice(card, marker),
    /if \(card\) \{\s*if \(card\.sourceId === CARD_SOURCE\) card\.entry\?\.activate\?\.\(\);\s*return;\s*\}/,
  );
});
