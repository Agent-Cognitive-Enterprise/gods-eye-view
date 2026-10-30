import * as Cesium from 'cesium';
import { formatNumber, msg, t } from '../../i18n/index.js';
import { translateFeedError } from '../../ui/statusText.js';
import { continuousRing } from '../../airsea/warnings.js';

/**
 * Warning Areas layer (fork feature): aviation and maritime warning areas
 * and marine weather alerts in translucent reds, only where the source
 * states the geometry. Points and lines stay points and lines. TRIAL
 * (test) data is drawn dashed and labelled. Sub-layers per domain, an
 * advisory filter, and a list of the newest warnings that opens one: its
 * times, authority, geometry quality and a link to the source.
 * Local-only layer; choices remembered per browser.
 */
export const WARNING_LAYER_ID = 'warning-areas';
const DOMAINS = Object.freeze([
  Object.freeze({
    id: 'marine_weather',
    label: msg('MARINE WX'),
    color: '#ff7a59',
  }),
  Object.freeze({ id: 'maritime', label: msg('MARITIME'), color: '#ff4d4d' }),
  Object.freeze({ id: 'aviation', label: msg('AVIATION'), color: '#ff3b8b' }),
]);
// A step above the spec's 0.14-0.24 start: lighter reds turned grey over
// dark ocean imagery.
const FILL_ALPHA = Object.freeze({
  advisory: 0.16,
  caution: 0.22,
  restricted: 0.28,
  danger: 0.34,
  unknown: 0.2,
});
const STATUS_TEXT = Object.freeze({
  healthy: msg('live'),
  degraded: msg('degraded'),
  stale: msg('stale'),
  down: msg('down'),
  unconfigured: msg('not connected'),
  permission_required: msg('permission required'),
  trial: msg('TRIAL'),
});
const PRECISION_TEXT = Object.freeze({
  official: msg('official geometry'),
  derived_checked: msg('geometry built from stated centre and radius'),
  approximate: msg('approximate geometry'),
  none: msg('geometry unavailable'),
});
export const WARNING_DISCLAIMER = msg(
  'For situational awareness only. Not for aviation or maritime navigation. Data may be delayed, incomplete or inaccurate. Areas are shown only where a source states them; no colour means no connected source, not no warning.',
);
const MAX_LIST = 12;

function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Polygons (as rings), lines and points of a GeoJSON geometry. */
function parts(geometry, out = { polygons: [], lines: [], points: [] }) {
  if (!geometry) return out;
  switch (geometry.type) {
    case 'Point':
      out.points.push(geometry.coordinates);
      break;
    case 'MultiPoint':
      out.points.push(...geometry.coordinates);
      break;
    case 'LineString':
      out.lines.push(geometry.coordinates);
      break;
    case 'MultiLineString':
      out.lines.push(...geometry.coordinates);
      break;
    case 'Polygon':
      out.polygons.push(geometry.coordinates[0]);
      break;
    case 'MultiPolygon':
      for (const polygon of geometry.coordinates) out.polygons.push(polygon[0]);
      break;
    case 'GeometryCollection':
      for (const part of geometry.geometries) parts(part, out);
      break;
    default:
  }
  return out;
}

const fmtTime = (value) =>
  value
    ? `${new Date(value).toISOString().slice(0, 16).replace('T', ' ')}Z`
    : '—';

