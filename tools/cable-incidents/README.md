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
`YYYY-MM-DDTHH:mm:ssZ` or milliseconds. `effectiveAt` is when the asserted
condition began, not when the notice was published: a later notice confirming
that an earlier fault was a physical break keeps the fault's time, and a
restoration uses the time service returned. Records with the same ID and
different contents reject the whole file, at every checkpoint. `knownAt`
prevents late reports from leaking into earlier snapshots. A cable operator or relevant authority can support a
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

## Watch for new notices (observe-only inbox)

`inbox.mjs` checks a short list of sources you choose and turns each new
notice into a **proposal** for you to review. A proposal is never evidence.
Only `accept` writes a row to the reviewed evidence file, with the
claim, incident and effective time that you supply. The inbox serves no route,
changes nothing on the globe and sends nothing to Autopilot. It runs only
when you run it, and nothing schedules it.

```sh
mkdir tools/cable-incidents/state
cp tools/cable-incidents/sources.example.json tools/cable-incidents/state/sources.json
node tools/cable-incidents/inbox.mjs poll
node tools/cable-incidents/inbox.mjs list
node tools/cable-incidents/inbox.mjs accept <proposal id> --claim fault \
  --incident 2024-11-18 --effective 2024-11-18T02:04:00Z
node tools/cable-incidents/inbox.mjs reject <proposal id> --reason "not a cable notice"
node tools/cable-incidents/inbox.mjs report
```

The state lives in `state/` next to the tool, which git ignores, or in the
folder you pass with `--state`. It holds your `sources.json`, `inbox.json`
(proposals and what has been seen), `evidence.json` (your reviewed rows, in
the replay format above) and `ioda.json`. Only one run at a time is
allowed: a run holds `inbox.lock`, and it removes the lock when it
finishes or is stopped with Ctrl-C. If a run is killed, delete the lock.
`accept` writes the evidence file first, then the inbox: if it stops in
between, the row is there and the proposal still shows as new.

**Sources.** Each source is `rss` (RSS or Atom) or `page`, a news listing
page whose article links start with `pathPrefix`. Each also has a
`sourceKind`: `operator` or `authority` for primary notices, `news` for
leads. Only HTTPS is accepted. An RSS item needs a full HTTPS `<link>`, or
failing that a full HTTPS `<guid>`; other items are skipped. Redirects are followed by hand, at most
five, and any hop that is not HTTPS fails the source. A feed item that
links to another site than the feed's own (`www.` aside) is proposed as
`news`, whatever the source, and marked as linking elsewhere. A page
source keeps only links on the page's own site. The example lists the
sources checked on 2026-11-20:

| Source                   | Kind      | Covers                                  | Note                                         |
| ------------------------ | --------- | --------------------------------------- | -------------------------------------------- |
| Cinia feed               | operator  | C-Lion1                                 | The page version is listed too, switched off |
| WIOCC news page          | operator  | Its capacity on EASSy, Equiano, 2Africa | Mostly commercial news; see below            |
| Space Norway feed        | operator  | Svalbard cables, Arctic Way             |                                              |
| Seaborn feed             | operator  | Seabras-1                               |                                              |
| Tata Communications feed | operator  | TGN, consortium shares                  | Mostly corporate news                        |
| Traficom news page       | authority | Finland                                 | Lists only its newest notices: poll daily    |
| Nkom news page           | authority | Norway, Svalbard                        | In Norwegian                                 |
| SubTel Forum feed        | news      | Industry news                           | Leads only                                   |

An `operator` source is primary only for cables it runs. WIOCC holds
capacity on Equiano and 2Africa but does not run them. A notice such as
"WIOCC restores ISPs on Equiano cable" is about WIOCC moving its own
customers, not about a repair of the cable. Record such a notice as
`news` (`--source-kind news`) unless it is about a cable WIOCC operates.
The same holds for Tata on consortium cables.

Checked and not usable as they stand:

- **SEACOM, Sweden's PTS, Telia, Taiwan's NCC:** the news list is built by
  JavaScript, so the page has no article links.
- **Liquid, Sparkle, Southern Cross, ACE, Chunghwa Telecom:** the news
  addresses tried return 404.
