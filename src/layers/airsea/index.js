import * as Cesium from 'cesium';
import { formatNumber, msg, t } from '../../i18n/index.js';
import { translateFeedError } from '../../ui/statusText.js';
import { resolutionForHeight } from '../../airsea/aggregate.js';
import { sectorRing } from '../../airsea/cellShare.js';
export { createAirSeaSource } from './source.js';

/**
 * Air and sea traffic layers (fork feature): where aircraft (blue) and
 * vessels (green) are concentrated, as translucent H3 cells counted on the
 * server from the app's existing feeds. Each row can also show the existing
 * individual-object layer (flights / AIS vessels) instead of, or with, the
 * density. Hiding a row only hides drawing: the server keeps collecting.
 * With a shared `share` (cellShare.js), a hexagon that air, sea and a
 * warning area all reach is split into halves or thirds, one per layer.
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
const W = (id, ms, label) => Object.freeze({ id, ms, label });
const W15M = W('15m', 15 * 60_000, msg('15 MIN'));
const W1H = W('1h', 3600_000, msg('1 H'));
const W6H = W('6h', 6 * 3600_000, msg('6 H'));
const W12H = W('12h', 12 * 3600_000, msg('12 H'));
const W24H = W('24h', 24 * 3600_000, msg('24 H'));
const W72H = W('72h', 72 * 3600_000, msg('72 H'));
/**
 * Two views: TRAFFIC is the movement footprint (passages through each cell
 * in the window, along each track); NOW is where objects are at present.
 */
export const TRAFFIC_VIEWS = Object.freeze({
  traffic: Object.freeze({
    air: Object.freeze({
      windows: [W15M, W1H, W6H, W12H, W24H],
      default: W12H,
    }),
    sea: Object.freeze({ windows: [W1H, W6H, W24H, W72H], default: W24H }),
  }),
  now: Object.freeze({
    air: Object.freeze({ windows: [W15M, W1H], default: W15M }),
    sea: Object.freeze({ windows: [W15M, W1H], default: W1H }),
  }),
});
export const TRAFFIC_WINDOWS = Object.freeze([W15M, W1H, W6H, W24H]);
// Footprint grids stored by the server: coarse for the globe, finer close.
// Sea also has the air grids, so both can share hexagons when both show.
const FOOTPRINT_RESOLUTIONS = Object.freeze({ air: [2, 3], sea: [2, 4] });
const SHARED_FINE_RESOLUTION = 3;
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
 *   now?: () => number, share?: object|null}} options
 */