/** @param {{source: object, storage?: Storage|null}} options */
export function createWarningAreasLayer({
  source,
  storage = defaultStorage(),
}) {
  if (typeof source?.getWarnings !== 'function')
    throw new TypeError('Warning areas layer requires a warnings source');
  const key = (name) => `gev.airsea.${WARNING_LAYER_ID}.${name}`;
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
  let _points = null;
  let _manager = null;
  let _enabled = false;
  let _warnings = [];
  let _sources = [];
  let _signature = null;
  let _lastUpdate = null;
  let _lastError = null;
  let _rowListener = null;
  let _restoreTimer = null;
  let _selected = null; // detail of the warning opened from the list
  const _domains = new Set(
    (read('domains', 'marine_weather,maritime,aviation') || '')
      .split(',')
      .filter((d) => DOMAINS.some((x) => x.id === d)),
  );
  let _advisories = read('advisories', '0') === '1';
  let _trial = read('trial', '1') === '1';

  const notifyRow = () => _rowListener?.();
  const visible = () =>
    _warnings.filter(
      (w) =>
        // The warning opened from the list is always drawn.
        w.id === _selected?.id ||
        (_domains.has(w.domain) &&
          (_advisories || w.severity !== 'advisory') &&
          (_trial || !w.trial)),
    );

  function render() {
    if (!_primitives) return;
    const shown = visible();
    const signature = JSON.stringify([
      shown.map((w) => [w.id, w.severity, w.isNew]),
      _selected?.id ?? null,
    ]);
    if (signature === _signature) return;
    _signature = signature;
    _primitives.removeAll();
    _points.removeAll();
    const fills = [];
    const outlines = [];
    const trialOutlines = [];
    for (const warning of shown) {
      const color = Cesium.Color.fromCssColorString(
        DOMAINS.find((d) => d.id === warning.domain)?.color ?? '#ff4d4d',
      );
      const selected = _selected?.id === warning.id;
      const { polygons, lines, points } = parts(warning.geometry);
      for (const ring of polygons) {
        const positions = Cesium.Cartesian3.fromDegreesArray(
          continuousRing(ring).flat(),
        );
        fills.push(
          new Cesium.GeometryInstance({
            geometry: new Cesium.PolygonGeometry({
              polygonHierarchy: new Cesium.PolygonHierarchy(positions),
              vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
            }),
            attributes: {
              color: Cesium.ColorGeometryInstanceAttribute.fromColor(
                color.withAlpha(
                  (FILL_ALPHA[warning.severity] ?? 0.14) * (selected ? 1.8 : 1),
                ),
              ),
            },
          }),
        );
        (warning.trial ? trialOutlines : outlines).push(
          new Cesium.GeometryInstance({
            geometry: new Cesium.PolylineGeometry({
              positions,
              width: selected ? 3 : warning.isNew ? 2.5 : 1.5,
              vertexFormat: warning.trial
                ? Cesium.PolylineMaterialAppearance.VERTEX_FORMAT
                : Cesium.PolylineColorAppearance.VERTEX_FORMAT,
            }),
            attributes: warning.trial
              ? undefined
              : {
                  color: Cesium.ColorGeometryInstanceAttribute.fromColor(
                    color.withAlpha(warning.isNew || selected ? 1 : 0.75),
                  ),
                },
          }),
        );
      }
      for (const line of lines) {
        const positions = Cesium.Cartesian3.fromDegreesArray(
          continuousRing(line).flat(),
        );
        (warning.trial ? trialOutlines : outlines).push(
          new Cesium.GeometryInstance({
            geometry: new Cesium.PolylineGeometry({
              positions,
              width: 3,
              vertexFormat: warning.trial
                ? Cesium.PolylineMaterialAppearance.VERTEX_FORMAT
                : Cesium.PolylineColorAppearance.VERTEX_FORMAT,
            }),
            attributes: warning.trial
              ? undefined
              : {
                  color: Cesium.ColorGeometryInstanceAttribute.fromColor(color),
                },
          }),
        );
      }
      for (const [lon, lat] of points)
        _points.add({
          position: Cesium.Cartesian3.fromDegrees(lon, lat),
          color: color.withAlpha(0.9),
          pixelSize: selected ? 11 : warning.isNew ? 8 : 6,
          outlineColor: warning.trial
            ? Cesium.Color.WHITE.withAlpha(0.8)
            : Cesium.Color.BLACK.withAlpha(0.6),
          outlineWidth: warning.trial ? 2 : 1,
        });
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
    // TRIAL (test) data: dashed white-red outlines, never mistaken for live.
    if (trialOutlines.length)
      _primitives.add(
        new Cesium.Primitive({
          geometryInstances: trialOutlines,
          appearance: new Cesium.PolylineMaterialAppearance({
            material: Cesium.Material.fromType('PolylineDash', {
              color: Cesium.Color.fromCssColorString('#ff4d4d'),
              gapColor: Cesium.Color.WHITE.withAlpha(0.6),
              dashLength: 12,
            }),
          }),
          allowPicking: false,
        }),
      );
    _viewer?.scene?.requestRender?.();
  }

  function setDomain(id) {
    if (_domains.has(id)) _domains.delete(id);
    else _domains.add(id);
    write('domains', [..._domains].join(','));
    render();
    notifyRow();
  }

  async function open(id) {
    try {
      _selected = await source.getWarning(id);
    } catch {
      _selected = null;
    }
    const bounds = _selected?.bounds;
    if (bounds && _viewer) {
      // The operator chose this: Autopilot steps aside first.
      void globalThis.__gevIntel?.voiceControl?.('pause');
      const [west, south, east, north] = bounds;
      const pad = Math.max(0.2, (north - south) * 0.3);
      _viewer.camera.flyTo({
        destination: Cesium.Rectangle.fromDegrees(
          west - pad,
          Math.max(-89, south - pad),
          east + pad,
          Math.min(89, north + pad),
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
      if (_enabled || !_manager) return;
      if (_manager.viewer) {
        void _manager.setEnabled(WARNING_LAYER_ID, true);
        return;
      }
      if (++tries < 60) _restoreTimer = setTimeout(attempt, 500);
    };
    _restoreTimer = setTimeout(attempt, 1500);
  }

  const layer = {
    id: WARNING_LAYER_ID,
    name: 'Warning Areas',
    icon: '⚠️',
    source: 'NWS / CCG S-124 trial',
    updateInterval: 120_000,

    attachDataManager(manager) {
      _manager = manager;
      scheduleRestore();
    },
    setRowControlsListener(listener) {
      _rowListener = listener;
    },
    setParams(params = {}) {
      if (typeof params.open === 'string') void open(params.open);
      return true;
    },
    init(viewer) {
      _viewer = viewer;
      _primitives = new Cesium.PrimitiveCollection();
      _primitives.show = false;
      _points = new Cesium.PointPrimitiveCollection();
      _points.show = false;
      viewer.scene.primitives.add(_primitives);
      viewer.scene.primitives.add(_points);
    },
    enable() {
      _enabled = true;
      write('enabled', '1');
      if (_primitives) _primitives.show = _points.show = true;
    },
    disable() {
      _enabled = false;
      write('enabled', '0');
      if (_primitives) _primitives.show = _points.show = false;
    },
    async update(_viewerArg, { signal } = {}) {
      if (!_enabled || signal?.aborted) return false;
      try {
        const answer = await source.getWarnings({ signal });
        if (!_enabled) return false;
        _warnings = answer.warnings ?? [];
        _sources = answer.sources ?? [];
        _lastUpdate = Date.now();
        _lastError = null;
        render();
        notifyRow();
        return true;
      } catch (error) {
        if (signal?.aborted) return false;
        _lastError = error?.message || msg('Warning areas unavailable');
        notifyRow();
        return error?.retryable !== false;
      }
    },
    destroy(viewer = _viewer) {
      layer.disable();
      clearTimeout(_restoreTimer);
      if (_primitives) {
        viewer?.scene?.primitives?.remove(_primitives);
        viewer?.scene?.primitives?.remove(_points);
        _primitives = _points = null;
      }
      _viewer = null;
      _manager = null;
      _rowListener = null;
    },

    getRowControls() {
      const shown = visible();
      const sources = _sources
        .map(
          (s) =>
            `${s.short ?? s.id} ${t(STATUS_TEXT[s.status] ?? msg('unknown'))}`,
        )
        .join(' · ');
      const selected = _selected
        ? [
            `${_selected.trial ? `${t('TRIAL')} · ` : ''}${_selected.title}`,
            `${t('effective')} ${fmtTime(_selected.effectiveFromUtc)} – ${fmtTime(_selected.effectiveUntilUtc)}`,
            _selected.authority,
            t(
              PRECISION_TEXT[_selected.geometryPrecision] ??
                PRECISION_TEXT.none,
            ),
          ]
            .filter(Boolean)
            .join(' · ')
        : null;
      const newest = [...shown]
        .sort((a, b) =>
          String(b.lastChange?.atUtc ?? b.publishedAtUtc ?? '').localeCompare(
            String(a.lastChange?.atUtc ?? a.publishedAtUtc ?? ''),
          ),
        )
        .slice(0, MAX_LIST);
      return {
        chips: [
          ...DOMAINS.map((d) => ({
            id: `domain-${d.id}`,
            label: t(d.label),
            active: _domains.has(d.id),
            color: d.color,
            onClick: () => setDomain(d.id),
          })),
          {
            id: 'advisories',
            label: t('ADVISORIES'),
            active: _advisories,
            title: t(
              'Include advisories (buoy, light and chart changes, small craft advisories)',
            ),
            onClick: () => {
              _advisories = !_advisories;
              write('advisories', _advisories ? '1' : '0');
              render();
              notifyRow();
            },
          },
          {
            id: 'trial',
            label: t('TRIAL DATA'),
            active: _trial,
            title: t('Show test (non-operational) data, drawn dashed'),
            onClick: () => {
              _trial = !_trial;
              write('trial', _trial ? '1' : '0');
              render();
              notifyRow();
            },
          },
          ...(_selected?.sourceUrl
            ? [
                {
                  id: 'open-source',
                  label: t('SOURCE ↗'),
                  title: _selected.sourceUrl,
                  onClick: () =>
                    globalThis.open?.(
                      _selected.sourceUrl,
                      '_blank',
                      'noopener,noreferrer',
                    ),
                },
              ]
            : []),
        ],
        info: _lastError
          ? translateFeedError(_lastError)
          : [
              selected,
              t('{count} areas shown', { count: formatNumber(shown.length) }),
              sources,
            ]
              .filter(Boolean)
              .join(' · '),
        infoTitle: t(WARNING_DISCLAIMER),
        list: {
          ariaLabel: t('Newest warnings'),
          items: newest.map((w) => ({
            id: w.id,
            lead: [w.isNew ? t('NEW') : null, w.trial ? t('TRIAL') : null]
              .filter(Boolean)
              .join(' · '),
            text: w.title,
            active: _selected?.id === w.id,
            params: { open: w.id },
          })),
        },
        legend: DOMAINS.map((d) => ({
          label: t(d.label),
          color: d.color,
          count: shown.filter((w) => w.domain === d.id).length,
        })),
      };
    },

    getStats() {
      return {
        count: visible().length,
        lastUpdate: _lastUpdate,
        error: _lastError,
        selected: _selected?.id ?? null,
        fallback: false,
      };
    },
  };
  return layer;
}