- **MainOne:** refuses automated requests (403).
- **Faroese Telecom:** redirects to its home page.
- **Tonga Cable, status.seacom.com:** no answer.
- **Telstra:** the media page has no article links.

Most operators publish no feed, so add their news page as a `page`
source, after checking that it is their own notice page. Wording cues are
English only: a notice in another language may name its cable but gets
no suggested claim. The first poll of a source that lists notices only records
them, so old news does not flood the inbox. A poll that lists nothing,
such as a consent page, records nothing. `--include-existing` proposes
the notices already listed too. A URL is proposed once: if an operator
updates a notice in place, the inbox will not see the update.

**Proposals.** A proposal lists the catalogue cables that its title and
summary name. It finds them by catalogue name, ignoring case, as whole
words, with no fuzzy match, and only in text that says cable, subsea,
submarine or undersea, or kabel, kabler, kablene, kablar or kaapeli (also inside a
compound word such as sjøkabel or merikaapeli). Those words also occur in names
("Kabelvåg", "Kabel Eins"), so they can let a name like "Northern Lights"
through; the reviewer still decides. Catalogue names include "Northern Lights", "Cook
Strait" and "T3". A one-token name of five or more characters with a
digit, such as "SeaMeWe-4" or "C-Lion1", is matched without that word, so "C-Lion1 repair
completed" still names the cable. Non-English notices name a cable only by
such a name. A one-word name such as "Echo" or "SAFE" is also
matched only with its catalogue capitals, and is shown as weak. Stored and
printed text has control and bidirectional characters removed.

