// Fork: on the terrain globe, cable lines are not draped (cableLinesDrape in
// surface.js): they draw as 3D lines at sea level, which costs the GPU far
// less than the ground polylines draping needs. Kept in its own file so
// upstream's cable tests merge without conflicts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { toLonLatH } from '../../geo/ellipsoid.js';
import { fromDegrees } from '../../geo/ellipsoid.js';
import { geoidHeight } from '../../data/geoid.js';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';
import { fakeCameraPort } from '../../testSupport/fakeCameraPort.mjs';
import { fakeSceneFrame } from '../../testSupport/fakeCesiumScene.mjs';
import { createTeleGeographySubmarineCableLayer } from '../../data/telegeographySubmarineCables.js';
import { cableLinesDrape } from './surface.js';

const CABLE = {
  type: 'Feature',
  id: 'ac1',
  properties: { id: 'ac1', name: 'Atlantic Crossing-1' },
  geometry: {
    type: 'LineString',
    coordinates: [
      [-40, 35],
      [-30, 40],
    ],
  },
};
const LANDING = {
  type: 'Feature',
  id: 'lisbon',
  properties: { id: 'lisbon', name: 'Lisbon, Portugal' },
  geometry: { type: 'Point', coordinates: [-9.1, 38.7] },
};
// A landing feature drawn as a line: it keeps its own clampTo ('both').
const LANDING_LINE = {
  type: 'Feature',
  id: 'spur',
  properties: { id: 'spur', name: 'Spur' },
  geometry: {
    type: 'LineString',
    coordinates: [
      [-9.1, 38.7],
      [-9.5, 38.5],
    ],
  },
};

/** A loaded cable layer; `globe` is what the renderer's globe port says. */
async function loaded({ globeVisible, landing = [LANDING] } = {}) {
  const listeners = new Map();
  const layer = createTeleGeographySubmarineCableLayer({
    overlayHost: {
      setVisible() {},
      setEntries() {},
      clearSource() {},
    },
    inputFor: () => ({ onClick: () => () => {} }),
    source: {
      label: 'Fork test source',
      async fetch() {
        return {
          cables: { type: 'FeatureCollection', features: [CABLE] },
          landingPoints: { type: 'FeatureCollection', features: landing },
        };
      },
    },
    mapStackEventTarget: {
      addEventListener: (name, fn) => listeners.set(name, fn),
      removeEventListener: (name) => listeners.delete(name),
    },
    sweepClock: () => 0,
  });
  const viewer = {
    scene: {
      canvas: { clientHeight: 900 },
      requestRender() {},
      preRender: { addEventListener: () => () => {} },
    },
  };
  const camera = fakeCameraPort({
    pose: {
      position: fromDegrees(-40, 35, 4_500_000),
      fovy: Math.PI / 3,
      aspectRatio: 1,
      heading: 0,
    },
  });
  const renderer = { camera: camera.port, frame: fakeSceneFrame(viewer) };
  if (globeVisible !== undefined)
    renderer.globe = { isGlobeVisible: () => globeVisible };
  const { draw } = bindFakeDraw(viewer, renderer);
  layer.init(viewer);
  layer.enable(viewer);
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline && !(layer.getStats().count > 0)) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(layer.getStats().error, null, 'the layer must load');
  const set = (name) =>
    [...draw.sets.values()].find(
      (record) => !record.disposed && record.spec.id.endsWith(`:${name}`),
    );
  const switchStack = (activeId) =>
    listeners.get('gev:map-stack-changed')({ detail: { activeId } });
  return { layer, set, switchStack };
}

const cableLine = (env) =>
  [...env.set('lines').items.values()].find((line) =>
    line.id.startsWith('cable:'),
  );

test('only the terrain globe leaves cable lines undraped', () => {
  assert.equal(cableLinesDrape('terrain'), false);
  assert.equal(cableLinesDrape('tiles'), true);
  assert.equal(cableLinesDrape('both'), true);
  assert.equal(cableLinesDrape(undefined), true);
});

