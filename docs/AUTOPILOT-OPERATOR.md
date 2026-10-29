# Autopilot operator guide (Windows)

Setting up, running, checking and troubleshooting the early-warning
Autopilot on a Windows PC. How it works: [EARLY-WARNING.md](EARLY-WARNING.md).
Feeds and gaps: [AUTOPILOT-FEEDS.md](AUTOPILOT-FEEDS.md). Updating:
[FORK-MAINTENANCE.md](FORK-MAINTENANCE.md).

Everything runs on this PC. No paid service, no cloud AI, no account is
needed; the local model and voice services are optional, and without them
scoring stays rule-based and voice is unavailable.

## Layout on disk

| Path                                  | What                                                                                    |
| ------------------------------------- | --------------------------------------------------------------------------------------- |
| `%USERPROFILE%\gev-autopilot`         | This fork's checkout (branch `feature/global-early-warning-autopilot`).                 |
| `%USERPROFILE%\gods-eye-view`         | Optional untouched upstream install (instance `main`, port 4173).                       |
| `%USERPROFILE%\gods-eye-view-runtime` | Launch scripts, a portable Node 24 (the system Node is not used), logs, voice sidecars. |
| `<checkout>\.gev-cache\intel\`        | Evidence store (`intel.sqlite`) and Autopilot settings (`settings.json`). Git-ignored.  |

The runtime folder is per machine and not in the repository. Its scripts:

| Script                                                          | Does                                                                                |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `Start-GEV.ps1 -Instance autopilot` (`Start-GEV-Autopilot.cmd`) | Starts the speech-to-text sidecar and the app on port 4174, waits until it answers. |
| `Stop-GEV.ps1 -Instance autopilot` (`Stop-GEV-Autopilot.cmd`)   | Stops the app and the sidecar.                                                      |
| `Test-GEV.ps1 [-RequireAi] [-RequireVoice]`                     | Smoke test of the running instance (page, API, short demo drill, model, voice).     |
| `Deploy-GEV.ps1 -Ref <ref>`                                     | Explicit, gated update with automatic rollback (see the maintenance guide).         |
| `Install-GEV-Voice.ps1`                                         | Downloads whisper.cpp, Piper and voices (pinned URLs, SHA-256 checked).             |
| `Set-GEV-Firewall.ps1 -Port 4174 [-Remove]`                     | Lets the Private-network local subnet reach the port (administrator).               |

The autopilot instance's environment is set in `gev-common.ps1`
(`GEV_INTEL_ENABLED=1`, the model and voice addresses below).

## First-time setup

1. Clone the fork and install with the portable Node:
   `git clone -b feature/global-early-warning-autopilot https://github.com/Agent-Cognitive-Enterprise/gods-eye-view.git gev-autopilot`,
   then `npm ci` from the runtime folder's Node.
2. Optional local model: KoboldCpp serving an OpenAI-compatible API on
   loopback (here `http://127.0.0.1:8790/v1`, Qwen3.6-35B-A3B). Set
   `GEV_LLM_BASE_URL`; anything other than a loopback address is refused.
   The app never changes KoboldCpp's configuration.
3. Optional local voice: run `Install-GEV-Voice.ps1`; the instance then uses
   `GEV_LOCAL_VOICE=1`, `GEV_STT_URL=http://127.0.0.1:8791` and the Piper
   paths.
4. `Start-GEV-Autopilot.cmd`, then `Test-GEV.ps1`.

## Daily use

- Open `http://localhost:4174/`. AUTOPILOT is at the top of the right rail:
  **AUTOPILOT ON/OFF**, **PAUSE/RESUME** (any map drag also pauses),
  **SKIP**, **DEMO DRILL** (a synthetic replay world; live data is untouched),
  **NARRATION** (spoken briefings via Piper), the feed list with health, and
  the queue. Cards show sources, verification, confidence and age.
- When nothing qualifies as an alert, **TOUR** visits other active events
  (`tourWhenIdle`).
- Camera moves turn the globe first, then descend; after each shot the
  camera zooms out in steps to the whole globe (**ZOOM OUT**,
  `pullBackEnabled`). Each browser remembers ON / OFF / PAUSED across reloads.
- The bottom controls (locations, voice, visual presets, POWER UP, language)
  hide after 4 s idle; any key or moving the pointer to the bottom edge
  brings them back. They stay visible while hovered or while a tray is open,
  and are never hidden on touch-only devices.
- Voice: pick the **Local** provider and hold Space to talk (English or
  Russian). Microphones work only on this PC: browsers allow them on
  `localhost` or HTTPS, not on `http://<LAN address>`. Firefox works on
  `localhost`; Chrome may need the site's microphone permission reset.
- Other devices on the local network can watch at `http://<PC name>:4174/`
  (they can read, not change settings or start drills).

## Configuration