The proposal suggests a claim from the wording: `restored` for repaired
or back in service, otherwise `fault`. Repair wording next to a negation,
a repair still to come or rerouting ("not yet restored", "until
repairs", "traffic rerouted") suggests nothing, because a wrong `restored`
would close an incident. It never suggests a physical
`break`. Words like "cut" or "damaged" are listed for you to check against
the notice itself. A suggestion is only a hint, so read the notice.

**Accepting.** `accept` needs:

- `--claim`.
- A local `--incident` ID.
- `--effective`: when the condition began, from the notice.
- The cable (`--cable` or `--cable-name`), unless the notice names exactly
  one catalogue cable and no weak one. `accept` prints the cable it used.

`knownAt` is when the inbox first saw the notice. `--source-kind` and `--url` let you record the operator's own
notice behind a news story. Because you found that notice now, `knownAt`
is then the time of the accept. Every accept replays the whole file, so an invalid or conflicting row is
refused. A row from a non-primary source is kept, but it stays a lead, and
the report says so. One
notice can be accepted for more than one claim. Cinia's repair notice, for
example, supports both `break` (effective at the fault time) and
`restored`.

**Report.** `report` replays your evidence a day before `--at` (default:
now) and at `--at`, then lists:

- Every incident that is new or has changed: "no operator report yesterday,
  operator reports a fault today". This goes by when each notice was
  first seen, so a notice reviewed days later changes that earlier day.
- The proposals accepted or rejected in the last 24 hours, whenever they
  were first seen.
- The incidents still open.
- The proposals waiting for review.
- The sources that failed.

An open status is the last thing reported, not proof that the cable is
still down.

**IODA.** `poll --ioda`, or `"ioda": {"enabled": true}`, fetches IODA's
country-level outage events for the last 24 hours. No key is needed. The
report lists them in a separate section, as impact only: a drop in a
country never names a cable, and a cable fault is never required to show
one. IODA marks its data "Copyright Georgia Tech Research Corporation. All
Rights Reserved". Its API software is licensed for academic research and
education. No data-use terms were found, so ask the IODA team before
polling it regularly or for other uses. It is off by default.

## Automatic signals (phase 1: shadow mode)

`GEV_INTEL_CABLES=1` (with `GEV_INTEL_ENABLED=1`) adds a feed named
`submarine-cables` to Autopilot. Every hour it polls the checked sources in
`server/providers/intel/connectors/cables.js` and judges each new notice
without a person (`src/intel/cableSignals.js`):

1. **Red flag:** the notice names a catalogue cable, or says submarine,
   subsea, undersea or sea cable, cable route, system, landing, ship, repair,
   cut, fault or damage, or a Nordic or German word for a sea cable. Its
   priority is `incident` (fault, outage, cut, damage, repair wording),
   `threat` (anchor, vessel, trawler, sabotage, investigation, police, navy,
   coast guard) or `mention`.
2. **Clear signal:** all of these hold.
   - The source is an operator or regulator, and the item links to its own
     site.
   - The notice names exactly one catalogue cable, and it is in the source's
     own `cables` list: an operator's own cables, a regulator's cables in its
     country. WIOCC and the news source speak for none.
   - The notice is dated: by its feed, or by the date a listing page puts in
     front of the title ("18.11.2024 …", "August 14, 2024 …").
   - Its wording matches a strict template: a fault ("fault detected in",
     "a fault in", "disturbance on", "cable cut", "C-Lion1 cable outage") or
     a repair stated as done ("has been repaired", "fully restored", "back
     online").
   - None of this appears:
     - negation or denial (no, not, n't, unaffected, normal, denies, false);
     - future, plans or questions (will, to be, expected, planned, until,
       in case, a question mark);
     - unconfirmed wording (suspected, possible, investigation);
     - other kinds of notice (maintenance, upgrade, drill, exercise, test,
       anniversary, years, since, last, results, latency, contract, award,
       route, project, court);
     - another cable or line (another, second, again, power cable,
       pipeline);
     - a year other than the notice's own or the one before;
     - both fault and repair wording.

   Its claim is `fault` or `restored`. A break is recorded only when the
   notice says cut, severed, broken or break. The templates are narrow on
   purpose: a wrong clear signal would reach the map with nobody to stop it.
   A real incident in other words becomes doubt instead.

3. **Doubt:** any other incident or threat red flag. In phase 2 a local
   model will judge these. Without one they are dropped. A clear notice
   dated more than 7 days before it was first seen is old news under a new
   address, so it is doubt too.
4. **Shadow incidents:** each cable has at most one incident at a time,
   and notices are applied in time order, a fault before a repair at the
   same time.
   - A clear fault opens an incident on its cable, or updates the open one.
   - A clear repair notice closes it, unless the repair is dated before the
     incident began.
   - A fault dated no later than the close belongs to the closed incident.
   - An open incident with no report for 30 days fades: it was last
     reported then, not proven repaired.

Nothing reaches the engine, the map or the camera. The feed is listed in
Autopilot's feeds as "Submarine cable notices (shadow mode)". Each red flag
and each would-be change goes to `cables-shadow.jsonl` in the intel folder
(`.gev-cache/intel`, or the folder of `GEV_INTEL_DB`), next to
`cables-shadow-state.json`. The first poll of each source records only a
baseline. A state file that cannot be read is moved aside
(`.corrupt-<time>`), and the reset is logged. The feed counts as failed only
when every source fails; a single failing source is logged in
`cables-shadow.jsonl` only.

`node tools/cable-incidents/evaluate.mjs` scores the rules on
`labelled-notices.json`, which holds three kinds of notice:

- **121 real notices** fetched on 2026-11-20, including Cinia's six C-Lion1
  fault and repair notices from 2024–25.
- **12 synthetic notices**, marked as such: paraphrased patterns of
  documented events, not quotations.
- **106 attack titles** written in review to break the rules ("No fault
  found on C-Lion1", "Planned maintenance … interruptions expected", "Cinia
  cuts latency on C-Lion1", "One year since the C-Lion1 cable cut"). Each
  is labelled by what it actually says.

On that set the rules give no wrong clear signal and catch all six real
incidents. They catch 14 of the 26 notices that should be clear. The
misses are synthetic or attack notices: Finnish or Norwegian wording,
"second fault after repair", fault and repair in one title, and Tata's
short names such as "TGN-Pacific". Those go to doubt. The tests pin no
wrong clear signal and no missed real incident.

Known limits:

- Nkom writes in Norwegian, so it can raise red flags but no clear signal.
- Tata's notices name "TGN-Pacific", not the catalogue's "Tata
  TGN-Pacific".
- Real notices rarely use the full "Svalbard Undersea Cable System".

## Next integration

Replay a labelled set of faults, repairs, false positives and
silent/rerouted faults before publishing cable status to the existing
overlay. Keep raw leads out of Autopilot, and treat publisher
corrections/retractions as operator review until a versioned correction
model is in place.
