# Daily Banking Access lead review for the live instance.
# 1. Fetch today's news leads, waiting for a completed GDELT refresh.
# 2. Rebuild work\ (the reviewer's only folder) from nothing: it is emptied,
#    so nothing a previous session left there (instructions such as
#    CLAUDE.md, configuration, notes) carries over, then filled with
#    reviewed-leads.json, events.review.json (from the live
#    events.local.json), today's leads and the bundled events. Instruction
#    or memory files the CLI could load from elsewhere stop the run.
#    collect-pages.mjs then fetches the pages the review needs (each lead,
#    the sources of ongoing events) into work\pages\ as bounded text, with
#    the evidence archiver's network guard: the reviewer itself has no tool
#    that reaches the network from this host.
# 3. Headless Claude reviews there (prompt on stdin) in restricted mode
#    ($ReviewerArgs): exactly the tools WebSearch Read Glob Grep Edit Write
#    (--tools); no web fetch, nothing that runs a command; the file tools
#    confined to work\; no user, project or local settings; no MCP servers;
#    writes to settings and tool configuration need an approval a headless
#    run cannot give. Web search runs on Anthropic's side. Afterwards work\
#    must hold only the expected files, the staged pages unchanged:
#    anything else fails the run, is kept in logs\quarantine\ and nothing
#    is applied.
# 4. Validate the working copies with the app's own loader and the review's
#    rules (earlier decisions change only through a documented correction).
#    The copies are staged first and the staged copies validated, so what
#    is promoted is what was validated. Both live files are then replaced
#    one after the other under one journal (logs\promotion.json), written
#    before either is replaced: crash-recoverable, not atomically visible.
#    A promotion cut short is completed by the next run before anything
#    else, with its follow-up steps. On failure before the journal, nothing
#    live changed and the day's leads come back; a run whose promotion did
#    not complete is FAILED.
# 5. The reviewer's report stays private, in reports\ on the host; nothing
#    the reviewer wrote is published automatically. PR #6 gets a status
#    comment written only by this script (fixed words and its own numbers).
# Scheduled by the task "GEV Banking Leads Review" (daily 09:00, Sydney time),
# and by "GEV Banking Leads Review (catch-up)" (13:00 and 17:00, -CatchUp):
# a catch-up runs only when today has no complete unattended run yet (the
# 09:00 run failed, was degraded or never ran), so one failure no longer
# costs the day. Nothing is applied without validation either way.
param(
  # The app checkout of the live instance.
  [string]$AppRoot = (Join-Path $env:USERPROFILE 'gev-fast'),
  [string]$BaseUrl = 'http://127.0.0.1:4173',
  [int]$Pr = 6,
  [switch]$NoPost,
  # Set by the scheduled task: only scheduled runs count towards the
  # acceptance metrics.
  [switch]$Scheduled,
  # Set by the catch-up task: run only if today has no complete unattended
  # run yet. Counts as unattended (trigger "catch-up").
  [switch]$CatchUp,
  # The reviewer binary. Only tests replace it (with a stand-in reviewer).
  [string]$ClaudeExe = (Join-Path $env:USERPROFILE '.local\bin\claude.exe'),
  # Named explicitly: restricted mode ignores the user's settings.
  [string]$Model = 'opus'
)
# It goes into a command line: a plain name only.
if ($Model -notmatch '^[A-Za-z0-9._\[\]-]+$') { throw "unexpected -Model value: $Model" }
# The reviewer's command line (after the binary). check-reviewer-live.ps1
# and the evaluation read this line, so all three run the same flags.
$ReviewerArgs = "-p --restricted --strict-mcp-config --model $Model --permission-mode acceptEdits --tools WebSearch Read Glob Grep Edit Write --allowedTools WebSearch Read Glob Grep --output-format text"
$ErrorActionPreference = 'Continue'
$Dir = $PSScriptRoot
$Work = Join-Path $Dir 'work'
$Date = [System.TimeZoneInfo]::ConvertTimeBySystemTimeZoneId([DateTime]::UtcNow, 'AUS Eastern Standard Time').ToString('yyyy-MM-dd')
$Log = Join-Path $Dir 'logs\review.log'
$Note = Join-Path ([Environment]::GetFolderPath('Desktop')) 'GEV banking review needs attention.txt'
$Utf8 = New-Object System.Text.UTF8Encoding $false
# Text that may hold strings the reviewer wrote (validator messages, file
# names): control characters removed, length capped.
function Clip([string]$text, [int]$max = 600) {
  $t = [regex]::Replace([string]$text, '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\u2028\u2029\p{Cf}]', '?')
  if ($t.Length -gt $max) { $t = $t.Substring(0, $max) + '...' }
  return $t
}
function Say([string]$text) { [System.IO.File]::AppendAllText($Log, ("{0} {1}`r`n" -f (Get-Date -Format s), (Clip $text 4000)), $Utf8) }
# The note on the Desktop is best-effort: security software may refuse a
# script changing a file there (Avast's Ransomware Shield does). The run
# then carries on, the log keeps the message and the posted status says the
# note could not be written, with no text of its own.
$script:NoteFailed = $false
function Attention([string]$text) {
  $t = Clip $text 1500
  Say "ATTENTION: $t"
  try { [System.IO.File]::AppendAllText($Note, ("{0} {1}`r`n" -f (Get-Date -Format s), $t), $Utf8) } catch {
    $script:NoteFailed = $true
    Say "the attention note could not be written: $($_.Exception.Message)"
  }
}

function Get-Sha([string]$file) { (Get-FileHash -Algorithm SHA256 -LiteralPath $file -ErrorAction Stop).Hash }
$Journal = Join-Path $Dir 'logs\promotion.json'

