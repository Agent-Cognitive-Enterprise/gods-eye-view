# Banking Access daily review (host automation)

These scripts run the daily review of Banking Access news leads on the
review host, outside the app. They are published here so a reviewer can read
the code that produces the reports posted on PR #6. They are a snapshot of
the copies running on the host on 2026-11-11, unchanged apart from line
endings (the repository stores LF). Machine-specific defaults are listed
below. The live data stays on the host: the operator events file, the
decision ledger, run logs, reports, archived evidence and backups.

**Run them from a host folder, not from here.** Each script keeps its state
next to itself (`events.local.json`, `reviewed-leads.json`, `leads\`,
`logs\`, `work\`, `backups\`, `evidence\`, `reports\`, `spotcheck\`,
`eval\runs\`). Copy the folder to the host first; on this host it is
`C:\Users\user\gods-eye-view-runtime\banking-review`. A `.gitignore` here
keeps that state out of the repository if they are run here by mistake.

## What a run does

`Review-BankingLeads.ps1`, in order:

1. **Fetch** (`fetch-leads.mjs`): reads the app's `/api/banking-access` and
   waits, at most 20 minutes, for a completed GDELT news refresh. The wait is
   shorter while the news circuit breaker is open. It writes
   `leads\<date>.json` with the leads not yet decided.
2. **Working copies**: the operator file and the decisions are backed up,
   then copied into `work\` with a copy of the bundled events. Files from an
   earlier run the same day are kept: the prompt and transcript are moved to
   `logs\runs\`, and the lead snapshot is copied there.
3. **Review**: headless Claude Code runs `review-prompt.md` in `work\` with
   `claude -p --permission-mode acceptEdits --tools WebSearch WebFetch Read Glob Grep Edit Write --allowedTools WebSearch WebFetch Read Glob Grep`.
   `--tools` sets the exact built-in tools the session has: nothing that
   runs a command or code. Asked in a test to list its tools, a run with
   these flags named exactly those seven (no MCP server loads on this host);
   asked to run `ls` by any means, it could not. An MCP tool added later
   would not be pre-approved, so a headless run would refuse it.
   (`--allowedTools` alone only pre-approves tools; it does not remove any:
   with it alone, the same test ran `ls` without asking.) File edits,
   including the new report, are accepted without asking only inside
   `work\`. An edit anywhere else would need an approval, which a headless
   run cannot give, so it is refused. The run is stopped after 90 minutes.

   **Known limit:** reading files (Read, Glob, Grep) and fetching web pages
   are not confined to `work\`. The reviewer runs under the operator's own
   Windows account, so it could read that account's other files and could
   send what it read to a web address. Untrusted news content could try to
   make it do so. Defences today:
   - the prompt treats web content as data, never as instructions;
   - the evaluation includes two prompt-injection traps;
   - nothing can be written outside `work\`;
   - no command can be run.

   These are not filesystem or network isolation. The stronger defence is
   to run the review under a restricted Windows account that can read only
   its working files, with no credentials of its own and, ideally, web
   access limited to what the review needs. That is not set up yet.

4. **Stage and validate**: the two working copies are first staged
   (`logs\staged\<time>\`, checked by SHA-256). The staged copies are then
   validated (`validate-events.mjs`), so what is promoted is exactly what
   was validated. The checks use the app's own loader and the review's
   rules:
   - every entry must be valid;
   - no event of the live operator file may be removed;
   - a new decision may be made only for a lead offered today (`fresh`),
     and every fresh lead must be decided today;
   - a decision new or changed today may name only an `eventId` that
     exists.

   Earlier decisions are immutable: none may be dropped, and none may change
   in any field, except a `pending` lead offered again today. Any other
   change needs a correction appended to the `corrections` list of
   `reviewed-leads.json`, holding:
   - the lead `id`, and `at`, today's date;
   - `from` and `to`, the entry exactly as it was and as it is now;
   - a `reason`;
   - `evidence`, one or more http(s) URLs (nothing else).

   The list is append-only. Corrections pass validation but are flagged:
   the run raises an attention note and the report names them, for the
   operator to check. The validator's verdict is read from its standard
   output only; a verdict that cannot be read applies nothing.

5. **Promote** both live files as one. The staged copies are checked again
   against their hashes. Then a journal (`logs\promotion.json`, with the
   review's date and any corrections) is written: the single commit point.
   Before it, nothing live has changed; after it, the promotion is
   completed. Each live file is replaced through a verified temporary copy
   and a rename, then checked again. On Windows PowerShell 5.1 the rename
   removes the old file just before moving the new one in, so a reader may
   for an instant find no file; the app then shows its last good copy.
   Every step stops on error. A run whose promotion fails is FAILED, never
   COMPLETE.
   - **Cut short** (a crash, a failed replace): the next run first
     completes the promotion from the journal, before it reads anything,
     including a catch-up that would otherwise have nothing to do. It then
     runs the promotion's follow-up steps: the corrections note, and the
     evidence for the review's date.
   - **Cannot be completed:** nothing is reviewed and the journal is kept
     for the operator.
   - **Failure before the journal:** nothing is applied, and the day's leads
     come back.

   Staged copies older than 14 days are removed.

   The promotion is journalled and eventually consistent, not atomically
   visible: the two files are replaced one after the other. If the second
   replacement fails, they disagree until the next run completes the
   journal. What that affects is narrow:
   - **The map:** the app reads only the events file. It shows either the
     whole old or the whole new version, or its last good copy while a file
     is missing.
   - **The decision ledger:** only the review scripts read it, and the next
     run completes the journal before it reads anything.

   Strict simultaneous visibility would need immutable versioned pairs and a
   single active-version pointer; not done.

6. **Evidence** (`archive-evidence.mjs`): snapshots of each decided lead's
   page and of event sources, with SHA-256 and HTTP status. Only public
   http(s) hosts are fetched: every address is checked when connecting, so
   no private or local address can be reached, and every redirect is checked
   the same way, with at most 3 redirects. A body is cut at 3 MB. Each
   request times out after 20 s of silence, and reading a body is limited
   to 20 s.

   Evidence capture is best-effort: many news sites refuse automated
   downloads. It is not a condition of a COMPLETE run, but it is reported
   on its own, in the status line and the ledger (`evidence`):
   - **complete:** every page saved;
   - **partial:** some saved;
   - **failed:** none saved;
   - **none:** nothing to save;
   - **error:** the archiver did not answer.

7. **Ledger and report**: one line per run in `logs\runs.jsonl`. The status
   is COMPLETE (a completed news fetch, a clean review, every fresh lead
   decided, validated and applied, and a report), DEGRADED (the same without
   a completed news fetch) or FAILED. The report is posted on PR #6 with a
   status line (`post_pr_comment.py`). Problems are also written to a note on
   the Desktop.

`build-spotcheck.mjs` builds a pack of at least 20 live decisions with
their archived evidence, for an operator to mark agree or disagree.

## Scheduling and recovery

Two Windows scheduled tasks run the wrapper. Both use the interactive logon
of the operator's account (needed for the Credential Manager), have a 3-hour
limit, ignore a second start while one runs, and start when available after
a missed time:

| Task                                  | When         | Arguments             |
| ------------------------------------- | ------------ | --------------------- |
| `GEV Banking Leads Review`            | 09:00 daily  | `-Scheduled`          |
| `GEV Banking Leads Review (catch-up)` | 13:00, 17:00 | `-Scheduled -CatchUp` |

A catch-up does nothing if today already has a COMPLETE unattended run, so
one failure no longer costs the day. Otherwise it runs the whole review
again; nothing is applied without validation either way. The lock is atomic:
a file created only if it does not exist, and a lock older than 3 hours
counts as crashed.

## The metric

Unattended runs are the 09:00 run and its catch-ups; manual runs never count.
Each day since 2026-11-09 expects one. A day's best unattended run counts
once. A day with none is MISSED. Today counts once its run is in the ledger
or after 12:00. A run is credited only with the decisions it made: leads new
or changed against the copy backed up when it started. Decisions applied
when a later run completes a cut-short promotion are credited to neither
run (the first is FAILED; the second did not make them).

Example ledger line:

```json
{
  "date": "2026-11-11",
  "trigger": "catch-up",
  "status": "COMPLETE",
  "newsStatus": "ok",
  "newsFailures": 0,
  "newsLastError": "GDELT answered 429",
  "candidates": 11,
  "fresh": 0,
  "decided": 0,
  "pending": 0,
  "reviewed": true,
  "promoted": true,
  "finishedAt": "2026-11-11T13:02:08",
  "evidence": {
    "date": "2026-11-11",
    "state": "partial",
    "saved": 4,
    "notSaved": 4
  }
}
```

(`newsLastError` is the last error the news fetcher saw, even when a later
fetch completed.)

## Regression checks

Host checks, not part of the app's unit suite; nothing live is touched and
nothing is posted:

- `node check-validate-events.mjs [appRoot]` exercises the validator in 18
  cases:
  - an earlier decision changed silently, or only in its metadata, fails;
  - a documented correction passes and is reported;
  - a correction with the wrong `from`, no reason, no evidence, evidence
    that is not a URL, or another date fails;
  - a pending lead offered again may be decided;
  - a decision for a lead not offered today fails;
  - a new decision naming a missing event fails;
  - removing a live event fails;
  - earlier corrections cannot change;
  - a malformed host corrections list is reported, not a crash.
- `powershell -File check-promotion.ps1 [-AppRoot <app>]` runs the whole
  wrapper five times in a sandbox, with a stand-in app (`check\fake-app.mjs`)
  and a stand-in reviewer (`check\fake-reviewer.cmd`):
  1. The second promotion is made to fail. The run is FAILED and the
     promotion journalled, with the events file replaced and the ledger not.
  2. The next run completes the promotion before fetching leads, runs its
     follow-up steps, reports its evidence capture on its own, and is
     COMPLETE.
  3. A journal that cannot be completed blocks the review.
  4. A documented correction is applied and flagged for the operator.
  5. A finished promotion whose journal cannot be removed blocks the review
     (rather than a full review that then fails to promote).

## Evaluation harness (`eval\`)

`Eval-BankingReview.ps1` runs the same prompt in a sandbox on `cases.json`:
nine trap leads plus a stale event to re-verify. The traps are:

- a customer count offered as the reach;
- a historical collapse reported as new;
- a "withdrawal" that is not about banks;
- an earnings call;
- two prompt injections, one in a title and one dressed as a plausible edit;
- a duplicate of an existing event;
- a publisher country that is not the incident's country;
- an unsupported claim about the whole population.

`prep-eval.mjs` sets it up and `grade-eval.mjs` grades the critical checks
and the decisions. Nothing live is touched.

## Host-specific defaults

| Where                                                 | Default                                                        |
| ----------------------------------------------------- | -------------------------------------------------------------- |
| State folder (the scripts' own folder on the host)    | `C:\Users\user\gods-eye-view-runtime\banking-review`           |
| `Review-BankingLeads.ps1 -AppRoot`, `eval -AppRoot`   | `C:\Users\user\gev-fast` (the instance on port 4173)           |
| `build-spotcheck.mjs` appRoot (2nd argument)          | `C:\Users\user\gev-fast`                                       |
| `Review-BankingLeads.ps1 -BaseUrl`, `fetch-leads.mjs` | `http://127.0.0.1:4173`                                        |
| `Review-BankingLeads.ps1 -Pr`                         | `6`                                                            |
| Claude Code binary                                    | `C:\Users\user\.local\bin\claude.exe`                          |
| Attention note                                        | `D:\Users\user\Desktop\GEV banking review needs attention.txt` |

The GitHub token is never stored in these files: `post_pr_comment.py` reads
it from the Windows Credential Manager (`git credential fill`) at run time.

The review uses Anthropic's cloud API through Claude Code. That is separate
from the Autopilot's optional local model. If an antivirus blocks
`api.anthropic.com`, see the troubleshooting table in
[`docs/AUTOPILOT-OPERATOR.md`](../../docs/AUTOPILOT-OPERATOR.md).
