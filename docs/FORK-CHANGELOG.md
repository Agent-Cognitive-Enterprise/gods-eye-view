# Fork changelog (early-warning Autopilot)

Changes carried by this fork on top of upstream. Upstream's `CHANGELOG.md`
and `changelog.d/` stay upstream's: a `changelog.d/<pr>-<slug>.md` fragment
is added only when a change is proposed upstream and has a pull request
number there.

## Unreleased (branch `feature/global-early-warning-autopilot`)

- **S2 GhostMaps age window.** S2's "Last 30 Days" export reaches back to 2013,
  so the layer drew years-old events as if current. A 6 H to 1 Y selector
  (default 1 M, remembered) now judges each placemark by its own Date field. A
  bare date lasts until that day ends. Undated events stay hidden; sites and
  areas are not events and stay on.
- **Upstream sync to a725178e.** Brings the Authoring panel (Scenes renamed and
  laid out in steps), one title style for the side panels, the Autostrada del
  Brennero (A22) webcams and an IPv4 retry for FIRMS.
- **Upstream sync to 423ca3ca.** Brings German, French, Italian, Brazilian
  Portuguese, Ukrainian and Japanese, CCTV view thinning, AIS vessels that let
  the scene idle, Vite 6.4.4 and Puppeteer 25.16.0, and the Context panel
  cleanup; removes the Operator HUD layout, the Snow preset and the Radio icon
  in the Context header. The fork's 263 strings are translated into the six
  new languages (not yet reviewed by native speakers).
- **Air & Sea, Phase E (branch `feature/air-sea-monitor`).** Hardening after
  four adversarial reviews. False signals: a first sighting or edge jitter is
  no passage, a stalled feed is missing coverage, anomaly noise is floored at
  counting noise, a small reference gives no percentage, and baseline weeks
  end before the warning began. Warnings: one empty listing ends nothing,
  re-listed warnings are reinstated, NWS cancellations and reissues are
  followed, one event per warning chain, resolved when it ends. Engine:
  ownership by report family, so a copy of an official report cannot rewrite
  it. Layers: only a person's own on/off is remembered, Autopilot reveals are
  never saved and respect a layer switched off, stale answers are dropped,
  and rebuilds are lighter. Server: cached, lighter warning lists, footprint
  view boxes, hourly correlations, sturdier SQLite, ZIP and download caps,
  and no error text in 500 answers. See `docs/air-sea-audit.md`.
- **Air & Sea, Phase D (branch `feature/air-sea-monitor`).** Warning ×
  traffic correlation: for every active warning area with a stated polygon,
  passages inside after it took effect against the same hours in earlier
  weeks (or, until two weeks exist, the hours just before it), with the
  surrounding ring as the control for time of day and feed-wide swings, an
  inner ring for possible rerouting, coverage gating and
  `causeAssessment: unconfirmed`. A new Autopilot feed, "Air & Sea
  signals", forwards only qualified records: a warning with a clear
  traffic change becomes one officially reported event carrying both
  receipts (the warning and the local measurement); severe aviation or
  maritime warnings on their own; anomaly clusters once a baseline exists.
  Marine weather alone, TRIAL data and degraded coverage never enter the
  queue. A followed warning's card is refreshed when traffic returns to
  normal. While the Autopilot shows such an event, the Warning Areas and
  traffic (or anomaly) layers are switched on, and switched off again
  afterwards unless the operator took them over. `/api/airsea/correlations`
  lists every reading. Engine: one report family (same provider and stable
  key) may fill in and refresh what it stated itself, never override
  another source.
- **CI.** Fork Autopilot CI also runs on `feature/air-sea-monitor`, with an
  explicit Air & Sea test step on Ubuntu and Windows.
- **Air & Sea, Phase C (branch `feature/air-sea-monitor`).** Traffic
  footprint: every accepted fix is followed along its great circle (only
  when gap and speed are plausible) into passages per H3 cell and
  object-minutes, kept in a local SQLite history (5-min rows for 3 days,
  hourly rows for 120 days, per-hour feed coverage). TRAFFIC view (default:
  passages over 15 min–24 h for air, 1–72 h for sea; 12 h / 24 h default)
  beside the NOW view (current occupancy). Traffic Anomalies layer: the
  last complete hour against the same hour of the week in up to four
  earlier weeks (median and robust z-score), purple for possible
  suppression and yellow for possible increase; nothing is reported until
  two comparable weeks exist, and a feed that delivered too little reads
  "coverage degraded: inconclusive", never as a drop in traffic. Shared
  hexagons: where air, sea and a shown warning area meet in one cell, the
  hexagon is split into halves or thirds (blue, green, red); sea joins the
  air grid while both are on screen.
