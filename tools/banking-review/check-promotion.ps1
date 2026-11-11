# Regression check for the journalled promotion in Review-BankingLeads.ps1.
# Runs the whole wrapper three times in a sandbox folder, with a stand-in app
# (check\fake-app.mjs) and a stand-in reviewer (check\fake-reviewer.cmd);
# nothing live is touched and nothing is posted.
#  1. The second promotion is made to fail (the live decision ledger is held
#     open: it can be read, not replaced). Expect: the run is FAILED, not
#     COMPLETE; the promotion is journalled; the events file was replaced
#     and the ledger was not (the cut-short state the journal records).
#  2. The lock is released and the wrapper runs again. Expect: it first
#     completes the journalled promotion (both files now match, the journal
#     is gone), then reviews normally: COMPLETE.
#  3. A journal whose staged copy is missing. Expect: nothing is reviewed,
#     the run is FAILED and the journal is kept for the operator.
#  4. The stand-in reviewer corrects an earlier decision, documented.
#     Expect: COMPLETE, the correction applied, and flagged for the operator.
# Usage: powershell -File check-promotion.ps1 [-AppRoot C:\Users\user\gev-fast]
param([string]$AppRoot = 'C:\Users\user\gev-fast', [int]$Port = 4199)
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$box = Join-Path ([System.IO.Path]::GetTempPath()) ('gev-promotion-check-' + (Get-Date -Format 'yyyyMMddHHmmss'))
New-Item -ItemType Directory $box | Out-Null
foreach ($f in 'fetch-leads.mjs', 'validate-events.mjs', 'archive-evidence.mjs', 'review-prompt.md') { Copy-Item (Join-Path $here $f) $box }
# The wrapper, with its attention note kept in the sandbox.
$w = [System.IO.File]::ReadAllText((Join-Path $here 'Review-BankingLeads.ps1'))
$noteLine = ($w -split "`r?`n" | Where-Object { $_ -like '$Note = *' })
if (@($noteLine).Count -ne 1) { throw 'attention note line not found' }
$w = $w.Replace($noteLine, '$Note = Join-Path $PSScriptRoot ''attention.txt''')
[System.IO.File]::WriteAllText((Join-Path $box 'Review-BankingLeads.ps1'), $w, (New-Object System.Text.UTF8Encoding $false))
New-Item -ItemType Directory (Join-Path $box 'logs'), (Join-Path $box 'work') | Out-Null
'{"events": []}' | Set-Content (Join-Path $box 'events.local.json') -Encoding ascii
'{"leads": {}}' | Set-Content (Join-Path $box 'reviewed-leads.json') -Encoding ascii
$ledgerFile = Join-Path $box 'reviewed-leads.json'
$eventsFile = Join-Path $box 'events.local.json'
$journal = Join-Path $box 'logs\promotion.json'
$reviewer = Join-Path $here 'check\fake-reviewer.cmd'

$results = New-Object System.Collections.Generic.List[string]
$failed = 0
function Expect([bool]$ok, [string]$what) {
  if ($ok) { $script:results.Add("ok   $what") } else { $script:results.Add("FAIL $what"); $script:failed++ }
}
function Run-Wrapper {
  & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $box 'Review-BankingLeads.ps1') -NoPost -AppRoot $AppRoot -BaseUrl "http://127.0.0.1:$Port" -ClaudeExe $reviewer | Out-Null
}
function Last-Run { (Get-Content (Join-Path $box 'logs\runs.jsonl') -Encoding utf8 | Where-Object { $_.Trim() } | Select-Object -Last 1) | ConvertFrom-Json }
function Log { Get-Content (Join-Path $box 'logs\review.log') -Raw -Encoding utf8 }

