/**
 * @module ui/resourcesPresentation
 * @description What the RESOURCES panel (fork feature) shows, as plain values:
 * sizes, durations and ages in the active language, jobs in their groups,
 * and the reasons, effects and changes in words. Pure: unit-tested.
 */
import { formatNumber, formatRelativeTime, msg, t } from '../i18n/index.js';
import { FEED_LABELS } from './feedLabels.js';

/** Group order and titles; unknown groups follow, titled by their code. */
export const RESOURCE_GROUPS = Object.freeze([
  Object.freeze({ id: 'autopilot-feeds', label: msg('Autopilot feeds') }),
  Object.freeze({ id: 'air-sea', label: msg('Air & Sea') }),
]);

const DEPENDENTS = Object.freeze({
  'autopilot-events': msg('Autopilot events from this feed'),
  'warning-areas-layer': msg('Warning Areas layer updates'),
});

/**
 * Readable names of the jobs whose server label is a bare code; Autopilot
 * feeds (intel:<feed>) take FEEDS' names (./feedLabels.js).
 */
const JOB_NAMES = Object.freeze({
  'airsea-traffic:adsblol-mil': msg('Military flights (adsb.lol)'),
  // The flights layer's fallback when OpenSky is down: its own title.
  'airsea-traffic:adsblol-regional': msg(
    'adsb.lol regional fallback (250 nm around the view)',
  ),
  'airsea-traffic:aisstream': msg('Vessels (AISStream)'),
  'airsea-traffic:opensky': msg('Air traffic (OpenSky)'),
  'airsea-warnings:nws-marine': msg('US marine warnings (NWS)'),
  // A trial exchange set: test data, never used for alerts.
  'airsea-warnings:s124-ccg-trial': msg(
    'Canadian navigation warnings, trial data (CCG S-124)',
  ),
});

/**
 * A job's name in words: the readable name where there is one, else the
 * server's label with its provider ("label · provider").
 */
export function jobName(job) {
  const id = String(job?.id ?? '');
  const readable = id.startsWith('intel:')
    ? FEED_LABELS[id.slice('intel:'.length)]
    : JOB_NAMES[id];
  if (readable) return t(readable);
  const label = String(job?.label ?? id);
  return job?.provider && job.provider !== label
    ? `${label} · ${job.provider}`
    : label;
}

const FIXED_REASONS = Object.freeze({
  'single-connection': msg('The one live AIS connection: no switch'),
  'not-switchable-yet': msg('No switch yet'),
});

/** Status tone for the row's dot. */
export function statusTone(status) {
  if (status === 'healthy' || status === 'trial') return 'ok';
  if (status === 'off' || status === 'disabled') return 'off';
  if (status === 'degraded' || status === 'stale') return 'warn';
  if (
    status === 'requires_credentials' ||
    status === 'permission_required' ||
    status === 'unconfigured' ||
    status === 'blocked_by_terms'
  )
    return 'idle';
  return status ? 'bad' : 'idle';
}

/** A byte count as KB, MB or GB. */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  const units = [
    [1024 ** 3, 'GB'],
    [1024 ** 2, 'MB'],
    [1024, 'KB'],
  ];
  for (const [size, unit] of units)
    if (bytes >= size)
      return `${formatNumber(bytes / size, { maximumFractionDigits: bytes >= 10 * size ? 0 : 1 })} ${unit}`;
  return `${formatNumber(bytes)} B`;
}

/** Megabytes (the server's unit) as MB or GB. */
export const formatMegabytes = (mb) =>
  Number.isFinite(mb) ? formatBytes(mb * 1024 * 1024) : '—';

/** A duration in milliseconds, short. */
export function formatDuration(ms) {
  if (!Number.isFinite(ms)) return '—';
  if (ms < 1000)
    return t('{value} ms', { value: formatNumber(Math.round(ms)) });
  const s = ms / 1000;
  if (s < 60)
    return t('{value} s', {
      value: formatNumber(s, { maximumFractionDigits: 1 }),
    });
  const min = s / 60;
  if (min < 60)
    return t('{value} min', { value: formatNumber(Math.round(min)) });
  return t('{value} h', {
    value: formatNumber(min / 60, { maximumFractionDigits: 1 }),
  });
}

/** How long ago `at` was, in words ("3 minutes ago"). */
export function formatAge(at, now) {
  if (!Number.isFinite(at)) return t('never');
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return formatRelativeTime(-s, 'second', { numeric: 'auto' });
  if (s < 3600) return formatRelativeTime(-Math.round(s / 60), 'minute');
  if (s < 86_400) return formatRelativeTime(-Math.round(s / 3600), 'hour');
  return formatRelativeTime(-Math.round(s / 86_400), 'day');
}

