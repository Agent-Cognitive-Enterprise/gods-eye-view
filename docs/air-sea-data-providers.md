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
a 404. The detector was prepared outside this repo and redesigned here after
five adversarial reviews and an external review. Its principle: establish
where a ship could not have travelled, rather than prove where it is.

- **Which reports count.** Class A and B position reports only (not long-range
  type 27), with the message's own coordinates. The report must carry its own
  UTC second (`Timestamp` 0-59; 60-63 mean no fix) within 15 s of the second of
  AISStream's `time_utc`. AISStream does not document `time_utc` as the fix
  time. The check is modulo a minute, so it catches a late relay only when the
  delay is not close to whole minutes. Reports more than 5 minutes old, out of
  order or repeated are ignored. Static reports give the ship type.
- **Three states.** Each report is `plausible`, `implausible` or `unknown`.
  - Speed limits depend on the kind of ship, from its AIS type. Up to the
    screening speed a move is plausible; up to the physical limit it is
    suspicious (`unknown`); beyond that it is implausible. Cargo ships and
    tankers: 30 and 40 kn (JMIC flags commercial ships over 30 kn). Passenger
    ships: 40 and 60. Fishing, tugs and other work boats: 30 and 50.
    High-speed craft, pleasure, pilot, SAR and military boats, and untyped
    class B units: 60 and 100. Unknown: 40 and 100. Speeds allow 0.5 km of
    position noise and 15 s of timing slack.
  - Ferries, small craft and unknown vessels may be fast: a suspicious stretch
    joins the vessel's trusted history once it shows that pace itself, over
    three reports and two minutes, and raises its screening speed: up to the
    physical limit, but no higher than 60 kn for a vessel of unknown type, so
    sustained 60-100 kn never reads as plain sailing for one. Cargo ships and
    tankers never do. A ship's own past speed is supporting evidence, never a
    limit.
  - Each step is also checked against the vessel's points up to 10 minutes
    back, so short steps cannot add up to an impossible drag.
- **Segments.** A vessel's trusted segment is its credible movement history,
  kept for 24 hours; only plausible reports extend it. A new track is
  provisional for its first three reports: one that does not fit them restarts
  the track. A report the trusted segment cannot explain opens a quarantined
  segment, and rejected reports never change the trusted history.
- **Episodes and recovery.** An implausible report opens an episode, and only
  an explicit recovery closes it. The episode remembers where its false
  positions went: where the spoof first landed, and up to 16 places, each
  with a clear radius of half its jump from the trusted fix (at most 10 km)
  that lapses 30 minutes after the last visit. While it is open:
  - a recovery candidate is plausible from the trusted fix, clear of those
    places, and nearer the ship's own track than to anywhere the spoof went.
    The own track is the line from the last trusted fix to where the ship
    would be had it held its course and speed. Being reachable from the old
    fix is not enough, as its reach grows every hour.
  - a report a quarantined segment of the spoof explains is the spoof. The
    exception is a recovery candidate: back on the ship's own track while the
    segment is a single glitch report, or while the spoof first landed on
    the ship's course (within 20 km of it), so the real ship can sail through
    it;
  - anything else near the spoof is held without being added as a new spoof
    place, so an honest ship held for a while does not mark its own track;
  - a suspicious report more than 20 km off the ship's own track is marked as
    another place the spoof went.

  Recovery takes three consecutive candidates, a minute or more apart in
  total. So a spoof that is held, jitters, circles, hops among points, or
  lands off course and drags back onto the ship's line is not adopted. An
  honest ship that sails on through a spoofed or glitched point gets free
  once it is clear of it.

- **Suspicious stretches.** A suspicious segment of a ship that may be fast
  (ferries, small craft, unknown), opened on speed, joins the trusted history
  once it shows that pace over three reports and two minutes; this also ends
  an episode if it is clear of every false position. Any suspicious segment,
  outside an episode, joins once it has moved for two minutes at no more than
  the screening speed: a burst of speed, a berth up a river, a coastline the
  route search got wrong.
- **Silence is not evidence.** A vessel that goes quiet keeps its last credible
  position, and a reappearance is judged over the whole gap at the screening
  speed. Nothing is inferred from the silence itself, so a ship that turned
  its AIS off for safety, or sailed out of coverage, is not suspicious.
