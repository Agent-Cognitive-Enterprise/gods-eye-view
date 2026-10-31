// What the operator chose to see of Fast Intelligence. Presentation only: it
// filters what the console draws, lists and may fly to; collection carries on
// whatever is hidden. Only reports from the push sources are touched, so this
// can never hide an official feed's alert. Pure and portable.

export const FAST_SOURCE_PROVIDERS = Object.freeze(['bluesky', 'telegram']);
export const FAST_CATEGORIES = Object.freeze([
  'armed_conflict',
  'civil_unrest',
  'natural_disaster',
  'infrastructure_disruption',
  'economic_stress',
  'breaking_news',
  'public_health',
]);
/** The sublayers, each independently switchable. */
export const FAST_SUBLAYERS = Object.freeze([
  'provisional',
  'corroborated',
  'official',
]);
export const FAST_WINDOWS_MIN = Object.freeze([5, 15, 60]);

const STORAGE_KEY = 'gev.fastintel.view';

const SUBLAYER_OF = Object.freeze({
  provisional: 'provisional',
  contested: 'provisional',
  corroborated: 'corroborated',
  official: 'official',
});

export const defaultFastView = () => ({
  enabled: true,
  sublayers: Object.fromEntries(FAST_SUBLAYERS.map((id) => [id, true])),
  categories: Object.fromEntries(FAST_CATEGORIES.map((id) => [id, true])),
  windowMin: null,
});

/** Anything stored that does not fit falls back to the defaults, key by key. */
export function readFastView(storage) {
  const view = defaultFastView();
  let stored;
  try {
    stored = JSON.parse(storage?.getItem(STORAGE_KEY) ?? 'null');
  } catch {
    return view;
  }
  if (!stored || typeof stored !== 'object') return view;
  if (typeof stored.enabled === 'boolean') view.enabled = stored.enabled;
  for (const [group, ids] of [
    ['sublayers', FAST_SUBLAYERS],
    ['categories', FAST_CATEGORIES],
  ])
    for (const id of ids)
      if (typeof stored[group]?.[id] === 'boolean')
        view[group][id] = stored[group][id];
  if (FAST_WINDOWS_MIN.includes(stored.windowMin))
    view.windowMin = stored.windowMin;
  return view;
}

export function writeFastView(storage, view) {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(view));
  } catch {
    /* a full or blocked store only loses the preference */
  }
}

/** The event came in, at least partly, from a push source. */
export const isFastEvent = (event) =>
  event.providers?.some((id) => FAST_SOURCE_PROVIDERS.includes(id)) ?? false;

/** A push-source claim too thin to draw; it waits in the activity list. */
export const isHeldCandidate = (event) =>
  isFastEvent(event) && event.fast_status === 'candidate';

/** Whether the console may show this event, and the Autopilot go to it. */
export function fastEventVisible(event, view, now) {
  if (!isFastEvent(event)) return true;
  if (!view.enabled || isHeldCandidate(event)) return false;
  const sublayer = SUBLAYER_OF[event.fast_status];
  if (sublayer && view.sublayers[sublayer] === false) return false;
  if (view.categories[event.category] === false) return false;
  if (view.windowMin !== null) {
    const age = now - (event.first_seen_at ?? event.last_meaningful_update_at);
    if (age > view.windowMin * 60_000) return false;
  }
  return true;
}

/** The server's event list narrowed to what the view allows. */
export function applyFastView(payload, view, now) {
  const events = payload.events.filter((event) =>
    fastEventVisible(event, view, now),
  );
  const kept = new Set(events.map((event) => event.event_id));
  return {
    ...payload,
    events,
    clusters: (payload.clusters ?? []).filter((cluster) =>
      cluster.event_ids.every((id) => kept.has(id)),
    ),
  };
}

/** Newest first: what the push sources found, drawn or not. */
export function fastActivity(events, view, limit = 30) {
  return events
    .filter(isFastEvent)
    .filter(
      (event) =>
        view.categories[event.category] !== false &&
        (view.sublayers[SUBLAYER_OF[event.fast_status]] ?? true) !== false,
    )
    .sort((a, b) => (b.first_seen_at ?? 0) - (a.first_seen_at ?? 0))
    .slice(0, limit);
}
