# Fast Intelligence feeds: audit

Baseline audit for the Fast Intelligence Feed (31 October 2026), written before
any code changed and updated with what live testing then showed. It records what
exists, what was missing, source terms, risks and the plan actually chosen.
Implementation reference: [FAST_FEEDS_IMPLEMENTATION.md](FAST_FEEDS_IMPLEMENTATION.md).

## Starting point

| Item              | Finding                                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------------------------- |
| Live installation | `C:\Users\user\gev-autopilot`, instance 4174, commit `4f74cec7`, no local changes                          |
| Unpushed work     | None on any branch                                                                                         |
| Upstream          | Level with `bilawalsidhu/gods-eye-view` at `a725178e`                                                      |
| Development tree  | `C:\Users\user\gev-sync` (reused: C: had 16 GB free, too little for another `node_modules`)                |
| Local model       | KoboldCpp with Qwen3.6-35B on `127.0.0.1:8790`, not the usual 5001; a GTX 1070 at 99 %, often `busy`       |
| Companion specs   | `GODS_EYE_VIEW_AUTOPILOT_SPEC.md` and the air/sea spec are not on this machine; read through the repo docs |
| `gh` CLI          | Not installed; the GitHub REST API is used directly                                                        |
| Baseline tests    | 9,328 of 9,340 pass, 11 skipped, 1 known Windows sky-image failure (recorded at the previous sync)         |

## What already existed

Much of the specification's Phase 1 was already there, so nothing was rebuilt.

| Need                                | Existing owner                                         |
| ----------------------------------- | ------------------------------------------------------ |
| Observation → event fold, lineage   | `src/intel/engine.js`, `correlate.js`, `evidence.js`   |
| Copy detection, material changes    | `src/intel/correlate.js`                               |
| Severity, confidence, attention     | `src/intel/scoring.js` ("important" is not "true")     |
| Lifecycle, fade, archive            | `src/intel/lifecycle.js`                               |
| Camera, dwell, hysteresis, cooldown | `src/intel/scheduler.js` (the only camera authority)   |
| Proximity (attention only)          | `src/intel/proximity.js`                               |
| USGS, NWS, GDACS, tsunami centres   | `server/providers/intel/connectors/*`                  |
| GDELT, S2 GhostMaps                 | Same; GDELT is aggregator grade and never corroborates |
| Bounded model assessment            | `server/providers/intel/assessor.js`, `localLlm.js`    |
| Durable storage                     | `node:sqlite` in `server/providers/intel/store.js`     |

## What was missing

1. **Any push source.** Every feed polled. Nothing could see a public post within
   seconds, and nothing kept a stream cursor.
2. **Trust rules for social posts.** Three gaps would have been dangerous once
   posts arrived:
   - Three accounts counted as corroboration strong enough for a critical
     interruption of the camera.
   - Every new source on an event was "material", so a wave of reposts would keep
     lifting the camera cooldown.
   - A deleted post could only retract a whole event, even one others support.
3. **A way to place a report.** The gazetteer had countries and states but no
   cities, and most incidents name a city.
4. **Separate clocks on a card.** `occurred_at` silently fell back to publication
   time, so "when it happened" could not be shown as unknown.
5. **Honest coverage display.** Nothing distinguished "no events" from "the
   source that would report them is down".

## Sources

| Source                   | Role                | Access                          | Terms and caveats                                                                                             |
| ------------------------ | ------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Bluesky Jetstream v2     | Push, first reports | Public, no key                  | No SLA or stated limits in the docs. Measured below.                                                          |
| Telegram (MTProto)       | Push, first reports | User-owned `api_id`, `api_hash` | Only public channels an account may read. A Bot token cannot read arbitrary channels. Telegram's terms apply. |
| USGS, NWS, GDACS         | Official alerts     | Public                          | Reused. NWS asks for at most one request per 30 s; GDACS refreshes about every 6 minutes.                     |
| GDELT                    | Slow correlation    | Public                          | 15-minute cycle. Aggregator grade; opt-in; a headline is a claim.                                             |
| S2 GhostMaps             | Analyst context     | Public, CC BY-NC-SA 4.0         | Analyst summary, not independent confirmation.                                                                |
| ACLED                    | Listed only         | Needs key                       | Its terms bar this use; never polled.                                                                         |
| Natural Earth            | Gazetteer           | Bundled                         | Public domain.                                                                                                |
| Other national CAP feeds | Not started         |                                 | Each needs its own check of terms and format.                                                                 |
| Mastodon, news RSS       | Not started         |                                 | Optional in the specification.                                                                                |

## Risks and what was done about them

| Risk                            | Treatment                                                                                                         |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Rumour becomes fact             | `social_claim` source type: below camera confidence alone, capped below critical however many accounts agree      |
| Repost storm moves the camera   | Posts on an established event enrich its card and renew nothing                                                   |
| Forged or old timestamps        | Server time wins over a post's own; a claimed time can only make a post older                                     |
| Fabricated location             | Coordinates only for a town named in the text; stated coordinates are never read; countries give bounds, no point |
| Prompt injection through a post | Post fenced as data; the model answers one question; its answer must quote the post and pass the gazetteer        |
| Secrets in the repo or browser  | Telegram login encrypted with Windows DPAPI outside the repository; never sent to the browser                     |
| A slow model delays alerts      | The fast path has no model in it                                                                                  |
| Queue growth                    | Bounded, with counted drops and fairness by source                                                                |
| Disturbing the live instance    | Separate tree, database and port. See the AISStream note below                                                    |

## What live testing changed

These came from running against the real stream on 31 October 2026, and none of
them would have shown up with fake sockets.

- **v2 wire format.** Fields are flat inside `payload`, not the nested `commit.*`
  in older write-ups. Confirmed on the live stream.
- **Volume is small.** About 20 to 30 posts a second for the whole network, not a
  firehose problem at all.
- **`createdAt` cannot be trusted.** Against the server's time it ran from 29 s in
  the future to 5 days in the past, with a 99th percentile of 9 hours.
- **The account limit is not 10,000.** The docs say so, but the public hosts refuse
  an address over about 8 KB: 150 accounts open, 200 are refused.
- **A shutdown race could stop the server.** A late socket event hit a closed queue
  and the error killed the whole process, every feed included. Fixed and proven by
  a live restart.
- **The gate over-matched.** See the precision figures in the implementation doc.
- **`telegram` (GramJS) is archived.** Its maintainers point to `teleproto`, which was
  then reviewed and not approved. See [TELEGRAM_LIBRARY_REVIEW.md](TELEGRAM_LIBRARY_REVIEW.md).
- **Staging took the AIS connection.** See below.

### AISStream: a mistake to not repeat

AISStream allows one connection per key, and the AIS watchdog connects in the
background whether or not any browser wants vessels. The first staging server
inherited the key from `.env` and opened a second connection for a few minutes
before it was noticed and stopped. Instance 4174 afterwards showed AIS `live`, no
reconnects and 25,156 vessels, with nothing in its log, but a brief overlap cannot
be ruled out.

This is now enforced in code rather than left to instructions: see Staging in the
implementation doc.