test('on the terrain globe a cable line is a 3D line at sea level', async () => {
  // The first load in this process: the layer itself must wait for the geoid
  // grid (ingestion.js), or the line would be drawn at ellipsoid height 0.
  const env = await loaded({ globeVisible: true });
  assert.equal(env.set('lines').spec.clampTo, 'terrain');
  const line = cableLine(env);
  assert.equal(line.mode, '3d');
  assert.equal(line.clampTo, undefined);
  assert.ok(line.positions.length > 100, 'still densified along the rhumb');
  for (const position of [
    line.positions[0],
    line.positions[Math.floor(line.positions.length / 2)],
    line.positions.at(-1),
  ]) {
    const { lon, lat, height } = toLonLatH(position);
    assert.ok(
      Math.abs(height - geoidHeight(lat, lon)) < 0.01,
      `at sea level: ${height} vs ${geoidHeight(lat, lon)}`,
    );
  }
  // The geoid here is tens of metres off the ellipsoid, so the test sees it.
  assert.ok(Math.abs(geoidHeight(35, -40)) > 5);
  env.layer.destroy();
});

test('photoreal tiles and an unknown surface keep cable lines draped', async () => {
  for (const globeVisible of [false, undefined]) {
    const env = await loaded({ globeVisible });
    const line = cableLine(env);
    assert.equal(line.mode, 'draped', `globe visible: ${globeVisible}`);
    const { height } = toLonLatH(line.positions[0]);
    assert.ok(Math.abs(height) < 1e-6, 'draped lines stay on the ellipsoid');
    env.layer.destroy();
  }
});

test('a line with its own clampTo stays draped on the terrain globe', async () => {
  const env = await loaded({ globeVisible: true, landing: [LANDING_LINE] });
  const spur = [...env.set('lines').items.values()].find((line) =>
    line.id.startsWith('landing-point:'),
  );
  assert.equal(spur.clampTo, 'both');
  assert.equal(spur.mode, 'draped');
  assert.equal(cableLine(env).mode, '3d');
  env.layer.destroy();
});

test('a stack switch redraws the lines only when draping changes', async () => {
  const env = await loaded({ globeVisible: false });
  assert.equal(cableLine(env).mode, 'draped');
  const first = cableLine(env);

  env.switchStack('photoreal'); // tiles -> tiles: nothing to do
  assert.equal(cableLine(env), first, 'same surface, same item');

  env.switchStack('osm'); // tiles -> terrain: undraped
  assert.equal(env.set('lines').spec.clampTo, 'terrain');
  assert.equal(cableLine(env).mode, '3d');
  assert.equal(env.set('lines').items.size, 1, 'replaced, not added');

  const undraped = cableLine(env);
  env.switchStack('osm');
  assert.equal(cableLine(env), undraped, 'no redraw without a change');

  env.switchStack('photoreal'); // terrain -> tiles: draped again
  assert.equal(cableLine(env).mode, 'draped');
  assert.equal(env.set('references').items.size, 2, 'references redrawn once');
  env.layer.destroy();
});

test('a stack switch while the layer is off draws nothing', async () => {
  const env = await loaded({ globeVisible: false });
  env.layer.disable();
  env.switchStack('osm');
  assert.equal(env.set('lines').items.size, 0, 'disabled sets stay empty');
  env.layer.enable();
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline && !(env.set('lines').items.size > 0)) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(cableLine(env).mode, '3d', 're-enabled on the new surface');
  env.layer.destroy();
});

test('cable lines are solid with no outline, so they draw in a batch', async () => {
  // An outlined line draws by its own material (settles() and batchable()
  // in src/render/cesium/draw.js); upstream's dark edges are left out.
  for (const globeVisible of [true, false]) {
    const env = await loaded({ globeVisible });
    const line = cableLine(env);
    assert.equal(line.style.kind, 'solid', `globe visible: ${globeVisible}`);
    assert.equal(
      line.style.outline,
      undefined,
      `globe visible: ${globeVisible}`,
    );
    assert.equal(line.widthPx, 8, 'wide enough to click, as upstream');
    env.layer.destroy();
  }
});