$app = Start-Process -FilePath 'node' -ArgumentList "`"$(Join-Path $here 'check\fake-app.mjs')`"", $Port -WindowStyle Hidden -PassThru
$holder = $null
try {
  $up = $false
  for ($i = 0; $i -lt 40 -and -not $up; $i++) {
    try { Invoke-RestMethod "http://127.0.0.1:$Port/api/banking-access" -TimeoutSec 2 | Out-Null; $up = $true } catch { Start-Sleep -Milliseconds 250 }
  }
  if (-not $up) { throw "the stand-in app did not answer on port $Port (is it in use?)" }
  # 1. The second promotion fails.
  $ready = Join-Path $box 'lock-held'
  $holder = Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -PassThru -ArgumentList '-NoProfile', '-Command',
    "`$f = [System.IO.File]::Open('$ledgerFile', 'Open', 'Read', 'Read'); New-Item -ItemType File '$ready' | Out-Null; Start-Sleep -Seconds 600"
  for ($i = 0; $i -lt 60 -and -not (Test-Path $ready); $i++) { Start-Sleep -Milliseconds 250 }
  Expect (Test-Path $ready) 'the ledger is held open for the first run'
  Run-Wrapper
  $r1 = Last-Run
  Expect ($r1.status -eq 'FAILED') "run 1 is FAILED, not COMPLETE (was $($r1.status))"
  Expect (-not $r1.promoted) 'run 1 does not count as promoted'
  Expect (Test-Path $journal) 'run 1 leaves the promotion journalled'
  Expect ((Get-Content $eventsFile -Raw) -match 'check-event-1') 'run 1 replaced the events file (the first file)'
  Expect (-not ((Get-Content $ledgerFile -Raw) -match 'check-lead-1')) 'run 1 did not replace the ledger (the second file)'
  Expect ((Get-Content (Join-Path $box 'attention.txt') -Raw) -match 'journalled') 'run 1 raises an attention note'
  Stop-Process -Id $holder.Id -Force; $holder = $null
  Start-Sleep -Milliseconds 500

  # 2. The next run completes the promotion first, then reviews normally.
  $j = Get-Content $journal -Raw | ConvertFrom-Json
  Run-Wrapper
  $r2 = Last-Run
  Expect ((Log) -match 'completed an interrupted promotion') 'run 2 completes the journalled promotion first'
  Expect ((Log) -match 'evidence \(\d{4}-\d{2}-\d{2}\)') 'run 2 runs the follow-up steps of the completed promotion'
  Expect (-not (Test-Path $journal)) 'run 2 removes the journal'
  Expect ($r2.fresh -eq 0) "run 2 completed the promotion before fetching leads (fresh $($r2.fresh): the lead was already decided)"
  Expect ((Get-Content $ledgerFile -Raw) -match 'check-lead-1') 'after run 2 the ledger holds the decision'
  Expect ((Get-Content $eventsFile -Raw) -match 'check-event-1') 'after run 2 the events file holds the event'
  Expect ($r2.status -eq 'COMPLETE') "run 2 is COMPLETE (was $($r2.status))"

  # 3. A journal that cannot be completed blocks the review.
  $missing = Join-Path $box 'logs\staged\missing\reviewed-leads.json'
  $bogus = [ordered]@{ startedAt = (Get-Date -Format s); files = @([ordered]@{ staged = $missing; to = $ledgerFile; sha256 = ('0' * 64) }) }
  [System.IO.File]::WriteAllText($journal, ($bogus | ConvertTo-Json -Depth 4))
  $before = (Log).Length
  Run-Wrapper
  $r3 = Last-Run
  $tail = (Log).Substring($before)
  Expect ($tail -match 'could not be completed') 'run 3 reports the journal it cannot complete'
  Expect (-not ($tail -match 'claude exit')) 'run 3 reviews nothing'
  Expect ($r3.status -eq 'FAILED') "run 3 is FAILED (was $($r3.status))"
  Expect (Test-Path $journal) 'run 3 keeps the journal for the operator'

  # 4. A documented correction of an earlier decision is applied and flagged.
  Remove-Item $journal
  New-Item -ItemType File (Join-Path $box 'work\make-correction') | Out-Null
  $notesBefore = (Get-Content (Join-Path $box 'attention.txt') -Raw).Length
  Run-Wrapper
  $r4 = Last-Run
  Expect ($r4.status -eq 'COMPLETE') "run 4 with a documented correction is COMPLETE (was $($r4.status))"
  $ledger4 = Get-Content $ledgerFile -Raw | ConvertFrom-Json
  Expect (@($ledger4.corrections).Count -eq 1 -and $ledger4.leads.'check-lead-1'.decision -eq 'duplicate') 'run 4 applied the correction'
  Expect ((Get-Content (Join-Path $box 'attention.txt') -Raw).Substring($notesBefore) -match 'earlier decisions corrected') 'run 4 flags the correction for the operator'
} finally {
  if ($holder) { Stop-Process -Id $holder.Id -Force -ErrorAction SilentlyContinue }
  Stop-Process -Id $app.Id -Force -ErrorAction SilentlyContinue
}
$results
"$($results.Count - $failed)/$($results.Count) passed; sandbox $box"
if ($failed) { exit 1 }
Remove-Item $box -Recurse -Force -ErrorAction SilentlyContinue
exit 0