/** A percentage, one decimal under ten. */
export function formatPercent(value) {
  if (!Number.isFinite(value)) return '—';
  return `${formatNumber(value, { maximumFractionDigits: value < 10 ? 1 : 0 })}%`;
}

/** The facts line under a job: how often, when last, how long, how much. */
export function jobFacts(job, now) {
  const parts = [];
  if (Number.isFinite(job.interval_ms))
    parts.push(
      t('every {interval}', { interval: formatDuration(job.interval_ms) }),
    );
  if (Number.isFinite(job.last_run_at))
    parts.push(t('ran {age}', { age: formatAge(job.last_run_at, now) }));
  else if (Number.isFinite(job.last_success_at))
    parts.push(
      t('updated {age}', { age: formatAge(job.last_success_at, now) }),
    );
  if (Number.isFinite(job.last_duration_ms))
    parts.push(
      t('took {duration}', { duration: formatDuration(job.last_duration_ms) }),
    );
  if (Number.isFinite(job.last_items))
    parts.push(t('{count} items', { count: formatNumber(job.last_items) }));
  return parts.join(' · ');
}

/** What stops with a job, in words. */
export const dependentLabels = (job) =>
  (job.dependents ?? []).map((code) =>
    DEPENDENTS[code] ? t(DEPENDENTS[code]) : code,
  );

/** Why a job has no switch, in words, or null. */
export const fixedReasonLabel = (job) =>
  job.fixed_reason
    ? t(FIXED_REASONS[job.fixed_reason] ?? job.fixed_reason)
    : null;

/** Jobs in their groups, each sorted: off by you first, then by label. */
export function groupJobs(jobs) {
  const known = new Map(
    RESOURCE_GROUPS.map((g) => [g.id, { ...g, label: t(g.label), jobs: [] }]),
  );
  for (const job of jobs ?? []) {
    if (!known.has(job.group))
      known.set(job.group, { id: job.group, label: job.group, jobs: [] });
    known.get(job.group).jobs.push(job);
  }
  return [...known.values()]
    .filter((g) => g.jobs.length)
    .map((g) => ({
      ...g,
      jobs: g.jobs.sort(
        (a, b) =>
          Number(b.off_by_you) - Number(a.off_by_you) ||
          jobName(a).localeCompare(jobName(b)),
      ),
    }));
}

/**
 * A change in words with its before and after, e.g. "GDELT off · CPU 12% →
 * 9% · memory 1.2 GB → 1.1 GB"; the after reads "measuring…" until known.
 */
export function changeSummary(change, jobs) {
  const job = (jobs ?? []).find((j) => j.id === change.id);
  const label = job ? jobName(job) : change.id;
  const head = change.on
    ? t('{label} turned on', { label })
    : t('{label} turned off', { label });
  if (!change.before) return head;
  // The next change came too soon to measure this one: no figures.
  if (change.measured === false) return head;
  if (!change.after) return `${head} · ${t('measuring…')}`;
  // t() isolates each value in right-to-left languages, so a unit stays
  // with its number.
  return [
    head,
    t('CPU {before} → {after}', {
      before: formatPercent(change.before.cpu_core_pct),
      after: formatPercent(change.after.cpu_core_pct),
    }),
    t('memory {before} → {after}', {
      before: formatMegabytes(change.before.rss_mb),
      after: formatMegabytes(change.after.rss_mb),
    }),
  ].join(' · ');
}

const SWITCH_ERRORS = Object.freeze({
  local_only: msg('Switches work only on the computer that runs the server.'),
  fixed: msg('No switch yet'),
});

/** Why a switch failed, in words where the server's code has them. */
export function switchErrorText(code) {
  const known = SWITCH_ERRORS[code];
  return known ? t(known) : String(code ?? '');
}

/** Points for a small line chart of `key` over the samples, in a w×h box. */
export function sparkline(samples, key, w = 120, h = 24) {
  const values = (samples ?? []).map((s) => s?.[key]).filter(Number.isFinite);
  if (values.length < 2) return '';
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  return values
    .map(
      (v, i) =>
        `${((i / (values.length - 1)) * w).toFixed(1)},${(h - ((v - min) / span) * (h - 2) - 1).toFixed(1)}`,
    )
    .join(' ');
}
