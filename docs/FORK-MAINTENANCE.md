# Fork maintenance: upstream sync, CI and deployment

How this fork (`Agent-Cognitive-Enterprise/gods-eye-view`) keeps the
early-warning Autopilot while continuing to take every upstream release of
`bilawalsidhu/gods-eye-view`. Feature documentation: [EARLY-WARNING.md](EARLY-WARNING.md);
operator guide: [AUTOPILOT-OPERATOR.md](AUTOPILOT-OPERATOR.md).

## Branch policy

| Branch                                   | Role                                                                                                       | Who writes                           |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `upstream/main`                          | The original project. Fetch only; the push URL is disabled in local clones.                                | Upstream maintainers                 |
| `origin/main`                            | Clean mirror of `upstream/main`, never a fork-only commit. Fast-forwarded by the sync workflow or by hand. | Sync workflow / maintainer (ff only) |
| `feature/global-early-warning-autopilot` | Integration branch: all fork features, upstream merged in through reviewed pull requests.                  | Maintainer, reviewed sync PRs        |
| `release/autopilot`                      | Optional deployable line: fast-forwarded from the integration branch only after Fork Autopilot CI passed.  | Maintainer                           |
| `sync/upstream-<up>-<target>`            | Short-lived merge candidates opened by the sync workflow.                                                  | Sync workflow                        |

Chosen to be the least disruptive to GitHub: `main` stays comparable with
upstream (clean "N commits behind" in the UI, upstream PRs apply as-is), and
the fork's own history lives on its own branches. Nothing is force-pushed;
history is never rewritten.

