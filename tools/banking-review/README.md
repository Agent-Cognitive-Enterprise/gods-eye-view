# Banking Access daily review (host automation)

These scripts run the daily review of Banking Access news leads on the
review host, outside the app. They are published here so a reviewer can read
the code that produces the reports posted on PR #6. They are a snapshot of
the copies running on the host on 2026-11-11, taken unchanged. Machine-specific
defaults (folders, the `claude` binary, a Desktop note) are listed below.
The live data stays on the host: the operator events file, the decision
ledger, run logs, reports, archived evidence and backups.

## What a run does

`Review-BankingLeads.ps1`, in order:

1. **Fetch** (`fetch-leads.mjs`): reads the app's `/api/banking-access` and
   waits, at most 20 minutes, for a completed GDELT news refresh. Fewer if the
   circuit breaker is open. It writes `leads\<date>.json` with the leads not
   yet decided.
2. **Working copies**: the operator file, the decisions and the bundled
   events are copied into `work\` and backed up. Earlier runs' files from the
   same day are kept: the prompt and transcript are moved to `logs\runs\`,
   and the lead snapshot is copied there.
3. **Review**: headless Claude Code (`claude -p --permission-mode acceptEdits
--allowedTools WebSearch WebFetch Read Glob Grep`) runs `review-prompt.md`
   in `work\`. It has no Write tool, so it can only edit the working copies.
   The run is stopped after 90 minutes.
4. **Validate, then promote** (`validate-events.mjs`): the working copies are
   checked with the app's own loader and the review's rules. A fresh lead
   must be decided today, and no earlier decision may be dropped. Only then
   are the live files replaced, atomically. On any failure nothing is
   applied, and the day's leads come back.
5. **Evidence** (`archive-evidence.mjs`): snapshots of each decided lead's
   page and of event sources, with SHA-256 and HTTP status. Fetches are
   limited to public hosts, checked at connect time with no private or local
   addresses, and capped at 3 MB and 20 s.
6. **Ledger and report**: one line per run in `logs\runs.jsonl`. The status
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
or changed against the copy backed up when it started.

Example ledger line:

```json
{
  "date": "2026-11-11",
  "trigger": "catch-up",
  "status": "COMPLETE",
  "newsStatus": "ok",
  "candidates": 11,
  "fresh": 0,
  "decided": 0,
  "pending": 0,
  "reviewed": true,
  "promoted": true,
  "finishedAt": "2026-11-11T13:02:08"
}
```

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

`prep-eval.mjs` sets it up and
`grade-eval.mjs` grades the critical checks and the decisions. Nothing live
is touched.

## Host-specific defaults

| Where                                               | Default                                                        |
| --------------------------------------------------- | -------------------------------------------------------------- |
| `Review-BankingLeads.ps1 -AppRoot`, `eval -AppRoot` | `C:\Users\user\gev-fast` (the instance on port 4173)           |
| `Review-BankingLeads.ps1 -BaseUrl`                  | `http://127.0.0.1:4173`                                        |
| `Review-BankingLeads.ps1 -Pr`                       | `6`                                                            |
| Claude Code binary                                  | `C:\Users\user\.local\bin\claude.exe`                          |
| Attention note                                      | `D:\Users\user\Desktop\GEV banking review needs attention.txt` |

The GitHub token is never stored in these files: `post_pr_comment.py` reads
it from the Windows Credential Manager (`git credential fill`) at run time.

The review uses Anthropic's cloud API through Claude Code. That is separate
from the Autopilot's optional local model. If an antivirus blocks
`api.anthropic.com`, see the troubleshooting table in
[`docs/AUTOPILOT-OPERATOR.md`](../../docs/AUTOPILOT-OPERATOR.md).
