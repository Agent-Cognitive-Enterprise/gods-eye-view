# Air & Sea monitoring: repository audit (Phase A)

Audit of the fork (`feature/global-early-warning-autopilot` at `f23d8ccf`,
30 October 2026) before adding aggregate air/sea traffic, warning areas and
traffic anomalies. Work happens on `feature/air-sea-monitor` in a separate
worktree; the running Windows instance (port 4174) is not touched until a
tested deployment.

## Existing traffic pipelines

| Pipeline                   | Server (path, cadence)                                                                                                                                                                                                                                                         | Client                                                        | Payload                                                                                                                                                  | Health                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| OpenSky global states      | `server/providers/aircraft/opensky.js`, `GET /api/flights`. Fetches only when a browser asks; cache 9 s, adaptive TTL up to 300 s from `X-Rate-Limit-Remaining`, 429 cooldown 30 s–30 min, serves stale.                                                                       | `src/layers/flights/` (layer `flights`), polls ~30 s while on | `{time, states: [[icao24, callsign, country, time_position, last_contact, lon, lat, baro_alt, on_ground, velocity, track, vrate, sensors, geo_alt, …]]}` | Response headers (`X-OpenSky-*`, cache status, stale seconds) |
| adsb.lol regional fallback | Same route: 250 nm `point` query around the view anchor when OpenSky fails or its snapshot is old; cache 12 s per 0.25° anchor                                                                                                                                                 | as above                                                      | normalised to OpenSky vectors (`normalizeAdsbLolPointResponse`)                                                                                          | `reason` header                                               |
| adsb.lol military          | `server/providers/aircraft/adsb-lol.js`, `GET /api/military`, cache 12 s, Retry-After cooldown 5–120 s                                                                                                                                                                         | layer `military`                                              | readsb rows `{now, ac: [{hex, lat, lon, alt_baro, gs, seen_pos, …}]}`                                                                                    | `X-Feed-Cache`                                                |
| AISStream                  | `server/providers/vessels/ais-live.js`: one backend WebSocket (`wss://stream.aisstream.io/v0/stream`), opened on the first `/api/vessels` request; watchdog, backoff ladder, auth probe. Store `ais-store.js`: latest row per MMSI, 30 min staleness, 50 000 cap, short tracks | layer `ais-live-vessels`                                      | rows `{mmsi, lat, lon, name, type, speed, heading, course, last_position_UTC, last_position_epoch}`                                                      | status snapshot in the route                                  |
| Local receivers            | `localReceiversProxy` (dump1090/readsb on the LAN)                                                                                                                                                                                                                             | layer `local-adsb` (local-only)                               | per receiver                                                                                                                                             | n/a                                                           |

Keys: none configured on this machine. OpenSky runs **anonymously** (about
400 credits a day, 4 per global snapshot, so ~100 snapshots a day per IP).
**AISStream needs `AISSTREAM_API_KEY`** (free registration), so vessel
density reports `not configured` here. Secrets live in `.env` (git-ignored)
and server memory only; no route returns them.

Licences: OpenSky terms of use (non-commercial research use, attribution);
adsb.lol data ODbL; AISStream terms (free tier, one connection per key).
`DATA_SOURCES.md` already lists all three; Phase A adds no data provider.
New library: `h3-js` 4.5.0 (Apache-2.0, no dependencies).

## Layer system (where the new layers plug in)

- Layer modules expose `init/enable/disable/update/destroy`,
  `getRowControls` (chips, info, legend) and `getStats`; the manager
  (`src/data/lifecycle.js`) initialises lazily on first enable.
- Every catalog layer needs a serialization disposition. Shareable layers
  take the next free share-link token (`6`, `7`, … in strict order, checked
  against upstream's ledger), which would collide with upstream's next
  layers. The fork's layers are therefore **local-only** (like
  `local-adsb`): not in share links, on/off/mode/window remembered per
  browser in `localStorage`.
- Registration touchpoints: `src/app/constructCatalog.js` (catalog +
  metadata), `src/sources/reference.js` and `src/app/sourceComposition.js`
  (source contract), `src/ui/layerNames.js`, `src/ui/layerPanel.js` (own
  **Air & Sea** group), `src/voice/layerManifest.js` (voice-off for now),
  `scripts/package-boundaries.json`, and three pinned counts in tests.
- Road traffic (`src/app/layers/traffic.js`, TomTom) is unrelated.

## Data contract added (Phase A)

- One normalised fix per object: `{domain, id (ICAO hex | MMSI), lat, lon,
observedAt, provider, …}`; fixes with no identity/position, out of range,
  at 0,0, more than 2 min in the future or older than 24 h are refused and
  counted. The fresher fix wins across providers, so an aircraft in both
  OpenSky and adsb.lol counts once.
