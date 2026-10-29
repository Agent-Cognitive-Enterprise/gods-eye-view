# Fork changelog (early-warning Autopilot)

Changes carried by this fork on top of upstream. Upstream's `CHANGELOG.md`
and `changelog.d/` stay upstream's: a `changelog.d/<pr>-<slug>.md` fragment
is added only when a change is proposed upstream and has a pull request
number there.

## Unreleased (branch `feature/global-early-warning-autopilot`)

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
