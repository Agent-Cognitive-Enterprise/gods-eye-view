// FAST INTELLIGENCE panel (fork feature): what the push sources found, how to
// narrow it, and how far each source can be trusted to be working right now. A
// source that is down says so in words, because an empty map must never read as
// a quiet world. Adding or removing a source works from this computer only.

import { formatNumber, formatRelativeTime, msg, t } from '../i18n/index.js';
import {
  FAST_CATEGORIES,
  FAST_SUBLAYERS,
  FAST_WINDOWS_MIN,
  fastActivity,
  readFastView,
  writeFastView,
} from '../intel/fastView.js';

const STATUS_POLL_MS = 10_000;
const MAX_ACTIVITY = 12;
const MAX_EXCERPT = 280;

const STATUS_LABELS = Object.freeze({
  candidate: msg('CANDIDATE'),
  provisional: msg('FIRST REPORT'),
  corroborated: msg('CORROBORATED'),
  official: msg('OFFICIAL'),
  contested: msg('CONTESTED'),
  retracted: msg('RETRACTED'),
  resolved: msg('RESOLVED'),
});
const SUBLAYER_LABELS = Object.freeze({
  provisional: msg('FIRST REPORTS'),
  corroborated: msg('CORROBORATED'),
  official: msg('OFFICIAL'),
});
const CATEGORY_LABELS = Object.freeze({
  armed_conflict: msg('CONFLICT'),
  civil_unrest: msg('UNREST'),
  natural_disaster: msg('DISASTER'),
  infrastructure_disruption: msg('INFRASTRUCTURE'),
  economic_stress: msg('ECONOMY'),
  breaking_news: msg('NEWS'),
  public_health: msg('HEALTH'),
});
const SOURCE_STATE = Object.freeze({
  healthy: msg('LIVE'),
  degraded: msg('RECONNECTING'),
  stale: msg('FEED STALE'),
  offline: msg('NO DATA'),
  disabled: msg('OFF'),
  requires_credentials: msg('AUTH REQUIRED'),
  needs_sources: msg('NO SOURCES CHOSEN'),
});
const TAG_LABELS = Object.freeze({
  community: msg('Community: a claim'),
  reporter: msg('Reporter: checked by you'),
  official: msg('Official: checked by you'),
});
const STAGE_LABELS = Object.freeze({
  publish_to_receive: msg('published to received'),
  receive_to_event: msg('received to event'),
  receive_to_display: msg('received to map'),
});
const WARN_STATES = new Set([
  'degraded',
  'stale',
  'offline',
  'requires_credentials',
]);

const el = (doc, tag, className, text) => {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

function ageOf(ms, at) {
  const seconds = Math.round((at - ms) / 1000);
  if (Math.abs(seconds) < 90) return formatRelativeTime(-seconds, 'second');
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 90) return formatRelativeTime(-minutes, 'minute');
  return formatRelativeTime(-Math.round(minutes / 60), 'hour');
}

const span = (ms) =>
  ms < 10_000
    ? t('{value} s', {
        value: formatNumber(ms / 1000, { maximumFractionDigits: 1 }),
      })
    : t('{value} s', { value: formatNumber(Math.round(ms / 1000)) });

const clock = (ms) => new Date(ms).toISOString().slice(11, 19).concat(' UTC');

/**
 * @param {{documentRef?: Document, client: object, storage?: Storage,
 *   onViewChange: Function, onSelect: Function, now?: () => number}} options
 */
