# Data terms: Bluesky, GDELT and ReliefWeb (fork)

What each source's published terms say about how this fork uses it, and where the
code stands. Read on 3 November 2026 from the pages linked below. This is a reading
of the text, not legal advice; check again before a public release.

## Summary

| Source    | What the terms allow                                              | Required of us                                          | Status                                                                 |
| --------- | ----------------------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------- |
| GDELT     | "unlimited and unrestricted use", redistribution in any form       | A citation to the GDELT Project and a link to its site  | Met: the data credit names and links it                                 |
| ReliefWeb | "Anyone may use the ReliefWeb API"                                 | An approved appname; respect the original source's rights | Met: appname per deployment, in `.env`; disasters only, no reports     |
| Bluesky   | Not stated for third parties; authors keep copyright in posts      | A way to delete what a user asks to delete              | Partly met: deleted posts are honoured, account removal is not          |

## GDELT

[About page](https://www.gdeltproject.org/about.html), Terms of Use: "all datasets
released by the GDELT Project are available for unlimited and unrestricted use for
any academic, commercial, or governmental use of any kind without fee", and "You may
redistribute, rehost, republish, and mirror any of the GDELT datasets in any form.
However, any use or redistribution of the data must include a citation to the GDELT
Project and a link to this website."

- The fork credits "GDELT Project" with a link in `src/data/dataCredits.js`, and every
  record carries "The GDELT Project (gdeltproject.org)".
- The terms cover GDELT's datasets, not the news articles they point to. The fork
  stores only GDELT's own fields and the article's address, never article text.
- No warranty is offered, and the data is machine coded; events are labelled
  "Machine-coded news" and never confirm anything.

## ReliefWeb

[API documentation](https://apidoc.reliefweb.int/): "Anyone may use the ReliefWeb
API. Reports, jobs, and training may include material owned by the original source.
Respect those rights when reusing content." and "Every API URL needs a pre-approved
`appname` so ReliefWeb can monitor usage."

- The fork reads `/v2/disasters` only: names, status, country, type and dates, which
  are ReliefWeb's own records. It reads no reports, maps or images, the material owned
  by others.
- The appname is not a secret (it travels in the URL), but it identifies this
  deployment. It lives in `.env` as `GEV_RELIEFWEB_APPNAME`, not in the code. Anyone
  running the fork must request their own.
- No rate limit is published on the page read; the fork polls hourly.
- The terms page (reliefweb.int/terms-conditions) refuses automated readers and was
  not read. An older map permission page asks for the credit "Source: OCHA/ReliefWeb"
  on reused maps, which the fork does not use.
- ReliefWeb asked for "the public URL for this APPNAME data". This deployment has
  none: it runs on a private network. Say so, and give the URL if one is published.

## Bluesky

[Terms of Service](https://bsky.social/about/support/tos) (updated 14 August 2025),
[Community Guidelines](https://bsky.social/about/support/community-guidelines)
(19 September 2025) and the
[Developer Guidelines](https://github.com/bluesky-social/bsky-docs/blob/main/docs/support/developer-guidelines.md).

- Authors "retain ownership" of their posts. The Terms license posts to Bluesky only,
  and say nothing about third parties storing or redistributing them.
- The Developer Guidelines: "All services must have a method for deleting content a
  user has requested to be deleted."
- The Community Guidelines bar removing attribution and sharing personal information,
  including about minors.
- Nothing found on AI processing, datasets, commercial use, Jetstream limits or use
  of the Bluesky name.

Where the fork stands:

- Only the operator's chosen accounts are read: seven news organisations.
- Text is kept short: excerpts of up to 280 characters, shown with the account's name
  and a link to the original post.
- Social-only events are pruned after 14 days.
- A deleted post is honoured: its words are blanked and it stops counting as
  evidence.
- **Gap: account removal is not honoured.** Jetstream's account events (deleted,
  deactivated, taken down) are skipped, so a removed account's excerpts stay until
  the 14-day prune.
- **Gap: there is no manual removal.** Nothing removes a post on request outside the
  stream.
- The local model reads post text to locate and summarise it. Nothing is used for
  training.

## Before a public release

- Honour Jetstream account events, and add a way to remove a post or account on
  request.
- Read ReliefWeb's full terms page in a browser.
- Decide whether a public build may show Bluesky excerpts at all, or only a link to
  the post.
