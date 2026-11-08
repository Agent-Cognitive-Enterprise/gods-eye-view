# Banking Access layer

A fork feature: countries where people are cut off from their money, shaded by
weighted impact. It sits in the **Events** group of the Layers panel. It is
local-only (remembered per browser, never in share links) and not
voice-controlled.

## What it shows

- **Shade:** light amber to dark red. In **% POPULATION** mode the shade
  follows the share of the population affected; in **PEOPLE** mode it follows
  the number of people. Both are weighted by severity, duration and
  confidence. The colour classes are:

  | Class    | % POPULATION (weighted share) | PEOPLE (weighted head-count)  |
  | -------- | ----------------------------- | ----------------------------- |
  | Minimal  | under 0.5% (outline only)     | under 10,000 (outline only)   |
  | Low      | 0.5% to under 3%              | 10,000 to under 100,000       |
  | Moderate | 3% to under 10%               | 100,000 to under 1 million    |
  | High     | 10% to under 25%              | 1 million to under 10 million |
  | Severe   | 25% and over                  | 10 million and over           |

  **Systemic** (a bright red border, never a darker fill) means an active
  event of severity 4 or 5 reaching at least 25% of the population or 10
  million people. The fill always follows the chosen metric, so a country of
  a billion with 1% affected stays light in **% POPULATION** mode even when
  the head-count makes it systemic. The border is dashed when some reach is
  unknown, and an event not re-verified for 30 days is never systemic.

- **Pattern:** the kind of disruption. Solid for bank failure or frozen
  deposits, stripes for a technical outage, a check for withdrawal limits or
  capital controls. Where the graphics card cannot draw patterned ground
  fills, all fills are solid.
- **Border:** solid in the class colour while active; grey while a resolved
  event fades; dashed when a live event's reach is not given by any source
  (with no known reach at all there is no fill, so the extent is shown as
  unknown rather than guessed; beside a known reach the shade may
  understate), or for past events in **HISTORY** mode. A **Minimal** country
  is a solid outline without a fill. A mode without a figure (a share but no
  head-count, or the reverse) shows the country as reach unknown in that
  mode. Unfilled countries keep an all-but-invisible interior, so clicking
  anywhere inside them selects them.
- **Card:** click a country, or its row, for the card. It shows the people and
  share affected, severity, duration (a start date for restrictions over 60
  days), confidence, the sources of the country's events by publisher, when
  it was last updated or resolved, how the reach was estimated, and the
  summary. When several events may overlap, the reach is a range (see below)
  and the card says so; an ongoing event not re-verified for 30 days says
  "Not re-verified since …". Choosing a row also
  flies there and pauses the Autopilot; **SOURCE ↗** then opens the lead
  event's first source.
- **Row:** chips for the two modes, **NEWEST** (list by last update rather
  than impact) and **HISTORY**. With news leads on, **NEWS LEADS** lists
  them instead of the countries.

There is no hover tooltip: the card on click carries the same facts.

## Scoring

Per event:

```text
share_score  = affected_population_pct / 100 × severity_w × duration_w × confidence_w × fade × stale
people_score = affected_people          × severity_w × duration_w × confidence_w × fade × stale
```

- **severity_w:** 1 → 0.3, 2 → 0.5, 3 → 0.7, 4 → 0.9, 5 → 1.0.
- **stale:** 0.5 for an ongoing event not re-verified for 30 days, else 1.
- **duration_w:** under 6 h 0.25, under a day 0.5, under 3 days 0.75, else 1.
  An ongoing event's duration grows until it is resolved.
- **confidence_w:** `social` 0.4, `multiple_reports` 0.7, `official` 1.0.
- **fade:** 1 while active; after `resolved_time` it falls linearly to 0
  over 5 days, after which the event is history (shown only with
  **HISTORY**).

When only one of `affected_people_est` and `affected_population_pct` is given,
the other is derived from the bundled World Bank population (SP.POP.TOTL,
latest year, `server/providers/bankingAccess/population.json`). When neither
is given, the event has no score.

