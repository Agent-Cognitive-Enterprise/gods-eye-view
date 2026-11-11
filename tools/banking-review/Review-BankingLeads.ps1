# Daily Banking Access lead review for the live instance (4173).
# 1. Fetch today's news leads, waiting for a completed GDELT refresh.
# 2. Copy the state into work\ (the reviewer's only writable folder):
#    reviewed-leads.json, events.review.json (from the live events.local.json),
#    today's leads and the bundled events.
# 3. Headless Claude reviews there (prompt on stdin), with exactly the tools
#    WebSearch WebFetch Read Glob Grep Edit Write (--tools): nothing that
#    runs a command. acceptEdits accepts file edits without asking only
#    inside work\; an edit elsewhere would need an approval, which a
#    headless run cannot give. Reads and web fetches are not confined.
# 4. Validate the working copies with the app's own loader and the review's
#    rules; only then replace the live files (atomically). On failure both
#    stay as they were, so the day's leads come back tomorrow.
# 5. Post the report on PR #6.
# Scheduled by the task "GEV Banking Leads Review" (daily 09:00, Sydney time),
# and by "GEV Banking Leads Review (catch-up)" (13:00 and 17:00, -CatchUp):
# a catch-up runs only when today has no complete unattended run yet (the
# 09:00 run failed, was degraded or never ran), so one failure no longer
# costs the day. Nothing is applied without validation either way.
param(
  [string]$AppRoot = 'C:\Users\user\gev-fast',
  [string]$BaseUrl = 'http://127.0.0.1:4173',
  [int]$Pr = 6,
  [switch]$NoPost,
  # Set by the scheduled task: only scheduled runs count towards the
  # acceptance metrics.
  [switch]$Scheduled,
  # Set by the catch-up task: run only if today has no complete unattended
  # run yet. Counts as unattended (trigger "catch-up").
  [switch]$CatchUp
)
$ErrorActionPreference = 'Continue'
$Dir = $PSScriptRoot
$Work = Join-Path $Dir 'work'
$Date = [System.TimeZoneInfo]::ConvertTimeBySystemTimeZoneId([DateTime]::UtcNow, 'AUS Eastern Standard Time').ToString('yyyy-MM-dd')
$Log = Join-Path $Dir 'logs\review.log'
$Note = 'D:\Users\user\Desktop\GEV banking review needs attention.txt'
$Utf8 = New-Object System.Text.UTF8Encoding $false
function Say([string]$text) { [System.IO.File]::AppendAllText($Log, ("{0} {1}`r`n" -f (Get-Date -Format s), $text), $Utf8) }
function Attention([string]$text) { Say "ATTENTION: $text"; [System.IO.File]::AppendAllText($Note, ("{0} {1}`r`n" -f (Get-Date -Format s), $text), $Utf8) }
function Promote([string]$from, [string]$to) {
  $tmp = "$to.tmp"
  Copy-Item $from $tmp -Force
  Move-Item $tmp $to -Force
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
  if ($done.Count) { Say "catch-up: today already has a complete run; nothing to do"; exit 0 }
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
try {
  Say "start $Date"
  $notes = New-Object System.Collections.Generic.List[string]

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
  $fetch = (& node (Join-Path $Dir 'fetch-leads.mjs') $Date $BaseUrl 2>&1 | Out-String).Trim()
  $fetchExit = $LASTEXITCODE
  Say "fetch ($fetchExit): $fetch"
  $leadsFile = Join-Path $Dir "leads\$Date.json"

  # A report already made today is kept, not reposted.
  $hostReport = Join-Path $Dir "reports\$Date.md"
  if (Test-Path $hostReport) { Move-Item $hostReport (Join-Path $Dir ("reports\$Date-earlier-{0}.md" -f (Get-Date -Format HHmmss))) -Force }

  # 2. Working copies.
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  Copy-Item (Join-Path $Dir 'events.local.json') (Join-Path $Dir "backups\events.local.$stamp.json")
  Copy-Item (Join-Path $Dir 'reviewed-leads.json') (Join-Path $Dir "backups\reviewed-leads.$stamp.json")
  Copy-Item (Join-Path $Dir 'events.local.json') (Join-Path $Work 'events.review.json') -Force
  Copy-Item (Join-Path $Dir 'reviewed-leads.json') (Join-Path $Work 'reviewed-leads.json') -Force
  Copy-Item (Join-Path $AppRoot 'server\providers\bankingAccess\events.json') (Join-Path $Work 'bundled-events.json') -Force
  Remove-Item (Join-Path $Work "reports\$Date.md") -ErrorAction SilentlyContinue
  if (Test-Path $leadsFile) { Copy-Item $leadsFile (Join-Path $Work "leads\$Date.json") -Force }

  # 3. Review.
  $reviewed = $false
  if ($fetchExit -eq 0 -and (Test-Path $leadsFile)) {
    $promptFile = Join-Path $Dir "logs\prompt-$Date.txt"
    $out = Join-Path $Dir "logs\claude-$Date.txt"
    $text = [System.IO.File]::ReadAllText((Join-Path $Dir 'review-prompt.md'), $Utf8).Replace('{DATE}', $Date)
    [System.IO.File]::WriteAllText($promptFile, $text, $Utf8)
    $claude = 'C:\Users\user\.local\bin\claude.exe'
    $cmd = "`"$claude`" -p --permission-mode acceptEdits --tools WebSearch WebFetch Read Glob Grep Edit Write --allowedTools WebSearch WebFetch Read Glob Grep --output-format text < `"$promptFile`" > `"$out`" 2>&1"
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
  } else {
    Attention "lead fetch failed ($Date): $fetch"
  }

  # 4. Validate, then promote.
  $promoted = $false
  if ($reviewed) {
    $check = (& node (Join-Path $Dir 'validate-events.mjs') $AppRoot (Join-Path $Work 'events.review.json') (Join-Path $Work 'reviewed-leads.json') (Join-Path $Dir 'reviewed-leads.json') $leadsFile 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -eq 0) {
      Promote (Join-Path $Work 'events.review.json') (Join-Path $Dir 'events.local.json')
      Promote (Join-Path $Work 'reviewed-leads.json') (Join-Path $Dir 'reviewed-leads.json')
      Say "promoted: $check"
      $promoted = $true
      $archive = (& node (Join-Path $Dir 'archive-evidence.mjs') $Date 2>&1 | Out-String).Trim()
      Say "evidence: $archive"
    } else {
      Attention "the review's edits failed validation and were not applied ($Date): $check"
      $notes.Add("**The review's edits failed validation and were not applied** (the day's leads will be reviewed again): ``$check``")
    }
  }

  # 5. Classify the run and record it in the ledger.
  #    COMPLETE: a completed news fetch, a clean review exit, every fresh lead
  #    decided today, the edits validated and applied, and a report.
  #    DEGRADED: the same but without a completed news fetch (the feed was
  #    degraded: not a quiet day). FAILED: anything else.
  $leadInfo = $null
  if (Test-Path $leadsFile) { try { $leadInfo = Get-Content $leadsFile -Raw -Encoding utf8 | ConvertFrom-Json } catch {} }
  $workReport = Join-Path $Work "reports\$Date.md"
  $runStatus = if (-not ($reviewed -and $promoted -and (Test-Path $workReport))) { 'FAILED' }
    elseif ($leadInfo -and $leadInfo.newsComplete) { 'COMPLETE' } else { 'DEGRADED' }
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
    decided = $decided; pending = $pending
    reviewed = $reviewed; promoted = $promoted; finishedAt = (Get-Date -Format s)
  }
  [System.IO.File]::AppendAllText((Join-Path $Dir 'logs\runs.jsonl'), (($entry | ConvertTo-Json -Compress) + "`n"), $Utf8)
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
  Say "status: $runStatus; complete days $completeDays/$days"

  # 6. Report.
  if (Test-Path $workReport) { $body = [System.IO.File]::ReadAllText($workReport, $Utf8) }
  else {
    $body = "## Banking Access daily review: $Date`n`nNo report was produced. Lead fetch: ``$fetch``.`n`n$([char]::ConvertFromUtf32(0x1F916)) Generated with [Claude Code](https://claude.com/claude-code)`n"
    Attention "no report was produced ($Date)"
  }
  # The status line goes right under the heading.
  $body = $body.TrimStart([char]0xFEFF)
  $nl = $body.IndexOf("`n")
  $body = if ($nl -gt 0) { $body.Substring(0, $nl + 1) + "`n" + $statusLine + "`n" + $body.Substring($nl + 1) } else { $body + "`n`n" + $statusLine + "`n" }
  if ($notes.Count) { $body = $body.TrimEnd() + "`n`n" + ($notes -join "`n`n") + "`n" }
  [System.IO.File]::WriteAllText($hostReport, $body.TrimStart([char]0xFEFF), $Utf8)
  if (-not $NoPost) {
    $posted = (& python (Join-Path $Dir 'post_pr_comment.py') $Pr $hostReport 2>&1 | Out-String).Trim()
    Say "posted: $posted"
    if ($LASTEXITCODE -ne 0) { Attention "posting the report to PR #$Pr failed ($Date): $posted" }
  }
  [System.IO.File]::WriteAllText((Join-Path $Dir 'logs\last-run.json'), (@{ date = $Date; fetch = $fetch; reviewed = $reviewed; status = $runStatus; finishedAt = (Get-Date -Format s) } | ConvertTo-Json), $Utf8)
  Say "done $Date"
} finally {
  Remove-Item $Lock -ErrorAction SilentlyContinue
}
