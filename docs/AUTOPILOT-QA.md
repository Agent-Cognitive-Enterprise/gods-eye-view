# Autopilot QA report and reliability review

Acceptance scenarios A01–A20 of the fork specification, mapped to the tests
that cover them and the results observed on 29 October 2026 (Windows 11,
i7-8700, GTX 1070, Node 24.22.2; KoboldCpp 1.119 with Qwen3.6-35B-A3B Q4_K_M;
whisper.cpp base-q5_1; Piper). CI runs the same suites on GitHub
(`.github/workflows/fork-autopilot.yml`) once the branch is pushed.

## How to reproduce

```powershell
# Deterministic suites (no network, no model, no audio): 114 tests
node --test src/intel/*.test.mjs server/providers/intel/*.test.mjs server/providers/localVoice/*.test.mjs src/voice/localVoice.test.mjs src/tooling/upstreamCheck.test.mjs src/tooling/smokeAutopilot.test.mjs

# Browser drill against a running instance (live dev server or offline production preview)
node scripts/qa-autopilot.mjs --url http://localhost:4174

# Local voice end to end (needs the voice sidecars and the local model)
node scripts/qa-local-voice.mjs --url http://localhost:4174 --mic <wav with a spoken command> --expect париж --lat 48.86 --lon 2.35

# Running instance smoke test; upstream merge check
node scripts/smoke-autopilot.mjs --url http://127.0.0.1:4174
node scripts/upstream-check.mjs --gates quick
```

## Acceptance mapping

| ID  | Scenario                                       | Covered by                                                                                                                                             | Result                                    |
| --- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| A01 | One verified high-priority earthquake          | `engine.test` A01; `scheduler.test` A01; `qa-autopilot` "flies to the highest-priority cluster"                                                        | Pass                                      |
| A02 | Two events 300 km apart                        | `clustering.test` A02 (one cluster, padded bounds); framing tests                                                                                      | Pass                                      |
| A03 | Events continents apart                        | `clustering.test` A03; `scheduler.test` A03; `qa-autopilot` rotation                                                                                   | Pass                                      |
| A04 | 179°E / 179°W                                  | `clustering.test` A04; `service.test` demo antimeridian pair                                                                                           | Pass                                      |
| A05 | Five syndicated copies of one wire             | `engine.test` A05; `service.test` demo (one lineage, ten duplicates)                                                                                   | Pass                                      |
| A06 | Same article every minute                      | `engine.test` A06                                                                                                                                      | Pass                                      |
| A07 | Material development / evacuation              | `engine.test` A07 (revision + linked consequence); `service.test` A07 data                                                                             | Pass                                      |
| A08 | Scores alternating 79/82                       | `scheduler.test` A08                                                                                                                                   | Pass                                      |
| A09 | Qualified critical arrives during hold         | `scheduler.test` A09; `service.test` A09 data; `qa-autopilot` "interrupts at most once"                                                                | Pass                                      |
| A10 | Sensational single-source story scored 99      | `engine.test` A10; `service.test` rumour held below critical then retracted; assessment shift bound                                                    | Pass                                      |
| A11 | Mouse drag during flight                       | `scheduler.test` A11; `qa-autopilot` drag pauses, no retake, RESUME                                                                                    | Pass                                      |
| A12 | Marker reaches TTL                             | `engine.test` A12 (fade, archive, still queryable)                                                                                                     | Pass                                      |
| A13 | Feed goes offline                              | `service.test` A13 (offline/degraded/stale; others keep ingesting); live: WHO timeout shown as offline, recovered                                      | Pass                                      |
| A14 | KoboldCpp stops during inference               | `localLlm.test` A14 (timeout, rule-based fallback, no cloud call)                                                                                      | Pass                                      |
| A15 | Malformed JSON, fake evidence ids, coordinates | `assessment.test` A15; `localLlm.test` A15                                                                                                             | Pass                                      |
| A16 | Russian speech command                         | `localVoice.test` A16 (adapter); `qa-local-voice` live: "Покажи Париж." → `fly_to_location`, spoken reply, camera at 48.86, 2.35                       | Pass (46 s end to end, see below)         |
| A17 | Narration interrupted by operator              | `localVoice.test` A17; `qa-local-voice` drag stops narration, no orphan playback                                                                       | Pass                                      |
| A18 | Network blocked                                | `service.test` A18 (offline drill, zero requests); `qa-local-voice` A18 (no voice/model request leaves the PC); offline production preview drill 10/10 | Pass                                      |
| A19 | Restart / reconnect / hidden tab               | `scheduler.test` A19 (one decision after a long gap); retention skip test (no re-ingest after restart); console `visibilitychange` handling            | Pass (restart under load not soak-tested) |
| A20 | Upstream touches Director/voice files          | `upstreamCheck.test` A20 (conflict reported with areas; checkout untouched); real upstream (3 commits) merged clean with quick gates                   | Pass                                      |