- `GET /api/airsea/density?domain=air|sea&res=1-4&window=…&box=w,s,e,n`:
  sparse H3 cells with `uniqueCount`, moving/stationary, density per
  10 000 km², newest/oldest sample age, providers, altitude bands, and the
  health of each feed (`healthy | degraded | stale | down | unconfigured`)
  plus a coverage level (`global | partial | none`) with its reason.
- `GET /api/airsea/sources`: catalogue with coverage, limitations, licence.
- Snapshots reach the service through `server/providers/airsea/bus.js`:
  one line in each proxy after it caches a fresh body. No new upstream
  request path.
- Background collection keeps the proxies warm while layers are hidden:
  `/api/flights` every 15 min anonymous (2 min with OpenSky OAuth),
  `/api/military` every 5 min, `/api/vessels` every 5 min with an AIS key.
  Requests go to the app's own routes, so caches and the credit governor
  apply. `GEV_AIRSEA_COLLECT=0` switches it off.

## Gaps and risks

- Without OpenSky credentials the aircraft picture is at most ~15 min fresh
  and a second running instance on the same IP shares the anonymous budget.
- AIS coverage is coastal; open ocean is mostly empty, which the layer
  states as "no reports, not no traffic".
- History is in memory in Phase A (a restart clears the windows); the
  SQLite baseline store is Phase C.
- Worldwide NOTAMs have no free machine-readable source (FAA access needs
  approval; EAD and NAIPS forbid automated retrieval without permission).
  Phase B starts with the Canadian S-124 trial feed (labelled TRIAL), NWS
  marine weather, and a permission-gated FAA adapter.
- Upstream conflicts: the catalog/panel/source registration lines, the
  pinned layer counts, and `package.json` (h3-js) are the merge surface.

## Phase B (warning areas)

Connected: NWS active marine alerts with official forecast-zone outlines
(machine-readable, public domain) and the Canadian Coast Guard S-124 trial
exchange set (test data, labelled TRIAL, never used for alerts). Catalogued
but not fetched: FAA NOTAM API, EUROCONTROL EAD, Airservices NAIPS, AMSA
NAVAREA X, other NAVAREA coordinators. Details per source, geometry rules
and lifecycle: [air-sea-data-providers.md](air-sea-data-providers.md).

## Phase C (traffic history and anomalies)

- **Footprint.** `src/airsea/trajectory.js` turns consecutive fixes of one
  object into the cells it crossed: one passage per entry into a cell (no
  recount while it stays), and the minutes it spent there. A move is
  followed along the great circle only within 20 min / 1,300 km/h (air) or
  3 h / 90 km/h (sea); anything else is an uncertain gap that paints
  nothing in between. Grids: air H3 2 and 3, sea H3 2, 3 and 4.
- **History.** `server/providers/airsea/history.js` keeps 5-minute rows for
  three days and hourly rows for 120 days in
  `GEV_AIRSEA_DIR/traffic.sqlite` (default `.gev-cache/airsea`), with the
  snapshots and objects each feed delivered per hour. Windows up to 6 h
  read the 5-minute rows, longer ones the hourly rows. Routes:
  `/api/airsea/footprint?domain=&res=&window=` and
  `/api/airsea/anomalies?domain=`.
- **Anomalies.** `src/airsea/anomaly.js` compares the last complete hour
  of passages per cell (air H3 2, sea H3 3) with the same hour of the week
  one to four weeks back. A cell needs a usual value of at least 5
  passages, a change of at least 50 % and a robust z-score of at least 3.
  Weeks whose feed delivered under 75 % of the expected snapshots, or
  under 70 % of the usual objects per snapshot, do not count; when the
  current hour fails the same test the answer is `coverage_degraded`.
  With fewer than two usable weeks the answer is `baseline_insufficient`
  and the row says from which day comparisons become possible.
- **Shared hexagons.** `src/airsea/cellShare.js` is the meeting point of
  the three map layers: each traffic layer publishes the cells it draws,
  the warning layer publishes its shown area outlines, and a cell reached
  by two or three of them is drawn as halves or thirds in the order air,
  sea, warning. It works when both traffic layers draw the same grid: in
  the TRAFFIC view sea follows the air grid (H3 3 close in, H3 2 on the
  globe); a TRAFFIC row beside a NOW row can still differ at some heights,
  and then the cells simply overlap as before.
- **Later option.** adsb.lol publishes daily historical archives (ODbL)
  that could seed the baseline instead of waiting two weeks; they are
  large and not fetched.
