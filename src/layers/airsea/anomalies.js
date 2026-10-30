import * as Cesium from 'cesium';
import { formatNumber, msg, t } from '../../i18n/index.js';
import { translateFeedError } from '../../ui/statusText.js';

/**
 * Traffic Anomalies layer (fork feature): cells where the last complete hour
 * of passages differs strongly from the same hour of the week in earlier
 * weeks. Purple: possible suppression; yellow: possible increase. Nothing
 * is shown while the baseline is too short or the feed itself was not
 * delivered in full; the row says which. Local-only; remembered per browser.
 */
export const ANOMALY_LAYER_ID = 'traffic-anomalies';
const DOMAINS = Object.freeze([
  Object.freeze({ id: 'air', label: msg('AIR') }),
  Object.freeze({ id: 'sea', label: msg('SEA') }),
]);
const COLORS = Object.freeze({
  possible_traffic_suppression: '#b36bff',
  possible_traffic_increase: '#ffd23f',
});
const STATUS_TEXT = Object.freeze({
  ok: msg('compared with earlier weeks'),
  baseline_insufficient: msg('baseline insufficient'),
  coverage_degraded: msg('coverage degraded: inconclusive'),
});
const CONFIDENCE_TEXT = Object.freeze({
  high: msg('high'),
  medium: msg('medium'),
  low: msg('low'),
});
export const ANOMALY_DISCLAIMER = msg(
  'Compares the last complete hour with the same hour of the week in up to four earlier weeks. A change is not a cause: it can follow weather, schedules or events. When the feed itself delivered too little, nothing is reported.',
);

function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
const day = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : '—');