Browser runs on 29 October 2026: `qa-autopilot` 10/10 against the live dev
instance and 10/10 against an offline production preview
(`vite preview`, `GEV_INTEL_OFFLINE=1`, separate state); `qa-local-voice`
10/10; `smoke-autopilot` 7/7 live (all feeds, model and voice up) and 5 pass
plus 2 expected warnings offline (no model, no voice).

Not yet run: the GitHub workflows themselves (the branch has not been pushed;
they parse and pass `actionlint` 1.7.7), and a multi-hour soak test.

## Reliability and safety review (Phase 6)

| Area                | Finding                                                                                                                                                                                          | Status                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Outbound requests   | Server-side only; every fetch has a size cap and timeout; conditional requests where offered; backoff to 30 min and a circuit breaker.                                                           | OK                                                                                                                       |
| Restart churn       | Old GhostMaps exports were re-ingested and pruned on every restart (~1,600 records).                                                                                                             | Fixed in Phase 5 (runner skips records beyond retention)                                                                 |
| Shared state        | A second instance or QA run shared the operator's `settings.json`.                                                                                                                               | Fixed: `GEV_INTEL_DB` moves store and settings                                                                           |
| Mutations           | Settings, drills, flags and history erase accepted only from loopback, unproxied, same-origin requests (tested).                                                                                 | OK                                                                                                                       |
| Local AI            | Loopback URLs only (`refused_non_loopback`); schema-constrained, validated, shift-bounded; never executes commands.                                                                              | OK                                                                                                                       |
| Local voice         | STT, model and TTS loopback/local only; transcribe and turn routes host-only; one turn at a time with client abort.                                                                              | OK                                                                                                                       |
| Untrusted text      | Feed text is reduced to plain text and length-capped; model prompts fence evidence; injection fixtures stay inert.                                                                               | OK                                                                                                                       |
| Store               | Corrupt database set aside and recreated; retention 90 days (GDELT 14); duplicates pruned.                                                                                                       | OK                                                                                                                       |
| Dependencies        | `npm audit --omit=dev`: 0 vulnerabilities; CI fails on high or critical.                                                                                                                         | OK                                                                                                                       |
| CI privileges       | Sync job has write scopes but runs only git and the fork's own script; upstream code runs only in the read-only, secret-free verify job.                                                         | OK                                                                                                                       |
| Deployment          | Only `Deploy-GEV.ps1`: clean tree, fast-forward, CI green for the exact commit, local gates, smoke test, automatic rollback.                                                                     | OK                                                                                                                       |
| LAN sharing         | The autopilot instance runs the Vite _dev_ server on `0.0.0.0` (approved by the operator for the LAN). A dev server also serves source modules and its HMR endpoint.                             | Advisory: for LAN viewing prefer a production build (`npm run build`, `vite preview`), which the CI smoke tests exercise |
| Ranking calibration | NWS "Severe" weather outranked a GDACS Red cyclone.                                                                                                                                              | Fixed in Phase 5 (cross-feed severity calibration)                                                                       |
| Voice latency       | 46 s end to end in the headless test (software rendering competes with the model for CPU); interactively about 6–8 s from component timings (speech-to-text ~2 s, warm model ~4 s, speech ~1 s). | Known limitation                                                                                                         |
| Merge un-flagging   | Operators can flag a mistaken merge; automatic un-merge is not implemented.                                                                                                                      | Pending                                                                                                                  |
