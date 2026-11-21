/**
 * @module fork/engine
 * @description Fork: the engine for the fork's code still drawn with Cesium
 * directly (the air/sea layers, banking access and the Autopilot console;
 * see src/render/cesiumAllowList.json). Cesium, and the adapter's map from
 * a scene object to its Cesium viewer, load only on the Cesium renderer, so
 * the application on another renderer (the stub, scripts/qa-stub-boot.mjs)
 * never requests a Cesium module.
 *
 * `Cesium` is a live binding: null until {@link loadForkEngine} resolves.
 * The scene phase records the renderer and loads it before any layer or tool
 * exists (src/app/scene.js); on any other renderer the catalog and the tools
 * leave the fork's Cesium code out ({@link forkEngineWanted}). Tests that run
 * that code await {@link loadForkEngine} first.
 */

/**
 * Exported as `Cesium`, but not named so here: the production build's
 * Cesium plugin rewrites `import('cesium')` into a read of the global
 * `Cesium`, which a local binding of that name would shadow (it read null).
 * @type {typeof import('cesium') | null}
 */
let engine = null;
export { engine as Cesium };

/** The catalog layers drawn with Cesium directly (absent on another renderer). */
export const FORK_ENGINE_LAYER_IDS = Object.freeze([
  'air-traffic',
  'sea-traffic',
  'warning-areas',
  'traffic-anomalies',
  'gnss-ship-regions',
  'banking-access',
]);

let behind = null;
let loading = null;
let rendererId = null;

/**
 * Load Cesium and the adapter's viewer map for the fork's code (once).
 * @returns {Promise<typeof import('cesium')>}
 */
export function loadForkEngine() {
  loading ??= Promise.all([
    import('cesium'),
    import('../render/cesium/viewers.js'),
  ]).then(
    ([module, viewers]) => {
      engine = module;
      behind = viewers.viewerBehind;
      return module;
    },
    (error) => {
      // A failed chunk load is retried by the next mount.
      loading = null;
      throw error;
    },
  );
  return loading;
}

/**
 * The Cesium viewer behind the scene object the application hands layers
 * and tools (its renderer's), or `host` itself: a viewer with no renderer
 * bound (tests), or anything before the engine loaded.
 * @param {object|null|undefined} host
 * @returns {object|null|undefined}
 */
export const viewerBehind = (host) => (behind ? behind(host) : host);

/**
 * Record the id of the renderer the application runs on.
 * @param {string|null|undefined} id
 */
export function setForkRenderer(id) {
  rendererId = id ?? null;
}

/**
 * Whether the fork's Cesium-drawn layers and console belong in the app: on
 * the Cesium renderer, or where no renderer was recorded (tests).
 * @returns {boolean}
 */
export const forkEngineWanted = () =>
  rendererId === null || rendererId === 'cesium';

/**
 * Add a primitive to a Cesium viewer's scene (the fork's direct drawing goes
 * through this file), or return null when there is no scene.
 * @param {object|null|undefined} viewer
 * @param {object} primitive
 */
export function addScenePrimitive(viewer, primitive) {
  const primitives = viewer?.scene?.primitives;
  return primitives ? primitives.add(primitive) : null;
}

/**
 * Remove a primitive added with {@link addScenePrimitive}, unless the viewer
 * is gone.
 * @param {object|null|undefined} viewer
 * @param {object|null|undefined} primitive
 */
export function removeScenePrimitive(viewer, primitive) {
  if (!primitive || viewer?.isDestroyed?.()) return;
  viewer?.scene?.primitives?.remove(primitive);
}

/** Ask a Cesium viewer's scene for a frame (it renders on demand). */
export function requestSceneRender(viewer) {
  viewer?.scene?.requestRender?.();
}