- **Geography.** A land grid built at start-up from the bundled Natural Earth
  countries (0.05°, about 5.5 km; about half a second) gives two more checks.
  - A jump from the sea to 10 km or more inland, by a vessel never seen
    inland, is noted as `land`. At speed it is implausible; at a ship's pace it
    is only `unknown`, because ports up rivers (Hamburg reads 24 km inland)
    and lakes are land on this coastline.
  - A long step between two sea points that crosses land is timed along the
    shortest water route. The Suez, Panama, Kiel and Corinth canals, the
    Bosporus, Dardanelles and Messina are opened by hand. A route that is too
    long marks the move `unknown`, never implausible.
  - Searches run on the AIS ingest path, so they are bounded. One search
    stops after 30,000 cells or 20 ms (about 26 ms measured at worst on the
    real grid) and then gives no route evidence. At most 4 run back to back,
    refilled at 2 a second by processing time, never by AIS time, which
    arrives out of order across vessels. A burst of reappearing ships costs at
    most 4 searches, about 100 ms at worst; then at most 2 a second. A found
    route is cached per position; "longer than", or a search that gave up, is
    reused only for a travel budget up to 10% larger. As the limits run on
    processing time, a replay faster than real time gets less route evidence.
- **Feed faults.** None of these votes:
  - a corrupted position field: a coordinate collapsed towards 0 while the
    ship was far from it, a sign flipped, or the two swapped, allowing for how
    far the ship could really have moved. Live data had the first: inland
    vessels near 52° N 5° E reported single positions at their own latitude
    with a longitude of 0.007 to 0.1, several ships within minutes;
  - a stale repeat: a report within 1.5 km of where the ship was minutes or up
    to two hours before;
  - two ships sharing one MMSI: when quarantined reports keep interrupting a
    recovery that then carries on, that MMSI's votes are dropped for a day.
    Not when the interrupting positions lie in a landing zone (below): that
    is a spoof flickering on and off at the edge of its reach.
- **Ambiguous evidence.** A jump that leaves one coordinate unchanged to 55 m,
  against the last fix or where the ship would be now on its course
  (`ambiguous_axis`), could be a corrupted field or a real spoof along a
  parallel or meridian. It votes and counts in the diagnostics, but a region
  needs three or more clear votes besides, and it marks no landing zone; the
  region reports how many ambiguous ones it holds (`ambiguousAxisVessels`).
- **Votes and regions.**
  - A vessel votes on an implausible jump only if:
    - its trusted segment has two or more reports;
    - it has been continuous for 30 minutes, with a gap of over 10 minutes or
      an adopted suspicious stretch restarting that clock;
    - its last credible fix is at most 30 minutes old;
    - the jump is 50 km or more (or 10 km onto land) and leaves its own
      neighbourhood of 20 km cells (resolution 5);
    - it was not first seen inside a spoof landing zone while the zone was
      active. A zone is a place, about 50 km across (a resolution-5 cell and
      its neighbours), where the first false positions of three or more
      other voting vessels landed within 3 hours of one another, in the last
      day. It stays active while their votes keep renewing there. A ship
      first seen there and then may be trusted at a false position, and its
      "return" to where it really is would put a region at the spoof target.
      Only the jump that creates a vote marks a zone, so a spoof dragged
      along a lane marks one point, not the lane.

    A track restarted after 24 hours during an episode cannot vote for a day.
    Later reports of the same episode keep the vote fresh and follow the
    false position while they are implausible from the trusted fix, or
    within the clear radius of a place the spoof went in the last 30
    minutes. A ship held by mistake, sailing or anchored away from the
    spoof, keeps no region alive. A recovery from a spoof the ship reported
    through, without falling silent, keeps its 30 minutes of history, so a
    spoof that flickers on and off keeps voting.

  - A ship that was in a zone before it formed, or arrived long after, still
    votes. If most ships of a region were first seen inside a zone, the region
    is kept but labelled `sourceLocation: "ambiguous"` (with
    `sourceInLandingZone: true`), and it is never an Autopilot record: they
    may be real ships there (a port beside the spoofer) or ships trusted at a
    false position, and AIS cannot tell which. Other regions say
    `sourceLocation: "credible"`.

  - Regions are where the voting ships credibly were, in H3 cells of about
    50 km (resolution 4) counted with their neighbours, so a cluster split by
    a cell edge is one region. It needs three or more vessels whose false
    positions agree: within one resolution-4 cell and its neighbours, up to
    about 130 km apart (at resolution 3, 40% of random independent jumps
    agreed; at resolution 4, 3%). A region is formed from those vessels only:
    its counts, area and times. Others nearby whose false positions went
    elsewhere stay free for a second region (and are counted as
    `otherNearbyVessels`). Cells of 20 km, like UKMTO's anomaly
    mapping, were tried first: in the Baltic replay they were too fine for
    open-sea traffic, and most voting ships fell in no region.
  - A region keeps its id while its cells overlap and its false positions
    still agree, as ships join or leave; two incidents from one place to two
    targets have two ids. It
    lasts while fresh votes support it and ends 30 minutes after the last.
    Ended regions stay in `recentIncidents` for 24 hours, as history, never as
    alerts, with their last `sourceLocation`.
  - The screen uses the H3 cells; the 1° grid remains in the code for
    comparison (`grid: 'degree'`), but its landing zones are whole degree
    cells, so there it finds much less.
  - MMSIs must be a ship station's (MID 201-775), not one digit repeated
    (`222222222`) or a country code with six zeros (`412000000`). A position
    within a degree of 0° N 0° E with a coordinate exactly zero is refused as
    a transponder without a fix (the Danish data has a fishing vessel at
    0.98° N, 0.000000° E); real positions nearby count.
