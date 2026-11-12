# Pushes a commit to the CI copy and starts both workflows on it.
#   ci_copy_run.ps1 -Commit <sha>
# Every step is checked before anything is pushed: a failed step stops the
# script with a non-zero exit, so the copy's branches are never deleted or
# pointed at a half-built commit.
param([Parameter(Mandatory = $true)][string]$Commit)
$copy = 'https://github.com/Agent-Cognitive-Enterprise/gods-eye-view-ci.git'
function Fail($why) { "FAILED: $why"; exit 1 }
# The fork's checkout, relative to the running account.
$repo = Join-Path $env:USERPROFILE 'gev-autopilot'
Set-Location $repo
$full = git rev-parse --verify --quiet "$Commit^{commit}"
if ($LASTEXITCODE -ne 0 -or $full -notmatch '^[0-9a-f]{40}$') { Fail "not a commit: $Commit" }
# CI copy only: ci.yml gains a manual start. Bytes are edited directly: no BOM, no newline change.
$tmpFile = "$env:TEMP\gev-ci.yml"
Remove-Item $tmpFile -ErrorAction SilentlyContinue
python -c "import subprocess,sys; b=subprocess.run(['git','cat-file','blob',sys.argv[1]+':.github/workflows/ci.yml'],capture_output=True,check=True,cwd=sys.argv[3]).stdout; old=b'on:\n  pull_request:\n'; assert b.count(old)==1, 'ci.yml on: block changed'; assert b'workflow_dispatch' not in b, 'ci.yml already has workflow_dispatch'; open(sys.argv[2],'wb').write(b.replace(old,b'on:\n  workflow_dispatch:\n  pull_request:\n'))" $full $tmpFile $repo
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $tmpFile)) { Fail 'could not build the copy-only ci.yml' }
$blob = git hash-object -w $tmpFile
$hashExit = $LASTEXITCODE
Remove-Item $tmpFile
if ($hashExit -ne 0 -or $blob -notmatch '^[0-9a-f]{40}$') { Fail 'hash-object' }
$index = "$env:TEMP\gev-ci-index"
Remove-Item $index -ErrorAction SilentlyContinue
$env:GIT_INDEX_FILE = $index
git read-tree $full; $ok = $LASTEXITCODE -eq 0
if ($ok) { git update-index --cacheinfo "100644,$blob,.github/workflows/ci.yml"; $ok = $LASTEXITCODE -eq 0 }
if ($ok) { $tree = git write-tree; $ok = $LASTEXITCODE -eq 0 -and $tree -match '^[0-9a-f]{40}$' }
Remove-Item Env:GIT_INDEX_FILE
Remove-Item $index -ErrorAction SilentlyContinue
if (-not $ok) { Fail 'could not build the copy-only tree' }
$env:GIT_AUTHOR_NAME = (git config user.name); $env:GIT_AUTHOR_EMAIL = (git config user.email)
$dispatchCommit = git commit-tree $tree -p $full -m "CI copy only: let ci.yml be started by hand"
if ($LASTEXITCODE -ne 0 -or $dispatchCommit -notmatch '^[0-9a-f]{40}$') { Fail 'commit-tree' }
$changed = @(git diff --name-only $full $dispatchCommit)
if ($changed.Count -ne 1 -or $changed[0] -ne '.github/workflows/ci.yml') { Fail "copy-only commit changes: $($changed -join ', ')" }
"diff from $full to the copy-only commit:"
git diff --stat $full $dispatchCommit | ForEach-Object { "  $_" }
# 30 s early: this PC's clock runs a few seconds ahead of GitHub's.
$since = (Get-Date).ToUniversalTime().AddSeconds(-30).ToString('yyyy-MM-ddTHH:mm:ssZ', [cultureinfo]::InvariantCulture)
git push -f $copy "${full}:refs/heads/feature/global-early-warning-autopilot" "${dispatchCommit}:refs/heads/ci/dispatch" 2>&1 | Select-Object -Last 2 | ForEach-Object { "$_" }
"push exit $LASTEXITCODE"
if ($LASTEXITCODE -ne 0) { Fail 'push' }
python "$PSScriptRoot\dispatch.py" $full $since
if ($LASTEXITCODE -ne 0) { Fail 'dispatch' }
