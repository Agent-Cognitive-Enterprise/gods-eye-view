# CI through a copy repository (host tools)

GitHub refuses to run Actions on this fork ("Actions has been disabled for
this repository", while every setting reads enabled). CI therefore runs in a
public, non-fork copy, `Agent-Cognitive-Enterprise/gods-eye-view-ci`. These
scripts are a snapshot of the copies on the operator's machine, published so
a reviewer can see how the CI evidence on the fork's commits is produced.

## The two workflows

- **Fork Autopilot CI** (`fork-autopilot.yml`, 3 jobs): runs on the commit
  itself when it is pushed to the copy's
  `feature/global-early-warning-autopilot`, or is dispatched.
- **CI** (`ci.yml`, 4 jobs): upstream's workflow has no manual start. It runs
  on a copy-only commit: the commit plus one added `workflow_dispatch:` line
  in `ci.yml`, pushed to the copy's `ci/dispatch` branch and dispatched.

## Scripts

- `ci_copy_run.ps1 -Commit <sha>`: builds the copy-only commit and checks
  every step before anything is pushed. It then force-pushes the commit and
  the copy-only commit to the copy and calls `dispatch.py`. Any failed step
  exits 1, so the copy's branches are never deleted or pointed at a
  half-built commit.
- `dispatch.py <sha> <push time>`: dispatches CI on `ci/dispatch`. It
  dispatches Fork Autopilot CI only if the push did not start a run created
  after the push. A second run on the same branch would cancel the first.
- `mirror_status.py <sha> [--dry-run]`: posts the copy's results on the
  fork's commit as two GitHub commit statuses, `ci-copy / Fork Autopilot CI`
  and `ci-copy / CI`. Each links to its run and is `success` only if every
  job succeeded. A CI run counts only if its commit is the target plus
  exactly that one `ci.yml` line (checked with the compare API) and it was
  dispatched. A commit with no completed run gets nothing.

Runs for two commits must not overlap: they share the copy's branches and
cancel each other.

## Host-specific defaults

The scripts expect the repository checkout at `%USERPROFILE%\gev-autopilot`,
and `git` and `python` on the PATH.
The GitHub token is read from the Windows Credential Manager
(`git credential fill`) at run time and is never stored in these files.