/** @param {{source: object, storage?: Storage|null}} options */
export function createTrafficAnomaliesLayer({
  source,
  storage = defaultStorage(),
}) {
  if (typeof source?.getAnomalies !== 'function')
    throw new TypeError('Traffic anomalies layer requires an anomalies source');
  const key = (name) => `gev.airsea.${ANOMALY_LAYER_ID}.${name}`;
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
      // not remembered
    }
  };

  let _viewer = null;
  let _primitives = null;
  let _manager = null;
  let _enabled = false;
  let _results = {}; // domain -> anomalies answer
  let _lastError = null;
  let _lastUpdate = null;
  let _rowListener = null;
  let _restoreTimer = null;
  let _signature = null;
  const _domains = new Set(
    (read('domains', 'air,sea') || '')
      .split(',')
      .filter((d) => d === 'air' || d === 'sea'),
  );
  const notifyRow = () => _rowListener?.();

  function render() {
    if (!_primitives) return;
    const cells = [..._domains].flatMap((d) => _results[d]?.cells ?? []);
    const signature = JSON.stringify(cells.map((c) => [c.h3, c.observation]));
    if (signature === _signature) return;
    _signature = signature;
    _primitives.removeAll();
    if (cells.length)
      _primitives.add(
        new Cesium.Primitive({
          geometryInstances: cells.map(
            (cell) =>
              new Cesium.GeometryInstance({
                geometry: new Cesium.PolygonGeometry({
                  polygonHierarchy: new Cesium.PolygonHierarchy(
                    Cesium.Cartesian3.fromDegreesArray(cell.ring.flat()),
                  ),
                  height: 4_000,
                  vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
                }),
                attributes: {
                  color: Cesium.ColorGeometryInstanceAttribute.fromColor(
                    Cesium.Color.fromCssColorString(
                      COLORS[cell.observation],
                    ).withAlpha(
                      Math.min(0.6, 0.25 + Math.abs(cell.changePct) / 300),
                    ),
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
    _viewer?.scene?.requestRender?.();
  }

  function scheduleRestore() {
    if (read('enabled', '0') !== '1' || !_manager) return;
    let tries = 0;
    const attempt = () => {
      _restoreTimer = null;
      if (_enabled || !_manager) return;
      if (_manager.viewer) {
        void _manager.setEnabled(ANOMALY_LAYER_ID, true);
        return;
      }
      if (++tries < 60) _restoreTimer = setTimeout(attempt, 500);
    };
    _restoreTimer = setTimeout(attempt, 1500);
  }

  function domainLine(d) {
    const result = _results[d];
    const label = t(DOMAINS.find((x) => x.id === d).label);
    if (!result) return `${label}: ${t('Loading…')}`;
    const status = t(STATUS_TEXT[result.status] ?? msg('unknown'));
    if (result.status === 'baseline_insufficient')
      return `${label}: ${status} (${t(
        'history since {since}; comparisons from {from}',
        {
          since: day(result.history_since),
          from: day(result.baseline_possible_from),
        },
      )})`;
    if (result.status === 'ok')
      return `${label}: ${t('{count} anomalous cells', {
        count: formatNumber(result.cells.length),
      })} · ${status} (${result.weeksUsed})`;
    return `${label}: ${status}`;
  }

  const layer = {
    id: ANOMALY_LAYER_ID,
    name: 'Traffic Anomalies',
    icon: '📉',
    source: 'Air & Sea history',
    updateInterval: 5 * 60_000,

    attachDataManager(manager) {
      _manager = manager;
      scheduleRestore();
    },
    setRowControlsListener(listener) {
      _rowListener = listener;
    },
    init(viewer) {
      _viewer = viewer;
      _primitives = new Cesium.PrimitiveCollection();
      _primitives.show = false;
      viewer.scene.primitives.add(_primitives);
    },
    enable() {
      _enabled = true;
      write('enabled', '1');
      if (_primitives) _primitives.show = true;
    },
    disable() {
      _enabled = false;
      write('enabled', '0');
      if (_primitives) _primitives.show = false;
    },
    async update(_viewerArg, { signal } = {}) {
      if (!_enabled || signal?.aborted) return false;
      try {
        const answers = await Promise.all(
          DOMAINS.map((d) => source.getAnomalies({ domain: d.id }, { signal })),
        );
        if (!_enabled) return false;
        _results = Object.fromEntries(
          DOMAINS.map((d, i) => [d.id, answers[i]]),
        );
        _lastError = null;
        _lastUpdate = Date.now();
        render();
        notifyRow();
        return true;
      } catch (error) {
        if (signal?.aborted) return false;
        _lastError = error?.message || msg('Traffic anomalies unavailable');
        notifyRow();
        return error?.retryable !== false;
      }
    },
    destroy(viewer = _viewer) {
      layer.disable();
      clearTimeout(_restoreTimer);
      if (_primitives) {
        viewer?.scene?.primitives?.remove(_primitives);
        _primitives = null;
      }
      _viewer = null;
      _manager = null;
      _rowListener = null;
    },
    getRowControls() {
      const cells = [..._domains].flatMap((d) =>
        (_results[d]?.cells ?? []).map((c) => ({ ...c, domain: d })),
      );
      return {
        chips: DOMAINS.map((d) => ({
          id: `domain-${d.id}`,
          label: t(d.label),
          active: _domains.has(d.id),
          onClick: () => {
            if (_domains.has(d.id)) _domains.delete(d.id);
            else _domains.add(d.id);
            write('domains', [..._domains].join(','));
            render();
            notifyRow();
          },
        })),
        info: _lastError
          ? translateFeedError(_lastError)
          : [..._domains].map(domainLine).join(' · '),
        infoTitle: t(ANOMALY_DISCLAIMER),
        list: {
          ariaLabel: t('Anomalous cells'),
          items: cells.slice(0, 12).map((c) => ({
            id: `${c.domain}:${c.h3}`,
            lead: `${c.changePct > 0 ? '+' : ''}${formatNumber(c.changePct)}%`,
            text: t(
              '{current} passages vs usual {baseline} ({confidence} confidence)',
              {
                current: formatNumber(c.current),
                baseline: formatNumber(c.baseline),
                confidence: t(CONFIDENCE_TEXT[c.confidence] ?? msg('low')),
              },
            ),
          })),
        },
        legend: [
          {
            label: t('Possible suppression'),
            color: COLORS.possible_traffic_suppression,
          },
          {
            label: t('Possible increase'),
            color: COLORS.possible_traffic_increase,
          },
        ],
      };
    },
    getStats() {
      return {
        count: Object.values(_results).reduce(
          (n, r) => n + (r?.cells?.length ?? 0),
          0,
        ),
        lastUpdate: _lastUpdate,
        error: _lastError,
        fallback: false,
      };
    },
  };
  return layer;
}
