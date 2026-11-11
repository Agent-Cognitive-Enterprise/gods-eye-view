import * as Cesium from 'cesium';
import { formatDate, formatNumber, msg, t } from '../../i18n/index.js';
import { translateFeedError } from '../../ui/statusText.js';
import { loadBundledJson } from '../../data/bundledJson.js';
import { countryView, indexCountries } from '../../bankingAccess/geometry.js';
import { RESTORE_ORIGIN, trackVisibility } from '../airsea/visibility.js';
export { createBankingAccessSource } from './source.js';

/**
 * Banking Access layer (fork feature): countries where reviewed events cut
 * people off from their money, shaded by weighted impact. Light amber to dark
 * red with the share of the population affected (or, in PEOPLE mode, with
 * how many people), weighted by severity, duration and confidence; a resolved
 * event fades over five days. The fill pattern says the kind of disruption:
 * solid for bank failure or frozen deposits, stripes for a technical outage,
 * a check for withdrawal limits or capital controls. An event without a
 * known reach is an outline only. Clicking a country (or a row) shows its
 * card. News candidates (GEV_BANKING_NEWS=1) are listed, never drawn.
 * Local-only; remembered per browser.
 */
export const BANKING_ACCESS_LAYER_ID = 'banking-access';
export const BANKING_CLASS_COLORS = Object.freeze({
  minimal: '#f2e6c2',
  low: '#ffd166',
  moderate: '#ff9f1c',
  high: '#ff4d2e',
  severe: '#c1121f',
  unknown: '#9fb3c8',
  history: '#8a8f98',
});
const SYSTEMIC_BORDER = '#ff2d55';
const OVERLAY_SOURCE_ID = 'banking-access';
const PICK_PREFIX = 'banking-access:';
const MAX_LIST = 12;
// Card lines do not wrap: longer text is cut, the full text is in the data.
const CARD_TEXT = 90;
const CARD_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});
const COUNTRIES_URL = new URL(
  '../../data/local_data/natural_earth/countries.json',
  import.meta.url,
);
const TYPE_TEXT = Object.freeze({
  technical_outage: msg('technical outage'),
  withdrawal_limits: msg('withdrawal limits'),
  capital_controls: msg('capital controls'),
  deposit_freeze: msg('frozen deposits'),
  bank_failure: msg('bank failure'),
});
const CONFIDENCE_TEXT = Object.freeze({
  social: msg('social media only'),
  multiple_reports: msg('multiple reports'),
  official: msg('official'),
});
const CLASS_TEXT = Object.freeze({
  minimal: msg('Minimal'),
  low: msg('Low'),
  moderate: msg('Moderate'),
  high: msg('High'),
  severe: msg('Severe'),
  unknown: msg('Reach unknown'),
});
export const BANKING_ACCESS_DISCLAIMER = msg(
  'Reviewed reports of people cut off from their money. Shade: the share of the population affected (or people affected), weighted by severity, duration and how well it is confirmed; a resolved event fades over five days. Pattern: solid for bank failure or frozen deposits, stripes for a technical outage, a check for withdrawal limits or capital controls. Estimates come from the sources; a dashed border means no source gives the reach of some event, and a solid outline without a fill means a minimal impact. News leads are not checked and are never drawn.',
);

function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
const hostOf = (url) => {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
};
const compact = (n) =>
  formatNumber(n, { notation: 'compact', maximumFractionDigits: 1 });
const percent = (p) =>
  `${formatNumber(p, { maximumFractionDigits: p < 10 ? 1 : 0 })}%`;
const day = (ms) =>
  ms
    ? formatDate(ms, { year: 'numeric', month: 'short', day: 'numeric' })
    : '—';
function durationText(hours, startedAt) {
  // A long-running restriction reads better by its start than in days.
  if (hours >= 60 * 24 && startedAt)
    return t('Since {date}', { date: day(startedAt) });
  if (hours < 48)
    return t('Duration: {value} h', { value: formatNumber(Math.round(hours)) });
  return t('Duration: {value} d', {
    value: formatNumber(Math.round(hours / 24)),
  });
}

/**
 * @param {{source: object, storage?: Storage|null, overlayHost?: object|null,
 *   screenSpaceEventHandlerFactory?: Function|null, picking?: object|null,
 *   pointer?: object|null, loadCountries?: () => Promise<object>}} options
 */
