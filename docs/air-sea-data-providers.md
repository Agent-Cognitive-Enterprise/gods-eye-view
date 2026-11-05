# Air & Sea monitoring: data providers

What the Air & Sea layers can see, how each source may be used, and what is
deliberately not connected. Status as of 30 October 2026. Background and
design: [air-sea-audit.md](air-sea-audit.md).

**For situational awareness only. Not for aviation or maritime navigation.**
An empty area means no connected source or no report, never "no traffic"
or "no warning".

## Traffic (Air Traffic, Sea Traffic layers)

| Source                       | Access                                                     | Coverage                                   | Use here                                                        |
| ---------------------------- | ---------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------- |
| OpenSky Network `states/all` | Machine-readable; free account (OAuth client) or anonymous | Worldwide where receivers hear aircraft    | Shared proxy snapshot; every 5 min with OAuth, 30 min anonymous |
| adsb.lol military / regional | Machine-readable, ODbL                                     | Military worldwide; 250 nm around the view | Shared proxy snapshots                                          |
| AISStream                    | Machine-readable WebSocket; free key                       | Coastal and port waters                    | The vessel layer's single socket                                |

## Warning areas (Warning Areas layer)

| Source                                                                                                 | Domain             | Access                                      | Status here                                                                                                                           | Coverage                                                       | Licence / terms                                                                                                       |
| ------------------------------------------------------------------------------------------------------ | ------------------ | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| NWS active marine alerts (`api.weather.gov/alerts/active?region_type=marine`) + forecast zone outlines | Marine weather     | Machine-readable                            | **Connected** (10 min; zones cached 14 days)                                                                                          | US coastal, offshore and Great Lakes zones                     | US Government work, public domain                                                                                     |
| Canadian Coast Guard S-124 trial exchange set                                                          | Maritime (NAVWARN) | **Trial / test data**                       | **Connected, TRIAL** (12 h, conditional)                                                                                              | Canadian waters in the set (St. Lawrence, Great Lakes, Arctic) | Government of Canada; "should under no circumstances be considered as operational or official"; never used for alerts |
| FAA NOTAM API                                                                                          | Aviation           | Permission required (FAA data agreement)    | Not fetched; `permission_required` (with `FAA_NOTAM_CLIENT_ID`/`SECRET` set: `unconfigured` until the approved API details are wired) | US airspace                                                    | FAA agreement                                                                                                         |
| EUROCONTROL EAD                                                                                        | Aviation           | Permission required                         | Not fetched                                                                                                                           | Europe                                                         | Agreement needed; EAD Basic is for human viewing                                                                      |
| Airservices Australia NAIPS                                                                            | Aviation           | Written authorisation required              | Not fetched                                                                                                                           | Australia                                                      | Terms prohibit bots, scripts, scrapers and AI tools without prior written authorisation                               |
| AMSA MSI (NAVAREA X)                                                                                   | Maritime           | Public pages; bulk/API licence not verified | Not fetched                                                                                                                           | Australia                                                      | Ask AMSA before automated use                                                                                         |
| Other NAVAREA coordinators (IHO directory)                                                             | Maritime           | Human-readable, uneven                      | Not connected                                                                                                                         | Worldwide, uneven                                              | No scraping rights assumed                                                                                            |

There is **no aviation warning source connected**: the Warning Areas layer
draws no aviation areas, and its row says so for every aviation source.

## Regional GNSS screen (AIS, opt-in)

`GEV_GNSS_REGIONAL=1`, with Air & Sea on and an AIS key, watches the vessel
positions the one AISStream connection already receives for signs that a
navigation fix went wrong in many ships at once. It opens no connection, keeps
nothing on disk, and answers `GET /api/airsea/gnss-regions`. Off, that route is
a 404. The detector was prepared outside this repo and reworked here after three
adversarial reviews and an external review.

- **Which reports count.** Class A and B position reports only (not long-range
  type 27), with the message's own coordinates. The report must carry its own
  UTC second (`Timestamp` 0-59; 60-63 mean no fix) within 15 s of the second of
  AISStream's `time_utc`. AISStream does not document `time_utc` as the fix
  time. The check is modulo a minute, so it catches a late relay only when the
  delay is not close to whole minutes: roughly half of long delays still pass.
  Reports more than 5 minutes old, out of order or repeated are ignored.