- **Known gaps.**
  - A track first seen while already spoofed is trusted as it is.
  - A spoof that moves at a believable speed from a believable start cannot be
    told from a real track without independent reference data.
  - A spoof that moved more than 2 km during a reception gap of over 10
    minutes is adopted. Its vote then waits 30 minutes, so a return from it
    within that time is not reported from the false position.
  - A spoof placed on the ship's own course at the distance it would have
    sailed is taken for the ship.
  - A spoof that landed on the ship's own course and is then dragged back
    along it is taken for the ship.
  - A vessel whose real position lies nearer the spoof than its own track
    (it turned towards the false position, or berthed beside it) stays held
    until it is back on a track of its own, or its history lapses after 24
    hours, and then cannot vote for a further day. It keeps no vote alive
    meanwhile unless it stays within a spoof place's clear radius (10 km at
    most).
  - During an episode, a ship whose real reports are only ever suspicious,
    not on speed
    (a river port that reads as inland, a channel the route search misses)
    cannot recover until its history lapses.
  - A spoof whose false positions drift away from every place it landed, at
    a pace the old fix could explain, stops renewing its votes once it is
    clear of them: its region ends while the ships may still be spoofed.
  - Ships first seen at a spoof point before any spoof there was seen may
    really be there; their regions are kept but marked (above).
  - Landing zones live in memory. After a restart in the middle of a spoof,
    ships already at the spoof point are first seen before any landing, so a
    region can appear at the spoof target until the spoof ends.
  - Ships really in a landing zone, such as a port beside the spoofer, cannot
    be told from ships first seen there while spoofed, if both arrive while
    the zone is active.
- **What it says.** A coarse box with `confidence: low`, `cause_assessment:
unconfirmed` and vessel counts, including how many false positions were on
  land: no MMSI, no positions, no target location. It is an AIS anomaly, not
  proof of spoofing or jamming, and says nothing about where a transmitter is.
  Receiver artefacts, relays, shared MMSIs and data lag can produce the same
  pattern. The `diagnostic` block counts:
  - assessments and evidence kinds;
  - recoveries, promotions and gaps;
  - quarantined vessels;
  - refused envelopes, by reason;
  - how far each report's own second sits from `time_utc`, and how far
    `time_utc` lags its receipt here.
- **Coverage.** Only waters AISStream covers. For its first 30 minutes it says
  `warming_up`. A feed that is not `healthy`, or no usable report for 5
  minutes, answers `coverage_uncertain` with no regions; no key answers
  `unconfigured`. Neither means the sea is clear. AISStream's coverage of the
  Gulf, Hormuz and the Gulf of Oman is close to none: on 6 November 2026 the
  running instance held 13 vessels in that whole area.
