# Autopilot feeds: what is covered and what is not

A plain statement of what the early-warning Autopilot can see. Details per
source (access, cadence, licence, failure modes) are in the source registry
in [EARLY-WARNING.md](EARLY-WARNING.md#sources-registry). Status as of
29 October 2026.

## Supported (on by default when the engine is on)

| Feed                         | Covers                                                                                                                             | Grade                       |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| USGS earthquakes             | Worldwide M4.5+, minutes after an event, revisions, PAGER alert, tsunami flag                                                      | Official                    |
| GDACS                        | Worldwide earthquakes, tropical cyclones, floods, volcanoes (Green+), droughts and wildfires (Orange/Red), with exposure estimates | Official (automatic model)  |
| NOAA tsunami warning centres | Pacific (PTWC) and US/Canada coasts (NTWC): warnings, threats, advisories, watches, cancellations                                  | Official                    |
| US National Weather Service  | United States Severe/Extreme alerts, plus relayed civil emergency, hazmat and outage messages                                      | Official                    |
| NASA EONET                   | Worldwide open storms, wildfires, volcanoes, floods, landslides                                                                    | Curated secondary           |
| WHO Disease Outbreak News    | Worldwide outbreak reports (last 45 days), country level                                                                           | Official                    |
| World Bank inflation         | Countries with very high or sharply rising annual consumer inflation                                                               | Official statistic (annual) |
| S2 GhostMaps incidents       | Dated incident exports (mostly USA, Iran/Middle East); analyst compilation                                                         | Analyst                     |

## Available but not active

| Feed      | Why not active                                                                                                                       |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| ReliefWeb | Its API requires an approved application name. Set `GEV_RELIEFWEB_APPNAME` once approved; tested on fixtures only.                   |
| GDELT     | Opt-in (`GEV_INTEL_GDELT=1`). Machine-coded news is frequently wrong; it is kept as unverified evidence and never confirms anything. |
| ACLED     | Requires an account and its terms restrict redistribution; listed, never fetched.                                                    |

## Known gaps

- **Armed conflict and civil unrest** have no verified worldwide source:
  only the GhostMaps analyst exports and opt-in GDELT. The Autopilot will miss
  or under-rate most conflict and protest events.
- **Breaking news** (multilingual RSS, wire services, The Wire) is not
  integrated: no licence and terms review has been done for any of them.
- **Infrastructure disruption** comes only from NWS civil messages (United
  States). There is no power-grid, internet-outage, transport or cyber feed.
- **Economic stress** is annual inflation only: no exchange-rate, market,
  food-price or sovereign-debt series, so a fast currency crisis appears
  months late, if at all.
- **Weather warnings outside the United States** come only through GDACS and
  EONET, at disaster scale; national meteorological agencies (Meteoalarm,
  JMA, BoM, IMD and others) are not integrated.
- **Tsunami bulletins** cover the Pacific and North American coasts; Indian
  Ocean and Mediterranean centres are not integrated.
- **Language**: all integrated sources publish in English; titles from other
  languages would be shown as received.
- **Location precision**: WHO, World Bank and ReliefWeb reports are
  country-level markers at the country's centre; NWS marine-zone alerts
  without an outline have no marker.
- **Latency**: official sources lag the event by minutes (USGS, tsunami,
  NWS), about an hour (GDACS), days (WHO) or a year (World Bank). The
  Autopilot is not a faster-than-official alerting system.

## Adding a source

Each new source needs, before code: its terms and licence (may it be fetched,
stored and shown to LAN viewers?), observed latency, coverage, failure modes
and whether it is primary, secondary or aggregated. Then a connector in
`server/providers/intel/connectors/` with fixture tests, a row in the
registry and in `DATA_SOURCES.md`, and a credit in `src/data/dataCredits.js`.
