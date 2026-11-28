// Fork: the fork's Cesium-drawn layers keep upstream's layer panel interface
// (CONTRIBUTING.md, "The layer panel interface"). Upstream's own check,
// src/data/layerPanelContract.test.mjs, runs on the stub renderer, where the
// app leaves these layers out, so they are held to the interface here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LayerLifecycle } from '../data/lifecycle.js';
import { createApplicationTrafficDensity } from '../app/layers/airSeaTraffic.js';
import { createApplicationBankingAccess } from '../app/layers/bankingAccess.js';
import { createBankingAccessLayer } from '../layers/bankingAccess/index.js';
import { createStandaloneLayerSources } from '../standalone/layerSources.js';
import { loadForkEngine } from './engine.js';

const MODULES = [
  '../layers/airsea/index.js',
  '../layers/airsea/anomalies.js',
  '../layers/airsea/gnssRegions.js',
  '../layers/airsea/warnings.js',
  '../layers/bankingAccess/index.js',
];

test('every fork layer registers, with the panel handle and no row listener', () => {
  const sources = createStandaloneLayerSources();
  const layers = [
    ...createApplicationTrafficDensity({ source: sources['air-sea'] }),
    createApplicationBankingAccess({ source: sources['banking-access'] }),
  ];
  assert.deepEqual(
    layers.map(({ id }) => id),
    [
      'air-traffic',
      'sea-traffic',
      'warning-areas',
      'traffic-anomalies',
      'gnss-ship-regions',
      'banking-access',
    ],
  );
  // The manager refuses a layer that still defines setRowControlsListener.
  const lifecycle = new LayerLifecycle({}, {});
  for (const layer of layers) lifecycle.register(layer);
  for (const layer of layers) {
    assert.equal(layer.setRowControlsListener, undefined, layer.id);
    const { panel } = lifecycle.layers.get(layer.id);
    assert.equal(typeof panel?.invalidate, 'function', layer.id);
  }
});

test('each fork layer tells the panel through the handle its init receives', () => {
  for (const path of MODULES) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /_rowListener|setRowControlsListener/, path);
    assert.match(
      source,
      /const notifyRow = \(\) => _panel\?\.invalidate\(\);/,
      path,
    );
    assert.match(
      source,
      /init\(viewer, \{ panel = null \} = \{\}\) \{\n\s+_panel = panel;/,
      path,
    );
    assert.match(source, /destroy\([^)]*\) \{[\s\S]*?_panel = null;/, path);
  }
});

test('Banking Access invalidates its row when an update settles', async () => {
  // The layer draws with Cesium through the fork engine.
  await loadForkEngine();
  let invalidations = 0;
  const panel = Object.freeze({ invalidate: () => invalidations++ });
  const layer = createBankingAccessLayer({
    source: {
      getSnapshot: async () => {
        throw new Error('offline');
      },
    },
    loadCountries: async () => ({ countries: [] }),
    overlayHost: {
      setEntries() {},
      setVisible() {},
      clearSource() {},
      hitTest: () => null,
    },
  });
  const viewer = {
    dataSources: { add() {}, remove() {} },
    scene: { requestRender() {} },
    camera: { flyTo() {} },
  };
  layer.init(viewer, { panel });
  layer.enable();
  await layer.update(viewer);
  assert.ok(invalidations >= 1, 'the failed load reached the panel');
  layer.destroy(viewer);
});
