// Air & Sea signals (fork feature), read in-process through the air/sea hub
// (server/providers/airsea/signals.js): warning areas whose traffic changed,
// severe aviation/maritime warnings and traffic-anomaly clusters. Nothing is
// fetched from the network here; the air/sea plugin already collects.

export function airSeaConnector({ hub }) {
  return {
    id: 'airsea-signals',
    provider: 'airsea',
    url: null,
    intervalMs: 10 * 60_000,
    // Quiet seas and skies produce no record at all; health is the hub's.
    staleAfterMs: null,
    license: 'Derived locally; warning sources keep their own licences',
    attribution:
      'Air & Sea: OpenSky Network, adsb.lol (ODbL), AISStream.io, warning authorities',
    async poll({ now }) {
      // Both plugins start together; the first poll may come first.
      if (!(await hub.whenReady()))
        throw new Error('air/sea monitoring not started');
      const records = hub.records();
      return {
        records,
        latestObservationAt: records.length ? now() : null,
      };
    },
  };
}
