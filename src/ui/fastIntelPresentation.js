// What the FAST INTELLIGENCE panel says, worked out from what its owner publishes.
// Pure, so the view can run it while rendering and its text follows the language.
// A source that is down says so in words, because an empty map must never read as
// a quiet world.

import { formatNumber, formatRelativeTime, msg, t } from '../i18n/index.js';
import {
  FAST_CATEGORIES,
  FAST_SUBLAYERS,
  FAST_WINDOWS_MIN,
  fastActivity,
} from '../intel/fastView.js';

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
const when = (value) => (value ? clock(value) : '—');

/** Source links come from the server, but only web links are ever followed. */
const webLink = (url) => (/^https?:\/\//i.test(url ?? '') ? url : null);

function presentFilters(view) {
  const chip = (id, label, active, change, title) => ({
    id,
    label,
    active,
    change,
    title,
  });
  const toggled = (group, id) => ({
    [group]: { ...view[group], [id]: view[group][id] === false },
  });
  return [
    {
      id: 'show',
      label: t('SHOW'),
      chips: [
        chip(
          'enabled',
          view.enabled ? t('ON MAP') : t('HIDDEN'),
          view.enabled,
          { enabled: !view.enabled },
          t('Hide or show on the map. Collection carries on either way.'),
        ),
        ...FAST_SUBLAYERS.map((id) =>
          chip(
            id,
            t(SUBLAYER_LABELS[id]),
            view.sublayers[id] !== false,
            toggled('sublayers', id),
          ),
        ),
      ],
    },
    {
      id: 'topic',
      label: t('TOPIC'),
      chips: FAST_CATEGORIES.map((id) =>
        chip(
          id,
          t(CATEGORY_LABELS[id]),
          view.categories[id] !== false,
          toggled('categories', id),
        ),
      ),
    },
    {
      id: 'window',
      label: t('NEW IN LAST'),
      chips: [null, ...FAST_WINDOWS_MIN].map((minutes) =>
        chip(
          String(minutes),
          minutes === null
            ? t('ALL')
            : t('{value} MIN', { value: formatNumber(minutes) }),
          view.windowMin === minutes,
          { windowMin: minutes },
        ),
      ),
    },
  ];
}

function presentTimeline(timeline) {
  if (timeline === null) return { text: t('Loading…') };
  if (!timeline) return { text: t('No detail available') };
  return {
    lines: [
      {
        label: t('Happened'),
        value: timeline.event_time_known
          ? when(timeline.event_time)
          : t('not stated'),
      },
      {
        label: t('First published'),
        value: when(timeline.first_known_source_publication_time),
      },
      {
        label: t('First detected here'),
        value: when(timeline.first_detected_at),
      },
      {
        label: t('First on the map'),
        value: when(timeline.first_displayed_at),
      },
      {
        label: t('First corroborated'),
        value: when(timeline.first_corroborated_at),
      },
      {
        label: t('Last real change'),
        value: when(timeline.last_material_update_at),
      },
      {
        label: t('Location'),
        value: timeline.location?.place
          ? t('{place} (approximate, unverified)', {
              place: timeline.location.place,
            })
          : t('unknown'),
      },
    ],
    evidence: timeline.evidence.map((item, index) => ({
      key: index,
      withdrawn: Boolean(item.withdrawn),
      excerpt: String(item.excerpt ?? '').slice(0, MAX_EXCERPT),
      url: webLink(item.url),
      link: item.attribution || t('Open the original'),
    })),
  };
}

function presentRow(event, at, openEvent) {
  const open = openEvent?.id === event.event_id;
  return {
    id: event.event_id,
    status: event.fast_status,
    badge: t(STATUS_LABELS[event.fast_status] ?? STATUS_LABELS.candidate),
    title: event.title,
    meta: [
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
    open,
    timeline: open ? presentTimeline(openEvent.timeline) : null,
  };
}

function presentSource(source, at) {
  const counters = source.counters ?? {};
  const state = SOURCE_STATE[source.status] ?? msg('NO DATA');
  return {
    id: source.provider,
    warn: WARN_STATES.has(source.status),
    text: `${source.provider === 'telegram' ? 'Telegram' : 'Bluesky'} · ${t(state)}`,
    meta: [
      t('{count} followed', { count: formatNumber(source.followed ?? 0) }),
      source.last_report_at
        ? t('last report {age}', { age: ageOf(source.last_report_at, at) })
        : t('no report yet'),
      t('received {count}', { count: formatNumber(counters.received ?? 0) }),
      t('filtered {count}', { count: formatNumber(counters.filtered ?? 0) }),
      t('dropped {count}', { count: formatNumber(counters.dropped ?? 0) }),
      source.reconnects
        ? t('reconnects {count}', { count: formatNumber(source.reconnects) })
        : null,
    ]
      .filter(Boolean)
      .join(' · '),
    error: source.last_error ?? '',
    stages: Object.entries(STAGE_LABELS)
      .filter(([stage]) => source.latency?.[stage])
      .map(([stage, label]) => {
        const reading = source.latency[stage];
        return {
          id: stage,
          text: t('{stage}: p50 {p50}, p95 {p95} ({count} samples)', {
            stage: t(label),
            p50: span(reading.p50_ms),
            p95: span(reading.p95_ms),
            count: formatNumber(reading.samples),
          }),
        };
      }),
  };
}

/**
 * @param {{at: number, status: object|null, settings: object|null, events: Array,
 *   view: object, openEvent: {id: string, timeline: object|null|false}|null,
 *   notice: string}} state What the owner publishes.
 * @returns {object} The panel, in the active language.
 */
export function presentFastIntel({
  at,
  status,
  settings,
  events,
  view,
  openEvent,
  notice,
}) {
  const sources = status?.sources ?? [];
  // A source switched off on purpose is neither up nor down.
  const watched = sources.filter((source) => source.status !== 'disabled');
  const up = watched.filter((source) => source.status === 'healthy');
  const anyLive = sources.some((source) => source.status === 'healthy');
  const queue = status?.queue;
  return {
    summary: {
      text: t('{up}/{total} up', {
        up: formatNumber(up.length),
        total: formatNumber(watched.length),
      }),
      down: watched.some((source) => WARN_STATES.has(source.status)),
    },
    filters: presentFilters(view),
    /* The one line that keeps an empty map from reading as a quiet world. */
    coverage: {
      down: !anyLive,
      text: anyLive
        ? t(
            'No pin does not mean nothing happened: only the sources below are watched.',
          )
        : t(
            'NO LIVE PUSH SOURCE. An empty map here says nothing about the world.',
          ),
    },
    rows: fastActivity(events, view, MAX_ACTIVITY).map((event) =>
      presentRow(event, at, openEvent),
    ),
    accounts: (settings?.bluesky?.accounts ?? []).map((account) => ({
      did: account.did,
      name: account.label || account.did,
      tag: account.tag,
    })),
    tags: Object.entries(TAG_LABELS).map(([value, label]) => ({
      value,
      label: t(label),
    })),
    notice,
    sources: sources.map((source) => presentSource(source, at)),
    queue: queue
      ? t('Queue {pending} of {max}', {
          pending: formatNumber(queue.pending),
          max: formatNumber(queue.max_pending),
        })
      : '',
    targets: (status?.slo ?? []).map((target) => ({
      id: target.stage,
      missed: target.met === false,
      text: t('Target {stage}: p95 under {target}; {reading}', {
        stage: t(STAGE_LABELS[target.stage] ?? msg('pipeline')),
        target: span(target.target_p95_ms),
        reading: target.measured
          ? span(target.measured.p95_ms)
          : t('not measured yet'),
      }),
    })),
  };
}
