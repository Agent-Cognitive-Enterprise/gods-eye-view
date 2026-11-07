import * as Cesium from 'cesium';
import { formatNumber, msg, t } from '../../i18n/index.js';
import { translateFeedError } from '../../ui/statusText.js';
import {
  GNSS_REGIONS_LAYER_ID,
  areaRing,
  regionsFromAnswer,
  viewRectangle,
} from '../../airsea/gnssRegionsView.js';
import { RESTORE_ORIGIN, trackVisibility } from './visibility.js';

export { GNSS_REGIONS_LAYER_ID };

/**
 * Ship GNSS Screen layer (fork feature): the areas where the regional AIS
 * screen (`/api/airsea/gnss-regions`) saw three or more ships' positions
 * jump implausibly to the same distant place. Each box is where the ships
 * were, approximately; the false positions and the ships are never shown.
 * Orange: a credible source location; grey: ambiguous (ships trusted where
 * spoofed positions landed). Ended incidents of the last day can be drawn
 * as outlines. Local-only; remembered per browser.
 */
export const GNSS_REGION_COLORS = Object.freeze({
  credible: '#ff8c42',
  ambiguous: '#a0a8b8',
  ended: '#ffb07a',
});
const HEIGHT = 500;
const MAX_LIST = 12;
const STATUS_TEXT = Object.freeze({
  warming_up: msg('warming up'),
  observing: msg('observing'),
  candidate_regions: msg('observing'),
  coverage_uncertain: msg('coverage uncertain: AIS feed not healthy'),
  unconfigured: msg('AIS feed not configured'),
});
export const GNSS_REGIONS_DISCLAIMER = msg(
  'Areas where three or more ships received over AIS jumped implausibly to the same distant place within 30 minutes. A box is roughly where the ships were; their false positions are not shown. One feed and an unconfirmed cause: an anomaly screen, not proof of GNSS interference.',
);

function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
// UTC; the date only when the span is not all today (an incident can stay
// active for days).
const stamp = (ms, withDate) =>
  ms
    ? new Date(ms)
        .toISOString()
        .slice(withDate ? 5 : 11, 16)
        .replace('T', ' ')
    : '—';
const day = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : null);
const span = (first, last, nowMs) => {
  const today = day(nowMs);
  const dated = day(first) !== today || day(last) !== today;
  return `${stamp(first, dated)}–${stamp(last, dated)}Z`;
};
const colorOf = (region) =>
  region.ambiguous
    ? GNSS_REGION_COLORS.ambiguous
    : region.state === 'ended'
      ? GNSS_REGION_COLORS.ended
      : GNSS_REGION_COLORS.credible;

