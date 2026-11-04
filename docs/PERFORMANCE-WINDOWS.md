# Windows performance audit (fork)

Measured on 4 November 2026 on the fork's Windows host, against isolated staging
copies of the app. Every finding below is marked **confirmed** (measured and
reproduced), **not reproduced** or **not measured**. Nothing here is a hardware
requirement.

## Environment

| Setting   | Value                                                                    |
| --------- | ------------------------------------------------------------------------ |
| Machine   | Intel i7-8700, 64 GB, Windows 11 Pro 23H2                                |
| GPU       | NVIDIA GeForce GTX 1070, ANGLE Direct3D 11 (`webgl2`)                    |
| Browser   | Chrome 156.0.8078.80, visible window, fresh profile per run              |
| Viewport  | 1600 × 900 at device pixel ratio 1, on the 1680 × 1050 console display   |
| App       | `vite` dev server per side, `GEV_ISOLATED_INSTANCE=1`, no `.env`, no LLM |
| Old / new | c320ccbe on port 4180 / `feature/world-overview` on port 4179            |

The operator normally watches over Remote Desktop; that display path was not
measured.

## Method

- `scripts/perf-staging.mjs --state <dir> --port <port>` starts an isolated instance:
  its own event database and air/sea folder, no AIS collection, no LLM. It refuses to
  start if `.env` exists, and stops if it sees a connection to AISStream.
- `scripts/perf-autopilot.mjs --url <instance> --label <name> --chrome <chrome.exe>`
  runs scenes in a real, headful Chrome and writes `<label>.json`:
  - **idle**: Autopilot off, camera parked, 45 s.
  - **hold**: Autopilot on, holding a shot.
  - **flight**: Autopilot moving between shots (short dwell).
  - **fast**: FAST INTELLIGENCE open while Autopilot runs.
  - optional **airsea**, **hidden** and **foreground** (`--scenes`).
- Per scene it records frame times from `requestAnimationFrame`, Cesium renders,
  process CPU from Chrome's SystemInfo, script time, heap, DOM nodes, requests,
  Autopilot marker additions and rebuilds, AUTOPILOT panel mutations and the
  overview's own update time. `--profile` adds CPU profiles and a hot list.
- A/B runs alternate old and new code (old, new, old, new) so machine and network
  load fall on both alike.
- From an elevated shell, Chrome relaunches itself un-elevated and its first process
  exits, which Puppeteer reads as a failed launch. With `--chrome`, the harness starts
  Chrome through `Start-Process` and connects to its debugging port. A watchdog saves
  what was measured and exits if a page stops answering.

## Findings

### 1. The page froze after hours with submarine cables on (confirmed, fixed)

The page caught frozen on 4173 had earthquakes, S2 ghost maps and submarine cables
on, with Autopilot running. Its main thread was inside Cesium's
`TexturePacker._findNode`, recursing up to 280 deep, called from
`TextureAtlas._resize` after a `BillboardCollection` update.

Cesium keys a billboard's atlas entry by image id. A canvas has no URL, so it gets a
new GUID on every assignment, even when it is the same canvas. `GeoJsonDataSource`
draws point pins as canvases, and an entity billboard is assigned its image again
each time the cluster reuses it after hiding it. As the camera moves, entries pile up
and are never freed, and every growth repacks all of them.

| Where                                              | Cables atlas entries                                        |
| -------------------------------------------------- | ----------------------------------------------------------- |
| 4173, the frozen page, after about 2 hours         | 2,765 for 1,917 billboards, all GUIDs                       |
| Staging, old code, 10 min of Autopilot (8 s dwell) | 2,386 → 14,373, rising ~1,200 a minute, texture 1024 × 1024 |
| Staging, new code, same 10 min                     | 1, texture 16 × 16                                          |

Fix: `src/data/stableBillboardImages.js` replaces each constant canvas image with its
data URL, built once per canvas. A data URL is its own id, so every billboard and
every reuse resolve to one atlas entry. It is applied to the submarine cable sources
and to `localGeojsonCore.js`, which loads infrastructure points the same way (that
second use was not measured separately). `geoFileImport.js` already did the same.

Not yet done: an overnight run of the fixed build.

### 2. Autopilot rebuilt every marker on every render (confirmed, fixed)

Each console render removed and re-added all event markers: 2,800 additions a minute
idle and 7,200 while flying, in 14 to 36 rebuilds. Markers are now added, changed and
removed one by one, and labels are replaced only when their text or look changes.
After: 0 rebuilds, 0 to 5 additions a minute.

