# Adversarial evaluation of the daily Banking Access review: runs the real
# reviewer (same prompt, same permissions) in a sandbox against crafted and
# known-answer leads (cases.json), then grades the outcome. Never touches the
# live operator file, the lead store or the PR; checks that it did not.
param([string]$AppRoot = (Join-Path $env:USERPROFILE 'gev-fast'), [string]$Model = 'opus')
$ErrorActionPreference = 'Continue'
$Eval = $PSScriptRoot
$Host_ = Split-Path $Eval -Parent
$Utf8 = New-Object System.Text.UTF8Encoding $false
$Date = [System.TimeZoneInfo]::ConvertTimeBySystemTimeZoneId([DateTime]::UtcNow, 'AUS Eastern Standard Time').ToString('yyyy-MM-dd')
$Run = Join-Path $Eval ("runs\" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$Work = Join-Path $Run 'work'
New-Item -ItemType Directory -Force (Join-Path $Work 'leads'), (Join-Path $Work 'reports') | Out-Null

# Live files that must not change.
$watched = 'Review-BankingLeads.ps1', 'validate-events.mjs', 'fetch-leads.mjs', 'review-prompt.md', 'events.local.json', 'reviewed-leads.json', 'post_pr_comment.py'
$before = @{}; foreach ($f in $watched) { $before[$f] = (Get-FileHash (Join-Path $Host_ $f)).Hash }

# Sandbox state (prep-eval.mjs): live events plus a resolved outage left
# wrongly ongoing, with the cases' URLs removed from sources and decisions.
Copy-Item (Join-Path $AppRoot 'server\providers\bankingAccess\events.json') (Join-Path $Work 'bundled-events.json')
$prep = (& node (Join-Path $Eval 'prep-eval.mjs') $Host_ (Join-Path $Eval 'cases.json') $Run $Date 2>&1 | Out-String).Trim()

# The pages the review needs, staged by the same collector the daily run
# uses (the reviewer has no fetch tool).
$collect = (& node (Join-Path $Host_ 'collect-pages.mjs') --out (Join-Path $Work 'pages') --leads (Join-Path $Work "leads\$Date.json") --events (Join-Path $Run 'events.before.json') --events (Join-Path $Work 'bundled-events.json') 2>&1 | Out-String).Trim()

# The real reviewer, as the daily task runs it.
$promptFile = Join-Path $Run 'prompt.txt'
[System.IO.File]::WriteAllText($promptFile, [System.IO.File]::ReadAllText((Join-Path $Host_ 'review-prompt.md'), $Utf8).Replace('{DATE}', $Date), $Utf8)
$out = Join-Path $Run 'claude.txt'
$claude = Join-Path $env:USERPROFILE '.local\bin\claude.exe'
# Exactly the production flags, read from the wrapper.
$flagLine = @(Get-Content (Join-Path $Host_ 'Review-BankingLeads.ps1') | Where-Object { $_ -match '^\$ReviewerArgs = "(.+)"$' })
if ($flagLine.Count -ne 1) { throw 'the $ReviewerArgs line was not found exactly once in Review-BankingLeads.ps1' }
$ReviewerArgs = ([regex]::Match($flagLine[0], '^\$ReviewerArgs = "(.+)"$').Groups[1].Value).Replace('$Model', $Model)
$cmd = "`"$claude`" $ReviewerArgs < `"$promptFile`" > `"$out`" 2>&1"
$proc = Start-Process -FilePath 'cmd.exe' -ArgumentList '/d', '/s', '/c', "`"$cmd`"" -WorkingDirectory $Work -WindowStyle Hidden -PassThru
if (-not $proc.WaitForExit(90 * 60 * 1000)) { & taskkill.exe /T /F /PID $proc.Id | Out-Null; "TIMEOUT" | Out-File (Join-Path $Run 'timeout.txt') }

# Validator (as the daily task would), grader, and the live-files check.
$valid = (& node (Join-Path $Host_ 'validate-events.mjs') $AppRoot (Join-Path $Work 'events.review.json') (Join-Path $Work 'reviewed-leads.json') (Join-Path $Run 'reviewed-leads.before.json') (Join-Path $Work "leads\$Date.json") 2>&1 | Out-String).Trim()
$grade = (& node (Join-Path $Eval 'grade-eval.mjs') (Join-Path $Eval 'cases.json') $Work $Date (Join-Path $Run 'events.before.json') (Join-Path $Run 'reviewed-leads.before.json') 2>&1 | Out-String).Trim()
$changed = @(); foreach ($f in $watched) { if ((Get-FileHash (Join-Path $Host_ $f)).Hash -ne $before[$f]) { $changed += $f } }
$summary = "`n`n**Validator (as the daily task would run it):** ``$valid```n`n**Pages staged:** ``$collect```n`n**Live files changed during the run:** $(if ($changed.Count) { $changed -join ', ' } else { 'none' })`n"
[System.IO.File]::AppendAllText((Join-Path $Run 'grade.md'), $summary, $Utf8)
Write-Output "run: $Run"
Write-Output "prep: $prep"
Write-Output "grade: $grade"
Write-Output "validator: $valid"
Write-Output "flags: $ReviewerArgs"
Write-Output "pages: $collect"
Write-Output "live files changed: $(if ($changed.Count) { $changed -join ', ' } else { 'none' })"
