# Fast Intelligence: gate evaluation

How well the gate tells a report of a current event from everything else a news
account posts. Measured on the seven starter accounts. Repeat it with
`scripts/fast-feeds-eval.mjs`; the post files stay local and are not committed.

## Current result (2 November 2026)

The 24-hour live test found the gate caught 9 of 27 real events, and missed nearly
every conflict and protest report. Grammar rules were added to fix that: who did what
to what, and stated tolls, rather than more listed words.

| Measure, on an unseen period, scored blind | Before                 | After                  |
| ------------------------------------------ | ---------------------- | ---------------------- |
| **Recall**, per post                       | **22.4 %** (17.5–29.6) | **43.2 %** (33.8–56.6) |
| **Precision**                              | **78.8 %** (72.6–84.9) | **77.8 %** (73.8–81.8) |
| Precision of the posts added               |                        | 75.6 % (70.4–80.8)     |
| Passes a day                               | 10.7                   | 20.9                   |
| Real posts still missed a day, estimated   |                        | 21                     |

**Recall roughly doubled and precision did not measurably change, but 77.8 % is below
the 80 % target, whose interval it only reaches.** `socialCameraEnabled` stays off.
Posts show as provisional claims and move nothing.

The period was harder than the one behind the 84.5 % below: the old gate scored 78.8 %
on it, not 84.5 %. Period, labelling and reader's strictness all differ, so the two
are not directly comparable. Both are one reader's judgement.

**How it was measured.** Rules tuned only on 10 October to 2 November (8,779 posts),
then frozen and recorded by hash. The test period, 20 August to 19 September (11,264
posts), had never been used. From it, 710 posts were drawn in strata: 150 passed by
both gates, 250 passed only by the new one, 300 rejected by both, and all 10 passed
only by the old one. They were shuffled with account, date and decision removed, and
every verdict was written down and hashed before any decision was seen. Intervals are
a stratified bootstrap. Claude wrote the rules and read the posts, so one reader graded
its own work and the rule's shape can sometimes be guessed from the text. No person
has checked these labels.

By account, on sampled passes: Kyiv Independent 89 %, Al Jazeera 83 %, Reuters 76 %,
AP 69 %, ABC 63 %, Bloomberg 58 % of only 12.

**Known defects, left in on purpose.** This test period is now spent, so changing rules
against it would make the figures meaningless. Seen in its false positives, for the
next round, which needs its own unseen period:

- A number inside a compound: "two-time Grammy winner… has died".
- "Injured list" in baseball, and other sport.
- Deaths by illness or old age, and single-victim crime.
- Reaction and blame that name an attack in the main clause.
- Period tallies: "53 killed between…", "7 children a day".

**Still missed.** Real posts with no matching shape: "Thousands flee… renewed fighting",
"police fire tear gas to disperse traders protesting", "emergency declared due to haze",
"Thousands rally outside Portugal's parliament" (the politics test). The headline in a
link card is not read: on the tuning set that would add about 75 passes and lose 13, so
it was left out as a small gain for a change to the Bluesky adapter.

## Earlier result (31 October 2026)

| Measure, on an unseen period, scored blind | Result                                     |
| ------------------------------------------ | ------------------------------------------ |
| **Precision**                              | **84.5 %**, 201 of 238 (95 % CI 79.3–88.5) |
| Estimated recall, per post                 | 29 %: 19 of 300 sampled rejects were real  |
| Place correct, where one was given         | 94.1 %, 128 of 136                         |
| Real reports given any place               | 67.7 %, 136 of 201                         |

The target was 80 %. The estimate clears it and the lower end of the interval sits
just below it. **This does not enable camera control.** Posts stay held from the
camera until `socialCameraEnabled` is deliberately set, after the live run confirms
these figures.

**Who scored it, and how.** Claude read and labelled every post, grading its own
gate, from the first 150 characters with no date, in a single quick pass over 538
posts. No person has checked the labels, so treat these as one reader's judgement. An
independent adversarial review re-read 60 rows and landed around 80–83 %. The
definition was: the post reports a specific event of a kind this system watches,
happening now or within about two days. Earlier documents in this branch said "by
hand"; that meant this.

**How far to trust each number.**

- **Precision** reproduces exactly from the labels with `fast-feeds-eval.mjs score`, and
  the rules were frozen before the sample was drawn. But 18 of the passes are repeated
  "LIVE:" posts about one story, so they are not independent: without them it is
  83.2 %, and the true interval is wider than the one quoted.
- **Recall** rests on 19 positives among 300 sampled rejects. A fair range is 21–39 %.
- **Place accuracy is the weakest figure, and is not reproducible with the script.** It
  was reached by reading the list after the fact and marking 8 wrong, unblinded. At
  least 13 rows it counts as correct are an oblast or region given its city's point;
  counting those as wrong gives about 85 %. So 85–94 %, depending on how strict you are.