export function createFastIntelPanel({
  documentRef = document,
  client,
  storage = globalThis.localStorage,
  onViewChange,
  onSelect,
  now = () => Date.now(),
}) {
  const panel = documentRef.getElementById('fast-intel-panel');
  const body = documentRef.getElementById('fast-intel-body');
  const summary = documentRef.getElementById('fast-intel-count');
  let view = readFastView(storage);
  let status = null;
  let settings = null;
  let events = [];
  let openEvent = null; // {id, timeline}
  let notice = '';
  let timer = null;
  let destroyed = false;
  let healthOpen = false;
  let sourcesOpen = false;
  const abort = new AbortController();

  function setView(change) {
    view = { ...view, ...change };
    writeFastView(storage, view);
    onViewChange(view);
    render();
  }

  function chip(label, active, onClick, title) {
    const button = el(documentRef, 'button', 'data-toggle-chip', label);
    button.type = 'button';
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
    if (title) button.title = title;
    button.addEventListener('click', onClick);
    return button;
  }

  function chips(label, children) {
    const row = el(documentRef, 'div', 'fast-chips');
    row.append(
      el(documentRef, 'span', 'intel-setting-label', label),
      ...children,
    );
    return row;
  }

  function renderControls() {
    const master = chip(
      view.enabled ? t('ON MAP') : t('HIDDEN'),
      view.enabled,
      () => setView({ enabled: !view.enabled }),
      t('Hide or show on the map. Collection carries on either way.'),
    );
    const sublayers = FAST_SUBLAYERS.map((id) =>
      chip(t(SUBLAYER_LABELS[id]), view.sublayers[id] !== false, () =>
        setView({
          sublayers: { ...view.sublayers, [id]: view.sublayers[id] === false },
        }),
      ),
    );
    const categories = FAST_CATEGORIES.map((id) =>
      chip(t(CATEGORY_LABELS[id]), view.categories[id] !== false, () =>
        setView({
          categories: {
            ...view.categories,
            [id]: view.categories[id] === false,
          },
        }),
      ),
    );
    const windows = [null, ...FAST_WINDOWS_MIN].map((minutes) =>
      chip(
        minutes === null
          ? t('ALL')
          : t('{value} MIN', { value: formatNumber(minutes) }),
        view.windowMin === minutes,
        () => setView({ windowMin: minutes }),
      ),
    );
    return [
      chips(t('SHOW'), [master, ...sublayers]),
      chips(t('TOPIC'), categories),
      chips(t('NEW IN LAST'), windows),
    ];
  }

  /** The one line that keeps an empty map from reading as a quiet world. */
  function coverageLine() {
    const sources = status?.sources ?? [];
    const live = sources.filter((source) => source.status === 'healthy');
    const line = el(
      documentRef,
      'p',
      `fast-coverage${live.length ? '' : ' fast-coverage-down'}`,
    );
    line.textContent = live.length
      ? t(
          'No pin does not mean nothing happened: only the sources below are watched.',
        )
      : t(
          'NO LIVE PUSH SOURCE. An empty map here says nothing about the world.',
        );
    return line;
  }

  function renderActivity() {
    const at = now();
    const list = el(documentRef, 'ul', 'fast-activity');
    const shown = fastActivity(events, view, MAX_ACTIVITY);
    if (!shown.length)
      list.append(el(documentRef, 'li', 'intel-muted', t('Nothing yet')));
    for (const event of shown) {
      const row = el(documentRef, 'li', `fast-row s-${event.fast_status}`);
      const button = el(documentRef, 'button', 'fast-row-button');
      button.type = 'button';
      const label = STATUS_LABELS[event.fast_status] ?? STATUS_LABELS.candidate;
      button.append(
        el(documentRef, 'span', 'fast-badge', t(label)),
        el(documentRef, 'span', 'fast-row-title', event.title),
        el(
          documentRef,
          'span',
          'intel-muted',
          [
            event.first_published_at
              ? t('posted {age}', { age: ageOf(event.first_published_at, at) })
              : null,
            t('seen {age}', { age: ageOf(event.first_seen_at, at) }),
            t('{count} independent', {
              count: formatNumber(event.explanation?.independent_sources ?? 0),
            }),
            event.location?.place ?? t('place unknown'),
          ]
            .filter(Boolean)
            .join(' · '),
        ),
      );
      button.addEventListener('click', () => toggleEvent(event));
      row.append(button);
      if (openEvent?.id === event.event_id) row.append(renderTimeline());
      list.append(row);
    }
    return list;
  }

  async function toggleEvent(event) {
    if (openEvent?.id === event.event_id) {
      openEvent = null;
      render();
      return;
    }
    openEvent = { id: event.event_id, timeline: null };
    if (event.location?.lat !== null && event.location?.lat !== undefined)
      onSelect(event.event_id);
    render();
    try {
      const timeline = await client.fastTimeline(event.event_id, abort.signal);
      if (openEvent?.id === event.event_id) openEvent.timeline = timeline;
    } catch {
      if (openEvent?.id === event.event_id) openEvent.timeline = false;
    }
    render();
  }

  function renderTimeline() {
    const box = el(documentRef, 'div', 'fast-timeline');
    const timeline = openEvent?.timeline;
    if (timeline === null) {
      box.append(el(documentRef, 'p', 'intel-muted', t('Loading…')));
      return box;
    }
    if (!timeline) {
      box.append(el(documentRef, 'p', 'intel-muted', t('No detail available')));
      return box;
    }
    const line = (label, value) => {
      const row = el(documentRef, 'div', 'fast-kv');
      row.append(
        el(documentRef, 'span', 'intel-muted', label),
        el(documentRef, 'span', null, value),
      );
      box.append(row);
    };
    const when = (value) => (value ? clock(value) : '—');
    line(
      t('Happened'),
      timeline.event_time_known ? when(timeline.event_time) : t('not stated'),
    );
    line(
      t('First published'),
      when(timeline.first_known_source_publication_time),
    );
    line(t('First detected here'), when(timeline.first_detected_at));
    line(t('First on the map'), when(timeline.first_displayed_at));
    line(t('First corroborated'), when(timeline.first_corroborated_at));
    line(t('Last real change'), when(timeline.last_material_update_at));
    line(
      t('Location'),
      timeline.location?.place
        ? t('{place} (approximate, unverified)', {
            place: timeline.location.place,
          })
        : t('unknown'),
    );
    for (const item of timeline.evidence) {
      const source = el(documentRef, 'div', 'fast-evidence');
      if (item.withdrawn)
        source.append(
          el(documentRef, 'span', 'intel-muted', t('Withdrawn by its source')),
        );
      else {
        const excerpt = String(item.excerpt ?? '').slice(0, MAX_EXCERPT);
        source.append(el(documentRef, 'span', null, excerpt));
        if (item.url) {
          const link = el(
            documentRef,
            'a',
            'fast-link',
            item.attribution || t('Open the original'),
          );
          link.href = item.url;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          source.append(link);
        }
      }
      box.append(source);
    }
    return box;
  }

  async function saveSettings(change) {
    try {
      settings = await client.updateFastSettings(change);
      notice = '';
    } catch (error) {
      notice =
        error.status === 403
          ? t('Sources can be changed on this computer only')
          : t('Could not save');
    }
    render();
  }

  function renderSources() {
    const box = el(documentRef, 'div', 'fast-sources');
    const accounts = settings?.bluesky?.accounts ?? [];
    for (const account of accounts) {
      const row = el(documentRef, 'div', 'fast-account');
      row.append(
        el(
          documentRef,
          'span',
          'fast-account-name',
          account.label || account.did,
        ),
      );
      const tag = el(documentRef, 'select', 'fast-select');
      tag.setAttribute('aria-label', t('How far to trust this source'));
      for (const [id, text] of Object.entries(TAG_LABELS)) {
        const option = el(documentRef, 'option', null, t(text));
        option.value = id;
        option.selected = account.tag === id;
        tag.append(option);
      }
      tag.addEventListener('change', () =>
        saveSettings({
          bluesky: {
            accounts: accounts.map((held) =>
              held.did === account.did ? { ...held, tag: tag.value } : held,
            ),
          },
        }),
      );
      const remove = el(documentRef, 'button', 'data-toggle-chip', t('REMOVE'));
      remove.type = 'button';
      remove.addEventListener('click', () =>
        saveSettings({
          bluesky: {
            accounts: accounts.filter((held) => held.did !== account.did),
          },
        }),
      );
      row.append(tag, remove);
      box.append(row);
    }
    const form = el(documentRef, 'form', 'fast-add');
    const input = el(documentRef, 'input', 'fast-input');
    input.type = 'text';
    input.placeholder = t('Bluesky handle or DID');
    input.setAttribute('aria-label', t('Bluesky handle or DID'));
    const add = el(documentRef, 'button', 'data-toggle-chip', t('FOLLOW'));
    add.type = 'submit';
    form.append(input, add);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const handle = input.value.trim();
      if (!handle) return;
      try {
        const found = await client.resolveFastAccount(handle);
        await saveSettings({
          bluesky: {
            accounts: [
              ...accounts,
              {
                did: found.did,
                label: found.handle ?? '',
                tag: 'community',
              },
            ],
          },
        });
      } catch (error) {
        notice =
          error.status === 403
            ? t('Sources can be changed on this computer only')
            : t('No such account');
        render();
      }
    });
    box.append(form);
    if (notice) box.append(el(documentRef, 'p', 'fast-notice', notice));
    return box;
  }

  function sourceLine(source, at) {
    const state = SOURCE_STATE[source.status] ?? msg('NO DATA');
    const row = el(
      documentRef,
      'li',
      `fast-source${WARN_STATES.has(source.status) ? ' fast-warn' : ''}`,
    );
    row.append(
      el(
        documentRef,
        'span',
        null,
        `${source.provider === 'telegram' ? 'Telegram' : 'Bluesky'} · ${t(state)}`,
      ),
    );
    const counters = source.counters ?? {};
    row.append(
      el(
        documentRef,
        'span',
        'intel-muted',
        [
          t('{count} followed', { count: formatNumber(source.followed ?? 0) }),
          source.last_report_at
            ? t('last report {age}', { age: ageOf(source.last_report_at, at) })
            : t('no report yet'),
          t('received {count}', {
            count: formatNumber(counters.received ?? 0),
          }),
          t('filtered {count}', {
            count: formatNumber(counters.filtered ?? 0),
          }),
          t('dropped {count}', { count: formatNumber(counters.dropped ?? 0) }),
          source.reconnects
            ? t('reconnects {count}', {
                count: formatNumber(source.reconnects),
              })
            : null,
        ]
          .filter(Boolean)
          .join(' · '),
      ),
    );
    if (source.last_error)
      row.append(el(documentRef, 'span', 'fast-notice', source.last_error));
    for (const [stage, label] of Object.entries(STAGE_LABELS)) {
      const reading = source.latency?.[stage];
      if (reading)
        row.append(
          el(
            documentRef,
            'span',
            'intel-muted',
            t('{stage}: p50 {p50}, p95 {p95} ({count} samples)', {
              stage: t(label),
              p50: span(reading.p50_ms),
              p95: span(reading.p95_ms),
              count: formatNumber(reading.samples),
            }),
          ),
        );
    }
    return row;
  }

  function renderHealth() {
    const at = now();
    const box = el(documentRef, 'div', 'fast-health');
    const list = el(documentRef, 'ul', 'fast-source-list');
    for (const source of status?.sources ?? [])
      list.append(sourceLine(source, at));
    box.append(list);
    const queue = status?.queue;
    if (queue)
      box.append(
        el(
          documentRef,
          'p',
          'intel-muted',
          t('Queue {pending} of {max}', {
            pending: formatNumber(queue.pending),
            max: formatNumber(queue.max_pending),
          }),
        ),
      );
    for (const target of status?.slo ?? [])
      box.append(
        el(
          documentRef,
          'p',
          target.met === false ? 'fast-notice' : 'intel-muted',
          t('Target {stage}: p95 under {target}; {reading}', {
            stage: t(STAGE_LABELS[target.stage] ?? msg('pipeline')),
            target: span(target.target_p95_ms),
            reading: target.measured
              ? span(target.measured.p95_ms)
              : t('not measured yet'),
          }),
        ),
      );
    return box;
  }

  const section = (label, open, toggle) => {
    const button = el(
      documentRef,
      'button',
      'intel-section panel-title intel-rules-toggle fast-section',
      `${open ? '▾' : '▸'} ${label}`,
    );
    button.type = 'button';
    button.setAttribute('aria-expanded', String(open));
    button.addEventListener('click', toggle);
    return button;
  };

  function render() {
    if (destroyed || !panel || !body) return;
    // A source switched off on purpose is neither up nor down.
    const watched = (status?.sources ?? []).filter(
      (source) => source.status !== 'disabled',
    );
    const down = watched.some((source) => WARN_STATES.has(source.status));
    if (summary) {
      const live = watched.filter((source) => source.status === 'healthy');
      summary.textContent = t('{up}/{total} up', {
        up: formatNumber(live.length),
        total: formatNumber(watched.length),
      });
      summary.classList.toggle('intel-feeds-down', down);
    }
    const scrolled = body.scrollTop;
    const focused = documentRef.activeElement;
    if (focused && body.contains(focused) && focused.tagName !== 'BUTTON')
      return; // never rebuild under someone typing
    const parts = [...renderControls(), coverageLine(), renderActivity()];
    parts.push(
      section(t('SOURCES'), sourcesOpen, () => {
        sourcesOpen = !sourcesOpen;
        render();
      }),
    );
    if (sourcesOpen) parts.push(renderSources());
    parts.push(
      section(t('HEALTH AND DELAY'), healthOpen, () => {
        healthOpen = !healthOpen;
        render();
      }),
    );
    if (healthOpen) parts.push(renderHealth());
    body.replaceChildren(...parts);
    body.scrollTop = scrolled;
  }

  async function poll() {
    timer = null;
    if (destroyed) return;
    try {
      status = await client.fastStatus(abort.signal);
    } catch {
      status = { sources: [] };
    }
    render();
    timer = setTimeout(poll, STATUS_POLL_MS);
  }

  return {
    /** Shows the panel if the server has Fast Intelligence on. */
    async start() {
      if (!panel) return false;
      try {
        status = await client.fastStatus(abort.signal);
      } catch {
        return false;
      }
      if (!status?.enabled) return false;
      settings = await client.fastSettings(abort.signal).catch(() => null);
      panel.hidden = false;
      // The left rail measures its panels on resize; this one just appeared.
      documentRef.defaultView?.dispatchEvent(new Event('resize'));
      render();
      timer = setTimeout(poll, STATUS_POLL_MS);
      return true;
    },
    view: () => view,
    /** The newest events from the server, whether or not they are shown. */
    update(next) {
      events = next;
      render();
    },
    destroy() {
      destroyed = true;
      abort.abort();
      clearTimeout(timer);
      if (panel) panel.hidden = true;
    },
  };
}
