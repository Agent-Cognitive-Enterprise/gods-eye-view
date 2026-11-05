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
a 404. The detector was prepared outside this repo and reworked here after an
adversarial review.

- **Which reports count.** Class A and B position reports only (not long-range
  type 27), with the message's own coordinates. The report must carry its own
  UTC second (`Timestamp` 0-59; 60-63 mean no fix) within 15 s of the second of
  AISStream's `time_utc`. AISStream does not document `time_utc` as the fix
  time, so this catches most late relays, though not delays of whole minutes.
  Reports more than 5 minutes old, out of order or repeated are ignored. The
  MMSI must be a ship station's (MID 201-775), not a placeholder such as
  `111111111` or `123456789`.
- **What counts as an anomaly.** A vessel needs two plausible fixes first. A
  later fix at least 10 km away that implies more than 100 knots is an outlier
  and never becomes the vessel's trusted position. Outliers count only from the
  cell the vessel was trusted in when the anomaly began, and only towards a cell
  at least two cells away. A region is reported when three or more different
  vessels in one 1° cell jumped, within 30 minutes, to the same such cell.
  Silence of 20 minutes since a vessel's last report starts its track afresh. A
  vessel whose trusted position moves far while it is under suspicion (a long
  spoof can come to look reachable) never votes again.
- **What it says.** A 1° box with `confidence: low`, `cause_assessment:
unconfirmed` and vessel counts: no MMSI, no positions, no target location. It
  is an AIS anomaly, not proof of spoofing or jamming, and says nothing about
  where a transmitter is. Receiver artefacts, relays, shared MMSIs and data lag
  can produce the same pattern. `diagnostic.refusedEnvelopes` counts reports
  refused, by reason.
- **Coverage.** Only waters AISStream covers. For its first 10 minutes it says
  `warming_up`. A feed that is not `healthy`, or no usable report for 5
  minutes, answers `coverage_uncertain` with no regions; no key answers
  `unconfigured`. Neither means the sea is clear.
- **Autopilot.** With the early-warning engine on, each region becomes an
  analyst record (severity hint 25, regional precision), refreshed every 10
  minutes while it lasts. Its subtype is an advisory
  (`ADVISORY_SUBTYPES` in `src/intel/taxonomy.js`): it never joins another event,
  so it cannot corroborate a news report, and it is never camera-eligible, near
  home or not. It can appear on the map and as an ambient tour stop.
- **Checked.** On 5 November 2026 the recent AIS tracks held by a running
  instance (6,954 vessels, 61,954 fixes over 84 minutes; tracks are thinned to
  30 s and 25 m, so one vessel's covers at most about half an hour) produced 17
  outliers and no region. The same stream with three injected coordinated jumps
  produced exactly one. The replay skipped the report-time rules above, which
  still need a live run. The thresholds are engineering choices, not calibrated
  rates.

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