- **What counts as an anomaly.** A vessel is trusted only from fixes that are a
  plausible move from its last trusted fix. A fix at least 10 km away that
  implies more than 100 knots is an outlier. After one, the vessel is under
  suspicion for 30 minutes: fixes within 20 km of where that impossible jump
  went are outliers too (an old trusted fix makes a long spoof look reachable),
  and a new trusted fix must be reachable at no more than 30 knots, or 1.5 times
  the vessel's own earlier speed. A ship that sails on is trusted again. A
  vessel votes after two plausible fixes and 30 minutes of tracking, for jumps
  of 50 km or more into another 1° cell. A region is reported when three or more
  different vessels in one cell voted, within 30 minutes, for the same target
  cell; it stays reported while the spoof goes on and ages out 30 minutes after
  the last vote. Silence of 20 minutes since a vessel's last report starts its
  track afresh. MMSIs must be a ship station's (MID 201-775), not one digit
  repeated (`222222222`) or a country code with six zeros (`412000000`).
- **Known gaps.** A vessel first seen while already spoofed, a reception gap of
  20 minutes in the middle of a spoof, a spoof that drags positions away
  gradually, or one that moves its target slowly enough to look like sailing,
  can leave a vessel trusted at a false position; a later jump from there is
  then reported from that false cell. Vessels voting for alternating targets
  out of step, or for targets either side of a cell edge, are not seen as
  coherent.
- **What it says.** A 1° box with `confidence: low`, `cause_assessment:
unconfirmed` and vessel counts: no MMSI, no positions, no target location. It
  is an AIS anomaly, not proof of spoofing or jamming, and says nothing about
  where a transmitter is. Receiver artefacts, relays, shared MMSIs and data lag
  can produce the same pattern. `diagnostic.refusedEnvelopes` counts reports
  refused, by reason, and `diagnostic.timing` counts how far each report's own
  second sits from `time_utc` and how far `time_utc` lags its receipt here, so
  a live run shows whether the time rules fit real traffic.
- **Coverage.** Only waters AISStream covers. For its first 30 minutes it says
  `warming_up`. A feed that is not `healthy`, or no usable report for 5
  minutes, answers `coverage_uncertain` with no regions; no key answers
  `unconfigured`. Neither means the sea is clear.
- **Autopilot.** Off unless `GEV_GNSS_REGIONAL_AUTOPILOT=1` is also set: until
  the time rules have been checked against live envelopes, the screen only
  observes. With it and the early-warning engine on, each region becomes an
  analyst record (severity hint 25, regional precision), refreshed every 10
  minutes while the region lasts and valid for the screen's 30-minute window.
  Its subtype is an advisory (`ADVISORY_SUBTYPES` in `src/intel/taxonomy.js`):
  it never joins another event, so it cannot corroborate a news report; it is
  never camera-eligible, near home or not; and the local model never assesses
  it. It can appear on the map and as an ambient tour stop.
- **Checked.** On 5 November 2026 the recent AIS tracks held by a running
  instance (7,476 vessels, 88,535 fixes over 137 minutes; tracks are thinned to
  30 s and 25 m, so one vessel's covers at most about half an hour) produced 30
  outliers, no vote and no region. The same stream with three injected
  coordinated jumps produced exactly one. The replay skipped the report-time
  rules, which still need a live run. The thresholds are engineering choices,
  not calibrated rates.

The existing GNSS Integrity layer (aircraft, from ADS-B navigation accuracy)
is separate and unchanged.

## How geometry is treated

- Only geometry a source states is drawn. S-124 polygons, lines and points
  are drawn as given (GML `lat lon` swapped to GeoJSON `[lon, lat]`); an
  S-124 circle (centre and radius) becomes a 64-point geodesic polygon,
  marked `derived_checked`. Points are never buffered into areas.
- NWS marine alerts carry no shape: the official forecast zone outlines
  they name are drawn (whole zones; the alert may affect part of one). Until
  a zone outline has loaded, the alert is a list record only.
- A warning without usable geometry is a list record (`geometry
unavailable`), never a polygon.

## Lifecycle

`scheduled` → `active` → `expired`, or `cancelled`, from each source's own
times. A warning is never expired because its feed went quiet; it ends
when its stated end passes, when the source cancels or supersedes it, or
when two complete, successful listings in a row from that source no longer
contain it (`removed_by_source`). If the source lists it again, it is
reinstated. Ended warnings are kept 30 days with their change history (`new`,
`changed`, `cancelled`, `expired`, `reinstated`).