export function createBankingAccessLayer({
  source,
  storage = defaultStorage(),
  overlayHost = null,
  screenSpaceEventHandlerFactory = null,
  picking = null,
  pointer = null,
  loadCountries = () => loadBundledJson(COUNTRIES_URL),
}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Banking access layer requires a snapshot source');
  const key = (name) => `gev.${BANKING_ACCESS_LAYER_ID}.${name}`;
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
  let _dataSource = null;
  let _enabled = false;
  let _answer = null;
  let _shapes = null;
  let _shapesLoading = null;
  let _selected = null; // iso3
  let _signature = null;
  let _lastError = null;
  let _lastUpdate = null;
  let _rowListener = null;
  let _clickHandler = null;
  let _request = null;
  let _mode = read('mode', 'share') === 'people' ? 'people' : 'share';
  let _newest = read('newest', '0') === '1';
  let _history = read('history', '0') === '1';
  let _newsList = false;
  let _manager = null;
  let _visibility = null;
  let _restoreTimer = null;
  const notifyRow = () => _rowListener?.();
  const canSelect = () =>
    overlayHost && screenSpaceEventHandlerFactory && picking;

  const countries = () => _answer?.countries ?? [];
  const eventsOf = (country) =>
    country.eventIds
      .map((id) => _answer.events.find((e) => e.id === id))
      .filter(Boolean);
  const leadOf = (country) =>
    _answer?.events.find((e) => e.id === country.leadEventId) ??
    eventsOf(country)[0];
  const sorted = () =>
    [...countries()].sort((a, b) =>
      _newest
        ? b.updatedAt - a.updatedAt
        : (b.scores[_mode] ?? -1) - (a.scores[_mode] ?? -1) ||
          b.updatedAt - a.updatedAt,
    );
  const classOf = (c) => c.classes?.[_mode] ?? 'unknown';
  const colorOf = (c) =>
    BANKING_CLASS_COLORS[classOf(c)] ?? BANKING_CLASS_COLORS.unknown;

  async function shapes() {
    if (_shapes) return _shapes;
    _shapesLoading ??= loadCountries()
      .then((pack) => (_shapes = indexCountries(pack)))
      .finally(() => {
        _shapesLoading = null;
      });
    return _shapesLoading;
  }

  function fillMaterial(country, color, patterns) {
    if (patterns && country.type === 'technical_outage')
      return new Cesium.StripeMaterialProperty({
        evenColor: color,
        oddColor: Cesium.Color.TRANSPARENT,
        repeat: 48,
        orientation: Cesium.StripeOrientation.VERTICAL,
      });
    if (
      patterns &&
      (country.type === 'withdrawal_limits' ||
        country.type === 'capital_controls')
    )
      return new Cesium.CheckerboardMaterialProperty({
        evenColor: color,
        oddColor: Cesium.Color.TRANSPARENT,
        repeat: new Cesium.Cartesian2(48, 48),
      });
    return new Cesium.ColorMaterialProperty(color);
  }

  function render() {
    if (!_dataSource || !_shapes) return;
    // Everything drawn comes from the countries and the mode; selection only
    // moves the card, so it never redraws the polygons.
    const signature = JSON.stringify([_mode, countries()]);
    if (signature === _signature) {
      publishCard();
      return;
    }
    _signature = signature;
    // Patterned ground fills need material support; otherwise all solid.
    let patterns = false;
    try {
      patterns = Cesium.GroundPrimitive.supportsMaterials(_viewer.scene);
    } catch {
      patterns = false;
    }
    const entities = [];
    for (const country of countries()) {
      const shape = _shapes.get(country.iso3);
      if (!shape) continue;
      const cls = classOf(country);
      const color = Cesium.Color.fromCssColorString(colorOf(country));
      const intensity = country.intensity?.[_mode];
      const fade = country.historical ? 0 : Math.max(0.15, country.decay);
      const filled =
        intensity != null &&
        !country.historical &&
        cls !== 'minimal' &&
        cls !== 'unknown';
      // Systemic importance is a bright border; the fill keeps to the metric.
      const systemic = country.systemic && !country.historical;
      const borderColor = country.historical
        ? Cesium.Color.fromCssColorString(BANKING_CLASS_COLORS.history)
        : systemic
          ? Cesium.Color.fromCssColorString(SYSTEMIC_BORDER)
          : country.active
            ? color
            : Cesium.Color.fromCssColorString(BANKING_CLASS_COLORS.history);
      // Dashed: history, or some live event's reach is not known.
      // Dashed whenever some reach is unknown, systemic or not.
      const dashed =
        country.historical || intensity == null || country.reachUnknown;
      const holesOf = (holes) =>
        holes.map(
          (hole) =>
            new Cesium.PolygonHierarchy(
              hole.map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat)),
            ),
        );
      shape.polygons.forEach(([outer, ...holes], index) => {
        const positions = outer.map(([lon, lat]) =>
          Cesium.Cartesian3.fromDegrees(lon, lat),
        );
        entities.push(
          new Cesium.Entity({
            id: `${PICK_PREFIX}${country.iso3}:${index}`,
            // Unfilled countries keep an all-but-invisible interior, so a
            // click anywhere inside still selects them.
            polygon: {
              hierarchy: new Cesium.PolygonHierarchy(positions, holesOf(holes)),
              material: filled
                ? fillMaterial(
                    country,
                    color.withAlpha((0.2 + 0.4 * intensity) * fade),
                    patterns,
                  )
                : new Cesium.ColorMaterialProperty(
                    Cesium.Color.WHITE.withAlpha(0.01),
                  ),
            },
            polyline: {
              positions: [...positions, positions[0]],
              clampToGround: true,
              width: systemic ? 3 : 2,
              material: dashed
                ? new Cesium.PolylineDashMaterialProperty({
                    color: borderColor.withAlpha(0.9),
                    dashLength: 12,
                  })
                : new Cesium.ColorMaterialProperty(
                    borderColor.withAlpha(country.active ? 0.95 : 0.6),
                  ),
            },
          }),
        );
      });
    }
    _dataSource.entities.suspendEvents();
    _dataSource.entities.removeAll();
    for (const entity of entities) _dataSource.entities.add(entity);
    _dataSource.entities.resumeEvents();
    publishCard();
    _viewer?.scene?.requestRender?.();
  }

  function cardFor(country) {
    const events = eventsOf(country);
    const lead = leadOf(country);
    const name = country.countryName || _shapes?.get(country.iso3)?.name;
    // A range when several events may overlap: largest single event to the
    // capped sum.
    const range = (low, high, fmt) =>
      high != null && high > low ? `${fmt(low)}–${fmt(high)}` : fmt(low);
    const people =
      country.affectedPeople != null &&
      range(country.affectedPeople, country.affectedPeopleHigh, compact);
    const share =
      country.affectedPct != null &&
      range(country.affectedPct, country.affectedPctHigh, percent);
    const affected =
      people && share && !country.mixedFigures
        ? t('Affected: {people} ({share} of the population)', { people, share })
        : people && share
          ? `${t('Affected: {people}', { people })} · ${t(
              'Affected: {share} of the population',
              { share },
            )}`
          : people
            ? t('Affected: {people}', { people })
            : share
              ? t('Affected: {share} of the population', { share })
              : t('Affected: not known');
    const details = [
      country.reachUnknown &&
      (country.affectedPeople != null || country.affectedPct != null)
        ? `${affected} · ${t('Reach unknown')}`
        : affected,
    ];
    if (country.overlapPossible)
      details.push(
        t(
          'Events may overlap: the range runs from the largest one to their sum',
        ),
      );
    if (lead?.stale)
      details.push(
        t('Not re-verified since {date}', { date: day(lead.verifiedAt) }),
      );
    if (lead) {
      details.push(
        [
          t('Severity {level}/5', { level: lead.severity }),
          durationText(lead.durationHours, lead.startedAt),
          t('Confidence: {level}', {
            level: t(CONFIDENCE_TEXT[lead.confidence] ?? msg('unknown')),
          }),
        ].join(' · '),
      );
      details.push(
        [
          t('Sources: {list}', {
            // Every event of this country, the lead's first.
            list: [lead, ...events.filter((e) => e !== lead)]
              .flatMap((e) => e.sources ?? [])
              .map((src) => src.publisher || hostOf(src.url))
              .filter((name, i, all) => name && all.indexOf(name) === i)
              .join(', '),
          }),
          t('updated {date}', { date: day(lead.updatedAt) }),
          lead.resolvedAt
            ? t('resolved {date}', { date: day(lead.resolvedAt) })
            : null,
        ]
          .filter(Boolean)
          .join(' · '),
      );
      if (lead.affectedBasis)
        details.push(
          t('Estimate: {basis}', {
            basis:
              lead.affectedBasis.length > CARD_TEXT
                ? `${lead.affectedBasis.slice(0, CARD_TEXT - 1)}…`
                : lead.affectedBasis,
          }),
        );
      if (lead.summary)
        details.push(
          lead.summary.length > CARD_TEXT
            ? `${lead.summary.slice(0, CARD_TEXT - 1)}…`
            : lead.summary,
        );
    }
    if (events.length > 1)
      details.push(
        t('More events here: {count}', {
          count: formatNumber(events.length - 1),
        }),
      );
    return {
      id: `banking-access-card:${country.iso3}`,
      selected: true,
      interactive: false,
      title: `${String(name ?? country.iso3).toUpperCase()} · ${t(
        TYPE_TEXT[country.type] ?? msg('unknown'),
      )}`,
      details,
      accent: colorOf(country),
      priority: Number.MAX_SAFE_INTEGER,
      gapPx: 15,
      verticalOnly: true,
      placement: 'above',
    };
  }

  function publishCard() {
    if (!overlayHost) return;
    const country = countries().find((c) => c.iso3 === _selected);
    const shape = country && _shapes?.get(country.iso3);
    if (!country || !shape || !_enabled) {
      overlayHost.setEntries(OVERLAY_SOURCE_ID, [], CARD_OPTIONS);
      return;
    }
    overlayHost.setEntries(
      OVERLAY_SOURCE_ID,
      [
        {
          ...cardFor(country),
          position: Cesium.Cartesian3.fromDegrees(
            shape.anchor.lon,
            shape.anchor.lat,
          ),
        },
      ],
      CARD_OPTIONS,
    );
  }

  function select(iso3, { fly = false } = {}) {
    _selected = iso3;
    publishCard();
    const shape = iso3 && _shapes?.get(iso3);
    if (fly && shape && _viewer?.camera) {
      // The operator chose this: Autopilot steps aside first.
      void globalThis.__gevIntel?.voiceControl?.('pause');
      const v = countryView(shape.box);
      _viewer.camera.flyTo({
        destination: Cesium.Rectangle.fromDegrees(
          v.west,
          v.south,
          v.east,
          v.north,
        ),
        duration: 2,
      });
    }
    notifyRow();
  }

  function pickedIso3(picked) {
    const id = picking.resolvePickId(picked);
    if (typeof id !== 'string' || !id.startsWith(PICK_PREFIX)) return null;
    const iso3 = id.slice(PICK_PREFIX.length).split(':')[0];
    return countries().some((c) => c.iso3 === iso3) ? iso3 : null;
  }

  function installClickHandler() {
    if (!canSelect() || _clickHandler || !_viewer) return;
    // Not in the pick-ownership registry, like the airspace zones: whole
    // countries must not make other layers' cards inert above them.
    _clickHandler = screenSpaceEventHandlerFactory(_viewer);
    _clickHandler.setInputAction((click) => {
      if (!_enabled || (pointer && !pointer.isPointerFree())) return;
      const card = overlayHost.hitTest?.(click.position?.x, click.position?.y, {
        sourceId: OVERLAY_SOURCE_ID,
      });
      if (card) return;
      const picked = _viewer.scene.pick(click.position);
      const iso3 = picked ? pickedIso3(picked) : null;
      if (iso3) return select(iso3);
      if (picked) {
        const id = picking.resolvePickId(picked);
        if (id && picking.isOwnedByOtherLayer(BANKING_ACCESS_LAYER_ID, id))
          return;
      }
      if (_selected) select(null);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function removeClickHandler() {
    _clickHandler?.destroy?.();
    _clickHandler = null;
  }

  function summaryLine() {
    if (!_answer) return t('Loading…');
    const shown = countries().filter((c) => !c.historical);
    const parts = [
      t('Countries: {count}', { count: formatNumber(shown.length) }),
      t('Active events: {count}', {
        count: formatNumber(_answer.counts?.active ?? 0),
      }),
    ];
    // An events file that could not be read, or holds an invalid entry: the
    // map shows its last good copy, and says from when.
    const degraded = _answer.degraded ?? [];
    if (degraded.length)
      parts.push(
        t('Events file DEGRADED: showing the copy from {time}', {
          time: formatDate(Math.min(...degraded.map((d) => d.lastGoodAt)), {
            day: 'numeric',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit',
          }),
        }),
      );
    if (_answer.problems?.length)
      parts.push(
        t('Entries to fix: {count}', {
          count: formatNumber(_answer.problems.length),
        }),
      );
    const news = _answer.news;
    // A failed fetch is DEGRADED, never a quiet day with zero leads.
    if (news?.enabled)
      parts.push(
        news.status === 'degraded' || news.status === 'circuit_open'
          ? t('News leads DEGRADED: next try {time}', {
              time: news.nextAttemptAt
                ? formatDate(news.nextAttemptAt, {
                    hour: '2-digit',
                    minute: '2-digit',
                  })
                : '—',
            })
          : news.status === 'starting' || news.fetchedAt == null
            ? t('News leads: starting')
            : news.status === 'stale'
              ? t('News leads: {count}, list from {time}', {
                  count: formatNumber(news.candidates?.length ?? 0),
                  time: formatDate(news.fetchedAt, {
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  }),
                })
              : t('News leads: {count}', {
                  count: formatNumber(news.candidates?.length ?? 0),
                }),
      );
    return parts.join(' · ');
  }

  function countryItem(c) {
    // The lower bound, marked when several events may add more.
    const more = (low, high) => (high != null && high > low ? '+' : '');
    const value =
      _mode === 'people'
        ? c.affectedPeople != null
          ? compact(c.affectedPeople) +
            more(c.affectedPeople, c.affectedPeopleHigh)
          : '?'
        : c.affectedPct != null
          ? percent(c.affectedPct) + more(c.affectedPct, c.affectedPctHigh)
          : '?';
    return {
      id: c.iso3,
      lead: c.historical ? t('PAST') : value,
      text: [
        c.countryName || _shapes?.get(c.iso3)?.name || c.iso3,
        t(TYPE_TEXT[c.type] ?? msg('unknown')),
        t('Severity {level}/5', { level: c.severity }),
      ].join(' · '),
      color: colorOf(c),
      active: _selected === c.iso3,
      params: { select: c.iso3 },
    };
  }

  function newsItems() {
    return (_answer?.news?.candidates ?? []).slice(0, MAX_LIST).map((n) => ({
      id: n.id,
      lead: n.sourceCountry || n.domain,
      text: n.title,
      params: { openNews: n.id },
    }));
  }

  function scheduleRestore() {
    if (read('enabled', '0') !== '1' || !_manager) return;
    let tries = 0;
    const attempt = () => {
      _restoreTimer = null;
      if (!_manager) return;
      if (_manager.viewer) {
        void _manager.setEnabled(BANKING_ACCESS_LAYER_ID, true, {
          origin: RESTORE_ORIGIN,
        });
        return;
      }
      if (++tries < 60) _restoreTimer = setTimeout(attempt, 500);
    };
    _restoreTimer = setTimeout(attempt, 1500);
  }

  const layer = {
    id: BANKING_ACCESS_LAYER_ID,
    name: 'Banking Access',
    icon: '🏦',
    source: 'Reviewed reports',
    updateInterval: 10 * 60_000,

    attachDataManager(manager) {
      _manager = manager;
      // Only a person's own on/off is remembered across reloads.
      _visibility = trackVisibility(manager, {
        id: BANKING_ACCESS_LAYER_ID,
        remember: (on) => write('enabled', on ? '1' : '0'),
      });
      scheduleRestore();
    },
    setRowControlsListener(listener) {
      _rowListener = listener;
    },
    init(viewer) {
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource(BANKING_ACCESS_LAYER_ID);
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
    },
    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost?.setVisible?.(OVERLAY_SOURCE_ID, true);
      installClickHandler();
    },
    disable() {
      _enabled = false;
      _request?.abort();
      _request = null;
      if (_dataSource) _dataSource.show = false;
      removeClickHandler();
      _selected = null;
      overlayHost?.clearSource?.(OVERLAY_SOURCE_ID);
      overlayHost?.setVisible?.(OVERLAY_SOURCE_ID, false);
    },
    setParams(params = {}) {
      if (typeof params.select === 'string')
        select(params.select, { fly: true });
      if (typeof params.openNews === 'string') {
        const item = _answer?.news?.candidates?.find(
          (n) => n.id === params.openNews,
        );
        if (item && /^https?:\/\//.test(item.url))
          globalThis.open?.(item.url, '_blank', 'noopener,noreferrer');
      }
    },
    async update(_viewerArg, { signal } = {}) {
      if (!_enabled || signal?.aborted) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      const abort = () => request.abort();
      signal?.addEventListener?.('abort', abort, { once: true });
      try {
        const [answer] = await Promise.all([
          source.getSnapshot({ history: _history, signal: request.signal }),
          shapes(),
        ]);
        if (request.signal.aborted || !_enabled) return false;
        _answer = answer;
        if (_selected && !countries().some((c) => c.iso3 === _selected))
          _selected = null;
        _lastError = null;
        _lastUpdate = Date.now();
        render();
        notifyRow();
        return true;
      } catch (error) {
        if (request.signal.aborted || !_enabled) return false;
        _lastError =
          error?.message || msg('Banking access monitor unavailable');
        notifyRow();
        return error?.retryable !== false;
      } finally {
        signal?.removeEventListener?.('abort', abort);
        if (_request === request) _request = null;
      }
    },
    destroy(viewer = _viewer) {
      layer.disable();
      clearTimeout(_restoreTimer);
      _visibility?.stop();
      _visibility = null;
      _manager = null;
      if (_dataSource) {
        viewer?.dataSources?.remove(_dataSource, true);
        _dataSource = null;
      }
      _viewer = null;
      _rowListener = null;
      _answer = null;
      _signature = null;
    },
    getRowControls() {
      const newsOn = _answer?.news?.enabled === true;
      const chips = [
        {
          id: 'mode-share',
          label: t('% POPULATION'),
          active: _mode === 'share',
          title: t('Shade by the share of the population affected'),
          onClick: () => {
            _mode = 'share';
            write('mode', _mode);
            render();
            notifyRow();
          },
        },
        {
          id: 'mode-people',
          label: t('PEOPLE'),
          active: _mode === 'people',
          title: t('Shade by the number of people affected'),
          onClick: () => {
            _mode = 'people';
            write('mode', _mode);
            render();
            notifyRow();
          },
        },
        {
          id: 'newest',
          label: t('NEWEST'),
          active: _newest,
          title: t('List the most recently updated first'),
          onClick: () => {
            _newest = !_newest;
            write('newest', _newest ? '1' : '0');
            notifyRow();
          },
        },
        {
          id: 'history',
          label: t('HISTORY'),
          active: _history,
          title: t('Also show past events, as grey outlines'),
          onClick: () => {
            _history = !_history;
            write('history', _history ? '1' : '0');
            notifyRow();
            void layer.update(_viewer);
          },
        },
      ];
      const chosen = countries().find((c) => c.iso3 === _selected);
      const url = chosen && leadOf(chosen)?.sources?.[0]?.url;
      if (url && /^https?:\/\//.test(url))
        chips.push({
          id: 'open-source',
          label: t('SOURCE ↗'),
          title: url,
          onClick: () =>
            globalThis.open?.(url, '_blank', 'noopener,noreferrer'),
        });
      if (newsOn)
        chips.push({
          id: 'news',
          label: t('NEWS LEADS'),
          active: _newsList,
          title: t('List unchecked news leads instead (never drawn)'),
          onClick: () => {
            _newsList = !_newsList;
            notifyRow();
          },
        });
      const legend = ['low', 'moderate', 'high', 'severe', 'minimal', 'unknown']
        .map((cls) => ({
          label: t(CLASS_TEXT[cls]),
          color: BANKING_CLASS_COLORS[cls],
          count: countries().filter((c) => !c.historical && classOf(c) === cls)
            .length,
        }))
        .filter((item, i) => i < 4 || item.count > 0);
      const systemicCount = countries().filter(
        (c) => c.systemic && !c.historical,
      ).length;
      if (systemicCount)
        legend.push({
          label: t('Systemic (border)'),
          color: SYSTEMIC_BORDER,
          count: systemicCount,
        });
      return {
        chips,
        info: _lastError ? translateFeedError(_lastError) : summaryLine(),
        infoTitle: t(BANKING_ACCESS_DISCLAIMER),
        list: {
          ariaLabel:
            _newsList && newsOn
              ? t('Unchecked news leads')
              : t('Countries affected'),
          items:
            _newsList && newsOn
              ? newsItems()
              : sorted().slice(0, MAX_LIST).map(countryItem),
        },
        legend,
      };
    },
    getStats() {
      return {
        count: countries().filter((c) => !c.historical).length,
        lastUpdate: _lastUpdate,
        error: _lastError,
        selected: _selected,
        fallback: false,
      };
    },
  };
  return layer;
}
