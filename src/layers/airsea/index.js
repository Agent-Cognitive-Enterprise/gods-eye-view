import * as Cesium from 'cesium';
import { formatNumber, msg, t } from '../../i18n/index.js';
import { translateFeedError } from '../../ui/statusText.js';
import { resolutionForHeight } from '../../airsea/aggregate.js';
export { createAirSeaSource } from './source.js';

/**
 * Air and sea traffic layers (fork feature): where aircraft (blue) and
 * vessels (green) are concentrated, as translucent H3 cells counted on the
 * server from the app's existing feeds. Each row can also show the existing
 * individual-object layer (flights / AIS vessels) instead of, or with, the
 * density. Hiding a row only hides drawing: the server keeps collecting.
 *
 * Local-only layers (no share-link token); on/off, display mode and time
 * window are remembered per browser.
 */

export const TRAFFIC_LAYERS = Object.freeze({
  air: Object.freeze({
    id: 'air-traffic',
    name: 'Air Traffic',
    icon: '✈️',
    color: '#7cc4ff',
    objectsLayerId: 'flights',
    // Drawn above high terrain so cells are not swallowed by mountains.
    height: 3_000,
    objects: msg('AIRCRAFT'),
  }),
  sea: Object.freeze({
    id: 'sea-traffic',
    name: 'Sea Traffic',
    icon: '🚢',
    color: '#34d17a',
    objectsLayerId: 'ais-live-vessels',
    height: 0,
    objects: msg('VESSELS'),
  }),
});
export const TRAFFIC_WINDOWS = Object.freeze([
  Object.freeze({ id: '15m', ms: 15 * 60_000, label: msg('15 MIN') }),
  Object.freeze({ id: '1h', ms: 3600_000, label: msg('1 H') }),
  Object.freeze({ id: '6h', ms: 6 * 3600_000, label: msg('6 H') }),
  Object.freeze({ id: '24h', ms: 24 * 3600_000, label: msg('24 H') }),
]);
const MODES = Object.freeze(['density', 'objects', 'both']);
// Brighter than the spec's 0.12-0.35 start: blue over blue ocean imagery
// disappeared at that range.
const MIN_ALPHA = 0.18;
const MAX_ALPHA = 0.55;
const COVERAGE_TEXT = Object.freeze({
  global: msg('Global coverage'),
  partial: msg('Partial coverage (regional or military feeds only)'),
  none: msg('No coverage'),
});
const REASON_TEXT = Object.freeze({
  not_configured: msg('the feed is not configured'),
  feeds_stale_or_down: msg('no recent data from the feeds'),
  only_regional_or_military_feeds: msg('only regional or military feeds'),
});
const STATUS_TEXT = Object.freeze({
  healthy: msg('live'),
  degraded: msg('degraded'),
  stale: msg('stale'),
  down: msg('down'),
  unconfigured: msg('not configured'),
  permission_required: msg('permission required'),
  trial: msg('trial'),
});
const SOURCE_NAMES = Object.freeze({
  opensky: 'OpenSky',
  'adsblol-regional': 'adsb.lol regional',
  'adsblol-mil': 'adsb.lol military',
  aisstream: 'AISStream',
});
export const AIR_SEA_DISCLAIMER = msg(
  'For situational awareness only. Not for aviation or maritime navigation. Data may be delayed, incomplete or inaccurate. An empty area means no reports, not no traffic.',
);

function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Opacity for a cell: log-scaled against the densest cell in view. */
export function cellAlpha(density, maxDensity) {
  if (!(density > 0) || !(maxDensity > 0)) return MIN_ALPHA;
  const share = Math.log1p(density) / Math.log1p(maxDensity);
  return MIN_ALPHA + (MAX_ALPHA - MIN_ALPHA) * Math.min(1, share);
}