This work did not show in frame rate on this machine (below).

### 3. Depth readback after each camera stop (confirmed, not changed)

`readPixels` is the largest self-time function while Autopilot moves: 6.8 % of samples
in **flight**, 3.9 % in **hold**. It comes from `scene.pickPosition` on `camera.moveEnd`,
twice per stop: upstream's `installViewTargetPrewarm` in `src/voice/gevActions.js`
and `refreshTilt` in the camera orientation controls. Both are upstream code; the
change belongs there, for example one shared, deferred pick per stop.

### 4. `CesiumWidget.resize` on every frame (confirmed, not changed)

1.1 % to 2.6 % of samples in every scene, from Cesium's per-frame size check. It is
cheap per call; not worth a fork change.

### 5. AUTOPILOT panel mutations (measured, not changed)

112 mutation batches a minute at rest and 288 while flying, the same before and after.

### 6. Hidden tab (confirmed, no work)

In the background the app renders nothing and uses about 0.3 % of one core.

### 7. Earlier frame drops (not reproduced)

An earlier round measured the old code at 47.9 fps holding a shot, 38 fps flying and
31 fps with FAST INTELLIGENCE open. Those runs were taken
while the watched 4173 page was heading into its freeze, repacking its atlas on the
same CPU and GPU; the freeze was caught about 20 minutes after the baseline. That is
the likely cause, not a proven one. In the later A/B rounds, when that page was no
longer busy, both old and new code held 59.7 to 59.9 fps in every scene.

## A/B results

Two rounds each, 45 s per scene, values for round 1 / round 2.

| Scene  | Side | fps         | p95 frame (ms) | Renderer CPU % | GPU proc. % | Script (ms/s) | Marker additions/min | Overview p95 (ms) |
| ------ | ---- | ----------- | -------------- | -------------- | ----------- | ------------- | -------------------- | ----------------- |
| idle   | old  | 59.8 / 59.9 | 16.8 / 17.0    | 8.8 / 7.4      | 2.6 / 2.8   | 16.4 / 14.1   | 2,800 / 2,800        | n/a               |
| idle   | new  | 59.9 / 59.8 | 16.9 / 17.0    | 7.4 / 7.1      | 2.4 / 2.4   | 14.1 / 13.9   | 0 / 0                | 0.2 / 0.2         |
| hold   | old  | 59.8 / 59.9 | 16.8 / 16.9    | 27.8 / 22.6    | 28.7 / 22.9 | 78.9 / 61.7   | 2,800 / 2,800        | n/a               |
| hold   | new  | 59.8 / 59.8 | 16.9 / 16.9    | 24.2 / 23.8    | 24.1 / 23.9 | 64.4 / 64.3   | 0 / 0                | 1.4 / 2.1         |
| flight | old  | 59.9 / 59.9 | 16.9 / 16.9    | 15.8 / 16.2    | 18.4 / 18.3 | 51.1 / 50.5   | 7,200 / 7,200        | n/a               |
| flight | new  | 59.8 / 59.7 | 16.8 / 16.9    | 18.2 / 16.3    | 21.0 / 19.1 | 57.8 / 50.2   | 0 / 0                | 1.5 / 1.5         |
| fast   | old  | 59.9 / 59.9 | 16.9 / 16.9    | 19.6 / 17.6    | 22.0 / 20.2 | 61.0 / 53.4   | 2,800 / 2,800        | n/a               |
| fast   | new  | 59.8 / 59.7 | 16.8 / 16.9    | 20.9 / 18.1    | 24.2 / 20.7 | 64.2 / 54.0   | 5 / 5                | 1.6 / 2.6         |

Reading: frame rate, frame time and CPU are the same within the spread between
rounds. The new code removes the marker churn and adds the world overview, which
updated one or two times per scene at no more than 2.6 ms. The freeze fix does not
show here because these scenes run without the cables layer; its evidence is the
atlas count above.

## Reproduce

```powershell
# two isolated instances (no .env in either checkout)
node scripts/perf-staging.mjs --state <dir-a> --port 4180   # in the old checkout
node scripts/perf-staging.mjs --state <dir-b> --port 4179   # in this branch
# measure (repeat, alternating sides)
node scripts/perf-autopilot.mjs --url http://127.0.0.1:4180 --label old-1 --seconds 45 `
  --scenes idle,hold,flight,fast --width 1600 --height 900 `
  --chrome "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" --out <results>
```