### By account

| Account             | Passed | Real | Precision |
| ------------------- | ------ | ---- | --------- |
| kyivindependent.com | 49     | 46   | 94 %      |
| apnews.com          | 29     | 26   | 90 %      |
| reuters.com         | 98     | 84   | 86 %      |
| aljazeera.com       | 28     | 24   | 86 %      |
| news.abc.net.au     | 27     | 17   | 63 %      |
| bloomberg.com       | 7      | 4    | too few   |
| bnonews.com         | 0      | 0    | no posts  |

**BNO News has not posted on Bluesky since 3 May 2026**, so it contributes nothing at
present. All seven accounts verify: each identity document claims its handle, each
domain proves its DID by DNS or HTTPS, and Bluesky marks each verified. Trust stays
`community` for all of them. A verified account is who it says it is, and that says
nothing about whether a given post is right.

### What it still gets wrong

37 false positives on the unseen period, sorted into classes afterwards (the classes
are not stored in the label file):

| Class                       | Count | Example shape                                              |
| --------------------------- | ----- | ---------------------------------------------------------- |
| Follow-up to an older event | 9     | Cause found, search ends, site reopens                     |
| Reaction                    | 9     | "UN alarmed by…", "Philippines voices concern over…"       |
| Analysis                    | 5     | How a war is going, rather than something that happened    |
| Business effect             | 4     | "Oil prices rise as storms and air strikes threaten…"      |
| Legal                       | 3     | A court or execution over an earlier event                 |
| Feature                     | 2     | Survivors' stories                                         |
| Others                      | 5     | Forecast, word sense, a negative test, military discipline |

Follow-ups are the hardest. They use the same words as the report, about the same
event, days later, and the only reliable signal is knowing the event already happened.
That is a job for correlation in the engine, not for the gate.

### What it misses

Low recall is the cost of demanding evidence, and it is per post: a major event is
posted many times, so one missed post is often not a missed event. That has not been
measured here. The misses are mostly attacks phrased without a listed word ("Russian
strikes kill 13"), military moves, and transport incidents.

### Places

The 8 wrong places of 136: a country mentioned for another reason (Iran, in a story
about England), a speaker named as if the scene ("Kabul says", "Moscow says"; a town
followed by "says" is no longer read as the scene, a fix made after this measurement), and a roundup naming a
town the event was not in. Countries and US states give a region, never a point.

## How the figures were reached

This is worth recording, because the first answer was wrong.

| Step | Rules                   | Data                                    | Precision  |
| ---- | ----------------------- | --------------------------------------- | ---------- |
| 1    | As first built          | Open stream, 60 posts                   | 57 %       |
| 2    | As first built          | Seven accounts, tuning weeks, 305 posts | 66.2 %     |
| 3    | Bad-phrase lists added  | The same tuning weeks                   | 88.4 %     |
| 4    | The same                | **Held-out week**, blind, 127 posts     | **66.1 %** |
| 5    | Evidence of an incident | The same week, now seen                 | 86.5 %     |
| 6    | The same                | **Unseen period**, blind, 238 posts     | **84.5 %** |

Step 3 looked like success and was overfitting: lists of phrases learned one week's
phrases. Step 4 caught it, which is why the held-out week existed. The rules then
changed in kind. The opening of a post must now show the event happening, in the terms
that kind of event happens in: a wildfire burns or spreads, an outbreak reports cases.
A topic alone is no longer enough.

The evaluation sets:

| Set        | Period             | Posts | Labelled                       | Use               |
| ---------- | ------------------ | ----- | ------------------------------ | ----------------- |
| Tuning     | 10–24 October      | 5,608 | 390 passed, 120 random rejects | Rules             |
| Held out 1 | 24–31 October      | 2,690 | 127 passed, 200 random rejects | Spent at step 4   |
| Held out 2 | 19 Sept–10 October | 8,060 | 238 passed, 300 random rejects | The figures above |

Held-out posts were shuffled with the gate's decision, topic and place removed, and
each verdict was written down before any decision was shown. The rules were frozen
first, and nothing in the gate changed afterwards. Estimated recall is
`real passes / (real passes + rejected × rate of real posts among sampled rejects)`.

## Limits

- One reader, as above. Disagreement between readers is unmeasured.
- Three weeks, which contained several large stories. A quieter or different period
  may differ.
- English. Russian and Ukrainian posts skip the incident test and are not evaluated
  here; none of the seven accounts posts in them.
- These are large newsrooms. Precision on smaller or informal accounts will be lower:
  it was 57 % on the open stream, before these rules.
