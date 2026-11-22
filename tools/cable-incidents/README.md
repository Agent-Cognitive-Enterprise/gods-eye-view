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
sources checked on 2026-11-20, and those added on 2026-11-21 after the
SEA-ME-WE 5 fault off Pakistan (2026-11-18) reached none of them:

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
| Transworld feed          | operator  | TW1, SEA-ME-WE 5 in Pakistan            | Mostly marketing                             |
| PTA media page           | authority | Pakistan                                | Switched off: timed out from Australia       |
| Dawn feed                | news      | Pakistan                                | Leads only                                   |
| ProPakistani feed        | news      | Pakistani technology news               | Leads only                                   |
| Telecom Review feed      | news      | Middle East telecoms                    | Leads only                                   |
| Arab News feed           | news      | Saudi Arabia, Red Sea                   | Leads only                                   |
| Gulf News feed           | news      | UAE, Gulf                               | Leads only                                   |

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
words, and only in text that says cable, subsea,
submarine or undersea, or kabel, kabler, kablene, kablar or kaapeli (also inside a
compound word such as sjøkabel or merikaapeli). Those words also occur in names
("Kabelvåg", "Kabel Eins"), so they can let a name like "Northern Lights"
through; the reviewer still decides. Catalogue names include "Northern Lights", "Cook
Strait" and "T3". A one-token name of five or more characters with a
digit, such as "SeaMeWe-4" or "C-Lion1", is matched without that word, so "C-Lion1 repair
completed" still names the cable. Non-English notices name a cable only by
such a name. A one-word name such as "Echo" or "SAFE" is also
matched only with its catalogue capitals, and is shown as weak.

