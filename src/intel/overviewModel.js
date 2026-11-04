// What the Autopilot world overview shows (fork feature). Pure: built from the
// console's own state, never from a second poll, and never changing the scheduler.
//
// - current: the shot on screen, as the scheduler holds it, drawn at the cluster's
//   centre. Not the camera: a zoom-out after a shot moves only the camera.
// - visited: shots that actually arrived, newest first, a short ring buffer the
//   console feeds when a flight settles. A refused or cancelled flight never lands.
// - next: the scheduler's own ranking of what it would pick, labelled LIKELY NEXT.
//   The scheduler commits to one shot at a time, so this is never drawn as a route.

/** How many arrived shots the overview remembers. */
export const VISITED_LIMIT = 5;
/** How many likely next stops it shows. */
export const NEXT_LIMIT = 8;

const located = (lat, lon) =>
  typeof lat === 'number' &&
  Number.isFinite(lat) &&
  typeof lon === 'number' &&
  Number.isFinite(lon);

/** Where a cluster is drawn, and how sure that position is. */
export function clusterPlace(cluster, eventsById) {
  const top = eventsById?.get(cluster?.event_ids?.[0]);
  const precision = top?.location?.precision;
  const center = cluster?.center;
  if (located(center?.lat, center?.lon))
    return {
      lat: center.lat,
      lon: center.lon,
      // A country-level report has a marker position, not a place.
      regional:
        cluster.framing === 'region' ||
        precision === 'country' ||
        precision === 'region',
    };
  const loc = top?.location;
  if (located(loc?.lat, loc?.lon))
    return { lat: loc.lat, lon: loc.lon, regional: precision === 'country' };
  // A region-framed shot (country or area bounds, no point): its box's centre.
  const middle = boundsCentre(cluster?.bounds ?? loc?.bounds);
  if (middle) return { ...middle, regional: true };
  return null;
}

/** Centre of a {west, east, south, north} box, which may cross ±180°. */
export function boundsCentre(bounds) {
  const { west, east, south, north } = bounds ?? {};
  if (!located(south, west) || !located(north, east)) return null;
  const span = west <= east ? east - west : east + 360 - west;
  let lon = west + span / 2;
  if (lon > 180) lon -= 360;
  return { lat: (south + north) / 2, lon };
}

/**
 * Adds an arrived shot to the front of the visited list. The same shot arriving
 * again (a revision, a re-flight) moves to the front rather than repeating.
 * @returns {Array} A new list, at most VISITED_LIMIT long.
 */
export function recordVisit(visited, entry, limit = VISITED_LIMIT) {
  if (!entry?.key || !located(entry.lat, entry.lon)) return visited;
  return [entry, ...visited.filter((v) => v.key !== entry.key)].slice(0, limit);
}

/**
 * The overview's model.
 * @param {{mode: string, world: string, schedulerCurrent: object|null,
 *   clusters: object[], events: object[], visited: object[],
 *   likely: object[], cameraKnown: boolean}} input
 */
export function overviewModel({
  mode,
  world,
  schedulerCurrent,
  clusters = [],
  events = [],
  visited = [],
  likely = [],
  cameraKnown = true,
}) {
  const eventsById = new Map(events.map((e) => [e.event_id, e]));
  const titleOf = (id) => eventsById.get(id)?.title ?? '';
  const demo = world === 'replay' || events.some((e) => e.synthetic);
  let current = null;
  let unplaced = 0;
  if (schedulerCurrent && mode !== 'off') {
    const cluster = clusters.find((c) =>
      c.event_ids.includes(schedulerCurrent.key),
    ) ?? {
      event_ids: schedulerCurrent.eventIds ?? [schedulerCurrent.key],
    };
    const place = clusterPlace(cluster, eventsById);
    if (place)
      current = {
        key: schedulerCurrent.key,
        title: titleOf(schedulerCurrent.key),
        eventIds: [...(schedulerCurrent.eventIds ?? cluster.event_ids)],
        tour: Boolean(schedulerCurrent.tour),
        ...place,
      };
    else unplaced += 1;
  }
  const next = [];
  for (const cluster of likely.slice(0, NEXT_LIMIT)) {
    const place = clusterPlace(cluster, eventsById);
    if (!place) {
      unplaced += 1;
      continue;
    }
    next.push({
      key: cluster.event_ids[0],
      title: titleOf(cluster.event_ids[0]),
      rank: next.length + 1,
      prediction: 'candidate',
      ...place,
    });
  }
  return {
    mode,
    world: demo ? 'replay' : 'live',
    demo,
    current,
    visited: visited.filter((v) => v.key !== current?.key),
    next,
    unplaced,
    status: !cameraKnown
      ? 'unknown_position'
      : !current && !next.length
        ? 'no_targets'
        : 'ready',
  };
}

/** Whether two models draw the same thing, so an identical update skips rendering. */
export function sameModel(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  const pick = (m) =>
    JSON.stringify([
      m.mode,
      m.world,
      m.status,
      m.unplaced,
      m.current && [
        m.current.key,
        m.current.lat,
        m.current.lon,
        m.current.title,
        m.current.regional,
      ],
      m.visited.map((v) => [v.key, v.lat, v.lon]),
      m.next.map((n) => [n.key, n.lat, n.lon, n.title, n.regional]),
    ]);
  return pick(a) === pick(b);
}