/** @param {{source: object, storage?: Storage|null, now?: () => number}} options */
export function createShipGnssRegionsLayer({
  source,
  storage = defaultStorage(),
  now = () => Date.now(),
}) {
  if (typeof source?.getGnssRegions !== 'function')
    throw new TypeError('Ship GNSS layer requires a GNSS regions source');
  const key = (name) => `gev.airsea.${GNSS_REGIONS_LAYER_ID}.${name}`;
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
  let _answer = null;
  let _regions = { active: [], ended: [] };
  let _selected = null;
  let _showEnded = read('ended', '1') === '1';
  let _lastError = null;
  let _lastUpdate = null;
  let _rowListener = null;
  let _restoreTimer = null;
  let _signature = null;
  let _visibility = null;
  const notifyRow = () => _rowListener?.();
  const drawn = () =>
    _showEnded ? [..._regions.active, ..._regions.ended] : _regions.active;

  function render() {
    if (!_primitives) return;
    const regions = drawn();
    const signature = JSON.stringify([
      _selected,
      regions.map((r) => [r.id, r.state, r.ambiguous, r.area]),
    ]);
    if (signature === _signature) return;
    _signature = signature;
    _primitives.removeAll();
    const fills = [];
    const outlines = [];
    for (const region of regions) {
      const ring = areaRing(region.area);
      if (!ring) continue;
      const color = Cesium.Color.fromCssColorString(colorOf(region));
      const selected = region.id === _selected;
      if (region.state === 'active')
        fills.push(
          new Cesium.GeometryInstance({
            geometry: new Cesium.PolygonGeometry({
              polygonHierarchy: new Cesium.PolygonHierarchy(
                Cesium.Cartesian3.fromDegreesArray(ring.slice(0, -1).flat()),
              ),
              height: HEIGHT,
              arcType: Cesium.ArcType.RHUMB,
              vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
            }),
            attributes: {
              color: Cesium.ColorGeometryInstanceAttribute.fromColor(
                color.withAlpha(selected ? 0.28 : 0.18),
              ),
            },
          }),
        );
      outlines.push(
        new Cesium.GeometryInstance({
          geometry: new Cesium.PolylineGeometry({
            positions: Cesium.Cartesian3.fromDegreesArrayHeights(
              ring.flatMap(([lon, lat]) => [lon, lat, HEIGHT]),
            ),
            width: selected ? 4 : 2,
            arcType: Cesium.ArcType.RHUMB,
            vertexFormat: Cesium.PolylineColorAppearance.VERTEX_FORMAT,
          }),
          attributes: {
            color: Cesium.ColorGeometryInstanceAttribute.fromColor(
              color.withAlpha(region.state === 'ended' && !selected ? 0.6 : 1),
            ),
          },
        }),
      );
    }
    if (fills.length)
      _primitives.add(
        new Cesium.Primitive({
          geometryInstances: fills,
          appearance: new Cesium.PerInstanceColorAppearance({
            flat: true,
            translucent: true,
          }),
          allowPicking: false,
        }),
      );
    if (outlines.length)
      _primitives.add(
        new Cesium.Primitive({
          geometryInstances: outlines,
          appearance: new Cesium.PolylineColorAppearance({ translucent: true }),
          allowPicking: false,
        }),
      );
    _viewer?.scene?.requestRender?.();
  }

  function open(id) {
    const region = drawn().find((r) => r.id === id);
    if (!region || !_enabled) return;
    _selected = id;
    const rect = _viewer && viewRectangle(region.area);
    if (rect) {
      // The operator chose this: Autopilot steps aside first.
      void globalThis.__gevIntel?.voiceControl?.('pause');
      _viewer.camera.flyTo({
        destination: Cesium.Rectangle.fromDegrees(
          rect.west,
          rect.south,
          rect.east,
          rect.north,
        ),
        duration: 2,
      });
    }
    render();
    notifyRow();
  }

  function scheduleRestore() {
    if (read('enabled', '0') !== '1' || !_manager) return;
    let tries = 0;
    const attempt = () => {
      _restoreTimer = null;
      if (!_manager) return;
      if (_manager.viewer) {
        // Sent even if a reveal switched it on first: it is the operator's.
        void _manager.setEnabled(GNSS_REGIONS_LAYER_ID, true, {
          origin: RESTORE_ORIGIN,
        });
        return;
      }
      if (++tries < 60) _restoreTimer = setTimeout(attempt, 500);
    };
    _restoreTimer = setTimeout(attempt, 1500);
  }

  function statusLine() {
    if (!_answer) return t('Loading…');
    const status = t(STATUS_TEXT[_answer.status] ?? msg('unknown'));
    const tracked = Number(_answer.diagnostic?.tracked);
    return [
      status,
      t('Regions: {count}', { count: formatNumber(_regions.active.length) }),
      Number.isFinite(tracked)
        ? t('Vessels tracked: {count}', { count: formatNumber(tracked) })
        : null,
    ]
      .filter(Boolean)
      .join(' · ');
  }

  const layer = {
    id: GNSS_REGIONS_LAYER_ID,
    name: 'Ship GNSS Screen',
    icon: '🛰️',
    source: 'Air & Sea AIS screen',
    updateInterval: 60_000,

    attachDataManager(manager) {
      _manager = manager;
      // Only a person's own on/off is remembered across reloads.
      _visibility = trackVisibility(manager, {
        id: GNSS_REGIONS_LAYER_ID,
        remember: (on) => write('enabled', on ? '1' : '0'),
      });
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
      if (_primitives) _primitives.show = true;
    },
    disable() {
      _enabled = false;
      if (_primitives) _primitives.show = false;
    },
    setParams(params = {}) {
      if (typeof params.open === 'string') open(params.open);
    },
    async update(_viewerArg, { signal } = {}) {
      if (!_enabled || signal?.aborted) return false;
      try {
        const answer = await source.getGnssRegions({ signal });
        if (!_enabled) return false;
        _answer = answer;
        _regions = regionsFromAnswer(answer, { now: now() });
        if (_selected && !drawn().some((r) => r.id === _selected))
          _selected = null;
        _lastError = null;
        _lastUpdate = Date.now();
        render();
        notifyRow();
        return true;
      } catch (error) {
        if (signal?.aborted) return false;
        _lastError = error?.message || msg('Ship GNSS screen unavailable');
        notifyRow();
        return error?.retryable !== false;
      }
    },
    destroy(viewer = _viewer) {
      layer.disable();
      clearTimeout(_restoreTimer);
      _visibility?.stop();
      _visibility = null;
      if (_primitives) {
        viewer?.scene?.primitives?.remove(_primitives);
        _primitives = null;
      }
      _viewer = null;
      _manager = null;
      _rowListener = null;
    },
    getRowControls() {
      const listed = drawn().slice(0, MAX_LIST);
      return {
        chips: [
          {
            id: 'ended',
            label: t('ENDED'),
            active: _showEnded,
            title: t('Show regions that ended in the last 24 hours'),
            onClick: () => {
              _showEnded = !_showEnded;
              write('ended', _showEnded ? '1' : '0');
              if (
                !_showEnded &&
                _selected &&
                !drawn().some((r) => r.id === _selected)
              )
                _selected = null;
              render();
              notifyRow();
            },
          },
        ],
        info: _lastError ? translateFeedError(_lastError) : statusLine(),
        infoTitle: t(GNSS_REGIONS_DISCLAIMER),
        list: {
          ariaLabel: t('Ship GNSS regions'),
          items: listed.map((r) => ({
            id: r.id,
            lead: [
              r.state === 'ended' ? t('ENDED') : null,
              r.ambiguous ? '?' : null,
            ]
              .filter(Boolean)
              .join(' '),
            text: [
              t('Vessels: {count}', { count: formatNumber(r.vessels) }),
              span(r.firstSeenAt, r.lastSeenAt, now()),
              r.ambiguous ? t('source location ambiguous') : null,
            ]
              .filter(Boolean)
              .join(' · '),
            color: colorOf(r),
            active: _selected === r.id,
            params: { open: r.id },
          })),
        },
        legend: [
          {
            label: t('Credible source location'),
            color: GNSS_REGION_COLORS.credible,
            count: _regions.active.filter((r) => !r.ambiguous).length,
          },
          {
            label: t('Ambiguous source location'),
            color: GNSS_REGION_COLORS.ambiguous,
            count: _regions.active.filter((r) => r.ambiguous).length,
          },
          {
            label: t('Ended in the last 24 h'),
            color: GNSS_REGION_COLORS.ended,
            count: _regions.ended.length,
          },
        ],
      };
    },
    getStats() {
      return {
        count: _regions.active.length,
        lastUpdate: _lastUpdate,
        error: _lastError,
        selected: _selected,
        fallback: false,
      };
    },
  };
  return layer;
}