/** The camera view as [west, south, east, north], or null for the globe. */
function viewBox(viewer) {
  const rect = viewer?.camera?.computeViewRectangle?.(
    viewer.scene?.globe?.ellipsoid,
  );
  if (!rect) return null;
  const deg = Cesium.Math.toDegrees;
  return [deg(rect.west), deg(rect.south), deg(rect.east), deg(rect.north)];
}

/**
 * @param {{domain: 'air'|'sea', source: object, storage?: Storage|null,
 *   now?: () => number}} options
 */
export function createTrafficDensityLayer({
  domain,
  source,
  storage = defaultStorage(),
  now = () => Date.now(),
}) {
  const spec = TRAFFIC_LAYERS[domain];
  if (!spec) throw new TypeError(`Unknown traffic domain: ${domain}`);
  if (typeof source?.getDensity !== 'function')
    throw new TypeError('Traffic layer requires a density source');
  const key = (name) => `gev.airsea.${spec.id}.${name}`;
  const read = (name, fallback) => {
    try {
      return storage?.getItem(key(name)) ?? fallback;
    } catch {
      return fallback;
    }
  };
  const write = (name, value) => {
    try {
      storage?.setItem(key(name), String(value));
    } catch {
      // Not remembered; the layer still works.
    }
  };

  let _viewer = null;
  let _primitives = null;
  let _manager = null;
  let _enabled = false;
  let _request = null;
  let _result = null;
  let _signature = null;
  let _lastUpdate = null;
  let _lastError = null;
  let _rowListener = null;
  let _removeMoveEnd = null;
  let _cameraTimer = null;
  let _restoreTimer = null;
  // Whether this row switched the individual-object layer on (and so may
  // switch it off again); a layer the user enabled themselves is left alone.
  let _ownsObjects = false;
  let _removeVisibilityListener = null;
  let _mode = MODES.includes(read('mode')) ? read('mode') : 'density';
  let _window =
    TRAFFIC_WINDOWS.find((w) => w.id === read('window')) ?? TRAFFIC_WINDOWS[1];

  const notifyRow = () => _rowListener?.();
  const showDensity = () => _enabled && _mode !== 'objects';

  // Changes to the object layer run one at a time and re-read the wanted
  // state after each await, so quick mode switches cannot leave it on.
  let _objectsChain = Promise.resolve();
  let _selfRequest = false;
  function applyObjects() {
    _objectsChain = _objectsChain
      .catch(() => {})
      .then(async () => {
        if (!_manager) return;
        const want = _enabled && _mode !== 'density';
        const on = _manager.isEnabled?.(spec.objectsLayerId) === true;
        if (want === on) return;
        if (!want && !_ownsObjects) return; // the user's own layer
        _selfRequest = true;
        let pending;
        try {
          pending = _manager.setEnabled(spec.objectsLayerId, want);
        } finally {
          _selfRequest = false;
        }
        _ownsObjects = want;
        await pending;
      });
    return _objectsChain;
  }

  function setMode(mode) {
    if (!MODES.includes(mode) || mode === _mode) return;
    _mode = mode;
    write('mode', mode);
    if (_primitives) _primitives.show = showDensity();
    void applyObjects();
    if (showDensity()) void refresh();
    notifyRow();
  }

  function setWindow(id) {
    const next = TRAFFIC_WINDOWS.find((w) => w.id === id);
    if (!next || next === _window) return;
    _window = next;
    write('window', id);
    void refresh();
    notifyRow();
  }

  async function refresh() {
    if (_manager) await _manager.refreshLayer?.(layer.id);
    else await layer.update();
  }

  function render() {
    const cells = _result?.cells ?? [];
    const signature = `${_result?.resolution}|${cells
      .map((c) => `${c.h3}:${c.uniqueCount}`)
      .join(',')}`;
    if (signature === _signature) return;
    _signature = signature;
    _primitives.removeAll();
    if (cells.length) {
      const max = Math.max(...cells.map((c) => c.densityPer10kKm2));
      const base = Cesium.Color.fromCssColorString(spec.color);
      _primitives.add(
        new Cesium.Primitive({
          geometryInstances: cells.map(
            (cell) =>
              new Cesium.GeometryInstance({
                id: `${layer.id}:${cell.h3}`,
                geometry: new Cesium.PolygonGeometry({
                  polygonHierarchy: new Cesium.PolygonHierarchy(
                    Cesium.Cartesian3.fromDegreesArray(cell.ring.flat()),
                  ),
                  height: spec.height,
                  vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
                }),
                attributes: {
                  color: Cesium.ColorGeometryInstanceAttribute.fromColor(
                    base.withAlpha(cellAlpha(cell.densityPer10kKm2, max)),
                  ),
                },
              }),
          ),
          appearance: new Cesium.PerInstanceColorAppearance({
            flat: true,
            translucent: true,
          }),
          allowPicking: false,
        }),
      );
    }
    _viewer?.scene?.requestRender?.();
  }

  function scheduleCameraRefresh() {
    if (!showDensity()) return;
    clearTimeout(_cameraTimer);
    // Resolution and view box follow the camera, debounced.
    _cameraTimer = setTimeout(() => {
      _cameraTimer = null;
      const resolution = resolutionForHeight(
        _viewer?.camera?.positionCartographic?.height,
      );
      if (resolution !== _result?.resolution || resolution >= 4) void refresh();
    }, 1200);
  }

  /** Re-enable after a reload when this browser left the layer on. */
  function scheduleRestore() {
    if (read('enabled') !== '1' || !_manager) return;
    let tries = 0;
    const attempt = () => {
      _restoreTimer = null;
      if (_enabled || !_manager) return;
      if (_manager.viewer && _manager.registrationsFinalized !== false) {
        void _manager.setEnabled(layer.id, true);
        return;
      }
      if (++tries < 60) _restoreTimer = setTimeout(attempt, 500);
    };
    _restoreTimer = setTimeout(attempt, 1500);
  }

  const layer = {
    id: spec.id,
    name: spec.name,
    icon: spec.icon,
    source: domain === 'air' ? 'OpenSky / adsb.lol' : 'AISStream',
    updateInterval: 60_000,

    attachDataManager(manager) {
      _manager = manager;
      // Switching the object layer by hand makes it the user's again: this
      // row never switches it off afterwards.
      _removeVisibilityListener = manager.subscribeVisibilityRequests?.(
        (change) => {
          if (change?.layerId === spec.objectsLayerId && !_selfRequest)
            _ownsObjects = false;
        },
      );
      scheduleRestore();
    },

    setRowControlsListener(listener) {
      _rowListener = listener;
    },

    init(viewer) {
      if (_viewer) throw new Error(`${spec.id} layer is already initialized`);
      _viewer = viewer;
      _primitives = new Cesium.PrimitiveCollection();
      _primitives.show = false;
      viewer.scene.primitives.add(_primitives);
      _removeMoveEnd = viewer.camera?.moveEnd?.addEventListener(
        scheduleCameraRefresh,
      );
    },

    enable() {
      _enabled = true;
      write('enabled', '1');
      if (_primitives) _primitives.show = showDensity();
      void applyObjects();
    },

    disable() {
      clearTimeout(_cameraTimer);
      _cameraTimer = null;
      _request?.abort();
      _request = null;
      _enabled = false;
      write('enabled', '0');
      if (_primitives) _primitives.show = false;
      void applyObjects();
    },

    async update(_viewerArg, { signal } = {}) {
      if (!_enabled || !_primitives || signal?.aborted) return false;
      if (!showDensity()) return true;
      const resolution = resolutionForHeight(
        _viewer?.camera?.positionCartographic?.height,
      );
      const box = resolution >= 4 ? viewBox(_viewer) : null;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      const onAbort = () => request.abort(signal.reason);
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const result = await source.getDensity(
          {
            domain,
            // Close views without a box fall back to the coarser grid.
            resolution: resolution >= 4 && !box ? 3 : resolution,
            windowMs: _window.ms,
            box,
          },
          { signal: request.signal },
        );
        if (request.signal.aborted || !_enabled) return false;
        _result = result;
        _lastUpdate = now();
        _lastError = null;
        render();
        notifyRow();
        return true;
      } catch (error) {
        if (request.signal.aborted || !_enabled) return false;
        _lastError = error?.message || msg('Air/sea density unavailable');
        notifyRow();
        // The drawing stays; the manager keeps its refresh cadence.
        return error?.retryable !== false;
      } finally {
        signal?.removeEventListener('abort', onAbort);
        if (_request === request) _request = null;
      }
    },

    destroy(viewer = _viewer) {
      layer.disable();
      clearTimeout(_restoreTimer);
      _removeVisibilityListener?.();
      _removeVisibilityListener = null;
      _removeMoveEnd?.();
      _removeMoveEnd = null;
      if (_primitives) {
        viewer?.scene?.primitives?.remove(_primitives);
        _primitives = null;
      }
      _viewer = null;
      _manager = null;
      _result = null;
      _signature = null;
      _rowListener = null;
    },

    getRowControls() {
      const coverage = _result?.coverage;
      const cells = _result?.cells?.length ?? 0;
      const sources = Object.entries(_result?.sources ?? {})
        .filter(([, s]) => s.status !== 'unconfigured' || domain === 'sea')
        .map(
          ([id, s]) =>
            `${SOURCE_NAMES[id] ?? id} ${t(STATUS_TEXT[s.status] ?? msg('unknown'))}`,
        )
        .join(' · ');
      const info = _lastError
        ? translateFeedError(_lastError)
        : !_result
          ? t('Loading…')
          : [
              t(COVERAGE_TEXT[coverage?.level] ?? COVERAGE_TEXT.none) +
                (coverage?.reason
                  ? `: ${t(REASON_TEXT[coverage.reason] ?? coverage.reason)}`
                  : ''),
              t('{objects} in {cells} cells', {
                objects: formatNumber(_result.drawn ?? _result.total),
                cells: formatNumber(cells),
              }),
              _result.total > (_result.drawn ?? _result.total)
                ? t('{count} not drawn (polar or beyond the cell limit)', {
                    count: formatNumber(_result.total - _result.drawn),
                  })
                : null,
              _result.collection_ms && _window.ms < _result.collection_ms
                ? t('collected every {minutes} min: this window may be empty', {
                    minutes: formatNumber(_result.collection_ms / 60_000),
                  })
                : null,
              sources,
            ]
              .filter(Boolean)
              .join(' · ');
      return {
        chips: [
          ...MODES.map((mode) => ({
            id: `mode-${mode}`,
            label:
              mode === 'density'
                ? t('DENSITY')
                : mode === 'objects'
                  ? t(spec.objects)
                  : t('BOTH'),
            active: _mode === mode,
            onClick: () => setMode(mode),
          })),
          ...TRAFFIC_WINDOWS.map((w) => ({
            id: `window-${w.id}`,
            label: t(w.label),
            active: _window === w,
            disabled: _mode === 'objects',
            title: t(
              'Count each object once, at its latest position in this window',
            ),
            onClick: () => setWindow(w.id),
          })),
        ],
        info,
        infoTitle: t(AIR_SEA_DISCLAIMER),
        legend: [
          {
            label: t('Fewer'),
            color: Cesium.Color.fromCssColorString(spec.color)
              .withAlpha(MIN_ALPHA * 2)
              .toCssColorString(),
          },
          {
            label: t('More (per area)'),
            color: spec.color,
            blurb: t(AIR_SEA_DISCLAIMER),
          },
        ],
      };
    },

    getStats() {
      return {
        count: _result?.cells?.length ?? 0,
        objects: _result?.total ?? 0,
        lastUpdate: _lastUpdate,
        error: _lastError,
        coverage: _result?.coverage ?? null,
        mode: _mode,
        windowMs: _window.ms,
        fallback: false,
      };
    },
  };
  return layer;
}
