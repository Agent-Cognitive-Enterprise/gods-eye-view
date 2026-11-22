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
   loopback (for example `http://127.0.0.1:5001/v1`, KoboldCpp's default).
   Set `GEV_LLM_BASE_URL`; anything other than a loopback address is
   refused.
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
- The **AUTOPILOT** tab in the right column opens and closes the panel like
  the other tabs. While Autopilot flies the camera the tab shows a green dot
  (an amber ring while paused), so it shows with the panel closed too.
- **FEEDS** (left column) shows each feed's health with failing feeds first
  and "N/M up" in its header; the local model's state is its last line.
  **CAMERA RULES** in the Autopilot panel opens and closes from its heading.
- When nothing qualifies as an alert, **TOUR** visits other active events
  (`tourWhenIdle`).
- Camera moves turn the globe first, then descend; after each shot the
  camera zooms out in steps to the whole globe (**ZOOM OUT**,
  `pullBackEnabled`). Each browser remembers ON / OFF / PAUSED across reloads.
- **PLACES**: pick HOME, FAMILY, TRAVEL or CUSTOM, centre the map on the
  place, then press **AT MAP CENTRE**; the row confirms what was saved.
  Events near a place rank higher (**NEAR** radius, **DECAY** length);
  confidence is not changed. Places are stored rounded to about 1 km and are
  visible to LAN viewers of the status API.
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
| `GEV_INTEL_CABLES`                                                                            | off                              | `1` polls submarine cable notices hourly, in shadow mode (logged in `.gev-cache/intel/cables-shadow.jsonl`).                  |
| `GEV_INTEL_CABLES_LIVE`                                                                       | off                              | With `GEV_INTEL_CABLES=1`, `1` sends confirmed cable incidents to Autopilot (see below).                                      |
| `GEV_INTEL_CABLES_IODA`                                                                       | off                              | With `GEV_INTEL_CABLES_LIVE=1`, `1` adds IODA country outages to a cable event's card (impact only; see below).               |
| `GEV_INTEL_CABLES_LLM`                                                                        | on                               | `0` judges cable notices by the rules alone, without the local model.                                                         |
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

| Symptom                                                                                                                                                     | Likely cause                                                                                                                                                                                                                                                                    | What to do                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| No AUTOPILOT panel                                                                                                                                          | Engine off, or an old tab.                                                                                                                                                                                                                                                      | `GEV_INTEL_ENABLED=1` in the instance environment; restart; reload the page.                                                                                                                                                                                                                                                                                                                                 |
| A feed shows **offline** / **degraded**                                                                                                                     | The source is down, slow or changed format; the runner backs off up to 30 min.                                                                                                                                                                                                  | Read `last_error` (`/api/intel/feeds`). Other feeds keep working. `GEV_INTEL_<FEED>=0` silences a broken one.                                                                                                                                                                                                                                                                                                |
| A feed shows **stale**                                                                                                                                      | Nothing new within its window (normal for tsunami centres and quiet NWS days).                                                                                                                                                                                                  | No action unless the source itself is publishing.                                                                                                                                                                                                                                                                                                                                                            |
| **needs a key** (ReliefWeb, ACLED)                                                                                                                          | No credentials by design.                                                                                                                                                                                                                                                       | ReliefWeb: request an app name, set `GEV_RELIEFWEB_APPNAME`. ACLED: not ingested (terms).                                                                                                                                                                                                                                                                                                                    |
| Camera does not move                                                                                                                                        | Autopilot off or paused (map drag), nothing above `minimumAttentionScore` (TOUR then shows other events), or a Cockpit/Director session owns the camera.                                                                                                                        | RESUME; check the queue; lower the threshold only deliberately.                                                                                                                                                                                                                                                                                                                                              |
| Camera keeps returning to US weather                                                                                                                        | Many NWS alerts in a quiet world.                                                                                                                                                                                                                                               | Set `categoryRelevance` or `GEV_INTEL_NWS=0`.                                                                                                                                                                                                                                                                                                                                                                |
| AI badge missing, "model offline"                                                                                                                           | KoboldCpp not running, not on the configured loopback URL, or busy with another client.                                                                                                                                                                                         | Start KoboldCpp; `Invoke-RestMethod http://127.0.0.1:8790/v1/models`. Scores fall back to rules meanwhile.                                                                                                                                                                                                                                                                                                   |
| Voice: "speech-to-text is not running"                                                                                                                      | whisper-server sidecar stopped.                                                                                                                                                                                                                                                 | Restart the instance (starts the sidecar) or check `logs\stt-*.log`.                                                                                                                                                                                                                                                                                                                                         |
| Voice: microphone unavailable                                                                                                                               | Not on `localhost`, permission denied, or another app holds the device.                                                                                                                                                                                                         | Use `http://localhost:4174` on this PC; reset site permissions; close other recorders.                                                                                                                                                                                                                                                                                                                       |
| Fans loud, GPU busy while the app is open                                                                                                                   | The local model assesses events in the background; GPU memory shared with the browser's 3D map.                                                                                                                                                                                 | **LOCAL AI OFF** in the panel stops it at once (scores become rule-based); close other GPU-heavy tabs.                                                                                                                                                                                                                                                                                                       |
| Slow voice replies (10–20 s first time)                                                                                                                     | Cold model; GPU memory nearly full with the browser and the model together.                                                                                                                                                                                                     | First reply warms the model; close GPU-heavy tabs.                                                                                                                                                                                                                                                                                                                                                           |
| "evidence store unreadable … moved to …corrupt-…"                                                                                                           | A damaged SQLite file.                                                                                                                                                                                                                                                          | Already handled: it was set aside and a fresh store opened. Delete the `.corrupt-*` files when not needed.                                                                                                                                                                                                                                                                                                   |
| Store grows                                                                                                                                                 | Retention is 90 days (GDELT 14 days); pruned automatically.                                                                                                                                                                                                                     | `DELETE /api/intel/history` (from this PC) erases all stored evidence.                                                                                                                                                                                                                                                                                                                                       |
| Deploy refused                                                                                                                                              | Dirty tree, detached HEAD, non-fast-forward, or CI not green for that commit.                                                                                                                                                                                                   | Commit/stash; integrate first; wait for CI or deliberately use `-SkipCiCheck` for a local commit.                                                                                                                                                                                                                                                                                                            |
| Port already in use                                                                                                                                         | Another instance or program on 4174.                                                                                                                                                                                                                                            | `Stop-GEV.ps1 -Instance autopilot`; `Get-NetTCPConnection -LocalPort 4174`.                                                                                                                                                                                                                                                                                                                                  |
| Claude Code (`claude -p`, e.g. a scheduled review) fails at once with "API Error: 403 Access to "api.anthropic.com" was blocked by" an antivirus web filter | The antivirus's web filter classed Anthropic's API host as malicious. It is Anthropic's official API endpoint, so a false positive is likely, but only the antivirus vendor can confirm it. This dependency is Anthropic's cloud API, not the Autopilot's optional local model. | First report it to the vendor as a false positive (URL/website) and keep its answer. To keep a scheduled job running meanwhile, add an exception in the antivirus for that address only, `https://api.anthropic.com/*` (everything else is still scanned). Remove it if the vendor upholds the detection. Check with protection on: `"Reply OK" \| claude -p`. Never turn the protection off to get past it. |

## Submarine cable incidents

With `GEV_INTEL_CABLES=1` the "Submarine cable notices" feed polls the
checked operator, regulator and news sources every hour
([tools/cable-incidents/README.md](../tools/cable-incidents/README.md)).
Nobody approves each notice: fixed rules, and the local model where the
rules are in doubt, decide. With `GEV_INTEL_CABLES_LIVE=1`:

- **What becomes an event:** only a fault or repair that an operator or
  regulator confirms about a cable it runs or oversees, in a title or
  summary of a fixed, plain shape. The globe highlights that cable's route,
  and the card says when it was first and last reported.
- **What never does:** news reports. They stay in the shadow log as
  `llm-unverified`, however many repeat them.
- **"Cut":** shown only when the source itself says the cable is cut,
  severed or broken. A fault alone is shown as a fault.
- **When it ends:** a repair notice from a primary source closes the event.
  An event with no new report fades after 30 days. One landing party of a
  consortium cable (Transworld for SEA-ME-WE 5) can open an event but cannot
  close it.
- **Impact (`GEV_INTEL_CABLES_IODA=1`):** IODA (Georgia Tech) internet
  outages in a country the cable lands in, during the incident, are added
  to the card. They show impact in that country and never say the cable
  caused it, and they never open or close an event. Off by default: ask
  IODA about its data-use terms before switching it on.
- **What to check:** every change is logged in
  `.gev-cache/intel/cables-shadow.jsonl` (`sent-to-autopilot` lines, and the
  reason for every notice that was not sent). Remove
  `GEV_INTEL_CABLES_LIVE` to go back to shadow mode; events already shown
  then fade as usual.

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