| Variable                                                                                      | Default                          | Meaning                                                                                                                       |
| --------------------------------------------------------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `GEV_INTEL_ENABLED`                                                                           | off                              | Turns the engine and `/api/intel` on.                                                                                         |
| `GEV_INTEL_OFFLINE`                                                                           | off                              | `1`: contact no feed (drills and the stored archive only).                                                                    |
| `GEV_INTEL_<FEED>`                                                                            | on                               | `0` switches one feed off: `USGS`, `GDACS`, `TSUNAMI`, `NWS`, `EONET`, `WHO`, `WORLDBANK`, `RELIEFWEB`, `ACLED`, `GHOSTMAPS`. |
| `GEV_INTEL_GDELT`                                                                             | off                              | `1` adds machine-coded news (unverified).                                                                                     |
| `GEV_RELIEFWEB_APPNAME`                                                                       | unset                            | Approved ReliefWeb app name; without it the feed waits.                                                                       |
| `GEV_INTEL_DB`                                                                                | `.gev-cache/intel/intel.sqlite`  | Moves the store _and_ settings (separate state for a second instance or tests).                                               |
| `GEV_LLM_BASE_URL` / `GEV_LLM_DISABLED`                                                       | `http://127.0.0.1:5001/v1` / off | Local model (loopback only) / `1` for rule-based scoring.                                                                     |
| `GEV_LOCAL_VOICE`, `GEV_STT_URL`, `GEV_PIPER_EXE`, `GEV_PIPER_VOICE_EN`, `GEV_PIPER_VOICE_RU` | off                              | Local voice (all loopback / local files).                                                                                     |

Autopilot behaviour settings (thresholds, dwell, tour, local AI on/off) are
listed in [EARLY-WARNING.md](EARLY-WARNING.md#settings-defaults-product-choices-not-measurements-of-danger)
and changed from the panel; `DELETE /api/intel/settings` (from this PC)
restores the defaults.

## Health checks

```powershell
.\Test-GEV.ps1                                   # PASS/WARN/FAIL per check
Invoke-RestMethod http://localhost:4174/api/intel/feeds | % feeds | ft id,status,last_error
Invoke-RestMethod http://localhost:4174/api/intel/ai          # local model state
Invoke-RestMethod http://localhost:4174/api/voice-local/status
Get-ChildItem $env:USERPROFILE\gods-eye-view-runtime\logs | sort LastWriteTime | select -Last 3
```

## Troubleshooting

| Symptom                                           | Likely cause                                                                                                                                             | What to do                                                                                                    |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| No AUTOPILOT panel                                | Engine off, or an old tab.                                                                                                                               | `GEV_INTEL_ENABLED=1` in the instance environment; restart; reload the page.                                  |
| A feed shows **offline** / **degraded**           | The source is down, slow or changed format; the runner backs off up to 30 min.                                                                           | Read `last_error` (`/api/intel/feeds`). Other feeds keep working. `GEV_INTEL_<FEED>=0` silences a broken one. |
| A feed shows **stale**                            | Nothing new within its window (normal for tsunami centres and quiet NWS days).                                                                           | No action unless the source itself is publishing.                                                             |
| **needs a key** (ReliefWeb, ACLED)                | No credentials by design.                                                                                                                                | ReliefWeb: request an app name, set `GEV_RELIEFWEB_APPNAME`. ACLED: not ingested (terms).                     |
| Camera does not move                              | Autopilot off or paused (map drag), nothing above `minimumAttentionScore` (TOUR then shows other events), or a Cockpit/Director session owns the camera. | RESUME; check the queue; lower the threshold only deliberately.                                               |
| Camera keeps returning to US weather              | Many NWS alerts in a quiet world.                                                                                                                        | Set `categoryRelevance` or `GEV_INTEL_NWS=0`.                                                                 |
| AI badge missing, "model offline"                 | KoboldCpp not running, not on the configured loopback URL, or busy with another client.                                                                  | Start KoboldCpp; `Invoke-RestMethod http://127.0.0.1:8790/v1/models`. Scores fall back to rules meanwhile.    |
| Voice: "speech-to-text is not running"            | whisper-server sidecar stopped.                                                                                                                          | Restart the instance (starts the sidecar) or check `logs\stt-*.log`.                                          |
| Voice: microphone unavailable                     | Not on `localhost`, permission denied, or another app holds the device.                                                                                  | Use `http://localhost:4174` on this PC; reset site permissions; close other recorders.                        |
| Fans loud, GPU busy while the app is open         | The local model assesses events in the background; GPU memory shared with the browser's 3D map.                                                          | **LOCAL AI OFF** in the panel stops it at once (scores become rule-based); close other GPU-heavy tabs.        |
| Slow voice replies (10–20 s first time)           | Cold model; GPU memory nearly full with the browser and the model together.                                                                              | First reply warms the model; close GPU-heavy tabs.                                                            |
| "evidence store unreadable … moved to …corrupt-…" | A damaged SQLite file.                                                                                                                                   | Already handled: it was set aside and a fresh store opened. Delete the `.corrupt-*` files when not needed.    |
| Store grows                                       | Retention is 90 days (GDELT 14 days); pruned automatically.                                                                                              | `DELETE /api/intel/history` (from this PC) erases all stored evidence.                                        |
| Deploy refused                                    | Dirty tree, detached HEAD, non-fast-forward, or CI not green for that commit.                                                                            | Commit/stash; integrate first; wait for CI or deliberately use `-SkipCiCheck` for a local commit.             |
| Port already in use                               | Another instance or program on 4174.                                                                                                                     | `Stop-GEV.ps1 -Instance autopilot`; `Get-NetTCPConnection -LocalPort 4174`.                                   |

## Safety notes

- Scores and markers are decision support, not declarations of fact. Cards
  show verification (unverified, corroborated, officially reported,
  disputed, retracted, resolved) and confidence; a single unverified source
  cannot trigger a critical interruption.
- Country-level markers (WHO, World Bank, ReliefWeb) sit at the centre of the
  country and are labelled approximate.
- The model's output is validated and bounded; it never runs commands, and
  it cannot invent evidence, coordinates or links.
- Mutating API calls (settings, drills, history erase) are accepted only from
  this PC.
