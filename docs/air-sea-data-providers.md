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
when a complete, successful listing from that source no longer contains it
(`removed_by_source`). Ended warnings are kept 30 days with their change
history (`new`, `changed`, `cancelled`, `expired`).
