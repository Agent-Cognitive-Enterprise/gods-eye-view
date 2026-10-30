/**
 * Autopilot reveal (fork feature): while the Autopilot shows an Air & Sea
 * event, the layers that explain it are switched on (the warning area and
 * the traffic around it, or the anomaly cells), and switched off again when
 * it moves on. Only layers this module switched on are switched off. A
 * layer the operator toggles meanwhile becomes theirs: switched off, it
 * stays off for that event; switched on, it stays on afterwards. Requests
 * use the "autopilot" origin, so they are never remembered as the
 * operator's own choice across reloads.
 */
import { trackVisibility } from './visibility.js';

const ORIGIN = 'autopilot';

/** The layers that explain an event, or none for other feeds. */
export function layersForEvent(event) {
  if (!event?.providers?.includes('airsea')) return [];
  const m = event.metrics ?? {};
  if (m.warning_domain)
    return [
      'warning-areas',
      m.warning_domain === 'aviation' ? 'air-traffic' : 'sea-traffic',
    ];
  if (event.subtype === 'air_traffic_anomaly')
    return ['traffic-anomalies', 'air-traffic'];
  if (event.subtype === 'sea_traffic_anomaly')
    return ['traffic-anomalies', 'sea-traffic'];
  return [];
}

/** @param {{manager: object}} options The layer data manager. */
export function createAirSeaReveal({ manager }) {
  const revealed = new Set();
  const declined = new Set(); // switched off by the operator for this event
  let shownKey = null;
  let self = false;
  const set = (id, on) => {
    self = true;
    try {
      void manager.setEnabled(id, on, { origin: ORIGIN });
    } finally {
      self = false;
    }
  };
  const visibility = trackVisibility(manager, {
    onRequest(change) {
      if (self) return;
      revealed.delete(change.layerId);
      if (change.enabled === false) declined.add(change.layerId);
      else declined.delete(change.layerId);
    },
  });
  return {
    /** The event the Autopilot now shows, or null. */
    show(event) {
      const key = event?.event_id ?? null;
      if (key !== shownKey) {
        shownKey = key;
        declined.clear();
      }
      const wanted = new Set(
        layersForEvent(event).filter(
          (id) => (manager.layers?.has?.(id) ?? true) && !declined.has(id),
        ),
      );
      for (const id of [...revealed])
        if (!wanted.has(id)) {
          revealed.delete(id);
          set(id, false);
        }
      for (const id of wanted)
        if (!revealed.has(id) && !visibility.wants(id)) {
          revealed.add(id);
          set(id, true);
        }
    },
    destroy() {
      this.show(null);
      visibility.stop();
    },
  };
}
