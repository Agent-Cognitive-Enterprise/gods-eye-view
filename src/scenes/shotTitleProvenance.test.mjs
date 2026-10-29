// Reproduction: a user-authored shot whose typed title equals a legacy base
// title of the Nepal pack must stay as typed in an upgraded scene.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SCENE_APPEND_RECIPES, displayShotTitle } from './recipes.js';
import { setLocale } from '../i18n/index.js';

test.afterEach(() => setLocale('en'));

test('a user shot named like a legacy base shot stays as typed in an upgraded scene', () => {
  const pack = SCENE_APPEND_RECIPES.find(
    (recipe) => recipe.legacySceneBootstrap?.cameraPath?.length,
  );
  assert.ok(pack, 'Nepal append pack with legacy bootstrap');
  const baseTitles = pack.legacySceneBootstrap.cameraPath.map((k) => k.title);
  // Shape written by SceneDirector._bootstrapLegacyShotPacks + appendShotPack:
  // base shots without sourcePackId, pack shots with it, marker bindings.
  const base = baseTitles.map((title, i) => ({ id: `base-${i}`, title }));
  const packShot = {
    id: 'pack-0',
    title: 'Upper Valley Collapse',
    sourcePackId: pack.id,
  };
  // Captured by captureShot ("Shot 10"), then renamed by the user.
  const userShot = { id: 'user-1', title: 'Bhote Koshi Flood Path' };
  const scene = {
    id: 'scene-user-upgraded',
    shots: [...base, packShot, userShot],
    appliedShotPacks: [
      {
        id: pack.id,
        version: Number(pack.version) || 1,
        shotBindings: Object.fromEntries(base.map((s) => [s.title, s.id])),
      },
    ],
  };
  for (const locale of ['de', 'ru', 'es']) {
    setLocale(locale);
    // The real base shot localizes (intended by the branch).
    assert.notEqual(
      displayShotTitle(base[5].title, base[5], scene),
      base[5].title,
    );
    // The user's shot must stay as typed.
    assert.equal(
      displayShotTitle(userShot.title, userShot, scene),
      userShot.title,
      `${locale}: user-typed title was translated`,
    );
  }
});