export function createTrafficDensityLayer({
  domain,
  source,
  storage = defaultStorage(),
  now = () => Date.now(),
  share = null,
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
  let _removeShareListener = null;
  let _mode = MODES.includes(read('mode')) ? read('mode') : 'density';
  let _view = read('view') === 'now' ? 'now' : 'traffic';
  const windowFor = (view) => {
    const options = TRAFFIC_VIEWS[view][domain];
    return (
      options.windows.find((w) => w.id === read(`window.${view}`)) ??
      options.default
    );
  };
  let _window = windowFor(_view);
  const resolutionFor = (height) => {
    if (_view === 'now') return resolutionForHeight(height);
    const [coarse, fine] = FOOTPRINT_RESOLUTIONS[domain];
    if (height >= 3_000_000 || !(height > 0)) return coarse;
    // Close in, sea joins the air grid while air density is on screen.
    const other = share?.resolutionOf(domain === 'air' ? 'sea' : 'air');
    return domain === 'sea' && other === SHARED_FINE_RESOLUTION
      ? SHARED_FINE_RESOLUTION
      : fine;
  };

  /** Tell the other layers which cells this one draws (none when hidden). */
  function publishShare() {
    share?.publishTraffic(
      domain,
      showDensity() && _result ? _result.cells : [],
      _result?.resolution ?? null,
    );
  }

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
    publishShare();
    void applyObjects();
    if (showDensity()) void refresh();
    notifyRow();
  }

  function setWindow(id) {
    const next = TRAFFIC_VIEWS[_view][domain].windows.find((w) => w.id === id);
    if (!next || next === _window) return;
    _window = next;
    write(`window.${_view}`, id);
    void refresh();
    notifyRow();
  }

  function setView(view) {
    if (view === _view || !TRAFFIC_VIEWS[view]) return;
    _view = view;
    write('view', view);
    _window = windowFor(view);
    _result = null;
    publishShare();
    void refresh();
    notifyRow();
  }

  async function refresh() {
    if (_manager) await _manager.refreshLayer?.(layer.id);
    else await layer.update();
  }

  function render() {
    const cells = _result?.cells ?? [];
    // TRAFFIC shades passages per area; NOW shades objects per area.
    const valueOf = (c) => c.passagesPer10kKm2 ?? c.densityPer10kKm2;
    // Slot and count of this layer's slice in each shared hexagon.
    const slices = cells.map((c) => {
      const owners = share?.shares(c.h3, c.ring).owners ?? [domain];
      return [Math.max(0, owners.indexOf(domain)), owners.length];
    });
    const signature = `${_result?.resolution}|${cells
      .map((c, i) => `${c.h3}:${c.passages ?? c.uniqueCount}:${slices[i]}`)
      .join(',')}`;
    if (signature === _signature) return;
    _signature = signature;
    _primitives.removeAll();
    if (cells.length) {
      const max = Math.max(...cells.map(valueOf));
      const base = Cesium.Color.fromCssColorString(spec.color);
      _primitives.add(
        new Cesium.Primitive({
          geometryInstances: cells.map(
            (cell, i) =>
              new Cesium.GeometryInstance({
                id: `${layer.id}:${cell.h3}`,
                geometry: new Cesium.PolygonGeometry({
                  polygonHierarchy: new Cesium.PolygonHierarchy(
                    Cesium.Cartesian3.fromDegreesArray(
                      sectorRing(cell.ring, ...slices[i]).flat(),
                    ),
                  ),
                  height: spec.height,
                  vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
                }),
                attributes: {
                  color: Cesium.ColorGeometryInstanceAttribute.fromColor(
                    base.withAlpha(cellAlpha(valueOf(cell), max)),
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
      const resolution = resolutionFor(
        _viewer?.camera?.positionCartographic?.height,
      );
      if (
        resolution !== _result?.resolution ||
        (_view === 'now' && resolution >= 4)
      )
        void refresh();
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
      // Another layer changed what shares these hexagons: re-slice, or
      // move to the shared grid first when that changed.
      _removeShareListener =
        share?.subscribe(() => {
          if (!showDensity() || !_result) return;
          const wanted = resolutionFor(
            _viewer?.camera?.positionCartographic?.height,
          );
          if (_view === 'traffic' && wanted !== _result.resolution)
            void refresh();
          else render();
        }) ?? null;
    },

    enable() {
      _enabled = true;
      write('enabled', '1');
      if (_primitives) _primitives.show = showDensity();
      publishShare();
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
      publishShare();
      void applyObjects();
    },

    async update(_viewerArg, { signal } = {}) {
      if (!_enabled || !_primitives || signal?.aborted) return false;
      if (!showDensity()) return true;
      const resolution = resolutionFor(
        _viewer?.camera?.positionCartographic?.height,
      );
      const box = _view === 'now' && resolution >= 4 ? viewBox(_viewer) : null;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      const onAbort = () => request.abort(signal.reason);
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const result =
          _view === 'traffic'
            ? await source.getFootprint(
                { domain, resolution, windowMs: _window.ms },
                { signal: request.signal },
              )
            : await source.getDensity(
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
        publishShare();
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
      _removeShareListener?.();
      _removeShareListener = null;
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
      const since = _result?.history_since;
      const trafficInfo =
        _view === 'traffic' && _result
          ? [
              t(COVERAGE_TEXT[coverage?.level] ?? COVERAGE_TEXT.none),
              t('{passages} passages through {cells} cells', {
                passages: formatNumber(_result.passages ?? 0),
                cells: formatNumber(cells),
              }),
              since
                ? t('history since {time}', {
                    time: `${new Date(since).toISOString().slice(0, 16).replace('T', ' ')}Z`,
                  })
                : t('no history yet'),
              _result.partial_window
                ? t('the window reaches back before history began')
                : null,
            ]
              .filter(Boolean)
              .join(' · ')
          : null;
      const info = _lastError
        ? translateFeedError(_lastError)
        : !_result
          ? t('Loading…')
          : (trafficInfo ??
            [
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
              .join(' · '));
      return {
        chips: [
          ...['traffic', 'now'].map((view) => ({
            id: `view-${view}`,
            label: view === 'traffic' ? t('TRAFFIC') : t('NOW'),
            active: _view === view,
            title:
              view === 'traffic'
                ? t(
                    'Passages through each cell along every track in the window',
                  )
                : t('Where objects are at present'),
            onClick: () => setView(view),
          })),
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
          ...TRAFFIC_VIEWS[_view][domain].windows.map((w) => ({
            id: `window-${w.id}`,
            label: t(w.label),
            active: _window === w,
            disabled: _mode === 'objects',
            title:
              _view === 'traffic'
                ? t('Passages counted along each track over this window')
                : t(
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
        view: _view,
        windowMs: _window.ms,
        fallback: false,
      };
    },
  };
  return layer;
}