Per country: overlap between events is unknown (two banks may share
customers), so the reach is a range, from the largest single event (full
overlap) to their sum (none), capped at 100% and at the population; the list
shows the lower bound, marked "+" when the range is wider. The colour uses
the largest single event's score, so a country is never redder than its
measured disruption. When every event of a country is history, its figures
are still shown on the card, unscored. The most serious live event (severity
first, then reach, then the latest) gives the country its type, pattern and
card, whether or not its reach is known. An event whose `start_time` is still
in the future is not drawn until it starts, and a `resolved_time` in the
future (a planned end) does not count towards the duration.

## The events file

Reviewed events live in `server/providers/bankingAccess/events.json`. An
operator can keep their own file outside the repo and point
`GEV_BANKING_ACCESS_EVENTS` at it (an absolute path); its events add to the
bundled ones, and an event with the same `id` replaces the bundled one. Both
files are re-read every 30 seconds, so edits show without a restart.

```json
{
  "events": [
    {
      "id": "xyz-2026-11-withdrawal-limits",
      "country_code": "XYZ",
      "country_name": "Example",
      "event_type": "withdrawal_limits",
      "severity": 4,
      "confidence": "multiple_reports",
      "start_time": "2026-11-01T00:00:00Z",
      "last_update_time": "2026-11-05T00:00:00Z",
      "last_verified_time": "2026-11-08T00:00:00Z",
      "resolved_time": null,
      "affected_people_est": null,
      "affected_population_pct": 12,
      "affected_basis": "How the estimate was made, and from which source.",
      "summary": "One or two sentences.",
      "sources": [
        {
          "title": "…",
          "url": "https://…",
          "publisher": "…",
          "published": "2026-11"
        }
      ]
    }
  ]
}
```

- `country_code`: ISO 3166-1 alpha-3. SSD, PSE, XKX and ESH are mapped to
  the bundled Natural Earth pack's SDS, PSX, KOS and SAH.
- `event_type`: `technical_outage`, `withdrawal_limits`, `capital_controls`,
  `deposit_freeze` or `bank_failure`.
- `severity`: 1 minor outage, card or app disruption, short; 2 multi-bank or
  regional outage; 3 no cash or payments for many hours or days; 4
  withdrawals restricted, transfers blocked, deposits effectively trapped; 5
  bank collapse, licence revoked, capital controls, widespread deposit
  lock-up.
- `confidence`: `social` (social media only), `multiple_reports`, or
  `official` (regulator, central bank or the bank itself among the sources).
- `last_verified_time`: when a reviewer last confirmed the status (still
  ongoing, or resolved). A report's date is not a confirmation that it still
  holds: an ongoing event not re-verified for 30 days counts half (it
  fades) and its card says so. Defaults to `last_update_time`.
- At least one source with an http(s) URL is required.

An entry that breaks a rule is left out and counted on the row ("Entries to
fix"); the reasons are in the route's `problems` list. Two entries with the
same `id` in one file are reported; the later one is kept.

## Review workflow

1. With `GEV_BANKING_NEWS=1`, the row's **NEWS LEADS** lists recent articles
   whose words suggest a disruption (GDELT DOC 2.0, last 3 days). They are
   unverified: never drawn, never scored. The publisher's country is shown,
   which is not necessarily where the event is.
   A request that fails on the network, or that GDELT answers with 429
   (one request every 5 s per address) or 5xx, is tried twice more, 6 and
   15 seconds apart; after that the next try is 15 minutes later.
2. A reviewer reads the sources, then adds an event to the operator file (or,
   for the shared set, to the bundled file in a pull request), with the
   reach only when a source gives it, and `affected_basis` saying how.
3. When the disruption ends, set `resolved_time`. The country fades over 5
   days, then is history.

## Route

`GET /api/banking-access` (`?history=1` adds past events). Same-site browsers
only, rate limited, GET only. The answer holds `countries` (with classes,
scores, intensity per mode, population), the `events` behind them, `counts`,
`problems`, and `news` (`enabled`, `fetchedAt`, `error`, `candidates`).

## Limits

- The map is only as fresh as the last review. News leads help a reviewer
  notice events; they do not replace one.
- Estimates of people affected are rare and rough. Many events will show as
  outlines with the reach unknown.
- Population figures are a bundled snapshot (World Bank, retrieved
  2026-11-08); territories without a World Bank figure get no derived share.
