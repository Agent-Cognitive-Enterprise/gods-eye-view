// Fork: the fork's Cesium-drawn layers on the scene object the app hands
// them, and the catalog without them on another renderer (src/fork/engine.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FORK_ENGINE_LAYER_IDS,
  forkEngineWanted,
  loadForkEngine,
  setForkRenderer,
  viewerBehind,
} from './engine.js';
import { createSceneHost } from '../render/rendererOf.js';
import { recordViewer } from '../render/cesium/viewers.js';
import { createApplicationCatalog } from '../app/constructCatalog.js';
import { createSurfaceServices } from '../app/surfaceServices.js';
import { createStandaloneLayerSources } from '../standalone/layerSources.js';
import { createApplicationTrafficDensity } from '../app/layers/airSeaTraffic.js';
import { createApplicationBankingAccess } from '../app/layers/bankingAccess.js';
import { worldClock } from '../time/worldClock.js';

await loadForkEngine();

/** A Cesium viewer double that records what layers add to it. */
function fakeViewer() {
  const added = { primitives: [], dataSources: [], moveEnd: [] };
  return {
    added,
    scene: {
      canvas: { clientWidth: 800, clientHeight: 600 },
      requestRender() {},
      primitives: {
        add: (p) => (added.primitives.push(p), p),
        remove: (p) => added.primitives.splice(added.primitives.indexOf(p), 1),
        contains: (p) => added.primitives.includes(p),
      },
    },
    camera: {
      moveEnd: {
        addEventListener: (fn) => {
          added.moveEnd.push(fn);
          return () => added.moveEnd.splice(added.moveEnd.indexOf(fn), 1);
        },
      },
      positionCartographic: { height: 1e7 },
    },
    dataSources: {
      add: (d) => (added.dataSources.push(d), Promise.resolve(d)),
      remove: (d) => added.dataSources.splice(added.dataSources.indexOf(d), 1),
      contains: (d) => added.dataSources.includes(d),
    },
  };
}

/** The scene object the app hands layers, bound to a renderer with `viewer` behind it. */
function sceneObject(viewer) {
  const renderer = { id: 'cesium' };
  recordViewer(renderer, viewer);
  const scene = createSceneHost(renderer, { container: null });
  return { host: scene.host, release: scene.release };
}

test('viewerBehind maps the scene object to its renderer’s Cesium viewer', () => {
  const viewer = fakeViewer();
  const { host, release } = sceneObject(viewer);
  assert.equal(viewerBehind(host), viewer);
  assert.equal(viewerBehind(viewer), viewer, 'a viewer stays itself');
  release();
});

test('every fork Cesium layer draws on the viewer behind the scene object', () => {
  const viewer = fakeViewer();
  const { host, release } = sceneObject(viewer);
  const never = new Promise(() => {});
  const layers = [
    ...createApplicationTrafficDensity({
      source: {
        getDensity: () => never,
        getFootprint: () => never,
        getWarnings: () => never,
        getAnomalies: () => never,
        getGnssRegions: () => never,
      },
    }),
    createApplicationBankingAccess({ source: { getSnapshot: () => never } }),
  ];
  assert.deepEqual(
    layers.map((layer) => layer.id).sort(),
    [...FORK_ENGINE_LAYER_IDS].sort(),
    'the list the catalog leaves out is these layers',
  );
  for (const layer of layers) layer.init(host);
  // The air/sea layers add their collections; banking adds its data source.
  assert.ok(viewer.added.primitives.length >= 5, 'air/sea collections added');
  assert.equal(viewer.added.dataSources.length, 1, 'banking source added');
  for (const layer of layers) layer.destroy(host);
  assert.equal(viewer.added.primitives.length, 0, 'removed from the viewer');
  release();
});

function surface(signal) {
  return createSurfaceServices({
    terrainSource: { getHeights: async () => [] },
    signal,
    eventTarget: null,
  });
}

test('on another renderer the catalog builds without the fork Cesium layers', (t) => {
  const lifetime = new AbortController();
  t.after(() => {
    lifetime.abort();
    setForkRenderer(null);
    worldClock.goLive();
  });
  setForkRenderer('stub');
  assert.equal(forkEngineWanted(), false);
  const catalog = createApplicationCatalog({
    sources: createStandaloneLayerSources(),
    signal: lifetime.signal,
    surface: surface(lifetime.signal),
  });
  for (const id of FORK_ENGINE_LAYER_IDS) {
    assert.equal(catalog.get(id), undefined, `${id} is absent`);
    assert.ok(!catalog.metadata.some((entry) => entry.id === id));
  }
  assert.equal(catalog.layers.length, 47 - FORK_ENGINE_LAYER_IDS.length);
  assert.equal(typeof catalog.getSourceAvailability, 'function');

  setForkRenderer('cesium');
  const full = createApplicationCatalog({
    sources: createStandaloneLayerSources(),
    signal: lifetime.signal,
    surface: surface(lifetime.signal),
  });
  assert.equal(full.layers.length, 47);
});

test('engine.js binds no local named Cesium (the build reads the global)', async () => {
  // vite-plugin-cesium rewrites import('cesium') into `Promise.resolve(Cesium)`,
  // a read of the global; a local binding named Cesium would shadow it.
  const { readFile } = await import('node:fs/promises');
  const source = (
    await readFile(new URL('./engine.js', import.meta.url), 'utf8')
  )
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(source, /\b(?:let|const|var|function|class)\s+Cesium\b/);
  assert.doesNotMatch(source, /(?:^|[^.\w$])Cesium\s*=(?!=)/m);
});