# Empty a folder without following links: a junction or symbolic link inside
# is removed itself, never what it points to.
function Clear-Folder([string]$path, [switch]$Inner) {
  # The folder itself must not be a link (its target would be emptied).
  if (-not $Inner -and ([System.IO.File]::GetAttributes($path) -band [System.IO.FileAttributes]::ReparsePoint)) { throw "$path is a link; not emptied" }
  foreach ($e in [System.IO.Directory]::EnumerateFileSystemEntries($path)) {
    $a = [System.IO.File]::GetAttributes($e)
    if ($a -band [System.IO.FileAttributes]::ReadOnly) { [System.IO.File]::SetAttributes($e, ($a -band -bnot [System.IO.FileAttributes]::ReadOnly)) }
    if ($a -band [System.IO.FileAttributes]::ReparsePoint) {
      if ($a -band [System.IO.FileAttributes]::Directory) { [System.IO.Directory]::Delete($e, $false) } else { [System.IO.File]::Delete($e) }
    } elseif ($a -band [System.IO.FileAttributes]::Directory) {
      Clear-Folder $e -Inner
      [System.IO.Directory]::Delete($e, $false)
    } else { [System.IO.File]::Delete($e) }
  }
}
# Every entry under work\, relative, without following links.
function Get-WorkEntries {
  $root = $Work.TrimEnd('\') + '\'
  $list = New-Object System.Collections.Generic.List[object]
  $stack = New-Object System.Collections.Generic.Stack[string]
  $stack.Push($Work)
  while ($stack.Count) {
    $d = $stack.Pop()
    foreach ($e in [System.IO.Directory]::EnumerateFileSystemEntries($d)) {
      $a = [System.IO.File]::GetAttributes($e)
      $item = [pscustomobject]@{ rel = $e.Substring($root.Length); full = $e
        dir = [bool]($a -band [System.IO.FileAttributes]::Directory); link = [bool]($a -band [System.IO.FileAttributes]::ReparsePoint) }
      $list.Add($item)
      if ($item.dir -and -not $item.link) { $stack.Push($e) }
    }
  }
  return ,$list
}
# What work\ may hold: the inputs, and after the review today's report.
# Returns the entries that are not expected (links are never expected).
function Get-UnexpectedWork([switch]$AfterReview) {
  $expected = @('leads', 'reports', 'pages', 'events.review.json', 'reviewed-leads.json', 'bundled-events.json', "leads\$Date.json", 'pages\index.json')
  if ($AfterReview) { $expected += "reports\$Date.md" }
  $entries = Get-WorkEntries
  # Staged pages are pages\NN.txt (their content is checked separately).
  return @($entries | Where-Object { $_.link -or -not (($expected -contains $_.rel) -or $_.rel -match '^pages\\\d{2,3}\.txt$') -or ($_.dir -ne ($_.rel -in 'leads', 'reports', 'pages')) })
}
# Instructions Claude Code could load from outside work\: CLAUDE.md files in
# every folder above it, the user-level and managed instruction files and
# rules. None should exist; if any does, nothing is reviewed (the operator
# decides). Restricted mode is not documented to skip them.
function Get-InstructionFiles {
  $found = New-Object System.Collections.Generic.List[string]
  $dirs = New-Object System.Collections.Generic.List[string]
  $d = Split-Path $Work -Parent
  while ($d) { $dirs.Add($d); $p = Split-Path $d -Parent; if ($p -eq $d) { break }; $d = $p }
  foreach ($d in $dirs) {
    foreach ($n in 'CLAUDE.md', 'CLAUDE.local.md', '.claude\CLAUDE.md', '.claude\CLAUDE.local.md') {
      $q = Join-Path $d $n
      if (Test-Path -LiteralPath $q) { $found.Add($q) }
    }
    $rules = Join-Path $d '.claude\rules'
    if (Test-Path -LiteralPath $rules) { $found.Add($rules) }
  }
  foreach ($q in @((Join-Path $ClaudeHome 'CLAUDE.md'), (Join-Path $ClaudeHome 'rules'),
      (Join-Path $env:ProgramData 'ClaudeCode\CLAUDE.md'), (Join-Path $env:ProgramFiles 'ClaudeCode\CLAUDE.md'))) {
    if ((Test-Path -LiteralPath $q) -and -not $found.Contains($q)) { $found.Add($q) }
  }
  return ,$found
}
# The reviewer's auto-memory folder. Claude Code keeps one per project,
# named after the working folder (or the git root, inside a checkout: the
# run refuses to start there, see Test-InGitCheckout). It must be empty when
# a review starts and when it ends.
$ClaudeHome = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $env:USERPROFILE '.claude' }
$MemoryDir = Join-Path $ClaudeHome ('projects\' + ($Work -replace '[^A-Za-z0-9]', '-') + '\memory')
function Test-InGitCheckout {
  $d = $Dir
  while ($d) {
    if (Test-Path -LiteralPath (Join-Path $d '.git')) { return $true }
    $p = Split-Path $d -Parent
    if ($p -eq $d) { break }
    $d = $p
  }
  return $false
}
function Get-MemoryFiles {
  if (-not (Test-Path -LiteralPath $MemoryDir)) { return ,@() }
  return ,@(Get-ChildItem -LiteralPath $MemoryDir -Recurse -Force -File -ErrorAction Stop | ForEach-Object { $_.FullName })
}
# Keep unexpected files for the operator (copies, size-capped; links are
# recorded, not followed), outside work\.
function Save-Quarantine([object[]]$items) {
  $q = Join-Path $Dir ('logs\quarantine\' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
  New-Item -ItemType Directory -Force $q | Out-Null
  $index = foreach ($i in ($items | Select-Object -First 200)) {
    $kind = if ($i.link) { 'link' } elseif ($i.dir) { 'folder' } else { 'file' }
    if ($kind -eq 'file' -and -not (Test-Path -LiteralPath $i.full)) { "missing`t-`t$($i.rel)"; continue }
    if ($kind -eq 'file') {
      $len = (New-Object System.IO.FileInfo $i.full).Length
      if ($len -le 1MB) { Copy-Item -LiteralPath $i.full -Destination (Join-Path $q (($i.rel -replace '[\\/:*?"<>|]', '_') + '.quarantined')) -ErrorAction SilentlyContinue }
      "$kind`t$len`t$($i.rel)"
    } else { "$kind`t-`t$($i.rel)" }
  }
  [System.IO.File]::WriteAllLines((Join-Path $q 'index.tsv'), [string[]]@($index), $Utf8)
  return $q
}

# Finish the journalled promotion: each staged file replaces its live file
# through a verified temporary copy and a rename, then is checked again. The
# rename replaces the file in place (on Windows PowerShell 5.1 the old file
# is removed just before the move, so a reader may for an instant find no
# file; the app then shows its last good copy). A file already in place is
# left alone, so finishing is safe to repeat. Throws on any failure. Once
# every live file matches, the journal is removed; if that alone fails, the
# promotion still counts as done and the next run removes the journal.
# Returns the journal (date, corrections) for the follow-up steps.
function Complete-Promotion {
  $j = Get-Content -LiteralPath $Journal -Raw -Encoding utf8 -ErrorAction Stop | ConvertFrom-Json
  if (-not $j.files -or @($j.files).Count -lt 1) { throw 'the promotion journal lists no files' }
  # Its date goes into the public status and into evidence paths: a date only.
  if ([string]$j.date -notmatch '^\d{4}-\d{2}-\d{2}$') { throw 'the promotion journal has no valid date' }
  foreach ($f in @($j.files)) {
    if ((Test-Path -LiteralPath $f.to) -and (Get-Sha $f.to) -eq $f.sha256) { continue }
    if (-not (Test-Path -LiteralPath $f.staged)) { throw "staged copy missing: $($f.staged)" }
    if ((Get-Sha $f.staged) -ne $f.sha256) { throw "staged copy changed: $($f.staged)" }
    $tmp = "$($f.to).tmp"
    Copy-Item -LiteralPath $f.staged -Destination $tmp -Force -ErrorAction Stop
    if ((Get-Sha $tmp) -ne $f.sha256) { throw "temporary copy for $($f.to) does not match" }
    Move-Item -LiteralPath $tmp -Destination $f.to -Force -ErrorAction Stop
    if ((Get-Sha $f.to) -ne $f.sha256) { throw "$($f.to) does not match after replacing" }
  }
  try { Remove-Item -LiteralPath $Journal -ErrorAction Stop }
  catch { Say "the promotion is complete, but its journal could not be removed: $($_.Exception.Message)" }
  return $j
}

# Stage the working copies for one journalled promotion: copied to logs\staged\<time>\
# and checked by hash. Returns the staged files, in order. Nothing live
# changes here.
function Stage-Together([object[]]$pairs) {
  if (Test-Path -LiteralPath $Journal) { throw 'an earlier promotion is still journalled' }
  $stage = Join-Path $Dir ('logs\staged\' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
  New-Item -ItemType Directory -Force $stage -ErrorAction Stop | Out-Null
  return ,@(foreach ($pair in $pairs) {
    $staged = Join-Path $stage (Split-Path $pair.to -Leaf)
    Copy-Item -LiteralPath $pair.from -Destination $staged -Force -ErrorAction Stop
    $sha = Get-Sha $staged
    if ($sha -ne (Get-Sha $pair.from)) { throw "staging $($pair.from) failed" }
    [pscustomobject]@{ staged = $staged; to = $pair.to; sha256 = $sha }
  })
}

# Commit staged files: check they are unchanged since staging (and so since
# validation), write the journal (the single commit point: before it
# nothing live has changed, after it the promotion is completed, now or by
# the next run), then complete it.
function Commit-Together([object[]]$files, [string]$date, [string[]]$corrections) {
  foreach ($f in $files) { if ((Get-Sha $f.staged) -ne $f.sha256) { throw "staged copy changed after validation: $($f.staged)" } }
  $tmp = "$Journal.tmp"
  $doc = [ordered]@{ startedAt = (Get-Date -Format s); date = $date; corrections = @($corrections); files = @($files) }
  [System.IO.File]::WriteAllText($tmp, ($doc | ConvertTo-Json -Depth 4), $Utf8)
  Move-Item -LiteralPath $tmp -Destination $Journal -Force -ErrorAction Stop
  return Complete-Promotion
}

# After a promotion, in the run that completed it (the same run or the
# next): corrections are flagged for the operator, and the evidence for the
# review's date is archived. Evidence capture is best-effort, not a
# condition of a COMPLETE run, but its outcome is reported on its own:
# complete (every page saved), partial, failed (none saved), none (nothing
# to save) or error (the archiver did not answer). Returns that outcome.
function Complete-Followups($j, $notes) {
  try { return Run-Followups $j $notes }
  catch {
    Say "a follow-up step of the promotion failed (the promotion itself is done): $($_.Exception.Message)"
    return [pscustomobject]@{ date = $j.date; state = 'error'; saved = $null; notSaved = $null }
  }
}
function Run-Followups($j, $notes) {
  $corrected = @($j.corrections | Where-Object { $_ })
  if ($corrected.Count) {
    Attention "earlier decisions corrected ($($j.date)), please check: $($corrected -join ', ')"
    # Published as a count only: lead ids hold addresses GitHub would link.
    $notes.Add("**$($corrected.Count) earlier decision(s) corrected on $($j.date), for the operator to check.** Each correction (reason and evidence) is in reviewed-leads.json on the host.")
  }
  $outcome = [pscustomobject]@{ date = $j.date; state = 'none'; saved = 0; notSaved = 0 }
  if ($j.date) {
    $archive = (& node (Join-Path $Dir 'archive-evidence.mjs') $j.date 2>&1 | Out-String).Trim()
    $archiveExit = $LASTEXITCODE
    Say "evidence ($($j.date)): $archive"
    $counts = $null
    try { $counts = ($archive -split "`n" | Select-Object -Last 1) | ConvertFrom-Json } catch {}
    if ($archiveExit -ne 0 -or -not $counts -or $null -eq $counts.archived) { $outcome.state = 'error'; $outcome.saved = $null; $outcome.notSaved = $null }
    else {
      $outcome.saved = [int]$counts.archived
      $outcome.notSaved = [int]$counts.failed
      $outcome.state = if ($outcome.saved + $outcome.notSaved -eq 0) { 'none' }
        elseif ($outcome.notSaved -eq 0) { 'complete' }
        elseif ($outcome.saved -eq 0) { 'failed' } else { 'partial' }
    }
  }
  return $outcome
}

New-Item -ItemType Directory -Force (Join-Path $Dir 'logs'), (Join-Path $Dir 'reports'), (Join-Path $Dir 'backups'), (Join-Path $Work 'reports'), (Join-Path $Work 'leads') | Out-Null

function Read-Ledger([switch]$Quiet) {
  $list = New-Object System.Collections.Generic.List[object]
  $file = Join-Path $Dir 'logs\runs.jsonl'
  if (-not (Test-Path $file)) { return ,$list }
  foreach ($line in (Get-Content $file -Encoding utf8)) {
    if (-not $line.Trim()) { continue }
    try { $list.Add(($line | ConvertFrom-Json)) } catch {
      $why = "skipped a bad line in logs\runs.jsonl: $($line.Substring(0, [Math]::Min(80, $line.Length)))"
      if ($Quiet) { Say $why } else { Attention $why }
    }
  }
  return ,$list
}
# Unattended runs: the 09:00 run and its catch-ups. Manual runs never count.
$Unattended = @('scheduled', 'catch-up')
if ($CatchUp) {
  $all = Read-Ledger -Quiet
  $today = @($all | Where-Object { $Unattended -contains $_.trigger -and $_.date -eq $Date })
  $done = @($today | Where-Object { $_.status -eq 'COMPLETE' })
  if ($done.Count -and -not (Test-Path -LiteralPath $Journal)) { Say "catch-up: today already has a complete run; nothing to do"; exit 0 }
  # The 09:00 run may still be going (its limit is 3 h): the lock below
  # then makes this run exit rather than overlap.
  Say "catch-up: today's unattended runs so far: $(if ($today.Count) { ($today | ForEach-Object { $_.status }) -join ', ' } else { 'none' })"
}

# One run at a time; a lock older than 3 h is a crashed run.
$Lock = Join-Path $Dir 'logs\review.lock'
if ((Test-Path $Lock) -and ((Get-Item $Lock).LastWriteTime -le (Get-Date).AddHours(-3))) {
  Say "removing a lock older than 3 h (a crashed run)"
  Remove-Item $Lock -ErrorAction SilentlyContinue
}
try {
  $lockStream = [System.IO.File]::Open($Lock, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
  $pidBytes = [System.Text.Encoding]::ASCII.GetBytes([string]$PID)
  $lockStream.Write($pidBytes, 0, $pidBytes.Length)
  $lockStream.Close()
} catch {
  Say "another run holds the lock; exiting"
  exit 0
}
$ledgerWritten = $false
try {
  Say "start $Date"
  $runStart = Get-Date
  $evidence = $null
  $notes = New-Object System.Collections.Generic.List[string]

  # A promotion cut short earlier (a crash, a failed replace) is completed
  # first, from its journal, before anything reads the live files. If it
  # cannot be, nothing is reviewed: the live files may disagree.
  $blocked = $false
  if (Test-Path -LiteralPath $Journal) {
    $recovered = $null
    try {
      $recovered = Complete-Promotion
    } catch {
      $blocked = $true
      Attention "an interrupted promotion could not be completed ($Date): $($_.Exception.Message). Nothing was reviewed; fix it (logs\promotion.json), then run again."
      $notes.Add('**An earlier promotion that had been cut short could not be completed; nothing was reviewed.** The details are on the host for the operator.')
    }
    if ($recovered) {
      Say 'completed an interrupted promotion from logs\promotion.json'
      $notes.Add("An earlier promotion (review of $($recovered.date)) had not finished; it was completed from its journal before this run.")
      $evidence = Complete-Followups $recovered $notes
      # The live files are in place, but a journal that cannot be removed
      # would make this run's own promotion fail after a full review.
      if (Test-Path -LiteralPath $Journal) {
        $blocked = $true
        Attention "the promotion journal (logs\promotion.json) could not be removed ($Date); the live files are complete. Nothing was reviewed; remove it, then run again."
        $notes.Add('**The promotion journal could not be removed** (the live files are complete); nothing was reviewed.')
      }
    }
  }

  # Staged copies older than 14 days go (never while a journal exists).
  if (-not (Test-Path -LiteralPath $Journal)) {
    Get-ChildItem (Join-Path $Dir 'logs\staged') -Directory -ErrorAction SilentlyContinue |
      Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-14) } |
      Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
  }

  # An earlier run today keeps its evidence: its prompt and transcript are
  # moved, and its lead snapshot copied, to logs\runs\ with its time.
  $runsDir = Join-Path $Dir 'logs\runs'
  New-Item -ItemType Directory -Force $runsDir | Out-Null
  foreach ($kept in @(
      @{ path = (Join-Path $Dir "logs\prompt-$Date.txt"); name = "prompt-$Date"; ext = 'txt'; move = $true },
      @{ path = (Join-Path $Dir "logs\claude-$Date.txt"); name = "claude-$Date"; ext = 'txt'; move = $true },
      @{ path = (Join-Path $Dir "leads\$Date.json"); name = "leads-$Date"; ext = 'json'; move = $false })) {
    if (-not (Test-Path $kept.path)) { continue }
    $when = (Get-Item $kept.path).LastWriteTime.ToString('HHmmss')
    $dest = Join-Path $runsDir ("{0}-{1}.{2}" -f $kept.name, $when, $kept.ext)
    if (Test-Path $dest) { continue }
    if ($kept.move) { Move-Item $kept.path $dest } else { Copy-Item $kept.path $dest }
    Say "kept the earlier run's $(Split-Path $kept.path -Leaf) as logs\runs\$(Split-Path $dest -Leaf)"
  }

  # 1. Leads (waits for a completed refresh).
  if ($blocked) {
    $fetch = 'not run: an interrupted promotion could not be completed'
    $fetchExit = 3
  } else {
    $fetch = (& node (Join-Path $Dir 'fetch-leads.mjs') $Date $BaseUrl 2>&1 | Out-String).Trim()
    $fetchExit = $LASTEXITCODE
  }
  Say "fetch ($fetchExit): $fetch"
  $leadsFile = Join-Path $Dir "leads\$Date.json"

  # A report already made today is kept, not reposted.
  $hostReport = Join-Path $Dir "reports\$Date.md"
  if (Test-Path $hostReport) { Move-Item $hostReport (Join-Path $Dir ("reports\$Date-earlier-{0}.md" -f (Get-Date -Format HHmmss))) -Force }

  # 2. Working copies, in a work\ folder rebuilt from nothing. Anything left
  #    there (by an earlier session, or planted) is removed first; if work\
  #    still holds anything else afterwards, nothing is reviewed.
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  Copy-Item (Join-Path $Dir 'events.local.json') (Join-Path $Dir "backups\events.local.$stamp.json")
  Copy-Item (Join-Path $Dir 'reviewed-leads.json') (Join-Path $Dir "backups\reviewed-leads.$stamp.json")
  $workReady = $false
  $pagesInfo = $null
  $pageHashes = @{}
  try {
    if (Test-InGitCheckout) { throw 'the state folder is inside a git checkout, so the reviewer''s memory folder cannot be located reliably; run it from a host folder' }
    # Instructions outside work\ that the CLI could load: never expected.
    $instr = Get-InstructionFiles
    if ($instr.Count) { throw "instruction files outside work\ that Claude Code could load: $($instr -join ', ')" }
    # The reviewer's auto-memory: kept for the operator, then emptied.
    $mem = Get-MemoryFiles
    if ($mem.Count) {
      $q = Join-Path $Dir ('logs\quarantine\' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-memory')
      New-Item -ItemType Directory -Force $q | Out-Null
      foreach ($m in ($mem | Select-Object -First 200)) { if ((New-Object System.IO.FileInfo $m).Length -le 1MB) { Copy-Item -LiteralPath $m -Destination (Join-Path $q (((Split-Path $m -Leaf) -replace '[\\/:*?"<>|]', '_') + '.quarantined')) -ErrorAction SilentlyContinue } }
      Clear-Folder $MemoryDir
      Attention "the reviewer's memory folder held $($mem.Count) files before the review ($Date); kept in $q, then removed"
    }
    $memLeft = Get-MemoryFiles
    if ($memLeft.Count) { throw "the reviewer's memory folder could not be emptied" }
    $leftover = @(Get-UnexpectedWork -AfterReview)
    if ($leftover.Count) {
      $q = Save-Quarantine $leftover
      # Usually what a failed run left; anything else means someone else
      # wrote there.
      Attention "work\ held $($leftover.Count) unexpected entries before the review ($Date): $(($leftover | Select-Object -First 10 | ForEach-Object { $_.rel }) -join ', '); kept in $q, then removed"
    }
    Clear-Folder $Work
    New-Item -ItemType Directory -Force (Join-Path $Work 'reports'), (Join-Path $Work 'leads') -ErrorAction Stop | Out-Null
    Copy-Item (Join-Path $Dir 'events.local.json') (Join-Path $Work 'events.review.json') -Force -ErrorAction Stop
    Copy-Item (Join-Path $Dir 'reviewed-leads.json') (Join-Path $Work 'reviewed-leads.json') -Force -ErrorAction Stop
    Copy-Item (Join-Path $AppRoot 'server\providers\bankingAccess\events.json') (Join-Path $Work 'bundled-events.json') -Force -ErrorAction Stop
    if (Test-Path $leadsFile) { Copy-Item $leadsFile (Join-Path $Work "leads\$Date.json") -Force -ErrorAction Stop }
    # The pages the review needs, fetched by this script (the reviewer has
    # no fetch tool): each fresh lead and the sources of ongoing events.
    $pagesDir = Join-Path $Work 'pages'
    if ($fetchExit -eq 0 -and (Test-Path $leadsFile)) {
      # Run with a time limit (each page also has its own deadline), so a
      # slow or hostile site cannot hold the run.
      $collectOut = Join-Path $Dir 'logs\collect-out.txt'
      $collectArgs = '"{0}" --out "{1}" --leads "{2}" --events "{3}" --events "{4}"' -f (Join-Path $Dir 'collect-pages.mjs'), $pagesDir, $leadsFile, (Join-Path $Dir 'events.local.json'), (Join-Path $AppRoot 'server\providers\bankingAccess\events.json')
      $cp = Start-Process -FilePath 'node' -ArgumentList $collectArgs -NoNewWindow -PassThru -RedirectStandardOutput $collectOut -RedirectStandardError (Join-Path $Dir 'logs\collect-stderr.txt')
      $null = $cp.Handle
      if (-not $cp.WaitForExit(15 * 60 * 1000)) { & taskkill.exe /T /F /PID $cp.Id | Out-Null; throw 'the page collector did not finish within 15 minutes and was stopped' }
      $collectExit = $cp.ExitCode
      $collect = if (Test-Path -LiteralPath $collectOut) { ([System.IO.File]::ReadAllText($collectOut)).Trim() } else { '' }
      Say "pages ($collectExit): $collect"
      if ($collectExit -ne 0) { throw "the page collector failed (exit $collectExit); see logs\collect-stderr.txt" }
      try { $pagesInfo = ($collect -split "`n" | Select-Object -Last 1) | ConvertFrom-Json } catch { throw 'the page collector gave no clear answer' }
    } else {
      New-Item -ItemType Directory -Force $pagesDir | Out-Null
      [System.IO.File]::WriteAllText((Join-Path $pagesDir 'index.json'), "[]`n", $Utf8)
    }
    # What was staged, by hash: the reviewer must leave it unchanged.
    $pageHashes = @{}
    foreach ($p in Get-ChildItem -LiteralPath $pagesDir -File -Force) { $pageHashes[$p.Name] = Get-Sha $p.FullName }
    $notClean = @(Get-UnexpectedWork)
    if ($notClean.Count) { throw "work\ still holds $($notClean.Count) unexpected entries after it was emptied" }
    $workReady = $true
  } catch {
    Attention "the reviewer's folder could not be prepared ($Date): $($_.Exception.Message). Nothing was reviewed."
    $notes.Add("**The reviewer's working folder could not be prepared; nothing was reviewed.**")
  }

  # 3. Review.
  $reviewed = $false
  $workClean = $false
  if ($workReady -and $fetchExit -eq 0 -and (Test-Path $leadsFile)) {
    $promptFile = Join-Path $Dir "logs\prompt-$Date.txt"
    $out = Join-Path $Dir "logs\claude-$Date.txt"
    $text = [System.IO.File]::ReadAllText((Join-Path $Dir 'review-prompt.md'), $Utf8).Replace('{DATE}', $Date)
    [System.IO.File]::WriteAllText($promptFile, $text, $Utf8)
    $claude = $ClaudeExe
    $cmd = "`"$claude`" $ReviewerArgs < `"$promptFile`" > `"$out`" 2>&1"
    $proc = Start-Process -FilePath 'cmd.exe' -ArgumentList '/d', '/s', '/c', "`"$cmd`"" -WorkingDirectory $Work -WindowStyle Hidden -PassThru
    if (-not $proc.WaitForExit(90 * 60 * 1000)) {
      & taskkill.exe /T /F /PID $proc.Id | Out-Null
      Attention "review timed out after 90 min and was stopped ($Date)"
      $notes.Add('**The review timed out after 90 minutes and was stopped; its edits were not applied.**')
    } else {
      Say "claude exit $($proc.ExitCode); transcript $out"
      # Only a clean exit counts as a review.
      $reviewed = ($proc.ExitCode -eq 0)
      if (-not $reviewed) { $notes.Add("**The reviewer exited with code $($proc.ExitCode); its edits were not applied.**") }
    }
    # The reviewer may write only its working copies and today's report.
    # Anything else (instructions, configuration, notes, links) fails the
    # run: kept for the operator, and nothing from the run is applied.
    try {
      $extra = @(Get-UnexpectedWork -AfterReview)
      # Memory or instruction files written outside work\ during the review
      # count as unexpected too.
      $memAfter = Get-MemoryFiles
      $instrAfter = Get-InstructionFiles
      foreach ($m in $memAfter) { $extra += [pscustomobject]@{ rel = "(memory) $(Split-Path $m -Leaf)"; full = $m; dir = $false; link = $false } }
      foreach ($m in $instrAfter) { $extra += [pscustomobject]@{ rel = "(instructions) $m"; full = $m; dir = (Test-Path -LiteralPath $m -PathType Container); link = $false } }
      # The staged pages must be exactly as the collector wrote them.
      $pagesNow = @{}
      foreach ($p in Get-ChildItem -LiteralPath (Join-Path $Work 'pages') -File -Force -ErrorAction SilentlyContinue) { $pagesNow[$p.Name] = Get-Sha $p.FullName }
      foreach ($k in @($pageHashes.Keys) + @($pagesNow.Keys) | Select-Object -Unique) {
        if ($pageHashes[$k] -ne $pagesNow[$k]) { $extra += [pscustomobject]@{ rel = "pages\$k (changed, added or removed)"; full = (Join-Path $Work "pages\$k"); dir = $false; link = $false } }
      }
      if ($extra.Count) {
        $q = Save-Quarantine $extra
        Attention "the reviewer left $($extra.Count) unexpected entries in its folder ($Date): $(($extra | Select-Object -First 10 | ForEach-Object { $_.rel }) -join ', '); kept in $q. Nothing from this run was applied."
        $notes.Add("**The reviewer left $($extra.Count) unexpected files in its working folder; nothing from this run was applied.** They are kept on the host for the operator.")
      } else { $workClean = $true }
    } catch {
      Attention "the reviewer's folder could not be checked ($Date): $($_.Exception.Message). Nothing from this run was applied."
      $notes.Add("**The reviewer's working folder could not be checked; nothing from this run was applied.**")
    }
  } elseif (-not $blocked -and $workReady) {
    Attention "lead fetch failed ($Date): $fetch"
  }

  # 4. Stage, validate the staged copies, then promote them.
  $promoted = $false
  $reportWritten = Test-Path -LiteralPath (Join-Path $Work "reports\$Date.md") -PathType Leaf
  if ($reviewed -and $workClean -and -not $reportWritten) { $notes.Add('**The reviewer wrote no report; its edits were not applied.**') }
  if ($reviewed -and $workClean -and $reportWritten) {
    $staged = $null
    try {
      $staged = Stage-Together @(
        @{ from = (Join-Path $Work 'events.review.json'); to = (Join-Path $Dir 'events.local.json') },
        @{ from = (Join-Path $Work 'reviewed-leads.json'); to = (Join-Path $Dir 'reviewed-leads.json') })
    } catch {
      Attention "staging the review's edits failed ($Date): $($_.Exception.Message); nothing live was changed"
      $notes.Add("**Staging the review's edits failed; nothing live was changed.** This run is not complete.")
    }
    if ($staged) {
      # The validator's answer is its stdout; its stderr goes to a log.
      $valErr = Join-Path $Dir 'logs\validate-stderr.txt'
      $check = (& node (Join-Path $Dir 'validate-events.mjs') $AppRoot $staged[0].staged $staged[1].staged (Join-Path $Dir 'reviewed-leads.json') $leadsFile (Join-Path $Dir 'events.local.json') 2> $valErr | Out-String).Trim()
      $valExit = $LASTEXITCODE
      $verdict = $null
      try { $verdict = $check | ConvertFrom-Json } catch {}
      if ($valExit -eq 0 -and $verdict -and $null -ne $verdict.corrections) {
        $committed = $null
        try {
          $committed = Commit-Together $staged $Date @($verdict.corrections)
          $promoted = $true
          Say "promoted: $check"
        } catch {
          $why = $_.Exception.Message
          $next = if (Test-Path -LiteralPath $Journal) { 'it is journalled, and the next run completes it before anything else' } else { 'nothing live was changed' }
          Attention "promoting the review's edits failed ($Date): $why; $next"
          $notes.Add("**Promoting the validated edits failed;** $(if (Test-Path -LiteralPath $Journal) { 'it is journalled, and the next run completes it before anything else' } else { 'nothing live was changed' }). This run is not complete.")
        }
        if ($committed) { $evidence = Complete-Followups $committed $notes }
      } elseif ($valExit -eq 0) {
        Attention "the validator's answer could not be read ($Date), so nothing was applied: $check"
        $notes.Add("**The validator's answer could not be read, so nothing was applied.**")
      } else {
        $shown = if ($check) { $check } else { 'the validator gave no answer; its error is in logs\validate-stderr.txt' }
        Attention "the review's edits failed validation and were not applied ($Date): $shown"
        # The problems name what the reviewer wrote: published only as a
        # count.
        $count = if ($verdict -and $verdict.problems) { @($verdict.problems).Count } else { '?' }
        $notes.Add("**The review's edits failed validation ($count problems) and were not applied** (the day's leads will be reviewed again). The details are on the host for the operator.")
      }
    }
  }

  # 5. Classify the run and record it in the ledger.
  #    COMPLETE: a completed news fetch, a clean review exit, only the
  #    expected files left in work\, every fresh lead decided today, the
  #    edits validated and applied, and a report written. DEGRADED: the same
  #    but without a completed news fetch (the feed was degraded: not a quiet
  #    day). FAILED: anything else.
  $workReport = Join-Path $Work "reports\$Date.md"
  $hasReport = Test-Path -LiteralPath $workReport -PathType Leaf
  $succeeded = $reviewed -and $workClean -and $promoted -and $hasReport
  if ($reviewed -and -not $hasReport) { Attention "no report was produced ($Date)" }
  $leadInfo = $null
  if (-not $blocked -and (Test-Path $leadsFile) -and (Get-Item $leadsFile).LastWriteTime -ge $runStart) { try { $leadInfo = Get-Content $leadsFile -Raw -Encoding utf8 | ConvertFrom-Json } catch {} }
  $runStatus = if (-not $succeeded) { 'FAILED' } elseif ($leadInfo -and $leadInfo.newsComplete) { 'COMPLETE' } else { 'DEGRADED' }
  # This run's decisions, as promoted: decided (confirmed/rejected/duplicate)
  # vs pending. Only leads new or changed against the copy backed up when
  # the run started count: an earlier run's decisions today are not this
  # run's (reviewedAt holds the date only).
  $decided = 0; $pending = 0
  if ($promoted) {
    $all = (Get-Content (Join-Path $Dir 'reviewed-leads.json') -Raw -Encoding utf8 | ConvertFrom-Json).leads
    $before = @{}
    $startCopy = Join-Path $Dir "backups\reviewed-leads.$stamp.json"
    if (Test-Path $startCopy) {
      $old = (Get-Content $startCopy -Raw -Encoding utf8 | ConvertFrom-Json).leads
      foreach ($p in $old.PSObject.Properties) { $before[$p.Name] = ($p.Value | ConvertTo-Json -Compress -Depth 6) }
    }
    foreach ($p in $all.PSObject.Properties) {
      if (-not ([string]$p.Value.reviewedAt -like "$Date*")) { continue }
      if ($before.ContainsKey($p.Name) -and $before[$p.Name] -eq ($p.Value | ConvertTo-Json -Compress -Depth 6)) { continue }
      if ($p.Value.decision -eq 'pending') { $pending++ } else { $decided++ }
    }
  }
  $entry = [ordered]@{
    date = $Date; trigger = $(if ($CatchUp) { 'catch-up' } elseif ($Scheduled) { 'scheduled' } else { 'manual' }); status = $runStatus
    newsStatus = $(if ($leadInfo) { $leadInfo.newsStatus } else { $null })
    newsFailures = $(if ($leadInfo) { $leadInfo.newsFailures } else { $null })
    newsLastError = $(if ($leadInfo) { $leadInfo.newsLastError } else { $null })
    candidates = $(if ($leadInfo) { $leadInfo.candidates } else { 0 })
    fresh = $(if ($leadInfo) { @($leadInfo.fresh).Count } else { 0 })
    pages = $pagesInfo
    decided = $decided; pending = $pending
    reviewed = $reviewed; workClean = $workClean; promoted = $promoted
    report = $(if ($hasReport) { 'private' } else { 'none' })
    finishedAt = (Get-Date -Format s)
    evidence = $(if ($evidence) { [ordered]@{ date = $evidence.date; state = $evidence.state; saved = $evidence.saved; notSaved = $evidence.notSaved } } else { $null })
  }
  [System.IO.File]::AppendAllText((Join-Path $Dir 'logs\runs.jsonl'), (($entry | ConvertTo-Json -Compress) + "`n"), $Utf8)
  $ledgerWritten = $true
  # The metric: one unattended run is expected per day since the first; a
  # day with no unattended row (missed trigger, lock, killed run) is MISSED.
  # A day's best unattended run (the 09:00 run or a catch-up) counts once.
  # Bad ledger lines are skipped, loudly.
  $ledger = Read-Ledger
  $rank = @{ COMPLETE = 3; DEGRADED = 2; FAILED = 1 }
  $first = [datetime]::ParseExact('2026-11-09', 'yyyy-MM-dd', $null)
  $sydney = [System.TimeZoneInfo]::ConvertTimeBySystemTimeZoneId([DateTime]::UtcNow, 'AUS Eastern Standard Time')
  # Today counts once its scheduled run is in the ledger, or once its run
  # window (09:00 plus the task's 3 h limit) has passed; before that it is
  # neither complete nor missed.
  $todayKey = $sydney.ToString('yyyy-MM-dd')
  $todayScheduled = @($ledger | Where-Object { $Unattended -contains $_.trigger -and $_.date -eq $todayKey }).Count -gt 0
  $lastDay = if ($todayScheduled -or $sydney.Hour -ge 12) { $sydney.Date } else { $sydney.Date.AddDays(-1) }
  $days = 0; $completeDays = 0; $missed = 0; $leadsReviewed = 0
  for ($d = $first; $d -le $lastDay; $d = $d.AddDays(1)) {
    $key = $d.ToString('yyyy-MM-dd'); $days++
    $best = $ledger | Where-Object { $Unattended -contains $_.trigger -and $_.date -eq $key } | Sort-Object { $rank[[string]$_.status] } -Descending | Select-Object -First 1
    if (-not $best) { $missed++ }
    elseif ($best.status -eq 'COMPLETE') { $completeDays++; $leadsReviewed += [int]$best.decided }
  }
  $pct = if ($days) { [math]::Round(100 * $completeDays / $days) } else { 0 }
  $statusLine = "**Run status: $runStatus** ($($entry.trigger); $decided leads decided, $pending pending). Unattended days (the 09:00 run or its catch-up) with a complete intelligence assessment: $completeDays of $days ($pct%; $missed missed); leads decided in complete unattended runs: $leadsReviewed."
  if ($evidence) {
    $statusLine += switch ($evidence.state) {
      'complete' { " Evidence: complete ($($evidence.saved) pages saved)." }
      'partial' { " Evidence: partial ($($evidence.saved) of $($evidence.saved + $evidence.notSaved) pages saved; the rest refused or unreachable)." }
      'failed' { " Evidence: failed (none of $($evidence.notSaved) pages saved)." }
      'none' { ' Evidence: none to save.' }
      default { ' Evidence: unknown (the archiver did not answer).' }
    }
  }
  Say "status: $runStatus; complete days $completeDays/$days; report $($entry.report)"

  # 6. The reviewer's report stays private: kept on the host for the
  #    operator, never posted automatically. An operator may publish it by
  #    hand after reading it (README: publishing a report).
  if ($hasReport) { Copy-Item -LiteralPath $workReport -Destination $hostReport -Force }

  # A run that succeeded empties work\ (its report is copied above, the
  # leads stay in leads\ and the staged pages were for this review only),
  # so the next day starts from an empty folder: an earlier day's files are
  # never mistaken for something planted. A failed run leaves it for the next run
  # to keep in logs\quarantine for the operator.
  if ($succeeded) {
    try { Clear-Folder $Work } catch { Say "work\ could not be emptied after the run: $($_.Exception.Message)" }
  }
  if ($script:NoteFailed) { $notes.Add('**The attention note on the host could not be written; the operator should read the log on the host.**') }

  # 7. The status comment on PR #6: written only by this script, from fixed
  #    words, numbers and dates it computed; no text from the reviewer, the
  #    leads or the web.
  $robot = [char]::ConvertFromUtf32(0x1F916)
  $status = "## Banking Access daily review: $Date`n`n$statusLine`n"
  if ($notes.Count) { $status += "`n" + ($notes -join "`n`n") + "`n" }
  $status += "`nThe review's report is kept on the host for the operator; it is not published automatically.`n`n$robot Generated with [Claude Code](https://claude.com/claude-code)`n"
  $statusFile = Join-Path $Dir "logs\status-$Date.md"
  [System.IO.File]::WriteAllText($statusFile, $status, $Utf8)
  if (-not $NoPost) {
    $posted = (& python (Join-Path $Dir 'post_pr_comment.py') $Pr $statusFile 2>&1 | Out-String).Trim()
    Say "posted: $posted"
    if ($LASTEXITCODE -ne 0) { Attention "posting the status to PR #$Pr failed ($Date): $posted" }
  }
  [System.IO.File]::WriteAllText((Join-Path $Dir 'logs\last-run.json'), (@{ date = $Date; fetch = $fetch; reviewed = $reviewed; status = $runStatus; finishedAt = (Get-Date -Format s) } | ConvertTo-Json), $Utf8)
  Say "done $Date"
} catch {
  # An unexpected error: nothing more is posted. The run is recorded as
  # FAILED (unless its ledger line was already written) and the operator
  # is told, so the day does not just look missed.
  $why = $_.Exception.Message
  try { Attention "the run stopped on an unexpected error ($Date): $why. Nothing more was posted." } catch {}
  if (-not $ledgerWritten) {
    try {
      $failed = [ordered]@{ date = $Date; trigger = $(if ($CatchUp) { 'catch-up' } elseif ($Scheduled) { 'scheduled' } else { 'manual' }); status = 'FAILED'; error = 'unexpected'; finishedAt = (Get-Date -Format s) }
      [System.IO.File]::AppendAllText((Join-Path $Dir 'logs\runs.jsonl'), (($failed | ConvertTo-Json -Compress) + "`n"), $Utf8)
    } catch {}
  }
} finally {
  Remove-Item $Lock -ErrorAction SilentlyContinue
}