**GitHub settings this needs (one-time, in the fork's Settings):**

- Actions enabled for the fork.
- Default branch set to `feature/global-early-warning-autopilot` (or
  `release/autopilot` once it exists). GitHub runs _scheduled_ workflows only
  from the default branch, and `main` must not carry fork files. Until this
  is set, run **Upstream sync** manually (Actions tab, _Run workflow_).
- No personal token or secret. The workflow uses only the built-in token,
  whose pushes start no other workflow, so upstream workflow files never run
  in this fork with its secrets. When upstream changes `.github/workflows/`,
  the run opens an issue and that sync is done by hand (manual sync below).

## Where the fork touches upstream code

New files are fork-only (`src/intel/`, `server/providers/intel/`,
`server/providers/localVoice/`, `src/voice/local*.js`, `src/ui/intelConsole.js`,
`src/ui/styles/intel.css`, `src/ui/dockAutoHide.js`, the fork docs and workflows). Upstream files the
fork edits are the merge surface; keep these edits additive and small:

| File                                                                                         | Fork change                                                                |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `server/providers/local.js`                                                                  | Registers the intel and local-voice plugins; shares the GhostMaps watcher. |
| `src/app/tools.js`, `src/standalone/tools.js`                                                | Mounts the Autopilot console and dock auto-hide; offers `local` voice.     |
| `src/ui/templates/layer-panels.html`                                                         | FEEDS panel shell at the end of the left stack.                            |
| `src/ui/leftPanelRail.js`                                                                    | Reads `--left-stack-base-top` (px) before its 26vh default.                |
| `src/ui/templates/context.html`, `style.css`                                                 | Panel shell and stylesheet import.                                         |
| `src/voice/commands.js`, `src/voice/providerCapabilities.js`, `src/voice/sessionCommands.js` | Local voice provider entry and label.                                      |
| `scripts/package-boundaries.json`                                                            | Owned-module entries for the new modules.                                  |
| `src/i18n/locales/*.json`, `src/i18n/same-as-english.json`                                   | Added strings (append-only).                                               |
| `src/data/dataCredits.js`, `DATA_SOURCES.md`, `.env.example`                                 | One credit entry, one source row and note, commented settings.             |

The merge check flags conflicts and both-sides changes in these areas
(`autopilot-hooks`, `voice`, `director`, `camera`, `i18n`, `dependencies`,
`ci`).

## Merge check (local, any time)

```powershell
git fetch upstream
node scripts/upstream-check.mjs                 # report only (git, seconds)
node scripts/upstream-check.mjs --gates quick   # + format, boundaries, Autopilot/voice tests, build
node scripts/upstream-check.mjs --gates full    # + the whole unit suite
```

It merges in a temporary git worktree, so the checkout, its working tree and
any running server are untouched, and removes the worktree afterwards
(`--keep` leaves it for inspection). Exit code 0 clean, 2 conflicts,
3 gate failure. `--json` and `--summary file.md` give machine and Markdown
reports.

## Manual sync

Only with a clean working tree. Keep the printed rollback point.

```powershell
git status --short                      # must be empty
git rev-parse HEAD                      # rollback point
git fetch upstream
node scripts/upstream-check.mjs --gates quick
git switch main
git merge --ff-only upstream/main       # stops if main has diverged: investigate, never force
git push origin main
git switch feature/global-early-warning-autopilot
git merge main                          # resolve conflicts deliberately (see the table above)
npm ci
npm run format:check
npm run check:boundaries
npm test
npm run build
git push origin feature/global-early-warning-autopilot
```

If a conflict appears, note each path and both sides' intent before editing,
prefer upstream's structure and re-apply the fork's small hook, then rerun
every gate. `git merge --abort` returns to the rollback point at any time
before the merge commit.

## Automated sync (`.github/workflows/upstream-sync.yml`)

Weekly (Monday 04:23 UTC) and on demand:

1. **propose** (write token, no upstream code executed): fetches upstream,
   fast-forwards `main` if it has not diverged, runs the git-only merge check,
   then either pushes `sync/upstream-<up>-<target>` and opens a pull request into the
   integration branch, or opens/updates an issue listing the conflicting files
   and their areas, or the upstream workflow files that need a manual sync.
2. **verify** (read-only token, no secrets): runs Fork Autopilot CI on the
   candidate. This is the first point where upstream code executes.
3. **report**: comments the CI result on the pull request.

Merging the pull request is a human decision. Nothing is deployed by any
workflow.

## CI (`.github/workflows/fork-autopilot.yml`)

Runs on pushes and pull requests to the integration and release branches,
manually, and from the sync workflow. Read-only token, pinned actions, no
secrets. Additive to upstream's `ci.yml` (which keeps running unchanged).

| Job                               | What it proves                                                                                                                                                           |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Gates, audit and Autopilot tests  | `npm audit --omit=dev --audit-level=high`, doctor, format, boundaries, the Autopilot/feeds/local AI/voice suites, `npm test`, production build.                          |
| Autopilot browser drill (offline) | Production build served by `vite preview` with `GEV_INTEL_OFFLINE=1`: smoke test and the full Autopilot drill in headless Chrome (A01–A03, A09, A11); evidence uploaded. |
| Windows production smoke          | `windows-latest`: Autopilot/voice suites, production build, `vite preview`, smoke test.                                                                                  |

Offline mode (`GEV_INTEL_OFFLINE=1`) contacts no feed, `GEV_LLM_DISABLED=1`
keeps scoring rule-based, and voice is off, so CI never depends on, or
calls, an outside service.

## Deployment (Windows, explicit)

The local installation is updated only by an operator running
`Deploy-GEV.ps1` from the runtime folder (see the operator guide):

```powershell
.\Deploy-GEV.ps1 -Ref origin/release/autopilot            # CI must be green for that commit
.\Deploy-GEV.ps1 -Ref <commit> -SkipCiCheck               # local-only commit; local gates only
```

It refuses a dirty tree, a detached HEAD or a non-fast-forward; records the
rollback point in `logs\deploy-<instance>-<time>.json`; checks GitHub's
check runs for the exact commit (all three Fork Autopilot CI jobs must have
succeeded); runs `npm ci` if the lockfile changed, the local gates and a
production build; restarts the instance and runs the smoke test. Any failure
after the branch moves resets it to the rollback point and restarts that
version. `Test-GEV.ps1` runs the smoke test on its own.
