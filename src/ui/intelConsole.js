/**
 * Early-warning console (fork feature): the AUTOPILOT right-rail panel, event
 * markers, world-overlay labels and cards, and the Autopilot controller.
 *
 * Ownership: the pure scheduler (src/intel/scheduler.js) decides which
 * cluster deserves the next shot; this controller only executes a shot
 * through the application's navigation authority (`runImmediateNavigation`,
 * which honours Cockpit), exactly as other camera owners do. Any other
 * camera owner, manual pointer/wheel input or an operator selection pauses
 * Autopilot until the operator resumes it; it never silently retakes the
 * camera. The panel stays hidden unless the server reports the feature on.
 * Nothing runs while the tab is hidden; on return one step catches up.
 */
import * as Cesium from 'cesium';
import {
  formatNumber,
  formatRelativeTime,
  getLocale,
  msg,
  t,
  tn,
} from '../i18n/index.js';
import { greatCircleKm } from '../geoDistance.js';
import { createIntelClient } from '../intel/client.js';
import {
  frameCluster,
  GLOBAL_VIEW_HEIGHT,
  globeViewHeight,
  pullBackPlan,
} from '../intel/framing.js';
import {
  createSchedulerState,
  setSchedulerMode,
  stepScheduler,
} from '../intel/scheduler.js';
import { wrapCardText } from '../layers/ghostMaps/records.js';
import { formatQuantity } from './unitLabels.js';
import { createSpeechPlayer } from '../voice/localAudio.js';

const PANEL_ID = 'intel-panel';
const LABEL_SOURCE = 'intel-labels';
const CARD_SOURCE = 'intel-card';
const PICK_PREFIX = 'intel:';
const TICK_MS = 5_000;
const REFRESH_MS = 10_000;
const REPLAY_REFRESH_MS = 3_000;
const MAX_LABELS = 12;
const MAX_QUEUE_ROWS = 12;
const FLIGHT_SEC = 3.5;
// Two-stage move: turn the globe at the current height, then descend.
const PAN_SEC = 3;
const PULL_BACK_STEP_SEC = 2;
// Closer than this (km between view centres) the turn is skipped.
const PAN_MIN_KM = 50;
// Bounded waits for map tiles: after the turn, and before a shot's hold.
const PAN_WAIT_MS = 2_500;
const SETTLE_WAIT_MS = 4_000;
const TILE_POLL_MS = 200;
// Globe tiles kept in memory while Autopilot runs (Cesium's default is 100).
const TILE_CACHE = 300;
const DEMO_SPEED = 30;
// Per-browser memory of ON / OFF / PAUSED across page reloads.
const MODE_STORAGE_KEY = 'gev.intel.autopilotMode';
const RESTORABLE_MODES = new Set(['auto', 'paused', 'off']);

function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** The stored Autopilot mode, or null when absent or unreadable. */
export function readStoredMode(storage) {
  try {
    const stored = JSON.parse(storage?.getItem(MODE_STORAGE_KEY) ?? 'null');
    return RESTORABLE_MODES.has(stored?.mode)
      ? {
          mode: stored.mode,
          reason: typeof stored.reason === 'string' ? stored.reason : null,
        }
      : null;
  } catch {
    return null;
  }
}

export function writeStoredMode(storage, mode, reason = null) {
  try {
    storage?.setItem(MODE_STORAGE_KEY, JSON.stringify({ mode, reason }));
  } catch {
    // Private windows and blocked storage: the mode is simply not remembered.
  }
}

export const CATEGORY_COLORS = Object.freeze({
  natural_disaster: '#ff9f43',
  armed_conflict: '#ff5a5a',
  civil_unrest: '#f7d046',
  economic_stress: '#7bd88f',
  infrastructure_disruption: '#5ac8fa',
  public_health: '#c792ea',
  breaking_news: '#c9d1d9',
});
const CATEGORY_LABELS = Object.freeze({
  natural_disaster: msg('Natural disaster'),
  armed_conflict: msg('Armed conflict'),
  civil_unrest: msg('Civil unrest'),
  economic_stress: msg('Economic stress'),
  infrastructure_disruption: msg('Infrastructure'),
  public_health: msg('Public health'),
  breaking_news: msg('Breaking news'),
});
const VERIFICATION_LABELS = Object.freeze({
  unverified: msg('UNVERIFIED'),
  corroborated: msg('CORROBORATED'),
  officially_reported: msg('OFFICIAL'),
  disputed: msg('DISPUTED'),
  retracted: msg('RETRACTED'),
  resolved: msg('RESOLVED'),
});
const FEED_LABELS = Object.freeze({
  'usgs-earthquakes': msg('USGS earthquakes'),
  'ghostmaps-incidents': msg('S2 GhostMaps incidents'),
  'gdacs-alerts': msg('GDACS disaster alerts'),
  'tsunami-ptwc': msg('Pacific Tsunami Warning Center'),
  'tsunami-ntwc': msg('National Tsunami Warning Center'),
  'nws-alerts': msg('US weather alerts (NWS)'),
  'nasa-eonet': msg('NASA EONET natural events'),
  'who-don': msg('WHO disease outbreak news'),
  'worldbank-inflation': msg('World Bank inflation'),
  'reliefweb-disasters': msg('ReliefWeb disasters'),
  'acled-conflict': msg('ACLED conflict data'),
  'gdelt-events': msg('GDELT machine-coded news'),
});
const FEED_STATUS_LABELS = Object.freeze({
  healthy: msg('live'),
  degraded: msg('degraded'),
  stale: msg('stale'),
  offline: msg('offline'),
  disabled: msg('disabled'),
  requires_credentials: msg('needs a key'),
  blocked_by_terms: msg('blocked by terms'),
});
const PAUSE_REASONS = Object.freeze({
  manual_input: msg('Paused: you moved the map'),
  voice: msg('Paused by voice command'),
  camera_owner_changed: msg('Paused: another tool took the camera'),
  operator_selection: msg('Paused: you selected an event'),
  navigation_refused: msg('Paused: the camera is not available'),
});
const DECISION_REASONS = Object.freeze({
  highest_priority: msg('highest priority'),
  rotation: msg('next in rotation'),
  clearly_higher_priority: msg('clearly higher priority'),
  critical_interrupt: msg('critical interruption'),
  current_no_longer_eligible: msg('previous focus expired'),
  tour: msg('tour · nothing urgent right now'),
});
const TERM_LABELS = Object.freeze({
  severity: msg('severity'),
  corroboration: msg('sources'),
  freshness: msg('freshness'),
  escalation: msg('escalation'),
  impact: msg('impact'),
  relevance: msg('relevance'),
});
// Spoken (lower-case) verification words for narration and explanations.
const SPOKEN_VERIFICATION = Object.freeze({
  unverified: msg('unverified'),
  corroborated: msg('corroborated'),
  officially_reported: msg('officially reported'),
  disputed: msg('disputed'),
  retracted: msg('retracted'),
  resolved: msg('resolved'),
});
const MAX_NARRATION_CHARS = 420;

