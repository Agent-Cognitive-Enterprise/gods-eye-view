/**
 * Autopilot reveal (fork feature): while the Autopilot shows an Air & Sea
 * event, the layers that explain it are switched on (the warning area and
 * the traffic around it, or the anomaly cells), and switched off again when
 * it moves on. Only layers this module switched on are switched off; one the
 * operator toggles meanwhile becomes theirs and is left alone.
 */

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
  let self = false;
  const set = (id, on) => {
    self = true;
    try {
      void manager.setEnabled(id, on);
    } finally {
      self = false;
    }
  };
  const unsubscribe = manager.subscribeVisibilityRequests?.((change) => {
    if (!self && change?.layerId) revealed.delete(change.layerId);
  });
  return {
    /** The event the Autopilot now shows, or null. */
    show(event) {
      const wanted = new Set(
        layersForEvent(event).filter((id) => manager.layers?.has?.(id) ?? true),
      );
      for (const id of [...revealed])
        if (!wanted.has(id)) {
          revealed.delete(id);
          set(id, false);
        }
      for (const id of wanted)
        if (!revealed.has(id) && manager.isEnabled?.(id) !== true) {
          revealed.add(id);
          set(id, true);
        }
    },
    destroy() {
      this.show(null);
      unsubscribe?.();
    },
  };
}