- **Air & Sea, Phase B (branch `feature/air-sea-monitor`).** Warning Areas
  layer: canonical warning records with validated GeoJSON, stated circles,
  lifecycle (scheduled/active/expired/cancelled, superseded, removed by
  source) and change history; NWS marine alerts on official zone outlines;
  Canadian Coast Guard S-124 trial data drawn dashed and labelled TRIAL;
  FAA NOTAM, EAD, NAIPS, AMSA and other NAVAREA sources listed honestly as
  permission required or not connected; newest-warnings list with source
  links and effective times.
- **Air & Sea, Phase A (branch `feature/air-sea-monitor`).** Air Traffic
  (blue) and Sea Traffic (green) H3 density layers in a new Air & Sea group,
  fed by the existing OpenSky / adsb.lol / AISStream proxies (no new
  provider, no extra poller); aircraft counted once across feeds; per-cell
  ages and feed health; DENSITY / AIRCRAFT|VESSELS / BOTH and 15 min–24 h
  window chips; background collection while hidden; settings per browser.
- **Layout.** FEEDS (with the local model's status) moved to a left-stack
  panel with an "N/M up" count and failing feeds listed first; the Autopilot
  panel fills the right column and folds CAMERA RULES away (remembered per
  browser), showing up to 30 events; both side columns start under the
  title; GSD / ALT / AIS sits under the Autopilot panel, on the bottom edge
  or above POWER UP while the corner row shows, so nothing overlaps.
- **Autopilot icon.** An aeroplane button first in the top-centre globe
  actions toggles Autopilot (resumes when paused); added at runtime by the
  console, the upstream template is unchanged.
- **Cleaner corners.** The ACTIVE STYLE indicator is hidden and the REC
  readout moves up into its place; the upper-left classification / mode /
  summary block and the lower-left MGRS / coordinate readout are hidden (CSS
  in `src/ui/styles/intel.css`; the cockpit layout is unchanged).
- **Personal relevance.** Home/Family/Travel/Custom places raise attention
  with an exponential distance curve (1,000 km radius, 400 km decay); confidence
  is unchanged and proximity alone never interrupts.
- **Lower background load.** After a model timeout the abandoned KoboldCpp
  generation is stopped, assessments rest 5 min and the event waits 30 min;
  revised events are re-assessed at most every 20 min; at most 40
  generations an hour (was 120); Autopilot tile cache 300 (was 1,000).
- **Camera moves.** Turn the globe at the current height, then descend;
  stepped zoom-out to a whole-globe view after each shot (ZOOM OUT rule);
  waits for map tiles before descending and before the hold, a larger tile
  cache and sibling preloading while Autopilot runs; the Autopilot state is
  remembered per browser across reloads.
- **S2 incidents in the tour.** Analyst-compiled incidents are tour stops
  (labelled unverified, never alerts); `tourAnalystIncidents`.
- **Auto-hiding bottom controls.** The command dock and the corner row fade
  after 4 s idle and return on any key or at the bottom edge; the map
  attribution moves to the bottom edge while they are hidden.
- **Phase 6, operations and upstream integration.** Offline mode
  (`GEV_INTEL_OFFLINE=1`); `GEV_INTEL_DB` now moves settings with the store;
  `scripts/smoke-autopilot.mjs` smoke test; `scripts/upstream-check.mjs`
  merge check in a temporary worktree; Fork Autopilot CI and the weekly
  Upstream sync workflow; Windows `Deploy-GEV.ps1`/`Test-GEV.ps1`; operator,
  feeds, QA and maintenance guides.
- **Phase 5, public feeds.** GDACS, NOAA PTWC/NTWC, US NWS, NASA EONET, WHO
  Disease Outbreak News, World Bank inflation; ReliefWeb (app name) and GDELT
  (opt-in) optional; ACLED listed only. Country and US-state geography from
  Natural Earth; aggregators never corroborate; cross-feed severity
  calibration; records beyond retention are skipped.
- **Phase 4, local voice.** whisper.cpp speech-to-text, the local model for
  commands, Piper speech; the **Local** voice provider (English, Russian);
  Autopilot narration with captions; foreground model priority over
  background assessments.
- **Phase 3, local intelligence.** Loopback KoboldCpp client; schema-bound,
  validated, revision-gated event assessments; AI status and badges;
  translated titles.
- **Tour.** Ambient tour of active events when nothing qualifies as an alert.
- **Phase 2, Autopilot.** Attention scheduler (dwell, hysteresis, cooldown,
  critical interrupt, operator yield), camera framing, the AUTOPILOT panel
  with queue, markers and evidence cards, browser QA gate.
- **Phase 1, event engine.** Evidence normalisation, copy and lineage
  detection, material updates, scoring, lifecycle, antimeridian-safe
  clustering, SQLite store, replay drills; USGS and GhostMaps feeds;
  `/api/intel` behind `GEV_INTEL_ENABLED`.
