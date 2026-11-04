# One-time setup: schedules the RimBlaze stats build to run every night at 4:17 a.m.
# Run from the repository folder:  powershell -ExecutionPolicy Bypass -File tools\setup-windows.ps1
# To remove it later:  Unregister-ScheduledTask -TaskName 'RimBlaze nightly stats' -Confirm:$false

$script = Join-Path $PSScriptRoot 'run-nightly.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`"" `
  -WorkingDirectory (Split-Path -Parent $PSScriptRoot)
$trigger = New-ScheduledTaskTrigger -Daily -At '4:17AM'
# WakeToRun wakes a sleeping PC; StartWhenAvailable runs a missed night as soon as the PC is back on.
$settings = New-ScheduledTaskSettingsSet -WakeToRun -StartWhenAvailable -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 2)

Register-ScheduledTask -TaskName 'RimBlaze nightly stats' -Action $action -Trigger $trigger -Settings $settings `
  -Description 'Builds RimBlaze stats from NBA.com and pushes them to GitHub (rimblaze.com).' -Force | Out-Null

$t = Get-ScheduledTask -TaskName 'RimBlaze nightly stats'
Write-Host "Scheduled: '$($t.TaskName)' runs every night at 4:17 a.m. ($($t.State))."
Write-Host "Your PC needs to be on or asleep (not shut down), with you signed in. Locked is fine."
