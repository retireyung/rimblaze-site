# RimBlaze stats, run on your own Windows computer.
# Pulls the latest code, saves the live game snapshot, runs the full stats build when due,
# and pushes the new data to GitHub,
# which redeploys rimblaze.com. Task Scheduler runs this every night; you can also
# run it by hand:  powershell -ExecutionPolicy Bypass -File tools\run-nightly.ps1
# A log of every run is kept in data\cache\nightly.log.

$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
$logDir = Join-Path $repo 'data\cache'
New-Item -ItemType Directory -Force $logDir | Out-Null
Start-Transcript -Path (Join-Path $logDir 'nightly.log') -Append | Out-Null

function Step($name, [scriptblock]$cmd) {
  Write-Host "`n== $name =="
  & $cmd
  if ($LASTEXITCODE -ne 0) { throw "$name failed (exit $LASTEXITCODE)" }
}

$ok = $false
try {
  Write-Host "RimBlaze nightly run - $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
  # Git needs a name and email to merge; set them for this folder only.
  git config user.name 'rimblaze-bot'; git config user.email 'bot@rimblaze.com'
  # Start every run from GitHub's latest version. This PC only produces generated stats and pages,
  # and every run rebuilds them, so a run that got stuck before simply starts over cleanly.
  if ((Test-Path .git\rebase-merge) -or (Test-Path .git\rebase-apply)) { git rebase --abort 2>$null }
  if (Test-Path .git\MERGE_HEAD) { git merge --abort 2>$null }
  Step 'Get latest code' { git fetch origin main }
  Step 'Reset to latest' { git checkout -f -B main origin/main }
  Step 'Live snapshot'   { node scripts/build-live.mjs }
  # Full stats (profiles, season, career) at most every 25 minutes; the live snapshot runs every time.
  $stamp = Join-Path $logDir 'last-full.txt'
  $due = -not (Test-Path $stamp) -or ((Get-Date) - (Get-Item $stamp).LastWriteTime).TotalMinutes -ge 25
  if ($due) {
    Step 'Build stats' { node scripts/build-stats.mjs }
    Set-Content -Path $stamp -Value (Get-Date -Format o)
  } else { Write-Host 'Full stats ran less than 25 minutes ago; live snapshot only.' }
  git add -A
  git diff --cached --quiet
  if ($LASTEXITCODE -ne 0) {
    Step 'Save data'   { git commit -m "Nightly stats $(Get-Date -Format yyyy-MM-dd)" }
    # If GitHub got newer changes during the build, replay this run on top of them; on a clash in a
    # generated file, this run's fresh version wins. If that still fails, the next run starts over.
    Step 'Upload data' {
      git push origin main
      if ($LASTEXITCODE -ne 0) {
        git pull --rebase -X theirs origin main
        if ($LASTEXITCODE -ne 0) { git rebase --abort 2>$null; $global:LASTEXITCODE = 1; return }
        git push origin main
      }
    }
  } else { Write-Host 'No data changes today.' }
  $ok = $true
  Write-Host "`nDone. rimblaze.com updates in a minute or two."
} catch {
  Write-Host "`nRUN FAILED: $_"
} finally {
  Stop-Transcript | Out-Null
}
if (-not $ok) { exit 1 }
