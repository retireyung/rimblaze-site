# RimBlaze nightly stats, run on your own Windows computer.
# Pulls the latest code, runs the stats build, and pushes the new data to GitHub,
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
  Step 'Get latest code' { git pull --rebase --autostash }
  Step 'Build stats'     { node scripts/build-stats.mjs }
  git add -A
  git diff --cached --quiet
  if ($LASTEXITCODE -ne 0) {
    Step 'Save data'   { git -c user.name="rimblaze-bot" -c user.email="bot@rimblaze.com" commit -m "Nightly stats $(Get-Date -Format yyyy-MM-dd)" }
    Step 'Upload data' { git push; if ($LASTEXITCODE -ne 0) { git pull --rebase --autostash; git push } }
  } else { Write-Host 'No data changes today.' }
  $ok = $true
  Write-Host "`nDone. rimblaze.com updates in a minute or two."
} catch {
  Write-Host "`nRUN FAILED: $_"
} finally {
  Stop-Transcript | Out-Null
}
if (-not $ok) { exit 1 }
