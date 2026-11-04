# Autopilot world overview (fork)

A 2D Mercator map at the foot of the AUTOPILOT panel: where the camera is, the shot on
screen, where Autopilot has been and where it is likely to go next.

## What it shows

| Mark                             | Meaning                                                                                                                                               |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Red dot, blinking                | The shot on screen, at its cluster's centre, as the scheduler holds it.                                                                               |
| Faded red dots, solid line       | Shots that actually arrived, newest first, up to five. A flight that was refused or cancelled never lands, so it is never listed.                     |
| Faded red dots, dashed line      | **Likely next**: the scheduler's own ranking of what it would turn to, up to eight. Only the first is joined to the route, and never as a commitment. |
| Cyan crosshair with arrow        | The camera itself and its heading. A zoom-out after a shot moves this, not the target.                                                                |
| Dashed ring around the red dot   | Regional: the report has a country or region, not a place.                                                                                            |
| `AUTO`, `PAUSED`, `OFF`, `DEMO`  | Autopilot's mode, and a drill rather than live events.                                                                                                |
| `NO TARGETS`, `POSITION UNKNOWN` | Nothing to show, or the camera's place could not be read.                                                                                             |

The map covers the whole width of the world from about 75°N to 60°S, which gives the
2:1 shape. A point beyond that band is held at the edge and its description says so.
Reports with no map position are counted under the map, never placed.

Hover or keyboard focus on a dot reads its title and status. Clicking one shows that
event through the same action as clicking its row in the queue, so it pauses Autopilot.
The map never moves the camera by itself.

## How it works

- `src/intel/mercator.js`: Web Mercator, latitude clamp and dateline splitting. Pure.
- `src/intel/overviewModel.js`: the model and its equality test. Pure.
- `src/intel/scheduler.js` `likelyNext()`: the next candidates, using the same eligibility,
  cooldown, fairness and tour ordering helpers as `stepScheduler`. Read only.
- `src/ui/worldOverview.js`: the owner. The console hands it its state after each render
  and an arrival when a flight settles. It follows the camera from Cesium's `postRender`,
  at most about seven times a second, so it adds no poll, render request or
  continuous-render hold.
- `src/ui/stores/worldOverview.js`, `src/ui/views/panels/WorldOverview.vue` and
  `WorldOverviewCamera.vue`: the view. The camera marker is its own component, so camera
  movement re-renders only it.
- `src/intel/overviewWorld.json`: the base map, built by
  `node scripts/build-overview-world.mjs` from the bundled Natural Earth countries
  (public domain): 34 KB, 14 KB compressed, instead of the 946 KB source.

It does no work while the map is hidden, scrolled out of view or the tab is in the
background, and catches up when it is shown again.

## Settings

- **Hide or show**: the ▾ button in the overview's header. Remembered per browser in
  `localStorage` under `gev.worldOverview.open` (`0` hides it).
- The overview follows the AUTOPILOT panel: it is not there when the early-warning engine
  is off, and closes with the panel.
- The blink stops for anyone whose system asks for reduced motion.

## Rollback

The overview is additive. To take it out without reverting the branch, remove
`<WorldOverview />` from `src/ui/views/ContextView.vue`; the console then creates no
owner, because it looks for `#world-overview` first. Reverting the merge commit removes it
entirely.