- **Map (Ship GNSS Screen layer).** In the Air & Sea group of the Layers panel.
  It reads the same route once a minute while on, and draws each region's box
  where the ships were: orange for a credible source location, grey for an
  ambiguous one. Incidents that ended in the last 24 hours are drawn as
  outlines, grey if their source location was ambiguous (the ENDED chip
  hides them). The row says the screen's status, the
  region count and how many vessels it tracks, and lists the regions; choosing
  one flies there and pauses the Autopilot. It shows no ships and no false
  positions. Local-only, like the other Air & Sea layers: remembered per
  browser, never in share links, not voice-controlled. With the route off it
  says the screen is not enabled. With the Autopilot flag, a GNSS advisory the
  Autopilot shows switches this layer on for as long as it is shown.
- **Autopilot.** Off unless `GEV_GNSS_REGIONAL_AUTOPILOT=1` is also set; the
  screen only observes until it has been validated on real anomalies. With
  it and the early-warning engine on, each region becomes an analyst record
  (severity hint 25, regional precision), refreshed every 10 minutes while
  the region lasts and valid for the screen's 30-minute window. Its subtype is
  an advisory (`ADVISORY_SUBTYPES` in `src/intel/taxonomy.js`):
  - it never joins another event, so it cannot corroborate a news report;
  - it is never camera-eligible, near home or not;
  - the local model never assesses it;
  - it can appear on the map and as an ambient tour stop.
- **Validation on Danish AIS.** The Danish Maritime Authority's free
  historical AIS (aisdata.ais.dk) covers Danish and southern Baltic waters,
  about 51.5-60° N and 6.5° W-21° E, including Bornholm, Gdansk and the
  Kaliningrad coast. Each day was replayed through the screen in file order,
  with snapshots every 5 minutes; a day of about 10 million accepted position
  reports takes about 2 minutes. There is no other ground truth.

  | Days             | What is known                                                                                                                 | Regions |
  | ---------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------- |
  | 1-3 July 2025    | GPSPatron's shipborne measurements: spoofing in the southern Baltic, about 30 hours within 1-3 July                           | 39      |
  | 27-28 March 2025 | Lloyd's List, 31 March: tracks of ships at Gdynia and Gdansk jumping to the Kaliningrad area (dates not given); not a control | 0       |
  | 1-3 July 2019    | before Baltic interference was common (negative control)                                                                      | 0       |
  | 3 November 2026  | an ordinary recent day (negative control)                                                                                     | 0       |
  - **The July 2025 episode.**
    - Ships in the southern Baltic jumped to points on the Kaliningrad coast
      and to about 55° N 21.5° E by the Curonian Lagoon, many onto land.
    - Voting ships rose from 0-10 an hour to 27 in the 14:00 UTC hour on 1
      July. The first region formed at 14:30, with up to 9 vessels in one
      region.
    - Regions were present for most of 1 July 14:30 to 2 July 06:35, and
      again from 22:00 on 2 July to 00:05 on 3 July. During the day on 2 July
      2-10 ships an hour voted, too few or too spread out to make three in one
      region within 30 minutes.
    - All 39 regions are where the voting ships were trusted, at sea between
      Bornholm, Gotland and the Polish coast (54.9-56.8° N, 15.2-18.7° E).
      None is at a spoof target. There are more than before the external
      review (23) because a region is now formed only from ships whose false
      positions agree, and keeps its id only while they do: ships from one
      area spoofed to the Kaliningrad coast and to the Curonian Lagoon make
      separate regions, and an incident whose target moves gets a new id.
  - **Landing zones.** The same days with zones switched off
    (`landingZones: false`) give 38 regions, the same areas split
    differently. Zones matter little here, as the replay starts before the
    episode; they matter for ships first seen while spoofed. One vessel
    first seen at a spoof point in the Curonian Lagoon renewed a single vote
    for about 8 hours. A single vessel makes no region.
  - **No false alarm on the controls.** At most 11 ships an hour voted on the
    July 2019 days and 9 on the March 2025 days (ambiguous one-axis votes
    included), never three clear and coherent in one region.
  - **Live finding.** The corrupted-field artefact came from the live AISStream
    feed (6,061 vessels over 17 hours, no region).

  The thresholds are engineering choices, checked on these nine days, not
  calibrated rates. The Gulf has no comparable free archive, and AISStream
  keeps no history.

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