In text that says cable (or one of the words above), a name with a
letter and a digit may be spaced and hyphenated differently: news wrote
"SEA-ME-WE 5" and "SMW5" for the catalogue's "SeaMeWe-5", and "C-Lion 1"
finds "C-Lion1". A few other spellings are listed as aliases (SMW4, SMW5,
SMW6, EIG). There is no other fuzzy match: "C-Lion12" and "SEA-ME-WE 55"
name nothing, and neither does "Africa 1,000 km". A clear signal still
needs the catalogue's own spelling (or an alias) in the title; any other
spelling goes to doubt and the local model. Stored and
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
2. **Clear signal:** decided on the notice's **title alone**. The summary
   is never judged, because company boilerplate ("Cinia also operates the
   C-Lion1 submarine cable") names cables too. All of these must hold:
   - The source is an operator or regulator, and the item links to its own
     site.
   - The title names exactly one catalogue cable, and it is in the source's
     own `cables` list: an operator's own cables, a regulator's cables in
     its country. WIOCC and the news source speak for none.
   - The notice is dated: by its feed, or by the date a listing page puts in
     front of its card ("18.11.2024 …", "August 14, 2024 …"). A date in the
     future is refused.
   - The whole title has one of the allowed shapes, tied to the cable's
     name and followed by the word "cable" (unless the name has it), with
     the incident in the singular:
     - Only the source's own name may stand before the cable's name: "the
       Cinia", "Cinia's", "Cinia Oy's", from the source's `speakers` list.
       "Fault in the former C-Lion1 cable" and "Preventing C-Lion1 cable
       faults" are no shape.
     - A place may follow, as a capitalised proper name: "near Gotland",
       "off Fujairah". It may also be "between A and B" when both are on
       the source's `places` list (Cinia: Finland, Germany). "In" and "at"
       are not allowed: "damaged in the film", "cut in prices" and "outage
       in December" are no shape.
     - The only labels taken off the title are the source's own name and
       "Update" ("Cinia: …", "… | Cinia", "… - Press release"). "Satire:"
       and "Opinion:" stay, so the title is no shape.

     The allowed shapes are:
     - a fault: "A fault in the Cinia C-Lion1 submarine cable", "Fault
       detected in …", "Disturbance on …", "C-Lion1 cable outage",
       "C-Lion1 submarine cable cut", "C-Lion1 cable damaged",
       "Svalbard Undersea Cable System: fault";
     - a repair stated as done: "C-Lion1 submarine cable has been repaired",
       "… has fully restored", "C-Lion1 cable back online", "Disturbance in
       the C-Lion1 cable has been repaired".

   - No blocking word appears in the title, as a second line of defence:
     - negation, denial or hedging (no, not, n't, unaffected, normal, usual,
       denies, false, claims, feared, unconfirmed, suspected, possible);
     - future, plans or questions (will, may, to be, expected, planned,
       until, in case, a question mark);
     - partial or moved service (partially, alternative, rerouted, remains,
       still, resolved, fixed, again, second, another);
     - other kinds of notice (maintenance, upgrade, drill, exercise,
       inspection, anniversary, years, last, timeline, review, results,
       cost, damages, compensation, contract, court, crew, sanctions,
       statement, power, pipeline, gas, exchange).
   - No year in the title other than the notice's own, and no '24-style
     years.

   Its claim is `fault` or `restored`. A break is recorded when the title
   says cut, severed, broken or break, or when a summary sentence opens
   with it ("The break in Cinia's C-Lion1 submarine cable has been
   repaired …").

   Allowed shapes decide, not a list of blocked words. Two review rounds
   showed that a blocklist alone never stops the next wrong signal: "Cinia
   files damages claim over C-Lion1 cable cut" and "Disturbance in C-Lion1
   resolved" both passed it. A wrong clear signal would reach the map with
   nobody to stop it, so a real incident in any other wording becomes
   doubt instead.

   On page sources the title is the card's first heading in document order:
   an `<h1>`–`<h6>`, or an element with a title class (`title`,
   `card-title`, `heading-style-h4`; not `series-title`, `tag-title` or
   `eyebrow`). A plain text link counts too, unless it only says "Read
   more". A card with no title is doubt.
   Traficom's and Nkom's links carry no date, so their notices are doubt
   until phase 2.

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

In shadow mode nothing reaches the engine, the map or the camera (phase 3
changes that, below). The feed is listed in
Autopilot's feeds as "Submarine cable notices". Each red flag
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
- **333 attack titles** written in three review rounds to break the rules ("No fault
  found on C-Lion1", "Planned maintenance … interruptions expected", "Cinia
  cuts latency on C-Lion1", "One year since the C-Lion1 cable cut"). Each
  is labelled by what it actually says.

Second and third review rounds added 89 and 138 more attack titles. On
all 466 notices the rules give no wrong clear signal. They catch five of the six real
incidents; the sixth is titled "Disturbance in Cinia's C-Lion Submarine
Cable", with "C-Lion", not the catalogue's "C-Lion1". Of the 51 notices
that should be clear, they catch 33. The other misses are synthetic or
attack notices: Finnish or Norwegian wording, "second fault after repair",
other title wordings, and Tata's short names such as "TGN-Pacific". Those
go to doubt. The tests pin no wrong clear signal, and the one known real
miss.

Known limits:

- Nkom writes in Norwegian, so it can raise red flags but no clear signal.
- Tata's notices name "TGN-Pacific", not the catalogue's "Tata
  TGN-Pacific".
- Real notices rarely use the full "Svalbard Undersea Cable System".

## Automatic signals (phase 2: the local model, shadow mode)

A doubtful notice that names a catalogue cable waits in a queue in
`cables-shadow-state.json`. So does an operator's or regulator's notice
with incident wording that names no cable in its title and summary
("International submarine cable develops fault: PTA"): its article may
name the cable, and if it does not, the notice is skipped as
`no-cable-named`. News that names no cable is not queued, because general
news says "cable fault" of power cuts all the time. The queue holds at
most 200; when it is full the oldest news goes first, and an operator's
or regulator's notice only when no news is left. After each poll the
shared local model reads up to three of them, at most twelve an hour,
and at most five articles are fetched per poll, read or not. It runs only while the model is online and idle and no voice
conversation holds it. `GEV_INTEL_CABLES_LLM=0` or `GEV_LLM_DISABLED=1`
leaves the feed on rules alone (`src/intel/cableAssessment.js`):

1. Operators' and regulators' notices are checked first: a news source can
   only ever give an unverified report.
2. The article is fetched from the publisher's own site; if a redirect
   leads elsewhere, only title and summary are used. Its readable text is
   kept: the longest `<article>`, or `<main>` or `<body>`. Scripts,
   navigation, headers, footers, forms are dropped, and so are blocks
   marked as related news, teasers, comments, sidebars or share bars, so
   their old headlines cannot be quoted.
3. The model answers in a fixed format:
   - is it about an incident, and is it current;
   - which cable, chosen only from the cables the notice names;
   - fault, break, restored or none;
   - the start date;
   - one whole sentence, word for word, that names the cable.

   The notice is given to the model as data, never as instructions.

4. The answer counts only if all of these hold:
   - The notice has a date of its own. The model's word that it is
     current is not enough.
   - The quote lies inside one sentence of the notice: the title, or a
     summary or article sentence. That **whole sentence**, and the title,
     are judged, never the quote alone. So "fault in the C-Lion1 cable",
     quoted from "Possible fault in the C-Lion1 cable", is hedged.
   - Neither the sentence nor the title has negation, hedging, plan or
     condition words, or drill, maintenance, history, money or law words
     (the phase-1 lists).
   - The sentence states the claim: fault wording, break wording for a
     break, repair wording for a repair. A repair must not be partial or
     rerouted. A fault must not be one the sentence says is repaired or
     resolved.
   - The sentence names the chosen cable, and no other cable the notice
     names, by any of their catalogue names in any spelling ("EESF-2" is
     "Finland-Estonia 2", "SEA-ME-WE 5" is "SeaMeWe-5").
   - The start date, if given, is in the last 30 days.
5. A valid answer from an operator or regulator about its own cable is
   `llm-clear`, and it updates the shadow incidents like a clear signal,
   unless one of these limits it to `llm-unverified` (logged as
   `limitedBy`):
   - `quote-only-in-article`: the quote comes from the article body. A
     fault, like a repair, is confirmed only from the title or summary:
     article bodies carry teasers, related news and other cables.
   - `quote-not-a-plain-statement`: excluding every other cable cannot
     work ("after a fault on the Gwadar fibre", "near Karachi where the
     Oman one failed"), so the quoted sentence must be a closed grammar,
     as a phase-1 title is. It has one of a few whole shapes about the
     chosen cable:
     - "A fault was detected in the C-Lion1 cable …", "There is a fault
       in …", "The fault in the C-Lion1 cable is located …"
     - "The C-Lion1 cable was damaged …", "… is out of service", "The
       C-Lion1 cable connection between Finland and Germany has been
       interrupted", "Data traffic in the C-Lion1 cable was interrupted …"
     - "The SMW5 cable has developed a fault …", "The SMW5 cable fault was
       detected …"
     - for a repair: "The C-Lion1 cable has been repaired …", "The break
       in the C-Lion1 cable was repaired …"

     The source's own name may lead ("Cinia has detected …", "Transworld
     informs its customers that …"). After a fault only these may follow,
     up to four of them:
     - one of the source's own `places` or `vocabulary` (a source with
       several cables lists each cable's places in `cablePlaces`, so
       Traficom's C-Lion1 "between Estonia and Sweden" is not one): "between Finland
       and Germany", "connecting Helsinki and Rostock", "near Gotland",
       "in the Swedish economic zone", "about 11 km off Karachi", "near
       the Karachi cable landing station";
     - a time: "at 4:04 a.m.", "at 06:40 Finnish time";
     - a date: "on Monday", "on 17 November 2026", "this morning".

     After a repair only a date or a time may follow: "repaired on the
     Finnish side" or "restored at reduced capacity" is not a whole
     repair. Nothing else is allowed: no "where", "as" or "after", and no
     other verb.

   - `quote-dated-another-year`: the sentence or the title names a year
     other than the notice's own, or a year written as '24 (phase 1's
     rule): "damaged near Gotland in 2024" is history.
   - `quote-dated-apart-from-notice`: the sentence, the title or the
     summary states a calendar date more than 7 days before the notice or
     after it, a date that does not exist ("31 February"), or the sentence
     states two dates that differ ("repaired on 2
     January" in a November post is a recap). Without a year the date is
     in the notice's year, or the year before. A stated date is also the
     event's time, for a repair too, so a repair dated before the fault
     opened closes nothing.
   - `model-date-differs-from-quote`: the model's start date and the
     sentence's date differ by more than a day.
   - `quote-may-name-another-cable`, a second layer: a list of other
     cables would always miss some ("the PEACE system", "WACS", "the line
     operated by PTCL"), so the check works the other way round:
     - Every cable noun in the sentence (cable, system, link, connection,
       line, network, segment, route) must belong to the chosen cable,
       with only its names masked. "The Oman cable", "the Finland-Sweden
       link", "the other system" and "the cable from Gwadar" fail;
       "the Karachi cable landing station" and "the cable ship" do not
       count as cables.
     - A source's own name straight before fault wording ("the
       Transworld fault") may mean another of its cables.
     - With the chosen cable's names and the source's own words
       (`speakers`, `places`, `vocabulary`) masked, nothing name-like may
       be left: another catalogue cable in any case or spelling, also
       without "Cable" and by its bracketed parts with their capitals
       ("PEACE", "WACS"); an
       unlisted one (SeaMeWe-3); a word with letters and digits; a word
       with two capitals; or a capitalised word after the first (not
       judged in the title, which may be in title case). Months, days and
       time zones are allowed.

     These checks cost right answers that name another place or company.

   - `headline-may-name-another-cable`: the same check on the title and
     summary, without the capitalised-word rule, and without the
     cable-noun rule when they do not name the chosen cable ("Network
     advisory" is a title, not another cable). A title such as "TW1 and
     SMW5 keep Pakistan connected" names two cables, so a fault quoted from
     its article is not confirmed.
   - `consortium-repair`: a source that is one landing party of a
     consortium cable (its `consortium` list; Transworld for SEA-ME-WE 5)
     may report a fault but cannot close the whole cable. Phase 1 gives
     doubt for the same reason. Such an incident is closed by no source:
     it fades after 30 days.
   - A fault dates from its start date.
   - A repair dates from its notice.
   - A repair seen while no incident is open is remembered, so a report of
     an earlier fault checked later cannot reopen the cable.

   Any other valid answer is `llm-unverified`, a report that is logged
   only. Anything else is `llm-rejected` with its reason. A busy model
   (another user of it) leaves the queue for the next poll and counts for
   nothing. After three real failures a notice is dropped.

`node tools/cable-incidents/evaluate-llm.mjs` runs the model on the
labelled notices the rules leave in doubt, using title and summary only.
It checks the claim, not which cable was chosen: the labels carry no
expected cable, and articles are not fetched, so article text (the main
attack surface) is covered by the unit tests, not by this score. On 60
of them, against Qwen3.6-35B through KoboldCpp on 2026-11-20:

- no wrong `llm-clear`;
- two correct ones: Cinia's real February 2025 notice titled "C-Lion",
  and a Svalbard fault;
- seven real incidents missed, mostly judged "not current".

Before the quote rules above, the same run gave three wrong `llm-clear`
("Possible fault on …", "Suspected fault …", and a C-Lion1 fault for
"Fault on the EE-S 1 cable; C-Lion1 traffic normal").

Three review rounds of phase 2 ended with no remaining wrong `llm-clear`
that does not need the model to make a mistake. These misses were
accepted for safety:

- Operator sentences that quote someone are rejected as attribution:
  "Cinia said the fault was detected …", or a CEO quote next to the fault
  sentence.
- A denial two sentences away is not seen; only the sentences either side
  are checked.
- Block words can drop a whole wrapper (`elementor-widget-container`,
  `share-enabled`, WordPress `tag-*` classes), leaving title and summary
  only.
- A fault stated only in a bullet list inside the post body is missed.

## Automatic signals (phase 3: live in Autopilot)

`GEV_INTEL_CABLES_LIVE=1`, beside `GEV_INTEL_CABLES=1`, sends the shadow
incidents to Autopilot (`src/intel/cableEvents.js`). Without it the feed
stays in shadow mode, as above.

- **What is sent:** a shadow incident, so only one opened by a clear signal
  or an `llm-clear` answer: an operator or regulator about its own cable.
  `llm-unverified` reports, news among them, are never sent.
- **When:** one record each time what an operator would see changes: the
  incident opens, gets a new report, is confirmed cut, or closes on a repair
  notice. Each record is marked as sent in `cables-published.json` (kept
  apart from the shadow state, so a reset of that state cannot lose it)
  after the runner has stored the poll's records; if storing throws, they
  are sent again. A record the runner drops because the incident opened
  more than 90 days ago is marked sent all the same. Each send is logged as
  `sent-to-autopilot`.
- **Switching it on:** incidents already open in the shadow state are sent
  on the first live poll. Look at `cables-shadow-state.json` first if the
  feed ran in shadow mode for long.
- **Repairs:** a repair is sent only for the incident that was shown open.
  A repair of an incident that was never sent sends nothing. If the shadow
  state was lost (a corrupt file moved aside), a repair notice dated after
  the shown incident's last report still closes it.
- **The record:** category `infrastructure_disruption`, subtype
  `submarine_cable_fault`, or `submarine_cable_break` once the source
  confirms a physical break, source type `primary_official`. One event per
  incident: `event_key` `submarine-cable:<cable>:<incident id>`, the id
  fixed when it opened, so an earlier-dated later report does not split
  it. A cable event joins only its own event, never a nearby news item or
  power cut, and the feed's own later records are material updates (a new
  report keeps it on the map, a confirmed cut changes its subtype and
  title). Its marker sits at the middle point of the catalogue line with
  the most points, labelled approximate.
- **On the globe:** the console draws the cable's catalogue route over the
  cable layer, whether that layer is on or not. A resolved event is drawn
  thin and dim for the hour the engine shows it, counted from the repair
  notice's time, so a repair dated at midnight usually archives at once.
- **How it ends:** a repair record (`status_hint` `resolved`) closes the
  event. An open incident's record carries `valid_until` 30 days after its
  last report, so the marker fades as the shadow incident does.

## Automatic signals (phase 4: IODA impact beside a cable event)

`GEV_INTEL_CABLES_IODA=1`, beside `GEV_INTEL_CABLES_LIVE=1`, adds IODA's
country internet outages to the card of a live cable event
(`src/intel/cableImpact.js`). It is off by default: IODA's data is marked
"All Rights Reserved", its software licence is for academic use, and no
data-use terms were found. Ask the IODA team (Georgia Tech) before polling
it regularly.

- **What it asks for:** one request to IODA's outage events for all
  countries, only while a live incident is open, at most every three
  hours, covering up to seven days back. No key is needed. A failed
  request is logged as `ioda-failed` and keeps the last impact.
- **What it shows:** outages in a country where the cable lands that began
  no earlier than a day before the incident opened. Impact is kept per
  incident and only grows while it lasts, so an outage seen once stays on
  the card even after it drops out of IODA's seven-day window; a new
  incident on the cable starts bare. The sentence leads the card's
  summary, qualifier first, and names at most four countries: "Impact only,
  cause unknown: IODA (Georgia Tech) saw internet outages where this cable
  lands, in Pakistan from 2026-11-18." A change is logged as `ioda-impact`
  and sends an updated record. It is shown, but counted as no news: it
  lifts no camera cooldown and starts no re-alert.
- **Landing countries:** each end of each of the cable's catalogue lines,
  matched to the nearest TeleGeography landing point within 0.1°, whose
  country is looked up in Natural Earth (with a few territory names
  added).
- **What it never does:** open, close or change a cable incident, or show
  an outage on its own. Traffic data measures impact in a country; only a
  primary notice names a cable.

## Next integration

A publisher's correction or retraction of a notice is not read yet: it
needs a versioned correction model.
