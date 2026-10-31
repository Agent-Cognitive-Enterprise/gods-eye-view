# Fast Intelligence: gate evaluation

How well the gate tells a report of a current event from everything else a news
account posts. Measured on 31 October 2026 on the seven starter accounts. Repeat it
with `scripts/fast-feeds-eval.mjs`; the post files stay local and are not committed.

## Result

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

**Who scored it.** Claude read and labelled every post. No person has checked the
labels, so treat the figures as one reader's judgement. The definition was: the post
reports a specific event of a kind this system watches, happening now or within about
two days. Earlier documents in this branch said "by hand"; that meant this.

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

37 false positives on the unseen period:

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
about England), a speaker named as if the scene ("Kabul says", "Moscow says"; fixed
after this measurement, so 94.1 % does not include that fix), and a roundup naming a
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
