// A user-made shot (no sourcePackId) typed as a legacy bootstrap title keeps
// its text even though its scene carries the evidence-pack marker.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SCENE_APPEND_RECIPES, displayShotTitle } from './recipes.js';
import { setLocale } from '../i18n/index.js';

test.afterEach(() => setLocale('en'));

test('a new user shot typed as a bootstrap title keeps its text in a pack scene', () => {
  setLocale('ru');
  const pack = SCENE_APPEND_RECIPES.find(
    (recipe) => recipe.legacySceneBootstrap?.cameraPath?.length,
  );
  assert.ok(pack);
  const title = 'Global Incident Context';
  const scene = {
    id: 'bhote-koshi-nepal-scene',
    appliedShotPacks: [
      {
        id: pack.id,
        version: pack.version,
        // The bootstrap binds this title to the original base shot.
        shotBindings: { [title]: 'legacy-base-1' },
      },
    ],
  };
  const userShot = { id: 'shot-user-new', title }; // no sourcePackId
  assert.equal(displayShotTitle(title, userShot, scene), title);
});
