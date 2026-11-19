# Review submarine cable incident evidence

The TeleGeography overlay shows routes, not health. A regional traffic anomaly
can be caused by a power loss or shutdown, and a real cable break can produce
little visible traffic loss if providers reroute. Keep the two kinds of
evidence separate.

This offline tool takes a **locally reviewed** JSON file and emits a reproducible
snapshot. It does not scrape reports, verify publisher identities, poll a feed,
update the globe, or send Autopilot alerts. Do not pass unreviewed feed or model
output directly to it.

## Run the historical replay

```sh
node tools/cable-incidents/replay.mjs tools/cable-incidents/c-lion1-2024-11.json 2024-11-20T00:00:00Z
node tools/cable-incidents/replay.mjs tools/cable-incidents/c-lion1-2024-11.json 2024-11-30T00:00:00Z
```

The first snapshot reports `fault-confirmed`, the second `reported-restored`
with `breakConfirmed: true`. These are two replay checkpoints, not an estimate
of how fast GEV could have learned the news. The fixture records `knownAt`
conservatively for the selected notices, without claiming their exact original
publication times. The restoration notice also reports that rerouting limited
disruption. No physical cause or actor is inferred.

## Evidence and decision rules

Supply `{ "evidence": [...] }`. Each claim needs a unique `id`, a `sourceKind`,
the original public HTTPS `sourceUrl`, a `claim`, the UTC `effectiveAt` time and
the UTC `knownAt` time when that version of the claim was available. Use
`YYYY-MM-DDTHH:mm:ssZ` or milliseconds. Immutable records with the same ID and
different contents are rejected. `knownAt` prevents late reports from leaking
into earlier snapshots. A cable operator or relevant authority can support a
qualified claim only in its own remit. For copied news, use the originating
primary notice if it can be independently verified.

1. Send `outage` observations to a separate list. `news`, `social`, or
   `telemetry` claims about a specific cable remain leads, even when they name
   the same cable or a dozen copies repeat the story.
2. For a primary `fault`, physical `break`, or cable `restored` claim, supply
   the cable ID or exact catalogue name, and a local `incidentId` shared by
   notices about the same incident on that cable. Resolve multipart routes as
   one ID. Unknown or ambiguous names and ID/name mismatches stay as leads.
   There is no fuzzy or nearest-cable match.
3. A notice saying only **fault** cannot establish a physical break. Mark
   `break` only when the notice expressly confirms a physical break, and
   `restored` only when it expressly confirms that cable's return to service.
   Restoration needs a known earlier fault in the same incident. A restoration
   without a fault, or followed by a same-incident fault, needs review. A
   separate subsequent fault needs a new incident ID. An open status is last
   known, not live telemetry or proof the cable is still down.

## Next integration

Add an opt-in source inbox for operator and regulator notices. Automatic
extraction can suggest row fields and exact catalogue matches for review. Use
regional outage feeds such as [IODA](https://ioda.inetintel.cc.gatech.edu/) to
measure impact independently, not as a prerequisite for cable confirmation.
Replay a labelled set of faults, repairs, false positives and silent/rerouted
faults before publishing cable status to the existing overlay. Keep raw leads
out of Autopilot, and treat publisher corrections/retractions as operator review
until a versioned correction model is in place.