const SETTING_CHOICES = Object.freeze([
  ['minimumAttentionScore', msg('MIN'), [60, 70, 80], (v) => formatNumber(v)],
  [
    'groupingRadiusKm',
    msg('GROUP'),
    [400, 800, 1600],
    (v) => formatQuantity(v, 'km'),
  ],
  [
    'minimumDwellMs',
    msg('DWELL'),
    [15_000, 30_000, 60_000],
    (v) => formatQuantity(v / 1000, 's'),
  ],
  [
    'proximityRadiusKm',
    msg('NEAR'),
    [500, 1000, 2000],
    (v) => formatQuantity(v, 'km'),
  ],
  [
    'proximityDecayKm',
    msg('DECAY'),
    [200, 400, 800],
    (v) => formatQuantity(v, 'km'),
  ],
]);
const PLACE_NAMES = Object.freeze({
  home: msg('HOME'),
  family: msg('FAMILY'),
  travel: msg('TRAVEL'),
  custom: msg('CUSTOM'),
});
const PLACE_TEXT = Object.freeze({
  home: msg('Home'),
  family: msg('Family'),
  travel: msg('Travel'),
  custom: msg('Custom place'),
});

const el = (doc, tag, className, text) => {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** Minutes-ago text in the UI language. */
export function ageText(ms, now) {
  const minutes = Math.round((now - ms) / 60_000);
  if (Math.abs(minutes) < 60) return formatRelativeTime(-minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 48) return formatRelativeTime(-hours, 'hour');
  return formatRelativeTime(-Math.round(hours / 24), 'day');
}

/** `koboldcpp/Qwen3.6-35B-A3B-Q4_K_M` → `Qwen3.6-35B-A3B`. */
export function modelName(id) {
  const name = String(id ?? '')
    .split('/')
    .pop();
  return name.replace(/[-_.]Q\d[\w]*$/i, '') || '?';
}

/** The three largest score contributions, for "why this event?". */
export function whyText(event) {
  const terms = [...(event.explanation?.attention ?? [])]
    .sort((a, b) => b.contribution - a.contribution)
    .slice(0, 3)
    .map(
      ({ term, contribution }) =>
        `${t(TERM_LABELS[term] ?? term)} ${formatNumber(Math.round(contribution))}`,
    );
  return terms.join(' · ');
}

/**
 * @param {{viewer: object, navigation: object, overlayHost: object,
 *   picking?: object, pointer?: object, documentRef?: Document,
 *   fetchImpl?: Function, now?: () => number, storage?: Storage | null,
 *   openExternal?: (url: string) => void}} options
 */
export function createIntelConsole({
  viewer,
  navigation,
  overlayHost,
  picking,
  pointer,
  documentRef = document,
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  storage = defaultStorage(),
  openExternal = (url) => window.open(url, '_blank', 'noopener,noreferrer'),
}) {
  const client = createIntelClient({ fetchImpl });
  const panel = documentRef.getElementById(PANEL_ID);
  const body = documentRef.getElementById(`${PANEL_ID}-body`);
  const count = documentRef.getElementById(`${PANEL_ID}-count`);
  const abort = new AbortController();
  let destroyed = false;
  let enabled = false;
  let world = 'live';
  let data = { events: [], clusters: [], now: now() };
  let feeds = [];
  let ai = null;
  // Narration (local text-to-speech): offered only when this server has it.
  let voice = { tts: false };
  const speech = createSpeechPlayer();
  const narrated = new Map(); // event id -> revision already narrated
  let narration = null; // {token, text}
  let settings = {};
  let lastFetchAt = 0;
  let refreshGeneration = 0;
  let timer = null;
  let scheduler = createSchedulerState();
  let lastDecision = null;
  let selectedId = null;
  let claiming = false;
  let flightSeq = 0;
  let pullBackTimers = [];
  let storedMode = null; // last mode written to storage
  let modeRestored = false; // nothing is written before the stored mode is read
  let notice = '';
  let placeSlot = 'home'; // which place the PLACES buttons set
  let placeNote = ''; // outcome of the last PLACES action, shown in the row
  let points = null;
  let clickHandler = null;
  let history = null; // null = hidden, [] = shown

  // ---------------------------------------------------------------- panel DOM
  const ui = {};
  function buildPanel() {
    body.replaceChildren();
    const mode = el(documentRef, 'div', 'intel-row intel-mode');
    ui.modeButton = el(
      documentRef,
      'button',
      'intel-mode-btn data-toggle-chip',
    );
    ui.modeButton.type = 'button';
    ui.modeButton.addEventListener('click', () => toggleAutopilot());
    ui.resume = el(
      documentRef,
      'button',
      'intel-resume-btn data-toggle-chip',
      t('RESUME'),
    );
    ui.resume.type = 'button';
    ui.resume.addEventListener('click', () => resume());
    ui.modeText = el(documentRef, 'span', 'intel-mode-text');
    mode.append(ui.modeButton, ui.resume, ui.modeText);

    const worlds = el(documentRef, 'div', 'intel-row intel-worlds');
    ui.live = el(documentRef, 'button', 'data-toggle-chip', t('LIVE'));
    ui.live.type = 'button';
    ui.live.addEventListener('click', () => setWorld('live'));
    ui.demo = el(documentRef, 'button', 'data-toggle-chip', t('DEMO DRILL'));
    ui.demo.type = 'button';
    ui.demo.title = t('Replay a synthetic drill; nothing in it is real');
    ui.demo.addEventListener('click', () => startDemo());
    ui.worldText = el(documentRef, 'span', 'intel-muted');
    worlds.append(ui.live, ui.demo, ui.worldText);

    ui.focus = el(documentRef, 'div', 'intel-focus');
    ui.notice = el(documentRef, 'div', 'intel-notice');
    ui.notice.setAttribute('role', 'status');
    ui.caption = el(documentRef, 'div', 'intel-caption');
    ui.caption.hidden = true;
    ui.caption.setAttribute('aria-live', 'polite');
    ui.captionText = el(documentRef, 'span', 'intel-caption-text');
    ui.skip = el(
      documentRef,
      'button',
      'data-toggle-chip intel-skip',
      t('SKIP'),
    );
    ui.skip.type = 'button';
    ui.skip.addEventListener('click', () => stopNarration());
    ui.caption.append(ui.captionText, ui.skip);

    ui.queueTitle = el(
      documentRef,
      'div',
      'intel-section panel-title',
      t('PRIORITY QUEUE'),
    );
    ui.queue = el(documentRef, 'ol', 'intel-queue');
    ui.queue.setAttribute('aria-label', t('Events by attention score'));

    ui.settingsTitle = el(
      documentRef,
      'div',
      'intel-section panel-title',
      t('CAMERA RULES'),
    );
    ui.settings = el(documentRef, 'div', 'intel-settings');
    ui.categories = el(documentRef, 'div', 'intel-categories');

    ui.feedsTitle = el(
      documentRef,
      'div',
      'intel-section panel-title',
      t('FEEDS'),
    );
    ui.feeds = el(documentRef, 'ul', 'intel-feeds');
    ui.ai = el(documentRef, 'div', 'intel-muted intel-ai');

    const historyRow = el(documentRef, 'div', 'intel-row');
    ui.historyButton = el(
      documentRef,
      'button',
      'data-toggle-chip',
      t('HISTORY'),
    );
    ui.historyButton.type = 'button';
    ui.historyButton.addEventListener('click', () => toggleHistory());
    historyRow.append(ui.historyButton);
    ui.history = el(documentRef, 'ol', 'intel-history');
    ui.history.hidden = true;

    body.append(
      mode,
      worlds,
      ui.focus,
      ui.notice,
      ui.caption,
      ui.queueTitle,
      ui.queue,
      ui.settingsTitle,
      ui.settings,
      ui.categories,
      ui.feedsTitle,
      ui.feeds,
      ui.ai,
      historyRow,
      ui.history,
    );
  }

  const eventsById = () => new Map(data.events.map((e) => [e.event_id, e]));

  function renderMode() {
    const mode = scheduler.mode;
    ui.modeButton.textContent =
      mode === 'off' ? t('AUTOPILOT OFF') : t('AUTOPILOT ON');
    ui.modeButton.setAttribute('aria-pressed', String(mode !== 'off'));
    ui.modeButton.classList.toggle('active', mode !== 'off');
    ui.resume.hidden = mode !== 'paused';
    const modeLabels = {
      paused: PAUSE_REASONS[scheduler.pauseReason] ?? msg('Paused'),
      auto: msg('Following the highest-priority events'),
      off: msg('Manual camera'),
    };
    const modeLabel = t(modeLabels[mode]);
    ui.modeText.textContent = modeLabel;
    panel.dataset.autopilot = mode;
  }

  function renderWorld() {
    ui.live.classList.toggle('active', world === 'live');
    ui.demo.classList.toggle('active', world === 'replay');
    ui.worldText.textContent =
      world === 'replay'
        ? t('Synthetic drill · {speed}× speed', {
            speed: formatNumber(DEMO_SPEED),
          })
        : t('Live public feeds');
  }

  function renderFocus() {
    const byId = eventsById();
    const current = scheduler.current;
    const top = current ? byId.get(current.key) : null;
    ui.focus.replaceChildren();
    if (!top) {
      ui.focus.append(
        el(
          documentRef,
          'div',
          'intel-muted',
          scheduler.mode === 'auto'
            ? t('Nothing meets the camera rules; holding a global view')
            : t('Select an event or turn Autopilot on'),
        ),
      );
      return;
    }
    const others = current.eventIds.length - 1;
    ui.focus.append(
      el(documentRef, 'div', 'intel-focus-title', top.title),
      el(
        documentRef,
        'div',
        'intel-muted',
        [
          t(DECISION_REASONS[lastDecision?.reason] ?? msg('in focus')),
          others > 0
            ? tn(others, '+{count} nearby event', '+{count} nearby events', {
                count: formatNumber(others),
              })
            : null,
        ]
          .filter(Boolean)
          .join(' · '),
      ),
      el(
        documentRef,
        'div',
        'intel-muted',
        t('Why: {terms}', { terms: whyText(top) }),
      ),
    );
  }

  function badge(text, className) {
    return el(documentRef, 'span', `intel-badge ${className}`, text);
  }

  function renderQueue() {
    const at = data.now ?? now();
    const rows = data.events.slice(0, MAX_QUEUE_ROWS).map((event) => {
      const row = el(documentRef, 'li', 'intel-queue-row');
      row.dataset.eventId = event.event_id;
      row.classList.toggle('selected', event.event_id === selectedId);
      row.classList.toggle(
        'focused',
        scheduler.current?.eventIds.includes(event.event_id) ?? false,
      );
      row.style.setProperty(
        '--intel-accent',
        CATEGORY_COLORS[event.category] ?? '#ccc',
      );
      row.style.opacity = String(Math.max(0.35, event.opacity ?? 1));
      const button = el(documentRef, 'button', 'intel-queue-btn');
      button.type = 'button';
      button.title = t('Show this event (pauses Autopilot)');
      const score = el(
        documentRef,
        'span',
        'intel-score',
        formatNumber(event.attention_score),
      );
      const main = el(documentRef, 'span', 'intel-queue-main');
      main.append(
        el(documentRef, 'span', 'intel-queue-title', displayTitle(event).text),
        el(
          documentRef,
          'span',
          'intel-muted',
          [
            t(CATEGORY_LABELS[event.category] ?? msg('Event')),
            ageText(event.last_meaningful_update_at, at),
            t('confidence {value}', {
              value: formatNumber(event.confidence, { style: 'percent' }),
            }),
            event.camera_eligible ? null : t('not a camera target'),
            event.proximity?.weight > 0
              ? t('{distance} from {place}', {
                  distance: formatQuantity(event.proximity.km, 'km'),
                  place: t(PLACE_TEXT[event.proximity.place] ?? msg('Home')),
                })
              : null,
          ]
            .filter(Boolean)
            .join(' · '),
        ),
      );
      const badges = el(documentRef, 'span', 'intel-badges');
      badges.append(
        badge(
          t(VERIFICATION_LABELS[event.verification] ?? msg('UNVERIFIED')),
          `v-${event.verification}`,
        ),
      );
      if (event.synthetic) badges.append(badge(t('DRILL'), 'v-drill'));
      if (event.model_applied) badges.append(badge(t('AI'), 'v-ai'));
      if (event.escalation === 'increasing')
        badges.append(badge('▲', 'v-rising'));
      button.append(score, main, badges);
      button.addEventListener('click', () =>
        selectEvent(event.event_id, { fly: true }),
      );
      row.append(button);
      return row;
    });
    ui.queue.replaceChildren(...rows);
    if (!rows.length)
      ui.queue.append(
        el(documentRef, 'li', 'intel-muted', t('No active events')),
      );
    if (count) count.textContent = formatNumber(data.events.length);
  }

  /** PLACES: pick a slot, then set it from the map centre or this device. */
  function renderPlaces() {
    const row = el(documentRef, 'div', 'intel-setting intel-places');
    row.append(el(documentRef, 'span', 'intel-setting-label', t('PLACES')));
    const places = settings.homeLocations ?? [];
    const placeOf = (label) => places.find((p) => p.label === label) ?? null;
    for (const label of Object.keys(PLACE_NAMES)) {
      const chip = el(
        documentRef,
        'button',
        'data-toggle-chip',
        `${placeOf(label) ? '● ' : ''}${t(PLACE_NAMES[label])}`,
      );
      chip.type = 'button';
      chip.classList.toggle('active', placeSlot === label);
      chip.setAttribute('aria-pressed', String(placeSlot === label));
      chip.addEventListener('click', () => {
        placeSlot = label;
        placeNote = '';
        renderSettings();
      });
      row.append(chip);
    }
    const current = placeOf(placeSlot);
    // One action under the chips: the selected place becomes the map centre.
    // The value names the slot it acts on, so what is set where is no guess.
    const line = el(documentRef, 'div', 'intel-place-line');
    const set = el(
      documentRef,
      'button',
      'data-toggle-chip intel-place-action',
      t('AT MAP CENTRE'),
    );
    set.type = 'button';
    set.title = t(
      'Set the selected place to the point at the centre of the map',
    );
    set.addEventListener('click', () => {
      const point = mapCentre();
      if (point) setPlace(placeSlot, point);
      else {
        placeNote = t('Point the map at the globe first');
        renderSettings();
      }
    });
    line.append(
      set,
      el(
        documentRef,
        'span',
        'intel-muted',
        `${t(PLACE_TEXT[placeSlot])}: ${current ? coordText(current) : t('not set')}`,
      ),
    );
    if (placeNote)
      line.append(el(documentRef, 'span', 'intel-place-note', placeNote));
    row.append(line);
    return row;
  }

  const coordText = ({ lat, lon }) =>
    `${formatNumber(Math.abs(lat))}°${lat < 0 ? 'S' : 'N'} ${formatNumber(Math.abs(lon))}°${lon < 0 ? 'W' : 'E'}`;

  function mapCentre() {
    const canvas = viewer.scene?.canvas;
    const centre =
      canvas &&
      viewer.camera?.pickEllipsoid?.(
        new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2),
      );
    if (!centre) return null;
    const carto = Cesium.Cartographic.fromCartesian(centre);
    return {
      lat: Cesium.Math.toDegrees(carto.latitude),
      lon: Cesium.Math.toDegrees(carto.longitude),
    };
  }

  async function setPlace(label, { lat, lon }) {
    const places = (settings.homeLocations ?? []).filter(
      (p) => p.label !== label,
    );
    placeSlot = label;
    placeNote = '';
    await changeSettings({ homeLocations: [...places, { label, lat, lon }] });
    const saved = settings.homeLocations?.find((p) => p.label === label);
    placeNote = saved
      ? t('{place} saved: {position}', {
          place: t(PLACE_TEXT[label]),
          position: coordText(saved),
        })
      : notice || t('Could not save the camera rules');
    renderSettings();
  }

  function renderSettings() {
    const rows = SETTING_CHOICES.map(([key, label, values, format]) => {
      const row = el(documentRef, 'div', 'intel-setting');
      row.append(el(documentRef, 'span', 'intel-setting-label', t(label)));
      for (const value of values) {
        const chip = el(
          documentRef,
          'button',
          'data-toggle-chip',
          format(value),
        );
        chip.type = 'button';
        chip.classList.toggle('active', settings[key] === value);
        chip.setAttribute('aria-pressed', String(settings[key] === value));
        chip.addEventListener('click', () => changeSettings({ [key]: value }));
        row.append(chip);
      }
      return row;
    });
    const critical = el(documentRef, 'div', 'intel-setting');
    critical.append(
      el(documentRef, 'span', 'intel-setting-label', t('CRITICAL')),
    );
    const allow = settings.criticalInterruptThreshold <= 100;
    const chip = el(
      documentRef,
      'button',
      'data-toggle-chip',
      allow ? t('INTERRUPTS ON') : t('INTERRUPTS OFF'),
    );
    chip.type = 'button';
    chip.classList.toggle('active', allow);
    chip.addEventListener('click', () =>
      changeSettings({ criticalInterruptThreshold: allow ? 101 : 95 }),
    );
    critical.append(chip);
    const local = el(documentRef, 'div', 'intel-setting');
    local.append(el(documentRef, 'span', 'intel-setting-label', t('LOCAL AI')));
    const aiOn = settings.localAiEnabled !== false;
    const aiChip = el(
      documentRef,
      'button',
      'data-toggle-chip',
      aiOn ? t('ON') : t('OFF'),
    );
    aiChip.type = 'button';
    aiChip.classList.toggle('active', aiOn);
    aiChip.setAttribute('aria-pressed', String(aiOn));
    aiChip.title = t(
      'Let the local model assess events (scores stay rule-based when off)',
    );
    aiChip.addEventListener('click', () =>
      changeSettings({ localAiEnabled: !aiOn }),
    );
    local.append(aiChip);
    const tourRow = el(documentRef, 'div', 'intel-setting');
    tourRow.append(el(documentRef, 'span', 'intel-setting-label', t('TOUR')));
    const tourOn = settings.tourWhenIdle !== false;
    const tourChip = el(
      documentRef,
      'button',
      'data-toggle-chip',
      tourOn ? t('ON') : t('OFF'),
    );
    tourChip.type = 'button';
    tourChip.classList.toggle('active', tourOn);
    tourChip.setAttribute('aria-pressed', String(tourOn));
    tourChip.title = t(
      'When nothing is urgent, slowly visit other active events in turn',
    );
    tourChip.addEventListener('click', () =>
      changeSettings({ tourWhenIdle: !tourOn }),
    );
    tourRow.append(tourChip);
    const zoomRow = el(documentRef, 'div', 'intel-setting');
    zoomRow.append(
      el(documentRef, 'span', 'intel-setting-label', t('ZOOM OUT')),
    );
    const zoomOn = settings.pullBackEnabled !== false;
    const zoomChip = el(
      documentRef,
      'button',
      'data-toggle-chip',
      zoomOn ? t('ON') : t('OFF'),
    );
    zoomChip.type = 'button';
    zoomChip.classList.toggle('active', zoomOn);
    zoomChip.setAttribute('aria-pressed', String(zoomOn));
    zoomChip.title = t(
      'After each event, zoom out step by step until the whole globe is in view',
    );
    zoomChip.addEventListener('click', () =>
      changeSettings({ pullBackEnabled: !zoomOn }),
    );
    zoomRow.append(zoomChip);
    const narrationRow = el(documentRef, 'div', 'intel-setting');
    if (voice.tts) {
      narrationRow.append(
        el(documentRef, 'span', 'intel-setting-label', t('NARRATION')),
      );
      const on = settings.narrationEnabled === true;
      const narrationChip = el(
        documentRef,
        'button',
        'data-toggle-chip',
        on ? t('ON') : t('OFF'),
      );
      narrationChip.type = 'button';
      narrationChip.classList.toggle('active', on);
      narrationChip.setAttribute('aria-pressed', String(on));
      narrationChip.title = t(
        'Speak a short briefing when Autopilot shows a new event (local speech)',
      );
      narrationChip.addEventListener('click', () => {
        if (on) stopNarration();
        changeSettings({ narrationEnabled: !on });
      });
      narrationRow.append(narrationChip);
    }
    const placesRow = renderPlaces();
    ui.settings.replaceChildren(
      ...rows,
      placesRow,
      critical,
      tourRow,
      zoomRow,
      ...(voice.tts ? [narrationRow] : []),
      local,
    );

    const relevance = settings.categoryRelevance ?? {};
    const chips = Object.keys(CATEGORY_LABELS).map((category) => {
      const on = relevance[category] !== 0;
      const button = el(
        documentRef,
        'button',
        'data-toggle-chip intel-category',
        t(CATEGORY_LABELS[category]),
      );
      button.type = 'button';
      button.style.setProperty('--intel-accent', CATEGORY_COLORS[category]);
      button.classList.toggle('active', on);
      button.setAttribute('aria-pressed', String(on));
      button.title = t('Include this category in Autopilot');
      button.addEventListener('click', () =>
        changeSettings({
          categoryRelevance: { ...relevance, [category]: on ? 0 : 100 },
        }),
      );
      return button;
    });
    ui.categories.replaceChildren(...chips);
  }

  /**
   * The title in the reader's language: a local-model translation when the
   * source language differs and one exists (flagged), else the original.
   */
  function displayTitle(event) {
    const assessment = event.model_applied ? event.assessment : null;
    const lang = String(getLocale() || 'en').slice(0, 2);
    const source = String(event.language || 'und').slice(0, 2);
    const translated =
      lang === 'ru'
        ? assessment?.title_ru
        : lang === 'en'
          ? assessment?.title_en
          : null;
    if (translated && source !== lang)
      return { text: translated, translated: true };
    return { text: event.title, translated: false };
  }

  function renderAi() {
    const state = ai?.state ?? 'not_configured';
    const values = {
      model: modelName(ai?.model),
      count: formatNumber(ai?.assessed ?? 0),
    };
    const text =
      state === 'online'
        ? t('Local AI: {model} · ready · {count} assessed', values)
        : state === 'busy'
          ? t('Local AI: {model} · working · {count} assessed', values)
          : state === 'paused'
            ? t('Local AI: paused · rule-based scoring')
            : state === 'not_configured'
              ? t('Local AI: not configured · rule-based scoring')
              : t('Local AI: offline · rule-based scoring');
    ui.ai.textContent = text;
    ui.ai.title = ai?.last_error ?? '';
    ui.ai.dataset.state = state;
  }

  function renderFeeds() {
    const at = now();
    ui.feeds.replaceChildren(
      ...feeds.map((feed) => {
        const row = el(documentRef, 'li', `intel-feed s-${feed.status}`);
        const status = FEED_STATUS_LABELS[feed.status] ?? msg('unknown');
        const line = [
          t(FEED_LABELS[feed.id] ?? msg('Feed')),
          t(status),
          feed.latest_observation_at
            ? t('newest {age}', {
                age: ageText(feed.latest_observation_at, at),
              })
            : null,
        ]
          .filter(Boolean)
          .join(' · ');
        row.textContent = line;
        if (feed.last_error) row.title = feed.last_error;
        return row;
      }),
    );
  }

  function renderHistory() {
    ui.history.hidden = history === null;
    ui.historyButton.classList.toggle('active', history !== null);
    if (history === null) return;
    const at = now();
    ui.history.replaceChildren(
      ...history.map((event) =>
        el(
          documentRef,
          'li',
          'intel-history-row',
          `${ageText(event.last_meaningful_update_at, at)} · ${event.title}`,
        ),
      ),
    );
  }

  function rememberMode() {
    if (!modeRestored) return;
    const key = `${scheduler.mode}:${scheduler.pauseReason ?? ''}`;
    if (key === storedMode) return;
    storedMode = key;
    writeStoredMode(storage, scheduler.mode, scheduler.pauseReason);
  }

  function render() {
    if (destroyed || !enabled) return;
    rememberMode();
    syncBuffering();
    renderMode();
    renderWorld();
    renderFocus();
    ui.notice.textContent = notice;
    renderQueue();
    renderFeeds();
    renderAi();
    renderMarkers();
    renderCard();
  }

  // ----------------------------------------------------------- globe output
  function ensurePoints() {
    if (points || !viewer?.scene) return points;
    points = viewer.scene.primitives.add(new Cesium.PointPrimitiveCollection());
    return points;
  }

  function renderMarkers() {
    const collection = ensurePoints();
    if (!collection) return;
    collection.removeAll();
    const limit = settings.maxMarkersInView ?? 200;
    const located = data.events.filter(
      (e) => e.location?.lat !== null && e.location?.lat !== undefined,
    );
    for (const event of located.slice(0, limit)) {
      const color = Cesium.Color.fromCssColorString(
        CATEGORY_COLORS[event.category] ?? '#cccccc',
      );
      const focused = scheduler.current?.eventIds.includes(event.event_id);
      collection.add({
        id: `${PICK_PREFIX}${event.event_id}`,
        position: Cesium.Cartesian3.fromDegrees(
          event.location.lon,
          event.location.lat,
          500,
        ),
        color: color.withAlpha(Math.max(0.15, event.opacity ?? 1)),
        pixelSize:
          7 + Math.round((event.attention_score / 100) * 9) + (focused ? 4 : 0),
        outlineColor:
          event.verification === 'officially_reported' ||
          event.verification === 'corroborated'
            ? Cesium.Color.WHITE.withAlpha(event.opacity ?? 1)
            : Cesium.Color.BLACK.withAlpha(0.6 * (event.opacity ?? 1)),
        outlineWidth: focused ? 3 : 1.5,
      });
    }
    const labels = located.slice(0, MAX_LABELS).map((event, index) => ({
      id: `intel-label:${event.event_id}`,
      position: Cesium.Cartesian3.fromDegrees(
        event.location.lon,
        event.location.lat,
        500,
      ),
      variant: 'label',
      paintLane: 'ambient-label',
      title:
        `${formatNumber(event.attention_score)} · ${displayTitle(event).text}`.slice(
          0,
          80,
        ),
      details: [
        [
          t(VERIFICATION_LABELS[event.verification] ?? msg('UNVERIFIED')),
          event.synthetic ? t('DRILL') : null,
        ]
          .filter(Boolean)
          .join(' · '),
      ],
      accent: CATEGORY_COLORS[event.category] ?? '#cccccc',
      sourceAlpha: () => Math.max(0.2, event.opacity ?? 1),
      anchorDot: false,
      priority: 10_000 - index,
      horizonCull: true,
      collisionGroup: 'intel-labels',
      maxDistance: 30_000_000,
    }));
    overlayHost.setEntries(LABEL_SOURCE, labels, {
      maxVisible: MAX_LABELS,
      collisionCapacity: 24,
    });
    viewer.scene.requestRender?.();
  }

  let cardDetail = null; // {event, evidence}
  function renderCard() {
    const shown = selectedId ?? scheduler.current?.key ?? null;
    const event = shown ? eventsById().get(shown) : null;
    if (
      !event ||
      event.location?.lat === null ||
      event.location?.lat === undefined
    ) {
      overlayHost.setEntries(CARD_SOURCE, [], { maxVisible: 1 });
      return;
    }
    const at = data.now ?? now();
    const link =
      cardDetail?.event.event_id === event.event_id
        ? firstLink(cardDetail)
        : null;
    const details = [
      [
        t(CATEGORY_LABELS[event.category] ?? msg('Event')),
        t(VERIFICATION_LABELS[event.verification] ?? msg('UNVERIFIED')),
        t('confidence {value}', {
          value: formatNumber(event.confidence, { style: 'percent' }),
        }),
      ].join(' · '),
      [
        t('updated {age}', {
          age: ageText(event.last_meaningful_update_at, at),
        }),
        tn(
          event.explanation?.independent_sources ?? 0,
          '{count} independent source',
          '{count} independent sources',
          {
            count: formatNumber(event.explanation?.independent_sources ?? 0),
          },
        ),
      ].join(' · '),
      ...wrapCardText(event.summary || '', 60, 3),
      t('Why: {terms}', { terms: whyText(event) }),
    ];
    if (event.synthetic)
      details.unshift(t('SYNTHETIC DRILL · not a real event'));
    if (event.critical_blocked)
      details.push(t('Held below critical: not corroborated'));
    if (!event.camera_eligible) {
      // Say why it is not an alert: evidence, age or the operator's filter.
      const note =
        event.confidence < (settings.minimumCameraConfidence ?? 0.35)
          ? msg('Candidate only: too little evidence for the camera')
          : event.lifecycle !== 'active'
            ? msg('Past its focus window: not an alert')
            : settings.categoryRelevance?.[event.category] === 0
              ? msg('Category filtered out of Autopilot')
              : msg('not a camera target');
      details.push(t(note));
    }
    const attribution =
      cardDetail?.event.event_id === event.event_id
        ? attributionOf(cardDetail)
        : null;
    const assessment = event.model_applied ? event.assessment : null;
    if (assessment) {
      details.push(
        ...wrapCardText(
          t('Local AI ({model}): {summary}', {
            model: modelName(assessment.model),
            summary: assessment.summary,
          }),
          60,
          3,
        ),
      );
      if (assessment.uncertainties?.[0])
        details.push(
          ...wrapCardText(
            t('Gap: {text}', { text: assessment.uncertainties[0] }),
            60,
            1,
          ),
        );
    }
    if (displayTitle(event).translated)
      details.push(t('Title: machine translation'));
    if (attribution) details.push(...wrapCardText(attribution, 60, 2));
    if (link) details.push(t('Source ↗ · click card to open'));
    const card = {
      id: `intel-card:${event.event_id}`,
      variant: 'card',
      selected: true,
      interactive: Boolean(link),
      title: displayTitle(event).text.slice(0, 90),
      details,
      accent: CATEGORY_COLORS[event.category] ?? '#cccccc',
      priority: Number.MAX_SAFE_INTEGER,
      gapPx: 15,
      verticalOnly: true,
      placement: 'above',
      stateless: true,
      horizonCull: true,
      position: Cesium.Cartesian3.fromDegrees(
        event.location.lon,
        event.location.lat,
        500,
      ),
    };
    if (link) {
      card.accessibilityLabel = t('Open the source for {title}', {
        title: card.title,
      });
      card.activate = () => {
        openExternal(link);
        return true;
      };
    }
    overlayHost.setEntries(CARD_SOURCE, [card], { maxVisible: 1 });
    overlayHost.setVisible?.(CARD_SOURCE, true);
  }

  const firstLink = (detail) =>
    detail.evidence
      .map((item) => item.observation.url)
      .find((url) => /^https:\/\//.test(url ?? '')) ?? null;
  const attributionOf = (detail) =>
    [
      ...new Set(
        detail.evidence
          .map((item) => item.observation.attribution)
          .filter(Boolean),
      ),
    ]
      .slice(0, 2)
      .join(' · ');

  async function loadDetail(id) {
    try {
      cardDetail = await client.detail(id, world, abort.signal);
    } catch {
      cardDetail = null;
    }
    renderCard();
  }

  // ----------------------------------------------------------------- camera
  function navigate(shot, duration, maximumHeight, complete) {
    claiming = true;
    let accepted;
    try {
      accepted = navigation.runImmediateNavigation('target', () => {
        viewer.camera.flyTo({
          destination: Cesium.Cartesian3.fromDegrees(
            shot.lon,
            shot.lat,
            shot.height,
          ),
          orientation: { heading: 0, pitch: -Cesium.Math.PI_OVER_TWO, roll: 0 },
          duration,
          maximumHeight,
          easingFunction: Cesium.EasingFunction.QUADRATIC_IN_OUT,
          complete,
        });
        return true;
      });
    } finally {
      claiming = false;
    }
    return accepted !== false;
  }

  /** Globe tiles and every shown 3D tileset loaded for the current view. */
  function viewLoaded() {
    const scene = viewer.scene;
    if (scene?.globe?.show && scene.globe.tilesLoaded === false) return false;
    const primitives = scene?.primitives;
    for (let i = 0; i < (primitives?.length ?? 0); i += 1) {
      const primitive = primitives.get(i);
      if (primitive?.show && primitive.tilesLoaded === false) return false;
    }
    return true;
  }

  /** Calls `done` once the view has loaded, or after `maxMs` regardless. */
  function whenViewLoaded(maxMs, done) {
    const until = Date.now() + maxMs;
    const check = () => {
      if (destroyed) return;
      if (viewLoaded() || Date.now() >= until) done();
      else pullBackTimers.push(setTimeout(check, TILE_POLL_MS));
    };
    check();
  }

  /**
   * Keep more tiles while Autopilot runs (the whole-globe view and recent
   * places are not fetched again) and load neighbouring tiles ahead of a
   * turn; the app's own values come back when Autopilot stops.
   */
  let bufferingSaved = null;
  function syncBuffering() {
    const globe = viewer.scene?.globe;
    if (!globe) return;
    const want = scheduler.mode === 'auto';
    if (want && !bufferingSaved) {
      bufferingSaved = {
        tileCacheSize: globe.tileCacheSize,
        preloadSiblings: globe.preloadSiblings,
      };
      globe.tileCacheSize = Math.max(globe.tileCacheSize ?? 0, TILE_CACHE);
      globe.preloadSiblings = true;
    } else if (!want && bufferingSaved) {
      Object.assign(globe, bufferingSaved);
      bufferingSaved = null;
    }
  }

  /**
   * Fly to a shot. With `pan`, a distant target is first brought to the
   * centre at the current height (never lower than the shot); once that view
   * has loaded the camera descends. `onSettled(ms)` runs when the shot's own
   * tiles have loaded (or after a bounded wait), with the time since the
   * flight began; a newer or cancelled flight ends the sequence.
   * Returns false when navigation was refused.
   */
  function flyTo(
    shot,
    { pan = false, duration = FLIGHT_SEC, onSettled = null } = {},
  ) {
    if (!shot) return false;
    const seq = ++flightSeq;
    const began = Date.now();
    const current = () => seq === flightSeq && !destroyed;
    const descend = () =>
      navigate(shot, duration, undefined, () => {
        if (current() && onSettled)
          whenViewLoaded(SETTLE_WAIT_MS, () => {
            if (current()) onSettled(Date.now() - began);
          });
      });
    const carto = viewer.camera?.positionCartographic;
    const fromHeight = carto?.height ?? 0;
    const panHeight = Math.max(fromHeight, shot.height);
    const far =
      carto &&
      greatCircleKm(
        {
          lat: Cesium.Math.toDegrees(carto.latitude),
          lon: Cesium.Math.toDegrees(carto.longitude),
        },
        shot,
      ) > PAN_MIN_KM;
    if (!pan || !far || panHeight <= shot.height * 1.05) return descend();
    return navigate(
      { lat: shot.lat, lon: shot.lon, height: panHeight },
      PAN_SEC,
      panHeight,
      () => {
        if (current())
          whenViewLoaded(PAN_WAIT_MS, () => {
            if (current()) descend();
          });
      },
    );
  }

  function cancelPullBack() {
    for (const id of pullBackTimers) clearTimeout(id);
    pullBackTimers = [];
  }

  /**
   * After a shot settles (`settledMs` after it began), zoom out in steps
   * until the whole globe shows.
   */
  function schedulePullBack(shot, settledMs, tour) {
    if (!shot || settings.pullBackEnabled === false) return;
    const canvas = viewer.scene?.canvas;
    const hold = settings.pullBackHoldMs ?? 10_000;
    const plan = pullBackPlan(shot.height, {
      spanMs: tour
        ? (settings.tourDwellMs ?? 45_000)
        : (settings.minimumDwellMs ?? 30_000),
      // Alerts stay close a little longer before pulling back.
      holdMs: settledMs + (tour ? hold : hold * 1.5),
      stepMs: settings.pullBackStepMs ?? 5_000,
      endHeight: globeViewHeight({
        fovRad: viewer.camera?.frustum?.fov ?? Math.PI / 3,
        aspect:
          canvas?.clientWidth && canvas?.clientHeight
            ? canvas.clientWidth / canvas.clientHeight
            : 16 / 9,
      }),
    });
    const shotKey = scheduler.current?.key;
    const shotStart = scheduler.current?.startedAt;
    for (const stepPlan of plan)
      pullBackTimers.push(
        setTimeout(() => {
          const sameShot =
            scheduler.mode === 'auto' &&
            scheduler.current?.key === shotKey &&
            scheduler.current?.startedAt === shotStart;
          if (destroyed || !sameShot) return cancelPullBack();
          if (documentRef.hidden) return;
          flightSeq += 1; // supersedes any unfinished two-stage flight
          navigate(
            { lat: shot.lat, lon: shot.lon, height: stepPlan.height },
            PULL_BACK_STEP_SEC,
          );
        }, stepPlan.atMs - settledMs),
      );
  }

  function shotFor(cluster) {
    const byId = eventsById();
    const canvas = viewer.scene?.canvas;
    return frameCluster(cluster, {
      precisions: cluster.event_ids
        .map((id) => byId.get(id)?.location?.precision)
        .filter(Boolean),
      fovRad: viewer.camera?.frustum?.fov ?? Math.PI / 3,
      aspect:
        canvas?.clientWidth && canvas?.clientHeight
          ? canvas.clientWidth / canvas.clientHeight
          : 16 / 9,
    });
  }

  const localeLang = () =>
    String(getLocale() || 'en').startsWith('ru') ? 'ru' : 'en';

  /** A short, grounded briefing: what, how sure, how recent; no speculation. */
  function narrationText(event, others = 0) {
    const at = data.now ?? now();
    const parts = [];
    if (event.synthetic) parts.push(t('Drill.'));
    parts.push(
      `${t(CATEGORY_LABELS[event.category] ?? msg('Event'))}: ${displayTitle(event).text}.`,
    );
    parts.push(
      t('{verification}, confidence {value}.', {
        verification: t(
          SPOKEN_VERIFICATION[event.verification] ?? msg('unverified'),
        ),
        value: formatNumber(event.confidence, { style: 'percent' }),
      }),
    );
    const sources = event.explanation?.independent_sources ?? 0;
    parts.push(
      tn(
        sources,
        '{count} independent source.',
        '{count} independent sources.',
        {
          count: formatNumber(sources),
        },
      ),
    );
    parts.push(
      t('Updated {age}.', {
        age: ageText(event.last_meaningful_update_at, at),
      }),
    );
    if (others > 0)
      parts.push(
        tn(others, 'One more event nearby.', '{count} more events nearby.', {
          count: formatNumber(others),
        }),
      );
    const text = parts.join(' ');
    return text.length > MAX_NARRATION_CHARS
      ? `${text.slice(0, MAX_NARRATION_CHARS - 1)}…`
      : text;
  }

  function stopNarration() {
    narration = null;
    speech.stop();
    if (ui.caption) ui.caption.hidden = true;
  }

  async function narrate(cluster) {
    if (!voice.tts || settings.narrationEnabled !== true) return;
    // Operator speech has priority: no briefing while a voice session runs.
    if (globalThis.__gevVoiceCommands?.isActive?.()) return;
    const event = eventsById().get(cluster.event_ids[0]);
    if (!event || narrated.get(event.event_id) === event.revision) return;
    narrated.set(event.event_id, event.revision);
    const text = narrationText(event, cluster.event_ids.length - 1);
    stopNarration();
    const token = {};
    narration = { token, text };
    ui.captionText.textContent = text;
    ui.caption.hidden = false;
    try {
      const response = await fetchImpl('/api/voice-local/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, lang: localeLang() }),
        signal: abort.signal,
      });
      if (!response.ok || narration?.token !== token) return;
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (narration?.token !== token) return;
      await speech.play(bytes);
    } catch {
      /* narration is optional; the card and caption still show the facts */
    } finally {
      if (narration?.token === token) {
        narration = null;
        ui.caption.hidden = true;
      }
    }
  }

  /** "Why are we looking at this?" from the deterministic explanation. */
  function explainText() {
    const key = selectedId ?? scheduler.current?.key ?? null;
    const event = key ? eventsById().get(key) : null;
    if (!event) return t('Nothing is in focus right now.');
    const reason = scheduler.current?.eventIds.includes(event.event_id)
      ? t(DECISION_REASONS[lastDecision?.reason] ?? msg('in focus'))
      : null;
    return [
      narrationText(event),
      reason ? t('Shown because: {reason}.', { reason }) : null,
      t('Why: {terms}', { terms: whyText(event) }),
    ]
      .filter(Boolean)
      .join(' ');
  }

  async function sourcesText() {
    const key = selectedId ?? scheduler.current?.key ?? null;
    if (!key) return t('Nothing is in focus right now.');
    if (cardDetail?.event.event_id !== key) await loadDetail(key);
    const publishers = [
      ...new Set(
        (cardDetail?.evidence ?? []).map((item) => item.observation.publisher),
      ),
    ].slice(0, 6);
    return publishers.length
      ? t('Sources: {list}.', { list: publishers.join(', ') })
      : t('No sources are listed for this event.');
  }

  /** Voice command entry for Autopilot (validated action names only). */
  async function voiceControl(action) {
    switch (action) {
      case 'on':
        if (scheduler.mode === 'off') toggleAutopilot();
        else if (scheduler.mode === 'paused') resume();
        return { ok: true, text: t('Autopilot on.') };
      case 'off':
        if (scheduler.mode !== 'off') toggleAutopilot();
        stopNarration();
        return { ok: true, text: t('Autopilot off.') };
      case 'pause':
        pause('voice');
        return { ok: true, text: t('Autopilot paused.') };
      case 'resume':
        resume();
        return { ok: true, text: t('Autopilot resumed.') };
      case 'next':
        if (scheduler.mode !== 'auto')
          return { ok: false, text: t('Autopilot is not running.') };
        if (scheduler.current) scheduler.current.startedAt = -Infinity;
        step();
        render();
        return { ok: true, text: t('Next event.') };
      case 'explain':
        return { ok: true, text: explainText() };
      case 'sources':
        return { ok: true, text: await sourcesText() };
      default:
        return {
          ok: false,
          text: t('That Autopilot command is not supported.'),
        };
    }
  }

  /** Voice query: filter the queue, show the most significant match. */
  function findEvents({ categories = [], countries = [], hours } = {}) {
    const since = Number.isFinite(hours)
      ? (data.now ?? now()) - hours * 3_600_000
      : -Infinity;
    const matches = data.events.filter(
      (event) =>
        (!categories.length || categories.includes(event.category)) &&
        (!countries.length ||
          countries.includes(event.location?.region_code)) &&
        event.last_meaningful_update_at >= since,
    );
    if (!matches.length)
      return { ok: true, text: t('No matching events in the queue.') };
    const top = matches[0];
    selectEvent(top.event_id, { fly: true, reason: 'voice' });
    return {
      ok: true,
      text: tn(
        matches.length,
        'One matching event. Showing: {title}.',
        '{count} matching events. Showing the most significant: {title}.',
        {
          count: formatNumber(matches.length),
          title: displayTitle(top).text,
        },
      ),
    };
  }

  function pause(reason) {
    stopNarration();
    if (scheduler.mode !== 'auto') return;
    scheduler = setSchedulerMode(scheduler, 'paused', reason);
    render();
  }

  function act(decision) {
    lastDecision = decision;
    if (decision.type === 'fly') {
      selectedId = null;
      const shot = shotFor(decision.cluster);
      const tour = decision.reason === 'tour';
      cancelPullBack();
      const accepted = flyTo(shot, {
        pan: true,
        onSettled: (settledMs) => schedulePullBack(shot, settledMs, tour),
      });
      if (!accepted) {
        scheduler = setSchedulerMode(scheduler, 'paused', 'navigation_refused');
        return;
      }
      loadDetail(decision.cluster.event_ids[0]);
      if (decision.reason !== 'tour') void narrate(decision.cluster);
    } else if (decision.type === 'idle') {
      cancelPullBack();
      const carto = viewer.camera?.positionCartographic;
      flyTo({
        lat: 15,
        lon: carto ? Cesium.Math.toDegrees(carto.longitude) : 0,
        height: GLOBAL_VIEW_HEIGHT,
      });
    }
  }

  function step() {
    if (scheduler.mode !== 'auto') return;
    const out = stepScheduler(scheduler, {
      // Camera timing (dwell, cooldown, confirmation) is about what a person
      // can watch: wall clock, even when a drill replays faster than real time.
      now: now(),
      clusters: data.clusters,
      events: data.events,
      settings,
    });
    scheduler = out.state;
    if (out.decision.type !== 'hold' && out.decision.type !== 'none')
      act(out.decision);
    else if (out.decision.type === 'hold') lastDecision ??= out.decision;
  }

  // ------------------------------------------------------------- operator
  function toggleAutopilot() {
    scheduler = setSchedulerMode(
      scheduler,
      scheduler.mode === 'off' ? 'auto' : 'off',
    );
    lastDecision = null;
    if (scheduler.mode === 'auto') {
      selectedId = null;
      step();
    }
    render();
  }

  function resume() {
    scheduler = setSchedulerMode(scheduler, 'auto');
    selectedId = null;
    step();
    render();
  }

  function selectEvent(
    id,
    { fly = false, reason = 'operator_selection' } = {},
  ) {
    selectedId = id;
    const event = eventsById().get(id);
    if (fly && event) {
      if (scheduler.mode === 'auto')
        scheduler = setSchedulerMode(scheduler, 'paused', reason);
      const cluster =
        event.location?.lat !== null
          ? {
              framing: 'point',
              event_ids: [id],
              center: { lat: event.location.lat, lon: event.location.lon },
              radius_km: 0,
            }
          : {
              framing: 'region',
              event_ids: [id],
              bounds: event.location?.bounds ?? null,
            };
      const shot = shotFor(cluster);
      if (shot) flyTo(shot, { pan: true });
      else notice = t('This event has no map location to show');
    }
    loadDetail(id);
    render();
  }

  async function changeSettings(patch) {
    try {
      settings = await client.updateSettings(patch);
      notice = '';
      await refresh({ force: true });
    } catch (error) {
      notice =
        error.status === 403
          ? t('Camera rules can only be changed on the host computer')
          : t('Could not save the camera rules');
      render();
    }
    renderSettings();
  }

  async function setWorld(name) {
    world = name;
    // A different world is a different queue: the operator re-enables Autopilot.
    stopNarration();
    scheduler = setSchedulerMode(scheduler, 'off');
    selectedId = null;
    cardDetail = null;
    await refresh({ force: true });
  }

  async function startDemo() {
    try {
      await client.startReplay('demo', DEMO_SPEED);
      notice = '';
      await setWorld('replay');
    } catch (error) {
      // Another device on the network cannot start a drill (it is shared
      // server state), but it may watch one the host computer started.
      if (error.status === 403) {
        const running = await client
          .replay(abort.signal)
          .then((r) => r?.replay)
          .catch(() => null);
        if (running) {
          notice = t('Watching the drill started on the host computer');
          await setWorld('replay');
          return;
        }
      }
      notice =
        error.status === 403
          ? t('The drill can only be started on the host computer')
          : t('Could not start the drill');
      render();
    }
  }

  async function toggleHistory() {
    if (history !== null) {
      history = null;
      renderHistory();
      return;
    }
    try {
      history = (await client.archive(20, abort.signal)).events;
    } catch {
      history = [];
    }
    renderHistory();
  }

  // ------------------------------------------------------------ data loop
  async function refresh({ force = false } = {}) {
    if (destroyed || !enabled) return;
    const interval = world === 'replay' ? REPLAY_REFRESH_MS : REFRESH_MS;
    if (!force && now() - lastFetchAt < interval) return;
    lastFetchAt = now();
    const requested = world;
    const generation = ++refreshGeneration;
    try {
      const [events, feedList, aiStatus] = await Promise.all([
        client.events(requested, abort.signal),
        client.feeds(abort.signal),
        client.ai(abort.signal).catch(() => null),
      ]);
      // A slower response for another world, or an older request, must not
      // overwrite what is now on screen (e.g. live data landing after DEMO).
      if (requested !== world || generation !== refreshGeneration) return;
      data = events;
      feeds = feedList.feeds;
      ai = aiStatus;
    } catch (error) {
      if (abort.signal.aborted) return;
      if (error.code === 'no_replay' && world === 'replay') {
        world = 'live';
        return refresh({ force: true });
      }
      notice = t('Event service unavailable');
    }
    render();
  }

  async function tick() {
    timer = null;
    if (destroyed) return;
    if (narration && globalThis.__gevVoiceCommands?.isActive?.())
      stopNarration();
    if (!documentRef.hidden) {
      await refresh();
      step();
      render();
    }
    timer = setTimeout(tick, TICK_MS);
  }

  // ------------------------------------------------------------- lifetime
  const onHandoff = () => {
    if (!claiming) pause('camera_owner_changed');
  };
  const onCanvasInput = () => pause('manual_input');
  const onVisibility = () => {
    if (!documentRef.hidden && enabled && !timer) tick();
  };
  let unsubscribeHandoff = () => {};

  async function start() {
    if (!panel || !body) return;
    try {
      const status = await client.status(abort.signal);
      enabled = status?.enabled === true;
      settings = status?.settings ?? {};
      const speechStatus = await fetchImpl('/api/voice-local/status', {
        signal: abort.signal,
      })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
      voice = {
        tts:
          speechStatus?.enabled === true &&
          speechStatus?.tts?.available === true,
      };
    } catch {
      enabled = false;
    }
    if (!enabled || destroyed) return;
    buildPanel();
    renderSettings();
    panel.hidden = false;
    unsubscribeHandoff =
      navigation.subscribeCameraHandoff?.(onHandoff) ?? (() => {});
    const canvas = viewer.scene?.canvas;
    for (const type of ['pointerdown', 'wheel'])
      canvas?.addEventListener(type, onCanvasInput, { passive: true });
    documentRef.addEventListener('visibilitychange', onVisibility);
    picking?.registerPickOwner?.(
      'intel',
      (id) => typeof id === 'string' && id.startsWith(PICK_PREFIX),
    );
    clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    clickHandler.setInputAction((click) => {
      if (pointer && !pointer.isPointerFree()) return;
      const picked = viewer.scene.pick(click.position);
      const id = picking?.resolvePickId
        ? picking.resolvePickId(picked)
        : picked?.id;
      if (typeof id === 'string' && id.startsWith(PICK_PREFIX))
        selectEvent(id.slice(PICK_PREFIX.length));
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    await refresh({ force: true });
    // Pick up where this browser left off before a reload.
    const restored = readStoredMode(storage);
    modeRestored = true;
    if (restored && restored.mode !== scheduler.mode && !destroyed) {
      scheduler = setSchedulerMode(scheduler, restored.mode, restored.reason);
      if (scheduler.mode === 'auto') step();
    }
    render();
    timer = setTimeout(tick, TICK_MS);
  }

  start();

  return {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      cancelPullBack();
      if (bufferingSaved && viewer.scene?.globe)
        Object.assign(viewer.scene.globe, bufferingSaved);
      stopNarration();
      abort.abort();
      clearTimeout(timer);
      unsubscribeHandoff();
      const canvas = viewer.scene?.canvas;
      for (const type of ['pointerdown', 'wheel'])
        canvas?.removeEventListener(type, onCanvasInput);
      documentRef.removeEventListener('visibilitychange', onVisibility);
      clickHandler?.destroy();
      picking?.unregisterPickOwner?.('intel');
      overlayHost.setEntries(LABEL_SOURCE, []);
      overlayHost.setEntries(CARD_SOURCE, []);
      overlayHost.clearSource?.(LABEL_SOURCE);
      overlayHost.clearSource?.(CARD_SOURCE);
      if (points && !viewer.isDestroyed?.())
        viewer.scene.primitives.remove(points);
      points = null;
    },
    /** Read-only state for QA scripts. */
    snapshot: () => ({
      enabled,
      world,
      mode: scheduler.mode,
      pauseReason: scheduler.pauseReason,
      current: scheduler.current,
      lastDecision,
      events: data.events.length,
      clusters: data.clusters.length,
      selectedId,
      narrating: narration?.text ?? null,
      pullBackSteps: pullBackTimers.length,
    }),
    toggleAutopilot,
    voiceControl,
    findEvents,
    narrationText,
    resume,
    startDemo,
  };
}
