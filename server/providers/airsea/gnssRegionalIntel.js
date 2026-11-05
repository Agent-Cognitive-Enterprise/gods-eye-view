/** Optional advisory-only conversion into the existing Air & Sea intel schema. */
export function regionalGnssIntelRecords(snapshot) {
  if (
    snapshot?.schemaVersion !== 1 ||
    snapshot.status !== 'candidate_regions' ||
    snapshot.coverage?.feedStatus !== 'healthy' ||
    snapshot.coverage?.stale
  )
    return [];
  const results = [];
  for (const region of snapshot.regions ?? []) {
    if (
      region?.domain !== 'sea' ||
      region?.confidence !== 'low' ||
      region?.causeAssessment !== 'unconfirmed' ||
      region?.eventPriority !== 'advisory'
    )
      continue;
    const { south, north, west, east } = region.area ?? {};
    if (
      ![south, north, west, east].every(Number.isFinite) ||
      north <= south ||
      east <= west
    )
      continue;
    const title = 'Possible regional AIS navigation-integrity anomaly';
    results.push({
      provider: 'airsea',
      source_item_id: `gnss:${region.id}`,
      event_key: `gnss:${region.id}`,
      lineage_key: `airsea:gnss:${region.id}`,
      publisher: "God's Eye View traffic analysis",
      source_type: 'analyst',
      url: null,
      license: 'Derived locally; original AISStream terms apply',
      attribution: 'AISStream.io',
      language: 'en',
      category: 'infrastructure_disruption',
      subtype: 'possible_navigation_integrity_anomaly',
      title,
      // Deliberately do not expose vessel IDs, false destinations, exact
      // trajectories, or anything implying transmitter localisation.
      // Fork: the coherent count is the evidence; others jumped elsewhere.
      summary: `At least ${region.evidence.coherentTargetVessels} vessels here reported implausible AIS position jumps to the same distant area within 30 minutes. AIS-only advisory: not confirmation of GNSS interference, and no location of its cause.`,
      occurred_at: new Date(region.firstSeenAt).toISOString(),
      published_at: new Date(region.lastSeenAt).toISOString(),
      valid_until: new Date(region.lastSeenAt + 20 * 60_000).toISOString(),
      location: {
        lat: (south + north) / 2,
        lon: (west + east) / 2,
        precision: 'region',
        geolocation_status: 'approximate',
        bounds: { south, north, west, east },
      },
      metrics: {
        severity_hint: 25,
        confidence: 'low',
        cause_assessment: 'unconfirmed',
        coherent_vessels: region.evidence.coherentTargetVessels,
        unique_vessels: region.evidence.uniqueVessels,
        // Fork: a 10-minute bucket, so a region still being reported is a new
        // observation and keeps its event live (the digest covers metrics).
        observed_through: new Date(
          Math.floor(region.lastSeenAt / 600_000) * 600_000,
        ).toISOString(),
        source_count: 1,
      },
    });
  }
  return results;
}
